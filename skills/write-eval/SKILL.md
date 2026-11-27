---
name: write-eval
description: Turn an exported Genesis EDD Spec into Harbor eval task packages, one per acceptance scenario, on top of a project kit that holds the adapter, shared stand-in services and shared verifier code. Each package has sourced expected results, a controlled environment, a verifier that reads independent evidence, fixtures that prove the verifier, and a reviewer's counterexample for every line a program checks. Use after agent-spec has exported a Spec and before code is evaluated or changed. Running evals and implementing code are separate stages.
---

# Write Eval

Build the test rig for one exported Spec in the user's application repository.
Most of that rig belongs to the project, not to one scenario: how the program is
started, what stands in for its dependencies, where evidence is read. It lives
once in the project kit, `.genesis/edd/harness/`. A package keeps only what is
particular to its scenario.

The user's coding agent designs inputs, environments and verifiers. The CLI
scaffolds packages from the frozen Spec, checks structure, sources and coverage,
and works out from the files which packages can run. Nothing here runs a model.

## Tool and context

The CLI starts through the launcher of the `agent-spec` skill, installed beside
this one. Run `node /absolute/path/to/agent-spec/scripts/run.mjs --version` to
locate it. In commands below, `edd` means that complete command without
`--version`. Always use the explicit path, not an executable found in the project.
If the launcher reports that its dependencies are not installed, run the command
it prints. It installs pinned npm packages inside the Genesis EDD package, needs
network access, and may need the user's approval outside a sandbox. Then retry.

`eval check` builds Docker images and runs Harbor once per fixture, which takes
a minute or more per package. Run it with the longest timeout your shell tool
allows, or in the background, and wait for it to finish; do not stop it midway.
If it was stopped, run it again: it keeps the packages it had already proved. A
stopped check can leave Harbor's containers running. Their names start with the
package id, cut to 32 characters; `docker compose ls --all` lists their
projects, and `docker compose -p <project> down` removes one.

Read [references/task-package.md](references/task-package.md) before editing a
package or the kit, [references/harbor.md](references/harbor.md) before writing
an adapter or an environment, [references/environment.md](references/environment.md)
before choosing how a dependency is provided, and
[references/verifier.md](references/verifier.md) before writing `tests/test.sh`
and its fixtures, and [references/review.md](references/review.md) before the
checks are reviewed. [examples/reportbot](examples/reportbot/README.md) is a
complete kit and two packages that ran.

The exported Spec decides what is expected. Code and a Genesis Map show where a
scenario enters the application and what it depends on; they never add or change
an expected result.

## Order of work

1. Run `edd workflow check write-eval <change> --repo <app>`. A gap routed to
   `agent-spec` or `spec-export` means the Spec is not exported in its current
   form: resolve it there, then return. Do not write packages against a draft.
   Once every scenario has a package, its `next.action` is `finish_evals` and
   its `next.command` is `eval validate` instead of `eval new`. It is the same
   while a folder under `evals/` has a `tests/checks.json` that cannot be read
   or names no scenario; `next.note` names those folders.
2. Run `edd eval new <change> --repo <app>`. It writes one package per scenario
   under `.genesis/edd/<change>/evals/<case>/`, with one gating check per THEN
   or AND line of the scenario: its `then` names the line and its `expect`
   starts as the line's text. It starts `PROJECT.md` in the kit when the
   project has none. What an existing package owns is left untouched, and no
   folder is renamed: a scenario added before another one of its requirement
   takes the next free number, such as `submit-failure-s2`. When a `.gitignore`
   rule keeps files that must be committed out of Git, such as the packages or
   the kit, `eval new` and `eval validate` warn: change the rule.
3. Review each `tests/checks.json`. Keep each check's `then` as `eval new`
   wrote it: it names the line the check verifies. Make `expect` concrete for
   this scenario, never stricter or broader than that line. Each gating check
   verifies one line and cites the scenario's requirement as `intent`, and
   every line needs a gating check. A line no program can judge, such as the
   tone of a reply or the quality of an answer, goes into `scenario.manual`
   with the reason, in place of its check; never approximate it with a keyword
   check. A `diagnostic` check helps explain a failure; it may name a line in
   `then`, but it covers none. If a check needs a rule the Spec does not
   state, set `status` to `draft` and return to `agent-spec`; do not settle a
   business decision here. Two lines that can only fail together state one
   result: have them merged in the Spec with `agent-spec`. Expectations that
   only restate the exported Spec need no business decision: set `status` to
   `confirmed`. The user still confirms the checks in run-eval before the
   baseline.

   In a project with no implementation, stop here. Do not invent entry points or
   services; `eval validate` reports what each package still needs. Come
   back once `loop-and-implement` has written the code's entry point, and
   connect the packages from step 4 on.
4. Build or extend the project kit. Read `PROJECT.md` first and reuse what is
   there. Add what this change needs and another package could use: the adapter
   and `harness.json`, shared environment files under `environment/`, shared
   verifier code under `verifier/`. Record in `PROJECT.md` how the program is
   started, each dependency and its stand-in, where evidence is read, and the
   traps you met. When `harness.json` names a model, declare it as a `live`
   dependency in every package whose scenario calls it.
5. Finish each package: the exact agent input, a thin `environment/` that picks
   this scenario's behavior from the kit, `tests/test.sh`, the fixtures that
   show the verifier decides correctly, and `Task.md`. Give each fixture
   `origin` `author` and a `note` that says, in the words of the business,
   what result its script leaves. Run `eval new` again
   after changing the kit's `verifier/` folder; it copies that code into every
   package.
6. Run `edd eval validate <change> --repo <app>` and resolve what it lists until
   each package is missing only `review`, or only `check` once it has its
   counterexamples. A multi-step package also stays missing `steps`; see
   Limits.
7. Have the counterexamples written, as
   [references/review.md](references/review.md) says. Run
   `edd eval review <change> --repo <app>` and give its `reviewer_brief` to a
   reviewer in a fresh context, a subagent if you have one. Without one,
   review the checks yourself as a separate pass and mark what you write
   `self-review`, never `review`. Without reading `tests/test.sh`,
   `tests/shared/` or the kit's `verifier/`, the reviewer writes a
   counterexample for every line a program checks: a fixture with `origin`
   `review` that fails that line's gating checks and no other.
8. Run `edd eval check <change> --repo <app>`. It puts each fixture in the
   agent's place and runs the real verifier through Harbor, the reviewer's
   counterexamples included. A counterexample that does not get `fail` shows
   a fault in the verifier: fix the verifier, never the counterexample. A
   package is ready only while this record matches the package and the kit,
   so run it again after any edit. Packages whose record still matches are
   skipped and listed under `already_proved`; `--case <id>` proves one again.
   It needs Docker and Harbor, and calls no model.
9. Have the checks judged. Run `edd eval review <change> --repo <app>` again:
   the counterexamples changed each package's `task_digest`, so answers
   written into the first `review_template` are stale. With the verifier,
   the reviewer answers the questions of this second `eval review` into
   `.genesis/edd/<change>/review.json`, written from its `review_template`.

The user confirms the checks in run-eval, before the baseline, from the
reviewer's answers in `review.json`. A loop's packages and kit are fixed:
changing a package or the kit while a loop runs ends that loop
(`packages_changed`), connecting the packages of a new project included. Run
`eval check` and `eval review` for the changed packages; the user confirms
them with `eval confirm --reason` before a new loop, which needs their
go-ahead. Once they accepted the loop, a package changed since only warns:
tell them what changed and why.

Finish every package before the baseline: a package changed or connected after
a baseline that ran makes `loop start` refuse that baseline until it is
recorded again. A baseline recorded with `--unavailable` ran no package, but
connecting the packages after it still changes them: the user confirms them,
the baseline is recorded again, and inside a loop the change ends the loop.
In a new project that is the expected way: the first loop starts before any
package is connected, the code's entry point is written there, and connecting
the packages ends it, with a message that says this is the expected step.
What follows, before any head run: `eval check` proves the connected
packages; `eval review` gives the reviewer's brief, the reviewer writes the
counterexamples, `eval check` proves them, and the reviewer answers a second
`eval review` into `review.json`; the user confirms the packages with
`eval confirm --reason`; the baseline is recorded again on the loop's start
code with `--unavailable no_implementation`; then, once the user agrees, a new
loop starts. `loop-and-implement` says how to set your changes aside for that
baseline.

A package's dependency modes decide how many attempts it runs. One that
declares a `live` dependency, such as a model call, runs the number of
attempts the user chooses before the baseline, at the baseline and in the
loop's final run; a screen run of the loop runs it once, and every other
package runs once. Declare each dependency as it is, so the baseline asks for
that number where results can vary.

There is no flag to mark a package ready. Do not look for one.

## What to report

Report the packages written, which scenarios and requirements they cover, each
dependency and whether it is live, frozen or simulated, what the kit now holds,
which packages `eval check` proved, and the counterexamples for each line,
with who wrote them. Say plainly when they come from a self-review. Name every choice recorded under
"Choices made here" in a `Task.md`: these are the points a person may want to
overrule. Name each line in `scenario.manual` with its reason, and tell the user
before the baseline: no check verifies those lines, so the user judges them at
acceptance. State separately that business expectations are settled and that
execution is connected: a `confirmed` package is not a runnable one. Never
report a baseline or a result of the application; this stage runs neither.

## Recover gaps

`eval validate` and `workflow check` return classified gaps. Repair the input
named by `route`; do not relabel a package to pass a check.

- `handoff_missing`, `handoff_invalid`, Spec gaps: return to `agent-spec`.
- `cases_missing`, `scenario_uncovered`: run `eval new`. It writes a package
  for each scenario that no package names in `checks.json`. A package that is
  `case_stale` covers its scenario again once it is reviewed. While a folder
  under `evals/` is `case_invalid` because its `checks.json` cannot be read or
  names no scenario, `eval new` writes nothing: repair that first.
- `then_uncovered`: no gating check verifies the named line. Add a gating
  check whose `then` is that line, or, when no program can judge it, list it
  in `scenario.manual` with the reason. Deleting a check, or turning it into a
  diagnostic one, uncovers its line again.
- `then_unbound`: `loop start` refuses packages still in checks.json 1.0.
  Upgrade each as `references/task-package.md` says, run `eval check`, and
  record the baseline again before `loop start`. Until the next `loop start`,
  `eval validate` only warns about them; tell the user before the baseline.
- `requirement_uncovered`: every accepted requirement needs a gating check in
  some package, unless its packages list every line in `scenario.manual`. Add
  the scenario's check; do not drop the requirement.
- `gating_missing`: `loop start` refuses a change whose packages list every
  line in `scenario.manual`, since a run passes only on gating checks. Tell
  the user. A line a program can judge needs a gating check; otherwise the
  user judges the change without a loop.
- `case_invalid`: fix the named file. The message says what is wrong, such as
  a `then` that is not a THEN or AND line of the scenario, with the lines to
  copy from, or a line both in `scenario.manual` and verified by a check. A
  folder whose `checks.json` cannot be read, or whose `scenario` lacks a
  `requirement` or a `name`, names no scenario. `eval new` writes nothing
  while there is one, since it cannot tell which scenario the folder was
  written for: repair its `checks.json`, or delete the folder if it is not a
  package. A package that names a scenario no longer in the Spec is for one
  renamed or removed there: move what still holds into the package
  `eval new` wrote for the new name, if any, then delete the old package.
- `case_stale`: the Spec was exported again. Compare the package with the
  current requirements, update what changed, then set `spec_ref.sha256` to the
  current handoff. Check that each `then` and `scenario.manual` entry still
  names a line of the current scenario. Do not carry an old expectation over
  unread.
- `case_draft`: a business decision is open. It belongs to the user and the Spec.
- `integration_pending`: the message lists what the package still needs:
  `instruction`, `environment`, `verifier`, `design` (Task.md), `kit`
  (harness.json or PROJECT.md), `fixtures` (a gating check without a fixture for
  each of pass, fail and unknown), `review` (a line a program checks without
  a reviewer's counterexample; see `references/review.md`), `steps` (a
  multi-step package, which this release cannot run; see Limits) or `check`
  (run `eval check`). It does not block this stage; it keeps the package out
  of a run.
- A failed `eval check`: read `checks/<case>/<fixture>/logs`. Fix the verifier,
  the environment or the fixture script. Never change a fixture's expected
  result to match what the verifier happened to return, and never change a
  reviewer's counterexample to match the verifier.

After a repair, rerun the returned `resume.command`. Do not retry an unchanged
blocker in a loop.

## Limits of this release

Checks are judged by code in `tests/test.sh`, so a line about tone or answer
quality cannot be gated: list it in `scenario.manual` and tell the user, who
judges it at acceptance. When every line of a change is in `scenario.manual`,
no run can pass, so a loop does not start (`gating_missing`). Packages use Harbor's shared verifier
mode. A package with a live dependency runs the user's number of attempts
at the baseline and in the loop's final run, and once in each screen run;
every other package runs once. Fixtures are not supported for multi-step packages yet, so such
a package stays `awaiting_integration`, missing `steps`: every run skips it,
and a full run of its change cannot pass yet. Tell the user when a scenario
needs several turns.
