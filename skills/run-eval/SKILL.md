---
name: run-eval
description: Run Genesis EDD eval packages with Harbor in local Docker, record a fixed baseline before a change, and compare later runs with it check by check. Use once write-eval has packages, both before and after code is changed. Writing specs, packages or application code are separate stages.
---

# Run Eval

Run the eval packages of one change against the code as it is now, and keep
what happened. The CLI starts Harbor, stores each run once under
`.genesis/edd/<change>/runs/`, and compares a run with the baseline. It never
edits a package, a Spec or application code.

## Tool and context

The CLI starts through the launcher of the `agent-spec` skill, installed beside
this one. Run `node /absolute/path/to/agent-spec/scripts/run.mjs --version` to
locate it. In commands below, `edd` means that complete command without
`--version`. Always use the explicit path, not an executable found in the project.
If the launcher reports that its dependencies are not installed, run the command
it prints. It installs pinned npm packages inside the Genesis EDD package, needs
network access, and may need the user's approval outside a sandbox. Then retry.

Read [references/run-records.md](references/run-records.md) before reporting a
result. A run needs Docker running and Harbor. The CLI runs `harbor` from the
`PATH`; when it is not installed there, set `GENESIS_EDD_HARBOR` to the command
as a JSON array, for example
`GENESIS_EDD_HARBOR='["uvx","--from","harbor","harbor"]'`, which needs no global
install. A model run costs money: confirm the model and the expected cost with
the user unless that run is already authorized.

## Order of work

1. Run `edd workflow check run-eval <change> --repo <app>`. Route package gaps
   to `write-eval` and Spec gaps to `agent-spec`. A missing tool is not a
   failing check: install it or ask the user to start it. Its `next.command` is
   the baseline command until a baseline is recorded for this Spec.
2. Record the baseline before any code for this change is written.
   - **An implementation exists:** write the expected baseline result of each
     check from what this change does, then run
     `edd run start <change> --repo <app> --baseline --expect <file>`. A check
     for a new ability is expected to `fail`; a check that guards existing
     behavior is expected to `pass`; use `any` when neither is known. Decide
     from the change, not from the wording of the requirement.
   - **Nothing can run yet,** as in a new project: run
     `edd run start <change> --repo <app> --baseline --unavailable no_implementation`.
     It records that no baseline exists and executes nothing.
3. After the code changes, run `edd run start <change> --repo <app>`. Each head
   run is compared with that one baseline.
4. Read the returned summary, then `run.json`, `compare.json` and each case's
   `logs/` in the run folder. Report every check with its before and after
   result, and say which kind of evidence stands behind the verdict.

The expectation file is a JSON array. Keep it beside the packages, as
`.genesis/edd/<change>/baseline-expectations.json`:

```json
[{ "case": "submit-failure-s1", "check": "c1", "expected": "fail", "reason": "The failure branch is added by this change." }]
```

## Rules

- A baseline is the code before the change. Never rerun it on changed code, and
  never treat a first head run as one. If packages changed since the baseline,
  the affected checks are reported as `head_only`.
- Do not edit a check, an expectation or the Spec to produce a failing
  baseline or a passing head. A baseline that does not match its expectation is
  recorded as a mismatch and investigated.
- `unknown` is missing evidence. A blocked or failed execution is reported as
  such, with the reason, and never as a business failure.
- Meeting acceptance and proving an improvement are separate claims. A `pass`
  verdict with `head_only` checks says the code meets the requirement; it does
  not say the change caused it.
- Pass `--yes` only when the user agreed that Harbor may read the host
  environment variables a package names.

## Recover gaps

- `baseline_missing`: record the baseline first, as in step 2.
- `harness_missing`: name the evaluated agent with `--agent`, or write
  `.genesis/edd/harness/harness.json`; see the write-eval environment reference.
- `harbor_missing`, `docker_unavailable`: fix the machine, then rerun the
  returned `resume.command`.
- `no_runnable_case` and package gaps: return to `write-eval`. A package is
  ready only while its last `eval check` matches it, so an edit to a package or
  to the project kit sends it back there.

A run that reports `execution_status` other than `completed` or `not_run` exits
nonzero. Read its `cases[].execution.reason` and the case's `logs/harbor.log`
before retrying; do not retry an unchanged failure in a loop.

## When a run does not pass

Read the case's `logs/` first, then classify before changing anything:

- the requirement is unclear or contradictory: return to `agent-spec`;
- the package or its environment is wrong: return to `write-eval`, and keep the
  old result as unverified;
- the application does not meet a confirmed requirement: that is the result.
  Changing the code to meet it belongs to `loop-and-implement`, when the user
  wants the implementation.
