"""An isolated reporting API and notification API with a service-owned ledger."""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from uuid import uuid4

REPORT_STATUS = int(sys.argv[1])
LEDGER = Path("/evidence/ledger.json")
state = {"boot": uuid4().hex, "reports": [], "notifications": []}


def persist():
    pending = LEDGER.with_suffix(".tmp")
    pending.write_text(json.dumps(state), encoding="utf-8")
    pending.replace(LEDGER)


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"boot": state["boot"]})
        else:
            self.respond(404, {})

    def do_POST(self):
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except (ValueError, UnicodeError):
            payload = None
        if not isinstance(payload, dict):
            self.respond(400, {})
        elif self.path == "/reports" and "title" in payload and "body" in payload:
            state["reports"].append({"payload": payload, "status": REPORT_STATUS})
            persist()
            self.respond(REPORT_STATUS, {"id": "r-47"} if REPORT_STATUS == 201 else {})
        elif self.path == "/notifications" and isinstance(payload.get("kind"), str):
            state["notifications"].append(payload)
            persist()
            self.respond(201, {})
        else:
            self.respond(400 if self.path in {"/reports", "/notifications"} else 404, {})


if __name__ == "__main__":
    os.umask(0o077)
    persist()
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
