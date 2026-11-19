"""A ranked checklist of the brightest objects in the night sky."""
from functools import lru_cache

from .astro import catalog

N_STARS = 100
DSO_MAG_LIMIT = 5.0

# (id, name, typical brightest magnitude) — planets vary; this is a typical good apparition
SOLAR_SYSTEM = [
    ("moon", "Moon", -12.7), ("venus", "Venus", -4.4), ("jupiter", "Jupiter", -2.5),
    ("mars", "Mars", -1.5), ("mercury", "Mercury", -0.5), ("saturn", "Saturn", 0.5), ("uranus", "Uranus", 5.7),
]


@lru_cache(maxsize=1)
def checklist():
    cat = catalog()
    cons = {c["id"]: c["name"] for c in cat["constellations"]}
    items = [{"kind": "planet", "ref": pid, "name": name, "mag": mag, "group": "Solar system",
              "detail": "Planet" if pid != "moon" else "Earth's Moon"} for pid, name, mag in SOLAR_SYSTEM]

    stars = sorted(cat["stars"], key=lambda s: s["mag"])[:N_STARS]
    for s in stars:
        desig = f"{s['bayer']} {s['con']}".strip() if s["bayer"] else ""
        items.append({"kind": "star", "ref": s["hip"], "name": s["name"] or desig or f"HIP {s['hip']}",
                      "mag": s["mag"], "group": "Stars", "con": cons.get(s["con"], s["con"]),
                      "detail": desig if s["name"] else "Star", "ra": s["ra"], "dec": s["dec"]})

    for d in cat["dsos"]:
        if d["mag"] <= DSO_MAG_LIMIT:
            items.append({"kind": "dso", "ref": d["id"], "name": d["name"], "mag": d["mag"], "group": "Deep sky",
                          "con": cons.get(d["con"], d["con"]), "detail": f"{d['kind']} · {d['desig']}",
                          "ra": d["ra"], "dec": d["dec"]})

    items.sort(key=lambda i: i["mag"])
    for rank, it in enumerate(items, 1):
        it["rank"] = rank
    return items
