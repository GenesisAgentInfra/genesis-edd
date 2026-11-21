---
name: loop-and-implement
description: Implement a change against Genesis EDD eval packages and iterate on their evidence until every gating check passes, the budget runs out, progress stops, or the user must decide. Use after run-eval has recorded a baseline, when the user wants the code written or fixed. Writing specs and eval packages are separate stages.
---

# Loop and Implement

Change the application until the eval packages of an exported Spec pass,
without moving the target. The Spec, the expected results and the baseline
stay fixed for the whole loop; only the code changes, and the CLI checks that.
Every full run gets a short report, so a person can audit each step.

## Tool and context

The CLI starts through the launcher of the `agent-spec` skill, installed beside
this one. Run `node /absolute/path/to/agent-spec/scripts/run.mjs --version` to
locate it. In commands below, `edd` means that complete command without
`--version`. Always use the explicit path, not an executable found in the project.
If the launcher reports that its dependencies are not installed, run the command
it prints. It installs pinned npm packages inside the Genesis EDD package, needs
network access, and may need the user's approval outside a sandbox. Then retry.

Read [references/causes.md](references/causes.md) before classifying a failure.
Runs need Docker and Harbor, as in run-eval.

## Before the first change

1. Run `edd workflow check loop-and-implement <change> --repo <app>`. Repair
   gaps where `route` says: the Spec in `agent-spec`, packages in `write-eval`,
   the baseline in `run-eval`.
2. Agree with the user on the go-ahead to change code and on the budget: full
   runs and minutes, by default 5 and 60. When the evaluated agent calls a
   model, agree on the model and the expected cost of a run too.
3. If you added files only for the evals after the baseline, such as
   `.dockerignore`, record the baseline again with the same `--expect` file;
   `loop start` refuses a baseline that ran on other code. This works only
   before the first `loop start` for this Spec.
4. Run `edd loop start <change> --repo <app> --max-iterations N --max-minutes M`.
   When the user later agrees to go on past the budget, run
   `edd loop extend <change> --repo <app> --max-iterations N --max-minutes M`:
   N more full runs and M minutes from then, with the runs and the baseline kept.

Nothing has to be committed. Every run stores its code as the commit it started
from plus `code.patch` in the run folder, with everything that commit does not
hold. Commit on a branch if you can and the user wants it. If `.git` is
read-only, as in Codex's sandbox, carry on without commits; never work around it
with a second checkout.

## Each iteration

1. Run `edd loop status <change> --repo <app>` and do what `next.action` says.
2. Read the evidence before changing anything: `compare.json`, and each failing
   case's `logs/`, which hold the program's output, the verifier's output and
   the stand-in services' records.
3. Classify every check that does not hold with
   [references/causes.md](references/causes.md), and change the layer the
   evidence points to, not the one that is easiest to change.
4. For code logic, find the root cause first, then make the smallest change
   that meets the requirement as written. Try it locally, by running the
   program or the project's own tests, before a full run.
   `edd run start <change> --repo <app> --case <id>` gives a quick look at one
   package; it never counts as passing.
5. In a project with no implementation, once the code has an entry point,
   return to `write-eval` to connect the packages and prove them with
   `eval check`. The expected results stay as they are.
6. Run the project's existing tests, if it has any. A check covers only its
   scenario; those tests guard the rest of the application.
7. Run `edd run start <change> --repo <app>`. Add `--attempts N` when the
   evaluated agent gives different results from run to run.
8. Run `edd loop report <change> --repo <app>` and fill in Cause, Changes and
   Next. Then return to step 1.

## What `next.action` asks

| Action | Do |
| --- | --- |
| `iterate` | Classify the open checks it lists and change the right layer. |
| `write_report` | Complete the named run's report before anything else. |
| `repair_execution` | The run did not complete. Fix the adapter or environment in `write-eval`, or rerun after a build or timeout fault. It is not a result of the code. |
| `split_changes` | A check that passed before the change now fails. Restore the code of the last run where it passed and reapply the changes one at a time to find the one that breaks it. |
| `stop_stuck` | The same checks failed twice on different code. Stop and ask the user. |
| `stop_budget` | The budget is used up. Stop and report. Raise it with `loop extend` only when the user agrees. |
| `final_review` | Every gating check passes. Review the change, below. |
| `ask_acceptance` | Ask the user to accept, below. |
| `restart` | The Spec was exported again. Update the packages, record a new baseline, then `loop start --restart`. |
| `repair_spec` | The Spec the loop started from no longer validates. Restore what changed; a requirement that must change goes to `agent-spec` and the user. |
| `done` | The user accepted a run of this loop. Offer to commit, merge or open a pull request. |

## Rules

- Never edit the Spec, `checks.json`, a fixture's expected result, a
  verifier's decision or a baseline to make a check pass. A wrong check is a
  `write-eval` fix with its own evidence, proved by `eval check` and named in
  the report. A wrong or unclear requirement is the user's decision, through
  `agent-spec`.
- Never special-case the eval inputs in application code: a known title, an
  ID, a fixed date.
- To go back to the code of a run, check out its `code_snapshot.commit` and
  `git apply` its `code.patch`. Keep your own changes aside first.
- Run again only after a real change. The same code shows nothing new.
- Do not record the baseline again during the loop. Head runs keep comparing
  with the loop's baseline, and the CLI refuses any base record on code other
  than the loop's starting code: `start_code` in `loop.json`, its commit plus
  `loop-start.patch` beside it. Files added for the evals during the loop, such
  as `.dockerignore`, cannot join this Spec's baseline; the checks of a package
  that changed stay `head_only`, and the report's Cause says why.
- `loop start --restart` starts the loop over with the latest baseline recorded
  on the starting code, which it keeps. The runs so far stay in the record under
  `previous`. To go on with more runs, use `loop extend` instead.
- Claim only what a run shows. "Works" needs a passing full run on the current
  commit; "improved" needs a baseline in which that check failed.
- Do not push, merge or open a pull request unless the user asks.

## What the CLI checks

- The same code means the same content: `code_snapshot.digest` covers every
  file a run sees, committed or not, and leaves the commit out. Committing
  alone changes nothing, so it never blocks a base record on the starting
  code, an acceptance or a restart.
- A report is complete when its first, template line is gone, Result, Cause,
  Changes and Next have content, every check listed under Cause has a cause
  after it, and a passing run also has Review.
- A regression is a gating check that passed in the baseline, or in the run
  before when there is no baseline result, and fails now. A check that passed
  only during the loop and fails again is reported as lost progress. Both
  compare results of the same package only: after a `write-eval` fix, the
  earlier results of that package do not count.
- The minutes of the budget count from `loop start` or the last `loop extend`.
  A run that did not complete still counts as a run; when the budget is used
  up, `next` is `stop_budget` instead of another repair.
- Stuck means the same gating checks failed in the last two full runs on
  different code. Partial runs (`--case`) never count.
- `loop accept` needs a passing full run, a complete report, an unchanged Spec,
  and the same code now as when that run started. Each loop is accepted once;
  an acceptance from an earlier loop of the change is kept in `accepted.json`
  under `earlier`.

## Final review

When every gating check passes, have the whole change since the starting
commit reviewed in a fresh context: a subagent if you have one, given only the
Spec, the diff and the latest report, not this conversation. Ask it to look for
special cases for eval inputs, changes the Spec does not ask for, side effects
no check covers, and claims in the report that the records do not support.
Each fix is a new commit and a new full run. Then write the run's Review
section. Without a subagent, review the diff yourself as a separate pass and
say so in Review: an author reviewing their own work misses more.

## Acceptance

Show the user the comparison of each check (improved, kept, or with no
baseline), the report, and anything the review left open. Acceptance is the
user's decision. Only after they give it, run
`edd loop accept <change> --repo <app> --run <id> --by <name> --ref <where they said it>`.
Then offer to commit the change, merge it or open a pull request.

## When you stop

For a stop on budget, on being stuck, or for a user decision, report what
passes, what still fails and why, what was tried, and what you would try next.
Leave the branch as it is.
