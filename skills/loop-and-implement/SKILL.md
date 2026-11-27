---
name: loop-and-implement
description: Implement a change against Genesis EDD eval packages and iterate on their evidence until every gating check passes, the budget runs out, progress stops, the loop ends, or the user must decide. Use after run-eval has recorded a baseline, when the user wants the code written or fixed. Writing specs and eval packages are separate stages.
---

# Loop and Implement

Change the application until the eval packages of an exported Spec pass,
without moving the target. A loop fixes its inputs when it starts: the Spec
export, the baseline, the eval packages and the project kit the user
confirmed, and the run plan (the number of attempts, the agent and the
model). The CLI enforces all of them. When one of them changes, or a rule that
decides whether a pass can be trusted cannot hold, the loop ends: `loop status`
says why and what changed, `run start` refuses its head runs, and you take
over as [When a loop ends](#when-a-loop-ends) says. Every full run gets a short
report, so a person can audit each step.

## Tool and context

The CLI starts through the launcher of the `agent-spec` skill, installed beside
this one. Run `node /absolute/path/to/agent-spec/scripts/run.mjs --version` to
locate it. In commands below, `edd` means that complete command without
`--version`. Always use the explicit path, not an executable found in the project.
If the launcher reports that its dependencies are not installed, run the command
it prints. It installs pinned npm packages inside the Genesis EDD package, needs
network access, and may need the user's approval outside a sandbox. Then retry.

Read [references/causes.md](references/causes.md) before classifying a failure.
Runs need Docker and Harbor, as in run-eval. `run start` and `eval check` build
Docker images and run Harbor, which takes a minute or more per package. Run
them with the longest timeout your shell tool allows, or in the background, and
wait for them to finish; do not stop one midway. A stopped command can leave
Harbor's containers running. Their names start with the package id, cut to 32
characters; `docker compose ls --all` lists their projects, and
`docker compose -p <project> down` removes one.

## Before the first change

1. Run `edd workflow check loop-and-implement <change> --repo <app>`. Repair
   gaps where `route` says: the Spec in `agent-spec`, packages in `write-eval`,
   the baseline in `run-eval`.
2. Get the user's go-ahead to change code. The budget, the number of
   attempts and the model were confirmed with the checks before the baseline,
   in run-eval, and `confirmed.json` keeps them: `loop start` takes the budget
   from there. Ask the user again only when `loop start` says `budget_unfit`:
   by earlier attempts, the confirmed number of full runs does not fit in the
   confirmed minutes. The estimate takes the times of the baseline's attempts,
   or, without them, those of the last `eval check` or the baseline's whole
   run, and the message says which. It counts only the Docker time of those
   attempts: when you propose a budget, add your own estimate of the final
   review's reviewer passes, and of the model calls when the estimate comes
   from `eval check`, whose fixtures make none, and tell the user the CLI does
   not count them. Then pass the budget they agree to with `--max-iterations` and
   `--max-minutes`. `loop status` keeps the estimate as `loop.estimate`.
   A new loop for the same change, after one ended or stopped, needs the
   user's go-ahead again: ask before every `loop start`, since the CLI cannot
   tell that a person agreed.
3. If you added files only for the evals after the baseline, such as
   `.dockerignore`, and no loop of this change has started yet, record the
   baseline again with the same `--expect` file and no `--attempts`, `--agent`
   or `--model`: it reads the plan the user confirmed from `confirmed.json`.
   Once a loop has started, every base record goes on its start code until a
   loop of the change is accepted (see Rules), so such a file cannot join the
   baseline then. `loop start` refuses a baseline that ran on other code
   (`baseline_not_at_start`), and a baseline recorded with `--unavailable`
   once the code is known to have changed since it: record that one again on
   the code the loop starts from. It refuses a baseline with a
   `baseline_mismatch`: either the expectation in
   `baseline-expectations.json` is wrong, so fix it and record the baseline
   again, or the code is not the code before the change. It refuses a baseline
   that ran other eval packages than the ones now too
   (`baseline_packages_differ`), such as a package changed or connected after
   it, or one that waited for `eval check` when it ran, which every run skips:
   prove such a package with `eval check`, and once the user confirmed the
   changed packages, record the baseline again with the same `--expect` file
   and no plan flags. It refuses packages the user has not confirmed, or that
   changed since they did (`checks_unconfirmed`): confirm them in run-eval,
   with `--reason` for a revision. It refuses a baseline that ran another
   plan than the user confirmed (`baseline_plan_differs`), also one that
   records that nothing could run, whose plan every head run takes: record it
   again without `--attempts`, `--agent` and `--model`, since it reads the
   confirmed plan, or the user confirms another plan. It refuses a baseline
   that fixed no number of attempts once a package declares a live dependency
   (`attempts_undecided`): that number is the user's. It refuses packages
   still in checks.json 1.0 (`then_unbound`): upgrade them in `write-eval`,
   then record the baseline again. And it refuses a change whose every THEN
   line is in `scenario.manual` (`gating_missing`): a run passes only on
   gating checks, so no run of it can pass. Tell the user.
4. Before changing any code, run `edd loop start <change> --repo <app>`. It
   takes the confirmed budget; `--max-iterations N --max-minutes M` replace
   it, and it warns when they exceed it.
   It refuses a baseline that ran on other code; if the code already changed,
   its message says how to set the edits aside and bring them back, or, when
   the commit itself holds other application files, to agree a way back with
   the user. A baseline recorded with `--unavailable` describes the code it
   was recorded on too, so start the loop before changing any code. It
   refuses while a loop for this Spec export has not ended and can still
   make a head run (`loop_running`): follow `loop status` instead. Once the user accepted the loop of this Spec
   export, it refuses with `loop_accepted`: a new loop for the change follows
   a new Spec export.

Nothing has to be committed. Every run stores its code as the commit it started
from plus `code.patch` in the run folder, with everything that commit does not
hold. Commit on a branch if you can and the user wants it. If `.git` is
read-only, as in Codex's sandbox, carry on without commits; never work around it
with a second checkout. When a patch cannot be written, `run start` or
`loop start` warns that the code cannot be restored: keep a copy of the
uncommitted files before changing them.

## Each iteration

1. Run `edd loop status <change> --repo <app>` and do what `next.action` says.
   When it names a step that ends the loop, stop iterating and follow
   [When a loop ends](#when-a-loop-ends).
2. Read the evidence before changing anything: `compare.json`, and each failing
   case's `logs/`, which hold the program's output, the verifier's output and
   the stand-in services' records.
3. Classify every check that does not hold with
   [references/causes.md](references/causes.md), and change the layer the
   evidence points to, not the one that is easiest to change. A fault in a
   package or the kit is fixed in `write-eval`, and that fix ends the loop.
4. For code logic, find the root cause first, then make the smallest change
   that meets the requirement as written. Try it locally, by running the
   program or the project's own tests, before a full run.
   `edd run start <change> --repo <app> --case <id>` gives a quick look at one
   package; it never counts as passing.
5. In a project with no implementation, the first loop starts on a baseline
   recorded with `--unavailable no_implementation`, before any package is
   connected: `loop status` says `iterate`, and `run start` has nothing to
   run. Write the code's entry point, then return to `write-eval` to connect
   the packages. Connecting them changes the packages and the kit, so it ends
   this loop (`loop_ended`, reason `packages_changed`), and the message says
   that this is the expected step. What follows, before any head run: prove
   the connected packages with `eval check`; run `eval review`, have a
   reviewer write the counterexamples without reading the verifier, prove
   them with `eval check`, and have the reviewer answer a second
   `eval review` into `review.json`; the user confirms the packages with
   `eval confirm --reason`; record the baseline again on the loop's start
   code with `run start --baseline --unavailable no_implementation`, with your
   changes set aside (see When a loop ends); bring your changes back; then,
   once the user agrees, start a new loop with `loop start`. The expected
   results stay as they are.
6. Run the project's existing tests, if it has any. A check covers only its
   scenario; those tests guard the rest of the application.
7. Run `edd run start <change> --repo <app>`, with no `--attempts`, `--agent`
   or `--model`: inside a loop, `run start` reads the run plan from the loop's
   checks confirmation, and refuses those flags before anything runs
   (`run_plan_fixed`). In a loop whose run plan runs a package with a live
   dependency more than once, the full run of an iteration is a screen run,
   with one attempt of each package; the CLI decides when the next full run is
   the final run, which follows the plan (see `final_run` below). Without such
   a package, every full run follows the plan. A baseline recorded by an
   earlier version, before runs followed a run plan, with more than one
   attempt also gives screen and final runs, and its final run repeats every
   package. Leave the code, the packages and the project kit, `harness.json`
   included, as they are while it runs: a run during which one of them changed
   neither passes nor adds to the results of that code, though it still uses
   one run of the budget, and a package or kit file that still differs
   afterwards ends the loop. Editing `harness.json` is a kit change and ends
   the loop too. If the number of attempts, the agent or the model has to
   change, ask the user: their `eval confirm` of another plan ends this loop
   (`confirmation_changed`), and a new loop needs a baseline of that plan on
   the loop's start code.
8. Run `edd loop report <change> --repo <app>` and fill in the sections its
   `next` names: Cause, Changes and Next, or fewer, such as only Next for a
   final run where every check holds. Its Result table names the THEN line
   each check verifies, lists below it the packages a final run did not run
   because it stopped early, and the lines no check verifies, which the user
   judges. Leave Review empty: it is written only when `loop status` says
   `final_review`. The report of a final run has Review filled in. Then return
   to step 1.

## What `next.action` asks

| Action | Do |
| --- | --- |
| `iterate` | Classify the open checks it lists and change the right layer; when a package waits only for `eval check`, the message says to prove it before the run. While no package is connected yet, as in the first loop of a new project, see step 5. When something outside the packages blocks every run, such as a `.dockerignore` without its `.genesis` line, the message names it: repair it, then run again. After a failed final run, or a screen run that passed on code that already failed, that code can never be accepted with those packages: find what makes the result vary, change the code, and screen it again. One more failed final run of this loop stops it (`stop_unstable`). When the failing attempts show a fault in a package or the kit instead, fixing it in `write-eval` ends the loop. |
| `write_report` | Complete the named run's report before anything else: the sections `loop report`'s `next` names, which its template line names too. After a later screen run of the same code, it can name the final run that passed there, whose report comes before acceptance. |
| `repair_execution` | The run did not complete, and `next.route` is `run-eval`. Rerun after a build or timeout fault. A fix to the adapter or the environment changes a package or the kit, which ends this loop (`packages_changed`). The attempts that errored are not a result of the code. A gating check that failed in another attempt that completed is one, and counts: the message names it, and the code changes before the next run. A final run with such a failure counts as a failed final run instead, and `loop status` goes on from there. |
| `split_changes` | A check that passed before the change now fails. Restore the code of the last run where it passed and reapply the changes one at a time to find the one that breaks it. |
| `final_review` | The screen run passed, or, without final runs, every gating check passes. Review the change, below: the reviewer answers two questions, one of them for each check in `next.flips`. Then write Review. |
| `final_run` | The screen run passed and its final review is done. Run `run start` and leave the code, the packages and the kit alone until it finishes: on the same code it runs each package with a live dependency the planned number of times and every other package once, the packages that failed before first, and it stops at the first package that fails. After a final run with missing evidence and no failure, it asks for one more on the same code when the cause was outside the packages and the kit, such as the machine or Docker. `run start` makes the final run whenever one is due on the code as it is now. Its message says about how long the final run takes by earlier attempts and which ones, and what its model calls cost when the attempts reported that; an estimate from `eval check` fixtures makes no model call and is a lower bound. When the estimate, from the loop's own runs once every package has some, does not fit the minutes left, `loop status` says `stop_budget` instead. |
| `run_again` | The code changed while the latest run executed, or a package or the kit changed during it and is back as it was, so its results belong to no one version of them; or the latest run passed and the code changed after it, so neither that run nor an acceptance of it covers the code now. Leave the code, the packages and the kit as they are during a run, prove a package that waits for it with `eval check` (`next.command` is `eval check` then), and run every package again. |
| `ask_acceptance` | Ask the user to accept, below, and show them `next.strength.sentence`. In a loop with final runs this comes only for a passing final run, which `next.command` names, also after a later screen run of the same code. |
| `done` | The user accepted a run of this loop, the code is still that run's, no later full run fails in an attempt that completed, and no run of the accepted code and packages that started after the accepted run fails a gating check; an eval package changed after the acceptance only warns. Offer to commit, merge or open a pull request. `next.uncommitted` lists the change's own files still to commit, such as reports and `accepted.json`; once everything is committed, `next.commit` names the commit and only a merge or pull request is left. |
| `repair_spec` | The Spec files differ from the export the loop started from, or that Spec no longer validates. Restore what changed. A requirement that must change is the user's decision, through `agent-spec`; a new export then ends this loop. |
| `loop_ended` | A fixed input of the loop changed. `next.reason` says which: `spec_exported`, `packages_changed`, `confirmation_changed` or `baseline_missing`, and `ended` holds the same facts. See [When a loop ends](#when-a-loop-ends). |
| `stop_budget` | The budget is used up (`next.reason` `budget_used_up`), or the final run, estimated from the loop's own runs, does not fit the minutes left (`final_run_does_not_fit`, with `next.estimate`). Stop and report; when only the final run is left, the message says what it takes. A bigger budget goes to a new loop, once the user agrees: `next.command` is `loop start` with `--max-iterations <N> --max-minutes <M>`, for the numbers the user gives. A new loop counts only its own runs: when only the final run was left, it screens and reviews the same code again before its final run, and its first `loop status` says so (`iterate`, with `next.command` `run start`): run it without changing the code. |
| `stop_stuck` | The same gating checks failed in the last two full runs on different code. Stop and ask the user how to proceed. A code change does not lift this stop. |
| `stop_unstable` | Without final runs: a gating check passed and failed on the code and packages of a run of this loop; `unstable` lists the runs. With final runs: two final runs of this loop failed, or a gating check failed on the code of a final run that passed. Only a run recorded as a final run counts as one that failed, also when an attempt of it errored while a gating check failed in another that completed. A failure of the same code always counts, so another run of it only adds to the count and no run of it can be accepted. Stop and tell the user what the runs showed. They decide: find and fix what makes the result vary, or change the requirement through `agent-spec`. A code change does not lift this stop: going on is a new loop, which keeps the start code, and the failures of the same code still count there. |
| `stop_incomplete` | Two final runs of the same code and packages found no failure but left checks unknown, so no third one is made. Stop and tell the user what kept the evidence from being read. They decide how to go on: a new loop, once they agree, screens and reviews the code again before its final run, and a fix to a package or the kit needs `eval check`, `eval review` and their `eval confirm` first. |
| `stop_no_gating` | No package has a gating check left: the user judges every THEN line, so no run can pass. Stop and tell the user. A line a program can judge needs a gating check, written with `write-eval`. |

## When a loop ends

A loop ends when `loop status` names `loop_ended` or a stop: `stop_budget`,
`stop_stuck`, `stop_unstable`, `stop_incomplete` or `stop_no_gating`. From then
on `run start` refuses its head runs, partial ones included, before anything
runs, and `loop accept` refuses it; the gap is `loop_ended`, with the reason,
or the stop. The CLI does not script the way on: it says what changed, and you
take over. A stop holds for good, since the runs it rests on no longer change;
`stop` in `loop status` names it, also while `next` still asks for the last
run's report first.
An end lasts while its input differs: putting that input back as it was, such
as a package file edited by mistake, or the baseline's run folder, lifts it.

The reasons of `loop_ended`:

- `spec_exported`: the Spec was exported again. Bring the packages in line
  with the new export in `write-eval`; the user confirms the checks of the new
  export. Expected results never change inside a loop. This end comes after
  an acceptance too (`ended.accepted` is true): the loop for the new export
  may then start from the accepted code.
- `packages_changed`: an eval package or a kit file differs from the checks
  the user confirmed for this loop; the message names the files. You may fix
  the packages in `write-eval` and run `eval check` and `eval review`. Going
  on needs the user's `eval confirm --reason` of the packages as they are,
  with the reviewer's answers on their diff. In the first loop of a new
  project this is the expected end once the packages are connected (Each
  iteration, step 5). A package set to `draft` holds a business decision: it
  is the user's, through `agent-spec`.
- `confirmation_changed`: the user's newest checks confirmation of this Spec
  export has another run plan or other packages than the loop's. A new loop
  needs a baseline of that plan and those packages on the start code. Once a
  confirmation covers the changed packages of a `packages_changed` end, the
  reason becomes this one.
- `baseline_missing`: the loop's baseline is no longer in `runs/`. Restore its
  run folder to go on with this loop, or record a baseline on the start code
  for a new one.

To go on after an end or a stop:

1. Stop and tell the user, as When you stop says.
2. Do what the end asks of you: fix a package in `write-eval`, prove it with
   `eval check`, and run `eval review` with a reviewer. Run `eval confirm`
   only with the user's own words.
3. Run `edd workflow check run-eval <change> --repo <app>`. After an end it
   names the next step on the way to a new loop, such as `confirm_checks`,
   `check_evals`, `record_baseline` or `start_loop`, and never a head run of
   the loop that ended; its notes say that a new loop needs the user's
   go-ahead.
4. When it says `record_baseline`, record the baseline again on the start
   code: until a loop of this change is accepted, that is the start code of
   the change's first unaccepted loop, `start_code` in `loop.json`, which the
   note names as a commit plus `loop-start.patch` when the commit does not
   hold all of it. Set your changes aside first, record the baseline, then
   bring them back, as below.
5. Ask the user before `loop start`. The new loop keeps that start code,
   takes the budget it is given (the confirmed one, or `--max-iterations` and
   `--max-minutes` for another the user agreed to), and reports what the
   earlier loops of the change used (`earlier_loops`, with a warning): tell
   the user. Failures of the same code still count in it, so code that failed
   in an earlier loop cannot be accepted in this one either.

After `stop_budget`, the loop's baseline and confirmation usually still hold,
so `loop start` with the budget the user gives starts the new loop at once.
`loop start` also starts one while the budget of the loop is used up and only
its report, its final review or the acceptance is left; finish those first
unless the user wants more runs instead. A new loop counts only its own runs,
so when the code as it is passed a run of an earlier loop, as when only the
final run was left, the first `loop status` says `iterate` with `run start`:
run every package again without changing the code; in a loop with final runs
that run is a screen run, whose report and final review come before the final
run.

To set your changes aside from the project root, with a commit:
`git stash push --include-untracked -- . ':(exclude).genesis' ':(exclude)openspec'`,
then, when the start code has a patch, `git apply` it. Record the baseline,
undo the patch with `git apply -R`, and bring your edits back with
`git stash pop`; staged changes come back unstaged. Without a commit, copy the
files you changed out of the project, put back the files as they were at the
start (`loop-start.patch` holds them), record, then copy your edits back. When
the current commit holds application files other than the start code's, as
after committing the change, a stash cannot set them aside: tell the user, and
agree with them how to put the application files back while keeping
`.genesis/` and `openspec/` as they are.

## Rules

- Never edit the Spec, its `genesis.json` or Map copy, `checks.json`, a
  fixture's expected result, a reviewer's counterexample, a verifier's
  decision or a baseline to make a check pass. A wrong check is a
  `write-eval` fix with its own evidence, proved by `eval check` and named in
  the report. A wrong or unclear requirement is the user's decision, through
  `agent-spec`.
- A loop's eval packages and project kit are fixed. Changing one ends the
  loop (`packages_changed`). The user confirms the changed packages with
  `eval confirm --reason` before a new loop, never at acceptance.
- Never special-case the eval inputs in application code: a known title, an
  ID, a fixed date.
- To go back to the code of a run, check out its `code_snapshot.commit` and
  `git apply` its `code.patch`. Keep your own changes aside first.
- Run again only after a real change, or when `loop status` asks for the
  final run, which repeats the code of its screen run. A run of the same code
  only adds to its count: it never cancels a failure.
- Until a loop of this change is accepted, every base record goes on the
  start code of the change's first unaccepted loop, whatever Spec export it
  is for: `start_code` in `loop.json`, its commit plus `loop-start.patch`
  beside it. The CLI refuses a base record on other code
  (`baseline_after_change`), and a new loop on a baseline that ran elsewhere
  (`baseline_not_at_start`). You may record the baseline again there; a loop
  that runs keeps comparing with its own baseline. Once the user accepted a
  loop, the start code is no longer held: the baseline of a new export may go
  on the accepted code or later, and the new loop records the accepted loop
  it follows (`follows` in `loop.json`). Files added for the evals after the
  first `loop start`, such as `.dockerignore`, cannot join the baseline until
  then.
- The run plan is fixed for the loop: `run start` reads it from the loop's
  checks confirmation and refuses `--attempts`, `--agent` and `--model`.
  Another plan is the user's decision: their `eval confirm` of it ends the
  loop, and a new loop needs a baseline of that plan on the start code. Say
  so in the next report.
- A new loop after one ended or stopped needs the user's go-ahead: ask first.
  It keeps the start code until a loop of the change is accepted, reports
  what the earlier loops used, and takes the budget it is given; failures of
  the same code still count.
- You may run `eval check` and `eval review` and record a baseline again.
  Run `eval confirm` and `loop accept` only with the user's own words, and
  never confirm or accept for them.
- Claim only what a run shows. "Works" needs a passing full run on the current
  code; "improved" needs a baseline in which that check failed.
- Do not push, merge or open a pull request unless the user asks.

## What the CLI checks

- The same code means the same content: `code_snapshot.digest` covers every
  tracked file and every untracked file Git does not ignore, committed or not,
  and leaves the commit out. Committing alone changes nothing, so it never
  blocks a base record on the start code, an acceptance or a new loop.
  Ignored files are not covered; keep them out of the image with
  `.dockerignore`.
- A report is complete when its first, template line is gone, Result, Cause,
  Changes and Next have content, every check listed under Cause has a cause
  after it, and a passing run also has a Review of at least 40 characters.
  `write_report` and `loop report` never ask for Review; `final_review` does,
  once the rest is complete. The report of a final run comes with Review filled
  in, pointing at its screen run's. `loop status` cannot tell when Review was
  written: a Review written before `final_review` skips that step and its
  Genesis review, so leave Review empty until then.
- Runs add up. Results of the same Spec export, code, package (its
  `task_digest`), agent and model count together: base and head runs, full and
  partial runs, and the runs of every loop of the Spec export. The count reads
  `runs/`, which Git ignores, so it covers this machine only. A run during
  which the code or a package changed, or that did not execute, adds nothing.
  Each attempt counts on its own, so a check that passed in one attempt of a
  run and failed in another passed and failed on that code. A pass or a
  failure counts only from an attempt that completed: one that did not, for
  example after a rate limit or a timeout, adds nothing even when its verifier
  recorded a failure. A missing result never counts. Without final runs, when
  a gating check passed and failed on the code and packages of a run of this
  loop, `loop status` lists it under `unstable` and says `stop_unstable`, and
  `loop accept` refuses that code with `unstable`. In a loop with final runs,
  one failed final run gives `iterate` instead, since that code can never be
  accepted, and so does a screen run that passed on code that already failed;
  `stop_unstable` comes with the second failed final run of the loop, or when
  a gating check fails on the code of a final run that passed. A full run
  recorded before runs had a role counts as a final run only when it passed,
  in `runs`, `history` and the count of incomplete final runs too. A check
  that varied only in base runs, or a diagnostic check that varied, only
  warns; say so in the report. A changed package, agent or model starts a new
  count; `loop status` warns when the code as it is now failed with an earlier
  version of a package.
- Every THEN and AND line of each package's scenario has a gating check
  whose `then` is that line, or is listed in `scenario.manual` for the user
  to judge. A line with neither is `then_uncovered`, which blocks
  `eval check` and `run start`; a diagnostic check covers no line.
  `loop start` refuses packages still in checks.json 1.0 (`then_unbound`),
  whose checks name no line, and a change with no gating check, whose every
  line the user judges (`gating_missing`); a loop that has none left says
  `stop_no_gating`.
- The packages and the kit are fixed for the loop. Every run records the
  digest of each package and kit file it executed (`eval_snapshot`) beside
  each package's `task_digest`. A run during which one changed is marked
  `packages_changed_during_run`: it neither passes nor is a baseline. A
  package or kit file that differs from the loop's checks confirmation ends
  the loop (`packages_changed`), and the message names the files.
  `loop accept` refuses a run whose packages are not the current ones
  (`packages_changed`). `loop start` refuses a baseline that ran other
  packages than the current ones (`baseline_packages_differ`). Each report's
  Changes lists the package and kit files that changed. The CLI does not
  judge whether a changed package still checks what the Spec says: that is
  for the reviewer and the user, in `eval review` and `eval confirm`.
- A regression is a gating check that passed in the baseline, or, when there
  is no baseline result, in the latest earlier full run with a pass or fail
  for it, and fails now; a run in between that could not tell does not hide
  it. A check that passed only during the loop and fails again is reported as
  lost progress. Both compare results of the same package only. Two runs of
  the same code are never a regression or lost progress. A run during which
  the code or a package changed, or one that did not complete, is compared
  neither as the latest run nor as an earlier one.
- The budget counts the loop's full runs and the minutes from `loop start`.
  The minutes stop at the user's acceptance only while it covers the loop:
  once the code changes, a later full run fails, or a run of the accepted
  code fails, the minutes since the acceptance count too. A run that did not
  complete still counts as a run, and so does a final run. The budget is
  hard: until the user's acceptance covers the loop (`loop status` says
  `done`), `run start` refuses a head run once it is used up, a partial one
  too (`stop_budget`), and `loop status` says `stop_budget` instead of
  another repair; the report, the final review and the acceptance of a
  passing run stay possible, and so does `loop start` of a new loop once the
  user agrees. Once a screen run passed, the CLI estimates the final run from
  the loop's own full runs, once every package has some, and from earlier
  attempts before that; when it does not fit the minutes left, the loop
  stops: `stop` in `loop status` says `stop_budget` with reason
  `final_run_does_not_fit` and the estimate, also while the report and the
  final review of that screen run are still asked for, and `run start`
  refuses every head run from then on. `loop accept` of a run made past the budget warns, and
  `accepted.json` records the budget and what was used, with what the loop's
  head runs took and used (`usage`).
- Stuck means the same gating checks failed in the last two full runs, screen
  or final, on different code, compared over the packages both ran: a final
  run that stopped at a failing package skipped the rest. Partial runs
  (`--case`), runs during which the code or a package changed, and runs that
  did not complete never count. A stuck loop ends.
- `loop status` gives the baseline's run plan as `loop.run_plan`, which is the
  plan of the loop's checks confirmation: `loop start` refuses a baseline
  that ran another one. A head run of the loop follows it: `run start` reads
  the attempts from it and the agent and the model from the loop's
  confirmation, and refuses `--attempts`, `--agent` and `--model` before
  anything runs (`run_plan_fixed`), on a base record too. `loop status` gives
  `final` too: whether the loop needs final runs (`needed`), the packages a
  final run repeats (`live`) and how often (`attempts`), the screen run whose
  final run is due (`candidate`, `pending`), its final runs, and the failed
  and incomplete ones; each of `runs` names its `role`, `screen` or `final`.
  `accepted.json` keeps the plan in `run_plan`, with the attempts each package
  made.
- The checks the user confirmed hold the loop. `loop start` refuses packages
  that differ from the latest confirmation of this Spec export
  (`checks_unconfirmed`), a `confirmed.json` edited by hand
  (`confirmation_invalid`), a baseline that ran another plan than the
  confirmed one (`baseline_plan_differs`), and, without `--max-iterations` or
  `--max-minutes`, a confirmed budget that the estimate from earlier attempts
  shows cannot fit (`budget_unfit`). While a loop runs, a newer confirmation
  with another run plan or other packages ends it (`confirmation_changed`);
  one with the same plan and packages, such as a new budget, does not, and
  the loop keeps its own budget. `loop accept` refuses a run whose packages
  differ from the latest confirmation (`packages_unconfirmed`). A loop
  started before loops kept a confirmation compares the packages with those
  it started on, and its acceptance still needs the latest confirmation. A
  package changed after the acceptance only warns.
- `loop accept` needs a loop that has not ended or stopped, a passing full
  run, in a loop with final runs a passing final run (a screen run is refused
  with `not_final`), a complete report, an unchanged Spec, code and packages
  that did not change while the run executed, the same code and packages now
  as when that run started, and no run of that code and those packages,
  before or after it, that fails a gating check. A loop is accepted once
  while that acceptance covers it; an acceptance from an earlier loop of the
  change is kept in `accepted.json` under `earlier`. The record keeps each
  check with its role and the counts of both sides, the run plan with each
  package's attempts, the strength sentence, the checks confirmation that
  covers the accepted packages and the one the loop started on
  (`checks_confirmation`, `loop_confirmation`), the lines only a self-review
  counterexample stands behind, the lines the user judged, the final run and
  its screen run with every full run of the loop and its role (`final_run`,
  `screen_run`, `history`), and the code digest with `code_digest_of`, so
  `loop status` can still tell whether the code changed when the run folder
  is gone.
- After acceptance, `done` holds only while the code is the accepted run's, no
  full run after the acceptance fails, and no run of the accepted code and
  packages that started after the accepted run fails a gating check, a partial
  one included. Only a failure in an attempt that completed counts: a fail
  graded after the agent or the harness errored does not. Otherwise the
  acceptance no longer covers the loop, and `loop status` marks it
  `outdated`: a gating check the accepted run passed and a later run of other
  code fails is a regression, no run of code that failed can be accepted
  again, and a passing run of other code needs the user's acceptance again,
  which `loop accept` records with the earlier one under `earlier`. An
  acceptance is not withdrawn for a failure of its code in a run that started
  before the accepted run, such as a failure an earlier release did not
  count, nor for an earlier release's acceptance of a screen run in a loop
  that needs a final run: `loop status` warns, and you tell the user.
- `done` names a commit only when the application code and the change's own
  files are committed: `openspec/changes/<change>/`, `openspec/config.yaml`,
  `openspec/genesis.json`, the Spec schema in `openspec/schemas/genesis-spec/`,
  `.genesis/edd/<change>/` apart from the ignored run
  records, the project kit and `.genesis/edd/.gitignore`. Leftovers such as
  `.DS_Store` or an editor's swap file do not count. When a `.gitignore` rule
  keeps any of them out of Git, such as one that ignores `.genesis/` or
  `openspec/`, `loop status`, `loop accept`, `eval new` and `eval validate`
  warn; change the rule so they are committed. Of the paths the rule keeps
  out, `next.uncommitted` lists each that Git holds nothing of, and the new
  files in a folder the rule ignores, until they are in Git. It never lists a
  file that a narrower rule, such as `*.log` or `.env`, keeps out on its own.

## Final review

When a screen run passes, or every gating check passes in a loop without final
runs, have the whole change since the starting commit reviewed in a fresh
context: a subagent if you have one, given only the Spec, the diff and the
latest report, not this conversation. It comes before the final run, which
repeats that code. The reviewer answers two things: for each gating check
that went from fail to pass (`next.flips`), which change explains it; and
whether each check is still faithful to its THEN line. Ask it to look for
special cases for eval inputs, changes the Spec does not ask for, side effects
no check covers, and claims in the report that the records do not support.
Files that were already uncommitted when the loop started, which `loop status`
names, show up in a diff from that commit; tell the reviewer their edits from
before the loop are not part of this change. When the loop started before the
project's first commit, no diff shows the change alone: give the reviewer
`loop-start.patch`, which holds the files as they were then, to compare with.
Each fix needs a new full run; nothing has to be committed for it. Then write
the run's Review section: who reviewed, what they checked and found, and how
each finding was handled. The report of the final run has its Review filled
in: it points at the screen run's.

Without a subagent, review the diff yourself as a separate pass and say so in
Review: an author reviewing their own work misses more.

When the Spec recorded a Map, `loop status` also gives `next.genesis_review`.
If Genesis is installed, review the change with it first, through its own
skill, and pass the `prepare` arguments to every `genesis map prepare` of that
review: `--base` with the commit the loop started from, `--entries-from` with
the Map copy, `openspec/changes/<change>/business-map.json`, and
`--include-untracked` when the change has untracked files. Genesis then starts
from the entries and flows of the Map the Spec was written against, so the
change lands on the same flows on every clone.
`genesis_review.uncommitted_at_start` lists files that were already
uncommitted when the loop started: say in the review that their edits from
before the loop are not part of this change.

- `--entries-from` needs Genesis at or after commit `9c0c914`. If
  `genesis map prepare` rejects the option, tell the user to update Genesis,
  or run it without the option and say in Review that the flow ids may differ
  from the Spec's Map. If Genesis reads the project without its Python
  analysis, `prepare` refuses `--entries-from` too: run it without and say so.
- Genesis does not see the eval packages under `.genesis/`, so a verdict such
  as "not reached by any test" does not account for EDD's evals. Say so in
  the review, next to the run that passed.

Give the reviewer the summary of that review. Its Map covers only the change:
never pass it to `spec new`, and leave the Map copy as it is. If Genesis is not
installed, say so in Review.

## Acceptance

Show the user the comparison of each check (improved, kept, or with no
baseline) with its passes out of its attempts, which checks are only
diagnostic, the report, and anything the review left open. In a loop with
final runs, that is the final run's comparison and report, with the report of
its screen run and that report's Review. Show them
`next.strength.sentence` as it is: it comes from a fixed formula over the
attempts the gating checks of packages with a live dependency had, not from a
judgment, and it says what those attempts cannot rule out. When it rests on a
single attempt, say so plainly. Tell them what the loop's runs took, as
`next.message` says it from `loop.usage`: the minutes and, when the agent
adapter reported them, the cost and tokens. Show them any warning that a
check failed or varied on this code. A diagnostic check never decides the
verdict, so say plainly which requirements it is the only evidence for. When
`next.manual` lists lines, no check verifies them: show the user what the
evaluated agent produced for each, from that case's `logs/` in the run, from
every attempt of the final run when there is one (`<case>/attempts.json`
lists each trial), and accept only when they say each line holds. When
`next.self_review` lists lines, only a self-review counterexample stands
behind them: say so. Acceptance is the user's decision. Only after they give
it, run
`edd loop accept <change> --repo <app> --run <id> --by <name> --ref <where they said it>`.
Then follow `loop status`: it offers a commit, naming the change's own files
that still have to be committed, or only a merge or pull request once
everything is committed.

## When you stop

For every stop, for `loop_ended`, and whenever the user must decide, report
the reason and what changed, what passes, what still fails and why, what was
tried, and what you would try next. Ask the user before a new loop, and leave
the branch as it is.
