# Why a check does not hold

Classify before changing anything. Each cause has its own place to fix.

| Cause | Signs in the evidence | Fix in |
| --- | --- | --- |
| Code logic | The program ran, the stand-ins behaved, and the records show the wrong effect. | the application |
| Requirement unclear or contradictory | Two checks cannot both hold, or a needed decision is not in the Spec. | `agent-spec`, with the user |
| Missing information | The program could not know a needed fact from its input or environment. | `write-eval` for input or environment; `agent-spec` if the fact is a business rule |
| Adapter | The program never ran, ran with the wrong arguments, or a normal exit status was read as a crash. | `write-eval`, in the kit |
| Environment | A stand-in answered wrongly, state was not reset, or a service was down. | `write-eval` |
| False rejection | The records show a correct effect, but the check failed. | `write-eval`, the verifier |
| False acceptance | The check passed, but the records show a wrong effect. | `write-eval`, the verifier |
| Leakage | The program could read expected results or the verifier. | `write-eval`, the package boundary |
| Infrastructure | An image build, a pull, Docker or a timeout failed. | run again; it is not a result |

How to tell them apart:

- Read the stand-in's own records first. They show what the program actually
  did, independent of what it printed or what the verifier concluded.
- `unknown` means the evidence could not be read or the scenario never
  happened. It points at the adapter, the environment or infrastructure, not
  at the code.
- A check that fails in some attempts and passes in others is still a failure
  of a requirement that must always hold. Look for what differs between the
  attempts before calling it noise: `<case>/attempts.json` names each
  attempt's trial folder under `logs/harbor/`, so compare a failing attempt's
  logs with a passing one's. The same holds across runs: a failure on some
  code counts for that code however many runs of it pass, in a later loop of
  the same Spec export too. The count reads `runs/`, which Git does not hold,
  so it covers the runs of this machine.
- A check that passed in a screen run and fails in the final run of the same
  code varies: nothing changed between the two runs. Compare the final run's
  failing attempts with its passing ones and with the screen run's attempt,
  each through `<case>/attempts.json`, and find what makes the result vary
  before changing anything. That code can never be accepted, so the fix is a
  change of the code, or of the package or environment when the evidence
  points there; a fix to a package or the environment ends the loop
  (`packages_changed`).

After a `write-eval` fix:

- Run `eval check` for the package; it is not ready until it passes.
- Inside a loop, the fix ends the loop (`packages_changed`): a loop's packages
  and kit are fixed. Run `eval review`, have the reviewer answer for the
  changed package, and let the user confirm it with `eval confirm --reason`.
  The baseline of the next loop is recorded again on the start code, so it
  runs the fixed package, and earlier results of the old package do not count
  against the new one.
- When you ask the user for that confirmation, tell them what was wrong with
  the package, what evidence showed it and which checks failed before the
  fix. Say the same in the report's Cause; its Changes lists the package and
  kit files that changed.
- Never make a check easier to hide a defect in the code.
