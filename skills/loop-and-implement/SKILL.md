---
name: loop-and-implement
description: Implement or judge a change in a Genesis EDD loop. The Spec export, the confirmed eval packages, the baseline on the start code and the run plan stay fixed while the code changes; every run is recorded and counted, the budget stops the loop, and only the user accepts, declines or ends it. Use when a change has the user's confirmation of its checks and a baseline, and the user wants the code written, fixed, or judged as it already is. It does not write specs or eval packages.
---

# Loop and Implement

A loop changes the application, or judges code already changed, against a
target that does not move: the current Spec export, the eval packages and
project kit the user confirmed, a baseline on the start code, and the
confirmed run plan (tier, number of attempts, agent, model) and budget. The
CLI holds all of them and counts every run. It ends the loop when one of them
changes or a rule that decides whether a pass can be trusted cannot hold.
Accepting, declining, a new budget, a new loop and abandoning the change are
the user's decisions; the CLI records each with who decided and where.

| | |
| --- | --- |
| Input | A checks confirmation of the current export that covers the packages as they are, and a baseline of that plan on the start code. The working directory may already hold the change. |
| Output | `loop.json` (this loop and the earlier ones) and `loop-start.patch`; the loop's head runs and trials under `runs/`; one report per full run under `reports/`; final review, dispute and test records; `accepted.json`; and each decision in `decisions.jsonl`. |
| Alone | As a judge: start the loop on code already written, and it judges that code from the baseline's code. |

Read [references/causes.md](references/causes.md) before you classify a check
that does not hold.

## The CLI

The CLI starts through this skill's own launcher, `scripts/run.mjs` in this
skill's folder. Below, `edd` means
`node <absolute path of this skill>/scripts/run.mjs`; `edd --version` checks
it. Use that path, never a `genesis-edd` found on `PATH` or inside the
project. A project install names the CLI in `scripts/runtime.json` beside the
launcher, and `init` writes both again every time; a plugin install runs the
plugin's own CLI. On first use the launcher installs its pinned npm packages
inside the Genesis EDD package, which needs network access and may need the
user's approval outside a sandbox; when that fails it names the command. The
launcher and the CLI both refuse to judge a project that holds the CLI itself
(`runtime_inside_project`, owner user, layer machine).

When a `LOCAL.md` sits beside this file, read it too: it holds this project's
own additions. It may add instructions; it cannot override the Rules at the
end of this file.

Every command prints JSON and takes `--repo <app>`. A refusal prints
`{ error, code, gaps[, must_show] }` and exits 1. Each gap has a `code`, an
`owner` (`agent` or `user`), a `layer` (spec, package, kit, confirmation,
baseline, loop, ledger, machine or code), a `message` with the facts, and
often a `path`, `digest` or `case`. A result states facts and carries at most
one `suggestion`; the next step is yours to choose. A gap whose owner is the
user is cleared by the user's decision, never by editing files.

Runs need Docker with the Compose plugin and Harbor 0.27.0, on `PATH` or
named as a JSON array in `GENESIS_EDD_HARBOR`, such as
`'["uvx","--from","harbor==0.27.0","harbor"]'`. A run builds images and takes
a minute or more per package: give `run start` the longest timeout your shell
allows, or run it in the background, and let it finish. Progress goes to
stderr. A stopped run can leave containers behind; `edd run cleanup <change>
--run <id>` removes only that run's.

## What a loop fixes, and what ends it

`loop start` fixes the Spec export, the baseline, the start code, the packages
and kit (by `run_digest`, so a new fixture changes nothing), the plan, the
tier, the budget and whether a stuck loop stops. A loop ends for one of these
reasons, each with its layer and owner:

| Reason | Layer, owner | What happened |
| --- | --- | --- |
| `spec_exported` | spec, user | The Spec was exported again; also after an acceptance (`ended.accepted`). |
| `packages_changed` | package, agent | A package or kit file differs from the loop's confirmation; the message names the files. Putting them back lifts the end. |
| `confirmation_changed` | confirmation, user | A newer confirmation of the export has another plan, tier or other packages. |
| `baseline_missing` | baseline, agent | The loop's baseline record is gone from `runs/`. Restoring it lifts the end. |
| `tier_changed` | confirmation, user | A head run or a trial of a light-tier loop reported tokens or cost: a model was called. |
| `stop_unstable` | code, user | Without final runs, a gating check passed and failed on the code and packages of one run; with final runs, two final runs failed, or a check failed on the code of a final run that passed. |
| `stop_incomplete` | loop, user | Two final runs of the same code found no failure but left checks unknown. |
| `stop_no_gating` | package, user | No gating check is left: the user judges every line, so no run can pass. |
| `stop_stuck` | code, user | The same gating checks failed in the last two full runs on different code, and the user's confirmation asked to stop then (`--stop-on-stuck`). Otherwise this is only a warning (`stuck`). |
| `stop_budget` | loop, user | The budget is used up (`budget_used_up`), or the final run's estimate does not fit what is left (`final_run_does_not_fit`). `loop budget` can lift it. |
| `loop_end`, `loop_decline`, `change_abandon` | loop, user | Recorded with `loop end`, `loop decline` or `change abandon`. |
| `loop_record_missing` | ledger, user | `loop.json` is missing or unreadable; the loop known from its runs counts as ended. |

An end that comes from a changed input lasts while the input differs. A stop
holds for good, since the runs it rests on no longer change, except a budget
stop the user lifts with `loop budget`. A recorded end is final.

Once a loop ended, `run start` refuses its head runs and trials (gap
`loop_ended`, or the stop code) and `loop accept` refuses it. Unless the user's
acceptance still covers the code, the change is locked (`change_locked`, owner
user, beside the end's own gap): no head run or trial of the application code
runs until the user agrees to a new loop, revises the budget of a loop that
ended only on its budget, or abandons the change; a new Spec export does not
lift it. When the code moved past a run the user accepted, the lock names that
acceptance as outdated. `loop status`
gives `ended` with the facts, `code_files` (application files changed since
the start code), `start_code`, and `new_loop` with its gates (a confirmation
of the packages as they are, a baseline on the start code, the user's
consent) and the consents it needs. Its `must_show` then holds `end`, `usage`,
`budget`, `disputes` and `lost_runs`: put them in front of the user.

## Starting a loop

```sh
edd loop start <change> --repo <app> [--by <name> --ref <where they said so>] \
  [--max-iterations N] [--max-minutes M] [--max-cost USD]
```

Starting a loop is the user's decision. `--by` and `--ref` record it, unless
the latest confirmation of the export, which covers the packages as they
are, was made with `--start-loop` and no loop started since; then that
confirmation is the consent. The `loop start` action of `workflow status`
reads that consent the same way, and names the confirmation in `needs`. The
budget is the confirmed one; flags replace it, and a budget above the
confirmed one needs `--by` and `--ref` too. When earlier attempts show the runs may not fit the
budget, `loop start` warns (`budget_unfit`); the budget still stops the loop.

`loop start` refuses with `LOOP_INPUT_BLOCKED`:

| Gap | Owner, layer | Meaning |
| --- | --- | --- |
| `loop_consent_missing`, `budget_over_confirmed` | user, loop | The user's consent to the loop, or to a bigger budget, is not recorded. |
| `loop_running` | agent, loop | A loop of this export is live. One loop runs at a time. |
| `baseline_missing`, `baseline_mismatch`, `baseline_packages_differ`, `baseline_plan_differs`, `baseline_not_at_start` | agent, baseline | No baseline of this export (the latest full base record counts), or one that did not behave as declared, ran other packages or another plan than confirmed, or ran on other code than the pinned start code. |
| `start_code_unknown`, `start_code_unrecoverable` | agent, baseline | The baseline's code has no content digest, or its commit or patch is gone, so the start code cannot be rebuilt. |
| `light_baseline_required` | agent, baseline | A light-tier loop in an existing project needs a baseline that ran. |
| `checks_unconfirmed` | user, confirmation | The user has not confirmed the packages as they are. |
| `confirmation_invalid`, `confirmation_unreadable`, `confirmation_newer` | agent, confirmation | `confirmed.json` was edited by hand, cannot be read, or comes from a newer release. |
| `attempts_undecided` | user, confirmation | A package declares a live dependency and the baseline fixed no number of attempts. |
| `tier_light_unfit` | user, confirmation | The user confirmed the light tier, and the change no longer qualifies for it. |
| `then_unbound` and the gaps `eval validate` reports | agent, package | A package is still in checks.json 1.0, whose checks name no line, or the packages are not valid as they are. |
| `gating_missing` | user, package | Every line is in `scenario.manual`: no run can pass. |
| `ledger_index_missing` | user, ledger | `runs/index.jsonl` is gone though runs were recorded in it. |
| `git_missing` | user, machine | The project is not a Git repository. |

The start code is the code the baseline ran on: its commit plus
`loop-start.patch`. Until a loop of the change is accepted or the user
abandons the change, every new loop keeps the start code of the change's first
unaccepted loop (`start_from: pinned`), and every base record goes there;
`run start --baseline --at-start` records one there without touching the
working directory. Once a loop is accepted the start code is no longer
pinned: a new loop of the same export may start with the user's consent, on
the latest baseline of the export wherever it ran, and records the loop it
follows.

The working directory may already hold the change. `loop.json` then records
`worktree_moved` and the files that moved; those edits are part of the loop's
change, and the user sees them at acceptance. Runs of the export made outside
a loop before it are recorded as `pre_loop`, and what earlier loops of the
change used as `earlier_loops`.

Nothing has to be committed: every run stores its code as a commit plus
`code.patch`. Commit on a branch only if the user wants it. If `.git` is
read-only, as in some sandboxes, carry on without commits. When a patch cannot
be written, `run start` warns that the code cannot be restored: keep a copy of
the uncommitted files before you change them. To go back to the code of a run,
check out its `code_snapshot.commit` and `git apply` its `code.patch`, with
your own changes set aside first.

## Runs of a loop

`edd run start <change> --repo <app>` makes a full head run of the loop. The
plan is the loop's: `--attempts`, `--agent` or `--model` with another value is
refused (`run_plan_fixed`); the same value is accepted.

- **Screen and final runs.** When the plan runs a package with a live
  dependency more than once, each iteration's full run is a screen run, with
  one attempt of each package. Once a screen run passed on the code as it is
  now, and that code never failed a gating check, the next full run of it is
  its final run (`final_run_due`): the plan's attempts, the packages that
  failed before first, stopping at the first package that fails unless
  `--all-packages` is given. A final review is not waited for before it, only
  before acceptance. Only a passing final run can be accepted. One failed
  final run means that code can never be accepted; a second one stops the
  loop.
- **Light tier.** Each package runs once, there are no screen or final runs,
  and a head run or a trial whose adapter reports tokens or cost ends the
  loop (`tier_changed`).
- **Partial runs** (`--case <id>`) give a quick look at a package. They never
  pass, and their minutes count toward the budget.
- **Trials** (`--trial`) made during a loop spend its budget, and are never
  one of its runs.
- **Reports.** Each full head run writes `reports/<run>.md` with Result and
  Changes from the records. Notes are yours: the cause of an open check, what
  was tried, anything the user should read. `edd loop report <change> --run
  <id>` writes a missing one. A report gates nothing.
- **Budget.** It counts full runs, run minutes (the Docker time of the loop's
  head runs, trials and lost runs) and, with a cap, the cost adapters
  reported. Once it is used up, `run start` refuses head runs and trials
  (`stop_budget`); a passing run can still be reviewed and accepted.
- **Project tests.** `edd loop tests <change> --command <text> --exit-code
  <n> [--summary <text>]` records a run of the project's own tests on the
  code as it is; acceptance shows it as your record. Run them with an
  interpreter or toolchain the project supports, such as its declared Python
  version, its lockfile or its CI (for example `uv run`), and name it in
  `--command` or `--summary`, so the record says what ran.

`edd loop status <change> --repo <app>` is read-only:

- `phase`: `live`, `closing` (the budget is used up, or a stop applies, and
  only the review and acceptance of a passing run are left), `ended` or
  `done` (the user's acceptance covers the loop). Without `loop.json` and the
  run records, as in a fresh clone, a committed `accepted.json` of the current
  export gives a read-only `done`: `situation.local_records` is false, and
  `code_matches` says whether the code is the accepted code.
- `situation.code`: `open` (gating checks still fail), `regression` (a check
  that passed now fails), `code_moved` (the code changed after the latest
  run), `run_not_settled` (the code or packages changed during it),
  `execution_incomplete` (it did not complete; a gating failure in a completed
  attempt still counts), `screen_burned` (a screen run passed on code that
  already failed), `final_failed`, `final_run_due`, `eval_blocked` (something
  outside the packages refuses every run, such as `.dockerignore`),
  `spec_invalid` (the Spec files differ from the loop's export, or no longer
  validate), `acceptable`, `accepted` or `ended` with its reason.
- `final`, `checks`, `regressions`, `lost_progress`, `stuck`, `unstable`,
  `loop` (plan, tier, budget, `used`, `exhausted`, `estimate`, `usage`,
  `trials`, `lost_runs`), `review`, `disputes`, `tests`, `acceptance`.
- `map_scope`, when the Spec recorded a Map: whether a Genesis review from
  it covers the whole project or, for the Map of a Genesis change review,
  only the flows that review analyzed (`scope_limited: true`, with
  `scope_note`).
- `gates`: the gaps the CLI would refuse a head run (`head_run`) or an
  acceptance (`accept`) with now.
- `obligations`: what the CLI cannot check itself, such as a final review's
  content, what the user must be shown, and the user's consent.
- `must_show`, `warnings` and at most one `suggestion`.

## Judgment

- **Read before changing.** Read `compare.json` and each failing case's
  `logs/`, which hold the program's output, the verifier's output and the
  stand-ins' records. The stand-ins' records show what the program actually
  did.
- **Classify, then change the layer the evidence points to**, not the one
  that is easiest to change; [references/causes.md](references/causes.md)
  lists the causes and their signs. A fault in a package or the kit is fixed
  in the packages, which ends the loop and needs the user's new confirmation.
- **Root cause, smallest change.** Find the cause first, then make the
  smallest change that meets the requirement as written. Try it locally, by
  running the program or the project's own tests, before a full run.
- **A regression** is a gating check that passed at the baseline, or in the
  latest earlier full run with a result for it, and fails now. Restoring the
  code of the last run where it passed and reapplying the changes one at a
  time finds the change that breaks it.
- **The same failure on different code** (`stuck`) says the cause is not
  where the changes went. Read the evidence again rather than repeat the same
  kind of change, and tell the user when you cannot find it.
- **Results that vary** on the same code are a finding, not noise: a check
  must hold every time. Compare a failing attempt's logs with a passing one's
  through `<case>/attempts.json`, and look for the source, such as a model,
  the clock, random numbers or an offline fallback. A final run that fails
  after its screen run passed on the same code varies by definition.
- **A new project** starts on the entry skeleton the packages are connected
  to; build the behaviour on it like any other change.
- **A check you think is wrong** is disputed, not edited: `edd loop dispute
  <change> --check CASE:CHECK --evidence <file>` records the evidence, and
  the user rules with `loop dispute --resolve <id> --ruling accept|reject
  --by --ref`. An accepted ruling agrees to a package change; the change
  itself ends the loop (`packages_changed`), and the user confirms the fixed
  package before a new loop. Disputes are shown at acceptance.

## Final review

Acceptance needs a final review of the accepted run's code, recorded after
the run it reviewed finished. A review of a passing screen run covers its
final run, which runs the same code. `loop status` gives `review` with the run
to review, `flips` (each gating check that went from not passing to passing
against the baseline), the questions, the reviewer kinds, `eval_literals`
(numbers and literals of the packages' instructions found in the added lines:
a hint, never a verdict; a line in a test file is marked `test`, and a
literal found only in test files `only_tests`), files that were uncommitted
when the loop started, and, when the Spec recorded a Map, an optional Genesis
review.

```sh
edd loop review <change> --repo <app> --run <id> --answers <file> \
  --reviewer subagent|human|genesis|self [--by <name>]
```

The answers file:

```json
{
  "flips": [{ "case": "submit-failure-s1", "check": "c1", "explained_by": "The 503 branch in submit.py returns before notify()." }],
  "special_cases": { "found": false, "detail": null },
  "outside_spec": { "found": false, "detail": null },
  "side_effects": { "found": false, "detail": null },
  "notes": "Read the Spec, the diff from the start code and the latest report."
}
```

Every flip needs an `explained_by`; `special_cases` says whether the change
special-cases an evaluation input, `outside_spec` whether it changes anything
the Spec does not ask for, `side_effects` whether it has a side effect no
check covers, each with a `detail` when found. A finding, the reviewer's
`notes` and a self review (`--reviewer self`) are shown to the user and
recorded with the acceptance. It refuses a run that did not pass
(`not_passing`), is not a full run of the loop (`run_unknown`), has no content
digest (`code_unknown`), answers that miss something
(`review_answers_incomplete`), and a loop that ended or is accepted already.

What makes a review worth its record:

- A reviewer in a fresh context, given only the Spec, the diff from the
  start code and the latest report, sees more than the author; without a
  subagent or a person, say plainly that it is a self review.
- Ask it to look for special cases of the evaluation inputs, changes the
  Spec does not ask for, side effects no check covers, and claims in the
  report the records do not support.
- Documentation the change edits states no more than the Spec and the code
  do. Behaviour the Spec leaves open is named as open or left out.
- Files already uncommitted when the loop started show up in a diff from its
  commit: tell the reviewer their earlier edits are not part of this change.
  Before the project's first commit, `loop-start.patch` holds the start code
  to compare with.
- A Genesis review starts from the Map the Spec was written against: pass
  `review.genesis_review.prepare` to every `genesis map prepare` of it.
  `--entries-from` needs Genesis Map at or after commit `9c0c914`; without
  it, run without the option and say the flow ids may differ. A Map from a
  change review covers only what that review analyzed: the Genesis review
  recorded from it (`loop review --reviewer genesis`), the acceptance
  result, `accepted.json` and `must_show` state that limited scope
  (`map_scope`). Genesis does not see the eval packages under `.genesis/`,
  so a verdict such as "not reached by any test" does not account for them. Never pass that review's Map to
  `spec new`, and leave the Map copy as it is.

## Acceptance

When a run is `acceptable`, `loop status` gives `must_show` with what the user
sees before deciding: `checks` (each check's before and after with its
counts; `label` says `holds (fixed)` for a check that went from not passing
to passing, `holds (kept)` for one that passed before), `strength` (a fixed sentence about what the attempts rule out; show
it as it is), `manual` (lines no check verifies), `self_review_lines`,
`judge_gating` (lines whose judge check the confirmation made gating, with
their proofs), `reviews`, `map_scope` (a Genesis review from the Map of a
change review, which covers only what that review analyzed),
`review_findings`, `self_review`, `eval_literals`, `project_tests`,
`disputes`, `usage`, `budget`, `pre_loop`, `worktree_moved`, `lost_runs`,
`old_package_failures`, `baseline_varied`, `final_runs_of_change` and
`unknown_attempts`, each when it has entries. Put
every one in front of the user; the wording and how many messages it takes
are yours. For a `manual` line, show what the evaluated agent produced, from
the case's `logs/` in every attempt of the accepted run, and accept only when
the user says each line holds. Show the diff too, whole for a small change,
else a summary and the files.

After the user's own words:

```sh
edd loop accept <change> --repo <app> --run <id> --by <name> --ref <where they said so>
```

It refuses, with the current `must_show`, a run that is a trial
(`trial_not_acceptable`), made outside a loop (`outside_loop`), not of this
loop (`run_unknown`, `run_unreadable`), not passing (`not_passing`), a screen
run where a final run is needed (`not_final`), of another plan
(`loop_plan_differs`), one during which the code or packages changed
(`code_changed_during_run`, `packages_changed_during_run`), code that failed a
gating check in any other run (`unstable`, owner user), packages that changed
since or that the latest confirmation does not cover (`packages_changed`,
`packages_unconfirmed`), a line without proof that its checks can fail
(`line_unproven`; in either tier a line whose judge check the confirmation
made gating needs its judge check's failure at the loop's baseline or a
reviewer's counterexample of the line that `eval check` proved), a run
without a final review of its code (`review_missing`), code that changed
since the run (`code_changed`), a loop
that ended (`loop_ended` or a stop) or whose Spec changed (`spec_changed`), a
missing run index (`ledger_index_missing`), and a loop already accepted
(`already_accepted`).

`accepted.json` keeps the checks, the plan, the tier, the strength sentence,
each line's proof, the final and screen runs with every full run of the loop,
the reviews and findings, the scope of the Spec's Map (`map_scope`), the
confirmations, the manual lines, the consent to the loop, the start code,
the disputes, the project tests, the budget with every revision and what
was used, and who accepted and where. The result says
whether everything is committed (`committed`, `commit`) or names every file
still to commit (`uncommitted`): the accepted code's files and the change's
own. Committing, merging and opening a pull request are the user's decisions. The acceptance holds (`done`) while
the code is the accepted run's, no full run after it fails, and no later run
of that code fails a gating check; otherwise `loop status` marks it
`outdated`, and a passing run of other code needs the user's acceptance
again.

## Declining, ending, budget, abandoning

- `edd loop decline <change> --by <name> --ref <ref> [--reason <text>]`: the
  user declines the loop; a running loop ends.
- `edd loop end <change> --reason <text> [--by <name> --ref <ref>]`: ends
  the running loop, with the user's name when it is their call. The change
  is then locked until the user agrees to a new loop, so tell them why.
- `edd loop budget <change> [--max-iterations N] [--max-minutes M]
  [--max-cost USD] --by <name> --ref <ref>`: the user revises the budget of
  a running loop, or lets a loop that ended only on its budget go on. Every
  revision is kept and shown at acceptance.
- `edd change abandon <change> --by <name> --ref <ref> --reason <text>`: the
  user abandons the change as it is: a running loop ends, and the pinned start
  code and the lock are released, so the next baseline may be recorded on any
  code.

When a loop stops or ends, or the user must decide, tell them the reason and
what changed, what passes, what still fails and why, what was tried, and what
you would try next.

## Where a change stands

`edd workflow status <change> --repo <app>` is read-only and optional. It
gives the facts of every layer (spec, packages, confirmation, baseline, loop,
ledger, machine), every gap, the `must_show` of any decision pending now, and
every action the CLI would take now, each with who takes it (`by`), the rules
it is about (`satisfies`, named in `rules`), the consent it needs (`needs`),
whether it ends a running loop (`effect`), and the gaps that would refuse it
(`blocked_by`). Each command still enforces its own gates.

## Rules

- Never change the Spec, its `genesis.json` or Map copy, a check, an
  expectation, a fixture's expected result, a reviewer's counterexample, a
  verifier's decision or a baseline to get a result. Expected results never
  change inside a loop.
- Never special-case the evaluation inputs in application code: a known
  title, an ID, a fixed date. Never use a stand-in for what the change
  modifies.
- Never shape a package to get a tier; only the user moves a change to the
  full tier.
- Never make an edit without behaviour to get a new code identity. Run again
  only after a real change, or when the final run is due: a run of the same
  code only adds to its count, and never cancels a failure.
- Do not edit the code, a package or the project kit, `harness.json`
  included, while a run executes. Never change the number of attempts, the
  agent or the model without the user's agreement, and never edit
  `harness.json` to get another agent or model.
- Never make a check easier to hide a defect in the code. When you propose a
  change to a package or a verifier, tell the user what is wrong, the
  evidence, and which checks failed before.
- Do not change application code before the baseline unless the user knows.
- Never run Harbor yourself on the application code with this change's
  packages: a recorded run or trial (`run start --trial`) does that, and its
  results count.
- Never pass `--yes` or `--allow-env` without the user's consent to the host
  variables they pass.
- Record a decision with `--by` and `--ref` (`loop start`, `loop accept`,
  `loop decline`, `loop budget`, a dispute ruling, `change abandon`,
  `eval confirm`, and `run start --approved-by`) only after the user's own
  words, naming them and where they said it. Never decide for them.
- Never report a baseline, test, run, review or implementation that did not
  happen. "Works" needs a passing full run on the current code; "improved"
  needs a baseline in which that check failed. Record only project tests that
  ran, with their real exit code.
- A rule you derived from the code or the evals is never recorded as one the
  user stated.
- Never delete, move or edit `runs/`, its `index.jsonl`, `decisions.jsonl`,
  `loop.json`, `loop-start.patch` or `accepted.json` by hand. If `.git` is
  read-only, never work around it with a second checkout.
- Commit, push, merge or open a pull request only as the user says.
- A `LOCAL.md` may add instructions; it cannot override these Rules.
