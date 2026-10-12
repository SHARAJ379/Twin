# The same app as broken-python, with its three bugs actually fixed. The
# route shapes are identical on purpose - only where state lives changed.
import hashlib
import hmac
import json
import os
import secrets
import socketserver
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

SECRET = os.environ.get("SESSION_SECRET", "dev-secret-not-for-production")
DATA_FILE = Path(os.environ.get("DATA_FILE", Path(__file__).parent / "data.json"))
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", Path(__file__).parent / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE.parent.mkdir(parents=True, exist_ok=True)

ITEMS_LOCK = Lock()


# FIXED: identity lives in a signed cookie, not server memory. Any instance
# that's given the same SESSION_SECRET can verify it, so login survives a switch.
def sign(value: str) -> str:
    sig = hmac.new(SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()
    return f"{value}.{sig}"


def verify(signed: str | None) -> str | None:
    if not signed or "." not in signed:
        return None
    value, _, sig = signed.rpartition(".")
    expected = hmac.new(SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()
    return value if hmac.compare_digest(sig, expected) else None


# FIXED: items live at DATA_FILE - point every instance at the same shared
# path and they all see the same data. Plain read-modify-write, no
# cross-process locking: fine for a demo app, not a production-grade store.
def read_items() -> list:
    try:
        return json.loads(DATA_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def write_items(items: list) -> None:
    DATA_FILE.write_text(json.dumps(items))


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


class Server(ThreadingHTTPServer):
    """
    ThreadingHTTPServer without the startup reverse-DNS lookup.

    HTTPServer.server_bind() calls socket.getfqdn() on the bind address, and
    TCPServer.__init__ runs it *before* server_activate() calls listen(). On a
    host with a slow resolver (CI runners especially) that blocks for tens of
    seconds with the socket bound but not yet listening - connections get
    refused, nothing is logged, and the process looks alive but serves nothing.
    """

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = self.server_address[0]
        self.server_port = self.server_address[1]


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
        signed = cookie["sid"].value if "sid" in cookie else None
        return verify(signed)

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
            with ITEMS_LOCK:
                items = read_items()
            for item in items:
                if item["id"] == item_id:
                    return self._json(200, item)
            return self._json(404, {"error": "not found"})

        if self.path.startswith("/uploads/"):
            if not self._session_email():
                return self._json(401, {"error": "not authenticated"})
            safe_name = os.path.basename(self.path.removeprefix("/uploads/"))
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
            return self._json(200, {"email": body["email"]}, {"Set-Cookie": f"sid={sign(body['email'])}; HttpOnly; Path=/"})

        if self.path == "/items":
            email = self._session_email()
            if not email:
                return self._json(401, {"error": "not authenticated"})
            body = self._body_json()
            if not body.get("name"):
                return self._json(400, {"error": "name required"})
            item = {"id": secrets.token_hex(16), "name": body["name"]}
            with ITEMS_LOCK:
                items = read_items()
                items.append(item)
                write_items(items)  # FIXED: DATA_FILE is a shared path, not local-only
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
            (UPLOAD_DIR / filename).write_bytes(content)  # FIXED: UPLOAD_DIR is a shared path, not local-only
            return self._json(201, {"filename": filename})

        self._json(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    server = Server(("127.0.0.1", port), Handler)
    print(f"fixed-python listening on {port}")
    server.serve_forever()
