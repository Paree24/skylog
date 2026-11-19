"""Offline HTTP server: serves the web UI and a small JSON API.

Uses only the Python standard library.
"""
import csv
import io
import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .astro import compute_sky, BORTLE_LABEL, BORTLE_NELM
from .stats import session_stats
from .checklist import checklist

from .paths import STATIC, OBS_DIR, LOG_FILE, PLACES_FILE, SETTINGS_FILE
_lock = threading.Lock()
APP_ID = "skylog"


class Presence:
    """Tracks open browser tabs via heartbeats so the app can exit when closed."""
    TAB_TIMEOUT = 150.0   # background tabs may only tick once a minute

    def __init__(self):
        self.tabs = {}         # tab id -> monotonic time of last ping
        self.ever = False
        self.empty_since = time.monotonic()
        self.lock = threading.Lock()

    def ping(self, tab):
        with self.lock:
            self.tabs[tab] = time.monotonic()
            self.ever, self.empty_since = True, None

    def bye(self, tab):
        with self.lock:
            self.tabs.pop(tab, None)
            self._check_empty()

    def _check_empty(self):
        now = time.monotonic()
        for t, seen in list(self.tabs.items()):
            if now - seen > self.TAB_TIMEOUT:
                del self.tabs[t]
        if not self.tabs and self.empty_since is None:
            self.empty_since = now

    def idle_for(self):
        """Seconds since the last tab went away (0 while a tab is open)."""
        with self.lock:
            self._check_empty()
            return 0.0 if self.tabs else time.monotonic() - self.empty_since


presence = Presence()


# ------------------------------------------------------------ persistence

def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path, data):
    OBS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def clean_place(p):
    """Validate a saved place {name, lat, lon, tz, bortle?}."""
    name = str(p.get("name", "")).strip()[:80]
    lat, lon, tz = float(p["lat"]), float(p["lon"]), float(p.get("tz", 0))
    if not name or not (-90 <= lat <= 90) or not (-180 <= lon <= 180) or not (-12 <= tz <= 14):
        raise ValueError("place needs a name, lat -90..90, lon -180..180, tz -12..14")
    out = {"name": name, "lat": round(lat, 5), "lon": round(lon, 5), "tz": tz}
    if p.get("bortle") is not None:
        out["bortle"] = max(1, min(9, int(p["bortle"])))
    return out


def load_log():
    if not LOG_FILE.exists():
        return []
    try:
        return json.loads(LOG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def save_log(sessions):
    OBS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LOG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(sessions, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(LOG_FILE)


def slug(text):
    return re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-")[:40] or "session"


def session_filename(sess, ext):
    return f"{sess.get('date', 'undated')}_{slug(sess.get('place'))}.{ext}"


def export_session(sess, fmt):
    if fmt == "json":
        return json.dumps(sess, indent=2, ensure_ascii=False), "application/json"
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["date", "place", "lat", "lon", "bortle", "kind", "id", "name",
                    "time", "alt", "az", "notes"])
        for it in sess.get("items", []):
            w.writerow([sess.get("date"), sess.get("place"), sess.get("lat"), sess.get("lon"),
                        sess.get("bortle"), it.get("kind"), it.get("ref"), it.get("name"),
                        it.get("time"), it.get("alt"), it.get("az"), it.get("notes", "")])
        return buf.getvalue(), "text/csv"
    # markdown
    lines = [f"# Sky observation — {sess.get('date')}", "",
             f"- **Location:** {sess.get('place') or '—'} ({sess.get('lat')}, {sess.get('lon')})",
             f"- **Sky:** Bortle {sess.get('bortle')} · limiting mag {sess.get('limit_mag')}",
             f"- **Seeing:** {sess.get('seeing') or '—'} / 5 · "
             f"**Transparency:** {sess.get('transparency') or '—'} / 5", ""]
    if sess.get("notes"):
        lines += ["## Notes", "", sess["notes"], ""]
    lines += ["## Observed", "", "| Time | Type | Object | Alt | Az | Notes |",
              "|---|---|---|---|---|---|"]
    for it in sess.get("items", []):
        lines.append(f"| {it.get('time', '')} | {it.get('kind')} | {it.get('name')} | "
                     f"{it.get('alt', '')}° | {it.get('az', '')}° | "
                     f"{(it.get('notes') or '').replace('|', '/')} |")
    return "\n".join(lines) + "\n", "text/markdown"


# ---------------------------------------------------------------- handler

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # -- helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # -- routes
    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/sky":
                when = datetime.fromisoformat(q["utc"].replace("Z", "+00:00"))
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
                return self._json(compute_sky(float(q["lat"]), float(q["lon"]), when,
                                              int(q.get("bortle", 4))))
            if url.path == "/api/ping":
                if q.get("tab") and q["tab"] != "probe":   # probes from a 2nd launch don't count
                    presence.ping(q["tab"])
                return self._json({"app": APP_ID, "data_dir": str(OBS_DIR), "log_file": str(LOG_FILE)})
            if url.path == "/api/checklist":
                return self._json(checklist())
            if url.path == "/api/places":
                return self._json(read_json(PLACES_FILE, []))
            if url.path == "/api/settings":
                return self._json(read_json(SETTINGS_FILE, {}))
            if url.path == "/api/bortle":
                return self._json({b: {"label": BORTLE_LABEL[b], "nelm": BORTLE_NELM[b]}
                                   for b in BORTLE_LABEL})
            if url.path == "/api/observations":
                return self._json(load_log())
            m = re.fullmatch(r"/api/observations/([\w-]+)/export", url.path)
            if m:
                sess = next((s for s in load_log() if s["id"] == m.group(1)), None)
                if not sess:
                    return self._json({"error": "not found"}, 404)
                fmt = q.get("fmt", "json")
                ext = {"json": "json", "csv": "csv"}.get(fmt, "md")
                text, ctype = export_session(sess, fmt)
                # also keep a copy on disk next to the log
                exp_dir = OBS_DIR / "exports"
                exp_dir.mkdir(parents=True, exist_ok=True)
                fname = session_filename(sess, ext)
                (exp_dir / fname).write_text(text, encoding="utf-8")
                body = text.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", f"{ctype}; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        except (KeyError, ValueError) as e:
            return self._json({"error": f"bad request: {e}"}, 400)
        if url.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/bye":
            presence.bye(parse_qs(url.query).get("tab", [None])[0])
            return self._json({"ok": True})
        if url.path == "/api/export-image":
            name = parse_qs(url.query).get("name", ["skylog.png"])[0]
            name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")[:100] or "skylog.jpg"
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 40 * 1024 * 1024:
                return self._json({"error": "bad image size"}, 400)
            data = self.rfile.read(n)
            if data.startswith(b"\xff\xd8\xff"):
                ext = ".jpg"
            elif data.startswith(b"\x89PNG"):
                ext = ".png"
            else:
                return self._json({"error": "not a JPEG or PNG"}, 400)
            if not name.lower().endswith(ext):
                name = name.rsplit(".", 1)[0] + ext
            exp_dir = OBS_DIR / "exports"
            exp_dir.mkdir(parents=True, exist_ok=True)
            (exp_dir / name).write_bytes(data)
            return self._json({"ok": True, "path": str(exp_dir / name)})
        if url.path == "/api/places":
            try:
                place = clean_place(self._body())
            except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
                return self._json({"error": str(e)}, 400)
            with _lock:
                places = [p for p in read_json(PLACES_FILE, []) if p["name"].lower() != place["name"].lower()]
                places.append(place)
                places.sort(key=lambda p: p["name"].lower())
                write_json(PLACES_FILE, places)
            return self._json(places)
        if url.path == "/api/stats":
            try:
                return self._json(session_stats(self._body()))
            except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
                return self._json({"error": f"bad session: {e}"}, 400)
        if url.path == "/api/settings":
            try:
                body = self._body()
            except json.JSONDecodeError:
                return self._json({"error": "invalid json"}, 400)
            with _lock:
                settings = read_json(SETTINGS_FILE, {})
                settings.update(body if isinstance(body, dict) else {})
                write_json(SETTINGS_FILE, settings)
            return self._json(settings)
        if url.path != "/api/observations":
            return self._json({"error": "not found"}, 404)
        try:
            sess = self._body()
        except json.JSONDecodeError:
            return self._json({"error": "invalid json"}, 400)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with _lock:
            log = load_log()
            sess.setdefault("id", uuid.uuid4().hex[:12])
            sess.setdefault("created", now)
            sess["updated"] = now
            log = [s for s in log if s["id"] != sess["id"]] + [sess]
            log.sort(key=lambda s: (s.get("date", ""), s.get("created", "")), reverse=True)
            save_log(log)
        return self._json(sess)

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path == "/api/places":
            name = parse_qs(url.query).get("name", [""])[0].lower()
            with _lock:
                places = [p for p in read_json(PLACES_FILE, []) if p["name"].lower() != name]
                write_json(PLACES_FILE, places)
            return self._json(places)
        m = re.fullmatch(r"/api/observations/([\w-]+)", url.path)
        if not m:
            return self._json({"error": "not found"}, 404)
        with _lock:
            log = load_log()
            save_log([s for s in log if s["id"] != m.group(1)])
        return self._json({"ok": True})


def serve(host="127.0.0.1", port=8765):
    httpd = ThreadingHTTPServer((host, port), Handler)
    return httpd
