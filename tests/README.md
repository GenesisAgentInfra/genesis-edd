# Tests

`npm test` (`node --test`) runs every `*.test.js` file. Node runs the files in
parallel, one process each, and the tests of one file one after another, since
they share `process.env` through `useFakeTools`.

`npm run test:quick` runs only the files of the main path: the harness smoke
test, the Spec, eval packages, runs and the loop (`helpers/harness.smoke.test.js`,
`spec.test.js`, `eval.test.js`, `run.test.js`, `loop.test.js`). Use it while
iterating, and run `npm test` before a commit.

- `spec.test.js` covers the Spec, its Map and its export; `spec-export.test.js`
  the Spec format, what an export shows the user, `spec import`, `--adopt`,
  `spec remap` and the skill launchers.
- `eval.test.js` covers eval packages and their proofs; `confirm.test.js` the
  review and the confirmation; `confirm-rules.test.js` the proofs each tier
  needs, accepted verdicts, the must_decide items and what a confirmation
  records.
- `loop.test.js` covers the main loop; `loop-<topic>.test.js` cover the rest of
  the loop by topic: `loop-review.test.js` the final review, the report and
  the user's decisions on the main path; `loop-consent.test.js` loop start
  consent and budgets; `loop-start-code.test.js` base records and the start
  code; `loop-decisions.test.js` ending, declining, abandoning, disputes and
  project tests; `loop-accepted.test.js` acceptance and the failure ledger.
  Helpers more than one of them use are in `helpers/loop.js`.
- `run.test.js` covers runs and their comparison; `run-code.test.js` the base
  record and the code identity, `run-plan.test.js` the run plan,
  `run-ledger.test.js` trials, the run index and runs a change lock refuses.
  Shared helpers are in `helpers/run.js`.
- `helpers/edd.js` holds the synthetic project, the fake Harbor and the fake
  Docker. `readyProject` builds each distinct set of options once per test
  process and gives every test its own copy of that project.
- `helpers/harness.smoke.test.js` checks the harness itself: the fake tools,
  the tiers `readyProject` confirms, and the loop helpers end to end.

Nothing needs Docker, Harbor, a network or a model. The fake Harbor reads
`app/results.json` as what the verifier finds; under the empty-run probe of
`eval check` (Harbor's `nop` agent) every check is unknown unless
`app/probe.json` says otherwise. The fake Docker answers `docker info` and
lists and removes the compose objects a test gives it with
`tools.dockerObjects()`. Run progress on stderr is off unless a test calls
`tools.progress(true)`.

## The user's decisions

The CLI records a user's decision only with who made it and where they said
so. The helpers make each one that way, never by going around a check:

- `USER` and `REF` are that person and place; `CONSENT` is `{ by, ref }` for
  the functions in `src/`, `CONSENT_FLAGS` the same as CLI flags, and
  `APPROVAL` / `APPROVAL_FLAGS` the cost approval of `run start`
  (`--approved-by`, `--ref`).
- `confirmChecks(project, options)` writes the reviewer's answers from the
  review template and calls `eval confirm` with `by` and `ref`. Every other
  option goes to it: `tier`, `attempts`, `startLoop`, `judgeGating`,
  `acceptVerdict` and so on.
- `startLoop(repo, name, options)` (from `helpers/edd.js`, re-exported by
  `helpers/loop.js` and `helpers/run.js`) starts a loop with the user's
  consent. A test of a start without consent passes
  `{ by: undefined, ref: undefined }` or calls `startLoop` of `src/loop.js`.
- `reviewRun(project, runId, options)` records a final review with
  `loop review`; acceptance needs one for the accepted code.

## Tiers

`readyProject` confirms the tier the CLI proposes: the light tier for sealed
packages with no live dependency and no model. `tier: 'full'` asks for the
full tier; a project with packages that are not connected gets it by default,
since the light tier cannot confirm lines whose package cannot be proved.
`live` or `model` makes a change of the full tier, whose confirmation fixes
the number of attempts (3 by default). In the light tier every gating line
needs a proof that its checks can fail: `readyProject` writes a reviewer's
counterexample for each line, or, with `proof: 'baseline'`, lets the baseline
it records before the confirmation prove the lines the change fixes.
