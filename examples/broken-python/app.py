# A minimal app on the standard library's http.server, deliberately broken
# the way a vibe-coded app commonly is: it works perfectly as one process on
# localhost, and silently loses data the moment more than one instance is
# running.
import json
import os
import secrets
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPLOAD_DIR = Path(__file__).parent / "uploads"  # BROKEN: relative to the app dir, lands on this instance's own local disk only
UPLOAD_DIR.mkdir(exist_ok=True)

# BROKEN: both live only in this process's memory. A second instance (or a
# restart of this one) starts with these empty - that's the bug Twin finds.
SESSIONS = {}  # sessionId -> email
ITEMS = []  # {id, name}


def parse_multipart(body: bytes, boundary: bytes):
    parts = body.split(b"--" + boundary)
    for part in parts:
        if b"Content-Disposition" not in part:
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers = part[:header_end]
        content = part[header_end + 4 :]
        content = content[: -2] if content.endswith(b"\r\n") else content
        if b'name="file"' not in headers:
            continue
        marker = b'filename="'
        start = headers.find(marker)
        filename = "upload"
        if start != -1:
            start += len(marker)
            end = headers.find(b'"', start)
            filename = headers[start:end].decode("utf-8", "replace")
        return filename, content
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep test output focused on Twin's own report

    def _json(self, status: int, body: dict, extra_headers: dict[str, str] | None = None):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _body_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw) if raw else {}

    def _session_email(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        sid = cookie["sid"].value if "sid" in cookie else None
        return SESSIONS.get(sid)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path == "/me":
            email = self._session_email()
            if not email:
                return self._json(401, {"error": "not authenticated"})
            return self._json(200, {"email": email})

        if self.path.startswith("/items/"):
            if not self._session_email():
                return self._json(401, {"error": "not authenticated"})
            item_id = self.path.removeprefix("/items/")
            for item in ITEMS:
                if item["id"] == item_id:
                    return self._json(200, item)
            return self._json(404, {"error": "not found"})

        if self.path.startswith("/uploads/"):
            if not self._session_email():
                return self._json(401, {"error": "not authenticated"})
            safe_name = os.path.basename(self.path.removeprefix("/uploads/"))  # no path traversal, even in a broken demo app
            file_path = UPLOAD_DIR / safe_name
            if not file_path.exists():
                return self._json(404, {"error": "not found"})
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/signup":
            body = self._body_json()
            if not body.get("email") or not body.get("password"):
                return self._json(400, {"error": "email and password required"})
            return self._json(201, {"email": body["email"]})

        if self.path == "/login":
            body = self._body_json()
            if not body.get("email") or not body.get("password"):
                return self._json(400, {"error": "email and password required"})
            sid = secrets.token_hex(16)
            SESSIONS[sid] = body["email"]
            return self._json(200, {"email": body["email"]}, {"Set-Cookie": f"sid={sid}; HttpOnly; Path=/"})

        if self.path == "/items":
            email = self._session_email()
            if not email:
                return self._json(401, {"error": "not authenticated"})
            body = self._body_json()
            if not body.get("name"):
                return self._json(400, {"error": "name required"})
            item = {"id": secrets.token_hex(16), "name": body["name"]}
            ITEMS.append(item)
            return self._json(201, item)

        if self.path == "/upload":
            email = self._session_email()
            if not email:
                return self._json(401, {"error": "not authenticated"})
            content_type = self.headers.get("Content-Type", "")
            if "boundary=" not in content_type:
                return self._json(400, {"error": "file required"})
            boundary = content_type.split("boundary=")[1].encode()
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            parsed = parse_multipart(body, boundary)
            if parsed is None:
                return self._json(400, {"error": "file required"})
            original_name, content = parsed
            filename = f"{secrets.token_hex(16)}-{os.path.basename(original_name)}"
            (UPLOAD_DIR / filename).write_bytes(content)  # BROKEN: write to a non-env-configured local path
            return self._json(201, {"filename": filename})

        self._json(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"broken-python listening on {port}")
    server.serve_forever()
