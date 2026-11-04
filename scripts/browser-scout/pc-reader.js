// Adrik computer reader — page script run in a person's own Chrome on a mosque site (Claude in Chrome's
// javascript_tool), for sites that refuse automated readers but open normally in a person's browser
// (rule computer-reader). It finds the prayer-time blocks the same way the Browser Scout does (rule prayer-blocks),
// clicks a "prayer times" opener when no table is visible (rule open-pop-ups), and returns JSON with a checksum so
// the text reaches the Scout exactly as the page shows it (scripts/browser-scout/pc_ingest.py verifies it).
// It never interacts with a bot check: it only reports one.
await (async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(4000);
  const title = document.title, body = document.body?.innerText ?? "", short = body.length < 2500;
  if (short && /just a moment|attention required|verify you are human|checking (if )?the site connection|checking your browser|security check|captcha/i.test(`${title} ${body}`))
    return JSON.stringify({ challenge: true, title, url: location.href });
  if (short && /^(40[134]|50\d)\b|forbidden|not found|access denied|service unavailable|bad gateway/i.test(title))
    return JSON.stringify({ closed: true, title, url: location.href, text: body.slice(0, 200) });

  const names = [/\bfaj[a]?r\b|\bsubh\b/i, /\bdh?uh?r\b|\bzuhr\b|\bzohr\b/i, /\basr\b/i, /\bmagh?rib\b/i, /\bisha\b/i];
  const hits = (t) => names.filter((r) => r.test(t)).length;
  const find = () => {
    const ok = [...document.querySelectorAll("body *")].filter((el) => {
      const t = el.innerText || "", r = el.getBoundingClientRect();
      return t.length <= 2500 && hits(t) >= 3 && /\d{1,2}:\d{2}/.test(t) && r.width >= 120 && r.height >= 80;
    });
    // Widen the smallest blocks to keep headers, dates and Jumu'ah rows next to them.
    const widen = (el) => {
      let e = el.closest("table") ?? el;
      for (let k = 0; k < 3 && e.parentElement; k++) {
        const p = e.parentElement, pt = p.innerText || "", et = e.innerText || "";
        if (pt.length > et.length + 400 || !/iqam|adhan|athan|azan|jama|begins|start|jumu|friday|\b20\d\d\b|tomorrow/i.test(pt.replace(et, ""))) break;
        e = p;
      }
      return e;
    };
    const blocks = [...new Set(ok.filter((el) => !ok.some((o) => o !== el && el.contains(o))).map(widen))];
    return blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b))).slice(0, 3);
  };

  let top = find();
  const clicked = [];
  if (!top.length) {
    const sel = "a, button, [role=button], [role=tab], summary, [data-toggle], [data-bs-toggle], .elementor-tab-title";
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim(), r = el.getBoundingClientRect();
      if (t.length < 3 || t.length > 40 || !/prayer|salah|salat|namaz|iqama|iqamah|timings?/i.test(t) || !r.width) continue;
      const href = el.getAttribute("href") || "";
      if (href && !/^(#|javascript)/.test(href) && new URL(href, location.href).pathname !== location.pathname) continue;   // stay on this page
      el.click(); clicked.push(t);
      // Panels often load their times after opening: wait up to 8 s before trying another opener (a second click
      // on a toggle would close the panel again).
      for (let w = 0; w < 16 && !(top = find()).length; w++) await sleep(500);
      if (top.length || clicked.length >= 3) break;
    }
  }
  // Plain spaces only (non-breaking and other Unicode spaces become " ", zero-width characters go), so a copy of the
  // text is exact and the checksum holds.
  const tidy = (s) => s.replace(/[\u200b-\u200d\u2060\ufeff]/g, "").replace(/[^\S\n]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
  const blocks = top.map((b) => tidy(b.innerText));
  const jumuah = [...document.querySelectorAll("body *")]
    .filter((el) => /jum[uma]+'?a?h?|friday/i.test(el.innerText || "") && /\d{1,2}:\d{2}/.test(el.innerText || "") && (el.innerText || "").length < 400)
    .filter((el, i, a) => !a.some((o) => o !== el && el.contains(o))).slice(0, 3).map((el) => tidy(el.innerText));
  // Checksum (FNV-1a over UTF-8) of exactly what is sent; pc_ingest.py refuses a copy that does not match.
  const text = blocks.join("\n=====\n") + "\n#####\n" + jumuah.join("\n");
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return JSON.stringify({ url: location.href, title, clicked, blocks, jumuah, check: h.toString(16) });
})()
