"""Statistics for an observing session.

* sky coverage during the observing window
* logged vs. available objects per category
* light pollution (Bortle) inferred from what was actually seen, per hour
"""
import math
from datetime import datetime, timedelta, timezone

from .astro import (BORTLE_LABEL, BORTLE_NELM, airmass, catalog, compute_sky, julian_date,
                    limiting_magnitude, lst_deg, moon_phase, moon_position, planet_positions,
                    radec_to_altaz, sun_position)

SAMPLE_MINUTES = 15
COVERAGE_POINTS = 2400
BRIGHT_STAR_MAG = 2.0


def k_ext(bortle):
    return 0.20 + 0.015 * (bortle - 1)


def dso_size_penalty(size):
    return max(0.0, math.log10(max(size, 1) / 8.0))


# ------------------------------------------------------------------ time

def night_to_utc(date_str, hhmm, tz):
    """Local clock time on the observing night (times before noon = next morning) -> UTC."""
    y, m, d = (int(x) for x in date_str.split("-"))
    hh, mm = (int(x) for x in hhmm.split(":"))
    minutes = ((hh - 12) % 24) * 60 + mm
    local_noon = datetime(y, m, d, 12, 0, tzinfo=timezone.utc)
    return local_noon + timedelta(minutes=minutes) - timedelta(hours=tz)


def item_utc(item, sess):
    if item.get("utc"):
        return datetime.fromisoformat(item["utc"].replace("Z", "+00:00"))
    return night_to_utc(sess["date"], item.get("time", "21:00"), float(sess.get("tz", 0)))


def local_clock(utc, tz):
    t = utc + timedelta(hours=tz)
    return t.strftime("%H:%M"), t.hour


# ------------------------------------------------------- object geometry

class Lookup:
    def __init__(self):
        cat = catalog()
        self.stars = {s["hip"]: s for s in cat["stars"]}
        self.dsos = {d["id"]: d for d in cat["dsos"]}
        self.cons = {c["id"]: c for c in cat["constellations"]}


def object_components(item, jd, lat, lst, lk):
    """What the observer must have seen to log this item.

    Returns (components, required, ra, dec) where components is a list of
    (mag, alt, extra_penalty); at least `required` of them must be visible.
    Returns None for objects that carry no brightness information (e.g. the Moon).
    """
    kind, ref = item.get("kind"), item.get("ref")
    if kind == "star":
        s = lk.stars.get(int(ref)) if str(ref).isdigit() else None
        if not s:
            return None
        alt, _ = radec_to_altaz(s["ra"], s["dec"], lat, lst)
        return [(s["mag"], alt, 0.0)], 1, s["ra"], s["dec"]
    if kind == "dso":
        d = lk.dsos.get(ref)
        if not d:
            return None
        alt, _ = radec_to_altaz(d["ra"], d["dec"], lat, lst)
        return [(d["mag"], alt, dso_size_penalty(d["size"]))], 1, d["ra"], d["dec"]
    if kind == "constellation":
        c = lk.cons.get(ref)
        if not c or not c["members"]:
            return None
        comps = []
        for hip in c["members"]:
            s = lk.stars.get(hip)
            if s:
                alt, _ = radec_to_altaz(s["ra"], s["dec"], lat, lst)
                comps.append((s["mag"], alt, 0.0))
        # recognising a figure needs roughly half of its pattern stars
        return comps, max(1, math.ceil(len(comps) / 2)), c["ra"], c["dec"]
    if kind == "planet":
        if ref == "moon":
            _, ra, dec = moon_position(jd)
            return [], 0, ra, dec  # always visible: no information
        for p in planet_positions(jd):
            if p["name"].lower() == ref:
                alt, _ = radec_to_altaz(p["ra"], p["dec"], lat, lst)
                return [(p["mag"], alt, 0.0)], 1, p["ra"], p["dec"]
    return None


def max_bortle_for(components, required, sun_alt, moon_alt, illum):
    """Brightest sky (highest Bortle) under which the item could still be seen.

    None  -> not visible even under Bortle 1 per the model (e.g. logged in daylight)
    9     -> visible under any sky (uninformative)
    """
    best = None
    for b in range(1, 10):
        lim = limiting_magnitude(b, sun_alt, moon_alt, illum)
        n_ok = sum(1 for mag, alt, pen in components
                   if alt > 0 and mag + k_ext(b) * (airmass(alt) - 1) + pen <= lim)
        if n_ok >= required:
            best = b
    return best


def faintest_needed(components, required, b):
    """Effective magnitude of the faintest component the observer needed (for display)."""
    effs = sorted(mag + k_ext(b) * (airmass(alt) - 1) + pen for mag, alt, pen in components if alt > 0)
    if not effs or required == 0:
        return None
    return round(effs[min(required, len(effs)) - 1], 2)


# ------------------------------------------------------------- coverage

def fibonacci_sphere(n):
    pts = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        z = 1 - 2 * (i + 0.5) / n
        lon = (i * ga) % (2 * math.pi)
        pts.append((math.degrees(lon), math.degrees(math.asin(z))))
    return pts


# ----------------------------------------------------------------- main

def session_stats(sess):
    lat, lon = float(sess["lat"]), float(sess["lon"])
    tz = float(sess.get("tz", 0))
    set_bortle = int(sess.get("bortle", 5))
    items = sess.get("items", [])
    lk = Lookup()

    times = sorted(item_utc(i, sess) for i in items)
    start = night_to_utc(sess["date"], sess["start"], tz) if sess.get("start") else (times[0] if times else None)
    end = night_to_utc(sess["date"], sess["end"], tz) if sess.get("end") else (times[-1] if times else None)
    if start is None:
        return {"empty": True}
    if end < start:
        start, end = end, start
    n_samples = max(1, int((end - start).total_seconds() // (SAMPLE_MINUTES * 60)) + 1)
    samples = [start + timedelta(minutes=SAMPLE_MINUTES * k) for k in range(n_samples)]
    if samples[-1] < end:
        samples.append(end)

    # ---- sky coverage
    pts = fibonacci_sphere(COVERAGE_POINTS)
    up = [False] * len(pts)
    up20 = [False] * len(pts)
    lsts = [lst_deg(julian_date(t), lon) for t in samples]
    for i, (ra, dec) in enumerate(pts):
        for lst in lsts:
            alt, _ = radec_to_altaz(ra, dec, lat, lst)
            if alt > 0:
                up[i] = True
                if alt > 20:
                    up20[i] = True
                    break
    pct_up = 100.0 * sum(up) / len(pts)
    pct_up20 = 100.0 * sum(up20) / len(pts)
    # stars with dec > -(90 - |lat|) (mirrored for the south) rise at some time: fraction (1 + cos lat) / 2
    max_possible = 50.0 * (1 + math.cos(math.radians(abs(lat))))

    # ---- availability during the window (with the configured sky)
    avail = {"planet": set(), "dso": set(), "constellation": set(), "star": set()}
    names = {}
    for t in samples:
        sky = compute_sky(lat, lon, t, set_bortle)
        for p in sky["planets"]:
            if p["vis"]:
                avail["planet"].add(p["id"]); names[("planet", p["id"])] = p["name"]
        if sky["moon"]["alt"] > 0:
            avail["planet"].add("moon"); names[("planet", "moon")] = "Moon"
        for d in sky["dsos"]:
            if d["vis"]:
                avail["dso"].add(d["id"]); names[("dso", d["id"])] = d["name"]
        for c in sky["constellations"]:
            if c["status"] in ("visible", "partial"):
                avail["constellation"].add(c["id"]); names[("constellation", c["id"])] = c["name"]
        for s in sky["stars"]:
            if s["vis"] and s["mag"] <= BRIGHT_STAR_MAG:
                avail["star"].add(str(s["hip"])); names[("star", str(s["hip"]))] = s["name"] or f"HIP {s['hip']}"

    logged = {k: set() for k in avail}
    for i in items:
        if i.get("kind") in logged:
            logged[i["kind"]].add(str(i["ref"]))
    categories = []
    labels = {"planet": "Planets & Moon", "dso": "Deep-sky objects", "constellation": "Constellations",
              "star": f"Bright stars (mag ≤ {BRIGHT_STAR_MAG:g})"}
    for k in ("planet", "dso", "constellation", "star"):
        got = logged[k] & avail[k]
        missed = sorted((names.get((k, r), r) for r in avail[k] - logged[k]))
        categories.append({
            "kind": k, "label": labels[k], "logged_total": len(logged[k]),
            "logged_available": len(got), "available": len(avail[k]),
            "pct": round(100.0 * len(got) / len(avail[k]), 1) if avail[k] else None,
            "missed": missed[:12], "missed_more": max(0, len(missed) - 12),
        })

    # ---- per-item light-pollution evidence
    evidence = []
    positions = []
    for it in items:
        t = item_utc(it, sess)
        jd = julian_date(t)
        lst = lst_deg(jd, lon)
        _, sra, sdec = sun_position(jd)
        sun_alt, _ = radec_to_altaz(sra, sdec, lat, lst)
        _, mra, mdec = moon_position(jd)
        moon_alt, _ = radec_to_altaz(mra, mdec, lat, lst)
        illum, _, _ = moon_phase(jd)
        comp = object_components(it, jd, lat, lst, lk)
        clock, hour = local_clock(t, tz)
        if comp is None:
            continue
        comps, required, ra, dec = comp
        positions.append({"kind": it["kind"], "name": it.get("name"), "ra": round(ra, 2), "dec": round(dec, 2)})
        if required == 0:
            bmax = 9
        else:
            bmax = max_bortle_for(comps, required, sun_alt, moon_alt, illum)
        beyond = bmax is None and required > 0 and any(alt > 0 for _, alt, _ in comps)
        if beyond:  # fainter than the model allows even at Bortle 1 -> strongest evidence of a dark sky
            bmax = 1
        # magnitudes: catalogue value of what had to be seen, and its effective value (haze + size) tonight
        up_mags = sorted(m for m, a, _ in comps if a > 0)
        cat_mag = (up_mags[min(required, len(up_mags)) - 1] if up_mags and required else
                   (-12.7 if it.get("ref") == "moon" else None))
        alt_obj = max((a for _, a, _ in comps), default=None)
        # per-Bortle thresholds at that moment, and whether this object passes each one
        limits = [round(limiting_magnitude(b, sun_alt, moon_alt, illum), 2) for b in range(1, 10)]
        ok = [required == 0 or sum(1 for m, a, p in comps
                                   if a > 0 and m + k_ext(b) * (airmass(a) - 1) + p <= limits[b - 1]) >= required
              for b in range(1, 10)]
        evidence.append({
            "name": it.get("name"), "kind": it["kind"], "time": clock, "hour": hour,
            "max_bortle": bmax, "informative": bmax is not None and bmax < 9, "beyond_model": beyond,
            "needed_mag": faintest_needed(comps, required, bmax or 1),
            "mag": round(cat_mag, 2) if cat_mag is not None else None, "eff_mag": faintest_needed(comps, required, set_bortle),
            "alt": round(alt_obj, 1) if alt_obj is not None and it["kind"] != "constellation" else None,
            "limits": limits, "ok": ok,
            "moon_up": moon_alt > 0, "twilight": sun_alt > -18,
        })

    # ---- per-hour estimate
    hours = {}
    for e in evidence:
        hours.setdefault(e["hour"], []).append(e)
    by_hour = []
    for h in sorted(hours, key=lambda h: (h - 12) % 24):
        ev = hours[h]
        info = [e for e in ev if e["informative"]]
        impossible = [e for e in ev if e["max_bortle"] is None]
        row = {"hour": f"{h:02d}:00–{(h + 1) % 24:02d}:00", "n_items": len(ev)}
        if info:
            key = min(info, key=lambda e: (e["max_bortle"], -(e["needed_mag"] or 0)))
            row.update({"bortle": key["max_bortle"], "estimated": True, "evidence": key["name"],
                        "beyond_model": key["beyond_model"],
                        "evidence_mag": key["needed_mag"], "moon_up": key["moon_up"],
                        "label": BORTLE_LABEL[key["max_bortle"]], "nelm": BORTLE_NELM[key["max_bortle"]]})
        else:
            row.update({"bortle": set_bortle, "estimated": False, "evidence": None,
                        "label": BORTLE_LABEL[set_bortle], "nelm": BORTLE_NELM[set_bortle]})
        # threshold strip: limits at the most demanding object's time (or the hour's first log)
        ref = min(info, key=lambda e: (e["max_bortle"], -(e["needed_mag"] or 0))) if info else ev[0]
        row["limits"] = ref["limits"]
        row["ok"] = ref["ok"] if info else [True] * 9
        row["items"] = [{k: e[k] for k in ("name", "kind", "time", "mag", "eff_mag", "alt", "max_bortle", "beyond_model")}
                        for e in sorted(ev, key=lambda e: ((int(e["time"][:2]) - 12) % 24, e["time"]))]
        row["uninformative"] = [e["name"] for e in ev if e["max_bortle"] == 9]
        row["inconsistent"] = [e["name"] for e in impossible]  # e.g. below the horizon at the logged time
        by_hour.append(row)

    est = [r["bortle"] for r in by_hour if r["estimated"]]
    overall = {
        "bortle": min(est) if est else None,          # darkest the evidence proves at some point
        "worst_hour_bortle": max(est) if est else None,
        "set_bortle": set_bortle,
    }

    return {
        "empty": False,
        "window": {"start": local_clock(start, tz)[0], "end": local_clock(end, tz)[0],
                   "minutes": round((end - start).total_seconds() / 60),
                   "from_log": not (sess.get("start") or sess.get("end"))},
        "coverage": {"pct_up": round(pct_up, 1), "pct_up20": round(pct_up20, 1),
                     "max_possible": round(max_possible, 1),
                     "points": [[round(ra, 1), round(dec, 1), 2 if b20 else (1 if u else 0)]
                                for (ra, dec), u, b20 in zip(pts, up, up20)]},
        "categories": categories,
        "visible_logged": {
            "logged": sum(c["logged_available"] for c in categories),
            "available": sum(c["available"] for c in categories),
            "pct": round(100.0 * sum(c["logged_available"] for c in categories)
                         / max(1, sum(c["available"] for c in categories)), 1),
        },
        "counts": {k: len(v) for k, v in logged.items()},
        "positions": positions,
        "evidence": evidence,
        "light_pollution": {"by_hour": by_hour, "overall": overall},
    }
