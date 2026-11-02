alter table mosques add column if not exists community text not null default 'sunni';  -- sunni | shia | ismaili | ahmadiyya | other
alter table mosques add column if not exists region text;
alter table mosques add column if not exists jumuah_only boolean not null default false;
create index if not exists mosques_region_idx on mosques (region);

create or replace function mosques_in_radius_v2(lat double precision, lng double precision, radius_m int, communities text[] default array['sunni'])
returns table (id uuid, name text, name_ar text, place_id text, address text, lat double precision, lng double precision,
               distance_m double precision, trust_score numeric, womens_section boolean, accessible boolean, asr_madhhab text, tz text,
               community text, jumuah_only boolean)
language sql stable as $$
  select m.id, m.name, m.name_ar, m.place_id, m.address,
         st_y(m.geom::geometry), st_x(m.geom::geometry),
         st_distance(m.geom, st_makepoint(lng, lat)::geography) as distance_m,
         m.trust_score, m.womens_section, m.accessible, m.asr_madhhab, m.tz, m.community, m.jumuah_only
  from mosques m
  where m.active and m.community = any(communities)
    and st_dwithin(m.geom, st_makepoint(lng, lat)::geography, radius_m)
  order by 8;
$$;
