create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

-- Fires the Scout edge function for every active mosque with a website.
-- Uses the anon key (public) because the function has verify_jwt on; writes happen inside the function via the service role.
create or replace function run_scout_all() returns int language plpgsql as $$
declare n int := 0; m record;
begin
  for m in select id from mosques where active and website is not null loop
    perform net.http_post(
      url := 'https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/scout',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.anon_key', true)),
      body := jsonb_build_object('mosque_id', m.id),
      timeout_milliseconds := 150000);
    n := n + 1;
  end loop;
  return n;
end $$;

-- 08:00 UTC = 03:00/04:00 Toronto depending on DST.
select cron.schedule('scout-daily', '0 8 * * *', $$select run_scout_all()$$);
select cron.schedule('trust-nightly', '30 8 * * *', $$select recompute_trust_scores()$$);
