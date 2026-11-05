// Scout page collection: turns a mosque website into readable text for the extractor.
// Handles the places iqama times hide besides plain HTML:
//   - linked "prayer times" pages (www / non-www, http / https treated as the same site)
//   - embedded timetable widgets (iframes): themasjidapp, Masjidal, Mawaqit, Google Apps Script, ...
//   - "Prayer Times" links to a provider's page on another site (prayertimedisplay.com, Mawaqit, Masjidal, ...)
//   - Mawaqit: the yearly iqama calendar sits in a `confData` script variable
//   - Google Apps Script web apps: the real page is a JSON-escaped string (`userHtml`)
//   - data feeds the page loads by script (Firebase *.json, Apps Script /exec, */prayer*.json),
//     found in the HTML or in the site's own script bundles (e.g. Next.js chunks)
//   - a day-by-day timetable compiled into the site's own script bundle (rule bundle-timetables)

export const UA = "AdrikScout/0.1 (+iqama schedule reader)";
export const LINK_RE = /salah|salat|prayer|namaz|iqama|iqamah|timetable|times|اوقات|الصلاة/i;
// Iframes worth opening.
const WIDGET_RE = /themasjidapp|masjidbox|mawaqit|masjidal|masjidiapp|connect-?mazjid|madina\.?apps|script\.google\.com\/macros|iqamah|prayer|salah|salat|iqama|timetable/i;
// Prayer-time providers that host a mosque's times on their own site: "Prayer Times" links to them are followed
// like pages of the mosque's site (rule widget-links).
export const WIDGET_HOSTS = /(^|\.)(prayertimedisplay\.com|mawaqit\.net|masjidal\.com|athanplus\.com|themasjidapp\.(org|net|com)|masjidbox\.com|mazjid\.com|madinaapps\.com|masjidiapp\.com|masjidplus\.com)$/i;
// Data feeds a page fetches by script.
const FEED_RE = /https?:\/\/[^"'`\s<>()\\]*?(?:firebaseio\.com\/[^"'`\s<>()\\]*?\.json|script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec|\/[^"'`\s<>()\\]*(?:prayer|iqama|iqamah|salah|salat|namaz|jamaat)[^"'`\s<>()\\]*\.json)/gi;
const FEED_SKIP = /sunrise-sunset|maps\.googleapis|googletagmanager|google-analytics/i;
// Timetable PDFs linked from the site (monthly / yearly calendars).
const PDF_WORDS = /salah|salat|prayer|namaz|iqama|iqamah|jamaat|timetable|time-table|calendar|schedule|timing/i;
export type Doc = { media_type: string; data: string; url: string };

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function fetchPdf(url: string): Promise<Doc | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
    if (!r.ok || !/pdf/i.test(r.headers.get("content-type") ?? "")) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 4_500_000 || bytes.length < 1000) return null;
    return { media_type: "application/pdf", data: b64(bytes), url };
  } catch { return null; }
}

function pdfLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { const u = new URL(m[1].replace(/&amp;/g, "&"), base); if (PDF_WORDS.test(u.pathname) || PDF_WORDS.test(htmlToText(m[2]))) out.push(u.toString()); } catch { /* skip */ }
  }
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(tr|p|div|li|h\d)>/gi, "\n").replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#43;/g, "+")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return await r.text();
}

const bareHost = (h: string) => h.replace(/^www\./i, "").toLowerCase();

function iframes(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    try { const u = new URL(m[1].replace(/&amp;/g, "&"), base); if (WIDGET_RE.test(u.toString())) out.push(u.toString()); } catch { /* skip */ }
  }
  return out;
}

// Mawaqit keeps the whole year in confData.iqamaCalendar[month][day] = [fajr, dhuhr, asr, maghrib, isha],
// each "HH:MM" or "+N" (N minutes after that prayer's adhan).
export function mawaqitText(html: string, now = new Date()): string | null {
  const m = html.match(/(?:var|let|const)\s+confData\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) return null;
  // deno-lint-ignore no-explicit-any
  let d: any;
  try { d = JSON.parse(m[1]); } catch { return null; }
  const tz = d.timezone || "America/Toronto";
  const [y, mo] = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now).split("-").map(Number);
  const names = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
  const val = (v: string) => /^\+\d+$/.test(String(v)) ? `${String(v).slice(1)} min after adhan` : v;
  const lines = [`Mawaqit timetable for ${d.name}. ${d.iqamaEnabled === false ? "These are ADHAN times (iqama disabled)." : "IQAMA times, one row per day; \"N min after adhan\" is a rule."}`];
  for (const k of [0, 1]) {
    const mi = (mo - 1 + k) % 12, yy = y + Math.floor((mo - 1 + k) / 12);
    const month = d.iqamaCalendar?.[mi];
    if (!month) continue;
    for (const day of Object.keys(month).map(Number).sort((a, b) => a - b)) {
      const v = month[String(day)];
      if (!Array.isArray(v)) continue;
      lines.push(`${yy}-${String(mi + 1).padStart(2, "0")}-${String(day).padStart(2, "0")} | ` + names.map((n, i) => `${n} ${val(v[i])}`).join(" | "));
    }
  }
  if (d.fixedIqama?.some?.((x: string) => x)) lines.push(`Fixed iqama override: ${JSON.stringify(d.fixedIqama)}`);
  const j = [d.jumua, d.jumua2, d.jumua3].filter(Boolean);
  if (j.length) lines.push(`Jumu'ah: ${j.join(", ")}${d.jumuaAsDuhr ? " (held at Dhuhr time)" : ""}`);
  return lines.join("\n");
}

// Pages whose content lives in script data rather than HTML.
export function pageText(url: string, body: string): string {
  if (/script\.google(usercontent)?\.com/.test(url)) {
    // goog.script.init("<JS string holding JSON>") — the JSON's userHtml is the real page.
    const m = body.match(/goog\.script\.init\("((?:\\.|[^"\\])*)"/);
    if (m) {
      try {
        const js = m[1].replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1").replace(/\\'/g, "'");
        const cfg = JSON.parse(JSON.parse(`"${js}"`));
        if (cfg.userHtml) return htmlToText(cfg.userHtml);
      } catch { /* fall through */ }
    }
  }
  if (/mawaqit\.net/.test(url)) { const t = mawaqitText(body); if (t) return t; }
  return htmlToText(body);
}

// Rule bundle-timetables: a day-by-day timetable compiled into the site's own script bundle — month-keyed lists of
// daily objects ({1:[{fajr:"6:25",zuhr:"12:21",asr:"3:09",maghrib:"4:52",isha:"6:18"}, …], 2:[…]}) or one list
// for the whole year. Returned as dated lines for this month and next, exactly as written (often 12-hour, no am/pm).
const DAY_KEYS: Record<string, string> = { fajr: "Fajr", dhuhr: "Dhuhr", zuhr: "Dhuhr", zohr: "Dhuhr", duhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" };
export function bundleTimetable(js: string, now = new Date(), tz = "America/Toronto"): string | null {
  const day = (s: string) => {
    const o: Record<string, string> = {};
    for (const x of s.matchAll(/["']?([a-z]+)["']?\s*:\s*["']([^"']{3,8})["']/gi)) { const k = DAY_KEYS[x[1].toLowerCase()]; if (k && /\d{1,2}:\d{2}/.test(x[2])) o[k] = x[2]; }
    return o.Fajr && o.Maghrib && o.Isha ? o : null;
  };
  const list = (body: string) => { const d = [...body.matchAll(/\{[^{}\[\]]*\}/g)].map((m) => day(m[0])); return d.every(Boolean) ? d as Record<string, string>[] : []; };
  const months = new Map<number, Record<string, string>[]>();
  for (const m of js.matchAll(/(?:^|[{,\s])["']?(1[0-2]|0?\d)["']?\s*:\s*\[([^\[\]]{300,20000})\]/g)) {
    const d = list(m[2]);
    if (d.length >= 28 && d.length <= 31) months.set(Number(m[1]), d);
  }
  if (months.has(0) && !months.has(12)) { const z = new Map([...months].map(([k, v]) => [k + 1, v])); months.clear(); z.forEach((v, k) => months.set(k, v)); }
  if (months.size < 2) {   // one list for the whole year
    for (const m of js.matchAll(/\[([^\[\]]{20000,400000})\]/g)) {
      const d = list(m[1]);
      if (d.length < 365 || d.length > 366) continue;
      let i = 0;
      for (let mo = 1; mo <= 12; mo++) { const n = new Date(Date.UTC(2024, mo, 0)).getUTCDate() - (d.length === 365 && mo === 2 ? 1 : 0); months.set(mo, d.slice(i, i + n)); i += n; }
      break;
    }
  }
  if (months.size < 2) return null;
  const [y, mo] = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now).split("-").map(Number);
  const lines: string[] = [];
  for (const k of [0, 1]) {
    const mi = ((mo - 1 + k) % 12) + 1, yy = y + Math.floor((mo - 1 + k) / 12), days = months.get(mi);
    const last = new Date(Date.UTC(yy, mi, 0)).getUTCDate();
    days?.slice(0, last).forEach((r, i) => lines.push(`${yy}-${String(mi).padStart(2, "0")}-${String(i + 1).padStart(2, "0")} | ` + ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].map((p) => `${p} ${r[p] ?? "—"}`).join(" | ")));
  }
  return lines.length ? lines.join("\n") : null;
}

async function feeds(htmls: string[], base: URL): Promise<{ feeds: string[]; timetables: string[] }> {
  const found = new Set<string>(), timetables: string[] = [];
  const scan = (s: string) => { for (const m of s.matchAll(FEED_RE)) if (!FEED_SKIP.test(m[0])) found.add(m[0]); };
  htmls.forEach(scan);
  // The site's own script bundles (e.g. Next.js chunks) often hold the data URL, or the timetable itself.
  const scripts = new Set<string>();
  for (const h of htmls) for (const m of h.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try { const u = new URL(m[1].replace(/&amp;/g, "&"), base); if (bareHost(u.host) === bareHost(base.host) && !/wp-includes|jquery|elementor|bootstrap|swiper|gtag|analytics/i.test(u.pathname)) scripts.add(u.toString()); } catch { /* skip */ }
  }
  await Promise.all([...scripts].slice(0, 20).map(async (u) => {
    try {
      const js = await fetchText(u);
      scan(js);
      const t = /fajr/i.test(js) ? bundleTimetable(js) : null;
      if (t) timetables.push(`\n\n=== day-by-day timetable compiled into the site's own script ${u} (this month and next, times exactly as the site's calendar shows them; 12-hour times may be written without am/pm) ===\n${t}`);
    } catch { /* skip */ }
  }));
  return { feeds: [...found].slice(0, 3), timetables: timetables.slice(0, 1) };
}

export async function collect(site: string): Promise<{ text: string; urls: string[]; docs: Doc[] }> {
  if (/\.pdf(\?|$)/i.test(site)) {
    const d = await fetchPdf(site);
    return { text: `=== timetable PDF attached: ${site} ===`, urls: [site], docs: d ? [d] : [] };
  }
  const home = await fetchText(site);
  const base = new URL(site);
  const links = new Set<string>(), widgetLinks = new Set<string>();
  for (const m of home.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1], label = htmlToText(m[2]);
    if (LINK_RE.test(label) || LINK_RE.test(href)) {
      try {
        const u = new URL(href, base); u.hash = "";
        if (bareHost(u.host) === bareHost(base.host) && u.toString() !== site && u.toString() !== base.toString()) links.add(u.toString());
        else if (WIDGET_HOSTS.test(u.host)) widgetLinks.add(u.toString());   // e.g. "Prayer Times" → prayertimedisplay.com
      } catch { /* skip */ }
    }
  }
  const pages = [...links].slice(0, 3);
  const parts = [pageText(site, home)];
  const htmls = [home];
  const extra = new Set<string>([...widgetLinks, ...iframes(home, base)]);
  for (const u of pages) {
    try { const h = await fetchText(u); htmls.push(h); parts.push(`\n\n=== ${u} ===\n` + pageText(u, h)); iframes(h, new URL(u)).forEach((w) => extra.add(w)); } catch { /* skip */ }
  }
  const found = await feeds(htmls, base);
  for (const f of found.feeds) extra.add(f);
  parts.push(...found.timetables);
  // Timetable PDFs: the site itself may be one, or link to them.
  const pdfUrls = [...new Set([...(/\.pdf(\?|$)/i.test(site) ? [site] : []), ...htmls.flatMap((h) => pdfLinks(h, base))])].slice(0, 2);
  const docs = (await Promise.all(pdfUrls.map(fetchPdf))).filter((d): d is Doc => !!d);
  const done = new Set([site, ...pages]);
  for (const w of [...extra].filter((w) => !done.has(w)).slice(0, 4)) {
    try { parts.push(`\n\n=== embedded timetable widget / data feed ${w} ===\n` + pageText(w, await fetchText(w)).slice(0, 20_000)); } catch { /* skip */ }
  }
  if (docs.length) parts.push(`\n\n=== timetable PDF(s) attached: ${docs.map((d) => d.url).join(", ")} ===`);
  return { text: parts.join("\n").slice(0, 120_000), urls: [site, ...pages, ...extra], docs };
}
