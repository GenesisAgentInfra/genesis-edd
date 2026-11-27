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
  attempts before calling it noise.

After a `write-eval` fix:

- Run `eval check` for the package; it is not ready until it passes.
- The package's digest changes, so its checks compare with no baseline result
  (`head_only`). Say in the report's Cause what was wrong with the package and
  what evidence showed it.
- Never make a check easier to hide a defect in the code.
