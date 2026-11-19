# Skylog — offline night sky observation logger

Plan and log naked-eye observing sessions. Pick a location, date/time and
light-pollution level, see which constellations and stars are visible on an
interactive sky dome, log what you saw, and save it to a file. It runs entirely
on your machine with no internet and no third-party Python packages.

## Download (Linux)

Grab **`Skylog-linux-x86_64`** from the [latest release](../../releases/latest), then:

```bash
chmod +x Skylog-linux-x86_64
./Skylog-linux-x86_64        # or double-click it in your file manager
```

It's a single self-contained file. You don't need Python or anything else installed.

## Build the double-click app yourself

```bash
python3 build.py     # one-time: builds dist/Skylog (needs internet once, to fetch PyInstaller)
./install.sh         # optional: adds Skylog to the app menu (--desktop also adds a Desktop icon)
```

* **`dist/Skylog`** is one self-contained file (~26 MB) with Python, the catalog and the UI inside. Double-click it, or copy it to any Linux machine; nothing needs to be installed there.
* It opens in your default browser. **Close the tab to quit**, and the app exits by itself about 12 s later. If the browser dies without closing the tab cleanly, the app still exits within about 2.5 minutes. Launching it again while it's running just opens another tab.
* Observations go to **`~/Documents/Skylog/`** (`observations.json` + `exports/`). Set the `SKYLOG_DATA` environment variable to use another folder.
* Uninstall the launcher with `./install.sh --uninstall`. Your observations are kept.
* Windows/macOS: run `python build.py` on that OS to get `dist/Skylog.exe` / `dist/Skylog.app`. PyInstaller can't cross-compile.

## Run from source

```bash
python3 run.py              # opens http://127.0.0.1:8765 in your browser
python3 run.py --port 9000 --no-browser
```

You only need Python 3.9 or newer, and the standard library is enough. From source, observations are saved in `./observations/` and the server keeps running until you press Ctrl+C.

## Features

| Requirement | How it works |
|---|---|
| **Inputs** | City presets (offline list), manual lat/lon or device location; a night-of date, UTC offset and a 12:00→12:00 time scrubber (▶ animates it); a Bortle 1–9 light-pollution slider |
| **What's visible** | Each star's altitude and azimuth come from the J2000 catalog and local sidereal time. Its magnitude after atmospheric extinction is compared against a limiting magnitude, which depends on Bortle class, twilight (Sun altitude) and moonlight. A constellation counts as *visible* when ≥80 % of its figure is above the horizon and ≥60 % of its pattern stars can be seen; otherwise it is *partial*, *faint* or below the horizon |
| **Planets** | Mercury to Neptune, plus the Moon and its phase. Positions come from JPL's approximate Keplerian elements (valid 1800–2050), within 0.1° of the DE421 ephemeris over 2024–2045. Magnitudes depend on phase and distance |
| **Deep-sky objects** | 132 clusters, nebulae and galaxies: all 110 Messier objects plus the bright non-Messier ones (Hyades, both Magellanic Clouds, Omega Centauri, 47 Tucanae, Carina Nebula, Double Cluster, Coathanger, Jewel Box and others). Each is rated **naked eye**, **binoculars** or **telescope** for your sky: its brightness after atmospheric extinction plus a size penalty (diffuse light is harder to see) is compared against the limiting magnitude |
| **Visualization** | An all-sky stereographic dome (zenith in the centre, N at top, E on the left) with star colour from B−V, constellation figures and names, star names, an alt/az grid, a compass, and the Sun and Moon with the Moon's phase. Every layer has a toggle and an opacity slider. Scroll to zoom, drag to pan, hover for details, click to log |
| **Logging** | Click an object on the sky or use **+** in the *Visible* list. Each night/site gets its own session with per-item notes, a session note, and seeing and transparency ratings. The log is grouped into planets, deep-sky objects, constellations and stars. **Mark logged objects** shows or hides the gold marks on the map; the log itself is not affected. **Highlight logged only** (or press `h`) dims everything you haven't logged |
| **Save to file** | Changes autosave to `observations/observations.json`. **Export** downloads JSON, CSV or Markdown and also keeps a copy in `observations/exports/` |
| **Sky image** | The camera button (or *Export → Sky image*) downloads an HD JPG (2200 px tall; its width follows the shape of what you logged) of the sky at the time on the slider. The image is rendered off-screen, not screenshotted, and zoomed as far as possible (up to 12×) while keeping all your logged objects and their labels in frame. A whole-sky inset shows the zoomed area. Labels avoid each other, star dots, symbols and constellation lines. Your logged objects are highlighted, and a side panel lists what you saw, grouped and timed. A copy goes to `exports/` |
| **Stats** | Set your observing hours (or let them default to your first and last log entries). The tab then shows: how much of the celestial sphere rose above your horizon (and above 20°) in that window, compared with the most your latitude allows; logged vs. available naked-eye objects for planets, deep-sky objects, constellations and bright stars, with what you missed; a coverage map; and **light pollution by hour, inferred from what you saw** |
| **Checklist** | The 140 brightest objects in the sky: the Moon, the planets, the 100 brightest stars, and deep-sky objects of magnitude ≤ 5. An object is ticked once you've logged it in any session, with the date you first saw it. Filter by type, *To find*, *Seen* or *Up now*, and log straight from the list |

### How the light-pollution estimate works

Each logged object is re-checked at its logged time against every Bortle class 1–9. The check accounts for its altitude (extinction), its size (diffuse objects are harder to see), twilight and moonlight. A constellation counts as seen when about half of its pattern stars are visible. The highest Bortle class that still lets you see an object is an *upper bound*: your sky was at least that dark. Each hour uses its most demanding object. If everything logged in an hour (Jupiter, Sirius, the Pleiades…) is visible under any sky, that hour tells us nothing, so it keeps your configured value.

Each hour lists every logged object as **catalogue magnitude → effective magnitude** (after haze at its altitude, plus the size penalty for deep-sky objects; for a constellation, this is the faintest of the pattern stars needed). It also shows the brightest sky that object allows. Below that is a **threshold strip** with the limiting magnitude for each of Bortle 1–9 at that moment, with twilight and moonlight included. Classes that would have hidden the hour's most demanding object are crossed out.

Keyboard: `←`/`→` move the time by 15 min, `h` toggles the highlight, and `Esc` closes the popover.

## Layout

```
run.py                  entry point: single-instance check, opens browser, auto-exit
build.py / install.sh   packaging (PyInstaller) and Linux menu/desktop launcher
assets/skylog.png       app icon (tools/make_icon.py)
skylogger/paths.py      bundled-resource and data-folder resolution
skylogger/astro.py      astronomy: sidereal time, alt/az, Sun/Moon, limiting magnitude
skylogger/server.py     JSON API + static files + observation persistence
static/                 UI (vanilla HTML/CSS/JS, no CDNs; Lato font bundled in static/fonts, OFL)
data/catalog.json       5,044 stars (mag ≤ 6.5), 89 constellation figures, 132 deep-sky objects
data/raw/               source data — d3-celestial (BSD-3, github.com/ofrohn/d3-celestial)
tools/build_catalog.py  regenerates data/catalog.json from data/raw/
tests/                  python3 -m unittest discover tests
```

## Accuracy notes

* Positions are good to about 0.5°, which is plenty for visual planning. Precession from J2000 is ignored.
* City presets use *standard* UTC offsets. During daylight saving time, add 1 to the UTC offset by hand.
* Limiting magnitude is an empirical model (Bortle class → zenith NELM, plus twilight, moonlight and extinction). Treat it as a guide; real conditions vary.

## Credits

* Star, constellation and deep-sky data: [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn, BSD-3-Clause ([`data/raw/LICENSE-d3-celestial.txt`](data/raw/LICENSE-d3-celestial.txt)). It is derived from the Hipparcos catalogue, IAU constellation lines, and the Messier and NGC catalogues.
* Planet orbital elements: E. M. Standish, *Keplerian Elements for Approximate Positions of the Major Planets* (JPL).
* Font: [Lato](https://www.latofonts.com/) by Łukasz Dziedzic, SIL Open Font License ([`static/fonts/OFL.txt`](static/fonts/OFL.txt)).
