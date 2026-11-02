-- Adrik (أدرك) — Iqama-aware mosque finder
-- Migration 001: core schema for Supabase (Postgres 15+, PostGIS)
-- Apply with: supabase db push   or paste into the SQL editor.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------
create type prayer_t as enum ('fajr','dhuhr','asr','maghrib','isha');
create type source_kind_t as enum ('website','pdf','image','platform_api','crowd','manual');
create type platform_t as enum ('none','masjidal','masjidbox','mymasjid','mawaqit','salahhour','other');
create type rule_kind_t as enum ('fixed','offset_from_adhan','sunset','sunset_offset');

-- ---------------------------------------------------------------
-- Mosques (seeded from Google Places, enriched by the Scout)
-- ---------------------------------------------------------------
create table mosques (
  id              uuid primary key default gen_random_uuid(),
  place_id        text unique,                      -- Google Places id, used in the Maps deep link
  name            text not null,
  name_ar         text,
  name_local      jsonb default '{}'::jsonb,        -- {"ur":"...","hi":"...","fr":"..."}
  geom            geography(point, 4326) not null,
  tz              text not null default 'America/Toronto',   -- IANA zone of the mosque
  address         text,
  website         text,
  phone           text,
  platform        platform_t not null default 'none',
  womens_section  boolean,                          -- null = unknown
  accessible      boolean,
  parking         boolean,
  calc_method     text default 'ISNA',              -- method the mosque itself uses for adhan
  asr_madhhab     text default 'standard',          -- 'standard' | 'hanafi'
  trust_score     numeric(4,3) not null default 0,  -- 0..1, recomputed nightly
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index mosques_geom_gix on mosques using gist (geom);

-- ---------------------------------------------------------------
-- Sources: every fetch the Scout or a human made
-- ---------------------------------------------------------------
create table sources (
  id           uuid primary key default gen_random_uuid(),
  mosque_id    uuid not null references mosques(id) on delete cascade,
  kind         source_kind_t not null,
  url          text,
  fetched_at   timestamptz not null default now(),
  raw_hash     text,                                -- sha256 of fetched content; unchanged hash = skip extraction
  confidence   numeric(4,3),                        -- Scout's self-reported 0..1
  model        text,                                -- e.g. claude-sonnet-4-5
  notes        text,
  needs_review boolean not null default false,
  reviewed_by  uuid,
  reviewed_at  timestamptz
);
create index sources_mosque_fetched_idx on sources (mosque_id, fetched_at desc);

-- ---------------------------------------------------------------
-- Iqama rules: how a mosque sets a prayer's iqama, when not a flat table
-- e.g. Al-Abbas Maghrib = {"kind":"sunset"}; another mosque = {"kind":"offset_from_adhan","minutes":5}
-- ---------------------------------------------------------------
create table iqama_rules (
  id          uuid primary key default gen_random_uuid(),
  mosque_id   uuid not null references mosques(id) on delete cascade,
  prayer      prayer_t not null,
  kind        rule_kind_t not null,
  minutes     int,                                  -- for offset kinds
  fixed_time  time,                                 -- for kind='fixed'
  valid_from  date not null,
  valid_to    date,                                 -- null = open-ended
  source_id   uuid references sources(id),
  unique (mosque_id, prayer, valid_from)
);

-- ---------------------------------------------------------------
-- Iqama rows: the resolved, per-day truth the Guide reads.
-- Stored as local wall-clock time + the mosque tz (DST-safe).
-- Several rows per (mosque, date, prayer) are allowed: second jama'ahs.
-- ---------------------------------------------------------------
create table iqama_rows (
  id          uuid primary key default gen_random_uuid(),
  mosque_id   uuid not null references mosques(id) on delete cascade,
  date        date not null,
  prayer      prayer_t not null,
  seq         smallint not null default 1,          -- 1 = main jama'ah, 2 = second, ...
  adhan_time  time,                                 -- as published by the mosque, if any
  iqama_time  time not null,
  label       text,                                 -- e.g. 'late jama\'ah for shift workers'
  source_id   uuid references sources(id),
  quarantined boolean not null default false,       -- failed validation; served only with a flag
  unique (mosque_id, date, prayer, seq)
);
create index iqama_rows_lookup_idx on iqama_rows (mosque_id, date);

-- ---------------------------------------------------------------
-- Jumu'ah slots and special jama'ahs (Taraweeh, Eid, Qiyam)
-- ---------------------------------------------------------------
create table jumuah_slots (
  id            uuid primary key default gen_random_uuid(),
  mosque_id     uuid not null references mosques(id) on delete cascade,
  slot          smallint not null,                  -- 1st, 2nd, 3rd, 4th
  khutbah_time  time not null,
  salah_time    time,                               -- null = derive from salah_offset_min
  salah_offset_min int default 30,
  language      text,                               -- 'en','ar','ur' ...
  valid_from    date not null,
  valid_to      date,
  source_id     uuid references sources(id),
  unique (mosque_id, slot, valid_from)
);

create table special_jamaah (
  id          uuid primary key default gen_random_uuid(),
  mosque_id   uuid not null references mosques(id) on delete cascade,
  date        date not null,
  name        text not null,                        -- 'Taraweeh', 'Eid al-Fitr', 'Qiyam'
  start_time  time not null,
  source_id   uuid references sources(id)
);

-- ---------------------------------------------------------------
-- Crowd reports: a user standing in the mosque
-- ---------------------------------------------------------------
create table reports (
  id              uuid primary key default gen_random_uuid(),
  mosque_id       uuid not null references mosques(id) on delete cascade,
  user_id         uuid,                             -- auth.users, nullable for anonymous v1
  date            date not null,
  prayer          prayer_t not null,
  observed_iqama  time not null,
  created_at      timestamptz not null default now()
);
create index reports_mosque_date_idx on reports (mosque_id, date, prayer);

-- ---------------------------------------------------------------
-- User profile (v1: device-level settings, synced if signed in)
-- ---------------------------------------------------------------
create table profiles (
  user_id         uuid primary key,
  language        text not null default 'en',
  calc_method     text not null default 'ISNA',
  asr_madhhab     text not null default 'standard',
  travel_mode     text not null default 'driving',  -- driving | walking | transit
  wudu_buffer_min int not null default 5,
  parking_buffer_min int not null default 3,
  womens_section_only boolean not null default false,
  home_mosque_id  uuid references mosques(id),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Nearby candidates with today's rows, in one call
-- select * from nearby_mosques(43.59, -79.66, 5000, current_date);
-- ---------------------------------------------------------------
create or replace function nearby_mosques(
  lat double precision, lng double precision, radius_m int, on_date date
) returns table (
  mosque_id uuid, name text, name_ar text, place_id text,
  lat double precision, lng double precision, distance_m double precision,
  trust_score numeric, womens_section boolean, accessible boolean,
  prayer prayer_t, seq smallint, iqama_time time, quarantined boolean
) language sql stable as $$
  select m.id, m.name, m.name_ar, m.place_id,
         st_y(m.geom::geometry), st_x(m.geom::geometry),
         st_distance(m.geom, st_makepoint(lng, lat)::geography) as distance_m,
         m.trust_score, m.womens_section, m.accessible,
         r.prayer, r.seq, r.iqama_time, r.quarantined
  from mosques m
  join iqama_rows r on r.mosque_id = m.id and r.date = on_date
  where m.active
    and st_dwithin(m.geom, st_makepoint(lng, lat)::geography, radius_m)
  order by 7, r.prayer, r.seq;
$$;

-- ---------------------------------------------------------------
-- Validation: iqama must fall inside its prayer window.
-- Called by the Scout writer after insert; rows outside are quarantined.
-- adhan_times is computed app-side and passed in as jsonb
-- {"fajr":"06:27","sunrise":"07:47","dhuhr":"13:02","asr":"15:51","maghrib":"18:20","isha":"19:37"}
-- ---------------------------------------------------------------
create or replace function validate_iqama_rows(p_mosque uuid, p_date date, adhan jsonb)
returns int language plpgsql as $$
declare n int;
begin
  update iqama_rows r set quarantined = true
  where r.mosque_id = p_mosque and r.date = p_date and (
    (r.prayer='fajr'    and (r.iqama_time < (adhan->>'fajr')::time    or r.iqama_time > (adhan->>'sunrise')::time)) or
    (r.prayer='dhuhr'   and (r.iqama_time < (adhan->>'dhuhr')::time   or r.iqama_time > (adhan->>'asr')::time)) or
    (r.prayer='asr'     and (r.iqama_time < (adhan->>'asr')::time     or r.iqama_time > (adhan->>'maghrib')::time)) or
    (r.prayer='maghrib' and (r.iqama_time < (adhan->>'maghrib')::time or r.iqama_time > (adhan->>'isha')::time)) or
    (r.prayer='isha'    and (r.iqama_time < (adhan->>'isha')::time))
  );
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------
-- Trust score: source type x freshness x crowd agreement (nightly)
-- ---------------------------------------------------------------
create or replace function recompute_trust_scores() returns void language sql as $$
  update mosques m set trust_score = least(1.0, greatest(0.0,
      coalesce((
        select case s.kind when 'platform_api' then 0.6 when 'website' then 0.5
                           when 'pdf' then 0.45 when 'image' then 0.4 when 'manual' then 0.7 else 0.3 end
             * greatest(0.3, 1 - extract(epoch from now() - s.fetched_at) / 86400 / 30)   -- decays over 30 days
        from sources s where s.mosque_id = m.id and not s.needs_review
        order by s.fetched_at desc limit 1), 0)
      + least(0.4, 0.1 * (select count(*) from reports r
                          where r.mosque_id = m.id and r.created_at > now() - interval '7 days'))
  )), updated_at = now();
$$;

-- ---------------------------------------------------------------
-- Row-level security: public read of mosque data, authenticated writes of reports/profiles
-- ---------------------------------------------------------------
alter table mosques enable row level security;
alter table iqama_rows enable row level security;
alter table jumuah_slots enable row level security;
alter table special_jamaah enable row level security;
alter table reports enable row level security;
alter table profiles enable row level security;

create policy "public read mosques"   on mosques       for select using (true);
create policy "public read iqama"     on iqama_rows    for select using (true);
create policy "public read jumuah"    on jumuah_slots  for select using (true);
create policy "public read special"   on special_jamaah for select using (true);
create policy "anyone can report"     on reports       for insert with check (true);
create policy "own profile"           on profiles      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Scout writes via the service role key; no policy needed.
