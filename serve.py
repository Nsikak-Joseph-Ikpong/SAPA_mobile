"""Run the cheese variance checker on this computer: python serve.py (or Run 'serve' in PyCharm).

Serves the page in web/ at http://localhost:8000 and opens it in the browser. Only this computer can
reach it (it listens on 127.0.0.1). The files you load stay in the browser; nothing is uploaded.
Stop it with Ctrl+C (or the red Stop button in PyCharm).

Phone access on the office network: python serve.py --share
  Also listens on the network, so a phone on the same Wi-Fi can open http://<this computer's address>:8000.
  The phone has to log in with a password (asked for the first time, kept hashed in .checker_login.json next
  to this file; change it with --set-password). The checker page open on THIS computer does the checking: the
  phone sends a job number, this computer's page works it out from the SAP files loaded there and sends back
  only the result. The SAP files never go to the phone. Keep this computer on, with the page open and the files
  loaded. Plain http on the local network only; nothing is reachable from the internet.

Options: --port 8080 to use another port, --no-browser to not open the browser.
"""
from __future__ import annotations

import argparse
import collections
import functools
import getpass
import hashlib
import hmac
import html
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
LOGIN_FILE = ROOT / ".checker_login.json"
SESSION_HOURS = 12
MAX_FAILS, LOCK_MINUTES = 5, 10

# web/index.html has no document skeleton (the Claude artifact and the Pages build add one): add it here
HEAD = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n')


# ---------------------------------------------------------------- password and sessions
def hash_password(pw: str, salt: bytes | None = None) -> dict:
    salt = salt or secrets.token_bytes(16)
    return {"salt": salt.hex(), "iterations": 300_000,
            "hash": hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 300_000).hex()}


def check_password(pw: str, stored: dict) -> bool:
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(stored["salt"]), int(stored["iterations"]))
    return hmac.compare_digest(h.hex(), stored["hash"])


def read_secret(prompt: str) -> str:
    """Hidden typing in a real terminal. PyCharm's Run window isn't one (hidden typing never reaches the program
    there and it seems to hang), so there the password is typed visibly."""
    if os.environ.get("PYCHARM_HOSTED") or not sys.stdin.isatty():
        return input(prompt)
    return getpass.getpass(prompt)


def ask_new_password() -> dict:
    print("Choose the password the phone will use to log in (at least 8 characters).")
    if os.environ.get("PYCHARM_HOSTED") or not sys.stdin.isatty():
        print("(In this window the password shows as you type; clear the window afterwards if anyone can see it.)")
    else:
        print("(Nothing shows while you type the password: that's normal. Press Enter when done.)")
    while True:
        pw = read_secret("New password: ").strip()
        if len(pw) < 8:
            print("Too short; at least 8 characters.")
            continue
        if read_secret("Type it again: ").strip() != pw:
            print("They don't match; try again.")
            continue
        stored = hash_password(pw)
        LOGIN_FILE.write_text(json.dumps(stored), encoding="utf-8")
        print(f"Password saved (hashed) in {LOGIN_FILE.name}.")
        return stored


class Sessions:
    def __init__(self):
        self.lock = threading.Lock()
        self.tokens: dict[str, float] = {}
        self.fails: dict[str, collections.deque] = collections.defaultdict(collections.deque)

    def new(self) -> str:
        t = secrets.token_urlsafe(32)
        with self.lock:
            self.tokens[t] = time.time() + SESSION_HOURS * 3600
        return t

    def valid(self, t: str | None) -> bool:
        with self.lock:
            exp = self.tokens.get(t or "")
            if exp and exp > time.time():
                return True
            self.tokens.pop(t or "", None)
            return False

    def end(self, t: str | None):
        with self.lock:
            self.tokens.pop(t or "", None)

    def locked(self, ip: str) -> bool:
        with self.lock:
            q = self.fails[ip]
            while q and q[0] < time.time() - LOCK_MINUTES * 60:
                q.popleft()
            return len(q) >= MAX_FAILS

    def failed(self, ip: str):
        with self.lock:
            self.fails[ip].append(time.time())


# ---------------------------------------------------------------- phone <-> laptop page relay
class Relay:
    """The phone's questions wait here until the checker page on this computer picks them up, works them out
    and posts the answer back."""

    def __init__(self):
        self.cv = threading.Condition()
        self.jobs: collections.deque = collections.deque()
        self.answers: dict[str, dict] = {}
        self.seen = 0.0     # when the page on this computer last asked for work

    def online(self) -> bool:
        return time.time() - self.seen < 40

    def ask(self, kind: str, args: dict, timeout: float = 60, pickup: float = 30) -> dict | None:
        jid = secrets.token_hex(8)
        with self.cv:
            self.jobs.append({"id": jid, "kind": kind, "args": args})
            self.cv.notify_all()
            start, end = time.time(), time.time() + timeout
            while jid not in self.answers and time.time() < end:
                # nobody picked it up (the page on this computer was closed): give up early
                if time.time() - start > pickup and any(j["id"] == jid for j in self.jobs):
                    break
                self.cv.wait(min(1.0, end - time.time()))
            ans = self.answers.pop(jid, None)
            if ans is None:     # not picked up in time: drop it so it isn't worked out for nobody
                self.jobs = collections.deque(j for j in self.jobs if j["id"] != jid)
            return ans

    def next(self, timeout: float = 25) -> dict | None:
        self.seen = time.time()
        with self.cv:
            end = time.time() + timeout
            while not self.jobs and time.time() < end:
                self.cv.wait(end - time.time())
            return self.jobs.popleft() if self.jobs else None

    def answer(self, jid: str, result: dict):
        with self.cv:
            self.seen = time.time()
            self.answers[jid] = result
            self.cv.notify_all()


LOGIN_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Cheese Variance Check</title>
<style>
:root { --ground: #f2f4f1; --surface: #fff; --ink: #17201d; --muted: #5b6661; --line: #d8ddd9; --accent: #23615a; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --ground: #111513; --surface: #192019; --ink: #e5eae7; --muted: #9aa59f; --line: #2c3531; --accent: #5fb3a8; --bad: #f27b70; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--ground); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
form { width: min(100% - 32px, 360px); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 24px; display: grid; gap: 12px; }
h1 { margin: 0; font-size: 20px; } p { margin: 0; color: var(--muted); font-size: 13px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--ground); color: var(--ink); }
button { font: inherit; font-weight: 600; padding: 10px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
.err { color: var(--bad); font-size: 13px; }
</style></head><body>
<form method="post" action="/login">
<h1>Cheese Variance Check</h1><p>Log in to use the checker running on the office computer.</p>
__ERROR__
<label>User<input name="username" autocomplete="username" value="checker" readonly></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Log in</button>
<p>Your phone can save this password and fill it in with Face ID or your fingerprint next time.</p>
</form></body></html>"""


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8"}

    def __init__(self, *a, app=None, **k):
        self.app = app
        super().__init__(*a, **k)

    # ---- helpers
    @property
    def local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    def cookie(self) -> str | None:
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "checker_session":
                return v
        return None

    def authed(self) -> bool:
        return self.local or self.app["sessions"].valid(self.cookie())

    def send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def json(self, code: int, obj):
        self.send(code, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def redirect(self, to: str, extra: dict | None = None):
        self.send(303, b"", "text/plain", {"Location": to, **(extra or {})})

    def body(self, limit: int) -> bytes | None:
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            return None
        return self.rfile.read(n)

    def login_page(self, error: str = "", code: int = 200):
        page = LOGIN_PAGE.replace("__ERROR__", f'<div class="err">{html.escape(error)}</div>' if error else "")
        self.send(code, page.encode(), "text/html; charset=utf-8")

    # ---- routes
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/login":
            return self.login_page() if self.app["share"] else self.redirect("/")
        if path == "/api/mode":
            return self.json(200, {"remote": not self.local, "share": self.app["share"],
                                   "authed": self.authed(), "laptop": self.app["relay"].online()})
        if not self.authed():
            return self.json(401, {"error": "login"}) if path.startswith("/api/") else self.redirect("/login")
        if path == "/api/next":
            if not self.local:
                return self.json(403, {"error": "only the page on this computer answers questions"})
            job = self.app["relay"].next()
            return self.json(200, job) if job else self.send(204, b"", "text/plain")
        if path in ("/", "/index.html"):
            body = (HEAD + (WEB / "index.html").read_text(encoding="utf-8")).encode("utf-8")
            return self.send(200, body, "text/html; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/login":
            if not self.app["share"]:
                return self.redirect("/")
            ip, s = self.client_address[0], self.app["sessions"]
            if s.locked(ip):
                return self.login_page(f"Too many wrong passwords. Try again in {LOCK_MINUTES} minutes.", 429)
            form = urllib.parse.parse_qs((self.body(4096) or b"").decode(errors="replace"))
            if check_password((form.get("password") or [""])[0], self.app["login"]):
                cookie = f"checker_session={s.new()}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_HOURS * 3600}"
                return self.redirect("/", {"Set-Cookie": cookie})
            s.failed(ip)
            return self.login_page("Wrong password.", 401)
        if path == "/logout":
            self.app["sessions"].end(self.cookie())
            return self.redirect("/login", {"Set-Cookie": "checker_session=; Path=/; Max-Age=0"})
        if not self.authed():
            return self.json(401, {"error": "login"})
        if path == "/api/ask":
            raw = self.body(64_000)
            try:
                q = json.loads(raw or b"")
                kind, args = str(q["kind"]), dict(q.get("args") or {})
            except (ValueError, KeyError, TypeError):
                return self.json(400, {"error": "bad request"})
            if kind not in ("status", "check", "history", "trace"):
                return self.json(400, {"error": "unknown question"})
            relay = self.app["relay"]
            if not relay.online():
                return self.json(503, {"error": "The checker page isn't open on the office computer. Open it there "
                                                "(python serve.py --share) and load the SAP files."})
            ans = relay.ask(kind, args)
            return self.json(200, ans) if ans is not None else self.json(504, {"error": "The office computer didn't answer in time."})
        if path == "/api/answer":
            if not self.local:
                return self.json(403, {"error": "only the page on this computer answers questions"})
            try:
                a = json.loads(self.body(50_000_000) or b"")
                self.app["relay"].answer(str(a["id"]), a.get("result") or {})
            except (ValueError, KeyError, TypeError):
                return self.json(400, {"error": "bad answer"})
            return self.json(200, {"ok": True})
        return self.json(404, {"error": "not found"})

    def end_headers(self):
        # always the latest page after an update; the page isn't framed by other sites
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def free_port(start: int, host: str) -> int:
    for port in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port between {start} and {start + 19}; try --port with another number.")


def lan_addresses() -> list[str]:
    ips = set()
    try:
        ips.update(a for a in socket.gethostbyname_ex(socket.gethostname())[2] if not a.startswith("127."))
    except OSError:
        pass
    try:     # the address used to reach other machines (no traffic is sent)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Serve the cheese variance checker on localhost.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--share", action="store_true", help="also let a phone on the office network log in and use it")
    ap.add_argument("--set-password", action="store_true", help="choose a new password for the phone")
    a = ap.parse_args(argv)
    login = None
    if a.set_password:
        ask_new_password()
        if not a.share:
            return 0
    if a.share:
        login = json.loads(LOGIN_FILE.read_text(encoding="utf-8")) if LOGIN_FILE.exists() else ask_new_password()
    host = "0.0.0.0" if a.share else "127.0.0.1"
    port = free_port(a.port, host)
    app = {"share": a.share, "login": login, "sessions": Sessions(), "relay": Relay()}
    server = http.server.ThreadingHTTPServer((host, port), functools.partial(Handler, directory=str(WEB), app=app))
    server.daemon_threads = True
    url = f"http://localhost:{port}/"
    print(f"Cheese variance checker running at {url}  (Ctrl+C to stop)")
    if a.share:
        addrs = lan_addresses()
        print("Shared on the office network. On your phone (same Wi-Fi), open:")
        for ip in addrs or ["<this computer's IPv4 address, from ipconfig>"]:
            print(f"    http://{ip}:{port}/")
        print("Keep the checker page open on this computer with the SAP files loaded: it does the checking.")
    if not a.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
