# Mosque registry: covering the whole GTA

Goal: know every mosque, musalla and Islamic centre in the Greater Toronto Area (Toronto, Peel, York, Durham, Halton),
know **how** each one publishes its times, read each one only as often as its times actually change, and keep
everything we learn so nothing is worked out twice.

## Phases

| # | Phase | What it does | Status |
|---|---|---|---|
| 1 | **Collect** | Google Maps sweep of the GTA → `mosque_candidates` → classified → accepted ones become mosques (switched off) → switched on 20 a day | **built** (migration 009, `scripts/gta_sweep.py`) |
| 2 | **Profile** | Each mosque's first reads set `read_method` and `publish_cadence` | fields exist; filling them is next |
| 3 | **Schedule by method** | `next_read_at` per mosque from its method (feed weekly, PDF when a new one appears, rules monthly + DST + Ramadan, ...) | hook exists in `run_scout_wave` |
| 4 | **Keep a year ahead** | Infer each mosque's standing rules from a year of rows; generate the next 12 months as `origin = 'rule'` (predicted) rows | `origin` / `predicted` columns exist |
| 5 | **Mosque portal** | A mosque claims its page, corrects its times, gets a timetable / widget / feed back | later |

## Why we keep rules, not just last year's times

Adhan times follow the sun and repeat on the same Gregorian date within a minute or two, and the Guide calculates them
anyway. **Iqama times are a mosque's decision** and move every year:

- Daylight saving changes on different dates (ends 1 Nov 2026, 7 Nov 2027; starts 8 Mar 2026, 14 Mar 2027).
- Ramadan comes about 11 days earlier each year.
- Mosques change their own times (new imam, committee decisions, extra Jumu'ah slots).

So we store the **pattern** (`iqama_rules`: fixed / minutes after adhan / sunset / minutes after sunset, with
`valid_from`–`valid_to`) and generate times from it. Last year's time for the same date is only a fallback
(`origin = 'last_year'`), shown as predicted until a read confirms it.

## Phase 1 in detail

### Sweep (`scripts/gta_sweep.py`)

```sh
python3 scripts/gta_sweep.py plan        # calls and worst-case cost, no calls made
python3 scripts/gta_sweep.py run         # sweep; writes scripts/out/gta_candidates.{json,csv}
python3 scripts/gta_sweep.py send        # load into the database (Scout mode "candidates", admin token)
```

1. **Grid**: Nearby Search, type `mosque`, 400 circles of 5 km. A circle that returns the maximum of 20 is split into
   4 smaller circles (down to 400 m), so dense areas (Mississauga, Scarborough) are covered completely.
2. **Text**: "masjid / musalla / islamic centre <city>" for 22 cities, plus GTA-wide "jamatkhana", "imambargah",
   "islamic society", ... for places Google does not type as a mosque.
3. **Details** (website, phone): only for places that look like places of prayer.

About 1,000 calls; roughly $30 at Google's list price, inside the free monthly allowance. Every response is cached in
`scripts/out/gta_cache.json`, so re-runs and runs stopped by `--max-calls` never pay twice. Tests:
`python3 -m unittest scripts/test_gta_sweep.py` (fake Google, no key).

### Classification (`classify_candidates()`, automatic)

| Result | When |
|---|---|
| `exists` | the place is already a mosque (its missing city / region / website / phone are filled in) |
| `rejected` | outside the GTA; closed permanently; a shop or business; not a place of worship and no mosque word in the name |
| `needs_review` | within 75 m of another mosque (possible duplicate); temporarily closed; name hints at a Shia, Ismaili or Ahmadiyya community; not typed as a mosque by Google |
| `accepted` → `promoted` | typed as a mosque by Google, inside the GTA, open, no hint |

Review list: `select * from candidates_to_review;`. To decide one:
`update mosque_candidates set status = 'accepted', community = 'shia', reviewed_by = 'wael', reviewed_at = now() where place_id = '...';`
then `select promote_candidates();`.

### Rollout (`activate_next_mosques()`, daily at 1:45 am Toronto)

Promoted mosques start switched off (`active = false`), so nothing reads them and the app does not show them. Each
night the next 20 are switched on: regions in `rollout.regions` order (Peel, Toronto, York, Halton, Durham), mosques
with a website first. Their first reads happen that same night.

```sql
update rollout set per_day = 40;        -- faster
update rollout set paused = true;       -- stop (switching on by hand still works: select activate_next_mosques(10);)
```

### Nightly Scout in waves (`run_scout_wave()`)

The old `scout-daily` job sent every mosque to the Scout at once. With hundreds of mosques that overloads the edge
function, so it is replaced by `scout-waves`: 30 mosques every 10 minutes from 2:00 to 3:50 am Toronto (EST), each
mosque at most once a day, before the 4:30 am catch-up and the 4:45 am Browser Scout. Capacity: 360 mosques a night.
