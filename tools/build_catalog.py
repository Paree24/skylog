"""Build the compact offline catalog (data/catalog.json) from the raw
d3-celestial data files in data/raw/ (BSD-3, github.com/ofrohn/d3-celestial).

Run once:  python tools/build_catalog.py
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "catalog.json"


def ra_norm(ra):
    return ra % 360.0


def load(name):
    with open(RAW / name, encoding="utf-8") as f:
        return json.load(f)


# common names for the bright non-Messier list (d3-celestial ships designations only)
BRIGHT_NAMES = {
    "Cr 140": "Collinder 140", "Cr 399": "Coathanger", "IC 2602": "Southern Pleiades",
    "PGC 17223": "Large Magellanic Cloud", "C 41": "Hyades", "Cr 39": "Alpha Persei Cluster",
    "Cr 256": "Coma Star Cluster", "NGC 104": "47 Tucanae", "NGC 869": "Double Cluster (h Persei)",
    "NGC 884": "Double Cluster (χ Persei)", "NGC 2244": "Rosette Cluster", "NGC 2264": "Christmas Tree Cluster",
    "NGC 2362": "Tau Canis Majoris Cluster", "NGC 2516": "Southern Beehive", "NGC 3372": "Carina Nebula",
    "NGC 3532": "Wishing Well Cluster", "NGC 5139": "Omega Centauri", "NGC 6231": "Northern Jewel Box",
    "NGC 292": "Small Magellanic Cloud", "IC 2391": "Omicron Velorum Cluster", "NGC 2451": "NGC 2451",
}
# nicer names for some Messier objects
MESSIER_NAMES = {
    "M7": "Ptolemy's Cluster", "M31": "Andromeda Galaxy", "M33": "Triangulum Galaxy",
    "M44": "Beehive Cluster", "M24": "Sagittarius Star Cloud", "M81": "Bode's Galaxy",
    "M22": "Great Sagittarius Cluster", "M41": "Little Beehive", "M15": "Great Pegasus Cluster",
}
EXTRA_DSOS = [  # well-known naked-eye objects missing from the source files
    {"id": "NGC 4755", "name": "Jewel Box", "type": "oc", "ra": 193.4, "dec": -60.33, "mag": 4.2, "dim": "10"},
]
DSO_KIND = {
    "oc": "Open cluster", "gc": "Globular cluster", "s": "Spiral galaxy", "e": "Elliptical galaxy",
    "i": "Irregular galaxy", "sd": "Dwarf galaxy", "sfr": "Nebula", "en": "Emission nebula",
    "rn": "Reflection nebula", "snr": "Supernova remnant", "pn": "Planetary nebula", "pos": "Star cloud / asterism",
}
DSO_GROUP = {"oc": "cluster", "gc": "globular", "s": "galaxy", "e": "galaxy", "i": "galaxy", "sd": "galaxy",
             "sfr": "nebula", "en": "nebula", "rn": "nebula", "snr": "nebula", "pn": "planetary", "pos": "cluster"}


def parse_dim(d):
    try:
        parts = [float(x) for x in str(d).lower().replace("×", "x").split("x") if x.strip()]
    except ValueError:
        return 5.0, 5.0
    if not parts:
        return 5.0, 5.0
    return parts[0], parts[1] if len(parts) > 1 else parts[0]


def build_dsos(stars):
    messier = load("messier.json")["features"]
    bright = load("dsos.bright.json")["features"]
    out = []
    for f in messier:
        p = f["properties"]
        mid = f["id"]
        name = MESSIER_NAMES.get(mid, p.get("alt") or None)
        name = (name or "").replace("´", "'").replace("’", "'")
        ra, dec = f["geometry"]["coordinates"]
        a, b = parse_dim(p.get("dim"))
        out.append({"id": mid, "name": name or mid, "desig": f"{mid}" + (f" · {p['desig']}" if p.get("desig") else ""),
                    "ngc": p.get("desig", ""), "type": p["type"], "ra": ra % 360, "dec": dec,
                    "mag": float(p.get("mag") or 9), "size": a, "size2": b})
    known_ngc = {d["ngc"].replace(" ", "") for d in out if d["ngc"]}
    messier_only = list(out)
    for f in bright + [{"id": e["id"], "properties": {"type": e["type"], "mag": e["mag"], "dim": e["dim"]},
                        "geometry": {"coordinates": [e["ra"], e["dec"]]}, "_name": e["name"]} for e in EXTRA_DSOS]:
        p, did = f["properties"], f["id"]
        if did == "GC" or did.replace(" ", "") in known_ngc:
            continue
        ra, dec = f["geometry"]["coordinates"]
        ra %= 360
        if any(abs((d["ra"] - ra + 180) % 360 - 180) < 0.5 and abs(d["dec"] - dec) < 0.5 for d in messier_only):
            continue  # same object already listed under its Messier number
        a, b = parse_dim(p.get("dim"))
        out.append({"id": did, "name": f.get("_name") or BRIGHT_NAMES.get(did, did), "desig": did, "ngc": did,
                    "type": p["type"], "ra": ra, "dec": dec, "mag": float(p.get("mag") or 9), "size": a, "size2": b})
    # constellation: nearest catalogue star that has one
    for d in out:
        best, bd = "", 1e9
        for s in stars:
            if not s["con"]:
                continue
            dd = ((s["ra"] - d["ra"] + 180) % 360 - 180) ** 2 * math.cos(math.radians(d["dec"])) ** 2 + (s["dec"] - d["dec"]) ** 2
            if dd < bd:
                best, bd = s["con"], dd
        d["con"] = best
        d["kind"] = DSO_KIND.get(d["type"], "Deep-sky object")
        d["group"] = DSO_GROUP.get(d["type"], "cluster")
        for k in ("ra", "dec", "size", "size2"):
            d[k] = round(d[k], 4 if k in ("ra", "dec") else 1)
        del d["ngc"]
    return out


def main():
    stars_raw = load("stars.6.json")["features"]
    names = load("starnames.json")
    cons_raw = load("constellations.json")["features"]
    lines_raw = {f["id"]: f for f in load("constellations.lines.json")["features"]}

    stars = []
    for f in stars_raw:
        hip = f["id"]
        ra, dec = f["geometry"]["coordinates"]
        p = f["properties"]
        n = names.get(str(hip), {})
        bayer = n.get("bayer") or n.get("flam") or ""
        try:
            bv = float(p.get("bv") or 0.6)
        except ValueError:
            bv = 0.6
        stars.append({
            "hip": hip,
            "ra": round(ra_norm(ra), 4),
            "dec": round(dec, 4),
            "mag": p["mag"],
            "bv": round(bv, 2),
            "name": n.get("name", ""),
            "bayer": bayer,
            "con": n.get("c", ""),
        })

    # spatial hash for matching line vertices to catalog stars
    grid = {}
    for i, s in enumerate(stars):
        grid.setdefault((int(s["ra"]), int(s["dec"])), []).append(i)

    def nearest(ra, dec):
        best, bd = None, 0.15  # degrees tolerance
        for dra in (-1, 0, 1):
            for ddec in (-1, 0, 1):
                key = ((int(ra) + dra) % 360, int(dec) + ddec)
                for i in grid.get(key, []):
                    s = stars[i]
                    d = math.hypot((s["ra"] - ra + 180) % 360 - 180, s["dec"] - dec)
                    if d < bd:
                        best, bd = i, d
        return best

    cons = []
    for f in cons_raw:
        p = f["properties"]
        abbr = f["id"]
        lines = []
        members = set()
        for seg in lines_raw.get(abbr, {}).get("geometry", {}).get("coordinates", []):
            pts = []
            for ra, dec in seg:
                ra = ra_norm(ra)
                idx = nearest(ra, dec)
                mag = stars[idx]["mag"] if idx is not None else 4.0
                if idx is not None:
                    members.add(stars[idx]["hip"])
                    if not stars[idx]["con"]:
                        stars[idx]["con"] = abbr
                pts.append([round(ra, 4), round(dec, 4), mag])
            lines.append(pts)
        cra, cdec = f["geometry"]["coordinates"]
        cons.append({
            "id": abbr,
            "name": p["name"],
            "gen": p.get("gen", ""),
            "rank": int(p.get("rank", 3)),
            "ra": round(ra_norm(cra), 3),
            "dec": cdec,
            "lines": lines,
            "members": sorted(members),
        })

    dsos = build_dsos(stars)
    OUT.write_text(json.dumps({"stars": stars, "constellations": cons, "dsos": dsos},
                              ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT} ({len(stars)} stars, {len(cons)} constellations, {len(dsos)} deep-sky objects)")


if __name__ == "__main__":
    main()
