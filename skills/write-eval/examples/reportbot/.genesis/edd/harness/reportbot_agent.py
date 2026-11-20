import shlex

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class ReportbotAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "reportbot"

    def version(self) -> str:
        return "1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        command = shlex.join(["python", "-m", "reportbot", *shlex.split(instruction)])
        result = await environment.exec(command=command, cwd="/app", user="nobody")
        output = (result.stdout or "") + (result.stderr or "")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "reportbot.log").write_text(f"exit={result.return_code}\n{output}")
        # The CLI also exits 1 after handling a rejected submission.
        if result.return_code not in (0, 1) or "Traceback (most recent call last):" in output:
            raise RuntimeError(f"reportbot exited {result.return_code}: {output}")
