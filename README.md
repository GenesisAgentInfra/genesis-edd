# Genesis EDD

Turn feature requests into clear, testable specs with your coding agent.

Genesis EDD helps you define what a feature should do before implementation,
and then check it. The **agent-spec** skill turns your request into concise
requirements and concrete acceptance scenarios. **write-eval** turns each
scenario into an eval package, and **run-eval** runs the packages before and
after a change and compares the two.

## What you can do

- **Describe a feature in plain language.** Turn the conversation into a structured
  spec with observable outcomes.
- **Work with new or existing projects.** Start from an empty project or use existing
  specs, code, and available Genesis Maps as context.
- **Refine requirements without starting over.** Keep accepted decisions and focus
  the discussion on what changes.
- **Check readiness before handing off.** Find missing information and unresolved
  decisions, then continue after they are addressed.
- **Export a fixed version of the spec.** Preserve requirements, their sources, and
  acceptance scenarios for subsequent work.
- **Get one eval package per scenario.** Each package is a
  [Harbor](https://docs.harborframework.com) task with the expected results kept
  out of the agent's reach.
- **Compare before and after.** Run the same packages on the code before your
  change and after it, and see which expected results now hold.

Works with Codex and Claude Code. Uses your existing coding agent; no Genesis
service is required. Running evals needs Docker and Harbor on your machine, and
whatever model access your own agent under test already uses.

## Skills

| Skill | Purpose | Availability |
| --- | --- | --- |
| `agent-spec` | Clarify requirements, write acceptance scenarios, and export a validated spec. | Available |
| `write-eval` | Turn an exported spec into eval packages, one per scenario. | Available |
| `run-eval` | Run eval packages and compare baseline and head results. | Available |
| `loop-and-implement` | Implement changes and iterate using Eval feedback. | Not yet available |

## Get started

Open your project in Codex or Claude Code and ask:

```text
Install Genesis EDD in this project from https://github.com/GenesisAgentInfra/genesis-edd.
Read its README and complete setup for the coding agent I am using.
```

Your agent can download the framework, install its dependencies, and initialize
the current project. Include the repository URL on the first install so it can
find the right project. Requires Git and **Node.js 22.20.0 or later**.

<details>
<summary>Installation steps for your agent or manual setup</summary>

Keep the target project's absolute path before changing directories. Reuse an
existing Genesis EDD checkout, or clone it into a persistent tools directory
outside the target project:

```sh
git clone https://github.com/GenesisAgentInfra/genesis-edd.git
cd genesis-edd
npm ci --ignore-scripts
node bin/genesis-edd.js init --repo /absolute/path/to/your-project --mode new --agent codex
```

When reusing a checkout, enter it and start with `npm ci`. Point `--repo` to the target project's
existing directory. Use `--mode new` for a project without application code, or
`--mode existing` for an existing codebase. Inspect the project to choose the mode.
Use `--agent codex` for Codex, `--agent claude` for Claude Code, or `--agent both`
when the user wants both.

Verify the installed launcher from the target project:

```sh
node .agents/skills/agent-spec/scripts/run.mjs --version
```

For Claude Code, use `.claude/skills/agent-spec/scripts/run.mjs` instead.
Copying only the skill folder leaves out its CLI dependencies and runtime binding;
complete the dependency installation and `init` step. Keep the Genesis EDD
checkout available: the installed skills use its CLI.

`run-eval` also needs Docker running and
[Harbor](https://docs.harborframework.com) on the `PATH` (for example
`uv tool install harbor`). The other skills work without them.
If you installed `genesis-spec`, rerun init to migrate to `agent-spec`. Files that
differ from the previous shipped version are left untouched for manual review.

</details>

## Describe what you want

```text
I want to add report notifications. When report submission fails, do not send a
success notification. Help me clarify the requirements and acceptance scenarios.
```

You do not have to type a command. Codex and Claude Code can select `agent-spec`
when your request matches its requirements and acceptance-scenario scope.
Automatic selection is decided by your coding agent; it is not guaranteed for
every prompt. To select the skill explicitly, use `$agent-spec` in Codex or
`/agent-spec` in Claude Code. If the installed skill is not visible, reload your
agent session.

The agent drafts the spec, clarifies unresolved business decisions, validates it,
and exports it when ready. You can review and edit the spec in your project.

## Write and run evals

```text
Write evals for the report notifications spec, then run them before and after
the change.
```

`write-eval` creates one package per acceptance scenario under
`.genesis/edd/<change>/evals/`, on top of a project kit in
`.genesis/edd/harness/` that holds what every package shares: how your agent is
started, stand-ins for its dependencies, and the code that reads evidence. A
package can run once its checking script has been proved against results whose
verdict is known. `run-eval` records each run under
`.genesis/edd/<change>/runs/`; run and check records stay out of Git.

A project without an implementation has nothing to run first: the baseline is
recorded as unavailable, and the first results count for the new code only. A
run that could not execute is reported as such, never as a failed check.

Genesis checks required inputs when you enter a supported workflow stage. These
checks do not force your coding agent to select the skill or intercept code edits.

## License

Apache-2.0. Built with OpenSpec; see [third-party notices](THIRD_PARTY_NOTICES.md).
