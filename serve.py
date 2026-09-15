"""Dev server for the app.

Identical to `python -m http.server`, except it tells the browser never to
cache. The stdlib server sends only Last-Modified, with no Cache-Control and
no ETag, so browsers are free to reuse a stale .js without revalidating —
which silently serves old code after an edit.

    py -3.13 serve.py [port]
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving on http://localhost:{port}/index.html  (no-cache)")
    print("Ctrl+C to stop.")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
