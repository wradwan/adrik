-- Browser Scout: a real-browser reader (GitHub Actions + Playwright) for sites whose times only appear
-- after scripts run, inside widgets, or in images. It sends rendered text + screenshots to the scout
-- edge function (mode "ingest"); callers are trusted via GitHub OIDC or an admin token kept here.
alter type source_kind_t add value if not exists 'browser';

create table if not exists app_secrets (name text primary key, value text not null, created_at timestamptz default now());
alter table app_secrets enable row level security;  -- no policies: service role only
revoke all on app_secrets from anon, authenticated;

-- Mosques the browser should read: active, have a website, and nothing usable for today yet.
create or replace function browser_scout_targets(for_date date default (now() at time zone 'America/Toronto')::date)
returns table(id uuid, name text, website text, community text) language sql stable as $$
  select m.id, m.name, m.website, m.community from mosques m
  where m.active and m.website is not null
    and not exists (select 1 from iqama_rows r where r.mosque_id = m.id and r.date = for_date and not r.quarantined)
    and not exists (select 1 from iqama_rules r where r.mosque_id = m.id and r.valid_from <= for_date and (r.valid_to is null or r.valid_to >= for_date))
  order by m.community <> 'sunni', m.name;
$$;
revoke execute on function browser_scout_targets(date) from anon, authenticated;
