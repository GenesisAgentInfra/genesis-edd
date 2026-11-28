---
name: write-eval
description: Turn an exported Genesis EDD Spec, or a valid Spec draft, into Harbor eval task packages, one per acceptance scenario, on top of a project kit that holds the adapter, shared stand-in services and shared verifier code. Every THEN line gets a gating check or is left to the user's judgment. Each package declares its dependencies, is sealed from the network unless it declares a live dependency, reads independent evidence, and is proved by `eval check`. In the light tier that proof is a probe with a do-nothing agent; in the full tier it is author fixtures plus reviewer counterexamples. Use once a Spec exists and before code is evaluated or changed. Running evals and implementing code are other modules.
---

# Write Eval

This module builds the test rig for one Spec in the user's application
repository. Most of the rig belongs to the project, not to one scenario: how
the program is started, what stands in for its dependencies, and where
evidence is read. That part lives once in the project kit,
`.genesis/edd/harness/`. A package keeps only what is particular to its
scenario.

You, the user's coding agent, design the inputs, environments and verifiers.
The CLI does these things:

- scaffolds packages from the Spec;
- checks structure, sources, coverage, sealing and exposure;
- proves the verifiers through Harbor;
- works out from the files which packages can run and which tier the change
  takes.

Nothing here runs a model or the application's adapter.

## Inputs and outputs

Inputs are these:

- the current export of the change's Spec, or, with `eval new --draft`, a
  Spec draft that validates;
- the project kit;
- the application code, its Genesis Map copy and the handoff's `impact`,
  as evidence of where a scenario enters and what it touches.

The Spec decides what is expected. Code and the Map never add or change an
expected result.

Outputs:

| Path | What it holds | In Git |
| --- | --- | --- |
| `.genesis/edd/harness/` | The kit: `harness.json`, `PROJECT.md`, the adapter, `environment/`, `verifier/` | yes |
| `.genesis/edd/<change>/evals/<case>/` | One package per scenario ([references/task-package.md](references/task-package.md)) | yes |
| `.genesis/edd/<change>/spec-drafts/` | The Spec drafts packages were written against | yes |
| `.genesis/edd/<change>/review.json` | The reviewer's answers ([references/review.md](references/review.md)) | yes |
| `.genesis/edd/<change>/checks/<case>/` | What `eval check` proved, with Harbor's logs | no, this machine only |

Readiness, coverage and the tier are worked out by the CLI from these files.
An author never declares them.

## Running the CLI

Start the CLI through this skill's own launcher:
`node <absolute path of this skill>/scripts/run.mjs`. Below, `edd` stands for
that command. `edd --version` shows the version. The launcher finds the CLI
in one of two ways:

- through `scripts/runtime.json`, which `init` writes on every run;
- in a plugin install, from the package that holds the skill.

It never looks the CLI up on PATH or in the project. It refuses a CLI inside
the project it would judge (`runtime_inside_project`, owner user). In a
plugin install, the first run may install the pinned npm dependencies inside
the Genesis EDD package. That needs network access, and outside a sandbox it
may need the user's approval.

Every command prints JSON and takes `--repo <app>`. A refusal prints
`{ error, code, gaps[, must_show] }` and exits 1. Each gap has these fields:
`code`, `owner` (`agent` or `user`), `layer` (`spec`, `package`, `kit`,
`confirmation`, `machine`, …), `message`, and the `case`, `path` or `digest`
involved. A gap the user owns is cleared by the user's decision. Editing a
package does not clear it.

A `LOCAL.md` beside this file, when present, holds the project's own
additions to this skill. Read it too. `init` never writes or changes it.

References: [task-package.md](references/task-package.md) gives the layout
and `checks.json`. [harbor.md](references/harbor.md) covers the adapter,
Compose, sealing and steps. [environment.md](references/environment.md) is
about choosing how each dependency is provided, and
[verifier.md](references/verifier.md) about `tests/test.sh` and fixtures.
[review.md](references/review.md) covers counterexamples, verdicts and what
the confirmation checks. [examples/reportbot](examples/reportbot/README.md)
is a complete kit with two packages that ran.
[assets/record.py](assets/record.py) is a recorder for lines about the
program's reply.

## What must exist and hold

For every scenario of the export:

- There is a package whose `tests/checks.json` names the scenario's
  requirement and name, bound (`spec_ref`) to the current export.
- Every THEN or AND line has a gating check whose `then` is that line, across
  the packages of the scenario, or is listed in `scenario.manual` with the
  reason. Never both.
- Every accepted requirement has a gating check in some package, unless all
  its lines are left to the user.
- A gating check cites its scenario's requirement as `intent`. Its `expect`
  says what this scenario must show, never stricter or broader than its line.
- `status` is `confirmed` when every expectation only restates the Spec.
  `draft` holds an expectation the Spec does not state, which is the user's
  to settle in the Spec.
- `dependencies` lists every external dependency with its mode, `live`,
  `frozen` or `simulated`, and the `stand_in` that replaces a frozen or
  simulated one. A missing `stand_in` causes a warning.
- The package is sealed, or declares the `live` dependency that needs the
  network.
- `instruction.md`, or each step's instruction, is the exact input the
  program receives.
- The environment builds `main`, through `environment/Dockerfile` or a
  `build` in the compose file, and exposes no expected result to the program.
- `tests/test.sh` is written and reads independent evidence.
- `tests/genesis.sh` and `tests/shared/` equal the shipped helper and the
  kit's `verifier/`.
- The kit's `harness.json`, or the package's own, names the adapter.
- The last `eval check` proved the package as it is now:
  - **both tiers:** the probe left every gating check `unknown`, other than
    code tests, and every fixture written got its expected results;
  - **full tier, also:** every line a program checks has a reviewer's
    counterexample, and each gating check that asserts absence
    (`"absence": true`) or belongs to a package with a live dependency has
    a fixture that leaves it `unknown` with the scenario run and its
    evidence missing;
  - **checks.json 1.0:** every gating check, other than a code test, has a
    fixture for each of `pass`, `fail` and `unknown`, and every line has a
    reviewer's counterexample.
- The project's `.dockerignore` has a `.genesis` line, and no `.gitignore`
  rule hides a file that must be committed. `eval new` and `eval validate`
  warn about that.

Notes, not conditions: a `Task.md` for every package that declares a
dependency (`eval validate` names its headings when one is missing), and a
`PROJECT.md` in the kit.

## Tiers

The CLI works out one tier for the whole change, and `eval validate` gives it
as `tier: { eligible, reasons, readiness }`. A change is eligible for the
light tier only when all of these hold:

- it has packages, none declares a live dependency, and no model is named;
- every package is sealed;
- no adapter module the kit can scan imports a model SDK or a general HTTP
  client, and no package names an adapter module outside the kit;
- this machine's runs show no package, as it is now, that passed and failed
  on the same code, reported model use, or lost its records. In looking for
  a check that passed and failed on the same code, a judge check the user
  made gating counts like any gating check.

`reasons` names each condition the change misses. `readiness` is the tier
whose rules decide which packages are ready. The user may confirm the full
tier for an eligible change. The light tier is refused for one that is not
(`tier_light_unfit`). Hints that a result may depend on a model are reported
as `variability_signals` and decide nothing: SDKs in dependency manifests,
`*_API_KEY` names, model API hosts.

In the light tier, the proof that a line's checks can fail is asked for when
the user confirms (`line_unproven`). It is either the line's real failure at
the baseline, or a reviewer's counterexample. In the full tier the
counterexamples, and the triggered `unknown` fixtures above, are asked for
before a package is ready. Author fixtures are optional in both tiers; the
accepted run proves that a check can pass. A line whose
judge check the user makes gating needs such a proof in either tier.
[review.md](references/review.md) gives the exact conditions.

## Judgment

**Expectations.** Start each check from one sentence: pass if and only if an
observable outcome holds. A check needs the scenario to be triggered and the
relevant activity fully observed. No input, no execution and no log are not a
pass. A check does not say whether it should pass before the change; that is
declared for a baseline in `baseline-expectations.json`.

**Checks that assert absence.** Mark a gating check `"absence": true` when
it passes because something is not found, such as "no success notice was
sent". Such a check passes on missing evidence unless its verifier tells
"none sent" from "nothing could be read". The probe never runs the
scenario, so in the full tier the package needs a fixture that runs the
scenario, leaves the evidence missing or from another run, and expects
`unknown`. The reviewer checks that every such check carries the mark.

**Lines a program cannot judge.** A line about tone or answer quality goes in
`scenario.manual` with the reason, and the user judges it at acceptance. A
judge check (`kind: judge`) may run the project's own judging program for
such a line. Its result stays diagnostic, and needs no proof, unless the user
makes the line gating when they confirm
(`eval confirm --judge-gating CASE:THEN`). A line made gating that way is
confirmed only with a `faithful` verdict and a proof, in either tier, that
its judge check can fail: its failure at a baseline, or a reviewer's
counterexample whose `then` names the line, which expects `fail` for the
judge checks and `pass` or `unknown` for every other gating check, proved by
the last `eval check`. `loop accept` holds that line the same way.

**Lines that can only fail together.** Prefer one line per result in the
Spec. When two to four lines of a scenario truly can only fail together, one
gating check may name them in `then_group`. The user then decides whether
they belong together (`then_group` in `must_decide`). Each line still needs
its own verdict and a counterexample that breaks it alone. A failure of a
check that several lines share, at a baseline, never proves any of them.

**Code tests.** A check of `kind: code_test` runs a test program frozen in
the package, under `tests/code/`, against the application code in the
container, with no adapter. The probe does not hold it to `unknown`. Its
counterexample is a code patch; a script fixture never counts for it. In the
light tier its failure at a baseline proves its line too. The user is told
that it tests code directly.

**Dependencies.** Keep the program's own code and interfaces as production
has them. Replace the service or data behind an interface. A stand-in may
replace a model when the scenario tests the code around it. When the result
depends on the model's reply, a prompt or the model configuration, the model
is `live`. [environment.md](references/environment.md) covers how to choose.

**Evidence.** Read final state from the service or the store the program
wrote to. Never read the program's own account of what it did as evidence
of any effect other than the reply itself. A line about the reply, such as
what a command prints, its exit status or an agent's answer, reads it from a
recorder the program cannot reach
([verifier.md](references/verifier.md#when-the-reply-is-the-outcome)). Map
each check to `pass`, `fail` or `unknown` as
[verifier.md](references/verifier.md) describes. The common faults are
these:

- a count that reads 0 when the log is missing;
- a verifier that runs the program itself, which the probe catches;
- evidence the agent could write;
- a check that also matches another run's leftovers.

**A failed `eval check`.** Read `checks/<case>/<fixture>/logs` and
`checks/<case>/_probe/logs`. Each kind of failure points at a fault of its
own:

- A fixture that got another result than it expects shows a fault in the
  verifier, the environment or the fixture script.
- A reviewer's counterexample that does not fail shows a verifier that misses
  what the line rules out.
- A probe that judged a result shows a verifier that decides without
  evidence of the run.
- An execution error usually points at the environment.

**Kit or package.** Put a file in the kit when a second package would
otherwise repeat it. Keep one package's exact input, expected results and
scenario settings in the package. Record in `PROJECT.md` how the program
starts, each dependency and its stand-in, where evidence is read, and the
traps you met.

## The commands

- `edd eval new <change> [--draft]` writes one package for each scenario that
  no package names. A new package gets these:
  - one gating check per THEN or AND line, whose `then` is the line and whose
    `expect` starts as its text;
  - a sealed `environment/docker-compose.yaml` (`main` with
    `network_mode: none`, and no image yet);
  - an `instruction.md` template;
  - a `tests/test.sh` template;
  - the shipped helper and a copy of the kit's `verifier/`.

  It starts the kit's `PROJECT.md` when there is none. It never rewrites an
  existing package and never renames a folder: a scenario inserted before
  another one takes the next free number. While a folder's `checks.json`
  cannot be read or names no scenario, no package is written for the
  scenarios of the requirement its name starts with (`skipped`). With
  `--draft`, the packages are bound to the Spec draft by the digest its
  export would have, and the draft is kept under `spec-drafts/`. You can
  validate and prove them; nothing confirms, baselines or runs them.
- `edd eval validate <change>` is read-only. It exits 1 when the packages, or
  the Spec they are read against, are invalid. It returns `cases[]`, each
  with its status, its integration (`missing` and `detail`), `sealed`,
  `live`, its adapter, dependencies, steps, code tests, judges (each with its
  `case`), `code_patches` (the fixtures that are code patches) and digests.
  A package with steps also gives `check_at`, the step each check is read
  at. It also returns `coverage`, `then_lines`, `tier`, `gaps` and
  `warnings`.
- `edd eval rebind <change>` binds packages written for an earlier export, or
  a draft, to the current export when their requirement text and every line
  of their scenario read the same, and every line they name still exists. It
  records `rebound` in `checks.json` and keeps the proofs and verdicts: a
  reviewer's verdict carries over only while the check and its line read the
  same, and a binding edited by hand carries none. It
  lists the others as `stale`, with why, and exits 1 while there are any. A
  re-binding is shown to the user at confirmation (`package_rebound`).
- `edd eval sync <change> [--case <id>]...` writes the shipped helper and the
  kit's `verifier/` into packages where they differ, and removes copies under
  a step's `tests/`. It changes those packages.
- `edd eval check <change> [--case <id>]... [--timeout <minutes>]` proves
  packages one at a time through Harbor in local Docker:
  - it runs each fixture in the agent's place, then the real verifier;
  - in the light tier, it also runs the probe with Harbor's nop agent;
  - a fixture `eval validate` lists in `code_patches` is applied to a copy
    of the code outside the project, and only such a fixture is.

  A package missing only `check`, or `review`, is checked. A fixture or probe
  whose record still holds is kept, and `already_proved` lists packages that
  need nothing. `--case` names a package and may be given more than once:
  each package named is checked, a ready one included, and all its fixtures
  run again; its probe is kept while it holds. A package that cannot be
  checked is listed under `skipped` with why, and the others go on. A
  package that changes while it is checked keeps no proof
  (`package_changed_during_check`). A package whose shared code differs is
  refused, with one `shared_code_mismatch` gap for that package. The result
  says what did not hold: `failed.probe_judged`, `probe_errored`,
  `fixture_failed` and `package_changed_during_check`. It needs Docker and
  Harbor (`docker_unavailable`, `harbor_missing`, layer machine). It exits 1 unless every checked package passed. Host variables
  that a `task.toml` declares are passed only with `--yes`, which passes all
  of them, or `--allow-env NAME[,NAME]`, which passes the named ones.
- `edd eval review <change>` is read-only. It gives the reviewer's brief and
  answer template, `must_decide` and `must_show`: the data the user must see
  before confirming. See [review.md](references/review.md).

`eval check` takes a minute or more per package. Give it the longest timeout
your shell tool allows, or run it in the background and wait. Run again
after a stop: proved packages are kept. A stopped check can leave Harbor's
containers running. Their compose project names start with the package id,
cut to 32 characters. `docker compose ls --all` lists them, and
`docker compose -p <project> down` removes one.

To see how a package behaves with the real adapter before it is proved, use
a trial run (`run start --trial`). It is recorded, it counts its failures,
and it is never a baseline, a proof or an accepted run. Trials made before
the first baseline are shown to the user at confirmation. A trial that calls
a model before any confirmation needs the user's cost approval
(`--approved-by`, `--ref`).

In the light tier, none of the steps before the baseline runs the adapter or
starts the program through it. The probe uses Harbor's nop agent, and a
fixture runs a script in the adapter's place. So a broken adapter first
shows at the baseline. A baseline that ends in an execution error is not a
baseline (`is_baseline: false`): fix what failed, usually the adapter, and
run the baseline again. An edit to the adapter keeps the proofs. To check a
new adapter before the baseline, use `run start --trial`. The user then sees
that trial at confirmation (`trial_before_baseline`).

## Gaps

| Gap | Owner, layer | Meaning | Refused by |
| --- | --- | --- | --- |
| `cases_missing`, `scenario_uncovered` | agent, package | A scenario has no package | `eval confirm` |
| `case_invalid` | agent, package | A package file is wrong; the message says what and, for a `then`, lists the lines to copy. Also a package naming a scenario the Spec no longer has, or a requirement the Spec leaves out. | `eval confirm`; `eval check` and runs skip it |
| `expected_results_exposed` | agent, package | The environment can hand the program expected results or the verifier: a build context, mount, config, secret or COPY that reaches `.genesis/edd`, the project root or a `checks.json` | as `case_invalid` |
| `then_uncovered` | agent, package | No gating check of the scenario's packages verifies the line, and none lists it in `scenario.manual`. A diagnostic check covers no line. | `eval confirm` |
| `then_conflict` | agent, package | One package checks a line that another leaves to the user | `eval confirm` |
| `requirement_uncovered` | agent, package | An accepted requirement has no gating check anywhere | `eval confirm` |
| `case_stale` | agent, package | The package is bound to another export or draft than the one read now | `eval confirm`; `eval check` and runs skip it |
| `draft_bound` | agent, package | The package is bound to the current Spec draft | `eval confirm`, runs |
| `case_draft` | user, spec | `status: draft`: an expectation the Spec does not state | `eval confirm` |
| `integration_pending` | agent, package (kit when only the adapter is missing) | Not runnable yet. `missing` lists `instruction`, `environment`, `verifier`, `kit`, `fixtures` and `review` (full tier), or `check`. | runs skip the package |
| `shared_code_mismatch` | agent, package | `tests/genesis.sh` or `tests/shared/` differs from the shipped helper or the kit's `verifier/`. One gap per package, naming the files that differ. | `eval check`, `eval confirm`, `run start` |
| `network_undeclared` | agent, package | Not sealed, and no live dependency declared | `eval confirm` |
| `line_unproven` | agent, package | Light tier: a gating line with neither a real failure before the change nor a proved counterexample. Either tier: a line whose judge check the user made gating, with no such proof. | `eval confirm`, `loop accept` |
| `then_unbound` | agent, package | A package still in `checks.json` 1.0 | `eval confirm`, `loop start` |
| `gating_missing` | user | Every line of the change is left to the user, so no run can pass | `loop start` |
| `handoff_missing`, `handoff_invalid` and other Spec gaps | spec | No current export to read. `eval new --draft` still works on a valid draft. | `eval new` without `--draft`, `eval check` except of draft-bound packages, `eval review`, `eval confirm`, `eval rebind` |

What the codes never permit:

- A `then` is copied from the Spec. Deleting a check, or making it
  diagnostic, uncovers its line again.
- A requirement is never dropped to clear `requirement_uncovered`.
- `case_stale` is never cleared by carrying an old expectation over unread.
  For a package whose scenario changed, update its checks against the current
  scenario before binding it. Set `spec_ref.sha256` to the current export and
  remove `spec_ref.scenario_sha256`. Or delete the package and let `eval new`
  write it again.
- `case_draft` is never cleared by setting `status` to `confirmed`. That is
  the user's decision, settled in the Spec.

## While a loop runs

A loop holds its packages and kit fixed. Changing either ends the loop
(`packages_changed`): a check, the input, the verifier, the environment, the
adapter, a stand-in, an `eval sync`, an `eval rebind`. Adding or editing a
fixture does not. `workflow status` shows this as
`packages.editing_ends_loop`, and as `effect: ends_loop` on the actions. A
new loop needs the user's go-ahead, a checks confirmation of the changed
packages, and a baseline that ran them. Once the user has accepted a loop, a
package change no longer ends it; tell the user what changed and why.

Finish packages before the baseline. A package changed after a baseline makes
that baseline compare nothing with it.

## New project

In a project with no implementation, packages connect to an entry skeleton:
an entry point that starts and does nothing of the business, and a
`.dockerignore` with its `.genesis` line. The baseline runs on that skeleton,
so every expected baseline result is `fail`. `pass` and `any` are refused,
`unknown` is no mismatch, and a skeleton that already passes a check gives
`baseline_mismatch`. Nothing failed there for a real reason, so every line
needs a reviewer's counterexample. That can be proved only once its package
is connected.

In any project, application code written after `spec new` makes the baseline
run on other code than `spec new` recorded, and `eval review` lists that for
the user (`code_changed_before_baseline`). Here that is the skeleton. In an
existing project it is often the `.dockerignore` line alone, since the file
decides what enters the image. Add that line before `spec new` when the
packages build from the project root. Added later, tell the user before the
baseline.

## Where a change stands

`edd workflow status <change> --repo <app>` is read-only, optional and always
exits 0. Its `packages` layer gives these facts:

- what the packages are read against (`read_against`: the export or a draft);
- validity and readiness, and each case's integration, sealing and adapter;
- coverage and the tier;
- unpackaged scenarios and unnamed folders;
- packages that are stale, draft-bound, out of line with the kit, or waiting
  for `eval check`;
- whether editing ends a running loop.

Its `actions` list every allowed command with `blocked_by`, `needs` and
`effect`. At most one `suggestion` comes with them. The order is yours.

## What the user must hear

Before the user confirms the checks, `eval review`'s `must_show` must be in
front of them. It holds:

- every line with its checks, verdict and proof;
- `must_decide`;
- the run plan with the tier and its reasons;
- dependencies and their stand-ins;
- packages with their own adapter;
- re-bound packages, code checks, judge checks and line groups;
- the choices recorded under "Choices made here" in a `Task.md`;
- the state of the run ledger.

The wording and the number of messages are yours. While you write packages,
say these as they come up:

- a line you leave to the user, and why;
- an expectation the Spec does not state;
- a scenario whose result depends on a live dependency;
- that a stand-in model tests the code around the model, not its answers;
- whether a counterexample or a verdict comes from a self-review.

Keep three things apart: a `confirmed` package status, the user's
confirmation of the checks, and a runnable package. They are not the same.

## Limits of this release

- Checks are decided by programs in the package: the verifier, code tests,
  and judges once the user makes a judge's line gating. A change whose every
  line is manual cannot pass a run.
- Packages use Harbor's shared verifier mode.
- Sealing is read from the package's files. The adapter runs on the host,
  outside the sealed network. The light tier rules out adapters that import a
  model SDK or an HTTP client and ends a loop when an attempt of one of its
  head runs or trials reports model use. It cannot see an adapter that sends
  requests another way.
- The CLI cannot tell that a `checks.json` changed from `draft` to
  `confirmed` within one export, or that an expectation is faithful to its
  line. The review and the user's confirmation cover those.

## Rules

These hold whatever path you take.

- Use the launcher of an installed skill, by its absolute path. Never use a
  CLI found in the project or on PATH.
- Do not change the Spec, checks, expectations, fixture expected results,
  counterexamples or the baseline to get a result. When a fixture's result
  differs from its `expect`, fix the verifier, the environment or the fixture
  script. When a reviewer's counterexample does not fail, fix the verifier.
- Do not settle a business decision in a package. An expectation the Spec
  does not state stays `draft` and goes back to the Spec. Never relabel a
  package or a status to pass a check, and never clear a user-owned gap by
  editing files.
- Never delete a check, make it diagnostic or drop a requirement to clear a
  coverage gap. Never carry an old expectation over to a new export unread.
- Never make an `expect` stricter or broader than its line. List a line in
  `scenario.manual` only when no program can judge it, never in place of a
  check that is hard to write, and never approximate such a line with a
  keyword check.
- Do not shape packages to get a tier, and never choose a tier yourself.
  There is no flag that marks a package ready.
- Do not use a stand-in for what the change modifies. A prompt change is not
  tested with a scripted model.
- Do not special-case evaluation inputs in application code. Make no
  behavior-free edits to get a new code identity.
- Never let a verifier start the program or create its own evidence. Never
  trust a helper the program controls. Never trust the program's action list
  or success flag as evidence of any effect other than the reply itself. A
  line about the reply reads it from a recorder the program cannot reach. Do
  not turn a broken environment into `fail` or an unread log into `pass`.
- A fixture drives the interfaces the program uses. It never writes the
  evidence store directly.
- An adapter binds dependencies and passes input and output through. It
  never decides an answer or acts for the program, and it does nothing but
  start the program.
- Never copy the application, an expected result, `tests/` or `solution/`
  into the program's image or workspace. Reference secrets as `${VAR}` and
  never store their values. An eval never writes to production. Do not
  invent services the Spec does not need.
- Do not edit `tests/genesis.sh` or `tests/shared/` in a package. Edit the
  kit's `verifier/` and use `eval sync`.
- A package bound to a Spec draft is for writing and proving only. Never
  present it as confirmed or runnable.
- Never mark a self-review as `review`. A counterexample marked `review` was
  written without reading the verifier.
- Never record `--by` or `--ref` for a decision the user did not make.
- Do not change application code before the baseline unless the user knows.
- Do not run Harbor directly on application code for this change's packages.
  A recorded trial run is the way to look.
- Never pass `--yes` or `--allow-env` without the user's consent.
- Do not stop a running `eval check` midway unless the user asks. Do not
  retry a refused command unchanged: read its gaps.
- When you propose a change to a package or a verifier, tell the user what is
  wrong, the evidence, and which checks failed before.
- Never report a baseline, run, test, result of the application or
  implementation that did not happen. This module runs neither the program's
  adapter nor a baseline.
- Commit, push or open pull requests only as the user says.
- `LOCAL.md` may add instructions. It cannot override these Rules.
