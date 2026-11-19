import unittest
from datetime import datetime, timezone

from skylogger.astro import compute_sky, sun_position, julian_date, radec_to_altaz, lst_deg


class AstroTests(unittest.TestCase):
    def test_polaris_altitude_matches_latitude(self):
        for lat in (20.0, 51.5, 70.0):
            sky = compute_sky(lat, 0.0, datetime(2026, 1, 1, 22, tzinfo=timezone.utc), 1)
            pol = next(s for s in sky["stars"] if s["name"] == "Polaris")
            self.assertAlmostEqual(pol["alt"], lat, delta=1.0)

    def test_solstice_noon_sun_altitude(self):
        jd = julian_date(datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc))
        _, ra, dec = sun_position(jd)
        alt, az = radec_to_altaz(ra, dec, 51.48, lst_deg(jd, 0.0))
        self.assertAlmostEqual(alt, 90 - 51.48 + 23.44, delta=0.5)
        self.assertAlmostEqual(az, 180, delta=3)

    def test_light_pollution_reduces_visible_stars(self):
        when = datetime(2026, 1, 15, 20, tzinfo=timezone.utc)  # moon-free check not needed: same moon both runs
        counts = [compute_sky(30.0, 0.0, when, b)["counts"]["stars_visible"] for b in (1, 5, 9)]
        self.assertGreater(counts[0], counts[1])
        self.assertGreater(counts[1], counts[2])

    def test_daytime_shows_nothing(self):
        sky = compute_sky(0.0, 0.0, datetime(2026, 3, 20, 12, tzinfo=timezone.utc), 1)
        self.assertEqual(sky["sun"]["phase"], "Daytime")
        self.assertEqual(sky["counts"]["stars_visible"], 0)

    def test_orion_visible_on_winter_evening(self):
        sky = compute_sky(40.0, -74.0, datetime(2026, 1, 20, 3, tzinfo=timezone.utc), 3)
        ori = next(c for c in sky["constellations"] if c["id"] == "Ori")
        self.assertEqual(ori["status"], "visible")


class PlanetTests(unittest.TestCase):
    def sample(self):
        from skylogger.astro import planet_positions, sun_position, _sep
        for day in range(0, 365 * 20, 11):  # 2026-2046
            jd = 2461041.5 + day
            _, sra, sdec = sun_position(jd)
            for p in planet_positions(jd):
                yield p, _sep(p["ra"], p["dec"], sra, sdec)

    def test_inner_planets_stay_near_sun(self):
        for p, elong in self.sample():
            if p["name"] == "Mercury":
                self.assertLess(elong, 28.5)
            if p["name"] == "Venus":
                self.assertLess(elong, 47.9)

    def test_magnitudes_in_known_ranges(self):
        ranges = {"Venus": (-4.95, -3.7), "Jupiter": (-2.95, -1.6), "Saturn": (-0.6, 1.5),
                  "Mars": (-3.0, 1.9), "Uranus": (5.3, 6.1), "Neptune": (7.6, 8.0)}
        for p, _ in self.sample():
            lo, hi = ranges.get(p["name"], (-99, 99))
            self.assertTrue(lo <= p["mag"] <= hi, (p["name"], p["mag"]))

    def test_planets_in_sky_output(self):
        sky = compute_sky(34.15, 77.58, datetime(2026, 11, 19, 14, 30, tzinfo=timezone.utc), 2)
        sat = next(p for p in sky["planets"] if p["id"] == "saturn")
        self.assertTrue(sat["vis"])
        self.assertEqual(len(sky["planets"]), 7)


class DeepSkyTests(unittest.TestCase):
    WHEN = datetime(2026, 11, 19, 17, 30, tzinfo=timezone.utc)  # 23:00 IST

    def names(self, bortle, how="naked-eye"):
        sky = compute_sky(34.15, 77.58, self.WHEN, bortle)
        return {d["name"] for d in sky["dsos"] if d["how"] == how}

    def test_famous_objects_in_catalog(self):
        from skylogger.astro import catalog
        names = {d["name"] for d in catalog()["dsos"]}
        for n in ("Pleiades", "Hyades", "Orion Nebula", "Andromeda Galaxy", "Omega Centauri", "Carina Nebula",
                  "Large Magellanic Cloud", "Small Magellanic Cloud", "Beehive Cluster", "Coathanger",
                  "Double Cluster (h Persei)", "Double Cluster (χ Persei)", "47 Tucanae", "Jewel Box"):
            self.assertIn(n, names)

    def test_dark_sky_shows_more_than_city(self):
        dark, city = self.names(2), self.names(8)
        self.assertTrue({"Andromeda Galaxy", "Orion Nebula", "Pleiades"} <= dark)
        self.assertIn("Pleiades", city)
        self.assertNotIn("Andromeda Galaxy", city)
        self.assertIn("Andromeda Galaxy", self.names(8, "binoculars"))


class StatsAndChecklistTests(unittest.TestCase):
    SESSION = {"date": "2026-11-19", "lat": 34.15, "lon": 77.58, "tz": 5.5, "bortle": 5, "items": [
        {"kind": "planet", "ref": "saturn", "name": "Saturn", "time": "20:00"},
        {"kind": "dso", "ref": "M31", "name": "Andromeda Galaxy", "time": "22:10"},
        {"kind": "planet", "ref": "jupiter", "name": "Jupiter", "time": "01:00"},
    ]}

    def test_light_pollution_by_hour(self):
        from skylogger.stats import session_stats
        st = session_stats(self.SESSION)
        rows = {r["hour"]: r for r in st["light_pollution"]["by_hour"]}
        # Saturn / Jupiter are visible under any sky: the hour keeps the user's setting
        self.assertFalse(rows["20:00–21:00"]["estimated"])
        self.assertEqual(rows["20:00–21:00"]["bortle"], 5)
        self.assertFalse(rows["01:00–02:00"]["estimated"])
        # Andromeda is real evidence of a reasonably dark sky
        self.assertTrue(rows["22:00–23:00"]["estimated"])
        self.assertLessEqual(rows["22:00–23:00"]["bortle"], 6)

    def test_coverage_and_window(self):
        from skylogger.stats import session_stats
        st = session_stats(self.SESSION)
        self.assertEqual(st["window"]["minutes"], 300)
        self.assertGreater(st["coverage"]["pct_up"], 50)
        self.assertLessEqual(st["coverage"]["pct_up"], st["coverage"]["max_possible"] + 1)

    def test_coverage_never_exceeds_latitude_maximum(self):
        from skylogger.stats import session_stats
        for lat in (19.08, 34.15, -33.9, 60.0):
            sess = dict(self.SESSION, lat=lat, start="18:00", end="06:00")
            cov = session_stats(sess)["coverage"]
            self.assertLessEqual(cov["pct_up"], cov["max_possible"] + 1.0, lat)
        self.assertAlmostEqual(session_stats(dict(self.SESSION, lat=0.0))["coverage"]["max_possible"], 100.0)

    def test_visible_logged_summary(self):
        from skylogger.stats import session_stats
        st = session_stats(self.SESSION)
        vl = st["visible_logged"]
        self.assertEqual(vl["available"], sum(c["available"] for c in st["categories"]))
        self.assertGreater(vl["logged"], 0)
        self.assertLessEqual(vl["logged"], vl["available"])

    def test_checklist(self):
        from skylogger.checklist import checklist
        c = checklist()
        self.assertGreaterEqual(len(c), 100)
        self.assertEqual(c[0]["name"], "Moon")
        names = [i["name"] for i in c]
        for n in ("Sirius", "Venus", "Pleiades", "Orion Nebula", "Andromeda Galaxy"):
            self.assertIn(n, names)
        self.assertEqual([i["rank"] for i in c], list(range(1, len(c) + 1)))


if __name__ == "__main__":
    unittest.main()
