# Harbor, as these packages use it

Harbor runs one package as one trial in local Docker. The CLI starts it; you do
not call `harbor run` yourself. What follows was checked with Harbor 0.27.0.
For anything else, `harbor run --help` on this machine is the contract.

## What happens in a trial

1. Harbor builds and starts the environment: `environment/Dockerfile`, or
   `environment/docker-compose.yaml` with a service named `main`.
2. It calls the agent: `setup`, then `run` with the text of `instruction.md`.
3. After the agent returns, it uploads `tests/` to `/tests` in `main` and runs
   `/tests/test.sh` there. Nothing under `tests/` exists in the container before
   that, so the agent cannot read it.
4. It reads `/logs/verifier/reward.json`. Everything the verifier writes under
   `/logs/verifier/` is kept with the trial.

The verifier runs in `main`, so it sees what the agent left there and reaches
the other services by name. Harbor runs its own commands with `bash`: use a base
image that has it.

## The environment

Two variables are set for every trial, and Harbor passes them to Compose:

| Variable | Is |
| --- | --- |
| `GENESIS_EDD_REPO` | the project root |
| `GENESIS_EDD_HARNESS` | the project kit, `.genesis/edd/harness` |

A package must be identical before and after a change, or two runs cannot be
compared. So the application is never copied into a package. Build the image
from the project as it is when the trial starts, and take shared files from the
kit:

```yaml
# environment/docker-compose.yaml
services:
  main:
    build:
      context: ${GENESIS_EDD_REPO}
      dockerfile: .genesis/edd/harness/environment/Dockerfile
    environment:
      NOTIFY_API_URL: http://api:8080
    depends_on:
      api:
        condition: service_healthy
  api:
    image: python:3.12-slim
    configs:
      - source: simulator
        target: /opt/simulator.py
    command: ["python", "/opt/simulator.py", "503"]
    healthcheck:
      test: ["CMD", "python", "-c", "from urllib.request import urlopen; urlopen('http://localhost:8080/health').close()"]
      interval: 1s
      retries: 20

configs:
  simulator:
    file: ${GENESIS_EDD_HARNESS}/environment/simulator.py
networks:
  default:
    internal: true
```

- Add `.genesis` to the project's `.dockerignore`. Without it a broad `COPY`
  puts every package's expected results into the agent's image; `eval validate`
  rejects the package. It also rejects any other build context that holds the
  package, such as `..` or `${GENESIS_EDD_HARNESS}/..`, and checks the kit's
  environment files as it checks the package's.
- Give each stand-in a healthcheck and let `main` wait for `service_healthy`.
- Keep the evidence where the agent cannot change it: in the stand-in service,
  or on a volume that `main` mounts read-only.

## Network

`network_mode` in `task.toml` is `public`, `no-network` or `allowlist` (with
`allowed_hosts`). It governs the containers Harbor manages. Networks you declare
in a compose file are respected as written, so for stand-in services the simple
isolation is the one above: `internal: true` on the default network. Services
reach each other; nothing reaches the outside. Images are pulled and built
before the network applies.

Use `allowlist` when a dependency is live. Say in `Task.md` which of the two
isolates the package.

## The adapter

The evaluated program enters through a Harbor agent: a built-in one, or a class
in the kit named by `harness.json` as `module:Class`. The kit folder is on
Harbor's import path during a trial.

```python
# .genesis/edd/harness/project_agent.py
import shlex

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class ProjectAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "project-agent"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        # Start the program the way production does, with this input.
        result = await environment.exec(command=f"python -m app {shlex.quote(instruction)}", cwd="/app", user="nobody")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "program.log").write_text(f"exit={result.return_code}\n{result.stdout or ''}{result.stderr or ''}")
        if result.return_code != 0:
            raise RuntimeError(f"program exited {result.return_code}")
```

- `environment.exec(command, cwd=None, env=None, timeout_sec=None, user=None)`
  returns `return_code`, `stdout` and `stderr`.
  `environment.upload_file(source, target)` copies a host file in.
- Keep the program's output: `self.logs_dir` is saved with the trial as `agent/`.
- Raise when the program could not do its work at all. The run then records an
  execution error, not a failing check. Do not raise for an exit status that is
  part of the program's normal behavior, such as "the request was rejected";
  say which statuses those are in `PROJECT.md`.
- Tell normal from broken by the exit status, not by which stream a message is
  on. Docker can deliver the program's stderr inside `stdout` and leave
  `stderr` empty. If you must match a message, search both.
- `eval check` replaces the adapter with each fixture, so it never runs the
  adapter. The first real run of the adapter is the baseline: an execution
  error there usually points at the adapter. Fix it, run `eval check` again,
  and record the baseline again.
- An adapter binds dependencies and passes input and output through. It never
  decides an answer or performs an action for the program.
- Declare an MCP server under `[[environment.mcp_servers]]` in `task.toml`.
  Harbor registers it only for its built-in agents; an adapter reads that
  configuration itself.

## Images

Each trial builds the `main` image from the project as it is at that moment, so
a code change reaches the next run without a rebuild flag. Docker reuses layers
whose inputs did not change.

## Where Harbor comes from

The CLI runs `harbor` from the `PATH`. When it is not installed there, set
`GENESIS_EDD_HARBOR` to the command as a JSON array, for example
`GENESIS_EDD_HARBOR='["uvx","--from","harbor","harbor"]'`. That needs no global
install.

## Reading a trial

Under a run's `<case>/logs/harbor/<trial>/`: `agent/` holds what the adapter
saved, `verifier/` holds the verifier's output and anything it copied there,
`trial.log` and `result.json` hold Harbor's own account. Two lines in these logs
are harmless: "Skipping image OS validation" and a note that an adapter declares
no options model.
