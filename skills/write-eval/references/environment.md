# Building the environment

Build the smallest resettable world that keeps the behavior this scenario needs.
[harbor.md](harbor.md) says where its files live and how Harbor uses them. This
file is about what to build.

## Order

1. Follow the evaluated agent through the tools, services and state this
   scenario touches. Use the Genesis Map in the change folder,
   `openspec/changes/<change>/business-map.json` (a change made before the copy
   existed may name a file under `.genesis/out` in the handoff's
   `context.map.path` instead), and `impact` from the Spec handoff when they
   exist; read the code where they do not reach.
2. Keep the agent's own code as it is: tool names, argument shapes and errors
   stay those of production. Replace the service or data behind an interface.
3. Choose how each external dependency is provided. Record the choice in
   `dependencies` in `checks.json`, and the stand-in in the kit's `PROJECT.md`.
4. Implement only the operations, records, permissions and errors this scenario
   exercises.
5. Create data with code and store it, so every run starts from the same input.
6. Put what a second scenario would repeat into the kit's `environment/`, and
   let each package choose its own behavior with a setting.

## Each dependency: live, frozen or simulated

| Mode | Use when | Examples | In the package |
| --- | --- | --- | --- |
| `live` | Read-only, safe, hard to reproduce, and it can be pinned or recorded | model calls, a read-only MCP server | `network_mode = "allowlist"` with the host in `allowed_hosts`; reference secrets as `${VAR}`, never store their values |
| `frozen` | Content must be identical in every run | a document corpus, web search results, a repository revision | bake the data into the image or ship it as fixed files; serve search results from a local service |
| `simulated` | The scenario writes, fails, checks permissions or time, or state must reset | placing an order, filing a ticket, sending a notification | a stateful service in `docker-compose.yaml`, reached by its service name |

Default to local, controlled dependencies. An eval never writes to production.
A `live` dependency makes two runs less comparable; say so when reporting.

A simulated dependency must hold state:

- within a run, what the agent wrote can be read back later in the same run;
- after the run, the verifier reads the final state from the service itself;
- between runs, each one starts from the same seeded state.

## Reset

| Environment | Check |
| --- | --- |
| A fresh container per run | Build one and confirm its starting state. Replacement is the isolation. |
| A service or database reused across runs | Record the starting state, change it, reset, and confirm it returns. |
| Immutable fixed data | Confirm the pinned input loads. No reset check is needed. |
| An approved live sandbox | Confirm the dedicated identity, a safe starting state, the allowed effects and the cleanup. |

## Keep hidden evidence hidden

The agent sees state only through its normal interface. The verifier reads raw
final state through a separate path. Nothing under `tests/` or `solution/`, and
no expected result, is copied into the agent's image or workspace; `eval
validate` rejects an environment file that reaches them.

## Before any run

1. Call every operation the scenario needs and confirm its response and effect.
2. Confirm valid actions succeed and invalid ones fail for the intended reason.
3. Write the fixtures in [verifier.md](verifier.md) and run `eval check`.

Fix a failure before recording a baseline. These steps show that the scenario
is reachable and the verifier decides correctly. They do not show that the
scenario is realistic or hard enough.

The approach to environments and verifiers here is adapted from the MIT-licensed
`langchain-eval-engineering` skill, https://github.com/langchain-ai/langchain-skills.
