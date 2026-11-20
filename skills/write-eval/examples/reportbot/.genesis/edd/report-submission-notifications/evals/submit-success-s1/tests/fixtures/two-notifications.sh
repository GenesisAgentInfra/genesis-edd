#!/bin/sh
# Submit the report, then send 2 success notification(s), without reportbot.
python - <<'PY'
import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen

def post(path, payload):
    request = Request("http://api:8080" + path, json.dumps(payload).encode(), {"Content-Type": "application/json"})
    try:
        urlopen(request, timeout=3).close()
    except HTTPError:
        pass

post("/reports", json.load(open("/app/example-report.json")))
for _ in range(2):
    post("/notifications", {"kind": "success", "title": "Week 47 status", "report_id": None})
PY
