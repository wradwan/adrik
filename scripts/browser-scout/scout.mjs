// Adrik Browser Scout — reads mosque sites in a real browser, the way a person does.
//
// For each target mosque it opens the site in Chromium, lets the page's scripts run, follows
// "prayer times" links, and collects:
//   - the rendered text of every frame (embedded widgets included)
//   - screenshots of the blocks that hold prayer times (found by prayer names on screen), including
//     pop-ups and tabs opened by buttons like "See prayer times"
//   - schedule data a page keeps in its own code (inline scripts)
//   - timetable images the site posts (monthly calendars, Ramadan charts, ...)
// It sends that to the scout edge function (mode "ingest"), where Claude reads the text and the
// screenshots and stores the iqama times with the same rules as the regular Scout.
//
// Usage:
//   node scout.mjs                      read every mosque the database says needs a browser read
//   node scout.mjs --id <uuid> --url <site> [--id … --url …]   read specific mosques
//   node scout.mjs --check [--id …]     read the mosques in answer-keys.json and compare with their keys
//   node scout.mjs --dry --url <url>    capture only (no Claude, no database); writes ./out/
//   node scout.mjs --image <file> --id <uuid> [--taken YYYY-MM-DD] [--url <site>] [--dry]
//                                       screenshot inbox: a community member's screenshot of the mosque's own site,
//                                       read with the same rules (--dry: read only, store nothing)
// Every lesson is a general rule in supabase/functions/scout/rules.ts; --check reports each rule as passing,
// failing or untested, from the rule ids listed in answer-keys.json.
// Auth: in GitHub Actions a GitHub OIDC token is used automatically; elsewhere set ADRIK_SCOUT_ADMIN_TOKEN.
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const API = process.env.ADRIK_SCOUT_URL ?? "https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/scout";
// Public anon key (same one the web app ships); the function also requires a trusted caller.
const ANON = process.env.ADRIK_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZib3d2bnd5dHV0bHRzZG5qY3hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MzIzNDEsImV4cCI6MjEwODUwODM0MX0.nLpuv5rDvdka8tfuZ3Ic_T1SdceNtPDTzfhkg6NEYVc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 AdrikScout/0.2";
const LINK_RE = /prayer|salah|salat|namaz|iqama|iqamah|jamaat|timing|timetable|اوقات|الصلاة/i;
// Rule bot-check: challenge pages are recognised and left alone (never solved or forced).
const BOT_TITLE = /just a moment|attention required|verify you are human|checking your browser|security check|are you a robot|access denied/i;
const BOT_TEXT = /verify you are human|checking (if )?the site connection( is)? secur|checking your browser|enable javascript and cookies to continue|requires cookies to be enabled|performing security verification|needs to review the security of your connection|you have been blocked|access denied|forbidden|don't have permission to access/i;
const BOT_URL = /\/\.well-known\/sgcaptcha|\/cdn-cgi\/challenge-platform|[?&]__cf_chl|captcha/i;
const IMG_RE = /prayer|salah|salat|namaz|timetable|time-?table|iqama|jamaat|schedule|calendar|ramadan|timing|monthly/i;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const values = (f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []));

async function authHeaders() {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    const r = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=adrik-scout`, { headers: { Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    return { "x-github-oidc": (await r.json()).value };
  }
  if (process.env.ADRIK_SCOUT_ADMIN_TOKEN) return { "x-adrik-admin": process.env.ADRIK_SCOUT_ADMIN_TOKEN };
  throw new Error("No credentials: run in GitHub Actions or set ADRIK_SCOUT_ADMIN_TOKEN");
}

async function call(body) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, ...(await authHeaders()) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const bare = (h) => h.replace(/^www\./i, "").toLowerCase();

// Marks the smallest on-screen elements that list at least three prayer names (and are not marked yet).
const MARK_BLOCKS = (tag) => {
  const names = [/\bfaj[a]?r\b|\bsubh\b/i, /\bdh?uh?r\b|\bzuhr\b|\bzohr\b|\bduhr\b/i, /\basr\b/i, /\bmagh?rib\b/i, /\bisha\b/i];
  const hits = (t) => names.filter((r) => r.test(t)).length;
  const ok = [];
  for (const el of document.querySelectorAll("body *")) {
    const t = el.innerText || "";
    if (t.length > 2500 || hits(t) < 3 || !/\d{1,2}:\d{2}/.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) continue;
    ok.push(el);
  }
  // Smallest blocks, widened to keep column headers (Adhan / Iqamah) in the picture.
  const widen = (el) => {
    let e = el.closest("table") ?? el;
    for (let k = 0; k < 3 && e.parentElement; k++) {
      const p = e.parentElement, pt = p.innerText || "", et = e.innerText || "";
      if (pt.length > et.length + 300 || !/iqam|adhan|athan|azan|jama|begins|start/i.test(pt.replace(et, ""))) break;
      e = p;
    }
    return e;
  };
  const minimal = [...new Set(ok.filter((el) => !ok.some((o) => o !== el && el.contains(o))).map(widen))].filter((el) => !el.closest("[data-adrik-block]"));
  minimal.slice(0, 3).forEach((el, i) => el.setAttribute("data-adrik-block", `${tag}-${i}`));
  return Math.min(minimal.length, 3);
};

// Marks buttons and tabs that open a prayer-times pop-up or panel ("See prayer times", "Salah timings").
const MARK_OPENERS = () => {
  const re = /prayer|salah|salat|namaz|iqama|iqamah|jamaat|timings?/i;
  const sel = 'button, [role=button], [role=tab], summary, a[href="#"], a[href^="#"], a[href^="javascript"], [data-toggle], [data-bs-toggle], .elementor-tab-title';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
    const r = el.getBoundingClientRect();
    if (t.length < 3 || t.length > 40 || !re.test(t) || r.width === 0 || r.height === 0) continue;
    el.setAttribute("data-adrik-open", String(out.length));
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
};

let pass = 0;
// Rendered text of every frame plus screenshots of the prayer-time blocks now on screen.
async function grab(page, out, label) {
  const texts = [];
  for (const f of page.frames()) {
    try { const t = await f.evaluate(() => document.body?.innerText ?? ""); if (t.trim()) texts.push((f === page.mainFrame() ? "" : `--- widget ${f.url()} ---\n`) + t.slice(0, 30_000)); } catch { /* detached */ }
  }
  out.text.push(`=== ${label} ===\n` + texts.join("\n\n"));
  for (const f of page.frames()) {
    if (out.images.length >= 3) break;
    const tag = `p${++pass}`;
    let n = 0;
    try { n = await f.evaluate(MARK_BLOCKS, tag); } catch { continue; }
    let failed = false;
    for (let i = 0; i < n && out.images.length < 3; i++) {
      try {
        const buf = await f.locator(`[data-adrik-block="${tag}-${i}"]`).first().screenshot({ type: "jpeg", quality: 85, timeout: 8_000 });
        out.images.push({ media_type: "image/jpeg", data: buf.toString("base64"), why: `prayer block (${label}) on ${f.url()}` });
      } catch { failed = true; }
    }
    // Some widgets cannot be cropped from inside (they block scrolling): photograph the whole widget instead.
    if (failed && f !== page.mainFrame() && out.images.length < 3) {
      try {
        const buf = await (await f.frameElement()).screenshot({ type: "jpeg", quality: 85, timeout: 10_000 });
        out.images.push({ media_type: "image/jpeg", data: buf.toString("base64"), why: `whole widget ${f.url()}` });
      } catch { /* skip */ }
    }
  }
}

class BotCheck extends Error {}
// A challenge page (Cloudflare, SiteGround, captcha) or a short refusal (HTTP 401/403/406/429): the site
// does not let automated readers in. Long pages that merely mention "captcha" (contact forms) are not refusals.
async function botCheck(page, status) {
  const title = await page.title().catch(() => "");
  const text = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 4000)).catch(() => "");
  const challenge = page.frames().some((f) => /challenges\.cloudflare\.com|hcaptcha\.com\/captcha|turnstile/i.test(f.url()));
  const short = text.length < 2500;
  const why = BOT_TITLE.test(title) ? title.trim()
    : short && BOT_URL.test(page.url()) ? "captcha page"
    : short && challenge ? "challenge widget"
    : short && BOT_TEXT.test(text) ? (text.match(BOT_TEXT)?.[0] ?? "refusal")
    : short && [401, 403, 406, 429].includes(status) ? `HTTP ${status}` : null;
  return why ? `${why}${status && status !== 200 ? ` (HTTP ${status})` : ""} at ${page.url()}` : null;
}

async function readPage(page, url, out) {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  const bot = await botCheck(page, resp?.status());
  if (bot) throw new BotCheck(bot);
  await grab(page, out, page.url());
  // Schedules some sites keep in their page code (e.g. a WordPress prayer plugin's settings).
  const data = await page.$$eval("script:not([src])", (els) => els.map((e) => e.textContent || "")
    .filter((t) => t.length < 60_000 && /fajr/i.test(t) && /isha/i.test(t) && /\d{1,2}:\d{2}/.test(t)).map((t) => t.slice(0, 15_000))).catch(() => []);
  if (data.length) out.text.push(`=== schedule data in the page code of ${page.url()} (use only where its structure is explicit; what the page displays wins) ===\n` + data.slice(0, 2).join("\n\n"));
  // Open prayer-times pop-ups, tabs and accordions, then read what appears.
  const openers = await page.evaluate(MARK_OPENERS).catch(() => []);
  for (const [i, label] of openers.entries()) {
    try {
      const before = page.url();
      await page.locator(`[data-adrik-open="${i}"]`).first().click({ timeout: 5_000 });
      await page.waitForTimeout(2_500);
      if (page.url().split("#")[0] !== before.split("#")[0]) { await page.goBack({ timeout: 15_000 }).catch(() => {}); continue; }
      await grab(page, out, `${page.url()} after clicking "${label}"`);
      await page.keyboard.press("Escape").catch(() => {});
    } catch { /* not clickable */ }
  }
  // Timetable images posted on the page.
  const imgs = await page.$$eval("img", (els) => els.map((e) => ({ src: e.currentSrc || e.src, alt: e.alt || "", title: e.title || "", w: e.naturalWidth, h: e.naturalHeight })));
  for (const im of imgs) {
    if (out.images.length >= 4) break;
    if (im.w < 400 || im.h < 300 || !IMG_RE.test(`${im.src} ${im.alt} ${im.title}`)) continue;
    try {
      const r = await page.request.get(im.src, { timeout: 15_000 });
      const type = (r.headers()["content-type"] ?? "").split(";")[0];
      const body = await r.body();
      if (/^image\/(png|jpeg|webp|gif)$/.test(type) && body.length < 3_500_000) out.images.push({ media_type: type, data: body.toString("base64"), why: `timetable image ${im.src}` });
    } catch { /* skip */ }
  }
  return page.$$eval("a[href]", (as) => as.map((a) => ({ href: a.href, text: (a.innerText || a.title || "").trim().slice(0, 80) })));
}

async function capture(browser, site) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5, locale: "en-CA", timezoneId: "America/Toronto" });
  const page = await ctx.newPage();
  const out = { text: [], images: [], pages: [site] };
  try {
    let links;
    try { links = await readPage(page, site, out); } catch (e) { if (e instanceof BotCheck) return { blocked: e.message }; throw e; }
    const base = new URL(page.url());
    const next = [...new Map(links.filter((l) => {
      try { const u = new URL(l.href); return bare(u.host) === bare(base.host) && (LINK_RE.test(l.text) || LINK_RE.test(u.pathname)) && u.href.split("#")[0] !== page.url().split("#")[0]; } catch { return false; }
    }).map((l) => [l.href.split("#")[0], l])).values()].slice(0, 2);
    for (const l of next) { try { out.pages.push(l.href); await readPage(page, l.href.split("#")[0], out); } catch { /* skip (a bot check on a sub-page just ends that page) */ } }
    if (!out.images.length) {   // nothing recognisable: one screenshot of the top of the home page
      await page.goto(site, { waitUntil: "domcontentloaded", timeout: 35_000 }).catch(() => {});
      await page.waitForTimeout(4_000);
      const buf = await page.screenshot({ type: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 1280, height: 2400 }, fullPage: true }).catch(() => null);
      if (buf) out.images.push({ media_type: "image/jpeg", data: buf.toString("base64"), why: "top of home page" });
    }
  } finally { await ctx.close(); }
  return { text: out.text.join("\n\n").slice(0, 110_000), images: out.images, pages: out.pages };
}

// Compare what Claude extracted with an answer key (times "HH:MM"; rules "sunset", "sunset+3", "adhan+5").
// Maghrib is compared loosely: a sunset rule and a fixed time a few minutes after sunset are the same jama'ah.
function compare(key, got) {
  const diffs = [];
  for (const p of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
    const want = key.times?.[p], have = got?.[p];
    if (!want || have === want) continue;
    const sunsetish = (v) => v && (/^sunset/.test(v) || /^1[6-8]:\d\d$/.test(v));
    if (p === "maghrib" && sunsetish(want) && sunsetish(have)) continue;
    diffs.push(`${p}: key ${want}, got ${have ?? "nothing"}`);
  }
  const wantJ = (key.jumuah ?? []).map((j) => j.khutbah).sort(), haveJ = (got?.jumuah ?? []).map((j) => j.khutbah).sort();
  if (wantJ.length && wantJ.join() !== haveJ.join()) diffs.push(`jumu'ah khutbah: key ${wantJ.join(", ")}, got ${haveJ.join(", ") || "nothing"}`);
  return diffs;
}

const keyFile = new URL("./answer-keys.json", import.meta.url);
const keys = JSON.parse(await readFile(keyFile, "utf8"));
const mediaType = (f) => /\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg";

// Screenshot inbox: no browser needed.
async function readScreenshot({ file, id, taken, url, dry }) {
  const data = (await readFile(file)).toString("base64");
  return call({ mode: "ingest", source: "screenshot", dry, mosque_id: id, url, taken, text: "", images: [{ media_type: mediaType(file), data }] });
}
if (values("--image").length && !flag("--check")) {
  const ids = values("--id"), taken = values("--taken"), urls = values("--url");
  for (const [i, file] of values("--image").entries()) {
    try {
      const res = await readScreenshot({ file, id: ids[i], taken: taken[i] ?? taken[0], url: urls[i], dry: flag("--dry") });
      console.log(`• ${file}: ${res.status === "dry" ? "dry run, " : ""}${res.rows} rows, ${res.rules} rules, ${res.jumuah} jumu'ah, confidence ${res.confidence}, stored as ${res.stored_as}`);
      if (res.status === "dry") console.log("    " + JSON.stringify(res.resolved_today) + "\n    notes: " + res.notes);
    } catch (e) { process.exitCode = 1; console.log(`• ${file}: ERROR ${String(e).slice(0, 200)}`); }
  }
  process.exit();
}

// Per-rule test report (rule ids come from the rulebook; keys list the rules they exercise).
const { RULES } = await import(new URL("../../supabase/functions/scout/rules.ts", import.meta.url));
const ruleIds = new Set(RULES.map((r) => r.id));
for (const k of keys.keys) for (const r of k.rules ?? []) if (!ruleIds.has(r)) throw new Error(`answer key ${k.name}: unknown rule "${r}"`);
const ruleResult = new Map();   // id -> { pass: [], fail: [], stale: [] }
const record = (key, status) => { for (const r of key.rules ?? []) { const e = ruleResult.get(r) ?? { pass: [], fail: [], stale: [] }; e[status].push(key.name); ruleResult.set(r, e); } };

const browser = await chromium.launch();
try {
  let targets;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const chosen = (k) => !values("--id").length || values("--id").includes(k.mosque_id);
  if (flag("--dry")) targets = values("--url").map((u) => ({ name: u, website: u }));
  else if (flag("--check")) targets = [...new Map(keys.keys.filter((k) => chosen(k) && !k.image).map((k) => [k.mosque_id, { id: k.mosque_id, name: k.name, website: k.url }])).values()];
  else if (values("--id").length) {
    const urls = values("--url");
    const known = urls.length ? [] : (await call({ mode: "targets" })).targets;
    targets = values("--id").map((id, i) => ({ id, website: urls[i] ?? known.find((k) => k.id === id)?.website }));
  }
  else {
    const t = await call({ mode: "targets" });
    targets = t.targets;
    for (const b of t.blocked ?? []) console.log(`• ${b.name}: skipped — ${b.reason} (since ${String(b.since).slice(0, 10)})`);
  }
  console.log(`Browser Scout: ${targets.length} mosque(s)`);
  let fails = 0;
  const verdict = (line, key, diffs, stale) => {
    if (stale) { record(key, "stale"); console.log(`${line}\n    ⚠ ${stale}`); return; }
    record(key, diffs.length ? "fail" : "pass");
    if (diffs.length) fails++;
    console.log(`${line}\n    ${diffs.length ? "✗ " + diffs.join("\n    ✗ ") : "✓ matches the answer key"}`);
  };
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const cap = await capture(browser, t.website);
      const keyFor = (d) => keys.keys.find((k) => k.mosque_id === t.id && !k.image && d >= k.valid_from && d <= k.valid_to) ?? keys.keys.find((k) => k.mosque_id === t.id && !k.image);
      if (cap.blocked) {
        const line = `• ${t.name ?? t.website}: bot check — not read (${cap.blocked})`;
        if (!flag("--dry")) await call({ mode: "blocked", mosque_id: t.id, url: t.website, reason: cap.blocked });
        if (flag("--check")) { const key = keyFor(today); verdict(line, key, key.expect === "bot check" ? [] : ["site showed a bot check"]); }
        else console.log(line);
        continue;
      }
      if (flag("--dry")) {
        await mkdir("out", { recursive: true });
        const slug = t.website.replace(/https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
        await writeFile(`out/${slug}.txt`, cap.text);
        for (const [i, im] of cap.images.entries()) await writeFile(`out/${slug}_${i}.jpg`, Buffer.from(im.data, "base64"));
        console.log(`• ${t.website}: ${cap.text.length} chars, ${cap.images.length} image(s) [${cap.images.map((i) => i.why).join("; ")}] in ${Date.now() - t0} ms`);
        continue;
      }
      const res = await call({ mode: "ingest", mosque_id: t.id, url: t.website, text: cap.text, images: cap.images.map(({ media_type, data }) => ({ media_type, data })) });
      const line = `• ${t.name ?? t.id}: ${res.rows} rows, ${res.rules} rules, ${res.jumuah} jumu'ah, confidence ${res.confidence}, ${cap.images.length} image(s), ${Math.round((Date.now() - t0) / 1000)}s` +
        (res.stored_as && res.stored_as !== "iqama" ? ` — ${res.stored_as}` : "");
      if (flag("--check")) {
        const d = res.resolved_today?.date, key = keyFor(d);
        if (!(d >= key.valid_from && d <= key.valid_to)) { verdict(line, key, [], `key covers ${key.valid_from}..${key.valid_to}; today is ${d} — send a fresh screenshot (rule daily-keys-expire)`); continue; }
        if (key.expect === "bot check") { record(key, "stale"); console.log(`${line}\n    ⚠ the site no longer shows a bot check — add a times key from a screenshot`); continue; }
        verdict(line, key, key.expect === "held back" ? (res.stored_as === "iqama" && res.rows + res.rules > 0 ? ["adhan-only page was stored as iqama"] : [])
          : compare(key, res.resolved_today).concat(res.stored_as && res.stored_as !== "iqama" ? [`stored as ${res.stored_as}`] : []));
      } else console.log(line);
    } catch (e) { fails++; console.log(`• ${t.name ?? t.website}: ERROR ${String(e).slice(0, 200)}`); }
  }
  // Screenshot fixtures: re-read every check with all the rules, writing nothing (dry run).
  if (flag("--check")) for (const key of keys.keys.filter((k) => k.image && chosen(k))) {
    const t0 = Date.now();
    try {
      const res = await readScreenshot({ file: new URL(key.image, keyFile), id: key.mosque_id, taken: key.taken, url: key.url, dry: true });
      verdict(`• ${key.name} [screenshot ${key.taken}]: ${res.rows} rows, ${res.rules} rules, ${res.jumuah} jumu'ah, confidence ${res.confidence}, ${Math.round((Date.now() - t0) / 1000)}s`,
        key, compare(key, res.resolved_today).concat(res.stored_as !== "iqama" ? [`stored as ${res.stored_as}`] : []));
    } catch (e) { fails++; record(key, "fail"); console.log(`• ${key.name} [screenshot]: ERROR ${String(e).slice(0, 200)}`); }
  }
  if (flag("--check")) {
    console.log("\nRules (supabase/functions/scout/rules.ts):");
    for (const r of RULES) {
      const e = ruleResult.get(r.id);
      const mark = e?.fail.length ? "✗" : e?.pass.length ? "✓" : e?.stale.length ? "⚠" : "·";
      const tail = e?.fail.length ? `failing: ${e.fail.join(", ")}` : e?.pass.length ? `${e.pass.length} key(s)` : e?.stale.length ? `only expired keys: ${e.stale.join(", ")}` : (["read", "browser"].includes(r.kind) && !values("--id").length ? "no answer key yet" : "");
      console.log(`  ${mark} ${r.kind.padEnd(7)} ${r.id}${tail ? " — " + tail : ""}`);
    }
  }
  if (flag("--check") && fails) process.exitCode = 1;
} finally { await browser.close(); }
