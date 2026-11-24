# Run records v0.1

Every run has its own folder and is written once.

```text
.genesis/edd/<change>/runs/<run-id>/
├── run.json                  identity and verdict of this run
├── compare.json              head runs only: each check against the baseline
├── code.patch                code the commit does not hold, if any
└── <case>/
    ├── check-results.json    each check's result, combined over the attempts
    ├── reward.json           1 when every gating check passed, else 0
    └── logs/                 Harbor's job output: agent, verifier and trial logs
```

EDD writes `<case>/check-results.json` and `<case>/reward.json`, not the
verifier: one result per check, combined over the attempts as described under
Attempts, and only when some attempt recorded results. The verifier's own files
are under `logs/harbor/<trial>/verifier/`.

`.genesis/edd/.gitignore` keeps `runs/`, `checks/`, `loop.json` and
`loop-start.patch` out of Git: they are the evidence and the loop state of this
machine, so a fresh clone has neither runs nor a running loop. Lines you add to
that file are kept. The records are still evidence: a rerun does not replace an
earlier run.

A run writes `run.json` last. A folder without it was left by a run that was
interrupted, or is still running. It is not counted or compared; `run start`
and `loop status` name it in a warning, and it can be deleted once its logs are
no longer needed.

## run.json

| Group | Field | Meaning |
| --- | --- | --- |
| Verdict | `execution_status` | `completed`, `blocked` (a baseline with no package that could run; a head run with none is refused and writes nothing), `error` (Harbor or the environment failed) or `not_run` (a declared unavailable baseline). Separate from any business result. |
| Verdict | `verdict` | Head runs: `pass`, `fail` or `unverified`. `null` for a baseline, which records results and decides nothing. |
| Verdict | `code_changed_during_run` | True when the code at the end of the run differs from the code at its start. Each package builds from the code as it is when it runs, so the results belong to no single version: a head run is `unverified`, a base run is not a baseline, and `loop accept` refuses it. A base run that completes while the code changes keeps `execution_status` `completed`, with `baseline_unavailable_reason` `execution_blocked`; one that also errored keeps `execution_status` `error`. Run again without editing the code. |
| Identity | `schema_version` | Version of the record format, `1.0`. |
| Identity | `run_id`, `side` | Start time with a suffix; `base` or `head`. |
| Identity | `scope` | `full`, or `partial` for a head run limited with `--case`. A partial run never passes. |
| Identity | `started_at`, `finished_at` | When the run started and ended, as UTC timestamps. |
| Identity | `code_version` | A commit when the tree is clean, `uncommitted` when it is not, `empty` when there is no code. |
| Identity | `spec_snapshot` | The change and the exported handoff the packages were written for. |
| Baseline | `is_baseline` | True only for a base run that executed to the end on code that did not change during it. |
| Baseline | `baseline` | The baseline run a head run is compared with, or `null`. |
| Baseline | `base_run` | Head runs: the base record they were compared with, a baseline or the record of an unavailable one. While a loop runs, it is always the loop's baseline. |
| Baseline | `baseline_unavailable_reason` | `no_implementation`, `execution_blocked` or `incompatible_tasks` when there is no usable baseline. |
| Baseline | `baseline_expectations` | Base runs that execute: the expected result of every declared check and the reason, fixed before the code changed, including packages that could not run yet. Empty for an unavailable baseline. |
| Baseline | `baseline_mismatch` | Base runs: checks whose result differs from the expectation. |
| Snapshot | `code_snapshot` | The commit, the application files that differ from it with their digests, a digest of the code, and `patch`: `code.patch` in the run folder holds those differences. The commit plus the patch restore that code. When the patch cannot be written, `patch` is missing and a warning says the code of the run cannot be restored. The digest covers content only, of tracked files and of untracked files Git does not ignore, committed or not; `digest_of` is `content`. Files Git ignores, such as `.env` or local data, are in neither the digest nor the patch, yet the Docker build context, the project root, holds them: keep them out of the image with `.dockerignore`. Committing the same code keeps the digest, so a commit alone is not a code change. A file such as `.dockerignore` counts, because it changes what the image holds; `.genesis/`, `openspec/` and the installed skills do not. Records without `digest_of` come from an earlier version whose digest included the commit: they compare by their commit when they had no uncommitted change, and otherwise not at all. |
| Snapshot | `task_digest` | Digest of each package together with the project kit. Only identical ones are compared. |
| Snapshot | `environment_ref` | Harbor version, agent, model, attempts and each case's dependencies with their mode. A head run whose agent, model, attempts or Harbor version differ from its baseline's warns; the verdicts stay as they are. |
| Snapshot | `map_ref` | The Map recorded with the Spec, or `null`. Its `path` is the copy committed in the change folder, `openspec/changes/<change>/business-map.json`; a change made before the copy existed names `.genesis/out/...`. `mode` and `freshness` are as `spec new` recorded them: `mode` is `map` or `unknown`, and `freshness` is `verified`, `stale` or `unverified` against the commit the Spec was written on. Changes made before `mode` was recorded have none. |
| Detail | `cases`, `skipped`, `warnings` | Per-case execution and gating counts; packages that were not runnable; anything the reader should know. |

## compare.json

Each entry names `case`, `check`, `intent` and `role`, with `before` (the
baseline result, or `null` with `before_unavailable_reason`), `after`, the
`verdict` and the verifier's `evidence`, and `flaky: true` when the check gave
different results across attempts. `before_unavailable_reason` is the
baseline's own reason when no baseline ran, `not_run_at_baseline` for a package
the baseline did not run, and `incompatible_tasks` for a package that changed
since. `base_run` names the base record, as in `run.json`.

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

`--attempts N` runs each package N times. EDD combines each check over the
attempts: one failing attempt makes it `fail`; otherwise one attempt without
evidence makes it `unknown`; otherwise it is `pass`. An attempt Harbor left no
readable result for has no evidence. A check whose attempts differ carries
`flaky: true` in `<case>/check-results.json` and `compare.json`, and the run
warns. Its evidence counts the results of every attempt.

## Verdict of a run

- `fail`: a gating check has failing evidence, and the code did not change
  during the run.
- `pass`: the run completed on code that did not change during it, every
  package ran, and every gating check passed. A project with no baseline can
  reach this.
- `unverified`: no proven failure, but something was skipped, blocked or
  unknown, or the code changed during the run.

Report the comparison beside the verdict: improved, kept, baseline mismatch or
head only.
