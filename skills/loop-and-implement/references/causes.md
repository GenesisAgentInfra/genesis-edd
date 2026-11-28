# Why a check does not hold

Classify before changing anything. Each cause lives in a layer of its own,
and changing another layer hides it rather than fixes it.

| Cause | Signs in the evidence | Layer | What checks that layer |
| --- | --- | --- | --- |
| Code logic | The program ran, the stand-ins behaved, and their records show the wrong effect. | code | a run of the loop |
| Requirement unclear or contradictory | Two checks cannot both hold, or a needed decision is not in the Spec. | spec, the user's | `spec validate`, `spec export` |
| Missing information | The program could not know a needed fact from its input or environment. | package or kit; spec when the fact is a business rule | `eval validate`, `eval check` |
| Adapter | The program never ran, ran with the wrong arguments, or a normal exit status was read as a crash. | kit | `eval check` |
| Environment | A stand-in answered wrongly, state was not reset, or a service was down. | package or kit | `eval check` |
| False rejection | The records show a correct effect, but the check failed. | package, the verifier | `eval check`, `eval review` |
| False acceptance | The check passed, but the records show a wrong effect. | package, the verifier | `eval check`, `eval review` |
| Leakage | The program could read expected results or the verifier. | package | `eval validate` |
| Infrastructure | An image build, a pull, Docker or a timeout failed. | machine | none: it is not a result |

How to tell them apart:

- Read the stand-ins' own records first. They show what the program actually
  did, independent of what it printed or what the verifier concluded.
- `unknown` means the evidence could not be read or the scenario never
  happened. It points at the adapter, the environment or the machine, not at
  the code.
- A check that fails in some attempts and passes in others is still a failure
  of a requirement that must always hold. `<case>/attempts.json` names each
  attempt's trial folder under `logs/harbor/`: compare a failing attempt's
  logs with a passing one's before calling it noise. The same holds across
  runs: a failure on some code counts for that code however many runs of it
  pass, in later loops of the same Spec export too, and a lost run counts as a
  failure of every gating check of its packages.
- A check that passed in a screen run and fails in the final run of the same
  code varies: nothing changed between the two runs. Find what makes the
  result vary before changing anything. That code can never be accepted, so
  the fix is a change of the code, or of the package or environment when the
  evidence points there.
- In a light-tier loop, an attempt of a head run or a trial that reported
  tokens or cost called a model (`tier_changed`), and a check that passed and
  failed on the same code
  (`stop_unstable`) shows a result that is not fixed. Look for the source,
  such as a model, the clock, random numbers or an offline fallback. Replacing
  it with a fixed stand-in, or declaring it a live dependency, changes the
  package; the second also takes the change out of the light tier, which is
  the user's to confirm.

What a fix in the packages or the kit means for the loop:

- The packages and the kit are fixed for a loop. A change to one ends it
  (`packages_changed`); a new fixture, such as a counterexample, does not.
- A changed package is ready again only once `eval check` proves it. The user
  confirms it before a new loop, never at acceptance; `eval review` lists what
  changed for them.
- When you propose such a change, tell the user what was wrong with the
  package, what evidence showed it, and which checks failed before the fix.
  If you think a check of the running loop is wrong, `loop dispute` records
  the evidence for the user's ruling.
- Never make a check easier to hide a defect in the code.
