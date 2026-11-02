create or replace function mosques_in_radius(lat double precision, lng double precision, radius_m int)
returns table (id uuid, name text, name_ar text, place_id text, address text, lat double precision, lng double precision,
               distance_m double precision, trust_score numeric, womens_section boolean, accessible boolean, asr_madhhab text, tz text)
language sql stable as $$
  select m.id, m.name, m.name_ar, m.place_id, m.address,
         st_y(m.geom::geometry), st_x(m.geom::geometry),
         st_distance(m.geom, st_makepoint(lng, lat)::geography) as distance_m,
         m.trust_score, m.womens_section, m.accessible, m.asr_madhhab, m.tz
  from mosques m
  where m.active and st_dwithin(m.geom, st_makepoint(lng, lat)::geography, radius_m)
  order by 8;
$$;
