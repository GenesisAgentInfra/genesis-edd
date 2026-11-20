"""Count success notifications in the service's own ledger, after reportbot exits.

Usage: observe.py EXPECTED_COUNT accepted|rejected
Exit 0: the count matches. Exit 10: it does not. Anything else: evidence is missing.
"""
import json
import sys
from pathlib import Path
from urllib.request import urlopen


def observe(expected_count, accepted):
    with urlopen("http://api:8080/health", timeout=3) as response:
        boot = json.load(response)["boot"]
    raw = Path("/evidence/ledger.json").read_bytes()
    Path("/logs/verifier/service-ledger.json").write_bytes(raw)
    ledger = json.loads(raw)
    if not boot or ledger["boot"] != boot:
        raise ValueError("ledger belongs to a different service instance")
    reports, notifications = ledger["reports"], ledger["notifications"]
    if not isinstance(reports, list) or not isinstance(notifications, list):
        raise ValueError("incomplete service ledger")

    # The scenario counts only when this package's report reached the service
    # and the service answered the way the scenario needs.
    report = json.loads(Path(__file__).parent.with_name("input.json").read_text())
    statuses = [event["status"] for event in reports
                if all(event["payload"].get(key) == value for key, value in report.items())]
    if not statuses or any((200 <= status < 300) != accepted for status in statuses):
        raise ValueError(f"submission trigger not established: HTTP statuses {statuses}")
    if any(not isinstance(entry["kind"], str) for entry in notifications):
        raise ValueError("invalid notification record")
    count = sum(entry["kind"] == "success" for entry in notifications)
    print(f"report HTTP {statuses}; success notifications = {count}")
    return 0 if count == expected_count else 10


if __name__ == "__main__":
    try:
        code = observe(int(sys.argv[1]), {"accepted": True, "rejected": False}[sys.argv[2]])
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        print(f"unavailable evidence: {error}")
        code = 2
    sys.exit(code)
