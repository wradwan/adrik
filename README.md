# Adrik — أدرك

Which jama'ah can I still catch, and how do I get there?

Adrik reads mosques' published iqama times, works out which congregation you can reach before iqama from where you are, and hands you off to Google Maps.

## Layout

- `supabase/migrations/` — schema (PostGIS mosques, per-day iqama rows, rules, Jumu'ah slots, crowd reports), nearby queries, validation, trust score, pg_cron schedule.
- `supabase/functions/scout/` — the Scout: fetches a mosque website, extracts the iqama schedule with Claude (strict JSON tool call), validates, upserts. Runs nightly via pg_cron.
- `supabase/functions/guide/` — the decision engine: adhan calculation (adhan-js), candidates in radius, ETA (Google Routes or distance estimate), feasibility + ranking, rolls forward to the next prayer when every jama'ah has passed.
- `web/index.html` — the Now card prototype. Static page; calls `guide` with the public anon key.
- `docs/` — design notes and the Scout extraction spec.

## Setup

```sh
npm i -g supabase            # or: scoop install supabase / brew install supabase/tap/supabase
supabase login
supabase link --project-ref fbowvnwytutltsdnjcxb
cp .env.example .env         # fill in keys
supabase secrets set --env-file .env
supabase functions deploy scout
supabase functions deploy guide
```

Migrations 001–005 are already applied to the linked project. For a fresh project: `supabase db push`.

## Run the web page locally

```sh
npx serve web                # http://localhost:3000 — location prompt works on localhost
```

To test on a phone, publish `web/` to any static host (Vercel, Netlify, GitHub Pages).

## Test the engine

```sh
curl -X POST https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/guide \
  -H "Authorization: Bearer <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"lat":43.5728,"lng":-79.6914,"mode":"driving"}'
```

## Status (2026-11-01)

- 24 Mississauga mosques seeded with Google place_ids; 3 with verified iqama data (Al-Farooq, Al-Abbas, Dar Al-Tawheed).
- Scout handles HTML tables and fixed-rule pages. Next: PDF and image timetables (pass as document/image blocks), bot-blocked sites (ISNA 403).
- Guide ETAs are distance-based until `GOOGLE_MAPS_API_KEY` is set.
