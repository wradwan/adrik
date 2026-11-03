// Adrik Scout — reads one mosque's published schedule and writes its iqama times.
//
// Modes (POST JSON):
//   { mosque_id, force? }                      fetch the website here (collect.ts) and extract
//   { mode: "targets" }                        list mosques that still need a browser read (trusted callers)
//   { mode: "ingest", mosque_id, url, text, images: [{ media_type, data }] }
//                                              the Browser Scout (real browser, GitHub Actions) sends the
//                                              rendered page text + screenshots; Claude reads both (trusted)
// Trusted callers: GitHub Actions of wradwan/adrik on main (OIDC token in x-github-oidc, audience
// "adrik-scout"), or x-adrik-admin matching app_secrets.scout_admin_token.
// Secrets: OPENROUTER_API_KEY or ANTHROPIC_API_KEY; SCOUT_MODEL optional.
// Version: v14 (2026-11-03): browser ingest with screenshots (vision); adhan-vs-iqama decided by calculation;
//   a new standing rule ends the previous one for that prayer.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import adhan from "npm:adhan@4.4.3";
import { collect } from "./collect.ts";

const OR_KEY = Deno.env.get("OPENROUTER_API_KEY");
const AN_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("SCOUT_MODEL") ?? (OR_KEY ? "anthropic/claude-sonnet-4.5" : "claude-sonnet-4-5");
const GH_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

const SYSTEM = `You are the Scout for Adrik, an app that tells Muslims which congregation (jama'ah) they can still reach.
Your only job: read a mosque's published prayer schedule and return the IQAMA (congregation start) times by calling the emit_timetable tool exactly once. Always call the tool; never answer in prose.

Rules:
- Iqama ≠ adhan. If a table has both ADHAN and IQAMA columns, extract IQAMA. Columns called "Begins", "Starts", "Start" or "Athan" are adhan; "Iqama", "Iqamah", "Jamaat", "Jama'ah", "Congregation" are iqama. If only one column exists and the page calls it "prayer times" with no iqama column, set has_iqama=false and still return the times with times_are="adhan".
- Never invent a time. A cell you cannot read -> null. A month not on the page -> omit it.
- Dates: ISO YYYY-MM-DD. Times: 24-hour HH:MM local to the mosque. Convert "4:15 pm" -> "16:15".
- Rules beat tables. If the page says "Maghrib: Sunset", "5 minutes after adhan", "Isha fixed at 8:00 pm", return a rule in rules, not per-day rows for that prayer.
- A change of iqama mid-month is normal. Return per-day rows; do not collapse to one value. A "today" box plus an "iqama time change" table: use the table for the dates it covers.
- A block labelled with a date range ("Nov 2 - 6", "Effective Nov 1 – Nov 30") applies to every day in that range: return a row per day, or rules with valid_from/valid_to.
- Jumu'ah: return each slot's khutbah start and salah start. If the page gives "Start" and "Iqamah" per slot, Start is the khutbah and Iqamah is the salah. If it gives only an iqamah/salah time, put it in salah_time and also in khutbah_time. If salah is N minutes after khutbah, return salah_offset_min=N and salah_time=null.
- Multiple jama'ahs for one prayer -> separate entries in second_jamaah with seq 2, 3... and a label.
- Time changes written as "X --> Y", "X → Y" or "X to Y" (e.g. at a DST change) mean the iqama moved from X to Y: Y is the current time. Under a heading like "Jamaat Timings" or "Iqama" these ARE iqama times (has_iqama=true).
- Data feeds and widgets: "00:00", "--:--" or an empty value is a placeholder, never an iqama time. A placeholder Maghrib in a feed means the site shows sunset: return a Maghrib "sunset" rule.
- "N min after adhan" (Mawaqit "+N"): return a rule — offset_from_adhan with minutes=N; for Maghrib use sunset_offset with minutes=N. Fixed times in a per-day calendar go in months as rows.
- A Maghrib time with a note like "Maghrib is sunset time" is a sunset rule, not a fixed time.
- Screenshots: when page screenshots or timetable images are attached, read them as part of the page. Prefer them over garbled text. Ignore generic city prayer-time widgets that are not this mosque's iqama.
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

type Img = { media_type: string; data: string };

const userMsg = (text: string, mosqueName: string, today: string, browser: boolean) =>
  `Mosque: ${mosqueName}. Today is ${today}. Extract this month and next month if published. Call emit_timetable with the result.` +
  (browser ? `\nThis was read in a real browser after the page's scripts ran. Below is the rendered text (including embedded widgets). Screenshots of the prayer-times areas and any timetable images follow the text.` : "") +
  `\n\n${text}`;

function parseLooseJson(s: string) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no JSON in text reply: " + s.slice(0, 300));
  return JSON.parse(s.slice(a, b + 1));
}

async function extractOpenRouter(text: string, mosqueName: string, today: string, images: Img[], browser: boolean) {
  const content = [{ type: "text", text: userMsg(text, mosqueName, today, browser) },
    ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.media_type};base64,${i.data}` } }))];
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OR_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://adrik.app", "X-Title": "Adrik Scout" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, temperature: 0,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
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

async function extractAnthropic(text: string, mosqueName: string, today: string, images: Img[], browser: boolean) {
  const content = [{ type: "text", text: userMsg(text, mosqueName, today, browser) },
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } }))];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AN_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, system: SYSTEM,
      tools: [{ name: "emit_timetable", description: "Return the extracted iqama schedule.", input_schema: SCHEMA }],
      messages: [{ role: "user", content }],
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

async function trusted(req: Request, db: SupabaseClient): Promise<boolean> {
  const oidc = req.headers.get("x-github-oidc");
  if (oidc) {
    try {
      const { payload } = await jwtVerify(oidc, GH_JWKS, { issuer: "https://token.actions.githubusercontent.com", audience: "adrik-scout" });
      return payload.repository === "wradwan/adrik" && payload.ref === "refs/heads/main";
    } catch { return false; }
  }
  const admin = req.headers.get("x-adrik-admin");
  if (!admin) return false;
  const { data } = await db.from("app_secrets").select("value").eq("name", "scout_admin_token").maybeSingle();
  return !!data?.value && data.value === admin;
}

// deno-lint-ignore no-explicit-any
type Out = Record<string, any>;

// What the extraction says for one date — returned to the Browser Scout so it can check answer keys.
function resolvedFor(out: Out, date: string) {
  const p: Record<string, string | null> = {};
  for (const k of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
    const row = (out.months ?? []).flatMap((m: Out) => m.rows ?? []).find((r: Out) => r.date === date);
    const rule = (out.rules ?? []).find((r: Out) => r.prayer === k && r.valid_from <= date && (!r.valid_to || r.valid_to >= date));
    p[k] = row?.[k] ?? (rule ? (rule.kind === "fixed" ? rule.fixed_time : rule.kind === "sunset" ? "sunset" : `${rule.kind === "sunset_offset" ? "sunset" : "adhan"}+${rule.minutes}`) : null);
  }
  return { date, ...p, jumuah: (out.jumuah ?? []).map((j: Out) => ({ khutbah: j.khutbah_time, salah: j.salah_time ?? null })) };
}

// Are these times the adhan (prayer start) rather than iqama? Compare with the calculated adhan for the
// mosque's location and date: if most Fajr/Dhuhr/Asr/Isha times sit within 3 minutes of the adhan, they
// are adhan times and are held back. Decided by arithmetic, not by how the page labels its table.
function lngLat(m: Out): [number, number] {
  // geom comes back as EWKB hex for a POINT: 01 01000020 E6100000 <x:8 bytes LE> <y:8 bytes LE>
  try {
    const h = String(m.geom ?? "");
    const off = h.length >= 50 ? 18 : 10;
    const dbl = (i: number) => new DataView(new Uint8Array(h.slice(off + i, off + i + 16).match(/../g)!.map((b) => parseInt(b, 16))).buffer).getFloat64(0, true);
    const x = dbl(0), y = dbl(16);
    if (isFinite(x) && isFinite(y) && Math.abs(y) <= 90) return [x, y];
  } catch { /* fall through */ }
  return [-79.70, 43.65]; // Peel Region
}
function adhanVerdict(m: Out, out: Out): { verdict: "adhan" | "iqama" | "unknown"; close: number; total: number } {
  const [lng, lat] = lngLat(m);
  const params = adhan.CalculationMethod.NorthAmerica();
  params.madhab = m.asr_madhhab === "hanafi" ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz ?? "America/Toronto", hour12: false, hour: "2-digit", minute: "2-digit" });
  const mins = (d: Date) => { const [h, mi] = fmt.format(d).split(":").map(Number); return (h % 24) * 60 + mi; };
  const hm = (t: string) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
  let close = 0, total = 0;
  const rows = (out.months ?? []).flatMap((mo: Out) => mo.rows ?? []).slice(0, 10);
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const t = new adhan.PrayerTimes(new adhan.Coordinates(lat, lng), new Date(r.date + "T12:00:00Z"), params);
    for (const k of ["fajr", "dhuhr", "asr", "isha"]) {
      if (!r[k] || !/^\d{1,2}:\d{2}/.test(r[k])) continue;
      total++;
      if (Math.abs(hm(r[k]) - mins(t[k as "fajr"])) <= 3) close++;
    }
  }
  return { verdict: total < 3 ? "unknown" : close / total >= 0.6 ? "adhan" : "iqama", close, total };
}

async function store(db: SupabaseClient, m: Out, out: Out, hash: string, url: string, kind: string) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz }).format(new Date());
  const av = adhanVerdict(m, out);
  const isAdhan = av.verdict === "adhan" || (av.verdict === "unknown" && !out.has_iqama);
  const needsReview = isAdhan || (out.confidence ?? 0) < 0.8 || (av.verdict === "iqama" && !out.has_iqama);
  const check = av.total ? ` [Adhan check: ${av.close}/${av.total} times within 3 min of the calculated adhan → ${isAdhan ? "held back as adhan" : "stored as iqama"}.]` : "";
  const { data: src } = await db.from("sources").insert({
    mosque_id: m.id, kind, url: out.source_url ?? url, raw_hash: hash,
    confidence: out.confidence, model: MODEL, notes: (out.notes ?? "") + check, needs_review: needsReview,
  }).select("id").single();
  const sid = src!.id;

  const rows: Record<string, unknown>[] = [];
  for (const mo of out.months ?? []) for (const r of mo.rows ?? []) {
    for (const p of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
      if (r[p] && !/^0?0:00/.test(r[p])) rows.push({ mosque_id: m.id, date: r.date, prayer: p, seq: 1, iqama_time: r[p], source_id: sid, quarantined: isAdhan });
    }
  }
  for (const s of out.second_jamaah ?? []) rows.push({ mosque_id: m.id, date: s.date, prayer: s.prayer, seq: s.seq, iqama_time: s.time, label: s.label, source_id: sid });
  if (rows.length) await db.from("iqama_rows").upsert(rows, { onConflict: "mosque_id,date,prayer,seq" });

  const rules = (out.rules ?? []).map((r: Out) => ({ mosque_id: m.id, prayer: r.prayer, kind: r.kind, minutes: r.minutes, fixed_time: r.fixed_time, valid_from: r.valid_from, valid_to: r.valid_to, source_id: sid }));
  if (rules.length) {
    // A new rule replaces the older one for that prayer: end the older rule the day before.
    for (const r of rules) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.valid_from))) continue;
      const dayBefore = new Date(Date.parse(`${r.valid_from}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
      await db.from("iqama_rules").update({ valid_to: dayBefore }).eq("mosque_id", m.id).eq("prayer", r.prayer)
        .lt("valid_from", r.valid_from).or(`valid_to.is.null,valid_to.gte.${r.valid_from}`);
    }
    await db.from("iqama_rules").upsert(rules, { onConflict: "mosque_id,prayer,valid_from" });
  }

  const jum = (out.jumuah ?? []).map((j: Out) => ({ mosque_id: m.id, slot: j.slot, khutbah_time: j.khutbah_time, salah_time: j.salah_time, salah_offset_min: j.salah_offset_min ?? 30, language: j.language, valid_from: today.slice(0, 8) + "01", source_id: sid }));
  if (jum.length) await db.from("jumuah_slots").upsert(jum, { onConflict: "mosque_id,slot,valid_from" });

  const spec = (out.special ?? []).map((s: Out) => ({ mosque_id: m.id, date: s.date, name: s.name, start_time: s.start_time, source_id: sid }));
  if (spec.length) await db.from("special_jamaah").insert(spec);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (out.mosque_name_ar && !m.name_ar) patch.name_ar = out.mosque_name_ar;
  for (const k of ["womens_section", "parking", "accessible"]) if (out.facilities?.[k] != null) patch[k] = out.facilities[k];
  await db.from("mosques").update(patch).eq("id", m.id);

  return { status: "ok", provider: OR_KEY ? "openrouter" : "anthropic", model: MODEL, source_id: sid, rows: rows.length, rules: rules.length, jumuah: jum.length,
    confidence: out.confidence, needs_review: needsReview, notes: out.notes, stored_as: isAdhan ? "held back (times match the adhan)" : "iqama",
    adhan_check: av, resolved_today: resolvedFor(out, today) };
}

Deno.serve(async (req) => {
  try {
    if (!OR_KEY && !AN_KEY) return Response.json({ error: "set OPENROUTER_API_KEY or ANTHROPIC_API_KEY" }, { status: 500 });
    const body = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (body.mode === "targets") {
      if (!await trusted(req, db)) return Response.json({ error: "not allowed" }, { status: 403 });
      const { data, error } = await db.rpc("browser_scout_targets");
      if (error) throw error;
      return Response.json({ targets: data });
    }

    const { data: m, error } = await db.from("mosques").select("*").eq("id", body.mosque_id).single();
    if (error || !m) return Response.json({ error: "mosque not found" }, { status: 404 });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz }).format(new Date());

    if (body.mode === "ingest") {
      if (!await trusted(req, db)) return Response.json({ error: "not allowed" }, { status: 403 });
      const text = String(body.text ?? "").slice(0, 120_000);
      const images: Img[] = (Array.isArray(body.images) ? body.images : []).slice(0, 4)
        .filter((i: Img) => /^image\/(png|jpeg|webp|gif)$/.test(i?.media_type) && typeof i?.data === "string" && i.data.length < 5_000_000);
      const hash = await sha256(text + images.map((i) => i.data.slice(0, 2000)).join("|"));
      const out = await extract(text, m.name, today, images, true);
      return Response.json({ ...(await store(db, m, out, hash, body.url ?? m.website, "browser")), images: images.length });
    }

    if (!m.website) return Response.json({ error: "mosque has no website" }, { status: 400 });
    const { text, urls } = await collect(m.website);
    const hash = await sha256(text);
    const { data: last } = await db.from("sources").select("raw_hash").eq("mosque_id", m.id).eq("kind", "website").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
    if (!body.force && last?.raw_hash === hash) return Response.json({ status: "unchanged" });
    const out = await extract(text, m.name, today, [], false);
    return Response.json(await store(db, m, out, hash, urls[0], "website"));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
