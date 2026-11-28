# Writing the verifier

A verifier decides each check from evidence that does not depend on what the
program says it did. Start every check from one sentence: pass if and only if
an observable outcome holds.

## Read final state

- Prefer the state a service ends in: rows, records, sent requests, files.
- Use recorded tool calls only when final state cannot prove a required
  action.
- Never trust a helper in the environment that already decides success.
- Never trust an action list written by the program or a success flag it
  returns as evidence of any effect other than the reply itself.
- Read a file the program could write, such as its store, only when it is a
  regular file and not a symlink. Otherwise the result is `unknown`.
- Accept every result that satisfies the requirement. Do not require a path,
  wording, length, keyword or call count unless that property is the
  requirement.

## When the reply is the outcome

Some lines are about the program's reply itself: what a command prints, its
exit status, the answer an agent gives. For such a line the reply is the
outcome. Capture it where the program cannot reach it.

- The adapter starts the program through a recorder in `main` that runs as
  root. [assets/record.py](../assets/record.py) is one. It runs the program
  as an unprivileged user and kills what that user left running once the
  program exits. Then it writes one record per command into a directory only
  root can read: the argv, stdout, stderr, exit status and times.
  [harbor.md](harbor.md#the-adapter) shows how a kit hands it to `main`.
- The verifier first checks the trigger: the recorded argv carries this
  scenario's input. Compare the arguments that hold the input, not the
  program's path, which a fixture's stand-in replaces. Only then does it
  read the reply.
- The result is `unknown` when the record is missing, is a symlink
  (`Path.is_symlink()`), is not a regular file, or holds another input.
- A fixture drives the same recorder with a stand-in program, as root, the
  way the adapter does. It never writes a record itself. Put the stand-in
  where the unprivileged user can read it, such as `/tmp`.
- A reply never proves any other effect. `"ok": true` does not show that a
  row was written. A line about the store reads the store.

```python
# verifier/reply.py in the kit: the reply to this scenario's command, or None.
import json
from pathlib import Path

EVIDENCE = Path("/evidence")


def reply(args):
    records = sorted(EVIDENCE.glob("[0-9][0-9][0-9][0-9].json"))
    if len(records) != 1 or records[0].is_symlink() or not records[0].is_file():
        return None
    try:
        record = json.loads(records[0].read_text())
    except (OSError, ValueError):
        return None
    argv = record.get("argv") if isinstance(record, dict) else None
    if not isinstance(argv, list) or argv[len(argv) - len(args):] != args:
        return None
    return record
```

The verifier maps `None` to `unknown`. A package with steps gets one record
per step, numbered in order.

## Three results

| Result | Use when |
| --- | --- |
| `pass` | Complete evidence shows the expectation holds. |
| `fail` | Complete evidence shows it does not. |
| `unknown` | The evidence could not be read: a service is down, a log is missing, the scenario never triggered. |

A run treats `unknown` as missing evidence. It blocks a passing verdict and
is never counted as a business failure. So do not turn a broken environment
into a `fail`, and do not turn an unread log into a `pass`.

## How a check decides

1. Could the evidence be read, and does it belong to this run? If not, the
   result is `unknown`.
2. Did the scenario happen? A check that nothing was sent proves nothing when
   nothing was attempted. If the trigger is not in the evidence, the result
   is `unknown`.
3. Only then is the outcome compared with the expectation: `pass` or `fail`.

A result that fakes success while the real outcome is wrong reaches step 3
and fails. A result with no trigger stops at step 2.

A code test (`kind: code_test`) decides by its test program's exit status
against the application code in the container. A judge (`kind: judge`)
decides by its judging program's exit status. The shipped helper maps both,
as [task-package.md](task-package.md#what-the-verifier-writes) says. A judge
stays diagnostic unless the user makes its line gating at confirmation. A
judge that calls a model needs the network, so its package declares that
dependency `live`.

## The probe

In the light tier, `eval check` runs each package once with Harbor's nop
agent, which does nothing. Every gating check must come out `unknown`, apart
from code tests, which read the code rather than what the program did. A
verifier that judges a result when nothing was done reads no evidence of the
run, or makes its own, for example by starting the program. Never let the
verifier start the program or create its evidence. In the light tier, the
proof that a check can fail is either a real failure before the change or a
reviewer's counterexample, and an accepted head run shows that it can pass.
A verifier that cannot judge `pass` shows only there, as a head run that
cannot pass.

## Fixtures

A fixture is a script that runs in `main` in the program's place and leaves a
result whose verdict you already know. It lives at
`tests/fixtures/<name>.sh`, or at `tests/fixtures/<name>/<step>.sh` for each
step of a multi-step package. `eval check` runs each fixture through Harbor,
then the real verifier, and compares what the verifier returned with
`fixtures[].expect`. A fixture script is uploaded to a fresh random path for
each call and deleted after it ran, so a verifier cannot tell a proof from a
real run by where a script was left.

A code patch fixture, `tests/fixtures/<name>.patch` or
`tests/fixtures/<name>/code.patch`, changes the application code instead. A
fixture is one exactly when `eval validate` lists it in its case's
`code_patches`. `eval check` applies it to a copy of the code as it is now,
outside the project. The nop agent then stands in for the program, and the
package's verifier runs against that copy. The counterexample of a line a
code test checks is a code patch; a script never counts for that line.

In the light tier the author writes no fixtures; any you write still run. In
the full tier, every gating check other than a code test needs at least one
fixture for each result:

| Expect | The script leaves |
| --- | --- |
| `pass` | a correct result, produced without the evaluated program |
| `fail` | a realistic wrong result, with the scenario triggered |
| `unknown` | no trigger, or evidence that is missing or belongs to another run |

Add more where the risk is real:

- a different result that is also correct (`pass`);
- a shortcut that claims success while the outcome is wrong (`fail`);
- a prohibited side effect (`fail`);
- a boundary, such as a negation or a stale record.

A fixture drives the same interfaces the program uses. It never writes the
evidence store directly.

A script that exits nonzero is a broken fixture, and its check fails. Record
the evidence for each check, because a result without evidence cannot be
audited.

A reviewer adds a counterexample for each line that needs one, written
without reading the verifier ([review.md](review.md)). It fails only its
line: the gating checks of that line expect `fail`, and every other gating
check expects `pass` or `unknown`. When the verifier does not return what a
counterexample expects, the verifier is wrong. Fix the verifier, never the
counterexample.
