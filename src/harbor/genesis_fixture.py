"""Stands in for the evaluated agent during `eval check`.

Harbor calls run() once for a package of one step, and once for each step, in
the order task.toml declares them, for a package with steps. Each call runs
the fixture's script for that step in the main container, so the package's
real verifier then judges a result whose correct verdict is already known. A
step the fixture has no script for is left as it is: nothing is done there.

Each script is uploaded to a new random path for every call and deleted once
it ran, so a verifier cannot tell a proof run from a real one by where a
script was left.

GENESIS_EDD_FIXTURE names the script of a package of one step. For a package
with steps, GENESIS_EDD_STEPS lists the steps in the order Harbor runs them,
as a JSON list, and the script of step S is tests/fixtures/NAME/S.sh: the
folder is GENESIS_EDD_FIXTURE_DIR/GENESIS_EDD_FIXTURE_NAME, or
GENESIS_EDD_FIXTURE itself when it names a folder, or the folder beside the
script GENESIS_EDD_FIXTURE names, without its .sh.
"""
import json
import os
import shlex
import uuid
from pathlib import Path

from harbor.agents.base import BaseAgent


def _steps() -> list[str]:
    raw = os.environ.get("GENESIS_EDD_STEPS", "").strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw.split(",")
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _script(call: int, steps: list[str]) -> tuple[str | None, Path | None]:
    """The step of this call, or None for a package of one step, and the
    script to run for it, or None when there is none."""
    fixture = Path(os.environ["GENESIS_EDD_FIXTURE"])
    if not steps:
        return None, fixture if call == 0 and fixture.is_file() else None
    if call >= len(steps):
        return None, None
    step = steps[call]
    name = os.environ.get("GENESIS_EDD_FIXTURE_NAME", "").strip()
    base = os.environ.get("GENESIS_EDD_FIXTURE_DIR", "").strip()
    if fixture.is_dir():
        folder = fixture
    elif name and base:
        folder = Path(base) / name
    else:
        folder = fixture.with_suffix("")
    script = folder / f"{step}.sh"
    return step, script if script.is_file() else None


class FixtureAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "genesis-fixture"

    def version(self) -> str:
        return "2"

    async def setup(self, environment) -> None:
        pass

    async def run(self, instruction, environment, context) -> None:
        call = getattr(self, "_genesis_calls", 0)
        self._genesis_calls = call + 1
        steps = _steps()
        step, script = _script(call, steps)
        where = f"step {step}: " if step else ("" if not steps else f"call {call + 1}, after the last step: ")
        lines = []
        try:
            if script is None:
                lines.append(f"{where}no script, nothing done")
                return
            target = f"/tmp/{uuid.uuid4().hex}"
            await environment.upload_file(script, target)
            try:
                result = await environment.exec(command=f"sh {shlex.quote(target)}")
            finally:
                try:
                    await environment.exec(command=f"rm -f {shlex.quote(target)}")
                except Exception:
                    # The container is discarded after the trial; a script
                    # that could not be removed is still at a random path.
                    pass
            lines.append(f"{where}exit={result.return_code}\n{result.stdout or ''}{result.stderr or ''}")
            if result.return_code != 0:
                raise RuntimeError(f"fixture script {'for step ' + step + ' ' if step else ''}exited {result.return_code}")
        finally:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            with (self.logs_dir / "fixture.log").open("a") as handle:
                handle.write("\n".join(lines) + "\n")
