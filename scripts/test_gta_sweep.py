"""Tests for gta_sweep.py with a fake Google (no network, no key): python3 -m unittest scripts/test_gta_sweep.py"""
import math, os, random, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gta_sweep as gs


def dist_m(a, b):
    dy = (a[0] - b[0]) * 111320
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


class FakeGoogle:
    """Places at known spots; Nearby returns at most 20 per circle, like the real API."""
    def __init__(self, places):
        self.places = places

    def __call__(self, url, body, mask):
        if url.endswith(":searchNearby"):
            c = body["locationRestriction"]["circle"]
            ctr = (c["center"]["latitude"], c["center"]["longitude"])
            hits = [p for p in self.places if "mosque" in p["types"] and dist_m(ctr, (p["location"]["latitude"], p["location"]["longitude"])) <= c["radius"]]
            hits.sort(key=lambda p: dist_m(ctr, (p["location"]["latitude"], p["location"]["longitude"])))
            return {"places": hits[:20]}
        if url.endswith(":searchText"):
            q = body["textQuery"].lower()
            return {"places": [p for p in self.places if q.split()[0] in p["displayName"]["text"].lower()][:20]}
        pid = url.rsplit("/", 1)[1]
        p = next(p for p in self.places if p["id"] == pid)
        return {"id": pid, "websiteUri": p.get("_web"), "addressComponents": [{"longText": p["_city"], "types": ["locality"]}]}


def place(i, lat, lng, city, name=None, types=("mosque", "place_of_worship"), web=None):
    return {"id": f"P{i}", "displayName": {"text": name or f"Masjid {i}"}, "formattedAddress": f"{i} Main St, {city}, ON A1A 1A1, Canada",
            "location": {"latitude": lat, "longitude": lng}, "types": list(types), "businessStatus": "OPERATIONAL",
            "_city": city, "_web": web}


class SweepTest(unittest.TestCase):
    def test_grid_has_no_gaps(self):
        pts = gs.start_grid()
        rnd = random.Random(1)
        for _ in range(3000):
            q = (rnd.uniform(gs.BBOX["lat0"], gs.BBOX["lat1"]), rnd.uniform(gs.BBOX["lng0"], gs.BBOX["lng1"]))
            self.assertTrue(any(dist_m(q, (a, b)) <= r for a, b, r in pts), q)

    def test_split_covers_parent(self):
        lat, lng, r = 43.6, -79.6, 5000
        kids = gs.split(lat, lng, r)
        rnd = random.Random(2)
        for _ in range(2000):
            ang, d = rnd.uniform(0, 2 * math.pi), r * math.sqrt(rnd.random())
            q = (lat + d * math.sin(ang) / 111320, lng + d * math.cos(ang) / (111320 * math.cos(math.radians(lat))))
            self.assertTrue(any(dist_m(q, (a, b)) <= kr + 1 for a, b, kr in kids))

    def test_dense_cluster_found_completely(self):
        rnd = random.Random(3)
        ps = [place(i, 43.60 + rnd.uniform(-0.01, 0.01), -79.65 + rnd.uniform(-0.012, 0.012), "Mississauga", web=f"https://m{i}.example") for i in range(70)]
        ps += [place(100 + i, rnd.uniform(43.3, 44.4), rnd.uniform(-80.2, -78.6), "Brampton") for i in range(40)]
        ps.append(place(200, 43.77, -79.25, "Scarborough", name="Musalla Al-Noor", types=("point_of_interest",)))
        ps.append(place(201, 43.70, -79.75, "Brampton", name="Islamic Halal Grocery", types=("grocery_store", "store")))
        ps.append(place(202, 44.38, -79.69, "Barrie", name="Barrie Masjid"))
        fake = FakeGoogle(ps)
        with tempfile.TemporaryDirectory() as d:
            g = gs.Google("k", os.path.join(d, "c.json"), 100000, fetch=fake)
            out = gs.sweep(g, log=lambda *_: None)
            ids = {c["place_id"] for c in out}
            for p in ps[:110]:
                self.assertIn(p["id"], ids, "a mosque typed place was missed")
            self.assertIn("P200", ids)                      # found by the "musalla" text search
            byid = {c["place_id"]: c for c in out}
            self.assertEqual(byid["P0"]["region"], "peel")
            self.assertEqual(byid["P0"]["website"], "https://m0.example")
            self.assertEqual(byid["P200"]["region"], "toronto")
            self.assertIsNone(byid["P202"]["region"])       # Barrie is outside the GTA
            self.assertEqual(byid["P201"]["raw"]["details"], {})   # shop: no paid details call
            paid = dict(g.paid)
            self.assertGreater(paid["nearby"], len(gs.start_grid()))   # the dense cluster was split
            # second run: everything comes from the cache, nothing is paid
            g.save()
            g2 = gs.Google("k", os.path.join(d, "c.json"), 0, fetch=fake)
            out2 = gs.sweep(g2, log=lambda *_: None)
            self.assertEqual(len(out2), len(out))
            self.assertEqual(sum(g2.paid.values()), 0)

    def test_budget_stops(self):
        g = gs.Google("k", None, 5, fetch=FakeGoogle([]))
        with self.assertRaises(gs.BudgetReached):
            gs.sweep(g, log=lambda *_: None)
        self.assertEqual(sum(g.paid.values()), 5)

    def test_city_parsing(self):
        self.assertEqual(gs.city_from(None, "2580 Drew Rd, Mississauga, ON L4T 3M5, Canada"), "Mississauga")
        self.assertEqual(gs.city_from([{"longText": "Scarborough", "types": ["sublocality_level_1"]},
                                       {"longText": "Toronto", "types": ["locality"]}], ""), "Scarborough")
        self.assertEqual(gs.CITY_REGION["whitby"], "durham")


if __name__ == "__main__":
    unittest.main()
