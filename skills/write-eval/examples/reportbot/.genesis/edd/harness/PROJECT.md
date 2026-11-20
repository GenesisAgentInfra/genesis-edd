# Eval notes for this project

## How the evaluated program is started

`python -m reportbot submit REPORT.json` in `/app`, as user `nobody`. The
adapter `reportbot_agent.py` treats `instruction.md` as the arguments after
`python -m reportbot`. The program calls no model.

## External dependencies

| Dependency | Mode | Stand-in |
| --- | --- | --- |
| Report API, `POST /reports` | simulated | `environment/simulator.py`, service `api` |
| Notify API, `POST /notifications` | simulated | the same service |

`simulator.py STATUS` answers every report with that HTTP status and keeps a
ledger of what it received. A package chooses the status in its
`docker-compose.yaml`. The compose network is `internal`, so nothing leaves
the machine.

## Independent evidence

The service writes `/evidence/ledger.json`. `main` mounts it read-only and the
file is readable by root only, so the program under test cannot read or change
it. `verifier/observe.py EXPECTED_COUNT accepted|rejected` reads the ledger,
checks that this package's report reached the service with the status the
scenario needs, then counts success notifications.

## Known traps

- The program exits 1 after a rejected submission. That is its normal path, not
  a crash; the adapter raises only on a traceback or another exit code.
- Zero notifications also happens when nothing was submitted. `observe.py`
  reports that as missing evidence, never as a pass.
- `.dockerignore` allows only `reportbot/` and `example-report.json` into the image.

## Open gaps

Timeouts and dropped connections are not simulated.
