# Run records v0.1

Every run has its own folder and is written once.

```text
.genesis/edd/<change>/runs/<run-id>/
├── run.json                  identity and verdict of this run
├── compare.json              head runs only: each check against the baseline
└── <case>/
    ├── check-results.json    what the verifier recorded
    ├── reward.json           the verifier's total
    └── logs/                 Harbor's job output: agent, verifier and trial logs
```

`runs/` is ignored by Git. The records are still evidence: a rerun does not
replace an earlier run.

## run.json

| Group | Field | Meaning |
| --- | --- | --- |
| Verdict | `execution_status` | `completed`, `blocked` (no package could run), `error` (Harbor or the environment failed) or `not_run` (a declared unavailable baseline). Separate from any business result. |
| Verdict | `verdict` | Head runs: `pass`, `fail` or `unverified`. `null` for a baseline, which records results and decides nothing. |
| Identity | `run_id`, `side` | Start time with a suffix; `base` or `head`. |
| Identity | `code_version` | A commit when the tree is clean, `uncommitted` when it is not, `empty` when there is no code. |
| Identity | `spec_snapshot` | The change and the exported handoff the packages were written for. |
| Baseline | `is_baseline` | True only for a base run that actually executed. |
| Baseline | `baseline` | The baseline run a head run is compared with, or `null`. |
| Baseline | `base_run` | Head runs: the base record they were compared with, a baseline or the record of an unavailable one. While a loop runs, it is always the loop's baseline. |
| Baseline | `baseline_unavailable_reason` | `no_implementation`, `execution_blocked` or `incompatible_tasks` when there is no usable baseline. |
| Baseline | `baseline_expectations` | Base runs that execute: the expected result of every declared check and the reason, fixed before the code changed, including packages that could not run yet. Empty for an unavailable baseline. |
| Baseline | `baseline_mismatch` | Base runs: checks whose result differs from the expectation. |
| Snapshot | `code_snapshot` | The commit, the application files that differ from it with their digests, a digest of the code, and `patch`: `code.patch` in the run folder holds those differences. The commit plus the patch restore the exact code. The digest covers content only, every file the run saw, committed or not; `digest_of` is `content`. Committing the same code keeps the digest, so a commit alone is not a code change. A file such as `.dockerignore` counts, because it changes what the image holds; `.genesis/`, `openspec/` and the installed skills do not. Records without `digest_of` come from an earlier version whose digest included the commit: they compare by their commit when they had no uncommitted change, and otherwise not at all. |
| Snapshot | `task_digest` | Digest of each package together with the project kit. Only identical ones are compared. |
| Snapshot | `environment_ref` | Harbor version, agent, model, attempts and each case's dependencies with their mode. |
| Snapshot | `map_ref` | The Map recorded with the Spec, or `null`. Its `path` is the copy committed in the change folder, `openspec/changes/<change>/business-map.json`; a change made before the copy existed names `.genesis/out/...`. |
| Detail | `cases`, `skipped`, `warnings` | Per-case execution and gating counts; packages that were not runnable; anything the reader should know. |

## compare.json

Each entry names `case`, `check`, `intent` and `role`, with `before` (the
baseline result, or `null` with `before_unavailable_reason`), `after`, the
`verdict` and the verifier's `evidence`. `before_unavailable_reason` is the
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

## Verdict of a run

- `fail`: a gating check has failing evidence.
- `pass`: the run completed, every package ran, and every gating check passed.
  A project with no baseline can reach this.
- `unverified`: no proven failure, but something was skipped, blocked or
  unknown.

Report the comparison beside the verdict: improved, kept, baseline mismatch or
head only.
