// Adrik Scout — reads one mosque's website and writes its iqama schedule.
// POST { mosque_id, force? }.
// Secrets: OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY; SCOUT_MODEL optional.
// Deployed version: v8 (2026-10-29). Works with claude-sonnet-5-5 (no forced tool_choice).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OR_KEY = Deno.env.get("OPENROUTER_API_KEY");
const AN_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("SCOUT_MODEL") ?? (OR_KEY ? "anthropic/claude-sonnet-4.5" : "claude-sonnet-4-5");
const LINK_RE = /salah|salat|prayer|namaz|iqama|iqamah|timetable|times|اوقات|الصلاة/i;

const SYSTEM = `You are the Scout for Adrik, an app that tells Muslims which congregation (jama'ah) they can still reach.
Your only job: read a mosque's published prayer schedule and return the IQAMA (congregation start) times by calling the emit_timetable tool exactly once. Always call the tool; never answer in prose.

Rules:
- Iqama ≠ adhan. If a table has both ADHAN and IQAMA columns, extract IQAMA. If only one column exists and the page calls it "prayer times" with no iqama column, set has_iqama=false and still return the times with times_are="adhan".
- Never invent a time. A cell you cannot read -> null. A month not on the page -> omit it.
- Dates: ISO YYYY-MM-DD. Times: 24-hour HH:MM local to the mosque. Convert "4:15 pm" -> "16:15".
- Rules beat tables. If the page says "Maghrib: Sunset", "5 minutes after adhan", "Isha fixed at 8:00 pm", return a rule in rules, not per-day rows for that prayer.
- A change of iqama mid-month is normal. Return per-day rows; do not collapse to one value.
- Jumu'ah: return each slot's khutbah start and salah start. If salah is N minutes after khutbah, return salah_offset_min=N and salah_time=null.
- Multiple jama'ahs for one prayer -> separate entries in second_jamaah with seq 2, 3... and a label.
- Extract facilities only if explicitly stated. Otherwise null.
- confidence is your honest 0-1 estimate that every returned time matches the page.`;

const SCHEMA = {
  type: "object",
  required: ["has_iqama", "times_are", "months", "rules", "jumuah", "confidence"],
  properties: {
    mosque_name_ar: { type: ["string", "null"] },
    source_url: { type: ["string", "null"] },
    has_iqama: { type: "boolean" },
    times_are: { type: "string", enum: ["iqama", "adhan"] },
    months: { type: "array", items: { type: "object", required: ["month", "rows"], properties: {
      month: { type: "string" },
      rows: { type: "array", items: { type: "object", required: ["date"], properties: {
        date: { type: "string" }, fajr: { type: ["string", "null"] }, dhuhr: { type: ["string", "null"] },
        asr: { type: ["string", "null"] }, maghrib: { type: ["string", "null"] }, isha: { type: ["string", "null"] } } } } } } },
    rules: { type: "array", items: { type: "object", required: ["prayer", "kind", "valid_from"], properties: {
      prayer: { type: "string", enum: ["fajr", "dhuhr", "asr", "maghrib", "isha"] },
      kind: { type: "string", enum: ["fixed", "offset_from_adhan", "sunset", "sunset_offset"] },
      minutes: { type: ["integer", "null"] }, fixed_time: { type: ["string", "null"] },
      valid_from: { type: "string" }, valid_to: { type: ["string", "null"] } } } },
    second_jamaah: { type: "array", items: { type: "object", required: ["date", "prayer", "seq", "time"], properties: {
      date: { type: "string" }, prayer: { type: "string" }, seq: { type: "integer" }, time: { type: "string" }, label: { type: ["string", "null"] } } } },
    jumuah: { type: "array", items: { type: "object", required: ["slot", "khutbah_time"], properties: {
      slot: { type: "integer" }, khutbah_time: { type: "string" }, salah_time: { type: ["string", "null"] },
      salah_offset_min: { type: ["integer", "null"] }, language: { type: ["string", "null"] } } } },
    special: { type: "array", items: { type: "object", required: ["date", "name", "start_time"], properties: {
      date: { type: "string" }, name: { type: "string" }, start_time: { type: "string" } } } },
    facilities: { type: "object", properties: { womens_section: { type: ["boolean", "null"] }, parking: { type: ["boolean", "null"] }, accessible: { type: ["boolean", "null"] } } },
    confidence: { type: "number" },
    notes: { type: ["string", "null"] },
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(tr|p|div|li|h\d)>/gi, "\n").replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": "AdrikScout/0.1 (+iqama schedule reader)" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return await r.text();
}

async function collect(site: string): Promise<{ text: string; urls: string[] }> {
  const home = await fetchText(site);
  const base = new URL(site);
  const links = new Set<string>();
  for (const m of home.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1], label = htmlToText(m[2]);
    if (LINK_RE.test(label) || LINK_RE.test(href)) {
      try { const u = new URL(href, base); if (u.host === base.host) links.add(u.toString()); } catch { /* skip */ }
    }
  }
  const urls = [site, ...[...links].slice(0, 3)];
  const parts = [htmlToText(home)];
  for (const u of urls.slice(1)) { try { parts.push(`\n\n=== ${u} ===\n` + htmlToText(await fetchText(u))); } catch { /* skip */ } }
  return { text: parts.join("\n").slice(0, 120_000), urls };
}

const userMsg = (text: string, mosqueName: string, today: string) =>
  `Mosque: ${mosqueName}. Today is ${today}. Extract this month and next month if published. Call emit_timetable with the result.\n\n${text}`;

function parseLooseJson(s: string) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no JSON in text reply: " + s.slice(0, 300));
  return JSON.parse(s.slice(a, b + 1));
}

async function extractOpenRouter(text: string, mosqueName: string, today: string) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OR_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://adrik.app", "X-Title": "Adrik Scout" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, temperature: 0,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userMsg(text, mosqueName, today) }],
      tools: [{ type: "function", function: { name: "emit_timetable", description: "Return the extracted iqama schedule.", parameters: SCHEMA } }],
      tool_choice: "auto",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  const msg = j.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  return call ? JSON.parse(call.function.arguments) : parseLooseJson(msg?.content ?? "");
}

async function extractAnthropic(text: string, mosqueName: string, today: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AN_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, system: SYSTEM,
      tools: [{ name: "emit_timetable", description: "Return the extracted iqama schedule.", input_schema: SCHEMA }],
      messages: [{ role: "user", content: userMsg(text, mosqueName, today) }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  const tool = j.content?.find((c: { type: string }) => c.type === "tool_use");
  if (tool) return tool.input;
  const txt = j.content?.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n") ?? "";
  return parseLooseJson(txt);
}

const extract = OR_KEY ? extractOpenRouter : extractAnthropic;

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    if (!OR_KEY && !AN_KEY) return Response.json({ error: "set OPENROUTER_API_KEY or ANTHROPIC_API_KEY" }, { status: 500 });
    const { mosque_id, force = false } = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: m, error } = await db.from("mosques").select("*").eq("id", mosque_id).single();
    if (error || !m) return Response.json({ error: "mosque not found" }, { status: 404 });
    if (!m.website) return Response.json({ error: "mosque has no website" }, { status: 400 });

    const { text, urls } = await collect(m.website);
    const hash = await sha256(text);
    const { data: last } = await db.from("sources").select("raw_hash").eq("mosque_id", m.id).order("fetched_at", { ascending: false }).limit(1).maybeSingle();
    if (!force && last?.raw_hash === hash) return Response.json({ status: "unchanged" });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz }).format(new Date());
    const out = await extract(text, m.name, today);
    const needsReview = !out.has_iqama || (out.confidence ?? 0) < 0.8;

    const { data: src } = await db.from("sources").insert({
      mosque_id: m.id, kind: "website", url: out.source_url ?? urls[0], raw_hash: hash,
      confidence: out.confidence, model: MODEL, notes: out.notes, needs_review: needsReview,
    }).select("id").single();
    const sid = src!.id;

    const rows: Record<string, unknown>[] = [];
    for (const mo of out.months ?? []) for (const r of mo.rows ?? []) {
      for (const p of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
        if (r[p]) rows.push({ mosque_id: m.id, date: r.date, prayer: p, seq: 1, iqama_time: r[p], source_id: sid, quarantined: !out.has_iqama });
      }
    }
    for (const s of out.second_jamaah ?? []) rows.push({ mosque_id: m.id, date: s.date, prayer: s.prayer, seq: s.seq, iqama_time: s.time, label: s.label, source_id: sid });
    if (rows.length) await db.from("iqama_rows").upsert(rows, { onConflict: "mosque_id,date,prayer,seq" });

    const rules = (out.rules ?? []).map((r: Record<string, unknown>) => ({ mosque_id: m.id, prayer: r.prayer, kind: r.kind, minutes: r.minutes, fixed_time: r.fixed_time, valid_from: r.valid_from, valid_to: r.valid_to, source_id: sid }));
    if (rules.length) await db.from("iqama_rules").upsert(rules, { onConflict: "mosque_id,prayer,valid_from" });

    const jum = (out.jumuah ?? []).map((j: Record<string, unknown>) => ({ mosque_id: m.id, slot: j.slot, khutbah_time: j.khutbah_time, salah_time: j.salah_time, salah_offset_min: j.salah_offset_min ?? 30, language: j.language, valid_from: today.slice(0, 8) + "01", source_id: sid }));
    if (jum.length) await db.from("jumuah_slots").upsert(jum, { onConflict: "mosque_id,slot,valid_from" });

    const spec = (out.special ?? []).map((s: Record<string, unknown>) => ({ mosque_id: m.id, date: s.date, name: s.name, start_time: s.start_time, source_id: sid }));
    if (spec.length) await db.from("special_jamaah").insert(spec);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (out.mosque_name_ar && !m.name_ar) patch.name_ar = out.mosque_name_ar;
    for (const k of ["womens_section", "parking", "accessible"]) if (out.facilities?.[k] != null) patch[k] = out.facilities[k];
    await db.from("mosques").update(patch).eq("id", m.id);

    return Response.json({ status: "ok", provider: OR_KEY ? "openrouter" : "anthropic", model: MODEL, source_id: sid, rows: rows.length, rules: rules.length, jumuah: jum.length, confidence: out.confidence, needs_review: needsReview, notes: out.notes });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
