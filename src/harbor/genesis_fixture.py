"""Stands in for the evaluated agent during `eval check`.

It runs one fixture script in the main container, so the package's real
verifier then judges a result whose correct verdict is already known.
"""
import os
from pathlib import Path

from harbor.agents.base import BaseAgent


class FixtureAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "genesis-fixture"

    def version(self) -> str:
        return "1"

    async def setup(self, environment) -> None:
        pass

    async def run(self, instruction, environment, context) -> None:
        await environment.upload_file(Path(os.environ["GENESIS_EDD_FIXTURE"]), "/tmp/genesis-fixture.sh")
        result = await environment.exec(command="sh /tmp/genesis-fixture.sh")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "fixture.log").write_text(
            f"exit={result.return_code}\n{result.stdout or ''}{result.stderr or ''}"
        )
        if result.return_code != 0:
            raise RuntimeError(f"fixture script exited {result.return_code}")
