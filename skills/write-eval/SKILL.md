---
name: write-eval
description: Turn an exported Genesis EDD Spec into Harbor eval task packages, one per acceptance scenario, on top of a project kit that holds the adapter, shared stand-in services and shared verifier code. Each package has sourced expected results, a controlled environment, a verifier that reads independent evidence, and fixtures that prove the verifier. Use after agent-spec has exported a Spec and before code is evaluated or changed. Running evals and implementing code are separate stages.
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

Run `node /absolute/path/to/this/skill/scripts/run.mjs --version` to locate the
installed CLI. In commands below, `edd` means that complete command without
`--version`. Always use the explicit path, not an executable found in the project.

Read [references/task-package.md](references/task-package.md) before editing a
package or the kit, [references/harbor.md](references/harbor.md) before writing
an adapter or an environment, [references/environment.md](references/environment.md)
before choosing how a dependency is provided, and
[references/verifier.md](references/verifier.md) before writing `tests/test.sh`
and its fixtures. [examples/reportbot](examples/reportbot/README.md) is a
complete kit and two packages that ran.

The exported Spec decides what is expected. Code and a Genesis Map show where a
scenario enters the application and what it depends on; they never add or change
an expected result.

## Order of work

1. Run `edd workflow check write-eval <change> --repo <app>`. A gap routed to
   `agent-spec` or `spec-export` means the Spec is not exported in its current
   form: resolve it there, then return. Do not write packages against a draft.
2. Run `edd eval new <change> --repo <app>`. It writes one package per scenario
   under `.genesis/edd/<change>/evals/<case>/`, with each expected result copied
   from the scenario's THEN lines, and starts `PROJECT.md` in the kit when the
   project has none. What an existing package owns is left untouched.
3. Review each `tests/checks.json`. Keep `expect` faithful to its requirement:
   make it concrete for this scenario, never stricter or broader. Add a
   `diagnostic` check when it helps explain a failure. If a check needs a rule
   the Spec does not state, set `status` to `draft` and return to `agent-spec`;
   do not settle a business decision here. Expectations that only restate the
   exported Spec need no further approval.

   In a project with no implementation, stop here. Do not invent entry points or
   services; `eval validate` reports what each package still needs.
4. Build or extend the project kit. Read `PROJECT.md` first and reuse what is
   there. Add what this change needs and another package could use: the adapter
   and `harness.json`, shared environment files under `environment/`, shared
   verifier code under `verifier/`. Record in `PROJECT.md` how the program is
   started, each dependency and its stand-in, where evidence is read, and the
   traps you met.
5. Finish each package: the exact agent input, a thin `environment/` that picks
   this scenario's behavior from the kit, `tests/test.sh`, the fixtures that
   show the verifier decides correctly, and `Task.md`. Run `eval new` again
   after changing the kit's `verifier/` folder; it copies that code into every
   package.
6. Run `edd eval validate <change> --repo <app>` and resolve what it lists until
   each package is missing only `check`.
7. Run `edd eval check <change> --repo <app>`. It puts each fixture in the
   agent's place and runs the real verifier through Harbor. A package is ready
   only while this record matches the package and the kit, so run it again after
   any edit. It needs Docker and Harbor, and calls no model.

There is no flag to mark a package ready. Do not look for one.

## What to report

Report the packages written, which scenarios and requirements they cover, each
dependency and whether it is live, frozen or simulated, what the kit now holds,
and which packages `eval check` proved. Name every choice recorded under
"Choices made here" in a `Task.md`: these are the points a person may want to
overrule. State separately that business expectations are settled and that
execution is connected: a `confirmed` package is not a runnable one. Never
report a baseline or a result of the application; this stage runs neither.

## Recover gaps

`eval validate` and `workflow check` return classified gaps. Repair the input
named by `route`; do not relabel a package to pass a check.

- `handoff_missing`, `handoff_invalid`, Spec gaps: return to `agent-spec`.
- `cases_missing`, `scenario_uncovered`: run `eval new`, or add the package.
- `requirement_uncovered`: every accepted requirement needs a gating check in
  some package. Add the scenario's check; do not drop the requirement.
- `case_invalid`: fix the named file. The message says what is wrong.
- `case_stale`: the Spec was exported again. Compare the package with the
  current requirements, update what changed, then set `spec_ref.sha256` to the
  current handoff. Do not carry an old expectation over unread.
- `case_draft`: a business decision is open. It belongs to the user and the Spec.
- `integration_pending`: the message lists what the package still needs:
  `instruction`, `environment`, `verifier`, `design` (Task.md), `kit`
  (harness.json or PROJECT.md), `fixtures` (a gating check without a fixture for
  each of pass, fail and unknown) or `check` (run `eval check`). It does not
  block this stage; it keeps the package out of a run.
- A failed `eval check`: read `checks/<case>/<fixture>/logs`. Fix the verifier,
  the environment or the fixture script. Never change a fixture's expected
  result to match what the verifier happened to return.

After a repair, rerun the returned `resume.command`. Do not retry an unchanged
blocker in a loop.

## Limits of this release

Checks are judged by code in `tests/test.sh`; there is no model judge, so a
requirement about tone or answer quality cannot be gated yet. Say so instead of
approximating it with a keyword check. Packages use Harbor's shared verifier
mode, and each run makes one attempt per package. Fixtures are not supported
for multi-step packages yet.
