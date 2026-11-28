# Reviewing the checks

Before the user confirms the checks, a second reader tests them against the
Spec. The reviewer writes a counterexample for each line that needs one, and
judges whether each line's checks say what the line says. The user reads the
result and confirms the checks and the run plan. A loop compares every run
with the checks the user confirmed, and ends when they change.

## Who reviews

The default reviewer is a fresh context, for example a subagent, given
`reviewer_brief` from `eval review` and nothing else. A person, or two
reviewers, is at least as independent and is fine too. Whoever reviews is
`review`, provided they did not write the checks and wrote their
counterexamples without reading the verifier. Say who reviewed in
`review.note`. When you review alone, as a separate pass, mark what you write
`self-review`, never `review`. The user is told which lines rest only on a
self-review (`self_review_only`, `self_review_verdict`).

`reviewer_brief` gives these:

- `first`: what to write before reading the verifier;
- `then`: what to answer after it;
- `lines`: the lines that need a counterexample;
- `give`: the Spec, each package's `checks.json`, the environment files, the
  kit's `PROJECT.md` and `environment/`, the author's pass fixtures and, in
  the light tier, the evidence the baseline left;
- `withhold`: `tests/test.sh`, `tests/shared/` and the kit's `verifier/`.

## What a review holds

A review has two parts. The order between them keeps the counterexamples
independent of the verifier.

1. **Counterexamples, written without the verifier.** For each line in
   `reviewer_brief.lines`, the reviewer writes a fixture that leaves a
   realistic result which breaks that line and no other. That is a script in
   `tests/fixtures/`, or a code patch for a line a code test checks, with an
   entry in `checks.json`:

   ```json
   { "name": "notice-after-rejection", "origin": "review",
     "note": "报告提交被拒绝，却发出了一条成功通知",
     "expect": { "c1": "fail" } }
   ```

   `eval check` proves new fixtures on their own; the probe does not run
   again for them. A counterexample that does not get `fail` shows that the
   verifier misses what the line rules out. Fix the verifier, never the
   counterexample.
2. **Verdicts, given after reading the verifier.** The reviewer answers each
   question of `eval review` into `.genesis/edd/<change>/review.json`, written
   from its `review_template`. They also answer, for each package changed
   since the last confirmation, whether its diff loosens a THEN line. For a
   line proved by its failure before the change, the reviewer also checks
   that the baseline failed for the behavior this line changes, not for
   another reason.

The template names each package by its `run_digest`. A counterexample leaves
that digest as it was, so the template stays current while counterexamples
are added. A fix to the verifier changes the package, and the next
`eval review` gives a template for it.

## Which lines need a counterexample

- **Full tier:** every line a program checks.
- **Light tier:** every line a program checks that has no other proof that it
  can fail. A line's real failure at the baseline proves it when all of these
  hold:
  - every gating check of the line failed, with evidence, in an attempt that
    completed;
  - that baseline ran the package as it is now;
  - every baseline of this Spec export expected `fail` for it;
  - no run on that code saw it pass;
  - no check of the line is shared with another line.

  A line a code test checks is proved this way too. A trial never proves a
  line. `eval review` names each line's proof so far (`lines[].proof`).
- A line whose check several lines share, as a `then_group` check is,
  always needs its own counterexample, which names it in `then`. A failure
  of that check at a baseline never proves any of its lines.
- In a new project the baseline runs on an entry skeleton and proves nothing,
  so every line needs a counterexample. It can be proved only once the
  package is connected.
- A line in `scenario.manual` needs none: the user judges it. A judge check
  of such a line that stays diagnostic needs none either.
- A line whose judge check the user makes gating (`--judge-gating`) needs a
  proof in either tier: its judge checks' failure at the baseline, under the
  conditions above, or a reviewer's counterexample of the line.

## What counts as a counterexample

A fixture is a counterexample of a line when all of these hold:

- its `origin` is `review`, or `self-review` when the author reviews alone;
- its `expect` names every gating check of the package, though a script may
  leave out a code test of another line;
- every gating check of that line expects `fail`;
- every other gating check expects `pass` or `unknown`;
- when `then` is given, it names that line.

The counterexample of a line a code test checks is a code patch: a fixture
`eval validate` lists in its case's `code_patches`. For a line whose judge
check is made gating, the counterexample's `then` names that line, it
expects `fail` for the line's judge checks and `pass` or `unknown` for every
other gating check, and the last `eval check` proved it. An author's fixture
never counts, even one that fails only the line. In the full tier, a package
in checks.json 1.1 is ready only when every line a program checks has a
counterexample that `eval check` proved. In the light tier, `eval confirm`
refuses a gating line with no proof (`line_unproven`), and `loop accept`
checks each line's proof again. Both do the same, in either tier, for a line
whose judge check is made gating.

## Verdicts

| Verdict | The checks of the line |
| --- | --- |
| `faithful` | pass exactly when the line holds |
| `weaker` | also pass for some results the line rules out |
| `stronger` | also fail for some results the line allows |
| `different` | check something else than the line says |
| `vacuous` | cannot fail, or cannot pass |
| `not_observable` | no program can judge this line |

`eval confirm` takes `faithful` for a line a program checks, a line whose
judge check is made gating included. It takes `weaker` or `stronger` only
when the user accepts that line as it is, with a reason
(`--accept-verdict`); `eval review` lists such lines as
`verdict_acceptable`. It never takes `different` or `vacuous`
(`line_not_faithful`). For any other line in `scenario.manual` it takes only
`not_observable` (`manual_disputed` otherwise). A verdict the user does not
accept means the package needs work: fix the check and prove it, or move a
line no program can judge into `scenario.manual`. Then review again. Write
the note of a `weaker` or `stronger` verdict so the user can decide from it
alone: which results the check lets through, or rejects, that the line does
not. Also say whether every check that passes when something is not found
carries `"absence": true`.

## review.json

`.genesis/edd/<change>/review.json`, committed with the packages:

```json
{
  "schema_version": "1.0",
  "spec": "sha256:<handoff id>",
  "review": { "origin": "review", "note": "A fresh subagent wrote the counterexamples, then read the verifier." },
  "lines": [
    { "package": "submit-failure-s1", "then": "本次提交发送的成功通知数量为零",
      "run_digest": "sha256:…", "verdict": "faithful", "note": "Counts the success notices of this submission." }
  ],
  "packages": [
    { "package": "submit-failure-s1", "run_digest": "sha256:…", "loosens": false, "note": "The diff only adds a build step." }
  ]
}
```

Write it from `review_template`, and keep each digest as the template gives
it. A line keeps the verdict confirmed before while what its package checks
did not change: the check entries of `checks.json`, the rest of `tests/`
apart from the fixtures, and the kit's `verifier/`. The template carries such
a verdict (`carried`). `packages` answers, for each package changed since the
last confirmation, whether its diff loosens a THEN line. An answer goes stale
when its package changes, but not when only a fixture does.

## eval review

`edd eval review <change> --repo <app>` is read-only and needs the current
export. It returns these:

- `lines`: every THEN and AND line with its requirement, scenario, package,
  status, checks, fixtures by origin, counterexamples, expected and recorded
  baseline result, proof, and the review answer so far.
- `must_decide`: the decisions that are the user's. Each item has a code, a
  message and its facts:
  - lines and checks: `then_uncovered`, `manual_line`, `expect_differs`,
    `then_group`, `judge_check`;
  - who reviewed: `self_review_only`, `self_review_verdict`;
  - what changed since the last confirmation: `changed_since_confirmation`,
    `plan_changed_since_confirmation`, `spec_changed_since_confirmation`,
    `package_rebound`;
  - baselines and runs: `baseline_plan_recorded`,
    `expectation_changed_after_baseline`, `expectation_added_after_baseline`,
    `code_changed_before_baseline`, `trial_before_baseline`,
    `cost_approved_runs`, `failed_with_old_package`;
  - the ledger and the network: `ledger_runs_lost`, `ledger_incomplete`,
    `network_undeclared`;
  - hints that decide nothing: `variability_signals`.
- `must_show`: what the user must see before confirming:
  - `lines` and `must_decide`;
  - `run_plan`: the tier with its reasons, the agent and model, whether
    attempts are needed (with the proposal and what 1, 3 and 5 attempts rule
    out), the minute estimates, what the CLI does not count, the budget and
    the cost cap;
  - `adapters`, `rebound`, `dependencies`, `code_checks`, `judge_checks`,
    `then_groups`, `recorded_choices` and `ledger`.

  `shown` is the digest of `must_show`. The wording and the number of
  messages are yours. Add your own estimate of what `run_plan.not_counted`
  names, and say that the CLI does not count it.
- `questions`, `reviewer_brief`, `review_template`, `run_plan` and `spec_diff`.
- `confirmation` and `current`: the latest confirmation of this export, and
  whether it covers the packages as they are.
- `gaps`, `warnings`, `confirm` (what a confirmation needs and which flags it
  takes), `loop`, and `change_lock` when the change is locked.

## Confirming

`eval confirm` reads this `review.json` and records the user's confirmation
of the checks and the run plan, only after their own words. The run-eval
skill explains its flags, what it refuses and what it records
([run-eval/SKILL.md](../../run-eval/SKILL.md), "Confirming the checks").

## Revisions and loops

A package changed after the confirmation is a revision; a new fixture alone
is not. To confirm a revision, prove the changed package with `eval check`
and run `eval review` again. A line whose checks did not change keeps its
verdict. The reviewer reads each changed package's diff and says whether it
loosens a THEN line. Then the user confirms again. Tell the user what
changed, why, and the diff.

While a loop runs, its packages and its plan are fixed. A package change ends
the loop (`packages_changed`). So does a confirmation with another plan,
another tier or other packages (`confirmation_changed`). A confirmation with
the same plan and packages, such as one with a new budget, leaves the loop
running with its own budget. A running loop's budget is changed with
`loop budget` and the user's `--by` and `--ref`. A new loop needs the user's
consent and a baseline of the confirmed plan on its start code.
