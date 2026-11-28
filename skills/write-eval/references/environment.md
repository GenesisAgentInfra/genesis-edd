# Building the environment

Build the smallest resettable world that keeps the behavior this scenario
needs. [harbor.md](harbor.md) says where its files live and how Harbor uses
them. This file is about what to build.

## What to look at

- **The path of the scenario.** Follow the evaluated program through the
  tools, services and state this scenario touches. The Genesis Map copy in
  the change folder, `openspec/changes/<change>/business-map.json`, and the
  handoff's `impact` show where it enters and what it may affect. A change
  made before Map copies existed may name a file under `.genesis/out` in the
  handoff's `context.map.path` instead. Read the code where they do not
  reach.
- **The program's own interfaces.** Keep the program's code as it is: tool
  names, argument shapes and errors stay those of production. Replace the
  service or the data behind an interface, not the interface.
- **Only what the scenario exercises.** Implement the operations, records,
  permissions and errors this scenario uses, and no more. Do not invent
  services the Spec does not need.
- **Fixed input.** Create data with code and store it, so every run starts
  from the same input.
- **What a second scenario would repeat.** Put that in the kit's
  `environment/`, and let each package choose its own behavior with a
  setting.

Record each dependency in `dependencies` in `checks.json`, with its mode and,
for a frozen or simulated one, its `stand_in`. Record the stand-in itself in
the kit's `PROJECT.md`. `eval review` shows the user every dependency, its
mode and its stand-in.

## Each dependency: live, frozen or simulated

| Mode | Use when | Examples | In the package |
| --- | --- | --- | --- |
| `live` | Read-only, safe, hard to reproduce, and it can be pinned or recorded | model calls, a read-only MCP server | `network_mode = "allowlist"` with the host in `allowed_hosts`; reference secrets as `${VAR}` and never store their values |
| `frozen` | Content must be identical in every run | a document corpus, web search results, a repository revision | bake the data into the image or ship it as fixed files; serve search results from a local service |
| `simulated` | The scenario writes, fails, checks permissions or time, or state must reset | placing an order, filing a ticket, sending a notification | a stateful service in `docker-compose.yaml` on an internal network, reached by its service name |

Default to local, controlled dependencies. An eval never writes to
production. A `live` dependency makes two runs less comparable; say so when
you report. A package that declares one takes the change to the full tier and
runs the number of attempts the user chooses, and every other package runs
once. When the kit's `harness.json` names a model, declare that model `live`
in every package whose scenario calls it.

## Sealed unless live

A package that can reach the network is live: it must declare that dependency
`live`, in both tiers, or `eval confirm` refuses it (`network_undeclared`).
Every other package is sealed: neither the program nor a stand-in reaches the
outside during the trial. [harbor.md](harbor.md#network) gives the two ways:
`network_mode: none` for a package without stand-ins, and an internal network
for one with them.

How to weigh a model dependency:

- A stand-in may replace a model when the scenario tests the code around it,
  such as a scripted model that answers each turn the same way. Then the
  dependency is `simulated`, and the light tier tests that code, not the
  model's answers. The user hears that.
- When the result depends on the model's reply, a prompt or the model
  configuration, declare the model `live`. A stand-in for what the change
  edits measures nothing of the change: a prompt change is not tested with a
  scripted model.
- A sealed program may take an offline fallback branch and pass. Say so in
  `PROJECT.md` when the program has one, so the reviewer can check which
  branch a run took.
- Time, random numbers and concurrency vary too. Replace them with fixed
  stand-ins where the scenario depends on them. A check that passes and fails
  on the same code stops a loop and keeps the change out of the light tier.

A simulated dependency holds state:

- within a run, what the program wrote can be read back later in the same
  run;
- after the run, the verifier reads the final state from the service itself;
- between runs, each one starts from the same seeded state.

## Reset

| Environment | What shows it resets |
| --- | --- |
| A fresh container per run | Its starting state, confirmed once. Replacement is the isolation. |
| A service or database reused across runs | Its starting state recorded, changed, reset, and confirmed to return |
| Immutable fixed data | The pinned input loads. No reset check is needed. |
| An approved live sandbox | A dedicated identity, a safe starting state, the allowed effects and the cleanup, all confirmed |

## Keep hidden evidence hidden

The program sees state only through its normal interface. The verifier reads
raw final state through a separate path. Nothing under `tests/` or
`solution/`, and no expected result, reaches the program's image or
workspace. `eval validate` rejects an environment file that could hand them
over (`expected_results_exposed`).

## Before a run

These should hold before a baseline is recorded:

- every operation the scenario needs answers as intended and has its effect;
- valid actions succeed, and invalid ones fail for the intended reason;
- `eval check` proved the package: with the fixtures of
  [verifier.md](verifier.md) in the full tier, and with its probe in the
  light tier.

They show that the scenario is reachable and that the verifier decides
correctly. They do not show that the scenario is realistic or hard enough.

The approach to environments and verifiers here is adapted from the
MIT-licensed `langchain-eval-engineering` skill,
https://github.com/langchain-ai/langchain-skills.
