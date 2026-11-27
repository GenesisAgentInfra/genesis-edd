# Example: reportbot

A complete project kit and two eval packages for a small program, as they were
after a real run. Read it for the shape of the files; the paths are the ones a
project uses.

`reportbot` submits a report, then notifies the team. The version here has the
defect the change removes: it sends the success notification whatever the
submission returns. The two requirements are in
`openspec/changes/report-submission-notifications/specs/`.

```text
.dockerignore                         only the program and its sample report enter the image
reportbot/__main__.py                 the program, before the change
.genesis/edd/
├── harness/                          the project kit
│   ├── harness.json
│   ├── PROJECT.md
│   ├── reportbot_agent.py            adapter: runs the program as an unprivileged user
│   ├── environment/Dockerfile
│   ├── environment/simulator.py      one stand-in for both APIs, with its own ledger
│   └── verifier/observe.py           reads the ledger; exits 0, 10 or 2
└── report-submission-notifications/
    ├── baseline-expectations.json    passed to run start --baseline --expect
    └── evals/
        ├── submit-failure-s1/        simulator answers 503; expects 0 notifications
        └── submit-success-s1/        simulator answers 201; expects 1 notification
```

`eval new` adds `tests/genesis.sh` and `tests/shared/` (a copy of the kit's
`verifier/`) to each package; they are left out here.

## What to notice

- The two packages differ in three places: the status the simulator answers
  with, the arguments to `observe.py`, and the fixtures. Everything else is in
  the kit.
- `observe.py` first confirms the report reached the service with the status
  the scenario needs. Zero notifications without a submission is `unknown`, not
  a pass.
- The ledger is written by the service, mounted read-only in `main`, and
  readable by root only. The program runs as `nobody`.
- The program exits 1 after a rejected submission. The adapter treats that as
  normal and raises only on a crash.
- The compose network is `internal`. `network_mode` in `task.toml` stays
  `public`, because the isolation is done in the compose file.
- Each `Task.md` records the one choice the Spec does not make: which HTTP
  status stands for a failed or a successful submission.

## What ran

With Harbor 0.26 in local Docker:

| Step | Result |
| --- | --- |
| `eval check` | 7 fixtures, each got the result it expects |
| `run start --baseline --expect …` | `submit-failure-s1` c1 `fail`, `submit-success-s1` c1 `pass`; no mismatch |
| the fix: notify only after a 2xx response | 4 lines in `reportbot/__main__.py` |
| `run start` | verdict `pass`; c1 `fail` to `pass` and c1 `pass` to `pass`, both `holds` |
