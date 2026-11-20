# Writing the verifier

A verifier decides each check from evidence that does not depend on what the
agent says it did. Start every check from one sentence: pass if and only if an
observable outcome holds.

## Read final state

- Prefer the state a service ends in: rows, records, sent requests, files.
- Use recorded tool calls only when final state cannot prove a required action.
- Never trust an action list written by the agent, a success flag it returns, or
  a helper in the environment that already decides success.
- Accept every result that satisfies the requirement. Do not require a path,
  wording, length, keyword or call count unless that property is the requirement.

## Three results

| Result | Use when |
| --- | --- |
| `pass` | Complete evidence shows the expectation holds. |
| `fail` | Complete evidence shows it does not. |
| `unknown` | The evidence could not be read: a service is down, a log is missing, the scenario never triggered. |

A run treats `unknown` as missing evidence. It blocks a passing verdict and is
never counted as a business failure, so do not turn a broken environment into a
`fail`, and do not turn an unread log into a `pass`.

## Decide in this order

1. Could the evidence be read, and does it belong to this run? If not: `unknown`.
2. Did the scenario happen? A check that nothing was sent proves nothing when
   nothing was attempted. If the trigger is not in the evidence: `unknown`.
3. Only then compare the outcome with the expectation: `pass` or `fail`.

A result that fakes success while the real outcome is wrong reaches step 3 and
fails. A result with no trigger stops at step 2.

## Fixtures

A fixture is a script, `tests/fixtures/<name>.sh`, that runs in `main` in the
agent's place and leaves a result whose verdict you already know. `eval check`
runs each one through Harbor, then the real verifier, and compares what the
verifier returned with `fixtures[].expect` in `checks.json`.

Every gating check needs at least one fixture for each result:

| Expect | The script leaves |
| --- | --- |
| `pass` | a correct result, produced without the evaluated program |
| `fail` | a realistic wrong result, with the scenario triggered |
| `unknown` | no trigger, or evidence that is missing or belongs to another run |

Add more where the risk is real: a different result that is also correct
(`pass`), a shortcut that claims success while the outcome is wrong (`fail`), a
prohibited side effect (`fail`), a boundary such as a negation or a stale
record. A fixture drives the same interfaces the program uses; it never writes
the evidence store directly.

A script that exits nonzero is a broken fixture, and the check fails. Record the
evidence for each check; a result without evidence cannot be audited.
