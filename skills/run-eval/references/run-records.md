# Run records

Every run has its own folder, written once, and two lines in the run index.

```text
.genesis/edd/<change>/
├── decisions.jsonl           the user's and the agent's recorded decisions
└── runs/
    ├── index.jsonl           one start and one finish line per run
    └── <run-id>/
        ├── run.json          identity and verdict of this run
        ├── compare.json      head runs and trials: each check against the baseline
        ├── code.patch        code the commit does not hold, if any
        └── <case>/
            ├── attempts.json       every attempt: its trial, status, results and times
            ├── check-results.json  each check's result, combined over the attempts
            ├── reward.json         1 when every gating check passed, else 0
            └── logs/               Harbor's job output: agent, verifier and trial logs
```

EDD writes `<case>/attempts.json`, `<case>/check-results.json` and
`<case>/reward.json`, not the verifier: each attempt as described under
Attempts, then one result per check, combined over the attempts, written only
when some attempt recorded results. The verifier's own files are under
`logs/harbor/<trial>/verifier/`, or, in a package with steps, under
`logs/harbor/<trial>/steps/<step>/verifier/` for each step. There each check
is read only from the `check-results.json` of the step its `at` names: a
result another step's verifier wrote for it never counts. `eval check`
writes `attempts.json` beside each fixture too, under
`checks/<case>/<fixture>/`, and
`checks/<case>/check.json` keeps `usage`, the sums over its fixtures'
attempts, and `probe`, the run of the package with Harbor's nop agent, with
the `run_digest` it ran and each check's `results`: every gating check must
be `unknown` there.

`.genesis/edd/.gitignore` keeps `runs/`, `checks/`, `loop.json`,
`loop-start.patch` and `decisions.jsonl` out of Git: they are the evidence and
the loop state of this machine, so a fresh clone has no runs and no loop.
Lines you add to that file are kept. A rerun never replaces an earlier run.

## Run index

`run start` appends a `start` line to `runs/index.jsonl` before Harbor starts
and a `finish` line after `run.json` is written.

- `start`: `run_id`, `started_at`, `side`, `scope`, `role`, `loop`, `spec`,
  `code` (its identity and snapshot), `cases`, `task_digest`, `run_digest`,
  `agent`, `model`, `attempts` per case, `run_plan`, `gating` (the gating
  check ids of each case), `check_steps` for packages with steps (their
  steps and the step each check is read at, so the attempts of a run that
  never finished are read the same way), `expectations` for a baseline,
  `cost_approval` when one was given, `harbor_jobs`, `host_env`, and
  `agents_by_case` for packages with their own adapter.
- `finish`: `execution_status`, `verdict`, `minutes` and `run_json`, the
  digest of `run.json` as written.

Every reader of the runs reads the index too. A run the index lists whose
folder or `run.json` is gone is **lost**: it counts as one failed attempt of
every gating check of its packages on its code, and spends the minutes its
finish line recorded. A run whose folder is there but that never finished is
**interrupted**: the attempts it completed count. `run list`, `run show`,
`eval review` (`ledger_runs_lost`, `ledger_incomplete`), `loop status` and
`loop accept` name them. The ledger state also lists indexed runs the index
no longer holds (`unindexed`), lines it cannot read (`broken_lines`) and a
`run.json` that differs from the one recorded when the run finished
(`altered`); these are disclosed, not refused. A missing index, while runs
were recorded in it, blocks `loop start` and `loop accept`
(`ledger_index_missing`, owner user, layer ledger).

## Decisions

`decisions.jsonl` beside the runs keeps each recorded decision with its time,
and `by` and `ref` when the user's: `loop_start`, `loop_end`, `loop_decline`,
`loop_budget`, `loop_review`, `loop_dispute`, `dispute_ruling`, `loop_tests`,
`change_abandon` and `cost_approval` (written by `run start
--approved-by --ref`).

## run.json

| Group | Field | Meaning |
| --- | --- | --- |
| Verdict | `execution_status` | `completed`, `blocked` (a baseline with no package that could run; a head run with none is refused and writes nothing), `error` (Harbor or the environment failed) or `not_run` (a declared unavailable baseline). Separate from any business result. A record read from the index alone is `lost` or `interrupted`. |
| Verdict | `verdict` | Head runs and trials: `pass`, `fail` or `unverified`; a trial is never `pass`, and records `trial_gating_passed: true` when every gating check passed. `null` for a base record, which records results and decides nothing. A lost run reads as `fail`. |
| Verdict | `not_acceptance` | `true` on a head run made outside a loop. A pass there is a comparison, never an acceptance: no budget, final run or final review applies to it. |
| Verdict | `code_changed_during_run` | True when the code differed from the code at the run's start after one of its packages ran, read by content and by when each file was last written, so a file edited and put back counts too; `code_changed_during` names the packages after which it differed. A head run is then `unverified`, a base record is not a baseline, and `loop accept` refuses it. |
| Verdict | `packages_changed_during_run` | The same for a package that ran, or the project kit; `eval_snapshot.changed_during_run` names those packages. |
| Identity | `schema_version` | `1.0`. |
| Identity | `run_id`, `side` | Start time with a suffix; `base`, `head` or `trial`. |
| Identity | `scope` | `full`, or `partial` for a run limited with `--case`. A partial run never passes and is never a loop's baseline. |
| Identity | `role` | In a loop whose plan runs a package with a live dependency more than once: `screen` for the full run of an iteration, with one attempt of each package, or `final` for the run on the code and packages of a passing screen run, which follows the plan; only a passing final run can be accepted. `trial` for a trial made inside a loop. `null` otherwise. |
| Identity | `final_of`, `run_order`, `all_packages` | Final runs: the screen run whose code they ran again, the packages in the order they ran (those whose gating checks failed in any earlier run of the export first), and whether `--all-packages` kept it going after a failure. |
| Identity | `started_at`, `finished_at` | UTC timestamps. |
| Identity | `code_version` | A commit when the tree is clean, `uncommitted` when it is not, `empty` when there is no code. |
| Identity | `spec_snapshot` | The change and the exported handoff the packages were written for. |
| Identity | `tier`, `tier_changed` | Head runs and trials: the tier of the loop the run was made in, or `null` outside a loop. `tier_changed` names the packages whose adapter reported model use in a light-tier loop; a head run or a trial that records it ends the loop. |
| Baseline | `is_baseline` | True only for a full base record that executed to the end on code and packages that did not change during it. |
| Baseline | `at_start` | True for a run on the pinned start code rebuilt outside the project (`--at-start`). |
| Baseline | `baseline`, `base_run` | Head runs and trials: the baseline compared with, and the base record compared with, a baseline or the record of an unavailable one. Inside a loop it is the loop's baseline; outside one, the latest valid baseline of the export. |
| Baseline | `loop` | Head runs and trials: `{ started_at, baseline, start_code }` of the loop the run was made in, or `null`. Only a head run that names a loop is one of its runs. |
| Baseline | `baseline_unavailable_reason` | `no_implementation`, `execution_blocked`, `incompatible_tasks` or `no_baseline` when there is no usable baseline. |
| Baseline | `baseline_expectations` | Base records that execute: the expected result of every declared check and its reason, with `declared` false for a check the expectation file left out (`any`). |
| Baseline | `baseline_mismatch` | Base records: checks whose result differs from the expectation, leaving out the unstable ones. |
| Baseline | `baseline_unstable` | Base records: checks that passed in some attempts and failed in others, each with its expectation and its `counts`. Their result before the change is not settled, so they are never a mismatch. |
| Snapshot | `code_snapshot` | The commit, the application files that differ from it with their digests, a content `digest` of the code (`digest_of` `content`), and `patch`: `code.patch` holds those differences, and the commit plus the patch restore the code. The digest covers tracked files and untracked files Git does not ignore, and leaves the commit out, so committing the same code is no code change. Files Git ignores are in neither, yet the Docker build context may hold them: keep them out of the image with `.dockerignore`. `.genesis/`, `openspec/` and the installed skills are not application code. A `.dockerignore` added or changed after `spec new` is part of the recorded code, so `eval review` lists a baseline on it as `code_changed_before_baseline` and, when the records show them, names the files that differ. |
| Snapshot | `task_digest` | Digest of each package together with the project kit, fixtures included. |
| Snapshot | `run_digest` | The same without `tests/fixtures/**` and the `fixtures` array of `checks.json`: what a run executes. Runs compare packages by it when both records have one, otherwise by `task_digest`; a new fixture changes no package a run executes. |
| Snapshot | `eval_snapshot` | As the run started: the digest of each file of every package and of the project kit. A report's Changes lists the files that differ from the run before. |
| Snapshot | `environment_ref` | Harbor version, `agent`, `model`, `attempts`, `attempts_by_case` (what each package that ran made), `agents_by_case` (packages that ran with their own adapter), `run_plan` and each case's dependencies with their mode. `run_plan` has `attempts` (the user's number, or `null`), `pass_rule` (`all`), `agent`, `model` and `source`: `confirmation` with its id, `baseline` for a base record made while no confirmation covered the packages, or `trial`. Head runs copy their base record's. |
| Snapshot | `checks_confirmation` | `{ id, at }` of the newest confirmation of this export whose packages are the ones this run ran, or `null`. |
| Snapshot | `judge_gating` | The judge checks the run counted as gating, as `case:then`, from the confirmation it followed. |
| Snapshot | `cost_approval` | `{ by, ref, at }` when the user approved a model-calling run before any confirmation. |
| Snapshot | `host_env` | `mode` (`all` for `--yes`, `listed` for `--allow-env`, `none`), the variables passed, those declared and those withheld. |
| Snapshot | `map_ref` | The Map recorded with the Spec, or `null`: its committed copy, `openspec/changes/<change>/business-map.json`, its mode, freshness and coverage. |
| Detail | `harbor_projects` | The compose projects Harbor ran each package's trials in, which `run cleanup` removes. |
| Detail | `usage` | `minutes` from the run's start to its end, `attempt_minutes`, `attempts`, `reported`, and the sums `cost_usd`, `n_input_tokens`, `n_cache_tokens` and `n_output_tokens`; see Usage. |
| Detail | `indexed` | True: the run index lists this run. |
| Detail | `cases`, `skipped`, `warnings` | Per-case execution, gating counts and `usage`; packages that did not run, with why: `awaiting_integration`, `draft_bound`, `invalid` (trials), `not_selected`, or `final_stopped` with `after` naming the package that failed; anything the reader should know. |

## compare.json

Written for head runs and trials. Each entry names `case`, `check`, `intent`
and `role`, with `before` (the baseline result, or `null` with
`before_unavailable_reason`), `after`, `before_counts` and `after_counts` (how
many attempts of each side passed, failed and had no evidence), the `verdict`,
the verifier's `evidence`, `flaky: true` when the check passed in some
attempts and failed in others, and `then`, the THEN or AND line its check
verifies. `before_unavailable_reason` is the baseline's own reason when no
baseline ran, `not_run_at_baseline` for a package the baseline did not run,
and `incompatible_tasks` for a package that changed since. Top-level `manual`
lists the lines of the packages that ran that no check verifies, each with
`case`, `then` and `reason`: the user judges them at acceptance.

| Verdict | Meaning |
| --- | --- |
| `holds` | Head passes and the baseline has a complete result that matches its expectation. Only a real fail to pass shows an improvement; pass to pass shows it was kept. |
| `violated` | Head has complete evidence that the requirement is not met. |
| `base_mismatch` | Head passes, but the baseline result does not match what was expected. The requirement can be met; the expected improvement is not shown. |
| `head_only` | Head passes and there is no comparable baseline. The requirement can be met; nothing is shown about the change. |
| `unverified` | Evidence is missing on the head side, or on a baseline that ran. |

In the table of a loop's report, a `holds` row reads `holds (fixed)` when
the check did not pass at the baseline and passes now, and `holds (kept)`
when it passed at the baseline too; `compare.json` keeps `holds` for both.
Its Changes section lists packages whose fixtures or proofs changed while what
a run executes did not under `Fixtures added or changed (what a run executes
is unchanged)`.

Head comes first: failing evidence is `violated`, missing evidence is
`unverified`. Only for a passing head is the baseline read. A missing
baseline result never hides a failure the head run proved.

## Attempts

A package that declares a `live` dependency runs the N attempts of the run
plan at the baseline, in a loop's final run, and in a full head run outside a
loop or in a loop without final runs; a screen run makes one attempt of each
package. Every other package runs once. A partial run makes one attempt of
each package unless `--attempts` says otherwise; inside a loop `--attempts`
may only repeat the plan's number. A trial makes one attempt of each package
unless `--attempts` says otherwise.

EDD combines each check over the attempts: one failing attempt makes it
`fail`; otherwise one attempt without evidence makes it `unknown`; otherwise
it is `pass`. An attempt whose agent or harness raised, such as on a rate
limit, or that Harbor left no readable result for, has no evidence: each of
its checks is `unknown`, and what its verifier recorded is kept under
`graded` and never counts. In a package with steps, an attempt in which the
agent of any one step raised is such an attempt, and names that step. Such a
run did not complete (`execution_status` `error`).

`<case>/attempts.json` holds `schema_version`, `case`, `planned` and
`attempts`, one entry per attempt, numbered from 1 in the order the trials
started:

| Field | Meaning |
| --- | --- |
| `attempt` | Its number. |
| `trial` | Its folder, `logs/harbor/<trial>`, or `null` when Harbor left none. |
| `status` | `completed`; `error`, with `reason`, when its result could not be read or the agent or harness raised; `missing`, with `reason`, when Harbor left no trial for it. |
| `step` | Packages with steps, in an attempt that is an `error` because a step raised: that step. |
| `results` | Each check's `pass`, `fail` or `unknown` as the verifier recorded it, read in a package with steps from the step the check is at; every check is `unknown` in an attempt that did not complete. |
| `graded` | Only in an attempt that did not complete and was graded anyway: kept for its logs, never counted. |
| `reward` | The reward the verifier wrote, or `null`; in a package with steps, that of the last step that wrote one. |
| `rewards` | Packages with steps: the reward each step's verifier wrote, by step. Each is compared with the gating checks at that step, 0 for a step with none, and a reward that does not match gives a warning. |
| `started_at`, `finished_at` | As Harbor recorded them, or `null`. |
| `usage` | Only when the adapter reported it: `n_input_tokens`, `n_cache_tokens`, `n_output_tokens` and `cost_usd`. |

A base and a head attempt with the same number are never paired: each side is
combined on its own.

## Usage

A run adds up its attempts in `usage`, for each case and in total; so does
`eval check` in `check.json`. `minutes` sums each attempt's time, to a tenth
of a minute; the run's own `minutes` is its wall time. `reported` counts the
attempts whose adapter reported any usage. `cost_usd` and each token count sum
only the attempts that reported them, and are `null` when none did: unknown is
never 0. Fixtures make no model call, so `eval check` reports none.

A loop's budget adds up the full runs and the run minutes of its head runs,
its trials and its lost or interrupted runs, and, with a cost cap, the cost
their attempts reported; time between runs does not count. `loop status`
estimates the next runs in `loop.estimate`: `screen`, `final` and `full`, from
the baseline's attempts, else the last `eval check`, else the baseline's whole
run, and from the loop's own attempts once every ready package has some;
`basis` says which, and `remaining` what the budget has left. When the final
run's estimate does not fit what is left, the loop stops on its budget
(`stop_budget` with `budget_reason` `final_run_does_not_fit` and the
estimate). `eval review` gives `run_plan.estimate` for 1, 3 and 5 attempts,
from the recorded baseline's attempts as `loop start` does, else from
`eval check`; `estimate_missing` names packages it could not estimate. The
budget charges each run its wall time, which is more than its attempts take.
So an estimate from attempts adds to each run the baseline's per-run
overhead: its `usage.minutes` less its `attempt_minutes`, never below 0.
`run_overhead` gives it, with the baseline it came from.

## Same code

Results add up across runs. Every result of one Spec export counts with the
others of the same code (`code_snapshot.digest`), package (`run_digest`, else
`task_digest`), agent and model: base and head runs, trials, full and partial
runs, in every loop of the export or outside one. Each attempt counts on its
own. A lost run counts as one failure of every gating check of its packages on
its code; an interrupted run counts the attempts it completed. A run during
which the code or a package changed, one that did not execute, and one whose
code cannot be known add nothing. A pass or a failure counts only from an
attempt that completed, and `unknown` never counts.

One failure among them is never cancelled. `loop accept` refuses a run when a
gating check failed on its code, packages, agent and model in any other run
(`unstable`). In a loop without final runs, `loop status` stops the loop
(`stop_unstable`) when a gating check passed and failed on the code and
packages of one of its runs. In a loop with final runs, one failed final run
means that code can never be accepted, and the loop stops with the second
failed final run, or with a failure on the code of a final run that passed. A
changed package, agent or model starts a new count; a changed fixture does
not. The records are in `runs/`, which Git ignores, so the count covers this
machine's runs.

## Verdict of a run

- `fail`: a gating check has failing evidence from an attempt that completed,
  and neither the code nor a package changed during the run. A final run
  stops at the first package whose gating checks failed, unless
  `--all-packages` was given, and skips the rest.
- `pass`: a full head run that completed on code and packages that did not
  change during it, ran every package, and every gating check passed. A
  light-tier run in which an attempt reported tokens or cost cannot pass, and
  a trial never passes.
- `unverified`: no proven failure, but something was skipped, blocked or
  unknown, the code or a package changed during the run, or the run was a
  trial.

Report the comparison beside the verdict: improved, kept, baseline mismatch or
head only. A pass outside a loop is a comparison, not an acceptance.
