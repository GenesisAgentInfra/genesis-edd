#!/usr/bin/env python3
"""Run the program under test as an unprivileged user and record its reply.

Use it when a THEN line is about the reply itself: what a command prints, its
exit status, the answer an agent gives. Copy this file into the kit's
environment/ folder and hand it to `main`, for example as a Compose config at
/opt/record.py. The adapter, and a fixture in its place, start the program
through it as root:

    python3 /opt/record.py [--evidence DIR] [--uid UID] [--gid GID] -- PROGRAM [ARG...]

The program runs as UID:GID (default 65534:65534, nobody and nogroup on
Debian images), in the current directory, with the recorder's environment,
HOME=/tmp and an empty standard input. When it exits, every process left of
that user is killed, so nothing it started outlives the command. Then one
record is written to DIR (default /evidence) as a new file, 0001.json,
0002.json and so on in the order of the commands:

    {"argv": [...], "cwd": "...", "uid": 65534, "gid": 65534,
     "started_at": "...", "finished_at": "...",
     "exit_status": 0, "signal": null, "stdout": "...", "stderr": "..."}

stdout and stderr are decoded as UTF-8; invalid bytes are replaced. DIR is
created when it is missing. It must be a directory owned by root with mode
0700, so the program can neither read nor change a record. Each record is
written to a temporary file and renamed into place. Pick a uid that nothing
else in `main` runs as, and run one command at a time.

The program's output is passed through. The recorder exits with the
program's exit status, or 128 + N when signal N stopped it. It exits 125
with no record when it cannot record (not run as root, a bad option, an
evidence directory it cannot use), and 126 or 127 when the program cannot be
started.
"""

import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


class Refused(Exception):
    """The command was not recorded. status is the recorder's exit status."""

    def __init__(self, message, status=125):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def parse(args):
    """--evidence DIR, --uid N and --gid N, then the command, after an optional --."""
    options = {"--evidence": "/evidence", "--uid": "65534", "--gid": "65534"}
    while args and args[0] in options:
        if len(args) < 2:
            raise Refused(f"{args[0]} needs a value")
        options[args[0]], args = args[1], args[2:]
    if args[:1] == ["--"]:
        args = args[1:]
    elif args and args[0].startswith("--"):
        raise Refused(f"unknown option {args[0]}")
    if not args:
        raise Refused("no command given")
    try:
        uid, gid = int(options["--uid"]), int(options["--gid"])
    except ValueError:
        raise Refused("--uid and --gid are numbers") from None
    if uid <= 0 or gid <= 0:
        raise Refused("--uid and --gid name an unprivileged user, never root (0)")
    return Path(options["--evidence"]), uid, gid, args


def evidence_dir(path):
    """The evidence directory, created when missing, if only root can use it."""
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise Refused(f"{path} must be a directory owned by root with mode 0700")
    return path


def become(uid, gid):
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def kill_leftovers(uid, gid):
    """Kill every process of uid from a child running as uid: kill(-1) reaches only that user's processes."""
    child = os.fork()
    if child == 0:
        code = 0
        try:
            become(uid, gid)
            os.kill(-1, signal.SIGKILL)
        except ProcessLookupError:
            pass  # nothing was left
        except BaseException:
            code = 1
        os._exit(code)
    _, status = os.waitpid(child, 0)
    if status != 0:
        raise Refused(f"could not stop the processes of uid {uid} that the program left")


def run(evidence, uid, gid, command):
    """Runs the command and returns its record and raw output. Output goes to
    unnamed files, so a process the program left cannot hold the recorder up."""
    with tempfile.TemporaryFile(dir=evidence) as out, tempfile.TemporaryFile(dir=evidence) as err:
        started = now()
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       env={**os.environ, "HOME": "/tmp"}, preexec_fn=lambda: become(uid, gid))
        except FileNotFoundError as error:
            raise Refused(f"cannot start {command[0]}: {error}", 127) from None
        except OSError as error:
            raise Refused(f"cannot start {command[0]}: {error}", 126) from None
        except subprocess.SubprocessError as error:
            raise Refused(f"cannot run {command[0]} as uid {uid}: {error}") from None
        returncode = process.wait()
        finished = now()
        kill_leftovers(uid, gid)
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(), err.read()
    record = {
        "argv": command, "cwd": os.getcwd(), "uid": uid, "gid": gid,
        "started_at": started, "finished_at": finished,
        "exit_status": returncode if returncode >= 0 else None,
        "signal": -returncode if returncode < 0 else None,
        "stdout": stdout.decode("utf-8", "replace"), "stderr": stderr.decode("utf-8", "replace"),
    }
    return record, stdout, stderr


def write_record(evidence, record):
    """Writes the record as the next numbered file, through a temporary file and a rename."""
    number = len(list(evidence.glob("[0-9][0-9][0-9][0-9].json"))) + 1
    while (evidence / f"{number:04d}.json").exists():
        number += 1
    handle, temporary = tempfile.mkstemp(dir=evidence, prefix=".record-", suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.rename(temporary, evidence / f"{number:04d}.json")


def main(args):
    if os.geteuid() != 0:
        raise Refused("run it as root: it starts the program as an unprivileged user and keeps the record where only root can read it")
    path, uid, gid, command = parse(args)
    evidence = evidence_dir(path)
    record, stdout, stderr = run(evidence, uid, gid, command)
    sys.stdout.buffer.write(stdout)
    sys.stdout.flush()
    sys.stderr.buffer.write(stderr)
    sys.stderr.flush()
    write_record(evidence, record)
    return record["exit_status"] if record["signal"] is None else 128 + record["signal"]


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as error:
        print(f"record.py: {error}", file=sys.stderr)
        sys.exit(error.status)
    except OSError as error:
        print(f"record.py: {error}", file=sys.stderr)
        sys.exit(125)
