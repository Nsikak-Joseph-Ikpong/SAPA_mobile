"""Run the cheese variance checker on this computer: python serve.py (or Run 'serve' in PyCharm).

Serves the page in web/ at http://localhost:8000 and opens it in the browser. Only this computer can
reach it (it listens on 127.0.0.1). The files you load stay in the browser; nothing is uploaded.
Stop it with Ctrl+C (or the red Stop button in PyCharm).

Options: --port 8080 to use another port, --no-browser to not open the browser.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socket
import sys
import threading
import webbrowser
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"

# web/index.html has no document skeleton (the Claude artifact and the Pages build add one): add it here
HEAD = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8"}

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/index.html"):
            body = (HEAD + (WEB / "index.html").read_text(encoding="utf-8")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        # always the latest page after an update
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def free_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit(f"No free port between {start} and {start + 19}; try --port with another number.")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Serve the cheese variance checker on localhost.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args(argv)
    port = free_port(a.port)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(WEB)))
    url = f"http://localhost:{port}/"
    print(f"Cheese variance checker running at {url}  (Ctrl+C to stop)")
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
