# Reviewing the checks

Before the user confirms the checks, a second reader tests them against the
Spec. The reviewer writes a counterexample for every THEN or AND line a
program checks, then judges whether each check says what its line says. The
user reads the result and confirms the checks, the number of attempts, the
model and the budget once, before the baseline. In a new project no package
can run before the loop connects it: the reviewer judges the checks first, and
writes the counterexamples once the packages are connected. Connecting them
ends that first loop, and the user confirms the connected packages before a
new loop (the end of the next section says how). A loop compares every run
with the checks the user confirmed, and ends when they change.

The reviewer works in a fresh context: a subagent if you have one, given
`reviewer_brief` from `eval review` and nothing else. Without a subagent, do
the review yourself as a separate pass and mark it `self-review`: the user is
told that only the author read the checks.

## The two passes

1. **Counterexamples, without the verifier.** The reviewer reads only what
   `reviewer_brief.give` lists: the Spec, each package's `checks.json`,
   `PROJECT.md`, the environment files with the stand-in services, and the
   author's pass fixtures. They do not read `tests/test.sh`, `tests/shared/`
   or the kit's `verifier/` (`reviewer_brief.withhold`). For every line a
   program checks, they write a fixture that leaves a realistic result that
   breaks that line and no other, as a fixture script in `tests/fixtures/`
   and an entry in `checks.json`:

   ```json
   { "name": "notice-after-rejection", "origin": "review",
     "note": "报告提交被拒绝，却发出了一条成功通知",
     "expect": { "c1": "fail" } }
   ```

   Run `eval check`. A counterexample that does not get `fail` shows that the
   verifier misses what the line rules out: fix the verifier, never the
   counterexample.
2. **Verdicts, with the verifier.** Run `eval review` again once `eval check`
   passes. The counterexamples changed each package's `task_digest`, so
   answers written into the first `review_template` are stale
   (`review_stale`). Now the reviewer reads the verifier and answers each
   question of this second `eval review` into `review.json`, written from its
   `review_template`.

In a new project no package can run before the loop connects it, so no
counterexample can be proved yet, and `eval review` says so in its `next` and
`reviewer_brief`. The reviewer judges now, from `checks.json`, whether the
`expect` of each check says what its line says, and answers into
`review.json`. Once the loop connects a package, `eval review` gives the
brief of an existing project again: they write its counterexamples as in the
first pass, prove them with `eval check`, and answer a second `eval review`.
Connecting the package changed it, which ended the loop, so the user confirms
it with `eval confirm --reason` before the baseline is recorded again and a
new loop starts with their go-ahead.

## What counts as a counterexample

A fixture is a counterexample of a line when:

- its `origin` is `review`, or `self-review` when the author reviews alone;
- its `expect` names every gating check of the package;
- every gating check whose `then` is that line expects `fail`;
- every other gating check expects `pass` or `unknown`.

An author's fixture never counts, even one that fails only the line. A
package in checks.json 1.1 is ready only when every line a program checks has
a counterexample, and `eval check` proves it like any other fixture, after
every change to the package. A line in `scenario.manual` needs none: the user
judges it. A package in checks.json 1.0 needs none either, and cannot be
confirmed.

## Verdicts

| Verdict | The checks of the line |
| --- | --- |
| `faithful` | pass exactly when the line holds |
| `weaker` | also pass for some results the line rules out |
| `stronger` | also fail for some results the line allows |
| `different` | check something else than the line says |
| `vacuous` | cannot fail, or cannot pass |
| `not_observable` | no program can judge this line |

`eval confirm` takes only `faithful` for a line a program checks, and only
`not_observable` for a line in `scenario.manual`. Any other verdict sends the
package back to write-eval: fix the check and prove it with `eval check`, or
move a line no program can judge into `scenario.manual`; then review again.

## review.json

`.genesis/edd/<change>/review.json`, committed with the packages:

```json
{
  "schema_version": "1.0",
  "spec": "sha256:<handoff id>",
  "review": { "origin": "review", "note": "A fresh subagent read the Spec, then the verifier." },
  "lines": [
    { "package": "submit-failure-s1", "then": "本次提交发送的成功通知数量为零",
      "task_digest": "sha256:…", "verdict": "faithful", "note": "Counts the success notices of this submission." }
  ],
  "packages": [
    { "package": "submit-failure-s1", "task_digest": "sha256:…", "loosens": false, "note": "The diff only adds a build step." }
  ]
}
```

Write it from `review_template`: it lists every line with its package's
`task_digest`, and a line of a package unchanged since the last confirmation
keeps the verdict confirmed then. `packages` answers, for each package changed
since the last confirmation, whether its diff loosens a THEN line. A
`task_digest` names the package as it was reviewed, so an answer goes stale
when the package changes.

## eval review

`edd eval review <change> --repo <app>` is read-only and returns:

- `lines`: every THEN and AND line with its requirement, scenario, package,
  status (`gating`, `manual`, `uncovered` or `unbound`), checks, fixtures by
  origin, counterexamples, the expected and recorded baseline result of each
  gating check, and the review answer so far.
- `must_decide`, most severe first: `then_uncovered`, `manual_line`,
  `expect_differs` (an `expect` worded otherwise than its line),
  `self_review_only`, `changed_since_confirmation` (with the files),
  `plan_changed_since_confirmation` (`harness.json` changed since the last
  confirmation and names another agent or model),
  `baseline_plan_recorded` (before any loop of the Spec export, a baseline
  recorded while no confirmation covered the packages, with another plan than
  `eval confirm` records without plan flags, as with `--attempts`, `--agent`
  or `--model`; `keys` names what differs, and `loop start` takes that
  baseline only once the user confirms the plan it ran),
  `spec_changed_since_confirmation` (lines added and removed since the last
  confirmed export) and `failed_with_old_package` (a check that failed with an earlier version of
  its package and passed with this one on the same code).
- `questions` for the reviewer, `reviewer_brief`, and `review_template`.
- `run_plan`: the packages with a live dependency, those that declare none
  while the kit names a model, the agent and the model, whether the user must
  fix a number of attempts, the proposal of 5, or 3 when the budget is tight,
  what 1, 3 and 5 attempts rule out, and the budget. `estimate` gives the
  minutes of the baseline, a screen run and the final run for 1, 3 and 5
  attempts, by the attempt times of the last `eval check`, with its `basis`;
  it counts only ready packages, and `estimate_missing` names the others.
  `not_counted` names what the CLI cannot see, such as the reviewer's passes
  and model calls.
- `confirmation` and `current`: the latest confirmation of this Spec export,
  and whether it covers the packages as they are.

## Confirming

Show the user, in one message: the line table, `must_decide`, the expected
baseline results, the number of attempts with its cost from
`run_plan.estimate` and what it rules out, the model, and the budget. Add your
own estimate of what `run_plan.not_counted` names, and say that the CLI does
not count it. When `estimate_missing` names a package, prove it with
`eval check` and run `eval review` again before you give the cost. When the
CLI has no estimate yet, as in a new project, give your own and say so. After
their own words, run:

```sh
edd eval confirm <change> --repo <app> --verdicts .genesis/edd/<change>/review.json \
  --by <name> --ref <where they said so> [--attempts N] [--agent NAME] [--model MODEL] \
  [--max-iterations N] [--max-minutes M]
```

`--verdicts` is a path in the project, or an absolute one. The agent and the
model default to the kit's `harness.json`, the budget to 5 full runs and 60
minutes. A revision keeps the run plan confirmed before, unless flags give
other values; once `harness.json` has changed since that confirmation, its
agent and model count again, and `run_plan` and `must_decide` show them.
`--attempts` is needed while a package declares a live dependency, or while
the agent runs with a model and a ready package declares none. A baseline
reads the plan: run it without `--attempts`, `--agent` and `--model`. Before
any loop of the Spec export it refuses other values (`run_plan_differs`);
once a loop has started for it, `run start` refuses those flags whatever
their values (`run_plan_fixed`).

`eval confirm` refuses, with `CONFIRM_INPUT_BLOCKED` and nothing written:

| Gap | Why |
| --- | --- |
| eval gaps | a package is invalid, stale, a draft, or leaves a line uncovered |
| `then_unbound` | a package is still in checks.json 1.0 |
| `review_unreadable` | `review.json` is no review, or a line has no verdict |
| `review_stale` | answers for another export, for another version of a package, a line missing or extra, or a changed package without its answer |
| `line_not_faithful` | a line a program checks was judged other than `faithful` |
| `manual_disputed` | a `scenario.manual` line was judged other than `not_observable` |
| `package_loosens` | the reviewer found that a package's diff loosens a THEN line |
| `reason_missing` | this export was confirmed before; a new confirmation is a revision, of the packages or of the run plan |
| `attempts_undecided` | the user's number of attempts is needed |
| `confirmation_unreadable` | `confirmed.json` cannot be read; restore it from Git |

`--by` and `--ref` are required. It warns about lines only a self-review
counterexample stands behind, about packages changed since their last
`eval check`, which a run skips until it is run again, and names packages not
connected yet: their counterexamples are proved once they are connected, and
connecting them changes them, so the user confirms them again, and inside a
loop that ends it. In a new project whose packages are not
connected yet, no package declares its dependencies, so it also warns when
the confirmation fixes no number of attempts: if a scenario may call a model,
ask the user for N before the baseline, as `eval review`'s `next` says.

## confirmed.json

`.genesis/edd/<change>/confirmed.json`, committed. The newest confirmation is
at the top level; earlier ones are under `earlier`, oldest first.

| Field | Meaning |
| --- | --- |
| `id` | Digest of the entry without `id` and `earlier`. An entry edited by hand no longer matches: `confirmation_invalid`. Restore the file from Git, or confirm again, which starts a new file. |
| `spec` | The change and the exported Spec it confirms. |
| `packages` | Each package's `task_digest`, the digest of each of its files, and whether it was ready. |
| `kit` | The digest of each file of the project kit. |
| `lines` | Each line with its requirement, scenario, status, checks, their `expect`, its counterexamples, the reviewer's verdict and note, and for a manual line its reason. |
| `review`, `package_reviews` | Who reviewed (`review` or `self-review`) and the answers about changed packages. |
| `baseline_expectations` | `baseline-expectations.json` as the user saw it, or `[]`. |
| `run_plan` | `attempts`, `pass_rule` (`all`), `agent`, `model` and `budget` (`iterations`, `minutes`). |
| `confirmed` | `by`, `ref`, `at`, `kind` (`initial` or `revision`) and, for a revision, `reason`. |

## Revisions

A package changed after the confirmation, inside a loop or before it, is a
revision. Prove it with `eval check`, run `eval review` again: its lines lose
their verdicts, and the reviewer reads its diff and says whether it loosens a
THEN line. The user confirms it with `eval confirm --reason <why the packages
changed>`. Inside a loop the change has ended the loop (`packages_changed`),
so this comes before a new loop, never with the acceptance; the baseline is
recorded again on the loop's start code, and a new loop starts with the
user's go-ahead.

While a loop runs, its run plan is fixed. A confirmation with another plan or
other packages than the loop's ends it (`confirmation_changed`), and a new
loop needs a baseline of that plan on its start code. A confirmation with the
same plan and packages, such as one with a new budget, leaves the loop as it
is, with its own budget; a bigger budget goes to a new loop, given to
`loop start`.
