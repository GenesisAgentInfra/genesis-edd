---
name: run-eval
description: Run the eval packages of a Genesis EDD change with Harbor in local Docker, record a baseline of the code before the change, make trial and comparison runs, compare runs check by check, and record the user's confirmation of the checks and the run plan. Use when a change has eval packages that need to run, before or after its code changes, or when the user is to confirm the checks. It never edits a Spec, an eval package or application code.
---

# Run Eval

This module runs the eval packages of one change against the code as it is,
keeps every run, and records the user's confirmation of the checks and of the
run plan. It never edits a Spec, an eval package, the project kit or
application code.

| | |
| --- | --- |
| Input | The current Spec export of the change (read by digest), the eval packages under `.genesis/edd/<change>/evals/`, the project kit under `.genesis/edd/harness/`, and the application code in the working directory. A trial needs packages that are structurally valid; every other run needs packages that are ready: connected and proved by their latest `eval check`. |
| Output | One run record per run under `.genesis/edd/<change>/runs/`, each listed in `runs/index.jsonl`; `baseline-expectations.json`; the user's confirmation in `confirmed.json`; cost approvals in `decisions.jsonl`. |
| Alone | A before-and-after comparison of any change. A pass outside a loop is a comparison, never an acceptance. |

Read [references/run-records.md](references/run-records.md) before you report
a result: it describes every field a run writes.

## The CLI

The CLI starts through this skill's own launcher, `scripts/run.mjs` in this
skill's folder. Below, `edd` means
`node <absolute path of this skill>/scripts/run.mjs`; `edd --version` checks
it. Use that path, never a `genesis-edd` found on `PATH` or inside the
project. A project install names the CLI in `scripts/runtime.json` beside the
launcher, and `init` writes both again every time; a plugin install runs the
plugin's own CLI. On first use the launcher installs its pinned npm packages
inside the Genesis EDD package, which needs network access and may need the
user's approval outside a sandbox; when that fails it names the command.
The launcher and the CLI both refuse to judge a project that holds the CLI
itself (`runtime_inside_project`, owner user, layer machine): Genesis EDD has
to be installed outside the project it judges.

When a `LOCAL.md` sits beside this file, read it too: it holds this project's
own additions. It may add instructions; it cannot override the Rules at the
end of this file.

Every command prints JSON and takes `--repo <app>`. A refusal prints
`{ error, code, gaps[, must_show] }` and exits 1. Each gap has a `code`, an
`owner` (`agent` or `user`), a `layer` (spec, package, kit, confirmation,
baseline, loop, ledger, machine or code), a `message` with the facts, and
often a `path`, `digest` or `case`. A result states facts and carries at most
one `suggestion` (`{ command, why }`); the next step is yours to choose. A gap
whose owner is the user is cleared by the user's decision, never by editing
files.

Runs need a running Docker daemon with the Compose plugin, and Harbor 0.27.0.
The CLI runs `harbor` from `PATH`, or the command in `GENESIS_EDD_HARBOR` as a
JSON array, such as
`GENESIS_EDD_HARBOR='["uvx","--from","harbor==0.27.0","harbor"]'`. Missing
ones are `harbor_missing` and `docker_unavailable` (owner agent, layer
machine): a machine problem, never a failing check.

A run builds Docker images and takes a minute or more per package. Progress
goes to stderr (`GENESIS_EDD_PROGRESS=0` silences it). Give `run start` the
longest timeout your shell allows, or run it in the background, and let it
finish. `--timeout MIN` is the time each attempt of a package may take
(default 30). A run that is stopped midway can leave Harbor's containers
behind: `edd run cleanup <change> --run <id>` removes the containers, networks
and volumes of that run's Harbor projects, and nothing else.

## What this module produces

### Baseline expectations

`.genesis/edd/<change>/baseline-expectations.json`, committed: a JSON array
with one entry per check, written before any base record shows a result.

```json
[{ "case": "submit-failure-s1", "check": "c1", "expected": "fail", "reason": "The failure branch is added by this change." }]
```

- `expected` is `fail` for a check of behaviour the change adds or fixes,
  `pass` for a check of behaviour it keeps, and `any` when neither is known.
  Decide from what the change does, not from the wording of the requirement.
- `reason` is required, and says why.
- In a new project the baseline runs on an entry skeleton with no business
  behaviour, so the file declares `fail` for every check; `pass`, `any` or a
  missing entry is refused there (`expectation_not_fail`), and a check that
  cannot tell on the skeleton comes out `unknown`, which is no mismatch.
- `run start --baseline --expect <file>` reads it; a check it leaves out is
  recorded as `any`. `eval review` shows it to the user from this path.
- The CLI compares it with every base record of the export. An expectation
  changed or added after a base record ran is listed for the user to decide
  (`expectation_changed_after_baseline`, `expectation_added_after_baseline`),
  with what the base records got.

### Run records

`edd run start <change> --repo <app>` with:

| Kind | Flags | What it is |
| --- | --- | --- |
| Baseline | `--baseline --expect <file>` | A base record of the code before the change. It is a baseline (`is_baseline`) only when it is a full record that executed to the end on code and packages that did not change while it ran. Its results are compared with the expectations (`baseline_mismatch`, `baseline_unstable`). |
| Baseline on the start code | `--baseline --at-start` | The same, run on the change's pinned start code, which the CLI rebuilds in a temporary folder; the working directory and `.git` stay as they are. |
| Nothing can run | `--baseline --unavailable no_implementation\|execution_blocked\|incompatible_tasks` | Records that no baseline exists, and runs nothing. Refused in the light tier of an existing project (`light_baseline_required`). |
| Head run | none | A run of the code as it is, compared check by check with a baseline. Inside a loop it is one of the loop's runs. Outside one it is a comparison only: its `run.json` records `not_acceptance: true`, and a pass there is never an acceptance. |
| Partial run | `--case <id>` (repeatable) | A quick look at some packages. It never passes and is never a loop's baseline. |
| Trial | `--trial` (with `--at-start` on the pinned start code) | Runs the structurally valid packages, ready or not, before or without a baseline. A trial is never a baseline, a loop run, an accepted run or a proof; the failures it records count for its code like any other. |

`--attempts`, `--agent` and `--model` set the run plan where the CLI lets a
flag set it (see below). `--all-packages` lets a final run of a loop go on
after a failing package, as a diagnosis; it spends the loop's budget like any
run.

What must hold for a base record a loop can start on:

- the packages it ran are the ones now, all ready and proved by their latest
  `eval check`; one that waits only for `eval check` is skipped, and a
  baseline that skipped it says so;
- it ran the plan of the user's current confirmation of these packages:
  `run start` refuses a baseline of another plan once one is confirmed
  (`run_plan_differs`), and `loop start` refuses a baseline whose plan differs
  from it (`baseline_plan_differs`);
- it matched its expectations (`baseline_mismatch` blocks a loop);
- once a loop of the change has started, and until one is accepted or the
  user abandons the change, it ran on the change's pinned start code
  (`baseline_after_change`, `baseline_not_at_start`; `--at-start` records
  there);
- its code can be rebuilt: a commit in this repository, plus the run's
  `code.patch` for what the commit does not hold (`code_unrestorable`,
  `start_code_unrecoverable` otherwise).

### The user's confirmation

`confirmed.json`, committed: the newest confirmation at the top level and
earlier ones under `earlier`. `edd eval confirm` writes it, and only with the
user's own words. Each entry keeps the packages and kit file digests, every
line with its checks, `expect`, counterexamples, proof and the reviewer's
verdict (a line whose judge check the user made gating carries
`judge_gating: true`), who reviewed (`review.origin`) and the answers about
changed packages, the expected baseline results the user saw, the run plan
(`tier`, `attempts`, `agent`, `model`, `budget` with full runs, run minutes
and an optional cost cap, `max_cost`, and `adapters` when a package names its
own), the tier's basis, the `must_decide` items that existed then, each with
its `decision` (the one a flag gave, or `confirmed_as_shown` for an item no
flag decides), `start_loop`, `stop_on_stuck`, `judge_gating`,
`accepted_verdicts`, `shown` (the digest of what `eval review` put in
`must_show`), `shown_source` (`verdicts`, the answers file given, and
`review_file`, whether it is the `review.json` that `eval review` reads), and
`confirmed` (`by`, `ref`, `at`, `kind` initial or revision, and an optional
`reason`). An entry edited by hand no longer matches its `id`
(`confirmation_invalid`); one written by a newer release is
`confirmation_newer`.

## Tiers

The CLI works out the tier from the packages and this machine's run records,
and `eval review` gives it as `run_plan.tier` with `eligible`, `proposed` and
the `reasons`. You never choose it; the user may move a change to the full
tier at any time.

- **Light:** every package sealed from the network, no live dependency, no
  model in the plan, a kit adapter that imports no model SDK or HTTP client
  and no package adapter the CLI cannot scan, and no run on this machine where
  the same package varied on the same code, reported model use, or was lost.
  In looking for a check that passed and failed on the same code, a judge
  check the user made gating counts like any gating check. Each package runs
  once. Every line a program checks needs a proof that its checks can fail
  before the user confirms it: its real failure, with evidence, in a
  completed attempt of a baseline that expected `fail`, on code where no run
  saw it pass; or a reviewer's counterexample that `eval check` proved. A line a code test checks takes
  that failure too, or a counterexample that is a code patch. A line whose
  check several lines share (`then_group`) is never proved by a failure at a
  baseline. In an existing project the baseline has to run.
- **Full:** every package sealed or declaring its live dependency. Packages
  with a live dependency run the user's number of attempts at the baseline
  and in a loop's final run.

In either tier, a line whose judge check the user makes gating needs the
same proof: its judge checks' failure at a baseline, or a reviewer's
counterexample whose `then` names the line, which expects `fail` for the
judge checks and `pass` or `unknown` for every other gating check, proved by
the last `eval check`. A judge left diagnostic needs no proof.

In a light-tier loop, a head run or a trial whose adapter reports tokens or
cost ends the loop (`tier_changed`), and such a head run cannot pass.

## Confirming the checks

`edd eval review <change> --repo <app>` is read-only. It returns every THEN
line with its checks, the reviewer's verdict, its expected and recorded
baseline result and what proves its checks can fail; `must_decide`, the
decisions that are the user's; `must_show`, what the user must see before
confirming, with `shown`, its digest; the reviewer's `questions`,
`reviewer_brief` and `review_template`; and `run_plan` with the proposed tier
and its reasons.

`must_show` keys, each a list: `lines`, `must_decide`, `run_plan` (tier with
`proposed`, `eligible` and `reasons`; agent; model; whether a number of
attempts is needed, with a proposal and what 1, 3 and 5 attempts rule out;
the estimate of the baseline, a screen run and the final run, from the
attempts of the recorded baseline plus its per-run overhead
(`run_overhead`) when one is recorded, else from the last `eval check`; what
the CLI does not count; the budget and cost cap), `adapters` (packages with their own
harness), `rebound` (packages `eval rebind` moved to this export),
`dependencies` (each package's dependencies, their mode and stand-in),
`code_checks` (checks that run a test command against the application code
directly), `judge_checks` (checks judged by the project's own program,
diagnostic unless the user makes their line gating), `then_groups` (a check
bound to several lines), `recorded_choices` (choices a package's Task.md
records that the Spec does not state), and `ledger` (lost, interrupted or
unindexed runs). Put every one in front of the user before they decide; the
wording and how many messages it takes are yours.

`must_decide` codes: `then_uncovered`, `manual_line`, `expect_differs`,
`self_review_only`, `self_review_verdict`, `verdict_acceptable`,
`changed_since_confirmation`,
`plan_changed_since_confirmation`, `baseline_plan_recorded`,
`spec_changed_since_confirmation`, `failed_with_old_package`,
`network_undeclared`, `expectation_changed_after_baseline`,
`expectation_added_after_baseline`, `code_changed_before_baseline` (a base
record ran on other code than `spec new` recorded), `trial_before_baseline`
(trials whose results were seen before any base record), `cost_approved_runs`,
`ledger_runs_lost`, `ledger_incomplete`, `package_rebound`, `judge_check`,
`then_group` and `variability_signals`. Each carries a message with its
facts. `expect_differs` and `self_review_verdict` are one item each, with
every line they concern under `lines`.

The reviewer's answers go in `.genesis/edd/<change>/review.json`, written from
`review_template` with its digests kept: a verdict and a note for every line,
`review.origin` (`review`, or `self-review` when the author judged alone), and
for every package changed since the last confirmation whether its diff loosens
a THEN line. `eval review` reads that file, so write it before you show the
user what they confirm: `eval confirm` records the digest of `must_show` as
it is with the `--verdicts` file it is given. A `--verdicts` file other than
that `review.json` is taken with a warning, not refused, and the
confirmation records which file it was in `shown_source`.

After the user's own words:

```sh
edd eval confirm <change> --repo <app> --verdicts .genesis/edd/<change>/review.json \
  --by <name> --ref <where they said so> [--reason TEXT] [--tier light|full] \
  [--attempts N] [--agent A] [--model M] [--max-iterations N] [--max-minutes M] \
  [--max-cost USD] [--start-loop] [--stop-on-stuck] [--judge-gating CASE:THEN]... \
  [--accept-verdict CASE:THEN --accept-reason TEXT]...
```

- The tier defaults to the proposed one. `--tier full` is always allowed and
  stays for later confirmations of the export: their plan records it as kept
  (`tier_by: kept`) and names the confirmation it came from (`tier_from`). In the light tier every
  package runs once, with no model and the agent of `harness.json`; it
  refuses `--agent` and `--model` (`light_plan_fixed`), and `--attempts`
  changes nothing there and is not recorded, with a warning.
- `--attempts` is the number of attempts of each package with a live
  dependency. Only a confirmation settles it (`attempts_undecided`, owner
  user, while a package declares one, or the agent runs with a model and a
  ready package declares none). It is the user's number: give them the cost
  of 1, 3 and 5 attempts from `run_plan.estimate`, and what each rules out.
- The budget is the flags, else the previous confirmation's of the same
  tier, else 5 full runs and 30 run minutes in the light tier, 5 and 60 in
  the full tier. `--max-minutes` counts run minutes, the Docker time of the
  loop's runs; waiting for the user does not count. `--max-cost` caps the cost
  adapters report; an adapter that reports none leaves the cap unenforced.
  With a live dependency and no cap, `eval review` and `eval confirm` warn.
- `--start-loop` records that the same words also start a loop: `loop start`
  then needs no `--by`/`--ref` until a loop starts after this confirmation.
  `--stop-on-stuck` records that a loop stops when the same gating checks
  fail twice on different code.
- `--judge-gating CASE:THEN`, once per line, makes a judge check's line
  gating: runs count that judge check like any gating check, and the line is
  confirmed only with the verdict `faithful` and a proof that it can fail, in
  either tier. Without it the judge stays diagnostic.
- `--accept-verdict CASE:THEN` with `--accept-reason TEXT` records that the
  user accepts a line whose checks the reviewer found `weaker` or `stronger`
  than it (`eval review` lists each as `verdict_acceptable`). Give one
  reason for all the lines, or one for each in the same order, in the
  user's words. The acceptance and its strength statement name each such
  line. A `different` or `vacuous` line can never be accepted: fix its check
  or move it to `scenario.manual`. A new review with another verdict needs a
  new confirmation.
- A `must_decide` item with no flag is decided by the confirmation itself:
  confirm only when the user accepts it, and put any condition they attach
  in `--reason`. It is recorded as `confirmed_as_shown`.
- A second confirmation of an export is a revision; `--reason` is optional.
  While a loop runs, a confirmation with another plan, tier or other packages
  ends it (`confirmation_changed`); one with the same plan and packages leaves
  it running.

`eval confirm` refuses with `CONFIRM_INPUT_BLOCKED` and writes nothing:

| Gap | Owner, layer | Why |
| --- | --- | --- |
| package gaps (`case_invalid`, `then_uncovered`, `case_stale`, `case_draft`, `draft_bound`, `shared_code_mismatch`, `then_unbound` and others) | as each gap says, mostly agent, package | the packages are not in a state a confirmation can cover: everything `eval validate` reports but `integration_pending`, and a package still in checks.json 1.0 (`then_unbound`) |
| `review_unreadable` | agent, confirmation | the answers file is no review, or a line has no verdict |
| `review_stale` | agent, confirmation | the answers are for another export or another version of a package, a line is missing or extra, or a changed package has no answer |
| `line_not_faithful` | agent, package | a line a program checks was judged other than `faithful`, and the user did not accept it as `weaker` or `stronger` |
| `verdict_not_acceptable` | agent, package | `--accept-verdict` names a line that is not gating, is `faithful`, or is `different` or `vacuous` |
| `manual_disputed` | agent, package | a `scenario.manual` line was judged other than `not_observable` |
| `package_loosens` | agent, package | a changed package's diff loosens a THEN line |
| `tier_light_unfit` | agent, confirmation | `--tier light` for a change that does not qualify; the reasons name each package and condition |
| `light_plan_fixed` | agent, confirmation | `--agent` or `--model` in the light tier |
| `line_unproven` | agent, package | light tier: a gating line has neither a real failure at a baseline nor a proved counterexample; either tier: a line whose judge check `--judge-gating` makes gating has no such proof |
| `network_undeclared` | agent, package | a package that can reach outside networks declares no live dependency |
| `judge_gating_unknown` | agent, package | `--judge-gating` names a line no judge check verifies |
| `attempts_undecided` | user, confirmation | the number of attempts is the user's and is not given |
| `confirmation_unreadable`, `confirmation_newer` | agent, confirmation | `confirmed.json` cannot be read, or was written by a newer release |

Outside a running loop, the result says whether a recorded baseline already
holds for these checks (`baseline.kept`), where a new one would go
(`baseline.on`, `baseline.at_start`), and what a new loop still needs
(`new_loop_needs`: a baseline, the user's consent).

## Runs, and what refuses them

`run start` refuses with `RUN_INPUT_BLOCKED` before Docker or Harbor starts:

| Gap | Owner, layer | Meaning |
| --- | --- | --- |
| `change_locked` | user, loop | The change's latest loop ended without acceptance. Head runs and trials of the application code wait until the user agrees to a new loop or abandons the change; a new Spec export does not lift it. A trial `--at-start` on the pinned start code is still allowed. |
| `cost_unapproved` | user, confirmation | The run calls a model (a live dependency, or a model the agent runs with) and no confirmation of this export records the user's plan yet. `--approved-by NAME --ref REF` records the user's approval; it is listed for the user at confirmation. |
| `baseline_missing` | agent, baseline | A head run needs a baseline of this export; `last_attempt` says why the last base attempt gave none. |
| `baseline_after_change` | agent, baseline | A base record on other code than the pinned start code. |
| `code_holds_accepted_change` | agent, baseline | A base record on the code that `accepted.json` records as accepted for this Spec export, as on a fresh clone that has no `loop.json`, unless that code is also the loop's start code. It would describe the change; a baseline of this change runs on its start code, which the message names, with the patch when the start code had uncommitted files. The patch is not committed, so a clone does not hold it. |
| `light_baseline_required` | agent, baseline | `--unavailable` in the light tier of an existing project. |
| `run_plan_differs` | agent, confirmation | A baseline with another plan than the user confirmed. |
| `run_plan_fixed` | agent, loop | Inside a loop, `--attempts`, `--agent` or `--model` differs from the loop's plan (`differs` names them). A value equal to the plan is accepted. |
| `attempts_undecided` | user, confirmation | A baseline, while a package declares a live dependency or the agent runs with a model and a ready package declares none, and no confirmation of this export gives the number of attempts. |
| `start_code_unknown` | agent, code | `--at-start` with no pinned start code. |
| `code_unrestorable` | agent, code | The code of a base record could not be saved as a commit plus a patch. |
| `working_tree_read` | agent, package | `--at-start`, and an environment reads the working directory by a path of its own. |
| `no_runnable_case`, `no_trial_case`, `draft_bound`, `case_invalid`, `shared_code_mismatch` | agent, package | No package can run, a package is written against a Spec draft or invalid, or its shared verifier code differs from the kit's. |
| `expectation_not_fail` | agent, baseline | A new project's baseline expecting `pass` or `any`. |
| `harness_missing` | agent, kit | No evaluated agent is named, by `--agent` or `harness.json`. |
| `harbor_missing`, `docker_unavailable` | agent, machine | The tools are missing or Docker is not running. |
| `loop_ended` or a stop code | per end reason | A head run or trial of a loop that ended, stopped or used up its budget (`stop_budget`). The gap names the reason, its layer and owner; `loop status` gives the facts. |

The run plan of a run:

- A baseline reads the plan of the user's current confirmation; outside one,
  the plan the user last confirmed for this export, else `harness.json`. A
  baseline recorded while no confirmation covers the packages runs with a
  warning, and a loop starts on it only once the user confirms that plan.
- Inside a loop the plan is the loop's, fixed by its confirmation. When it
  runs a package with a live dependency more than once, each iteration's full
  run is a screen run with one attempt of each package, and only the final
  run makes the plan's number; otherwise every full run follows the plan.
  Every package without a live dependency runs once.
- Outside a loop a head run follows its baseline's plan; flags may override
  it, and a run whose settings differ from the baseline's warns that the
  comparison may show that difference rather than the change.
- A package with its own `harness.json` runs with its own adapter, whatever
  the plan's agent is.

Host environment variables reach Harbor only with consent: `--yes` passes
every variable a package's `task.toml` declares, `--allow-env NAME[,NAME]`
only those named; without either none is passed. A declared variable without
a default that is not passed can stop its package. The run records which were
passed (`host_env`). `eval check` takes the same two flags.

The exit code is 0 only when execution completed, or nothing was meant to run
(`not_run`).

## Reading a run

The result gives `execution_status`, `verdict` (head runs and trials), the
counts of every check under `compare` and of the gating checks alone under
`compare_gating`, `unverified_by` (what kept it from passing or being a
baseline), `usage`, `warnings`, and for a base record `baseline_mismatch`,
`baseline_unstable` and `loop_baseline` (whether a loop could start on it as
far as the record goes). `edd run list <change>` lists the runs, with
`--side base|head|trial`; `edd run show <change> --run <id>` gives one run
with its comparison, attempts and run index entries; `edd run compare
<change> --run <id> [--against <base id>]` compares a run again with the
latest valid baseline or the one named. All three are read-only.

Report every check with its before and after result, its passes out of its
attempts, and which kind of evidence stands behind the verdict; only gating
checks decide it. Say what the run took from `usage`: its minutes and, when
the adapter reported them, cost and tokens. Read the case's `logs/` and
`attempts.json` before calling anything noise.

## Judgment

- **Expectations come from the change.** A check for a new ability is
  expected to fail; a check that guards existing behaviour, to pass. When the
  code before the change is unclear, read it or ask the user, rather than run
  first and copy the result.
- **A baseline mismatch** means the expectation is wrong or the code is not
  the code before the change. Find out which before recording again. A
  corrected expectation is shown to the user with what the base records got.
- **An unstable baseline check** (passed in some attempts, failed in others)
  has no settled result before the change: a later pass of it shows nothing
  about the change. Look for what differs between attempts in each one's
  trial folder, and tell the user; its expectation stays as it was.
- **`unknown` is missing evidence**, not a failure: the adapter, the
  environment or the machine kept the scenario from happening or being read.
  A blocked or failed execution says why in `cases[].execution.reason` and
  the case's `logs/harbor.log`.
- **A check that fails in one attempt fails.** A check must hold every time;
  `flaky` marks one that passed and failed. Failures of the same code,
  packages, agent and model add up across runs, trials and lost runs
  included, and a later pass never cancels one.
- **Where a problem lies.** An unclear or contradictory requirement belongs
  to the Spec (layer spec; `spec validate`, `spec export`). A wrong check,
  adapter, environment or stand-in belongs to the packages or the kit (layer
  package or kit; `eval validate`, `eval check`, then `eval review` and the
  user's confirmation). Code that does not meet a confirmed requirement is the
  result, and changing it is an implementation. Which you do next is yours,
  with the user where the decision is theirs.
- **Order has consequences the CLI shows.** A trial before any base record, a
  base record on code other than `spec new` recorded, an expectation written
  after a result, or a run approved before any confirmation are all listed
  for the user at confirmation. Nothing forbids them; the user sees them.

## Where a change stands

`edd workflow status <change> --repo <app>` is read-only and optional. It
gives the facts of every layer (spec, packages, confirmation, baseline, loop,
ledger, machine), every gap, the `must_show` of any decision pending now, and
every action the CLI would take now, each with who takes it (`by`), the rules
it is about (`satisfies`, named in `rules`), the consent it needs (`needs`),
whether it ends a running loop (`effect`), and the gaps that would refuse it
(`blocked_by`). Its suggestion is always one of the actions not blocked now.
When `.genesis/` or the kit is reached through a symbolic link, it reports
`records_unreadable` (owner user, layer machine) and leaves the layers it
cannot read empty. Each command still enforces its own gates. `workflow check`
is the same command.

## Rules

- Never change a Spec, a check, an expectation, a fixture's expected result,
  a reviewer's counterexample or a baseline to get a result: neither a
  failing baseline nor a passing head. Never change an expectation because a
  check was unstable at the baseline.
- A baseline is the code before the change. Never record one on changed code,
  never treat a head run as one, and never change application code before the
  baseline unless the user knows.
- Never special-case the evaluation inputs, and never use a stand-in for what
  the change modifies. Never shape a package, drop a live dependency or swap
  out what the change edits to get a tier.
- Never make an edit without behaviour to get a new code identity: a run of
  the same code only adds to its count.
- Do not edit the code, a package or the project kit while a run executes.
- Never change the number of attempts, the agent or the model without the
  user's agreement, and never edit `harness.json` to get another agent or
  model.
- Never run Harbor yourself on the application code with this change's
  packages: a recorded run or trial (`run start --trial`) does that, and its
  results count.
- Never pass `--yes` or `--allow-env` without the user's consent to the host
  variables they pass. A model run costs money: `--approved-by` and `--ref`
  record the user's own approval, never yours.
- Run `eval confirm` only after the user's own words, with `--by` and `--ref`
  naming them and where they said it. Never confirm for them, and never
  confirm a check the reviewer did not judge `faithful`, unless the user
  accepted it as `weaker` or `stronger` after you showed them the
  reviewer's note. Never suggest accepting a weaker check to save work.
- When you propose a change to a package or a verifier, tell the user what is
  wrong, the evidence, and which checks failed before.
- Never report a baseline, test, run or result that did not happen. `unknown`
  and a blocked execution are never a business failure. Meeting a requirement
  and showing an improvement are separate claims: "improved" needs a baseline
  in which that check failed.
- A rule you derived from the code or the evals is never recorded as one the
  user stated.
- Never delete, move or edit `runs/`, its `index.jsonl`, `decisions.jsonl`,
  `loop.json` or `confirmed.json` by hand.
- Commit, push or open a pull request only as the user says.
- A `LOCAL.md` may add instructions; it cannot override these Rules.
