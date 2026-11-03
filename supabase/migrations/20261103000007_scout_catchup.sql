-- Catch-up Scout runs for sites that post today's times only (widgets can still show yesterday at 3 am).
create or replace function public.run_scout_missing() returns integer language plpgsql as $f$
declare n int := 0; m record; today date := (now() at time zone 'America/Toronto')::date;
begin
  for m in select id from mosques ms where ms.active and ms.website is not null
      and exists (select 1 from iqama_rows r where r.mosque_id = ms.id and r.date between today - 3 and today - 1)
      and not exists (select 1 from iqama_rows r where r.mosque_id = ms.id and r.date = today)
  loop
    perform net.http_post(
      url := 'https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/scout',
      headers := jsonb_build_object('Content-Type','application/json','Authorization', 'Bearer ' || '<anon key — public, same as web page>'),
      body := jsonb_build_object('mosque_id', m.id, 'force', true),
      timeout_milliseconds := 150000);
    n := n + 1;
  end loop;
  return n;
end $f$;
select cron.schedule('scout-catchup-early', '30 9 * * *', 'select run_scout_missing()');   -- 4:30 am Toronto (EST)
select cron.schedule('scout-catchup-morning', '0 14 * * *', 'select run_scout_missing()'); -- 9:00 am Toronto (EST)
