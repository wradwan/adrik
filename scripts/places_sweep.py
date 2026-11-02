import json, sys, time, urllib.request
KEY = sys.argv[1]  # pass GOOGLE_MAPS_API_KEY; never commit it
H = {"X-Goog-Api-Key": KEY, "Content-Type": "application/json"}
def call(url, body=None, mask=""):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers={**H, "X-Goog-FieldMask": mask}, method="POST" if body else "GET")
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)

# 1) Details for known place_ids
known = json.load(open(sys.argv[2]))
details = {}
for p in known:
    try:
        d = call(f"https://places.googleapis.com/v1/places/{p['place_id']}", mask="id,displayName,websiteUri,nationalPhoneNumber,businessStatus")
        details[p["place_id"]] = d
    except Exception as e:
        details[p["place_id"]] = {"error": str(e)}
json.dump(details, open("/home/claude/adrik/scripts/peel_details.json","w"), indent=1)

# 2) Grid sweep over Peel (Mississauga, Brampton, Caledon) — Nearby Search, type mosque, 2.5 km circles
lat0, lat1, lng0, lng1 = 43.47, 43.98, -80.05, -79.55
step_lat, step_lng = 0.032, 0.044   # ~3.5 km spacing
found = {}
lat = lat0
calls = 0
while lat <= lat1:
    lng = lng0
    while lng <= lng1:
        body = {"includedTypes": ["mosque"], "maxResultCount": 20,
                "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": 2500}}}
        try:
            r = call("https://places.googleapis.com/v1/places:searchNearby", body,
                     "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.types,places.businessStatus")
            calls += 1
            for p in r.get("places", []): found[p["id"]] = p
        except Exception as e:
            print("err", lat, lng, e)
        lng += step_lng
    lat += step_lat
# 3) Text searches for places not typed as mosque
for q in ["musalla Mississauga", "musallah Brampton", "masjid Brampton", "masjid Mississauga", "islamic centre Brampton", "islamic centre Mississauga", "jamatkhana Peel Ontario", "imambargah Brampton Mississauga", "masjid Caledon Bolton"]:
    try:
        r = call("https://places.googleapis.com/v1/places:searchText", {"textQuery": q, "pageSize": 20,
                 "locationRestriction": {"rectangle": {"low": {"latitude": lat0, "longitude": lng0}, "high": {"latitude": lat1, "longitude": lng1}}}},
                 "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.types,places.businessStatus")
        calls += 1
        for p in r.get("places", []): found.setdefault(p["id"], p)
    except Exception as e:
        print("err", q, e)
json.dump(list(found.values()), open("/home/claude/adrik/scripts/peel_sweep.json","w"), indent=1, ensure_ascii=False)
print("details:", len(details), "with website:", sum(1 for d in details.values() if d.get("websiteUri")))
print("sweep calls:", calls, "places found:", len(found))
