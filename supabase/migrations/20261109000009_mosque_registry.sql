-- Migration 009: mosque registry — GTA rollout, step 1. Safe to run twice (paste into the SQL editor, or supabase db push).
--
-- 1. Every mosque gets a reading METHOD (how it publishes its times), a PUBLISH CADENCE (how often those times
--    change) and a NEXT READ time. Profiling fills them in (step 2); method-based scheduling uses them (step 3).
--    Until then every mosque is still read daily, exactly as before.
-- 2. iqama_rows get an ORIGIN: 'read' (from the mosque's own publication), 'rule' (generated from the mosque's
--    standing rule), 'last_year' (same date last year, a fallback), 'crowd', 'manual'. Rule and last-year rows are
--    PREDICTED until a read confirms them. Nothing writes predicted rows yet.
-- 3. mosque_candidates: everything the Google Maps sweep finds (scripts/gta_sweep.py). Each candidate is classified
--    automatically: accepted (typed as a mosque by Google, inside the GTA, open), needs_review, rejected, or
--    already known. Accepted candidates become mosques that are NOT yet active.
-- 4. Rollout throttle: a daily job switches on a few new mosques at a time (default 20 a day, Peel first), so the
--    Scout's cost and the review load grow gradually instead of all at once.
-- 5. The nightly Scout run goes out in waves (30 mosques every 10 minutes) instead of every mosque at once.

-- ---------------------------------------------------------------
-- 1. Reading method, cadence and schedule on each mosque
-- ---------------------------------------------------------------
do $$ begin create type read_method_t as enum (
  'unprofiled',        -- not looked at yet
  'platform_feed',     -- Mawaqit, Masjidal, MasjidBox, ... : structured data, no AI needed
  'timetable_pdf',     -- a yearly or monthly PDF timetable
  'timetable_image',   -- a timetable posted as an image
  'website_table',     -- a table on the website (server-rendered)
  'website_widget',    -- times appear only after scripts run (Browser Scout)
  'rules_page',        -- standing rules ("Isha 10 min after adhan", "Dhuhr 1:30 PM")
  'computer_reader',   -- refuses automated readers; read in Wael's own Chrome
  'social_only',       -- posts times only on Instagram / Facebook / WhatsApp
  'no_online_source',  -- publishes nothing online: crowd reports or manual entry
  'site_closed'        -- the site refuses a normal browser too; needs the mosque's other channel
); exception when duplicate_object then null; end $$;
do $$ begin create type publish_cadence_t as enum ('unknown', 'yearly', 'monthly', 'weekly', 'daily', 'rule_based'); exception when duplicate_object then null; end $$;
do $$ begin create type row_origin_t as enum ('read', 'rule', 'last_year', 'crowd', 'manual'); exception when duplicate_object then null; end $$;

alter table mosques
  add column if not exists read_method      read_method_t not null default 'unprofiled',
  add column if not exists publish_cadence  publish_cadence_t not null default 'unknown',
  add column if not exists next_read_at     timestamptz,           -- null = read on every daily run (current behaviour)
  add column if not exists last_dispatch_at timestamptz,           -- when the daily Scout last sent this mosque to be read
  add column if not exists profiled_at      timestamptz,
  add column if not exists profile_notes    text,
  add column if not exists city             text,
  add column if not exists discovered_via   text not null default 'seed',   -- seed | gta_sweep | manual | mosque_claim
  add column if not exists activated_at     timestamptz;
create index if not exists mosques_next_read_idx on mosques (next_read_at) where active;

-- Backfill what the existing data already tells us. Everything else stays 'unprofiled' until step 2.
update mosques set activated_at = created_at where active and activated_at is null;
update mosques set read_method = 'platform_feed', profiled_at = now(), profile_notes = 'from platform column'
  where platform <> 'none' and read_method = 'unprofiled';
with last_pc as (
  select distinct on (mosque_id) mosque_id, notes from sources
  where kind = 'browser' and (notes like 'SITE CLOSED%' or notes like 'BOT CHECK%' or notes like 'PC CHROME%')
  order by mosque_id, fetched_at desc)
update mosques m set read_method = case when l.notes like 'SITE CLOSED%' then 'site_closed'::read_method_t else 'computer_reader'::read_method_t end,
                     profiled_at = now(), profile_notes = 'from Scout history (bot check / computer reader)'
from last_pc l where l.mosque_id = m.id and m.read_method = 'unprofiled';

-- ---------------------------------------------------------------
-- 2. Where each iqama row came from; predicted rows
-- ---------------------------------------------------------------
alter table iqama_rows
  add column if not exists origin row_origin_t not null default 'read',
  add column if not exists predicted boolean generated always as (origin in ('rule', 'last_year')) stored;

-- ---------------------------------------------------------------
-- 3. Candidates from the Google Maps sweep
-- ---------------------------------------------------------------
create table if not exists mosque_candidates (
  place_id        text primary key,                 -- Google Places id
  name            text not null,
  address         text,
  city            text,
  region          text,                             -- toronto | peel | york | durham | halton; null = outside the GTA
  lat             double precision not null,
  lng             double precision not null,
  website         text,
  phone           text,
  types           text[] not null default '{}',
  primary_type    text,
  business_status text,                             -- OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY
  found_by        text[] not null default '{}',     -- 'grid', 'text:masjid Brampton', ...
  community_hint  text,                             -- from the name: shia | ismaili | ahmadiyya (a hint, never final)
  community       text,                             -- set by a reviewer; used on promotion (default sunni)
  status          text not null default 'new'
                  check (status in ('new', 'accepted', 'needs_review', 'rejected', 'exists', 'promoted')),
  status_reason   text,
  mosque_id       uuid references mosques(id) on delete set null,
  reviewed_by     text,
  reviewed_at     timestamptz,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  raw             jsonb
);
create index if not exists mosque_candidates_status_idx on mosque_candidates (status, region);
alter table mosque_candidates enable row level security;   -- no policies: service role only
revoke all on mosque_candidates from anon, authenticated;

-- Classify every candidate still marked 'new'. A reviewer decides 'needs_review' rows by setting status to
-- 'accepted' (optionally with community) or 'rejected', and reviewed_by / reviewed_at.
create or replace function classify_candidates() returns void language plpgsql as $$
declare
  worship_name constant text := '(masjid|masjed|mosque|musall?a|musallah|jamat ?khana|jamaat|jama.?at|islamic|muslim|imam ?barg|imambara|ismaili|imam[ -]e[ -]|hoss?ain|husain|sufi|jerrahi|tekke|dergah|\mjk\M|hussain|zainab|zahra|zawiy|markaz|da.?wah|ummah|baitul|bait ul|madinah|madina|quba|taqwa|noor|salaam|salam|tawheed|tawhid|furqan|huda|iman|ihsan|sunnah|deen|madrass?a)';
  shops constant text[] := array['store','grocery_store','supermarket','food_store','convenience_store','restaurant','meal_takeaway',
    'cafe','bakery','butcher_shop','clothing_store','book_store','travel_agency','funeral_home','cemetery','car_dealer',
    'real_estate_agency','insurance_agency','lawyer','doctor','dentist','pharmacy','hotel','gas_station'];
begin
  -- Hints from the name only; anything with a hint is reviewed by a person.
  update mosque_candidates set community_hint = case
      when name ~* 'jamat ?khana|ismaili|\mjk\M' then 'ismaili'
      when name ~* 'imam ?barg|imambara|imam[ -]e[ -]zamana|wali ?ul ?asr|hoss?ain|husain|hussain|husayn|zainab|jafari|ja.fari|shia|ahlul ?bayt|abbas|panjtan|mehfil' then 'shia'
      when name ~* 'ahmadiyya|baitul islam|baitul hamd|bait-ul|baitur rahman|baitun nur' then 'ahmadiyya'
    end
  where status = 'new';

  update mosque_candidates c set status = 'exists', mosque_id = m.id, status_reason = 'already in mosques'
  from mosques m where m.place_id = c.place_id and c.status = 'new';

  update mosque_candidates set status = 'rejected', status_reason = 'outside the GTA'
  where status = 'new' and region is null;

  update mosque_candidates set status = 'rejected', status_reason = 'closed permanently on Google Maps'
  where status = 'new' and business_status = 'CLOSED_PERMANENTLY';

  update mosque_candidates set status = 'rejected', status_reason = 'a shop or business, not a place of prayer'
  where status = 'new' and types && shops and not ('mosque' = any(types)) and coalesce(primary_type, '') <> 'mosque';

  update mosque_candidates set status = 'rejected', status_reason = 'not a place of worship, and no mosque word in the name'
  where status = 'new' and not ('mosque' = any(types)) and not ('place_of_worship' = any(types)) and name !~* worship_name
    and not ('community_center' = any(types));   -- community centres often hold the prayers: reviewed below

  -- Possible duplicate: another mosque (known or candidate) within 75 m.
  -- (Between two new candidates side by side, the first by place_id goes on; the second is reviewed.)
  update mosque_candidates c set status = 'needs_review', status_reason = 'within 75 m of ' || d.near
  from (
    select x.place_id, coalesce(
      (select m.name from mosques m
       where st_dwithin(m.geom, st_makepoint(x.lng, x.lat)::geography, 75) and m.place_id is distinct from x.place_id limit 1),
      (select o.name from mosque_candidates o
       where o.place_id < x.place_id and o.status in ('new', 'accepted', 'promoted', 'needs_review')
         and st_dwithin(st_makepoint(o.lng, o.lat)::geography, st_makepoint(x.lng, x.lat)::geography, 75) limit 1)) as near
    from mosque_candidates x where x.status = 'new') d
  where d.place_id = c.place_id and d.near is not null;

  update mosque_candidates set status = 'needs_review', status_reason = 'temporarily closed on Google Maps'
  where status = 'new' and business_status = 'CLOSED_TEMPORARILY';

  update mosque_candidates set status = 'needs_review', status_reason = 'community hint: ' || community_hint
  where status = 'new' and community_hint is not null;

  -- Typed as a mosque, but the name is an organization's (school, committee, convention, youth program, parking...)
  -- with no prayer word in it: a person decides whether people pray there.
  update mosque_candidates set status = 'needs_review', status_reason = 'typed as a mosque, but the name sounds like an organization'
  where status = 'new' and ('mosque' = any(types) or primary_type = 'mosque')
    and name ~* '(school|academy|institute|college|committee|council|convention|conference|youth|program|food bank|office|services|federation|parking|car wash|daycare|camp|store|book)'
    and name !~* '(masjid|masjed|mosque|musall?ah?|jame?a?.? ?masjid|jamat ?khana|imambarg|imambara|islamic cent|prayer|salah|jumu?.?ah)';

  update mosque_candidates set status = 'accepted', status_reason = 'typed as a mosque on Google Maps'
  where status = 'new' and ('mosque' = any(types) or primary_type = 'mosque');

  update mosque_candidates set status = 'needs_review', status_reason = 'not typed as a mosque on Google Maps'
  where status = 'new';
end $$;

-- Accepted candidates become mosques, switched OFF until the rollout activates them.
create or replace function promote_candidates() returns int language plpgsql as $$
declare n int;
begin
  with ins as (
    insert into mosques (place_id, name, geom, address, website, phone, city, region, community, active, discovered_via)
    select c.place_id, c.name, st_makepoint(c.lng, c.lat)::geography, c.address, c.website, c.phone, c.city, c.region,
           coalesce(c.community, 'sunni'), false, 'gta_sweep'
    from mosque_candidates c where c.status = 'accepted'
    on conflict (place_id) do nothing
    returning id, place_id)
  update mosque_candidates c set status = 'promoted', mosque_id = ins.id from ins where ins.place_id = c.place_id;
  get diagnostics n = row_count;
  -- accepted rows whose place_id was already a mosque (race with a manual insert)
  update mosque_candidates c set status = 'exists', mosque_id = m.id from mosques m
  where c.status = 'accepted' and m.place_id = c.place_id;
  return n;
end $$;

-- Load a batch from the sweep (called by the scout edge function, mode "candidates"), then classify and promote.
-- Known mosques get their missing city / region / website / phone filled from Google; nothing on file is overwritten.
create or replace function upsert_candidates(items jsonb) returns jsonb language plpgsql as $$
declare n_in int; n_promoted int;
begin
  insert into mosque_candidates (place_id, name, address, city, region, lat, lng, website, phone, types, primary_type,
                                 business_status, found_by, raw)
  select x->>'place_id', x->>'name', x->>'address', x->>'city', x->>'region', (x->>'lat')::float8, (x->>'lng')::float8,
         nullif(x->>'website', ''), nullif(x->>'phone', ''),
         coalesce(array(select jsonb_array_elements_text(x->'types')), '{}'), x->>'primary_type', x->>'business_status',
         coalesce(array(select jsonb_array_elements_text(x->'found_by')), '{}'), x->'raw'
  from jsonb_array_elements(items) x
  where x->>'place_id' is not null and x->>'name' is not null and x->>'lat' is not null and x->>'lng' is not null
  on conflict (place_id) do update set
    name = excluded.name, address = excluded.address, city = excluded.city, region = excluded.region,
    lat = excluded.lat, lng = excluded.lng,
    website = coalesce(excluded.website, mosque_candidates.website), phone = coalesce(excluded.phone, mosque_candidates.phone),
    types = excluded.types, primary_type = excluded.primary_type, business_status = excluded.business_status,
    found_by = array(select distinct unnest(mosque_candidates.found_by || excluded.found_by)),
    raw = excluded.raw, last_seen_at = now();
  get diagnostics n_in = row_count;

  perform classify_candidates();
  n_promoted := promote_candidates();

  update mosques m set city = coalesce(m.city, c.city), region = coalesce(m.region, c.region),
                       website = coalesce(m.website, c.website), phone = coalesce(m.phone, c.phone)
  from mosque_candidates c where c.status = 'exists' and c.mosque_id = m.id
    and (m.city is null or m.region is null or m.website is null or m.phone is null);

  return jsonb_build_object('received', jsonb_array_length(items), 'stored', n_in, 'promoted', n_promoted,
    'by_status', (select jsonb_object_agg(status, n) from (select status, count(*) n from mosque_candidates group by status) s),
    'by_region', (select jsonb_object_agg(coalesce(region, 'outside'), n) from (select region, count(*) n from mosque_candidates group by region) r));
end $$;
revoke execute on function upsert_candidates(jsonb) from anon, authenticated;
revoke execute on function classify_candidates() from anon, authenticated;
revoke execute on function promote_candidates() from anon, authenticated;

-- What a person needs to look at.
create or replace view candidates_to_review as
  select place_id, name, city, region, status_reason, community_hint, website, phone, types, business_status,
         'https://www.google.com/maps/place/?q=place_id:' || place_id as maps_link
  from mosque_candidates where status = 'needs_review'
  order by region, city, name;
revoke all on candidates_to_review from anon, authenticated;

-- ---------------------------------------------------------------
-- 4. Rollout throttle
-- ---------------------------------------------------------------
create table if not exists rollout (
  id        boolean primary key default true check (id),   -- a single row
  per_day   int not null default 20,
  regions   text[] not null default array['peel', 'toronto', 'york', 'halton', 'durham'],
  paused    boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into rollout default values on conflict do nothing;
alter table rollout enable row level security;
revoke all on rollout from anon, authenticated;

-- Switch on the next batch of swept mosques: regions in rollout order, mosques with a website first.
create or replace function activate_next_mosques(n int default null) returns int language plpgsql as $$
declare k int; r rollout;
begin
  select * into r from rollout;
  if r.paused and n is null then return 0; end if;
  with nxt as (
    select m.id from mosques m
    where not m.active and m.activated_at is null and m.discovered_via = 'gta_sweep'
    order by coalesce(array_position(r.regions, m.region), 99), (m.website is null), m.city, m.name
    limit coalesce(n, r.per_day))
  update mosques m set active = true, activated_at = now(), next_read_at = null from nxt where m.id = nxt.id;
  get diagnostics k = row_count;
  return k;
end $$;
revoke execute on function activate_next_mosques(int) from anon, authenticated;

-- ---------------------------------------------------------------
-- 5. Nightly Scout in waves
-- ---------------------------------------------------------------
-- Sends up to `batch` mosques that have not been sent today (Toronto date) and are due. Run every 10 minutes during
-- the night window; with 12 waves of 30 that covers 360 mosques. `next_read_at` is the hook for step 3: a mosque
-- whose next read is in the future is skipped (nothing sets it in the future yet).
create or replace function run_scout_wave(batch int default 30) returns int language plpgsql as $$
declare n int := 0; m record;
  day_start timestamptz := date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto';
begin
  for m in
    select id from mosques
    where active and website is not null
      and (last_dispatch_at is null or last_dispatch_at < day_start)
      and (next_read_at is null or next_read_at <= now())
    order by last_dispatch_at nulls first, name
    limit batch
    for update skip locked
  loop
    perform net.http_post(
      url := 'https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/scout',
      headers := jsonb_build_object('Content-Type', 'application/json',
        -- public anon key (the same one the web page ships); the scout function itself needs no secret for this mode
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZib3d2bnd5dHV0bHRzZG5qY3hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MzIzNDEsImV4cCI6MjEwODUwODM0MX0.nLpuv5rDvdka8tfuZ3Ic_T1SdceNtPDTzfhkg6NEYVc'),
      body := jsonb_build_object('mosque_id', m.id),
      timeout_milliseconds := 150000);
    update mosques set last_dispatch_at = now() where id = m.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function run_scout_wave(int) from anon, authenticated;

-- Replace the single 3 am run (every mosque at once) with waves from 2:00 to 3:50 am Toronto (EST; 3:00–4:50 in
-- summer), ahead of the 4:30 am catch-up and the 4:45 am Browser Scout.
select cron.unschedule('scout-daily') where exists (select 1 from cron.job where jobname = 'scout-daily');
select cron.unschedule('scout-waves') where exists (select 1 from cron.job where jobname = 'scout-waves');
select cron.schedule('scout-waves', '*/10 7-8 * * *', $$select run_scout_wave(30)$$);
select cron.unschedule('rollout-activate') where exists (select 1 from cron.job where jobname = 'rollout-activate');
select cron.schedule('rollout-activate', '45 6 * * *', $$select activate_next_mosques()$$);   -- 1:45 am Toronto, before the waves
