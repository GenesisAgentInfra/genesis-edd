# Run records v0.1

Every run has its own folder and is written once.

```text
.genesis/edd/<change>/runs/<run-id>/
├── run.json                  identity and verdict of this run
├── compare.json              head runs only: each check against the baseline
├── code.patch                code the commit does not hold, if any
└── <case>/
    ├── attempts.json         every attempt: its trial, status, results and times
    ├── check-results.json    each check's result, combined over the attempts
    ├── reward.json           1 when every gating check passed, else 0
    └── logs/                 Harbor's job output: agent, verifier and trial logs
```

EDD writes `<case>/attempts.json`, `<case>/check-results.json` and
`<case>/reward.json`, not the verifier: each attempt as described under
Attempts, then one result per check, combined over the attempts, written only
when some attempt recorded results. The verifier's own files are under
`logs/harbor/<trial>/verifier/`. `eval check` writes `attempts.json` beside each
fixture too, under `checks/<case>/<fixture>/`, and `checks/<case>/check.json`
keeps `usage`, the sums over its fixtures' attempts, with the keys of a
case's `usage` below.

`.genesis/edd/.gitignore` keeps `runs/`, `checks/`, `loop.json` and
`loop-start.patch` out of Git: they are the evidence and the loop state of this
machine, so a fresh clone has neither runs nor a running loop. Lines you add to
that file are kept. The records are still evidence: a rerun does not replace an
earlier run. The count of results on the same code, under Same code, reads
`runs/`, so it covers the runs of this machine only. Never delete or move
`runs/` or `loop.json`: `loop.json` alone keeps a loop's budget and the loops
before it. When it is missing or cannot be read, the head runs in `runs/`
still name their loop's start code and baseline, so base records and a new
loop keep that start code, and `loop start` and `run start --baseline` say so;
the budget and the earlier loops are lost. Restore `loop.json` if you can.

A run writes `run.json` last. A folder without it was left by a run that was
interrupted, or is still running. It is not counted or compared; `run start`
and `loop status` name it in a warning, and it can be deleted once its logs are
no longer needed.

## run.json

| Group | Field | Meaning |
| --- | --- | --- |
| Verdict | `execution_status` | `completed`, `blocked` (a baseline with no package that could run; a head run with none is refused and writes nothing), `error` (Harbor or the environment failed) or `not_run` (a declared unavailable baseline). Separate from any business result. |
| Verdict | `verdict` | Head runs: `pass`, `fail` or `unverified`. `null` for a baseline, which records results and decides nothing. |
| Verdict | `code_changed_during_run` | True when the code differed from the code at the run's start after one of its packages ran. `run start` reads the code again after each package, by content and by when each file was last written, so a file edited and put back before the run ends counts too; `code_changed_during` names the packages after which it differed. Each package builds from the code as it is when it runs, so the results belong to no single version: a head run is `unverified`, a base run is not a baseline, and `loop accept` refuses it. A base run that completes while the code changes keeps `execution_status` `completed`, with `baseline_unavailable_reason` `execution_blocked`; one that also errored keeps `execution_status` `error`. Run again without editing the code. |
| Verdict | `packages_changed_during_run` | True when a package that ran, or the project kit, differed from the run's start after one of its packages ran, read by content and by when each file was last written, so a file edited and put back counts too. Its results belong to no single version of the packages: a head run is `unverified`, a base run is not a baseline, and `loop accept` refuses it. `eval_snapshot.changed_during_run` names those packages. Prove them again with `eval check`, then run again without editing them. Records without this field read as false. |
| Identity | `schema_version` | Version of the record format, `1.0`. |
| Identity | `run_id`, `side` | Start time with a suffix; `base` or `head`. |
| Identity | `scope` | `full`, or `partial` for a head run limited with `--case`. A partial run never passes. |
| Identity | `role` | Full head runs of a loop whose run plan runs a package with a live dependency more than once: `screen` for the full run of an iteration, with one attempt of each package, or `final` for the full run on the code and packages of a screen run that passed and whose report and final review are done; a final run follows the plan, and only a passing one can be accepted. `null` for base runs, partial runs, runs outside a loop and loops without final runs. A loop on a baseline recorded before runs followed a run plan, with more than one attempt, has final runs too, and a final run then repeats every package. A record without `role` reads as `final` when it passed and ran each package a final run repeats the plan's number of times, and otherwise as `screen`. |
| Identity | `final_of`, `run_order` | Final runs only: the screen run whose code they ran again, and the packages in the order they ran: first those whose gating checks failed in any earlier run of this Spec export, then the rest. |
| Identity | `started_at`, `finished_at` | When the run started and ended, as UTC timestamps. |
| Identity | `code_version` | A commit when the tree is clean, `uncommitted` when it is not, `empty` when there is no code. |
| Identity | `spec_snapshot` | The change and the exported handoff the packages were written for. |
| Baseline | `is_baseline` | True only for a base run that executed to the end on code and packages that did not change during it. |
| Baseline | `baseline` | The baseline run a head run is compared with, or `null`. |
| Baseline | `base_run` | Head runs: the base record they were compared with, a baseline or the record of an unavailable one. While a loop runs, it is always the loop's baseline. |
| Baseline | `loop` | Head runs: the loop of `loop.json` the run was made in, `{ started_at, baseline, start_code }`, or `null` outside a loop. Only a run that names a loop is one of its runs, so a run made while `loop.json` was missing joins no loop. A record without this field, from an earlier version, belongs to the loop of its Spec export that started before it. |
| Baseline | `baseline_unavailable_reason` | `no_implementation`, `execution_blocked` or `incompatible_tasks` when there is no usable baseline. |
| Baseline | `baseline_expectations` | Base runs that execute: the expected result of every declared check and the reason, fixed before the code changed, including packages that could not run yet. Empty for an unavailable baseline. |
| Baseline | `baseline_mismatch` | Base runs: checks whose result differs from the expectation, leaving out the unstable ones. |
| Baseline | `baseline_unstable` | Base runs: checks that passed in some attempts and failed in others, each with its expectation and its `counts` of pass, fail and unknown. Their result before the change is not settled, so they are never a mismatch, and their expectation stays as it was declared. The run, and `loop start` on it, warn. |
| Snapshot | `code_snapshot` | The commit, the application files that differ from it with their digests, a digest of the code, and `patch`: `code.patch` in the run folder holds those differences. The commit plus the patch restore that code. When the patch cannot be written, `patch` is missing and a warning says the code of the run cannot be restored. The digest covers content only, of tracked files and of untracked files Git does not ignore, committed or not; `digest_of` is `content`. Files Git ignores, such as `.env` or local data, are in neither the digest nor the patch, yet the Docker build context, the project root, holds them: keep them out of the image with `.dockerignore`. Committing the same code keeps the digest, so a commit alone is not a code change. A file such as `.dockerignore` counts, because it changes what the image holds; `.genesis/`, `openspec/` and the installed skills do not. Records without `digest_of` come from an earlier version whose digest included the commit: they compare by their commit when they had no uncommitted change, and otherwise not at all. |
| Snapshot | `task_digest` | Digest of each package together with the project kit. Only identical ones are compared. `eval_snapshot` lists the files behind it. |
| Snapshot | `eval_snapshot` | As the run started: `packages`, the digest of each file of every package by its path in the package, and `kit`, the digest of each file of the project kit by its path in `.genesis/edd/harness/`. `Task.md`, `PROJECT.md`, Python caches and leftovers are left out, as from `task_digest`. A report's Changes lists the files that differ from the run before; a record without it names each changed package instead. |
| Snapshot | `environment_ref` | Harbor version, agent, model, `attempts` (what each package with a live dependency made), `attempts_by_case` (what each package that ran made), `run_plan` and each case's dependencies with their mode. `run_plan` is fixed by the baseline: `attempts` (the user's N, or `null` when no package needed one), `pass_rule` (`all`), `agent`, `model` and `source`: `confirmation`, with `confirmation` the id of the user's checks confirmation it was read from, or `baseline`, for a baseline recorded without a current confirmation, as after a package changed. Such a baseline takes the plan the user last confirmed for this Spec export, with the agent and model of harness.json once it changed since; a warning names what it took. Head runs copy their base record's. A record without `run_plan` reads as `source` `legacy` with `uniform: true`: outside screen runs and partial runs, every package runs its `attempts`. Outside a loop, a head run whose agent, model, attempts or Harbor version differ from its baseline's warns, and the verdicts stay as they are; attempts are compared for a full run, or when `--attempts` was given. Once a loop has started for the Spec export, `run start` refuses `--attempts`, `--agent` and `--model` before anything runs, on a base record too (`run_plan_fixed`): a head run takes the attempts of the loop's baseline and the agent and model of the loop's checks confirmation, and a baseline reads its plan from the latest confirmation. A screen run makes one attempt of each package by design, so only the Harbor version can still warn there. |
| Snapshot | `checks_confirmation` | `{ id, at }` of the newest checks confirmation in `confirmed.json` of this Spec export whose packages are the ones this run ran, or `null`. Records without this field read as `null`. |
| Snapshot | `map_ref` | The Map recorded with the Spec, or `null`. Its `path` is the copy committed in the change folder, `openspec/changes/<change>/business-map.json`; a change made before the copy existed names `.genesis/out/...`. `mode` and `freshness` are as `spec new` recorded them: `mode` is `map` or `unknown`, and `freshness` is `verified`, `stale` or `unverified` against the commit the Spec was written on. Changes made before `mode` was recorded have none. |
| Detail | `usage` | What the run took and used: `minutes` from its start to its end, `attempt_minutes`, the sum over its attempts, `attempts`, `reported`, and the sums `cost_usd`, `n_input_tokens`, `n_cache_tokens` and `n_output_tokens`; see Usage. |
| Detail | `cases`, `skipped`, `warnings` | Per-case execution, gating counts and `usage`, with the same keys as the run's but `minutes` the sum over the package's attempts and no `attempt_minutes`; packages that did not run: not runnable (`awaiting_integration`), not named with `--case` (`not_selected`), or left by a final run after a package failed (`final_stopped`, with `after` naming that package); anything the reader should know. |

## compare.json

Each entry names `case`, `check`, `intent` and `role`, with `before` (the
baseline result, or `null` with `before_unavailable_reason`), `after`,
`before_counts` and `after_counts` (how many attempts of each side passed,
failed and had no evidence; `before_counts` is `null` with no baseline result),
the `verdict` and the verifier's `evidence`, and `flaky: true` when the check
passed in some attempts and failed in others. `before_unavailable_reason` is the
baseline's own reason when no baseline ran, `not_run_at_baseline` for a package
the baseline did not run, and `incompatible_tasks` for a package that changed
since. `base_run` names the base record, as in `run.json`. An entry also
carries `then`, the THEN or AND line its check verifies, for a package in
checks.json 1.1. Top-level `manual` lists the lines of the packages that ran
that no check verifies, each as `case`, `then` and `reason`: the user judges
them at acceptance. Records written before these fields existed have neither;
read a missing `manual` as `[]`.

| Verdict | Meaning |
| --- | --- |
| `holds` | Head passes and the baseline has a complete result that matches its expectation. Only a real fail to pass shows an improvement; pass to pass shows it was kept. |
| `violated` | Head has complete evidence that the requirement is not met. |
| `base_mismatch` | Head passes, but the baseline result does not match what was expected. Acceptance can be met; the expected improvement is not shown. |
| `head_only` | Head passes and there is no comparable baseline. Acceptance can be met; nothing is shown about the change. |
| `unverified` | Evidence is missing on the head side, or on a baseline that ran. |

Decide head first: failing evidence is `violated`, missing evidence is
`unverified`. Only for a passing head look at the baseline. A missing baseline
result never hides a failure the head run proved.

## Attempts

A package that declares a `live` dependency runs the N attempts of the run
plan at the baseline, in a loop's final run, and in a full run outside a loop
or in a loop without final runs; a screen run makes one attempt of each
package. Every other package runs once, and a partial run runs each package
once unless `--attempts` says, which only a run outside a loop may.
EDD combines each check over the attempts: one failing attempt makes it
`fail`; otherwise one attempt without evidence makes it `unknown`; otherwise it
is `pass`. An attempt Harbor left no readable result for has no evidence, and
neither has one whose agent or harness raised, such as on a rate limit: Harbor
may still grade it, but what its verifier recorded, a pass or a fail, is no
result of the code, so each of its checks is `unknown`. Such a run did not
complete (`execution_status` `error`) and fails no check through it. A
check that passed in some attempts and failed in others carries `flaky: true`
in `<case>/check-results.json` and `compare.json`, and the run warns; an
attempt without evidence does not make a check flaky. Its evidence counts the
results of every attempt.

`<case>/attempts.json` holds `schema_version`, `case`, `planned` (the attempts
asked for) and `attempts`, one entry per attempt, numbered from 1 in the order
the trials started:

| Field | Meaning |
| --- | --- |
| `attempt` | Its number. |
| `trial` | Its folder, `logs/harbor/<trial>`, or `null` when Harbor left none. |
| `status` | `completed`; `error`, with `reason`, when its result could not be read or the agent or harness raised, such as on a rate limit; `missing`, with `reason`, when Harbor left no trial for it. |
| `results` | Each check's `pass`, `fail` or `unknown` as the verifier recorded it in that attempt; every check is `unknown` in an attempt that did not complete. |
| `graded` | Only in an attempt that did not complete and was graded anyway: what its verifier recorded, kept for its logs. It never counts. A record written before `graded` existed holds those values in `results`; they are read as `unknown`. |
| `reward` | The reward the verifier wrote, or `null`. |
| `started_at`, `finished_at` | As Harbor recorded them, or `null`. |
| `usage` | Only when the adapter reported it: `n_input_tokens`, `n_cache_tokens`, `n_output_tokens` and `cost_usd`, each only when reported. |

A base and a head attempt with the same number are never paired: each side is
combined on its own, and the comparison uses each side's result and counts. A
run recorded before `attempts.json` existed has its counts read from its
combined evidence, or its one result counted once per attempt.

## Usage

A run adds up its attempts in `usage`, for each case and in total; so does
`eval check` in `check.json`. `minutes` sums the time from each attempt's
`started_at` to its `finished_at`, to a tenth of a minute; the run's own
`minutes` is its wall time, from its start to its end. `attempts` counts
the attempts, and `reported` those whose agent adapter reported any usage.
`cost_usd` and each token count sum only the attempts that reported them, and
are `null` when none did: unknown is never 0. A fixture stands in for the
evaluated agent and makes no model call, so `eval check` reports none. A run
with a model whose adapter reported nothing for a package warns that the
estimates count its time only. A run recorded before `usage` existed has
none; `loop status` and `loop accept` read its time from `started_at` and
`finished_at`, and its usage from its `attempts.json` files, when it has them.

`loop status` estimates the next runs from earlier attempts in
`loop.estimate`: the mean time and cost of an attempt of each ready package,
from the baseline's attempts, or else from the fixtures of its last
`eval check`, gives `screen` (one attempt of each package), and `final` and
`full` (the plan's attempts). `basis` says where it came from:
`baseline_attempts`, `eval_check` (`per_attempt` names each package's),
`baseline_run` when only the baseline's whole run is known, or `null`. Once
every ready package has completed attempts in the loop's own runs, the
estimate rests on those alone, and `basis` is `loop_attempts`.
`remaining` holds the runs and minutes the budget has left. Before a final
run, `loop status` checks the final run's estimate against the minutes left:
when it does not fit, it says `stop_budget` with reason
`final_run_does_not_fit` and the estimate in `next.estimate`. `loop start`
checks the confirmed budget against the same estimate, and `eval review`
gives `run_plan.estimate` from `eval check` for 1, 3 and 5 attempts, of the
ready packages; `run_plan.estimate_missing` names the others.
`loop status` adds up the loop's head runs, full and partial, in
`loop.usage`, and `accepted.json` keeps it as `usage`.

## Same code

Results add up across runs. Every result of one Spec export is counted with
the others of the same code (`code_snapshot.digest`), package (`task_digest`),
agent and model: base and head runs, full and partial runs, in every loop of
the Spec export or outside one. The records are in `runs/`, which Git
ignores, so the count covers the runs of this machine. Each attempt counts on
its own, so a check that passed
in one attempt and failed in another of the same run passed and failed on that
code. A run during which the code or a package changed, one that did not
execute, and one whose code cannot be known add nothing. A pass or a failure
counts only from an attempt that completed: Harbor may still run the verifier
after the agent stopped on a rate limit or a timeout, and that failure is no
result of the code. `unknown` never counts. A run recorded before
`attempts.json` existed gives one combined result per package and check, from
a package that completed.

One failure among them is never cancelled. `loop accept` refuses a run when a
gating check failed on its code, packages, agent and model in any other run
(`unstable`). In a loop without final runs, `loop status` says
`stop_unstable` when a gating check passed and failed on the code and packages
of a run of the loop. In a loop with final runs, one failed final run means
changing the code, and `stop_unstable` comes with the second failed final run
of the loop, or with a failure on the code of a final run that passed. A stop
ends the loop; a new loop, once the user agrees, still counts the failures of
the same code. A changed package, agent or model starts a new count.

## Verdict of a run

- `fail`: a gating check has failing evidence from an attempt that
  completed, and neither the code nor a package changed during the run. A final run stops at the first package
  whose gating checks failed in an attempt that completed and skips the rest,
  so a final run that stopped early is `fail`.
- `pass`: the run completed on code and packages that did not change during
  it, every package ran, and every gating check passed. A project with no
  baseline can reach this.
- `unverified`: no proven failure, but something was skipped, blocked or
  unknown, or the code or a package changed during the run.

Report the comparison beside the verdict: improved, kept, baseline mismatch or
head only.
