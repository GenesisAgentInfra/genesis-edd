# Eval task package v0.1

Two layers. The project kit is shared by every package of the project. One
package tests one scenario of the exported Spec.

```text
.genesis/edd/
├── harness/                    the project kit
│   ├── harness.json            {"agent": "module:Class", "model": optional}
│   ├── PROJECT.md              how evals work in this project; read it first
│   ├── <adapter>.py            starts the evaluated program for Harbor
│   ├── environment/            shared Dockerfile, stand-in services, seed data
│   └── verifier/               shared verifier code; copied into every package
└── <change>/evals/<case>/      one package
    ├── task.toml               Harbor configuration; no Genesis fields
    ├── instruction.md          exact input for the evaluated agent
    ├── Task.md                 design notes for a human reader
    ├── environment/            thin: picks this scenario's behavior from the kit
    └── tests/
        ├── checks.json         expected results, their sources, the fixtures
        ├── test.sh             verifier entry point
        ├── fixtures/<name>.sh  scripts that stand in for the agent
        ├── genesis.sh          shipped helper; do not edit
        └── shared/             copy of the kit's verifier/; do not edit
```

A package reaches the kit in two ways. Environment files are used in place:
`${GENESIS_EDD_HARNESS}` in `docker-compose.yaml` is the kit folder during a
run. Verifier code cannot be used in place, because Harbor uploads only
`tests/`; `eval new` copies the kit's `verifier/` into `tests/shared/` and
`eval validate` rejects a copy that differs.

Put a file in the kit when a second package would otherwise repeat it. Keep one
package's exact input, its expected results and its scenario-specific settings
in the package.

A multi-turn scenario uses Harbor's multi-step layout instead of
`instruction.md`: `steps/<step>/instruction.md` for each turn, with matching
`[[steps]]` entries in `task.toml`. Creating the folders alone does not make
Harbor run them.

## PROJECT.md and Task.md

`PROJECT.md` is what the next package, and the next change, should not have to
find out again: how the evaluated program is started, each dependency and its
stand-in, which records prove an effect, known traps, open gaps. Update it when
a run teaches something. Never put one package's expected result in it.

`Task.md` is for the person who commands this work. It says how the scenario is
triggered, what is simulated and how that differs from production, what each
check reads, which choices were made that the Spec does not state, and what is
not covered. A choice that changes what the business accepts does not belong
there: it goes back to the Spec.

## checks.json

```json
{
  "schema_version": "1.0",
  "status": "confirmed",
  "spec_ref": { "id": "report-notifications", "sha256": "sha256:<handoff id>" },
  "scenario": { "requirement": "REQ-submit-failure", "name": "提交失败" },
  "dependencies": [
    { "name": "notify-api", "mode": "simulated", "note": "records every request" }
  ],
  "checks": [
    { "id": "c1", "intent": "REQ-submit-failure", "expect": "本次提交发送的成功通知数量为零", "role": "gating" }
  ],
  "fixtures": [
    { "name": "no-notification", "expect": { "c1": "pass" } },
    { "name": "one-notification", "expect": { "c1": "fail" } },
    { "name": "no-submission", "expect": { "c1": "unknown" } }
  ]
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `status` | `draft`, `confirmed` | `confirmed` when every expectation restates the exported Spec. `draft` holds an expectation the Spec does not state; it cannot be run or accepted. |
| `spec_ref` | `id`, `sha256` | The change and the exported handoff this package was written for. A new export makes the package stale until it is reviewed. |
| `scenario` | `requirement`, `name` | The Spec scenario this package triggers. |
| `dependencies[]` | `name`, `mode`, optional `note` | Every external dependency and how it is provided: `live`, `frozen` or `simulated`. `[]` when there is none. |
| `checks[].id` | `c1`, `c2` … | The verifier reports results under the same id. |
| `checks[].intent` | a requirement id | The requirement this check enforces. A check without a source is rejected. |
| `checks[].at` | a step name | Multi-step packages only: the turn after which the check is read. |
| `checks[].expect` | one sentence | What must be observed in this scenario. |
| `checks[].role` | `gating`, `diagnostic` | Gating checks decide the result. Diagnostic checks explain it. |
| `fixtures[].name` | kebab-case | Names `tests/fixtures/<name>.sh`. |
| `fixtures[].expect` | check id to `pass`, `fail` or `unknown` | What the verifier must return after that script ran in the agent's place. |

There is no field that says a package can run. `eval validate` works it out:
the files are written, the kit names an adapter, every gating check has a
fixture for each of the three results, and the last `eval check` passed on the
package and kit as they are now.

Rules:

- Every accepted requirement needs a gating check in some package, and every
  scenario needs a package. A change cannot pass on a subset.
- A check does not say whether it should pass or fail before the change. That
  is declared for a specific baseline run, not derived from the wording.
- A check for something that must not happen still needs the scenario to be
  triggered and the relevant activity fully observed. No input, no execution or
  no log is not a pass.

## What the verifier writes

`tests/test.sh` runs after the agent finishes and writes two files to
`/logs/verifier/`. The shipped helper produces both:

```sh
#!/bin/sh
here=$(dirname "$0")
. "$here/genesis.sh"

# The reader decides; the shell only maps its exit status to a result.
evidence=$(python "$here/shared/observe.py" 0 rejected 2>&1)
case $? in
    0) gate c1 pass "$evidence" ;;
    10) gate c1 fail "$evidence" ;;
    *) gate c1 unknown "$evidence" ;;
esac

finish
```

Read the evidence with one program that exits with a distinct status for
"holds", "does not hold" and "could not tell". Do not count matches at the end
of a shell pipeline: when the read fails, the count is 0 and a check for "none
were sent" passes on missing evidence.

- `gate ID RESULT EVIDENCE` records a gating check, `note ID RESULT EVIDENCE` a
  diagnostic one. `RESULT` is `pass`, `fail` or `unknown`.
- `finish` writes `check-results.json` with one `{id, result, evidence}` entry
  per recorded check, and `reward.json` with `reward` 1 only when every gating
  check passed.
- Use `unknown` when evidence could not be read. It is never a pass, and a run
  reports it as missing evidence, not as a business failure.
- Use `gate` and `note` exactly as `checks.json` declares each check's role.

## Package identity

A run records a digest of each package together with the kit; `Task.md` and
`PROJECT.md` are prose and are left out, and so are Python caches and the files
an operating system or editor leaves behind: `.DS_Store`, `Thumbs.db`, `*.swp`,
`*.swo` and `*~`. Results are compared only between runs of an identical
package and kit, so changing an input, a check, the verifier, the adapter or a
stand-in starts a new comparison instead of silently reusing an old baseline.
The same digest decides whether the last `eval check` still counts.
