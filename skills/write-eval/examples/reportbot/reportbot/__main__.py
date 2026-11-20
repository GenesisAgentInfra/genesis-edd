"""Submit a report to the reporting service and tell the team about it."""
import json
import os
import sys
import urllib.error
import urllib.request


def post(url, payload):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, {}


def submit(path):
    with open(path, encoding="utf-8") as handle:
        report = json.load(handle)
    status, body = post(os.environ["REPORT_API_URL"] + "/reports", report)
    post(
        os.environ["NOTIFY_API_URL"] + "/notifications",
        {"kind": "success", "title": report["title"], "report_id": body.get("id")},
    )
    if 200 <= status < 300:
        print(f"submitted {body.get('id')}")
        return 0
    print(f"submission failed with HTTP {status}", file=sys.stderr)
    return 1


def main(argv):
    if len(argv) != 2 or argv[0] != "submit":
        print("usage: python -m reportbot submit REPORT.json", file=sys.stderr)
        return 2
    return submit(argv[1])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
