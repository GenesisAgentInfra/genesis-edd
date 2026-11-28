# Harbor, as these packages use it

Harbor runs one package as one trial in local Docker. The CLI starts every
trial: `eval check` for proofs, and `run start` for trials, baselines and
loop runs, each recorded. What follows was checked with Harbor 0.27.0. For
anything else, `harbor run --help` on this machine is the contract.

## What happens in a trial

1. Harbor builds and starts the environment: `environment/Dockerfile`, or
   `environment/docker-compose.yaml` with a service named `main`.
2. It calls the agent: `setup`, then `run` with the text of `instruction.md`.
3. After the agent returns, it uploads `tests/` to `/tests` in `main` and runs
   `/tests/test.sh` there. Nothing under `tests/` exists in the container
   before that, so the agent cannot read it.
4. It reads `/logs/verifier/reward.json`. Everything the verifier writes under
   `/logs/verifier/` is kept with the trial.

A package with steps repeats steps 2 and 3 for each step that `task.toml`
declares. The agent runs with that step's `instruction.md`, then Harbor lays
the step's `tests/` over `tests/` and runs that step's `test.sh`. Harbor
keeps what each step's verifier wrote under `steps/<step>/verifier/` of the
trial. EDD reads each check only from the step its `at` names, and compares
each step's reward with the gating checks at that step.

The verifier runs in `main`, so it sees what the agent left there and reaches
the other services by name. Harbor runs its own commands with `bash`, so use
a base image that has it.

## The environment

Two variables are set for every trial, and Harbor passes them to Compose:

| Variable | Is |
| --- | --- |
| `GENESIS_EDD_REPO` | the project root, or the rebuilt start code for a run `--at-start` |
| `GENESIS_EDD_HARNESS` | the project kit, `.genesis/edd/harness` |

A package must be identical before and after a change, or two runs cannot be
compared. So the application is never copied into a package. Build the image
from the project as it is when the trial starts, and take shared files from
the kit:

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

- Add `.genesis` to the project's `.dockerignore`. Without it, a build from
  the project root puts every package's expected results into the image.
  Add only that line, and create the file with just that line when there is
  none. Other exclusions change every Docker build of the project, so they
  are the user's call. The file decides what enters the image, so it counts
  as application code. When the packages build from the project root, add
  the line before `spec new`. Added later, it makes the baseline run on other
  code than `spec new` recorded, and `eval review` lists that for the user
  (`code_changed_before_baseline`). Tell the user before the baseline.
- Reach the project only through `${GENESIS_EDD_REPO}`. A baseline on the
  rebuilt start code points that variable at the rebuilt code. A path of your
  own into the project would read the working directory instead, and
  `run start --at-start` refuses it (`working_tree_read`).
- Give each stand-in a healthcheck, and let `main` wait for
  `service_healthy`.
- Keep the evidence where the agent cannot change it: in the stand-in
  service, on a volume that `main` mounts read-only, or, for the program's
  reply, in a directory of `main` only root can use, written by a recorder
  (see [The adapter](#the-adapter)).

`eval validate` reports `expected_results_exposed` for any environment file,
the package's or the kit's, that could hand the program, or a stand-in that
could pass it on, what decides its result:

- a build context, an additional build context, a bind mount, a config or a
  secret that holds the project root or a folder above it, or that reaches
  `.genesis/edd` or a `checks.json`. A mount of the project root is never
  filtered by `.dockerignore`.
- the host's Docker socket;
- a COPY that takes `.genesis/edd` or the kit's `verifier/` into an image;
- a path given by a variable it cannot resolve;
- an `include` or `extends` whose files it does not read;
- text that names `checks.json`, `../tests` or `../solution`.

## Network

A package is sealed when neither the program nor a stand-in can reach the
outside during the trial. Every package must be sealed or declare a `live`
dependency, in both tiers, and the light tier needs every package sealed.
The CLI decides from the package's files, as Harbor 0.27.0 uses them. Harbor
merges the package's compose file after its own and keeps the network
settings written there. A package is sealed in one of two ways:

- **No stand-in services:** every service, usually `main` alone, has
  `network_mode: none`. `eval new` writes this for a new package:

  ```yaml
  # environment/docker-compose.yaml
  services:
    main:
      network_mode: none
  ```

  `main` still needs its image: an `environment/Dockerfile` beside it, or a
  `build` as in the example above.
- **Stand-in services:** every service joins only networks declared
  `internal: true`. A service without `networks` is on `default`, so declare
  `default` internal, as the example above does. Services reach each other
  by name, and nothing reaches the outside.

With a compose file, seal the package there and keep `network_mode` in
`task.toml` at `public`. `no-network` and `allowlist` in `task.toml` make
Harbor start an egress sidecar. That moves every service without network
settings of its own into the sidecar's network, so `main` no longer reaches a
stand-in by name. `no-network` with such stand-ins counts as sealed, with a
warning, and its runs usually end in an execution error. A package with only
a Dockerfile and `no-network` counts as sealed through that sidecar. The
sidecar needs kernel support and has not been checked on a real Harbor yet,
so prefer the compose file above.

These are not sealed:

- a service whose `network_mode` is anything but `none`, such as `host`,
  `bridge` or `service:…`;
- a service on a network that is not internal, or on an external one;
- a package with only a Dockerfile and `public`, the default of earlier
  versions;
- `allowlist`;
- a file that cannot be read or parsed;
- an `include`, or a service that `extends` another.

A stand-in that reaches the outside unseals the package too, because it
could pass requests on for `main`.

When a dependency is live, use `allowlist` with the host in `allowed_hosts`,
and declare the dependency `live` in `checks.json`; the change then takes the
full tier. Say in `Task.md` how the package is isolated. Sealing governs the
trial only: images are pulled and built before it applies, so a build can
still download dependencies.

## The adapter

The evaluated program enters through a Harbor agent: a built-in one, or a
class in the kit named by `harness.json` as `module:Class`. The kit folder is
on Harbor's import path during a trial. A package's own `harness.json`,
`{"agent": "module:Class"}`, names another adapter for that package alone.
Runs pass it to Harbor for that package, and the confirmation records it.

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
- Keep the program's output: `self.logs_dir` is saved with the trial as
  `agent/`. Harbor 0.27.0 also copies that folder into `main` at
  `/logs/agent` before the verifier runs. The program under test can write
  there, so a verifier never reads `/logs/agent` as evidence. `eval validate`
  warns about a package's `tests/` or the kit's `verifier/` that names it.
- When a line is about the program's reply, the adapter may start the
  program through the kit's recorder, so the reply is kept where the program
  cannot reach it ([verifier.md](verifier.md#when-the-reply-is-the-outcome)).
  Copy [assets/record.py](../assets/record.py) into the kit's
  `environment/` folder and hand it to `main` as a config:

  ```yaml
  # environment/docker-compose.yaml
  services:
    main:
      build:
        context: ${GENESIS_EDD_REPO}
        dockerfile: .genesis/edd/harness/environment/Dockerfile
      network_mode: none
      configs:
        - source: record
          target: /opt/record.py
  configs:
    record:
      file: ${GENESIS_EDD_HARNESS}/environment/record.py
  ```

  The adapter runs it as root, and the recorder runs the program as an
  unprivileged user:

  ```python
  command = shlex.join(["python3", "/opt/record.py", "--", "python", "-m", "app", instruction])
  result = await environment.exec(command=command, cwd="/app", user="root")
  if result.return_code in (125, 126, 127):
      raise RuntimeError(f"the recorder could not run the program: {result.stderr or result.stdout}")
  ```

  The recorder exits 125 to 127 when it could not run the program, and
  otherwise with the program's own status. `main` needs `python3`. A fixture
  script starts the recorder too, as the agent's user, so keep that user
  root: no `USER` in `main`'s image and no `user` under `[agent]` in
  `task.toml`. The recorder lives in the kit's `environment/`, so the proofs
  rest on it, and an edit to it asks for a new `eval check`.
- Raise when the program could not do its work at all. The run then records
  an execution error, not a failing check. Do not raise for an exit status
  that is part of the program's normal behavior, such as "the request was
  rejected". Say which statuses those are in `PROJECT.md`.
- Tell normal from broken by the exit status, not by which stream a message
  is on. Docker can deliver the program's stderr inside `stdout` and leave
  `stderr` empty. If you must match a message, search both.
- In a package with steps, Harbor calls `run` once per step, each time with
  that step's instruction. When `run` raises in any step, the whole attempt
  is an execution error, and the attempt names that step.
- `eval check` never runs the adapter. It replaces the adapter with each
  fixture script, with Harbor's nop agent for the probe, and with the nop
  agent on patched code for a code patch fixture. An edit to `harness.json`,
  or to the adapter modules at the kit's root, therefore keeps the proofs.
  The exception is a module that an environment file copies or mounts into a
  container. The adapter first runs in a trial or a baseline. An execution
  error there usually points at the adapter.
- An adapter binds dependencies and passes input and output through. It
  never decides an answer or performs an action for the program.
- The adapter runs on the host, outside the sealed network. An adapter
  module that imports a model SDK or a general HTTP client takes the change
  to the full tier. In a light-tier loop, an attempt of a head run or a
  trial that reports tokens or cost ends the loop (`tier_changed`), and such
  a head run cannot pass. Neither catches an
  adapter that sends requests another way, so keep the adapter to starting
  the program.
- Declare an MCP server under `[[environment.mcp_servers]]` in `task.toml`.
  Harbor registers it only for its built-in agents, so an adapter reads that
  configuration itself.
- Host variables named as `${NAME}` in an env table of `task.toml` reach
  Harbor only when the user agrees: `--yes` passes every declared one, and
  `--allow-env NAME[,NAME]` passes the named ones.

## Images

Each trial builds the `main` image from the project as it is at that moment,
so a code change reaches the next run without a rebuild flag. Docker reuses
layers whose inputs did not change.

## Where Harbor comes from

The CLI runs `harbor` from the `PATH`. When it is not installed there, set
`GENESIS_EDD_HARBOR` to the command as a JSON array, for example
`GENESIS_EDD_HARBOR='["uvx","--from","harbor==0.27.0","harbor"]'`. That needs
no global install. Use Harbor 0.27.0, the version this release is checked
with.

## Reading a trial

A trial's logs are under `runs/<run>/<case>/logs/harbor/<trial>/` for a run,
and under `checks/<case>/<fixture>/logs/harbor/<trial>/` for a proof (the
probe's fixture folder is `_probe`). `agent/` holds what the adapter
saved, and `verifier/` holds the verifier's output and anything it copied
there; a package with steps has one per step, under
`steps/<step>/verifier/`. `trial.log` and `result.json`
hold Harbor's own account. Two lines in these logs are harmless: "Skipping
image OS validation", and a note that an adapter declares no options model.
