# Eval task package v0.1

There are two layers. The project kit is shared by every package of the
project. A package tests one scenario of the Spec.

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
    ├── instruction.md          exact input for the evaluated program
    ├── harness.json            optional: {"agent": "module:Class"} for this package only
    ├── Task.md                 design notes for a human reader
    ├── environment/            thin and sealed: picks this scenario's behavior from the kit
    ├── steps/<step>/           a multi-step package: instruction.md and tests/ per step
    └── tests/
        ├── checks.json         expected results, the lines they verify, the fixtures
        ├── test.sh             verifier entry point
        ├── code/               test programs of code-level checks
        ├── judges/             judging programs for lines the user judges
        ├── fixtures/           NAME.sh, NAME.patch, or NAME/STEP.sh and NAME/code.patch
        ├── genesis.sh          shipped helper; do not edit
        └── shared/             copy of the kit's verifier/; do not edit
```

A package reaches the kit in two ways:

- **Environment files are used in place.** In `docker-compose.yaml`,
  `${GENESIS_EDD_HARNESS}` is the kit folder and `${GENESIS_EDD_REPO}` the
  project root during a run.
- **Verifier code is copied.** Harbor uploads only `tests/`, so `eval new`
  copies the kit's `verifier/` into `tests/shared/` of a new package, and
  `eval sync` brings existing packages in line. A copy that differs from the
  kit is `shared_code_mismatch`, reported once per package with the files
  that differ, and `eval check`, `eval confirm` and `run start` refuse it.

Put a file in the kit when a second package would otherwise repeat it. Keep
one package's exact input, its expected results and its scenario settings in
the package.

A package's own `harness.json` names the adapter that package runs with,
instead of the kit's agent. It holds only `agent`. The model stays the kit's,
or the one in the confirmed run plan. Keep that module in the kit: one that
lies elsewhere cannot be scanned, so the change takes the full tier
(`adapter_unscanned`). `eval review` shows such packages to the user, and the
confirmation records them.

## Multi-step packages

A scenario of several turns uses Harbor's multi-step layout:

- each turn is declared in `task.toml` as a `[[steps]]` entry with a `name`,
  in the order Harbor runs them;
- each step has its folder `steps/<name>/`, with `instruction.md` and
  `tests/test.sh`;
- every check names the step after which it is read, in `at`;
- each step's `test.sh` records only the checks of that step;
- a fixture gives one script per step, `tests/fixtures/<fixture>/<step>.sh`,
  and a step without one does nothing.

A run and `eval check` read each check's result only from the verifier
output of its own step, `steps/<at>/verifier/check-results.json` in the
trial: a result another step's verifier wrote for it never counts. Each
step's `reward.json` is compared with the gating checks at that step, and is
0 for a step with none; a reward that does not match gives a warning. A step
whose agent raised makes the whole attempt an execution error.

`eval validate` gives the step of each check as `check_at`. It reports a
step folder that `task.toml` does not declare, a declared step without a
folder, an unnamed or doubled step, and a check without `at`. A `genesis.sh`
or `shared/` under a step's `tests/` would stand in for the shipped one, and
`eval sync` removes it.

## PROJECT.md and Task.md

`PROJECT.md` is what the next package, and the next change, should not have
to find out again: how the evaluated program is started, each dependency and
its stand-in, which records prove an effect, known traps and open gaps.
Update it when a run teaches something. Never put one package's expected
result in it. `eval validate` warns while it is missing or still the
template.

`Task.md` is for the person who commands this work. It covers these:

- how the scenario is triggered;
- what is simulated, and how that differs from production;
- what each check reads;
- which choices were made that the Spec does not state;
- what is not covered.

A choice that changes what the business accepts does not belong there: it
goes back to the Spec. `eval validate` warns when a package that declares a
dependency has no `Task.md`, and names the headings. `eval review` shows the
user what is listed under the heading "Choices made here".

## checks.json

```json
{
  "schema_version": "1.1",
  "status": "confirmed",
  "spec_ref": { "id": "report-notifications", "sha256": "sha256:<handoff id>" },
  "scenario": { "requirement": "REQ-submit-failure", "name": "提交失败", "manual": [] },
  "dependencies": [
    { "name": "notify-api", "mode": "simulated", "stand_in": "a local service that records every request" }
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

A line no program can judge has no gating check. It is listed in
`scenario.manual` with the reason, and the user judges it at acceptance. A
judge check may run the project's judging program for it. That result stays
diagnostic, and needs no proof, unless the user makes the line gating when
confirming (`--judge-gating <case>:<line>`). Made gating, the judge counts
in a run's verdict like a gating check, and the line needs the verdict
`faithful` and a proof that the judge can fail, in either tier
([review.md](review.md#which-lines-need-a-counterexample)):

```json
"scenario": {
  "requirement": "REQ-complaint-reply",
  "name": "回复投诉",
  "manual": [ { "then": "回复的语气礼貌", "reason": "语气没有程序能判断" } ]
},
"checks": [
  { "id": "j1", "intent": "REQ-complaint-reply", "then": "回复的语气礼貌", "expect": "回复的语气礼貌",
    "role": "diagnostic", "kind": "judge", "program": "judges/tone.py", "timeout_sec": 120 }
]
```

A code-level check runs a test program frozen in the package against the
application code in the container:

```json
{ "id": "c2", "intent": "REQ-submit-failure", "then": "失败的提交不写入报告表",
  "expect": "失败的提交不写入报告表", "role": "gating", "kind": "code_test", "command": "code/no_row_on_failure.sh" }
```

### Fields

| Field | Values | Meaning |
| --- | --- | --- |
| `schema_version` | `1.1`, or `1.0` for an earlier package | `eval new` writes `1.1`. See checks.json 1.0 below. |
| `status` | `draft`, `confirmed` | `confirmed` when every expectation restates the Spec. `draft` holds an expectation the Spec does not state, the user's to settle in the Spec (`case_draft`). It is not the user's confirmation of the checks, which `eval confirm` records in `confirmed.json`. |
| `spec_ref` | `id`, `sha256`, optional `draft`, optional `scenario_sha256` | The change and the export, or draft, this package is bound to. `scenario_sha256` is the digest of the scenario's text when it was bound; `eval rebind` reads it when the earlier Spec text is gone. |
| `rebound` | list of `{ from, to, at, basis }` | Written by `eval rebind`: the package's earlier bindings |
| `scenario` | `requirement`, `name` | The Spec scenario this package triggers. A requirement the Spec leaves out (`excluded`) is never checked. |
| `scenario.manual` | list of `then`, `reason` | The THEN and AND lines no program can judge, each with why; `[]` when a gating check verifies every line |
| `dependencies[]` | `name`, `mode`, `stand_in`, optional `note` | Every external dependency and how it is provided: `live`, `frozen` or `simulated`. `stand_in` says what replaces a frozen or simulated one; a missing one gives a warning. A `live` dependency takes the change to the full tier and makes the package run the number of attempts the user chose. A package that is not sealed must declare its live dependency (`network_undeclared`). |
| `checks[].id` | `c1`, `c2` … | The verifier reports results under the same id |
| `checks[].intent` | a requirement id | A gating check cites its scenario's requirement. A diagnostic check may cite another requirement of the Spec. A check without a source is rejected. |
| `checks[].then` | one THEN or AND line | The line this check verifies, copied from the Spec. A gating check needs it, or `then_group`. A diagnostic check may name a line, and covers none. A judge names a line of `scenario.manual`. |
| `checks[].then_group` | 2 to 4 lines | Gating checks only: lines of the scenario that can only fail together. Each line still needs its own verdict and its own counterexample. |
| `checks[].expect` | one sentence | What must be observed in this scenario. It starts as the text of `then`; make it concrete, never stricter or broader than the line. A concrete `expect` that differs from its `then` text is shown to the user at confirmation as `expect_differs`, one item that lists every such check. |
| `checks[].role` | `gating`, `diagnostic` | Gating checks decide the result. Diagnostic checks explain it. A judge is declared diagnostic, and counts as gating only once the user makes its line gating at confirmation. |
| `checks[].kind` | `verifier` (default), `code_test`, `judge` | How the check is decided: by the verifier reading what the program left, by a test program run against the code, or by a judging program |
| `checks[].command` | path under `tests/code/` | A code test's program, run by `gate_code` or `note_code` in `test.sh` |
| `checks[].program` | path under `tests/judges/` or `tests/shared/judges/` | A judge's program, run by `judge` in `test.sh` |
| `checks[].timeout_sec` | whole seconds, default 300 | The time a code test or judge may take; `test.sh` passes the same number |
| `checks[].at` | a step name | Multi-step packages only: the step after which the check is read |
| `fixtures[].name` | kebab-case | Names its script, `tests/fixtures/<name>.sh`, or its step scripts or code patch |
| `fixtures[].origin` | `author`, `review`, `self-review` | Who wrote it. `author` is the package's author, also when the field is missing. `review` is a reviewer who wrote it from the scenario without reading the verifier. `self-review` is the author doing that review alone. |
| `fixtures[].note` | one sentence | In the words of the business, the result the fixture leaves |
| `fixtures[].then` | one line | Optional: the line a counterexample breaks. A line that a `then_group` check shares needs a counterexample that names it here. |
| `fixtures[].kind` | `script`, `code_patch` | Says which, when a fixture has both a script and a patch. A fixture is a code patch exactly when `eval validate` lists it in its case's `code_patches`: `kind: code_patch`, or a patch and no script without `kind`. |
| `fixtures[].patch` | path under `tests/fixtures/` | A code patch somewhere other than `tests/fixtures/<name>.patch` or `tests/fixtures/<name>/code.patch` |
| `fixtures[].expect` | check id to `pass`, `fail` or `unknown` | What the verifier must return after the fixture ran in the agent's place |

There is no field that says a package can run; `integration` is rejected.
`eval validate` works readiness out from these conditions:

- the files are written: the instruction, an environment that builds `main`,
  and `test.sh` beyond its template;
- an adapter is named;
- the last `eval check` passed on the package and the kit as they are now.

In both tiers the probe of `eval check` proves that every gating check but
a code test is `unknown` when nothing happens, and the accepted run proves
that it can pass; author fixtures are optional. In the full tier every line
a program checks also needs a reviewer's counterexample, and each gating
check that asserts absence (`"absence": true`) or belongs to a package with
a live dependency needs a fixture that leaves it `unknown` with the scenario
run and its evidence missing. In the light tier each line's proof that it
can fail is checked when the user confirms (`line_unproven`). A package in
checks.json 1.0 keeps the rule of 0.2.0: a fixture for each of the three
results of every gating check but a code test. A line
whose judge check the user makes gating needs that proof in either tier.

### Coverage

- Every THEN and AND line of the scenario has a gating check, in any package
  of that scenario, whose `then` (or `then_group`) is that line, or the line
  is listed in `scenario.manual`. Otherwise it is `then_uncovered`. A line
  matches when its runs of whitespace fold into one space; otherwise it must
  be the Spec's text exactly, without the THEN or AND keyword. A GIVEN or
  WHEN line is no line to check.
- A line is verified by a check or judged by the user, not both, within a
  package (`case_invalid`) and across packages (`then_conflict`).
- Two gating checks may verify the same line. A diagnostic check covers no
  line, so turning the only gating check of a line into a diagnostic one
  uncovers the line.
- `checks` may be `[]` only when `scenario.manual` lists every line. A run
  passes only on gating checks, so when no package of a change has one, no
  run can pass and `loop start` refuses (`gating_missing`).
- A line written twice in a scenario counts as one line, with a warning.
- Every accepted requirement needs a gating check in some package, unless
  its packages leave every line to the user, and every scenario needs a
  package. A change cannot pass on a subset.
- A counterexample of a line is a fixture with `origin` `review` or
  `self-review` that meets these conditions:
  - its `expect` names every gating check of the package;
  - it is `fail` for the checks of that line, and `pass` or `unknown` for the
    others;
  - a script may leave out a code test of another line.

  A line a code test checks needs a code patch as its counterexample, a
  fixture `eval validate` lists in `code_patches`; in the light tier its
  failure at the baseline proves it too. A line whose check several lines
  share is never proved by a failure at the baseline. An author's fixture
  never counts. A line in `scenario.manual` needs none while its judge, if
  any, stays diagnostic.
- A check does not say whether it should pass or fail before the change.
  That is declared for a baseline run, not derived from the wording.
- A check that something must not happen still needs the scenario to be
  triggered and the relevant activity fully observed. No input, no execution
  and no log are not a pass.

### checks.json 1.0

A package written before checks.json 1.1 keeps working under the rules it was
written for. The CLI never rewrites it, and `eval validate` warns about it:

- its checks name no line, so its lines show as `unbound`, and whether every
  line is checked is not known;
- it needs no counterexamples;
- `eval confirm` and `loop start` refuse it (`then_unbound`);
- a gating check of another requirement than its scenario's gives a warning;
- a 1.0 file that carries 1.1 fields (`then`, `then_group`, `kind`,
  `command`, `program`, `timeout_sec`, `scenario.manual`, or a fixture's
  `origin`, `note`, `then`, `kind` or `patch`) is rejected.

One change may hold both versions.

An upgraded package holds all of the following:

- `schema_version` `"1.1"`;
- every gating check bound to its line with `then`, and citing the scenario's
  requirement, while a check of another requirement becomes diagnostic;
- every line no program can judge in `scenario.manual`, with the reason;
- the counterexamples its tier asks for;
- a passing `eval check`.

The upgrade changes the package. A baseline recorded before it compares
nothing with it (`baseline_packages_differ`), and during a loop it ends the
loop (`packages_changed`). Upgrading before the baseline means the baseline
is recorded once.

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
gate_code c2 code/no_row_on_failure.sh

finish
```

Read the evidence with one program that exits with a distinct status for
"holds", "does not hold" and "could not tell". Do not count matches at the end
of a shell pipeline: when the read fails, the count is 0, and a check for
"none were sent" passes on missing evidence.

- `gate ID RESULT EVIDENCE` records a gating check, and `note ID RESULT
  EVIDENCE` a diagnostic one. `RESULT` is `pass`, `fail` or `unknown`.
- `gate_code ID PROGRAM [SECONDS]` and `note_code ID PROGRAM [SECONDS]` run a
  code test, and `judge ID PROGRAM [SECONDS]` runs a judge. `PROGRAM` is a
  path under `tests/`. The exit status gives the result:
  - 0 is `pass`, and 1 to 123 is `fail`;
  - `unknown` covers a timeout (124), "cannot tell" (125), a program that
    cannot run (126 or 127), a signal, and a missing program.

  The output goes to `/logs/verifier/ID.log`, and its last lines are the
  evidence. `eval validate` checks that `test.sh` has the call each code test
  and judge needs, with its `timeout_sec`.
- `finish` writes `check-results.json`, with one `{id, result, evidence}`
  entry per check, and `reward.json`, with `reward` 1 only when every gating
  check passed. In a package with steps, each step's `test.sh` writes both
  for the checks at that step, and its reward is 0 when the step has no
  gating check. The helper records a judge as a diagnostic check, also once
  the user made its line gating; the run counts it as gating then.
- A check recorded more than once is `unknown`.
- `unknown` means the evidence could not be read. It is never a pass, and a
  run reports it as missing evidence, not as a business failure.
- Use `gate` and `note` exactly as `checks.json` declares each check's role.

## Package identity

Runs and proofs record digests of each package together with the kit.
`Task.md` and `PROJECT.md` are prose and are left out. So are Python caches
and the files an operating system or editor leaves behind: `.DS_Store`,
`Thumbs.db`, `*.swp`, `*.swo` and `*~`.

- `run_digest` is what a run executes: every file of the package and the kit
  except `tests/fixtures/**`, with the `fixtures` array left out of
  `checks.json`. Results are compared only between runs of the same
  `run_digest`. A loop's packages are held by it, and so are the failures
  counted for the same code. Changing an input, a check, a `then`, a
  `scenario.manual` entry, the verifier, the adapter or a stand-in starts a
  new comparison. Adding or editing a fixture does not.
- `task_digest` covers every file, fixtures included. Between records that
  do not both have a `run_digest`, it decides.
- `proof_digest` is what `eval check` proofs rest on. It leaves out the
  binding to a Spec (`spec_ref`, `rebound`), the package's own
  `harness.json`, and the kit's `harness.json` and adapter modules at its
  root, unless an environment file copies or mounts such a module into a
  container. An edit to the adapter alone, or a re-binding, keeps the proofs.
  `probe_digest` is the same without fixtures, and each fixture also has its
  own digest, so a fixture added later runs alone.
- `check_digest` is what a package checks: `checks.json` without fixtures and
  binding, the rest of `tests/` apart from the fixtures, and the kit's
  `verifier/`. A reviewer's verdict on a line is kept while it stays the
  same.
