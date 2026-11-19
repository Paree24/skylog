"""Pure-Python positional astronomy for the sky logger (no external deps).

Accuracy target: visual planning (~0.5 deg). Catalog positions are J2000;
precession to date is ignored (< 0.4 deg for the 2020s).
"""
import json
import math
from datetime import datetime, timezone
from functools import lru_cache

from .paths import CATALOG as CATALOG_PATH

D2R = math.pi / 180.0
R2D = 180.0 / math.pi

# Naked-eye limiting magnitude at zenith for each Bortle class (1..9)
BORTLE_NELM = {1: 7.6, 2: 7.1, 3: 6.6, 4: 6.2, 5: 5.8, 6: 5.3, 7: 4.8, 8: 4.3, 9: 3.8}
BORTLE_LABEL = {
    1: "Excellent dark site", 2: "Truly dark site", 3: "Rural sky",
    4: "Rural/suburban transition", 5: "Suburban sky", 6: "Bright suburban sky",
    7: "Suburban/urban transition", 8: "City sky", 9: "Inner-city sky",
}


@lru_cache(maxsize=1)
def catalog():
    with open(CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------- time

def julian_date(dt: datetime) -> float:
    dt = dt.astimezone(timezone.utc)
    return dt.timestamp() / 86400.0 + 2440587.5


def lst_deg(jd: float, lon_deg: float) -> float:
    """Local sidereal time in degrees (IAU 1982 GMST)."""
    t = (jd - 2451545.0) / 36525.0
    gmst = (280.46061837 + 360.98564736629 * (jd - 2451545.0)
            + 0.000387933 * t * t - t ** 3 / 38710000.0)
    return (gmst + lon_deg) % 360.0


# -------------------------------------------------------------- coordinates

def radec_to_altaz(ra, dec, lat, lst):
    """All degrees. Returns (alt, az) with az measured from North through East."""
    h = (lst - ra) * D2R
    d = dec * D2R
    p = lat * D2R
    sin_alt = math.sin(d) * math.sin(p) + math.cos(d) * math.cos(p) * math.cos(h)
    sin_alt = max(-1.0, min(1.0, sin_alt))
    alt = math.asin(sin_alt)
    y = -math.cos(d) * math.sin(h)
    x = math.sin(d) * math.cos(p) - math.cos(d) * math.sin(p) * math.cos(h)
    az = math.atan2(y, x) % (2 * math.pi)
    return alt * R2D, az * R2D


def airmass(alt):
    if alt <= 0:
        return 40.0
    s = math.sin(alt * D2R)
    return 1.0 / (s + 0.025 * math.exp(-11.0 * s))


# ---------------------------------------------------------------- sun/moon

def _obliquity(n):
    return (23.439 - 0.0000004 * n) * D2R


def _ecl_to_eq(lon, lat, eps):
    ra = math.atan2(math.sin(lon) * math.cos(eps) - math.tan(lat) * math.sin(eps), math.cos(lon))
    dec = math.asin(math.sin(lat) * math.cos(eps) + math.cos(lat) * math.sin(eps) * math.sin(lon))
    return (ra * R2D) % 360.0, dec * R2D


def sun_position(jd):
    """Low-precision solar ecliptic longitude (rad) and RA/Dec (deg)."""
    n = jd - 2451545.0
    L = (280.460 + 0.9856474 * n) % 360.0
    g = ((357.528 + 0.9856003 * n) % 360.0) * D2R
    lam = (L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) * D2R
    ra, dec = _ecl_to_eq(lam, 0.0, _obliquity(n))
    return lam, ra, dec


def moon_position(jd):
    """Low-precision lunar position (~0.3 deg). Returns (lambda_rad, ra, dec)."""
    t = (jd - 2451545.0) / 36525.0
    Lp = 218.316 + 481267.881 * t
    D = (297.850 + 445267.112 * t) * D2R
    M = (357.529 + 35999.050 * t) * D2R
    Mp = (134.963 + 477198.868 * t) * D2R
    F = (93.272 + 483202.018 * t) * D2R
    lon = (Lp + 6.289 * math.sin(Mp) + 1.274 * math.sin(2 * D - Mp)
           + 0.658 * math.sin(2 * D) + 0.214 * math.sin(2 * Mp)
           - 0.186 * math.sin(M) - 0.114 * math.sin(2 * F)) * D2R
    lat = (5.128 * math.sin(F) + 0.281 * math.sin(Mp + F)
           + 0.278 * math.sin(Mp - F) + 0.173 * math.sin(2 * D - F)) * D2R
    ra, dec = _ecl_to_eq(lon, lat, _obliquity(jd - 2451545.0))
    return lon, ra, dec


def moon_phase(jd):
    sun_lam, _, _ = sun_position(jd)
    moon_lam, _, _ = moon_position(jd)
    elong = (moon_lam - sun_lam) % (2 * math.pi)
    illum = (1 - math.cos(elong)) / 2.0
    deg = elong * R2D
    names = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
             "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"]
    name = names[int(((deg + 22.5) % 360) // 45)]
    return illum, deg, name



# ------------------------------------------------------------------ planets
# JPL "Keplerian Elements for Approximate Positions of the Major Planets"
# (E.M. Standish), Table 1, valid 1800-2050. Per planet:
#   (a, e, I, L, long.peri, long.node) at J2000 and their rates per Julian century.
PLANET_ELEMENTS = {
    "Mercury": ((0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593),
                (0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081)),
    "Venus":   ((0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255),
                (0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418)),
    "Earth":   ((1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0),
                (0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0)),
    "Mars":    ((1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891),
                (0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343)),
    "Jupiter": ((5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909),
                (-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106)),
    "Saturn":  ((9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448),
                (-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794)),
    "Uranus":  ((19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503),
                (-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589)),
    "Neptune": ((30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574),
                (0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664)),
}
PLANET_COLORS = {"Mercury": "#c9b9a6", "Venus": "#fff1c4", "Mars": "#ff8a5c", "Jupiter": "#f3d9a8",
                 "Saturn": "#e9cf8a", "Uranus": "#a8e6ee", "Neptune": "#7fa3ff"}


def _helio_ecliptic(name, T):
    """Heliocentric J2000 ecliptic xyz (AU) at T Julian centuries from J2000."""
    el, rate = PLANET_ELEMENTS[name]
    a, e, inc, L, varpi, node = (v + r * T for v, r in zip(el, rate))
    M = ((L - varpi + 180) % 360 - 180) * D2R
    E = M + e * math.sin(M)
    for _ in range(8):  # Kepler's equation, Newton iterations
        E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
    xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
    w, O, i = (varpi - node) * D2R, node * D2R, inc * D2R
    cw, sw, cO, sO, ci, si = math.cos(w), math.sin(w), math.cos(O), math.sin(O), math.cos(i), math.sin(i)
    x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp
    y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp
    z = (sw * si) * xp + (cw * si) * yp
    return x, y, z


def _planet_mag(name, r, delta, i):
    """Visual magnitude (Explanatory Supplement 1992) from distances (AU) and phase angle (deg)."""
    base = 5 * math.log10(r * delta)
    if name == "Mercury":
        return base - 0.42 + 0.038 * i - 0.000273 * i ** 2 + 0.000002 * i ** 3
    if name == "Venus":
        return base - 4.40 + 0.0009 * i + 0.000239 * i ** 2 - 0.00000065 * i ** 3
    if name == "Mars":
        return base - 1.52 + 0.016 * i
    if name == "Jupiter":
        return base - 9.40 + 0.005 * i
    if name == "Saturn":
        return base - 8.88 + 0.044 * i
    if name == "Uranus":
        return base - 7.19
    return base - 6.87  # Neptune


def planet_positions(jd):
    """Geocentric RA/Dec (deg), magnitude, distance and phase for the 7 planets."""
    T = (jd - 2451545.0) / 36525.0
    ex, ey, ez = _helio_ecliptic("Earth", T)
    eps = 23.43928 * D2R
    out = []
    for name in PLANET_COLORS:
        px, py, pz = _helio_ecliptic(name, T)
        dx, dy, dz = px - ex, py - ey, pz - ez
        r, R, delta = math.sqrt(px * px + py * py + pz * pz), math.sqrt(ex * ex + ey * ey + ez * ez), \
            math.sqrt(dx * dx + dy * dy + dz * dz)
        cos_i = max(-1.0, min(1.0, (r * r + delta * delta - R * R) / (2 * r * delta)))
        phase_angle = math.acos(cos_i) * R2D
        # ecliptic -> equatorial (J2000)
        xq, yq, zq = dx, dy * math.cos(eps) - dz * math.sin(eps), dy * math.sin(eps) + dz * math.cos(eps)
        ra = math.atan2(yq, xq) * R2D % 360.0
        dec = math.asin(zq / delta) * R2D
        out.append({"name": name, "ra": ra, "dec": dec, "dist_au": delta,
                    "mag": _planet_mag(name, r, delta, phase_angle),
                    "illum": (1 + cos_i) / 2, "color": PLANET_COLORS[name]})
    return out


def _sep(ra1, dec1, ra2, dec2):
    a = (math.sin(dec1 * D2R) * math.sin(dec2 * D2R)
         + math.cos(dec1 * D2R) * math.cos(dec2 * D2R) * math.cos((ra1 - ra2) * D2R))
    return math.acos(max(-1.0, min(1.0, a))) * R2D

# ----------------------------------------------------------- sky brightness

def _interp(x, pts):
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


TWILIGHT_LIMIT = [(-18, 8.0), (-15, 6.5), (-12, 5.0), (-9, 3.8),
                  (-6, 2.2), (-3, 0.8), (0, -1.5), (5, -3.0)]


def twilight_phase(sun_alt):
    if sun_alt > -0.833:
        return "Daytime"
    if sun_alt > -6:
        return "Civil twilight"
    if sun_alt > -12:
        return "Nautical twilight"
    if sun_alt > -18:
        return "Astronomical twilight"
    return "Astronomical night"


def limiting_magnitude(bortle, sun_alt, moon_alt, moon_illum):
    lim = BORTLE_NELM[bortle]
    lim = min(lim, _interp(sun_alt, TWILIGHT_LIMIT))
    if moon_alt > 0:
        # a bright moon washes out the sky; stronger when it is high
        lim -= 1.4 * moon_illum * min(1.0, (moon_alt + 5) / 35.0)
    return round(lim, 2)


# ---------------------------------------------------------------- the sky

def compute_sky(lat, lon, when: datetime, bortle: int):
    bortle = max(1, min(9, int(bortle)))
    cat = catalog()
    jd = julian_date(when)
    lst = lst_deg(jd, lon)

    _, sra, sdec = sun_position(jd)
    sun_alt, sun_az = radec_to_altaz(sra, sdec, lat, lst)
    _, mra, mdec = moon_position(jd)
    moon_alt, moon_az = radec_to_altaz(mra, mdec, lat, lst)
    illum, elong, phase_name = moon_phase(jd)

    lim = limiting_magnitude(bortle, sun_alt, moon_alt, illum)
    k_ext = 0.20 + 0.015 * (bortle - 1)  # extinction coefficient (mag/airmass)

    def eff_mag(mag, alt):
        return mag + k_ext * (airmass(alt) - 1.0)

    stars_out = []
    star_vis = {}
    for s in cat["stars"]:
        alt, az = radec_to_altaz(s["ra"], s["dec"], lat, lst)
        if alt < -1.0:
            continue
        vis = alt > 0 and eff_mag(s["mag"], alt) <= lim
        star_vis[s["hip"]] = vis
        stars_out.append({
            "hip": s["hip"], "alt": round(alt, 3), "az": round(az, 3),
            "mag": s["mag"], "bv": s["bv"], "name": s["name"],
            "bayer": s["bayer"], "con": s["con"], "vis": vis,
        })

    planets_out = []
    for p in planet_positions(jd):
        alt, az = radec_to_altaz(p["ra"], p["dec"], lat, lst)
        elong_sun = _sep(p["ra"], p["dec"], sra, sdec)
        vis = alt > 0 and eff_mag(p["mag"], alt) <= lim
        planets_out.append({
            "id": p["name"].lower(), "name": p["name"], "alt": round(alt, 3), "az": round(az, 3),
            "mag": round(p["mag"], 2), "dist_au": round(p["dist_au"], 3), "illum": round(p["illum"], 3),
            "elong": round(elong_sun, 1), "color": p["color"], "vis": vis,
        })

    dsos_out = []
    for d in cat.get("dsos", []):
        alt, az = radec_to_altaz(d["ra"], d["dec"], lat, lst)
        if alt < -1.0:
            continue
        # diffuse light is harder to see than a star of equal magnitude
        size_pen = max(0.0, math.log10(max(d["size"], 1) / 8.0))
        m_eff = eff_mag(d["mag"], alt) + size_pen if alt > 0 else 99
        if m_eff <= lim:
            how = "naked-eye"
        elif m_eff <= lim + 3.0:
            how = "binoculars"
        else:
            how = "telescope"
        dsos_out.append({
            "id": d["id"], "name": d["name"], "desig": d["desig"], "kind": d["kind"], "group": d["group"],
            "con": d["con"], "mag": d["mag"], "size": d["size"], "size2": d["size2"],
            "alt": round(alt, 3), "az": round(az, 3), "how": how, "vis": how == "naked-eye",
        })

    cons_out = []
    for c in cat["constellations"]:
        lines = []
        n_pts = n_up = 0
        for seg in c["lines"]:
            pts = []
            for ra, dec, _mag in seg:
                alt, az = radec_to_altaz(ra, dec, lat, lst)
                n_pts += 1
                n_up += alt > 0
                pts.append([round(alt, 3), round(az, 3)])
            lines.append(pts)
        members = c["members"]
        n_vis = sum(1 for h in members if star_vis.get(h))
        frac_up = n_up / n_pts if n_pts else 0.0
        frac_vis = n_vis / len(members) if members else 0.0
        if frac_up >= 0.8 and frac_vis >= 0.6:
            status = "visible"
        elif n_vis >= min(2, len(members)) and n_vis > 0:
            status = "partial"
        elif frac_up > 0:
            status = "faint" if n_up else "below"
        else:
            status = "below"
        calt, caz = radec_to_altaz(c["ra"], c["dec"], lat, lst)
        cons_out.append({
            "id": c["id"], "name": c["name"], "gen": c["gen"], "rank": c["rank"],
            "alt": round(calt, 2), "az": round(caz, 2),
            "lines": lines, "members": members,
            "n_members": len(members), "n_visible": n_vis,
            "frac_up": round(frac_up, 2), "status": status,
        })

    return {
        "input": {"lat": lat, "lon": lon, "utc": when.astimezone(timezone.utc).isoformat(),
                  "bortle": bortle, "bortle_label": BORTLE_LABEL[bortle]},
        "lst_hours": round(lst / 15.0, 4),
        "limit_mag": lim,
        "zenith_nelm": BORTLE_NELM[bortle],
        "sun": {"alt": round(sun_alt, 2), "az": round(sun_az, 2),
                "phase": twilight_phase(sun_alt)},
        "moon": {"alt": round(moon_alt, 2), "az": round(moon_az, 2),
                 "illum": round(illum, 3), "elong": round(elong, 1), "phase": phase_name},
        "stars": stars_out,
        "planets": planets_out,
        "dsos": dsos_out,
        "constellations": cons_out,
        "counts": {
            "stars_visible": sum(1 for s in stars_out if s["vis"]),
            "constellations_visible": sum(1 for c in cons_out if c["status"] == "visible"),
            "constellations_partial": sum(1 for c in cons_out if c["status"] == "partial"),
            "planets_visible": sum(1 for p in planets_out if p["vis"]),
            "dsos_visible": sum(1 for d in dsos_out if d["vis"]),
            "dsos_binocular": sum(1 for d in dsos_out if d["how"] == "binoculars"),
        },
    }
