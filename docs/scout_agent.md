# Adrik Scout agent — extraction spec

The Scout reads one mosque's published prayer schedule and emits a strict JSON document. It runs offline on a schedule; nothing here is on a user's request path.

## Run loop (per mosque)

1. Load `mosques` row + last valid `sources` row + last month's `iqama_rows`.
2. Fetch `website`. If `platform` ≠ `none`, hand off to the platform adapter and skip the LLM.
3. Find the prayer-times page: follow links whose text matches `salah|salat|prayer|namaz|iqama|iqamah|timetable|times|اوقات|الصلاة` (max depth 2). Collect HTML, linked PDFs and images (`.png/.jpg` inside the times section).
4. Hash the collected content. Same `raw_hash` as last run → update `fetched_at`, stop.
5. Call Claude (Sonnet, vision on) with the system prompt below, the page text (readability-extracted), and any PDF/image as attachments. Ask for the **current month and the next**, if published.
6. Parse JSON, write `sources`, `iqama_rules`, `iqama_rows`, `jumuah_slots`. Materialise rules into rows for 60 days using app-side adhan calculation at the mosque's coordinates.
7. Run `validate_iqama_rows()` per date. Any quarantined row, or `confidence < 0.8`, or a change > 45 min from last month's same-date row → `sources.needs_review = true`.
8. Schedule next run: monthly tables → 1st and 15th; fixed rules → weekly; ±7 days around a DST change or Ramadan → daily.

## System prompt

```
You are the Scout for Adrik, an app that tells Muslims which congregation (jama'ah) they can still reach.
Your only job: read a mosque's published prayer schedule and return the IQAMA (congregation start) times as strict JSON.

Rules:
- Iqama ≠ adhan. If a table has both ADHAN and IQAMA columns, extract IQAMA. If only one column exists and the page calls it "prayer times" with no iqama column, set "has_iqama": false and still return the times with "times_are": "adhan".
- Never invent a time. A cell you cannot read → null. A month not on the page → omit it.
- Dates: ISO (YYYY-MM-DD). Times: 24-hour "HH:MM" local to the mosque. Convert "4:15 pm" → "16:15".
- Rules beat tables. If the page says "Maghrib: Sunset", "5 minutes after adhan", "Isha fixed at 8:00 pm", return a rule in "rules", not per-day rows for that prayer.
- A change of iqama mid-month (e.g. Fajr 6:30 until Oct 10, 6:45 from Oct 11) is normal. Return per-day rows; do not collapse to one value.
- Jumu'ah: return each slot's khutbah start and salah start. If the page says salah is N minutes after khutbah, return "salah_offset_min": N and "salah_time": null. Note the language if stated.
- Multiple jama'ahs for one prayer (two Isha, late Fajr) → separate rows with "seq": 1, 2 ... and a "label".
- Extract facilities only if explicitly stated: women's section, parking, wheelchair access. Otherwise null.
- "confidence" is your honest 0–1 estimate that every returned time matches the page. Lower it for blurry images, merged cells, inconsistent formats, or text you inferred.
- Output ONLY the JSON object. No prose, no markdown fences.
```

## Output schema

```json
{
  "mosque_name": "Masjid Al-Farooq",
  "mosque_name_ar": "مسجد الفاروق",
  "source_url": "https://masjidfarooq.com/salah-times",
  "source_kind": "website",
  "timezone_hint": "America/Toronto",
  "has_iqama": true,
  "times_are": "iqama",
  "months": [
    {
      "month": "2026-10",
      "rows": [
        {"date": "2026-10-26", "fajr": "06:45", "dhuhr": "13:40", "asr": "16:15", "maghrib": "18:25", "isha": "20:00"}
      ]
    }
  ],
  "rules": [
    {"prayer": "maghrib", "kind": "sunset", "minutes": null, "fixed_time": null, "valid_from": "2026-10-01", "valid_to": null}
  ],
  "second_jamaah": [
    {"date": "2026-10-26", "prayer": "isha", "seq": 2, "time": "21:30", "label": "late jama'ah"}
  ],
  "jumuah": [
    {"slot": 1, "khutbah_time": "12:00", "salah_time": "12:30", "salah_offset_min": null, "language": null},
    {"slot": 4, "khutbah_time": "15:00", "salah_time": null, "salah_offset_min": 30, "language": null}
  ],
  "special": [
    {"date": "2026-10-30", "name": "Qiyam", "start_time": "23:00"}
  ],
  "facilities": {"womens_section": null, "parking": null, "accessible": null},
  "confidence": 0.93,
  "notes": "Fajr iqama moves to 06:45 from Oct 11; Asr/Isha to 16:15/20:00 from Oct 21."
}
```

Use Claude's structured-output / JSON-schema mode with this shape so a malformed reply is rejected before parsing.

## Test fixtures (from the two screenshots)

| Mosque | URL | Expected shape | What it tests |
| --- | --- | --- | --- |
| Masjid Al-Farooq | masjidfarooq.com | 31 rows, iqama column, 4 Jumu'ah slots (last with offset 30) | Monthly HTML table, mid-month shifts, Jumu'ah offset rule |
| Al-Abbas Musallah (MWC) | mwcanada.org | 0 rows, 5 rules: fajr fixed 07:00, dhuhr fixed 14:00, asr fixed 16:45, maghrib sunset, isha fixed 20:00 | Fixed-rule site, "Sunset" keyword |

Expected values for 2026-10-26 after materialisation:

| Mosque | Fajr | Dhuhr | Asr | Maghrib | Isha |
| --- | --- | --- | --- | --- | --- |
| Al-Farooq | 06:45 | 13:40 | 16:15 | 18:25 | 20:00 |
| Al-Abbas | 07:00 | 14:00 | 16:45 | 18:20 (sunset) | 20:00 |

## Review queue (v1 = you)

A Supabase view `sources where needs_review` plus a one-screen admin page: page screenshot on the left, extracted table on the right, Approve / Fix / Mark platform. Every Fix is stored as `source_kind = 'manual'` and becomes a regression fixture.


## Rulebook (added 3 Nov 2026)

Every lesson learned from a mosque site is a general rule in `supabase/functions/scout/rules.ts`, applied to every
mosque including new ones: the Scout's reading instructions are built from it, and code checks, plain-reader and
browser rules are listed there with where they live. `docs/scout_rulebook.md` is generated from it
(`node scripts/browser-scout/rulebook.mjs`). Every answer key lists the rules it tests; `node scout.mjs --check`
(run on every push and every Sunday) reports each rule as passing, failing or untested. Screenshots sent for sites
that refuse automated readers go through the screenshot inbox (`node scout.mjs --image <file> --id <uuid>`), and are
kept as fixtures that are re-read on every check without writing to the database.

## Browser Scout (added 3 Nov 2026)

Some mosque sites only show their times after scripts run, inside widgets, or as images. The Browser Scout
(`scripts/browser-scout/scout.mjs`) reads those the way a person does:

1. Open the site in Chromium, let scripts run, follow "prayer times" links.
2. Collect the rendered text of every frame (embedded widgets included).
3. Screenshot the blocks that list prayer names with times, and download posted timetable images.
4. Send text + screenshots to the scout edge function (`mode: "ingest"`); Claude reads both and the
   same storage rules apply.

Runs daily from GitHub Actions (`.github/workflows/browser-scout.yml`) for the mosques
`browser_scout_targets()` returns; it authenticates with GitHub's OIDC token (repository wradwan/adrik,
branch main). Locally: `ADRIK_SCOUT_ADMIN_TOKEN=… node scout.mjs` (token in `.env` / `app_secrets`).

**Answer keys** (`answer-keys.json`): ground truth from screenshots of each mosque's own site.
`node scout.mjs --check` re-reads those mosques and compares; it runs every Sunday. A mismatch is first
checked against the site's primary data — if the mosque changed its times, the key gets a new date range;
only a disagreement with the primary data is a Scout bug, and the fix goes into the pipeline (never a
hand-entered time).

**Adhan vs iqama** is decided by arithmetic: posted Fajr/Dhuhr/Asr/Isha times within 3 minutes of the
calculated adhan are held back as adhan, whatever the page calls them.
