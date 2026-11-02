// Adrik Guide — the decision engine. Deterministic; no LLM.
// POST { lat, lng, mode?: "driving"|"walking"|"transit", has_wudu?: bool, wudu_min?: 5, parking_min?: 3,
//        radius_m?: 5000, madhhab?: "standard"|"hanafi", prayer?: "fajr"|..., at?: ISO datetime (for testing) }
// Returns { prayer, adhan, now, recommendation, alternatives, note }
// Secrets: GOOGLE_MAPS_API_KEY (optional — falls back to distance-based ETA)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import adhan from "npm:adhan@4.4.3";

type Prayer = "fajr" | "dhuhr" | "asr" | "maghrib" | "isha";
const PRAYERS: Prayer[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
const GKEY = Deno.env.get("GOOGLE_MAPS_API_KEY");
const TZ = "America/Toronto";

const W = { earliest: 0.4, slack: 0.2, trust: 0.2, travel: 0.1, affinity: 0.1 };

// deno-lint-ignore no-explicit-any
type Mosque = Record<string, any>;
type Cand = { mosque: Mosque; iqama: number; seq: number; label?: string; source: string };
type Scored = { c: Cand; travel: number; arrival: number; slack: number; feasible: boolean; trust: number; dist: number; score?: number };

function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) % 24 * 60 + Number(p.minute) };
}
const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fmt = (mins: number) => { const h = Math.floor(mins / 60) % 24, m = mins % 60; return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };
const toMins = (d: Date) => localParts(d, TZ).mins;

function adhanTimes(lat: number, lng: number, d: Date, madhhab: string) {
  const params = adhan.CalculationMethod.NorthAmerica();
  params.madhab = madhhab === "hanafi" ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
  const t = new adhan.PrayerTimes(new adhan.Coordinates(lat, lng), d, params);
  return { fajr: toMins(t.fajr), sunrise: toMins(t.sunrise), dhuhr: toMins(t.dhuhr), asr: toMins(t.asr), maghrib: toMins(t.maghrib), isha: toMins(t.isha) };
}

function haversine(a: [number, number], b: [number, number]) {
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function etas(origin: [number, number], dests: [number, number][], mode: string): Promise<number[]> {
  if (!GKEY || dests.length === 0) {
    const speed = mode === "walking" ? 5 : mode === "transit" ? 18 : 30; // km/h, urban, with a 1.3 road factor
    return dests.map((d) => Math.round(haversine(origin, d) * 1.3 / 1000 / speed * 60));
  }
  const r = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition" },
    body: JSON.stringify({
      origins: [{ waypoint: { location: { latLng: { latitude: origin[0], longitude: origin[1] } } } }],
      destinations: dests.map((d) => ({ waypoint: { location: { latLng: { latitude: d[0], longitude: d[1] } } } })),
      travelMode: mode === "walking" ? "WALK" : mode === "transit" ? "TRANSIT" : "DRIVE",
      ...(mode === "driving" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  const out = new Array(dests.length).fill(Infinity);
  for (const e of j) if (e.condition === "ROUTE_EXISTS") out[e.destinationIndex] = Math.round(parseInt(e.duration) / 60);
  return out;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const b = await req.json();
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng required" }, 400);
    const mode = b.mode ?? "driving";
    const wudu = b.has_wudu ? 0 : (b.wudu_min ?? 5);
    const parking = mode === "driving" ? (b.parking_min ?? 3) : 0;
    const radius = b.radius_m ?? 5000;
    const now = b.at ? new Date(b.at) : new Date();
    const { date, mins: nowM } = localParts(now, TZ);
    const ad = adhanTimes(lat, lng, now, b.madhhab ?? "standard");

    // Which prayer are we in? The current one if its adhan has passed and the next hasn't; else the next upcoming.
    const windows: Record<Prayer, [number, number]> = { fajr: [ad.fajr, ad.sunrise], dhuhr: [ad.dhuhr, ad.asr], asr: [ad.asr, ad.maghrib], maghrib: [ad.maghrib, ad.isha], isha: [ad.isha, 24 * 60 + ad.fajr] };
    const startPrayer: Prayer = b.prayer ?? PRAYERS.find((p) => nowM >= windows[p][0] && nowM < windows[p][1]) ?? PRAYERS.find((p) => ad[p] > nowM) ?? "fajr";

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const communities: string[] = Array.isArray(b.communities) && b.communities.length ? b.communities : ["sunni"];
    const { data: msAll, error } = await db.rpc("mosques_in_radius_v2", { lat, lng, radius_m: radius, communities });
    if (error) throw error;
    // Jumu'ah-only places (e.g. a workplace musalla) are candidates on Friday Dhuhr only.
    const isFriday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(now) === "Fri";
    const ms = (msAll ?? []).filter((m: Mosque) => !m.jumuah_only);
    const msJumuah = isFriday ? (msAll ?? []) : ms;
    const ids = (msAll ?? []).map((m: { id: string }) => m.id);

    // Day context: today (offset 0) or tomorrow (offset 1). Times stay in minutes relative to today's midnight.
    const tomorrow = new Date(now.getTime() + 864e5);
    const adT = adhanTimes(lat, lng, tomorrow, b.madhhab ?? "standard");
    const dayCtx = (offset: 0 | 1) => offset === 0
      ? { dateStr: date, dateObj: now, ad, windows, shift: 0 }
      : { dateStr: localParts(tomorrow, TZ).date, dateObj: tomorrow, ad: adT, shift: 1440,
          windows: { fajr: [adT.fajr, adT.sunrise], dhuhr: [adT.dhuhr, adT.asr], asr: [adT.asr, adT.maghrib], maghrib: [adT.maghrib, adT.isha], isha: [adT.isha, 1440 + adT.fajr] } as Record<Prayer, [number, number]> };

    // Walk forward from the current prayer: today's remaining prayers, then tomorrow's Fajr.
    // A jama'ah more than 10 min gone counts as missed, and we move on.
    const seq: { prayer: Prayer; offset: 0 | 1 }[] = [...PRAYERS.slice(PRAYERS.indexOf(startPrayer)).map((p) => ({ prayer: p, offset: 0 as const })), { prayer: "fajr", offset: 1 as const }];
    const allGone = (p: Scored[]) => p.length > 0 && !p.some((s) => s.feasible) && p[0].slack < -10;
    let i = 0, prayer = startPrayer, offset: 0 | 1 = 0, skipped: Prayer[] = [];
    let ev = await evaluate(seq[0].prayer, seq[0].offset);
    while (!b.prayer && (ev.pool.length === 0 || allGone(ev.pool)) && i < seq.length - 1) {
      if (ev.pool.length) skipped.push(seq[i].prayer);
      i++; prayer = seq[i].prayer; offset = seq[i].offset;
      ev = await evaluate(prayer, offset);
    }
    const { pool, uniq, noData, windowEnd } = ev;
    const ctx = dayCtx(offset);
    const cap = (p: string) => p[0].toUpperCase() + p.slice(1);
    const lastSkipped = skipped.at(-1);
    const skipNote = lastSkipped ? `${cap(lastSkipped)} jama'ah has passed at every nearby mosque — pray ${cap(lastSkipped)} where you are. ` : "";
    const fmtD = (mins: number) => fmt(mins) + (offset === 1 ? " tomorrow" : "");

    async function evaluate(prayer: Prayer, offset: 0 | 1) {
    const { dateStr, dateObj, windows: win, shift } = dayCtx(offset);
    const windowEnd = win[prayer][1] + shift;
    const [{ data: rows }, { data: rules }] = await Promise.all([
      db.from("iqama_rows").select("mosque_id,seq,iqama_time,label,quarantined").in("mosque_id", ids).eq("date", dateStr).eq("prayer", prayer),
      db.from("iqama_rules").select("mosque_id,kind,minutes,fixed_time,valid_from,valid_to").in("mosque_id", ids).eq("prayer", prayer).lte("valid_from", dateStr).or(`valid_to.is.null,valid_to.gte.${dateStr}`),
    ]);

    const cands: Cand[] = [];
    for (const m of (prayer === "dhuhr" ? msJumuah : ms)) {
      const mr = (rows ?? []).filter((r: { mosque_id: string; quarantined: boolean }) => r.mosque_id === m.id && !r.quarantined);
      if (mr.length) { for (const r of mr) cands.push({ mosque: m, iqama: hm(r.iqama_time) + shift, seq: r.seq, label: r.label, source: "table" }); continue; }
      const rule = (rules ?? []).find((r: { mosque_id: string }) => r.mosque_id === m.id);
      if (!rule) continue;
      const mosqueAdhan = adhanTimes(m.lat, m.lng, dateObj, m.asr_madhhab ?? "standard");
      let iq: number | null = null;
      if (rule.kind === "fixed" && rule.fixed_time) iq = hm(rule.fixed_time);
      else if (rule.kind === "sunset") iq = mosqueAdhan.maghrib;
      else if (rule.kind === "sunset_offset") iq = mosqueAdhan.maghrib + (rule.minutes ?? 0);
      else if (rule.kind === "offset_from_adhan") iq = mosqueAdhan[prayer] + (rule.minutes ?? 0);
      if (iq != null) cands.push({ mosque: m, iqama: iq + shift, seq: 1, source: "rule" });
    }
    const noData = (ms ?? []).filter((m: { id: string }) => !cands.some((c) => c.mosque.id === m.id)).length;
    const uniq = [...new Map(cands.map((c) => [c.mosque.id, c.mosque])).values()];
    if (!cands.length) return { pool: [] as Scored[], uniq, noData, windowEnd };

    // ETAs in one call.
    const eta = await etas([lat, lng], uniq.map((m) => [m.lat, m.lng] as [number, number]), mode);
    const etaBy = Object.fromEntries(uniq.map((m, i) => [m.id, eta[i]]));

    const scored: Scored[] = cands.map((c) => {
      const travel = etaBy[c.mosque.id as string];
      const arrival = nowM + travel + wudu + parking;
      const slack = c.iqama - arrival;
      const feasible = slack >= 0 && c.iqama <= windowEnd;
      const trust = Number(c.mosque.trust_score ?? 0);
      const dist = Number(c.mosque.distance_m);
      return { c, travel, arrival, slack, feasible, trust, dist };
    });
    const feas = scored.filter((s) => s.feasible);
    const pool = feas.length ? feas : scored.filter((s) => s.c.iqama <= windowEnd + 15); // small miss still counts
    const minIq = Math.min(...pool.map((s) => s.c.iqama)), maxIq = Math.max(...pool.map((s) => s.c.iqama));
    const maxTr = Math.max(...pool.map((s) => s.travel), 1);
    for (const s of pool) {
      const earliest = maxIq === minIq ? 1 : 1 - (s.c.iqama - minIq) / (maxIq - minIq);
      const slackScore = s.slack < 0 ? 0 : s.slack <= 15 ? 1 : Math.max(0, 1 - (s.slack - 15) / 45);
      const travelScore = 1 - s.travel / maxTr;
      const affinity = s.c.mosque.id === b.home_mosque_id ? 1 : 0;
      s.score = W.earliest * earliest + W.slack * slackScore + W.trust * s.trust + W.travel * travelScore + W.affinity * affinity;
    }
    pool.sort((a, b2) => (b2.score ?? 0) - (a.score ?? 0));
    return { pool, uniq, noData, windowEnd };
    }

    const base = { prayer, day: offset === 1 ? "tomorrow" : "today", date: ctx.dateStr, now: fmt(nowM), adhan: fmtD(ctx.ad[prayer] + ctx.shift), window_end: fmtD(windowEnd),
      missed: lastSkipped ?? null, eta_source: GKEY ? "google_routes" : "estimate", candidates: ms?.length ?? 0, with_data: uniq.length, without_data: noData };

    if (!pool.length) return json({ ...base, recommendation: null, alternatives: [], note: `${skipNote}No iqama data for ${cap(prayer)} within ${radius / 1000} km.` });

    const pack = (s: Scored) => ({
      mosque: s.c.mosque.name, mosque_id: s.c.mosque.id, address: s.c.mosque.address,
      distance_km: +(s.dist / 1000).toFixed(1), travel_min: s.travel, mode,
      iqama: fmtD(s.c.iqama), leave_by: fmtD(s.c.iqama - s.travel - wudu - parking),
      slack_min: s.slack, feasible: s.feasible, jamaah: s.c.seq > 1 ? (s.c.label ?? `jama'ah ${s.c.seq}`) : "main",
      data: s.c.source, trust: s.trust,
      maps_url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(String(s.c.mosque.address ?? s.c.mosque.name))}&destination_place_id=${s.c.mosque.place_id ?? ""}&travelmode=${mode}`,
    });
    const top = pool[0], rest = pool.slice(1, 4);
    const missedAll = allGone(pool);
    const note = skipNote + (missedAll ? `${cap(prayer)} jama'ah has passed at every nearby mosque — pray ${cap(prayer)} where you are.`
      : top.feasible ? (top.slack > 20 ? `${cap(prayer)} iqama ${fmtD(top.c.iqama)} at ${top.c.mosque.name}. No need to leave yet — leave by ${fmtD(top.c.iqama - top.travel - wudu - parking)}.` : `Leave now for ${top.c.mosque.name}. You'll arrive about ${top.slack} min before iqama.`)
      : `You'd arrive about ${-top.slack} min after iqama at ${top.c.mosque.name} — you can still join the jama'ah in progress.`);

    return json({
      ...base, missed: missedAll ? prayer : base.missed,
      recommendation: missedAll ? null : pack(top), alternatives: missedAll ? [] : rest.map(pack), note,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
