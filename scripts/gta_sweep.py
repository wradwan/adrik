#!/usr/bin/env python3
"""Adrik GTA sweep: finds every mosque, musalla and Islamic centre in the Greater Toronto Area on Google Maps and
loads them into the database as candidates (docs/mosque_registry.md, migration 009).

  python3 gta_sweep.py plan                  how many Google calls the sweep will make, and the worst-case cost (no calls)
  python3 gta_sweep.py run [--max-calls N]   sweep; writes out/gta_candidates.json and out/gta_candidates.csv
  python3 gta_sweep.py send                  send out/gta_candidates.json to the Scout (mode "candidates")

Keys are read from the environment or from adrik/.env and are never printed:
  GOOGLE_MAPS_API_KEY        Places API (New) enabled
  ADRIK_SCOUT_ADMIN_TOKEN    for "send"

How it searches (cheap first, expensive only where needed):
  1. Grid:  Nearby Search for type "mosque" in 5 km circles over the GTA. A circle that returns the maximum (20)
            is split into 4 smaller circles, down to 400 m, so dense areas are covered completely.
  2. Text:  searches by name ("masjid Brampton", "musalla Scarborough", "jamatkhana", ...) for places Google does not
            type as a mosque.
  3. Details: website and phone, fetched once per unique place that looks like a place of prayer (the most
            expensive call, so shops and schools found by the text searches are skipped).
Every Google response is cached in out/gta_cache.json: a re-run (or a run stopped by --max-calls) never pays twice.
Prices are Google's 2025 list prices before the free monthly allowance; check the Google Cloud console for actuals.
"""
import argparse, csv, hashlib, json, math, os, re, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
SCOUT = "https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/scout"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZib3d2bnd5dHV0bHRzZG5qY3hiIiwicm9sZSI6ImFub24i"
        "LCJpYXQiOjE3OTI5MzIzNDEsImV4cCI6MjEwODUwODM0MX0.nLpuv5rDvdka8tfuZ3Ic_T1SdceNtPDTzfhkg6NEYVc")

# GTA: City of Toronto + the regions of Peel, York, Durham and Halton (Burlington to Clarington, the lake to Georgina).
BBOX = {"lat0": 43.25, "lat1": 44.45, "lng0": -80.25, "lng1": -78.55}
CITY_REGION = {
    "toronto": "toronto", "scarborough": "toronto", "north york": "toronto", "etobicoke": "toronto", "east york": "toronto", "york": "toronto",
    "mississauga": "peel", "brampton": "peel", "caledon": "peel", "bolton": "peel", "caledon east": "peel", "inglewood": "peel",
    "vaughan": "york", "woodbridge": "york", "maple": "york", "concord": "york", "kleinburg": "york", "thornhill": "york",
    "markham": "york", "unionville": "york", "richmond hill": "york", "oak ridges": "york", "aurora": "york", "newmarket": "york",
    "stouffville": "york", "whitchurch-stouffville": "york", "gormley": "york", "king city": "york", "king": "york", "nobleton": "york",
    "schomberg": "york", "east gwillimbury": "york", "holland landing": "york", "queensville": "york", "mount albert": "york",
    "sharon": "york", "georgina": "york", "keswick": "york", "sutton": "york", "pefferlaw": "york",
    "pickering": "durham", "ajax": "durham", "whitby": "durham", "brooklin": "durham", "oshawa": "durham", "courtice": "durham",
    "bowmanville": "durham", "clarington": "durham", "newcastle": "durham", "uxbridge": "durham", "port perry": "durham",
    "scugog": "durham", "beaverton": "durham", "cannington": "durham", "sunderland": "durham", "brock": "durham",
    "oakville": "halton", "burlington": "halton", "milton": "halton", "georgetown": "halton", "acton": "halton", "halton hills": "halton",
}
TEXT_CITIES = ["Toronto", "Scarborough", "North York", "Etobicoke", "Mississauga", "Brampton", "Caledon", "Vaughan", "Markham",
               "Richmond Hill", "Newmarket", "Aurora", "Stouffville", "Pickering", "Ajax", "Whitby", "Oshawa", "Clarington",
               "Oakville", "Burlington", "Milton", "Halton Hills"]
TEXT_PER_CITY = ["masjid", "musalla", "islamic centre"]
TEXT_GTA_WIDE = ["jamatkhana", "imambargah", "islamic society", "muslim association", "dawah centre", "islamic institute",
                 "masjid prayer room", "musallah"]
WORSHIP_NAME = re.compile(r"masjid|masjed|mosque|musall?ah?|jamat ?khana|jamaat|jama.?at|islamic|muslim|imambarg|imambara|husain|hussain|"
                          r"zainab|zahra|zawiy|markaz|da.?wah|ummah|baitul|bait ul|madinah?|quba|taqwa|noor|salaa?m|tawh?eed|tawhid|"
                          r"furqan|huda|iman|ihsan|sunnah|deen|madrass?a", re.I)
SHOP_TYPES = {"store", "grocery_store", "supermarket", "food_store", "convenience_store", "restaurant", "meal_takeaway", "cafe",
              "bakery", "butcher_shop", "clothing_store", "book_store", "travel_agency", "funeral_home", "cemetery", "car_dealer",
              "real_estate_agency", "insurance_agency", "lawyer", "doctor", "dentist", "pharmacy", "hotel", "gas_station"}

FIELDS_LIST = "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.businessStatus"
FIELDS_DETAILS = "id,websiteUri,nationalPhoneNumber,addressComponents"
START_RADIUS, MIN_RADIUS, MAX_RESULTS = 5000.0, 400.0, 20
# USD per 1,000 calls (Google list price, 2025) and the free calls per month per SKU.
PRICE = {"nearby": (32.0, 5000), "text": (32.0, 5000), "details": (20.0, 1000)}


# ---------------------------------------------------------------- keys
def env_value(name):
    if os.environ.get(name):
        return os.environ[name]
    for p in [os.environ.get("ADRIK_ENV", ""), os.path.join(HERE, "..", ".env"), os.path.expanduser("~/mnt/dev/adrik/.env")]:
        if p and os.path.isfile(p):
            for line in open(p, encoding="utf-8"):
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    sys.exit(f"{name} not found in the environment or adrik/.env")


# ---------------------------------------------------------------- geometry
def km_lat(km):
    return km / 111.32


def km_lng(km, lat):
    return km / (111.32 * math.cos(math.radians(lat)))


def start_grid(bbox=BBOX, radius=START_RADIUS):
    """Circle centres on a square grid whose spacing (r * sqrt 2) leaves no gaps between circles."""
    step_km = radius / 1000 * math.sqrt(2) * 0.98
    mid = (bbox["lat0"] + bbox["lat1"]) / 2
    pts, lat = [], bbox["lat0"] + km_lat(step_km) / 2
    while lat - km_lat(step_km) / 2 < bbox["lat1"]:
        lng = bbox["lng0"] + km_lng(step_km, mid) / 2
        while lng - km_lng(step_km, mid) / 2 < bbox["lng1"]:
            pts.append((round(lat, 5), round(lng, 5), radius))
            lng += km_lng(step_km, mid)
        lat += km_lat(step_km)
    return pts


def split(lat, lng, r):
    """Four circles that cover the circle (lat, lng, r): centred on its quadrants, radius r / sqrt 2."""
    off, nr = r / 2 / 1000, r / math.sqrt(2)
    return [(round(lat + dy * km_lat(off), 5), round(lng + dx * km_lng(off, lat), 5), nr) for dy in (-1, 1) for dx in (-1, 1)]


# ---------------------------------------------------------------- Google calls (cached)
class Google:
    def __init__(self, key, cache_path, max_calls, fetch=None):
        self.key, self.cache_path, self.max_calls = key, cache_path, max_calls
        self.cache = {}
        if cache_path and os.path.isfile(cache_path):
            with open(cache_path) as fh:
                self.cache = json.load(fh)
        self.paid = {"nearby": 0, "text": 0, "details": 0}
        self.fetch = fetch or self._http

    def _http(self, url, body, mask):
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method="POST" if body else "GET",
                                     headers={"X-Goog-Api-Key": self.key, "X-Goog-FieldMask": mask, "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:300]
                if e.code in (429, 500, 503) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"Google HTTP {e.code}: {msg}")

    def call(self, sku, url, body=None, mask=""):
        k = hashlib.sha1(json.dumps([url, body, mask], sort_keys=True).encode()).hexdigest()
        if k in self.cache:
            return self.cache[k]
        if sum(self.paid.values()) >= self.max_calls:
            raise BudgetReached()
        res = self.fetch(url, body, mask)
        self.paid[sku] += 1
        self.cache[k] = res
        if sum(self.paid.values()) % 25 == 0:
            self.save()
        return res

    def save(self):
        if self.cache_path:
            tmp = self.cache_path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.cache, fh)
            os.replace(tmp, self.cache_path)


class BudgetReached(Exception):
    pass


# ---------------------------------------------------------------- the sweep
def city_from(address_components, formatted):
    for want in ("sublocality_level_1", "locality", "administrative_area_level_3"):
        for c in address_components or []:
            if want in c.get("types", []):
                name = c.get("longText") or c.get("shortText") or ""
                if name.lower() in CITY_REGION:
                    return name
    # "2580 Drew Rd, Mississauga, ON L4T 3M5, Canada" -> Mississauga
    parts = [p.strip() for p in (formatted or "").split(",")]
    for i, p in enumerate(parts):
        if re.match(r"^ON\b", p) and i > 0:
            return parts[i - 1]
    return None


def looks_like_prayer_place(p):
    types = set(p.get("types", []))
    if "mosque" in types or p.get("primaryType") == "mosque":
        return True
    if types & SHOP_TYPES:
        return False
    return "place_of_worship" in types or bool(WORSHIP_NAME.search(p.get("displayName", {}).get("text", "")))


def sweep(g, log=print):
    found = {}   # place id -> {"place": ..., "found_by": set()}

    def add(places, tag):
        for p in places or []:
            if p.get("id"):
                found.setdefault(p["id"], {"place": p, "found_by": set()})["found_by"].add(tag)

    # 1. grid with adaptive split
    queue, done = list(start_grid()), 0
    log(f"grid: {len(queue)} starting circles")
    while queue:
        lat, lng, r = queue.pop(0)
        res = g.call("nearby", "https://places.googleapis.com/v1/places:searchNearby",
                     {"includedTypes": ["mosque"], "maxResultCount": MAX_RESULTS,
                      "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": round(r, 1)}}}, FIELDS_LIST)
        places = res.get("places", [])
        add(places, "grid")
        if len(places) >= MAX_RESULTS and r / math.sqrt(2) >= MIN_RADIUS:
            queue.extend(split(lat, lng, r))
        done += 1
        if done % 50 == 0:
            log(f"  {done} circles, {len(queue)} queued, {len(found)} places")

    # 2. text searches, inside the GTA box, up to 3 pages each
    rect = {"rectangle": {"low": {"latitude": BBOX["lat0"], "longitude": BBOX["lng0"]},
                          "high": {"latitude": BBOX["lat1"], "longitude": BBOX["lng1"]}}}
    queries = [f"{t} {c}" for c in TEXT_CITIES for t in TEXT_PER_CITY] + [f"{t} Greater Toronto Area" for t in TEXT_GTA_WIDE]
    log(f"text: {len(queries)} searches")
    for q in queries:
        token = None
        for _ in range(3):
            body = {"textQuery": q, "pageSize": 20, "locationRestriction": rect}
            if token:
                body["pageToken"] = token
            res = g.call("text", "https://places.googleapis.com/v1/places:searchText", body, FIELDS_LIST + ",nextPageToken")
            add(res.get("places"), "text:" + q)
            token = res.get("nextPageToken")
            if not token:
                break

    # 3. details (website, phone, address parts) for places that look like places of prayer
    out = []
    for pid, f in found.items():
        p = f["place"]
        loc = p.get("location", {})
        d = {}
        if looks_like_prayer_place(p):
            d = g.call("details", f"https://places.googleapis.com/v1/places/{pid}", None, FIELDS_DETAILS)
        city = city_from(d.get("addressComponents"), p.get("formattedAddress"))
        out.append({
            "place_id": pid, "name": p.get("displayName", {}).get("text", ""), "address": p.get("formattedAddress"),
            "city": city, "region": CITY_REGION.get((city or "").lower()),
            "lat": loc.get("latitude"), "lng": loc.get("longitude"),
            "website": d.get("websiteUri"), "phone": d.get("nationalPhoneNumber"),
            "types": p.get("types", []), "primary_type": p.get("primaryType"), "business_status": p.get("businessStatus"),
            "found_by": sorted(f["found_by"]), "raw": {"place": p, "details": d},
        })
    return sorted(out, key=lambda c: (c["region"] or "~", c["city"] or "", c["name"]))


def cost(paid):
    worst = sum(n * PRICE[k][0] / 1000 for k, n in paid.items())
    after_free = sum(max(0, n - PRICE[k][1]) * PRICE[k][0] / 1000 for k, n in paid.items())
    return worst, after_free


def plan():
    grid = start_grid()
    text_calls = len(TEXT_CITIES) * len(TEXT_PER_CITY) + len(TEXT_GTA_WIDE)
    print(f"grid: {len(grid)} starting circles of {START_RADIUS / 1000:.0f} km; dense areas add about 4 calls per split")
    print(f"text: {text_calls} searches (up to 3 pages each = {text_calls * 3} calls at most)")
    print("details: one per unique place that looks like a place of prayer (expect 250-400 in the GTA)")
    est = {"nearby": len(grid) + 150, "text": text_calls * 2, "details": 350}
    worst, after = cost(est)
    print(f"estimate: {sum(est.values())} calls -> ${worst:.0f} at list price, ${after:.0f} after Google's free monthly allowance")


def write_outputs(cands):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "gta_candidates.json"), "w", encoding="utf-8") as fh:
        json.dump(cands, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(OUT, "gta_candidates.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["region", "city", "name", "address", "website", "phone", "google_types", "status", "found_by", "maps_link"])
        for c in cands:
            w.writerow([c["region"] or "outside", c["city"], c["name"], c["address"], c["website"] or "", c["phone"] or "",
                        " ".join(c["types"]), c["business_status"], "; ".join(c["found_by"]),
                        f"https://www.google.com/maps/place/?q=place_id:{c['place_id']}"])


def send(path):
    with open(path, encoding="utf-8") as fh:
        cands = json.load(fh)
    token = env_value("ADRIK_SCOUT_ADMIN_TOKEN")
    last = None
    for i in range(0, len(cands), 200):
        body = {"mode": "candidates", "candidates": cands[i:i + 200]}
        req = urllib.request.Request(SCOUT, data=json.dumps(body).encode(), method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {ANON}", "x-adrik-admin": token})
        try:
            with urllib.request.urlopen(req, timeout=170) as r:
                last = json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"Scout error HTTP {e.code}: {e.read().decode()[:300]}")
        print(f"sent {min(i + 200, len(cands))}/{len(cands)}: stored {last.get('stored')}, promoted {last.get('promoted')}")
    print(json.dumps({k: last.get(k) for k in ("by_status", "by_region")}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "run", "send"])
    ap.add_argument("--max-calls", type=int, default=2000, help="stop after this many paid Google calls (cached calls are free)")
    a = ap.parse_args()
    if a.cmd == "plan":
        return plan()
    if a.cmd == "send":
        return send(os.path.join(OUT, "gta_candidates.json"))
    os.makedirs(OUT, exist_ok=True)
    g = Google(env_value("GOOGLE_MAPS_API_KEY"), os.path.join(OUT, "gta_cache.json"), a.max_calls)
    try:
        cands = sweep(g)
    except BudgetReached:
        g.save()
        worst, after = cost(g.paid)
        sys.exit(f"stopped at --max-calls {a.max_calls} ({g.paid}); run again to continue from the cache. Spent so far: up to ${worst:.2f}")
    g.save()
    write_outputs(cands)
    worst, after = cost(g.paid)
    by_region = {}
    for c in cands:
        by_region[c["region"] or "outside"] = by_region.get(c["region"] or "outside", 0) + 1
    print(f"paid calls this run: {g.paid} -> up to ${worst:.2f} at list price (${after:.2f} after the free allowance)")
    print(f"places found: {len(cands)} {by_region}; with a website: {sum(1 for c in cands if c['website'])}")
    print("wrote out/gta_candidates.json and out/gta_candidates.csv; next: python3 gta_sweep.py send")


if __name__ == "__main__":
    main()
