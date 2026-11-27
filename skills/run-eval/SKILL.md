---
name: run-eval
description: Have the user confirm the checks of Genesis EDD eval packages, run them with Harbor in local Docker, record a fixed baseline before a change, and compare later runs with it check by check. Use once write-eval has packages, both before and after code is changed. Writing specs, packages or application code are separate stages.
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
`GENESIS_EDD_HARBOR='["uvx","--from","harbor==0.27.0","harbor"]'`, which needs no
global install. Genesis EDD is checked with Harbor 0.27.0. A model run costs
money: confirm the model and the expected cost with the user unless that run is
already authorized.

A run builds Docker images and runs Harbor, which takes a minute or more per
package. Run `run start` with the longest timeout your shell tool allows, or in
the background, and wait for it to finish; do not stop it midway. A stopped run
can leave Harbor's containers running. Their names start with the package id,
cut to 32 characters; `docker compose ls --all` lists their projects, and
`docker compose -p <project> down` removes one.

## Order of work

1. Run `edd workflow check run-eval <change> --repo <app>`. Route package gaps
   to `write-eval` and Spec gaps to `agent-spec`. A missing tool is not a
   failing check: install it or ask the user to start it. While no loop runs
   and the user has not confirmed the checks of the packages as they are,
   `next.action` is `confirm_checks` and `next.command` is `eval review`: do
   step 2 first. Then its `next.command` is
   the baseline command until a baseline is recorded for this Spec, and again
   while no loop runs and the recorded one has a `baseline_mismatch`, fixed no
   number of attempts while a package now declares a live dependency, or, on
   code that is still the baseline's, ran other eval packages than the ones
   now or another run plan than the user confirmed, with `--expect` once
   `baseline-expectations.json` exists. In a new project where no package
   can run yet, `confirm_checks` comes before the packages are connected, and
   the baseline command then records `--unavailable no_implementation`.
   `next.note`
   says which; for a mismatch, follow `baseline_mismatch` under Recover gaps
   before recording again. Once a baseline is recorded and no loop runs,
   `next.action` is `start_loop` while the code is still the baseline's: to
   have the change implemented, start the loop in `loop-and-implement` before
   changing any code. After the code has changed outside a loop, it is
   `run_eval`, and a loop starts on that baseline only once the code is the
   baseline's again, as `workflow check loop-and-implement` says. A baseline
   recorded with `--unavailable` describes the code and the packages it was
   recorded with: once the code is known to have changed since, or a package
   differs, `next.action` is `record_baseline`, on the code the loop starts
   from. While a finished package waits
   only for `eval check`, `next.action` is `check_evals`: every run skips such
   a package, and a loop starts only on a baseline that ran it.
   Until a loop of this change is accepted, every base record goes on the
   start code of the change's first unaccepted loop, which the note names: a
   base record on other code is refused (`baseline_after_change`). That holds
   after a loop ended or stopped, and after the Spec was exported again while
   a loop the user has not accepted ran. Once the baseline is recorded there,
   `next.action` is `start_loop` with plain `loop start`, whatever the code
   is: bring back the changes you set aside, then, once the user agrees,
   start it. While a loop has ended or stopped, `workflow check` never names
   a head run of it, and a new loop needs the user's go-ahead; while a stop
   holds or the budget is used up and only the report, the final review or
   the acceptance is left, it names `loop_status`. Inside a loop, always
   follow `loop status`. After the
   user accepts a run of the loop, and while the code is still that run's and
   no later run fails, `next.action` is `loop_done`: the loop is finished, and
   `loop status` says what is left. The baseline command passes no
   `--attempts`, `--agent` or `--model`, inside a loop or outside one: once
   the checks are confirmed, the baseline reads the user's number, the agent
   and the model from `confirmed.json`. A baseline recorded again after a
   package changed, before the user confirmed that change, also passes none:
   it reads the plan the user last confirmed for this Spec export, with the
   agent and model of harness.json once it changed since, records that plan
   as its own, and `eval confirm --reason` follows before `loop start`. Outside
   a loop, `eval review` lists a baseline recorded with a plan of its own in
   `must_decide` (`baseline_plan_recorded`) while no confirmation covers it.
   A baseline that skipped a package waiting for `eval check` says so in its
   `next`: prove the package, then record the baseline again.
2. Confirm the checks with the user, once, before the baseline. Run
   `edd eval review <change> --repo <app>`. If write-eval has not had the
   checks reviewed yet, do that first, as its
   `references/review.md` says: the reviewer's counterexamples, proved with
   `eval check`, then their answers in `.genesis/edd/<change>/review.json`,
   written from the `review_template` of an `eval review` run after the
   counterexamples. In a new project no package can run before the loop
   connects it: the reviewer judges each check against its line now, from
   `checks.json`, and answers into `review.json`; the counterexamples are
   written and proved with `eval check` once the loop connects the packages.
   Connecting them ends that first loop, and the user confirms the connected
   packages then, before a new loop, as `loop-and-implement` says. Write the
   expected
   baseline result of each check into `baseline-expectations.json` (step 3)
   before this, so the user sees it. Then show the user, in one message: the
   line table (`lines`), the `must_decide` items, the expected baseline
   results, the number of attempts with its cost and what it rules out, the
   model, and the budget of the loop (full runs and minutes, by default 5 and
   60).
   - A package whose `tests/checks.json` declares a `live` dependency, such as
     a model call, can give different results from one attempt to the next, so
     it runs N attempts at the baseline and in the loop's final run; every
     other package runs once. With N above 1, each iteration of the loop first
     makes a screen run of one attempt of each package, and only the final run,
     on the code of a passing screen run, can be accepted. N is the user's
     decision. Propose 5, or 3 when the budget is tight; 1 is allowed, and the
     acceptance will then say it rests on a single attempt. Give the cost
     from `run_plan.estimate`: for 1, 3 and 5 attempts, the minutes of the
     baseline, of a screen run and of the final run, from the attempt times
     of the last `eval check`; final runs count toward the budget. Those
     times are a lower bound, since a fixture does not run the evaluated
     agent and makes no model call: with a model call, add its price per
     attempt. `run_plan.not_counted` names what the CLI cannot see, such as
     the reviewer's passes in `eval review` and in the final review, which run
     in your coding agent: add your own estimate of them, and tell the user
     that the CLI does not count them. The estimate counts only ready
     packages: when `run_plan.estimate_missing` names one, prove it with
     `eval check` and run `eval review` again before you give the cost. In a
     new project no package runs before the loop connects it, so the CLI has
     no estimate yet: give the user your own estimate of a run, and say that
     the CLI has none. No package declares its dependencies there yet either:
     if a scenario may call a model, ask for N now, since declaring a live
     dependency later changes the package, which ends a running loop and
     needs the user's number before a new one. Say what N rules out, from
     `run_plan.strength`: a check that fails half the time still passes all N
     attempts with a 50%, 13% or 3% chance for N = 1, 3 or 5, and one that
     fails one time in ten with a 90%, 73% or 59% chance.
   - When `harness.json` names a model and a package declares no live
     dependency (`run_plan.undeclared`), ask whether its scenario calls the
     model; if it does, declare it in `write-eval` and prove the package
     again with `eval check` first.

   After the user's own words, record them:
   `edd eval confirm <change> --repo <app> --verdicts .genesis/edd/<change>/review.json --by <name> --ref <where they said so> [--attempts N] [--max-iterations N] [--max-minutes M]`.
   The number, the agent and the model stay fixed for the whole loop, and
   `loop start` takes the budget from there. A later confirmation with another
   run plan or other packages ends a running loop (`confirmation_changed`);
   one with the same plan and packages, such as a new budget, leaves it as it
   is, with its own budget.
3. Record the baseline before any code for this change is written, without
   `--attempts`, `--agent` or `--model`: it runs the confirmed plan, and other
   values are refused (`run_plan_differs`); once a loop has started for this
   Spec export, any of those flags is refused (`run_plan_fixed`).
   - **An implementation exists:** write the expected baseline result of each
     check from what this change does, then run
     `edd run start <change> --repo <app> --baseline --expect <file>`.
     A check for a new ability is expected to `fail`; a check that guards
     existing behavior is expected to `pass`; use `any` when neither is known.
     Decide from the change, not from the wording of the requirement.
   - **Nothing can run yet,** as in a new project: run
     `edd run start <change> --repo <app> --baseline --unavailable no_implementation`.
     It records that no baseline exists and executes nothing.
   A baseline recorded without a confirmation, outside a loop, runs with a
   warning and needs `--attempts N` while a package declares a live
   dependency, but no loop starts on it until the user confirms the same
   plan.
4. To implement the change, start the loop in `loop-and-implement` now, before
   any code changes; it makes the head runs. Outside a loop, after the code
   changes, run `edd run start <change> --repo <app>`. Each head run is
   compared with that one baseline. Inside a loop, follow `loop status` after a
   run: the report and the final review come before the final run, when the
   loop has one, and before the user is asked to accept.
5. Read the returned summary, then `run.json`, `compare.json`, each case's
   `attempts.json` and its `logs/` in the run folder. Report every check with
   its before and after result and its passes out of its attempts, and say
   which kind of evidence stands behind the verdict. The summary counts every
   check under `compare` and the gating ones alone under `compare_gating`; only
   gating checks decide the verdict. Say too what the run took, from `usage`
   in `run.json`: its minutes and, when the agent adapter reported them, its
   cost and tokens. An adapter that reports nothing leaves them unknown, and
   the run warns when the agent ran with a model.

The expectation file is a JSON array. Keep it beside the packages, as
`.genesis/edd/<change>/baseline-expectations.json`:

```json
[{ "case": "submit-failure-s1", "check": "c1", "expected": "fail", "reason": "The failure branch is added by this change." }]
```

At the baseline, each package with a live dependency runs the N attempts the
user confirmed, and every other package runs once; a partial run (`--case`)
runs each package once. A check must hold every time: one failing attempt
fails it, so a check that passes in some attempts and fails in others is a
failure, marked `flaky`. Look for what differs between the attempts, in each
one's trial folder under `logs/harbor/`, before calling it noise. Outside a
loop, full head runs follow the baseline's plan without `--attempts`;
`--attempts`, `--agent` and `--model` override it, and a head run whose
settings differ from the baseline's warns, because its comparison may show
that difference rather than the change. Once a loop has started for this
Spec export, while `loop.json` is for it, after the loop ended too, `run start`
reads the run plan from the loop's checks confirmation and refuses
`--attempts`, `--agent` and `--model` before anything runs, on a base record
too (`run_plan_fixed`). Inside a loop, when the plan runs a package with a
live dependency more than once, each iteration's full run is a screen run,
with one attempt of each package, and the final run, which `loop status` asks for once a screen
run passed and was reviewed, runs the plan's N; otherwise every full run
follows the plan. To change the plan, the user confirms another one with
`eval confirm`, which ends the loop; a new loop needs a baseline of that plan
on its start code.

Runs add up: results of the same code, packages, agent and model are counted
together across runs, and one failure among them stays a failure, in every
loop of the Spec export. A later pass of that code never cancels it. The
count reads `runs/`, which Git ignores, so it covers the runs of this machine.

## Rules

- A baseline is the code before the change. Never rerun it on changed code, and
  never treat a first head run as one. If packages changed since the baseline,
  the affected checks are reported as `head_only`. Until a loop of this change
  is accepted, any base record, `--unavailable` included, is refused on code
  other than the start code of the change's first unaccepted loop
  (`baseline_after_change`), whatever Spec export it is for. A loop that runs
  keeps comparing its head runs with its own baseline; a new loop, after it
  ended and once the user agrees, may start on a baseline recorded again
  there. Once the user accepted a loop, the baseline of a new export may go on
  the accepted code or later.
- Do not edit the code, a package or the project kit while a run executes. A
  run during which the code changed records `code_changed_during_run`, and one
  during which a package or the kit changed records
  `packages_changed_during_run`; neither passes or is a baseline. Prove
  changed packages with `eval check`, then run again. Inside a loop, a package
  or kit file that still differs afterwards ends the loop.
- Do not edit a check, an expectation or the Spec to produce a failing
  baseline or a passing head. A baseline that does not match its expectation is
  recorded as a mismatch and investigated. Never change an expectation because
  a check was unstable at the baseline.
- Never change the number of attempts, the agent or the model after the
  baseline without the user's agreement. Before a loop starts, changing them
  means a new `eval confirm` with them, then the baseline recorded again,
  which reads them. Inside a loop the plan is fixed: the user's
  `eval confirm` of another plan ends the loop, and a new loop, once they
  agree, needs the baseline recorded again on its start code, which reads
  that plan.
- `unknown` is missing evidence. A blocked or failed execution is reported as
  such, with the reason, and never as a business failure.
- Meeting acceptance and proving an improvement are separate claims. A `pass`
  verdict with `head_only` checks says the code meets the requirement; it does
  not say the change caused it.
- Pass `--yes` only when the user agreed that Harbor may read the host
  environment variables a package names.

## Recover gaps

- `baseline_missing`: record the baseline first, as in step 3.
- `checks_unconfirmed`: the user has not confirmed the checks of this Spec
  export, the latest confirmation is for another export, or a package changed
  since. Do step 2: `eval review`, the reviewer's answers in `review.json`,
  then `eval confirm` with the user's words, and `--reason` when this export
  was confirmed before.
- `run_plan_differs`: a baseline would use other attempts, an agent or a
  model than the user confirmed. Run it without `--attempts`, `--agent` and
  `--model`. To change the plan, show the user and record a new
  `eval confirm --reason` with the new flags first.
- `run_plan_fixed`: `run start` was given `--attempts`, `--agent` or
  `--model` while a loop has started for this Spec export, also with the
  loop's own values, and on a base record too. Run it without them: a head
  run reads the plan from the loop's checks confirmation, and a baseline from
  the latest confirmation. Do not edit `harness.json` to get another agent or
  model: that changes the kit, which ends the loop. Changing the plan is the
  user's decision: their `eval confirm` of another plan ends the loop, and a
  new loop needs a baseline of that plan on its start code.
- `baseline_plan_differs`: `loop start` found a baseline that ran another
  plan than the user confirmed, or, for a baseline recorded with
  `--unavailable`, keeps another one for the loop's head runs. Record the
  baseline again on the code before the change, without `--attempts`,
  `--agent` and `--model`, since it reads the confirmed plan, and with the
  same `--unavailable` reason for one that recorded that nothing could run;
  or the user confirms another plan.
- `confirmation_invalid`, `confirmation_unreadable`: `confirmed.json` was
  edited by hand or cannot be read. Restore it from Git. An invalid one can be
  replaced by recording the user's confirmation again with `eval confirm`.
- `eval confirm` refusals (`line_not_faithful`, `manual_disputed`,
  `package_loosens`, `review_stale`, `review_unreadable`, `reason_missing`):
  see write-eval's `references/review.md`. A check the reviewer did not judge
  `faithful` goes back to `write-eval`; it is never confirmed as it is.
- `attempts_undecided`: a package declares a live dependency, or the kit names
  a model and a ready package declares none, and neither the confirmation nor
  the baseline fixed a number of attempts. Agree N with the user as in step 2,
  and record it with `eval confirm --attempts N`, with `--reason` when this
  export was confirmed before. A package that declares a live dependency
  after a baseline that fixed no number needs the user's N and the baseline
  recorded again: record N with `eval confirm --attempts N`, then the baseline
  again, which reads it, keeping `--unavailable <its reason>` when the
  baseline recorded that nothing could run, and start the loop once the user
  agrees.
- `baseline_unstable`: not a gap, but a note on the baseline and a warning: a
  check passed in some attempts and failed in others. Its result before the
  change is not settled, so it is never a `baseline_mismatch` and a later pass
  shows nothing about the change. Read the attempts' logs, tell the user
  before the loop starts, and leave its expectation as it is.
- `baseline_mismatch`: the baseline did not behave as declared, and no loop
  starts on it. Find out why first. If the expectation was wrong, correct it in
  `baseline-expectations.json`, say why, and record the baseline again with
  it; if the code was not the code before the change, restore that code and
  record the baseline there. Ask the user when it is unclear what that code
  does.
- `baseline_after_change`: until a loop of this change is accepted, every
  base record goes on the start code of the change's first unaccepted loop,
  whatever Spec export it is for, and the code is not that now. This holds
  while a loop runs, after it ended or stopped, and after the Spec was
  exported again. Do not record a baseline on the code as it is: set your
  changes aside, restore the start code the message names, record the
  baseline there, and bring your changes back, as `loop-and-implement` says;
  then start a new loop with `loop start` once the loop ended and the user
  agrees.
- `baseline_not_at_start`: `loop start` found a baseline that ran on other
  code than the loop would start on. Before the first loop of the change, the
  code changed after the baseline. Never record the baseline on the changed
  code. If only files for the evals changed, such as `.dockerignore`, record
  it again with the same `--expect` file and no plan flags: it reads the plan
  the user confirmed. Otherwise follow the message: it gives the commands that
  set the edits aside, start the loop and bring them back, or, when the commit
  itself holds other application files, says to agree a way back with the
  user. After a loop of the change ended or stopped, and until one is
  accepted, a new loop keeps the start code of the change's first unaccepted
  loop, and its baseline ran elsewhere: record it again there; your changes
  may be back when you run `loop start`. A baseline recorded with
  `--unavailable` is refused once the code is known to have changed since it:
  record it again on the code the loop starts from, with the same reason.
- `baseline_packages_differ`: the baseline ran other eval packages than the
  ones now: a package changed or is gone since, was connected after it, or
  waited for `eval check` when it ran and was skipped. Every run of a loop is
  compared with its baseline, so prove such a package with `eval check`, and
  once the user confirmed the changed packages, record the baseline again on
  the code before the change, with the same `--expect` file and no plan
  flags, then start the loop.
- `packages_changed`: an eval package changed after the run named for
  `loop accept`. A loop's packages are fixed, so the loop has ended
  (`loop_ended`, reason `packages_changed`): going on needs the user's
  `eval confirm` and a new loop.
- `packages_changed_during_run`: a package or the kit changed while the run
  named for `loop accept` executed. Run again without editing them.
- `unstable`: a gating check failed on the code and packages of the run named
  for `loop accept`, in another run before or after it. That failure always
  counts, so no run of that code can be accepted; the user decides, see
  `loop-and-implement`.
- `loop_baseline_missing`: the loop's baseline run folder is gone, so the loop
  has ended (`baseline_missing`). Restore the folder to go on with it, or
  record a baseline on the loop's start code and, once the user agrees, start
  a new loop.
- `loop_ended`, and a stop as a gap (`stop_budget`, `stop_stuck`,
  `stop_unstable`, `stop_incomplete`, `stop_no_gating`): `run start` refuses
  a head run of a loop that ended or stopped, before anything runs, and
  `loop accept` refuses that loop. Until the user's acceptance covers the
  loop (`loop status` says `done`), `run start` also refuses a head run once
  the budget is used up (`stop_budget`, reason `budget_used_up`). See When a
  loop ends in `loop-and-implement`.
- `harness_missing`: name the evaluated agent with `--agent`, or write
  `.genesis/edd/harness/harness.json`; see the write-eval environment reference.
- `harbor_missing`, `docker_unavailable`: fix the machine, then rerun the
  returned `resume.command`.
- `no_runnable_case` and package gaps: return to `write-eval`. A package is
  ready only while its last `eval check` matches it, so an edit to a package or
  to the project kit sends it back there. A connected package missing only
  `review` needs a reviewer's counterexamples first, proved with `eval check`.

A head run in which an attempt errored and a gating check failed in another
attempt that completed did not complete, but that failure is a result of the
code and counts, and its `next` says so: fix the cause of the error, and
change the code before the next run.

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
