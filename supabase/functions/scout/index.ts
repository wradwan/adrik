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
// v15: target list computed here (partial coverage + 3-day browser refresh), no database function needed.
// v16: adhan check also uses "an iqama never comes before the adhan"; unclear cases follow Claude's reading.
// v17: timetable PDFs (linked from the site, or sent by the Browser Scout) go to Claude as documents.
// v18: "Tomorrow" lines; screenshot inbox (ingest with source: "screenshot", stored as kind image).
// v19: reading rules come from rules.ts (the rulebook); ingest dry-run for test fixtures; mode "blocked" records
//   a bot check and the target list skips such sites for 7 days. Claude is told the mosque's address (location rules).
// v20: computer reader — sites that refuse automated readers are read in a person's own Chrome (source "pc-chrome",
//   stored as kind browser with notes "PC CHROME: …"); targets also lists them ("computer"); a site that refuses a
//   normal browser too is recorded as SITE CLOSED.
// v21: Maghrib check — a fixed Maghrib time before sunset or more than 45 min after it is dropped (rule maghrib-near-sunset).
// v22: the plain reader also finds day-by-day timetables compiled into the site's own script bundle (rule bundle-timetables).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import adhan from "npm:adhan@4.4.3";
import { collect, type Doc } from "./collect.ts";
import { READ_RULES } from "./rules.ts";

const OR_KEY = Deno.env.get("OPENROUTER_API_KEY");
const AN_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("SCOUT_MODEL") ?? (OR_KEY ? "anthropic/claude-sonnet-4.5" : "claude-sonnet-4-5");
const GH_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

const SYSTEM = `You are the Scout for Adrik, an app that tells Muslims which congregation (jama'ah) they can still reach.
Your only job: read a mosque's published prayer schedule and return the IQAMA (congregation start) times by calling the emit_timetable tool exactly once. Always call the tool; never answer in prose.

Rules (general: they apply to every mosque):
${READ_RULES}`;

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
// deno-lint-ignore no-explicit-any
type Out = Record<string, any>;
type Att = { images: Img[]; docs: Pick<Doc, "media_type" | "data">[] };

const userMsg = (text: string, mosqueName: string, today: string, browser: boolean) =>
  `Mosque: ${mosqueName}. Today is ${today}. Extract this month and next month if published. Call emit_timetable with the result.` +
  (browser ? `\nThis was read in a real browser after the page's scripts ran. Below is the rendered text (including embedded widgets). Screenshots of the prayer-times areas and any timetable images follow the text.` : "") +
  `\n\n${text}`;

function parseLooseJson(s: string) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no JSON in text reply: " + s.slice(0, 300));
  return JSON.parse(s.slice(a, b + 1));
}

async function extractOpenRouter(text: string, mosqueName: string, today: string, att: Att, browser: boolean) {
  const content = [{ type: "text", text: userMsg(text, mosqueName, today, browser) },
    ...att.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.media_type};base64,${i.data}` } })),
    ...att.docs.map((d, n) => ({ type: "file", file: { filename: `timetable-${n + 1}.pdf`, file_data: `data:${d.media_type};base64,${d.data}` } }))];
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

async function extractAnthropic(text: string, mosqueName: string, today: string, att: Att, browser: boolean) {
  const content = [{ type: "text", text: userMsg(text, mosqueName, today, browser) },
    ...att.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    ...att.docs.map((d) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data } }))];
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
// Name plus address, so Claude can tell this mosque's location from another branch (rule location-picker).
const label = (m: Out) => (m.address ? `${m.name} (${m.address})` : m.name) as string;

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


// What the extraction says for one date — returned to the Browser Scout so it can check answer keys.
function resolvedFor(out: Out, date: string, heldBack = false) {
  const p: Record<string, string | null> = {};
  for (const k of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
    // Held-back (adhan) rows are not used by the app, so they are not part of what it will show.
    const row = heldBack ? undefined : (out.months ?? []).flatMap((m: Out) => m.rows ?? []).find((r: Out) => r.date === date);
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
function adhanVerdict(m: Out, out: Out): { verdict: "adhan" | "iqama" | "unclear" | "unknown"; close: number; early: number; total: number } {
  const [lng, lat] = lngLat(m);
  const at = (madhab: unknown) => { const p = adhan.CalculationMethod.NorthAmerica(); p.madhab = madhab as typeof p.madhab; return p; };
  const own = at(m.asr_madhhab === "hanafi" ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi), shafi = at(adhan.Madhab.Shafi);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz ?? "America/Toronto", hour12: false, hour: "2-digit", minute: "2-digit" });
  const mins = (d: Date) => { const [h, mi] = fmt.format(d).split(":").map(Number); return (h % 24) * 60 + mi; };
  const hm = (t: string) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
  let close = 0, early = 0, total = 0;
  const rows = (out.months ?? []).flatMap((mo: Out) => mo.rows ?? []).slice(0, 10);
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const c = new adhan.Coordinates(lat, lng), d = new Date(r.date + "T12:00:00Z");
    const t = new adhan.PrayerTimes(c, d, own), ts = new adhan.PrayerTimes(c, d, shafi);
    for (const k of ["fajr", "dhuhr", "asr", "isha"]) {
      if (!r[k] || !/^\d{1,2}:\d{2}/.test(r[k])) continue;
      total++;
      const v = hm(r[k]);
      if (Math.abs(v - mins(t[k as "fajr"])) <= 3) close++;
      // An iqama can never come before the adhan. Earliest possible adhan: Shafi Asr.
      if (v < mins(ts[k as "fajr"]) - 5) early++;
    }
  }
  const verdict: "adhan" | "iqama" | "unclear" | "unknown" = total < 3 ? "unknown" : early > 0 || close / total >= 0.6 ? "adhan" : close / total <= 0.25 ? "iqama" : "unclear";
  return { verdict, close, early, total };
}

// Rule maghrib-near-sunset: a Maghrib jama'ah starts shortly after sunset. A fixed Maghrib time before sunset or more
// than 45 minutes after it is wrong for that date (typically a time not updated after a clock change): it is dropped
// before storing, and the read is noted. Sunset/offset rules are unaffected.
function sunsetMin(m: Out, date: string): number {
  const [lng, lat] = lngLat(m);
  const t = new adhan.PrayerTimes(new adhan.Coordinates(lat, lng), new Date(date + "T12:00:00Z"), adhan.CalculationMethod.NorthAmerica());
  const [h, mi] = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz ?? "America/Toronto", hour12: false, hour: "2-digit", minute: "2-digit" }).format(t.maghrib).split(":").map(Number);
  return (h % 24) * 60 + mi;
}
function checkMaghrib(m: Out, out: Out): void {
  const bad: string[] = [];
  const off = (date: string, t: string) => { const [h, mi] = String(t).split(":").map(Number); return h * 60 + mi - sunsetMin(m, date); };
  for (const mo of out.months ?? []) for (const r of mo.rows ?? []) {
    if (!r.maghrib || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !/^\d{1,2}:\d{2}/.test(r.maghrib)) continue;
    const d = off(r.date, r.maghrib);
    if (d < -2 || d > 45) { bad.push(`${r.date} ${r.maghrib}`); r.maghrib = null; }
  }
  out.rules = (out.rules ?? []).filter((u: Out) => {
    if (u.prayer !== "maghrib" || u.kind !== "fixed" || !u.fixed_time || !/^\d{4}-\d{2}-\d{2}$/.test(String(u.valid_from))) return true;
    const d = off(u.valid_from, u.fixed_time);
    if (d < -2 || d > 45) { bad.push(`rule from ${u.valid_from} ${u.fixed_time}`); return false; }
    return true;
  });
  if (bad.length) out.notes = `${out.notes ?? ""} [Maghrib check: dropped ${bad.length} Maghrib time(s) not within sunset..sunset+45 min (${bad.slice(0, 3).join("; ")}${bad.length > 3 ? "; …" : ""}).]`.trim();
}

// Arithmetic decides when it is clear; when it is not, Claude's reading of the page decides.
function classify(m: Out, out: Out) {
  const av = adhanVerdict(m, out);
  return { av, isAdhan: av.verdict === "adhan" || (av.verdict !== "iqama" && !out.has_iqama) };
}

async function store(db: SupabaseClient, m: Out, out: Out, hash: string, url: string, kind: string, notePrefix = "") {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz }).format(new Date());
  const { av, isAdhan } = classify(m, out);
  const needsReview = isAdhan || (out.confidence ?? 0) < 0.8 || (av.verdict === "iqama" && !out.has_iqama);
  const check = av.total ? ` [Adhan check: ${av.close}/${av.total} within 3 min of the calculated adhan, ${av.early} before it → ${isAdhan ? "held back as adhan" : "stored as iqama"}.]` : "";
  const { data: src } = await db.from("sources").insert({
    mosque_id: m.id, kind, url: out.source_url ?? url, raw_hash: hash,
    confidence: out.confidence, model: MODEL, notes: notePrefix + (out.notes ?? "") + check, needs_review: needsReview,
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
    adhan_check: av, resolved_today: resolvedFor(out, today, isAdhan) };
}

// Rule daily-targets: mosques the Browser Scout should read today — every active mosque with a website (new ones
// included) with fewer than all five prayers covered today (rows or standing rules), or last read by the browser
// more than 3 days ago. Rule bot-check: sites that refused the reader in the last 7 days are listed as blocked.
// Rule computer-reader: those are listed in "computer" for a person's own browser to read, unless that browser was
// refused too (SITE CLOSED) in the last 7 days. Reads made in a person's browser do not count as automated reads.
async function browserTargets(db: SupabaseClient) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const [{ data: ms }, { data: rows }, { data: rules }, { data: srcs }] = await Promise.all([
    db.from("mosques").select("id,name,website,community").eq("active", true).not("website", "is", null),
    db.from("iqama_rows").select("mosque_id,prayer").eq("date", today).eq("quarantined", false).limit(5000),
    db.from("iqama_rules").select("mosque_id,prayer").lte("valid_from", today).or(`valid_to.is.null,valid_to.gte.${today}`).limit(5000),
    db.from("sources").select("mosque_id,fetched_at,notes").eq("kind", "browser").order("fetched_at", { ascending: false }).limit(5000),
  ]);
  const cov = new Map<string, Set<string>>();
  for (const x of [...(rows ?? []), ...(rules ?? [])]) { const s = cov.get(x.mosque_id) ?? new Set(); s.add(x.prayer); cov.set(x.mosque_id, s); }
  const lastBrowser = new Map<string, { at: string; bot: boolean }>(), lastPc = new Map<string, { at: string; closed: boolean }>();
  for (const x of srcs ?? []) {
    if (/^(PC CHROME|SITE CLOSED)/.test(x.notes ?? "")) { if (!lastPc.has(x.mosque_id)) lastPc.set(x.mosque_id, { at: x.fetched_at, closed: /^SITE CLOSED/.test(x.notes ?? "") }); }
    else if (!lastBrowser.has(x.mosque_id)) lastBrowser.set(x.mosque_id, { at: x.fetched_at, bot: /^BOT CHECK/.test(x.notes ?? "") });
  }
  const stale = Date.now() - 3 * 864e5, botWait = Date.now() - 7 * 864e5;
  // Rule bot-check: a site that showed a bot check is not visited again for 7 days.
  const all = (ms ?? []).map((m) => ({ ...m, covered: cov.get(m.id)?.size ?? 0, last_browser: lastBrowser.get(m.id)?.at ?? null, bot: !!lastBrowser.get(m.id)?.bot }));
  const blocked = all.filter((m) => m.bot && m.last_browser && Date.parse(m.last_browser) > botWait && m.covered < 5);
  const targets = all.filter((m) => !blocked.includes(m))
    .filter((m) => m.covered < 5 || (m.last_browser && Date.parse(m.last_browser) < stale))
    .map((m) => ({ ...m, reason: m.covered < 5 ? `missing ${5 - m.covered} prayer(s) today` : "browser refresh (every 3 days)" }))
    .sort((a, b) => Number(a.community !== "sunni") - Number(b.community !== "sunni") || a.name.localeCompare(b.name));
  const computer = all.filter((m) => m.bot && m.last_browser && Date.parse(m.last_browser) > Date.now() - 8 * 864e5)
    .filter((m) => { const pc = lastPc.get(m.id); return !(pc?.closed && Date.parse(pc.at) > botWait); });
  return { targets, blocked: blocked.map((m) => ({ id: m.id, name: m.name, website: m.website, since: m.last_browser, reason: "bot check: read in a person's browser (computer reader) or from a screenshot" })),
    computer: computer.map((m) => ({ id: m.id, name: m.name, website: m.website, covered_today: m.covered, last_computer_read: lastPc.get(m.id)?.at ?? null })) };
}

Deno.serve(async (req) => {
  try {
    if (!OR_KEY && !AN_KEY) return Response.json({ error: "set OPENROUTER_API_KEY or ANTHROPIC_API_KEY" }, { status: 500 });
    const body = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (body.mode === "targets") {
      if (!await trusted(req, db)) return Response.json({ error: "not allowed" }, { status: 403 });
      return Response.json(await browserTargets(db));
    }

    const { data: m, error } = await db.from("mosques").select("*").eq("id", body.mosque_id).single();
    if (error || !m) return Response.json({ error: "mosque not found" }, { status: 404 });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz }).format(new Date());

    if (body.mode === "blocked") {   // rule bot-check: record it, never force past it
      if (!await trusted(req, db)) return Response.json({ error: "not allowed" }, { status: 403 });
      const reason = String(body.reason ?? "the site showed a bot check to the browser reader").slice(0, 300);
      const notes = body.source === "pc-chrome"   // a person's own browser was refused too: the site is closed to everyone
        ? `SITE CLOSED: ${reason}. A normal browser is refused too; needs the mosque's other channel.`
        : `BOT CHECK: ${reason}. Not read automatically; read in a person's browser (computer reader) or from a screenshot.`;
      const { data: src } = await db.from("sources").insert({ mosque_id: m.id, kind: "browser", url: body.url ?? m.website, needs_review: true, notes }).select("id").single();
      return Response.json({ status: "blocked", source_id: src?.id });
    }

    if (body.mode === "ingest") {
      if (!await trusted(req, db)) return Response.json({ error: "not allowed" }, { status: 403 });
      const text = String(body.text ?? "").slice(0, 120_000);
      const images: Img[] = (Array.isArray(body.images) ? body.images : []).slice(0, 4)
        .filter((i: Img) => /^image\/(png|jpeg|webp|gif)$/.test(i?.media_type) && typeof i?.data === "string" && i.data.length < 5_000_000);
      const docs = (Array.isArray(body.docs) ? body.docs : []).slice(0, 2)
        .filter((d: Img) => d?.media_type === "application/pdf" && typeof d?.data === "string" && d.data.length < 6_500_000);
      const hash = await sha256(text + [...images, ...docs].map((i) => i.data.slice(0, 2000)).join("|"));
      const shot = body.source === "screenshot";   // a community member's screenshot of the mosque's own site
      const pc = body.source === "pc-chrome";      // read in a person's own Chrome (rule computer-reader)
      const intro = shot ? `A community member sent this screenshot of ${m.name}'s own website (${body.url ?? m.website ?? "site"}), taken ${body.taken ?? today}. ${text}`
        : pc ? `This site refuses automated readers, so it was read in a person's own Chrome on their computer. Below is the rendered text of the prayer-time block(s) the page showed (after clicking any "prayer times" opener), then any Jumu'ah lines on the page.\n\n${text}`
        : text;
      const out = await extract(intro, label(m), today, { images, docs }, !shot && !pc);
      checkMaghrib(m, out);
      if (body.dry) {   // test fixture: read with every rule, write nothing
        const { av, isAdhan } = classify(m, out);
        return Response.json({ status: "dry", confidence: out.confidence, notes: out.notes, stored_as: isAdhan ? "held back (times match the adhan)" : "iqama",
          adhan_check: av, rows: (out.months ?? []).reduce((n: number, mo: Out) => n + (mo.rows?.length ?? 0), 0), rules: out.rules?.length ?? 0, jumuah: out.jumuah?.length ?? 0,
          resolved_today: resolvedFor(out, String(body.taken ?? today), isAdhan) });
      }
      return Response.json({ ...(await store(db, m, out, hash, body.url ?? m.website, shot ? "image" : "browser", pc ? "PC CHROME: " : "")), images: images.length, docs: docs.length });
    }

    if (!m.website) return Response.json({ error: "mosque has no website" }, { status: 400 });
    const { text, urls, docs } = await collect(m.website);
    const hash = await sha256(text + docs.map((d) => d.data.slice(0, 4000)).join("|"));
    const { data: last } = await db.from("sources").select("raw_hash").eq("mosque_id", m.id).eq("kind", "website").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
    if (!body.force && last?.raw_hash === hash) return Response.json({ status: "unchanged" });
    const out = await extract(text, label(m), today, { images: [], docs }, false);
    checkMaghrib(m, out);
    return Response.json(await store(db, m, out, hash, urls[0], "website"));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
