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
        ├── checks.json         expected results, the lines they verify, the fixtures
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
Harbor run them. This release cannot prove or run such a package yet: it stays
`awaiting_integration`, missing `steps`, so a full run of its change cannot
pass.

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
  "schema_version": "1.1",
  "status": "confirmed",
  "spec_ref": { "id": "report-notifications", "sha256": "sha256:<handoff id>" },
  "scenario": { "requirement": "REQ-submit-failure", "name": "提交失败", "manual": [] },
  "dependencies": [
    { "name": "notify-api", "mode": "simulated", "note": "records every request" }
  ],
  "checks": [
    { "id": "c1", "intent": "REQ-submit-failure", "then": "本次提交发送的成功通知数量为零",
      "expect": "本次提交发送的成功通知数量为零", "role": "gating" }
  ],
  "fixtures": [
    { "name": "no-notification", "origin": "author", "note": "报告提交被拒绝，没有发出成功通知", "expect": { "c1": "pass" } },
    { "name": "one-notification", "origin": "author", "note": "报告提交被拒绝，却发出了一条成功通知", "expect": { "c1": "fail" } },
    { "name": "no-submission", "origin": "author", "note": "没有提交报告，这个场景没有发生", "expect": { "c1": "unknown" } },
    { "name": "notice-after-rejection", "origin": "review", "note": "报告提交被拒绝，却发出了一条成功通知", "expect": { "c1": "fail" } }
  ]
}
```

A line no program can judge, such as the tone of a reply, has no check. It is
listed in `scenario.manual` with the reason, and the user judges it at
acceptance:

```json
"scenario": {
  "requirement": "REQ-complaint-reply",
  "name": "回复投诉",
  "manual": [
    { "then": "回复的语气礼貌", "reason": "语气没有程序能判断" }
  ]
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `schema_version` | `1.1`, or `1.0` for an earlier package | `eval new` writes `1.1`. A `1.0` package is read with a warning; see checks.json 1.0 below. |
| `status` | `draft`, `confirmed` | `confirmed` when every expectation restates the exported Spec. `draft` holds an expectation the Spec does not state; it cannot be run or accepted. `confirmed` is not the user's confirmation of the checks, which `eval confirm` records in `confirmed.json`. |
| `spec_ref` | `id`, `sha256` | The change and the exported handoff this package was written for. A new export makes the package stale until it is reviewed. |
| `scenario` | `requirement`, `name` | The Spec scenario this package triggers. |
| `scenario.manual` | list of `then`, `reason` | The THEN and AND lines no program can judge, each with why; `[]` when a gating check verifies every line. The user judges these lines at acceptance. |
| `dependencies[]` | `name`, `mode`, optional `note` | Every external dependency and how it is provided: `live`, `frozen` or `simulated`. `[]` when there is none. A `live` dependency, such as a model call, makes the package run the number of attempts the user chose before the baseline; a package without one runs once. |
| `checks[].id` | `c1`, `c2` … | The verifier reports results under the same id. |
| `checks[].intent` | a requirement id | The requirement this check enforces. A gating check's intent is the scenario's requirement. A diagnostic check may cite another requirement of the Spec. A check without a source is rejected. |
| `checks[].then` | one THEN or AND line | The line of the scenario this check verifies, copied from the exported Spec. Required for a gating check. A diagnostic check may name a line; it covers none. |
| `checks[].at` | a step name | Multi-step packages only: the turn after which the check is read. |
| `checks[].expect` | one sentence | What must be observed in this scenario. It starts as the text of `then`; make it concrete, never stricter or broader than the line. |
| `checks[].role` | `gating`, `diagnostic` | Gating checks decide the result. Diagnostic checks explain it. |
| `fixtures[].name` | kebab-case | Names `tests/fixtures/<name>.sh`. |
| `fixtures[].origin` | `author`, `review`, `self-review` | Who wrote the fixture. `author` is the package's author, also when the field is missing. `review` is a reviewer who wrote it from the scenario without reading the verifier. `self-review` is the author doing that review alone. A `review` or `self-review` fixture that fails only one line's gating checks is that line's counterexample; see `review.md`. |
| `fixtures[].note` | one sentence | In the words of the business, the result the script leaves, such as 报告提交被拒绝，却发出了一条成功通知. |
| `fixtures[].expect` | check id to `pass`, `fail` or `unknown` | What the verifier must return after that script ran in the agent's place. |

There is no field that says a package can run. `eval validate` works it out:
the files are written, the kit names an adapter, every gating check has a
fixture for each of the three results, every line a program checks has a
reviewer's counterexample, and the last `eval check` passed on the package and
kit as they are now.

Rules:

- Every THEN and AND line of the scenario has a gating check whose `then` is
  that line, or is listed in `scenario.manual`; otherwise `eval validate`
  reports `then_uncovered`, which blocks `eval check` and `run start`. A line
  is matched with runs of whitespace folded into one space; otherwise it must
  be the Spec's text exactly, without the THEN or AND keyword.
- A gating check verifies exactly one line. Two gating checks may verify the
  same line. A diagnostic check does not cover a line: turning the only gating
  check of a line into a diagnostic one leaves the line uncovered.
- A line is verified by a check or judged by the user, not both. List a line
  in `scenario.manual` only when no program can judge it, never in place of a
  check that is hard to write, and never approximate it with a keyword check.
- `checks` may be `[]` only when `scenario.manual` lists every line. Then the
  requirement needs no gating check, but a run can pass only on gating checks:
  when no package of a change has one, no run of it can pass, and `loop start`
  refuses it (`gating_missing`).
- A line written twice in a scenario counts as one line, with a warning. Two
  lines that can only fail together state one result: merge them in the Spec
  with `agent-spec`.
- Every accepted requirement needs a gating check in some package, unless its
  packages leave every line to the user, and every scenario needs a package. A
  change cannot pass on a subset.
- Every line a gating check verifies needs a counterexample: a fixture with
  `origin` `review` or `self-review` whose `expect` names every gating check
  of the package, is `fail` for the checks of that line, and `pass` or
  `unknown` for the others. An author's fixture does not count. Until each
  line has one, the package misses `review` and does not run. A line in
  `scenario.manual` needs none.
- A check does not say whether it should pass or fail before the change. That
  is declared for a specific baseline run, not derived from the wording.
- A check for something that must not happen still needs the scenario to be
  triggered and the relevant activity fully observed. No input, no execution or
  no log is not a pass.

### checks.json 1.0

A package written before checks.json 1.1 keeps working: it is read under the
rules it was written for, never rewritten, and `eval validate` warns. Its checks
name no line, so its lines show as `unbound` and whether every line is checked
is not known. It needs no counterexamples, but `eval confirm` does not confirm
it. A gating check that cites another requirement than its scenario's is a
warning. `loop start` refuses 1.0 packages (`then_unbound`). A 1.0 file
that carries `then`, `scenario.manual`, or a fixture's `origin` or `note` is
rejected. One change may hold both versions.

To upgrade a package:

1. Set `schema_version` to `"1.1"`.
2. Give every gating check the line it verifies as `then`, and the scenario's
   requirement as `intent`. A check of another requirement becomes diagnostic.
3. List each line no program can judge in `scenario.manual` with the reason.
4. Have a reviewer write a counterexample for each line a program checks, as
   `review.md` says.
5. Run `eval validate` until it reports no `then_uncovered`, then `eval check`.
6. Have the user confirm the checks, as run-eval says: `eval review`, the
   reviewer's answers in `review.json`, then `eval confirm`, with `--reason`
   when this Spec export was confirmed before.
7. Record the baseline again. The upgrade changes the package, so a baseline
   recorded before it compares nothing with it, and `loop start` refuses that
   baseline (`baseline_packages_differ`).

Upgrade before recording the baseline, so it is recorded once. An upgrade
during a loop changes the package, which ends that loop (`packages_changed`).

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
`checks.json` is part of the digest, with every `then`, `scenario.manual`
entry and fixture `origin` and `note`: changing one of them changes the
package too.
The same digest decides whether the last `eval check` still counts.
