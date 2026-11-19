#!/usr/bin/env python3
"""Start the Skylog night sky observation logger (fully offline).

Double-click the packaged app, or:  python run.py [--port 8765] [--no-browser] [--keep-running]

* If Skylog is already running it just opens a new browser tab.
* When launched as a packaged app it exits by itself shortly after the last
  browser tab is closed (use --keep-running to disable).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

from skylogger.paths import FROZEN, LOG_FILE
from skylogger.server import serve, presence, APP_ID

DEFAULT_PORT = 8765
CLOSE_GRACE = 12.0        # seconds without any open tab before exiting
NEVER_CONNECTED = 300.0   # give up if no browser ever connects


def say(msg):
    try:
        print(msg, flush=True)
    except (OSError, AttributeError, ValueError):  # no console (windowed app)
        pass


def existing_instance(host, port):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/ping?tab=probe", timeout=1) as r:
            return json.load(r).get("app") == APP_ID
    except (OSError, ValueError):
        return False


def open_browser(url):
    """Open the default browser without leaking PyInstaller's bundled lib paths."""
    if sys.platform.startswith("linux"):
        env = dict(os.environ)
        for var in ("LD_LIBRARY_PATH", "LD_PRELOAD"):
            orig = env.pop(var + "_ORIG", None)
            if orig is not None:
                env[var] = orig
            elif FROZEN:
                env.pop(var, None)
        opener = shutil.which("xdg-open")
        if opener:
            try:
                subprocess.Popen([opener, url], env=env, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
                return
            except OSError:
                pass
    webbrowser.open(url)


def watchdog(httpd):
    start = time.monotonic()
    while True:
        time.sleep(2)
        if not presence.ever:
            if time.monotonic() - start > NEVER_CONNECTED:
                break
            continue
        if presence.idle_for() > CLOSE_GRACE:
            break
    say("No open Skylog tabs — shutting down.")
    httpd.shutdown()


def main():
    ap = argparse.ArgumentParser(description="Offline night sky observation logger")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--keep-running", action="store_true",
                    help="don't exit when the browser tab is closed")
    args = ap.parse_args()

    if existing_instance(args.host, args.port):
        say("Skylog is already running — opening it.")
        if not args.no_browser:
            open_browser(f"http://{args.host}:{args.port}/")
        return

    try:
        httpd = serve(args.host, args.port)
    except OSError:                    # port taken by something else
        httpd = serve(args.host, 0)
    port = httpd.server_address[1]
    url = f"http://{args.host}:{port}/"

    say(f"✦ Skylog running at {url}")
    say(f"  Observations are saved to {LOG_FILE}")
    say("  Press Ctrl+C to stop." if not FROZEN else "  Close the browser tab to quit.")

    auto_exit = FROZEN and not args.keep_running and not args.no_browser
    if auto_exit:
        threading.Thread(target=watchdog, args=(httpd,), daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.4, open_browser, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        say("\nbye")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
