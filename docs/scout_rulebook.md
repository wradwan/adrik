# Adrik Scout rulebook

Every lesson learned from a mosque website, written as a **general rule** that applies to every mosque — including mosques added later.
Generated from `supabase/functions/scout/rules.ts` (the single source of truth) and `scripts/browser-scout/answer-keys.json`; do not edit by hand.

**Adding a lesson.** When a site is read wrong: (1) write the general rule in `rules.ts` — never hand-enter that mosque's times; (2) add an answer key (or a screenshot fixture) that would have caught it and list the rule id in its `rules`; (3) push. Every push re-runs all answer keys and prints each rule as passing (✓), failing (✗) or untested (·).

**46 rules**: 23 reading a schedule · 5 checks in code · 6 finding the times (plain reader) · 8 reading in a real browser · 4 keeping the rules honest.

## Reading a schedule

Sent to Claude, word for word, as its reading instructions for every mosque.

| Rule | What it says | Learned from | Tested by |
|---|---|---|---|
| `iqama-not-adhan` | Iqama ≠ adhan. If a table has both ADHAN and IQAMA columns, extract IQAMA. Columns called "Begins", "Starts", "Start" or "Athan" are adhan; "Iqama", "Iqamah", "Jamaat", "Jama'ah", "Congregation" are iqama. If only one column exists and the page calls it "prayer times" with no iqama column, set has_iqama=false and still return the times with times_are="adhan". | Scout design; Ar-Rashaad, Masjid Mubarak, Bab ul Ilm (single-column pages) | Bramalea Islamic Cultural Centre (BICC), Bab ul Ilm - Bani Hashim Society, Masjid Mubarak (Ahmadiyya) |
| `athan-beside-iqama` | When each prayer shows two times and only one of them is labelled Athan/Adhan/Begins/Start, the other (usually the larger, unlabelled time) is the iqama. | ISNA Canada / Islamic Centre of Canada (big iqama time, small 'Athan' time beside it) | ISNA Canada (Islamic Centre of Canada) (screenshot) |
| `next-iqamah-label` | A "Next Iqamah" / "until iqamah" countdown above a single list of times labels that list as iqama times, even under a "Prayer Times" heading: set has_iqama=true. | BARIC (heading 'Prayer Times', countdown 'Next Iqamah: Fajr') | Brampton and Regional Islamic Centre (BARIC) (screenshot) |
| `not-a-prayer` | Shuruq/Sunrise, Imsak, Sunset, Midnight, Tahajjud and Ishraq rows are not congregational prayers: never return them as an iqama. Countdown timers, "current time" and clocks are not schedule times. | ISNA (Shuruq under Fajr), Bab ul Ilm (Imsak, Sunrise), Masjid Mubarak (Sunset row), BARIC/ISNA countdowns | Bab ul Ilm - Bani Hashim Society, Brampton and Regional Islamic Centre (BARIC) (screenshot), ISNA Canada (Islamic Centre of Canada) (screenshot) |
| `never-invent` | Never invent a time. A cell you cannot read -> null. A month not on the page -> omit it. | Scout design | — |
| `formats` | Dates: ISO YYYY-MM-DD. Times: 24-hour HH:MM local to the mosque. Convert "4:15 pm" -> "16:15". | Scout design | Brampton and Regional Islamic Centre (BARIC) (screenshot) |
| `rules-beat-tables` | Rules beat tables. If the page says "Maghrib: Sunset", "5 minutes after adhan", "Isha fixed at 8:00 pm", return a rule in rules, not per-day rows for that prayer. | Rahmat (Maghrib sunset+3), Al Hassan, Masjid-E-Aqsa | Masjid-E-Aqsa, Masjid Rahmatul-lil-Alameen, Al Hassan Community Centre, Al-Hikmah Centre, Anatolia Islamic Centre, DawaNet Community Centre |
| `maghrib-sunset-note` | A Maghrib time with a note like "Maghrib is sunset time" is a sunset rule, not a fixed time. | Masjid-E-Aqsa (page note: Maghrib at sunset) | Masjid-E-Aqsa |
| `today-box-plus-change-table` | A change of iqama mid-month is normal. Return per-day rows; do not collapse to one value. A "today" box plus an "iqama time change" table: use the table for the dates it covers. | BICC (today's box + change table for 01–10 Nov) | Bramalea Islamic Cultural Centre (BICC) |
| `date-range-block` | A block labelled with a date range ("Nov 2 - 6", "Effective Nov 1 – Nov 30") applies to every day in that range: return a row per day, or rules with valid_from/valid_to. | Ar-Rashaad ('Nov 2 - 6'), Al Hassan ('Effective Nov 1 - 30') | Ar-Rashaad Centre, Al Hassan Community Centre |
| `jumuah-start-iqamah` | Jumu'ah: return each slot's khutbah start and salah start. If the page gives "Start" and "Iqamah" per slot, Start is the khutbah and Iqamah is the salah. If it gives only an iqamah/salah time, put it in salah_time and also in khutbah_time. If salah is N minutes after khutbah, return salah_offset_min=N and salah_time=null. | Masjid-E-Aqsa (4 slots, iqamah only), BICC, Rowdah, DawaNet (start + iqamah) | Masjid-E-Aqsa, Ar-Rashaad Centre, Bramalea Islamic Cultural Centre (BICC), Masjid Rahmatul-lil-Alameen, Al Hassan Community Centre, DawaNet Community Centre, Rowdah Centre |
| `jumuah-athan` | A Jumu'ah slot listed with an "Athan" time equal to the slot's time: that time is the khutbah start (the Friday adhan is called as the khateeb takes the minbar). Return khutbah_time = that time and salah_time = null. | ISNA (Jummah 1 1:00 PM / Athan 1:00 PM; Jummah 2 3:00 PM / Athan 3:00 PM) | ISNA Canada (Islamic Centre of Canada) (screenshot) |
| `second-jamaah` | Multiple jama'ahs for one prayer -> separate entries in second_jamaah with seq 2, 3... and a label. | Scout design | — |
| `arrow-change` | Time changes written as "X --> Y", "X → Y" or "X to Y" (e.g. at a DST change) mean the iqama moved from X to Y: Y is the current time. Under a heading like "Jamaat Timings" or "Iqama" these ARE iqama times (has_iqama=true). | Rahmat ('Jamaat Timings' box at the November DST change) | Masjid Rahmatul-lil-Alameen |
| `feed-placeholders` | Data feeds and widgets: "00:00", "--:--" or an empty value is a placeholder, never an iqama time. A placeholder Maghrib in a feed means the site shows sunset: return a Maghrib "sunset" rule. | Site data feeds read by the HTTP Scout (Maghrib left empty when the site shows sunset) | — |
| `mawaqit-offset` | "N min after adhan" (Mawaqit "+N"): return a rule — offset_from_adhan with minutes=N; for Maghrib use sunset_offset with minutes=N. Fixed times in a per-day calendar go in months as rows. | Anatolia Islamic Centre (Mawaqit: Asr +5, Maghrib +3) | Anatolia Islamic Centre |
| `tomorrow-line` | A "Tomorrow" line under a prayer (or a "tomorrow's iqama change" note) gives that prayer's iqama for the NEXT date: today's value is the one in the prayer's own row; return the tomorrow value as a row for tomorrow's date. In flattened text like "MAGHRIB / TOMORROW 5:07 5:12 / 5:11", 5:07 is the start, 5:12 today's iqama and 5:11 tomorrow's. | Rowdah Centre (prayertimedisplay.com widget, red 'Tomorrow' line) | Rowdah Centre |
| `screenshot-date` | A screenshot sent by a community member shows one day: use the date it displays (not the day it was received). | Screenshot inbox (BARIC, ISNA) | Brampton and Regional Islamic Centre (BARIC) (screenshot), ISNA Canada (Islamic Centre of Canada) (screenshot) |
| `ignore-city-widgets` | Screenshots: when page screenshots or timetable images are attached, read them as part of the page and prefer them over garbled text. Ignore generic city prayer-time widgets (e.g. "Toronto prayer times") that are not this mosque's iqama. | Ar-Rashaad (timesprayer.com Toronto widget beside the real block), Masjid Mubarak (Vaughan city table) | Ar-Rashaad Centre, Masjid Mubarak (Ahmadiyya) |
| `pdf-year-columns` | An attached PDF is a timetable the mosque links to: read it as part of the page, check which year it is for, and whether its columns are iqama or prayer-start times. A perpetual or past-year calculated timetable is adhan times, not iqama. | Islamic Forum of Canada (2011 perpetual start-time PDF) | — |
| `location-picker` | Sites with several locations or a "Change location" picker: use the times for this mosque's own location. A mosque's own website often names its centre differently from our list (the organization's name vs. the centre's name, an acronym vs. the full name), so on the mosque's own site the location shown by default IS this mosque — unless the page clearly names a different city or address than the one given for this mosque. Only then return no times. | ISNA Canada (site shows its centre 'Islamic Centre of Canada (ICC)' with a location picker; a stricter first version of this rule wrongly returned nothing — caught by the screenshot fixture) | ISNA Canada (Islamic Centre of Canada) (screenshot) |
| `facilities-explicit` | Extract facilities only if explicitly stated. Otherwise null. | Scout design | — |
| `honest-confidence` | confidence is your honest 0-1 estimate that every returned time matches the page. | Scout design | — |

## Checks in code

Enforced by the scout edge function after Claude has read the page, whatever Claude concluded.

| Rule | What it says | Learned from | Tested by |
|---|---|---|---|
| `adhan-check`<br><sub>index.ts adhanVerdict()</sub> | Adhan vs iqama is decided by arithmetic, not by the page's label: compare Fajr/Dhuhr/Asr/Isha with the calculated adhan for the mosque's location and date. ≥60% within 3 min → adhan (held back); ≤25% → iqama; in between, Claude's reading decides. | Ar-Rashaad (wrongly held back because its block says 'Prayer Times'), Masjid Mubarak (correctly held back) | Masjid-E-Aqsa, Ar-Rashaad Centre, Masjid Mubarak (Ahmadiyya) |
| `iqama-never-before-adhan`<br><sub>index.ts adhanVerdict()</sub> | An iqama can never come before the adhan: any time more than 5 min before the earliest possible adhan (Shafi) marks the set as adhan/calculated times and holds it back. | Bab ul Ilm (Jafari Fajr before the ISNA adhan), other calculated-time pages | Bab ul Ilm - Bani Hashim Society |
| `rule-replacement`<br><sub>index.ts store()</sub> | A new standing rule for a prayer ends the older open rule for that prayer the day before the new one starts — mosques change times, and the old rule must not linger. | Al-Hikmah Centre (Asr moved 15:30 → 15:00 on 3 Nov) | — |
| `no-placeholder-rows`<br><sub>index.ts store()</sub> | "00:00" values are never stored as iqama rows. | Site data feeds with empty Maghrib | — |
| `review-low-confidence`<br><sub>index.ts store()</sub> | A read with confidence below 0.8, or held back as adhan, is flagged needs_review; held-back rows are quarantined and never shown in the app. | Scout design | — |

## Finding the times (plain reader)

How the HTTP Scout finds where a site keeps its times.

| Rule | What it says | Learned from | Tested by |
|---|---|---|---|
| `same-site-links`<br><sub>collect.ts collect()</sub> | Follow "prayer times" links on the same site; www / non-www and http / https are the same site. | Peel sites linking between www and bare domains | — |
| `widget-iframes`<br><sub>collect.ts iframes()</sub> | Open embedded timetable widgets (themasjidapp, Masjidal, Mawaqit, MasjidBox, Google Apps Script, anything named prayer/salah/iqama/timetable). | Peel sites embedding third-party prayer widgets | Anatolia Islamic Centre |
| `mawaqit-calendar`<br><sub>collect.ts mawaqitText()</sub> | Mawaqit pages keep the whole year's iqama calendar in a confData script variable: read it for this month and next. | Anatolia Islamic Centre | — |
| `apps-script-pages`<br><sub>collect.ts pageText()</sub> | Google Apps Script web apps hide the real page in a JSON-escaped userHtml string: decode it before reading. | Peel sites publishing their timetable as an Apps Script page | — |
| `script-feeds`<br><sub>collect.ts feeds()</sub> | Pages that load times by script: find the data feed (Firebase *.json, Apps Script /exec, */prayer*.json) in the HTML or in the site's own script bundles, and read it. | Al-Hikmah Centre (Next.js site loading prayer-time.json) | — |
| `timetable-pdfs`<br><sub>collect.ts pdfLinks()/fetchPdf()</sub> | Timetable PDFs linked from the site (calendar, schedule, timetable…) are sent to Claude as documents. | Islamic Forum of Canada (SALAH-TIMETABLE.pdf) | — |

## Reading in a real browser

How the Browser Scout (GitHub Actions, Chromium) reads sites the plain reader cannot.

| Rule | What it says | Learned from | Tested by |
|---|---|---|---|
| `real-browser`<br><sub>scout.mjs capture()</sub> | Sites that refuse plain readers or draw their times with scripts are read in a real browser after the page's scripts run, including every embedded frame. | DawaNet (HTTP 406 to the plain Scout), script-drawn widgets | Masjid-E-Aqsa, Ar-Rashaad Centre, DawaNet Community Centre |
| `prayer-blocks`<br><sub>scout.mjs MARK_BLOCKS</sub> | Photograph the smallest on-screen blocks that list at least three prayer names with times, widened to keep column headers (Adhan / Iqamah) in the picture. | Masjid-E-Aqsa, BICC (headers needed to tell adhan from iqama) | Masjid-E-Aqsa, Bramalea Islamic Cultural Centre (BICC) |
| `whole-widget-screenshot`<br><sub>scout.mjs grab()</sub> | When a block inside an embedded widget cannot be cropped (the widget blocks scrolling), photograph the whole widget instead. | Rowdah Centre (cross-origin prayertimedisplay.com widget) | Rowdah Centre |
| `open-pop-ups`<br><sub>scout.mjs MARK_OPENERS</sub> | Click buttons, tabs and accordions that open prayer times ("See prayer times", "Salah timings") and read what appears; if a click navigates away, go back. | DawaNet ('See prayer times' pop-up) | DawaNet Community Centre |
| `page-code-schedules`<br><sub>scout.mjs readPage()</sub> | Schedules kept in the page's own code (inline scripts naming Fajr and Isha) are passed along, marked: use only where their structure is explicit — what the page displays wins. | DawaNet (WordPress plugin settings holding the month's periods) | DawaNet Community Centre |
| `timetable-images`<br><sub>scout.mjs readPage()</sub> | Large images whose name, alt or title says timetable / prayer / Ramadan / monthly are downloaded and read. | Sites posting their monthly timetable as an image | — |
| `bot-check`<br><sub>scout.mjs botCheck() + index.ts mode 'blocked'</sub> | A site that refuses automated readers — a bot-check page ("Just a moment…", "Verify you are human", "Checking the site connection security", any captcha) or a short refusal (HTTP 401/403/406/429, "Forbidden", "Access denied") — is not read and never forced: the Scout records "BOT CHECK", skips the site for 7 days, and the mosque is listed as needing a screenshot or the mosque's own feed/allow-listing. Refusals depend on the reader's network, so only the scheduled reader (GitHub Actions) records them; a manual run elsewhere just reports them. | BARIC and ISNA Canada (Cloudflare), Mississauga Muslim Community (HTTP 403); Jame Masjid Mississauga (SiteGround captcha refused the workspace reader but let GitHub's reader in) | Brampton and Regional Islamic Centre (BARIC), ISNA Canada (Islamic Centre of Canada), Mississauga Muslim Community |
| `daily-targets`<br><sub>index.ts browserTargets()</sub> | Every active mosque with a website — new ones included — is a browser target whenever today has fewer than five prayers covered, and is re-read at least every 3 days. Sites that only publish today are therefore read every day. | Al-Hikmah, Rowdah, DawaNet, Rahmat (single-day widgets) | Al-Hikmah Centre |

## Keeping the rules honest

How screenshots, answer keys and fixes work.

| Rule | What it says | Learned from | Tested by |
|---|---|---|---|
| `screenshot-is-answer-key` | Every screenshot of a mosque's own site becomes an answer key (ground truth). A wrong read is fixed by a general rule in this file — never by hand-entering that mosque's times. | Wael's instruction (3 Nov 2026) | — |
| `key-vs-site` | When a key and the live site disagree, check the site's primary data first (feed, widget, image). If the mosque changed its times, end the old key and add a new one; only a disagreement with the primary data is a Scout bug. | Al-Hikmah Centre (Asr changed after the screenshot) | Al-Hikmah Centre |
| `daily-keys-expire` | A key from a single-day widget covers that day only; an expired key is reported as a warning (send a fresh screenshot), not a failure. | Rowdah Centre | Rowdah Centre |
| `screenshot-inbox`<br><sub>scout.mjs --image</sub> | For sites no automated reader may open, a community member's screenshot of the mosque's own site is read with the same rules (stored as source kind "image"). Screenshot fixtures are re-read on every check without writing to the database (dry run). | BARIC, ISNA Canada | Brampton and Regional Islamic Centre (BARIC) (screenshot), ISNA Canada (Islamic Centre of Canada) (screenshot) |
