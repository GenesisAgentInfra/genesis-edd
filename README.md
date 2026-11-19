# Genesis EDD

Turn feature requests into clear, testable specs with your coding agent.

Genesis EDD helps you define what a feature should do before implementation.
The **agent-spec** skill turns your request into concise requirements
and concrete acceptance scenarios, with questions focused on decisions that affect
acceptance.

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

Works with Codex and Claude Code. Uses your existing coding agent; no separate
model API key or Genesis service is required.

## Skills

| Skill | Purpose | Availability |
| --- | --- | --- |
| `agent-spec` | Clarify requirements, write acceptance scenarios, and export a validated spec. | Available |
| `write-eval` | Turn an accepted spec into an Eval task package. | Not yet available |
| `run-eval` | Run Evals and compare baseline and head results. | Not yet available |
| `loop-and-implement` | Implement changes and iterate using Eval feedback. | Not yet available |

## Get started

Requires **Node.js 22.20.0 or later**.

```sh
git clone https://github.com/GenesisAgentInfra/genesis-edd.git
cd genesis-edd
npm ci --ignore-scripts
node bin/genesis-edd.js init --repo /absolute/path/to/your-project --mode new --agent both
```

Point `--repo` to an existing project directory. Use `--mode existing` if the project
already has code. Choose `--agent codex`, `--agent claude`, or `--agent both`.
Keep the Genesis EDD checkout available: the installed skill uses its CLI.
If you installed `genesis-spec`, rerun init to migrate to `agent-spec`. Files that
differ from the previous shipped version are left untouched for manual review.

Reload your project's skills, then describe the behavior you want.

In Codex:

```text
$agent-spec When report submission fails, do not send a success notification.
```

In Claude Code:

```text
/agent-spec When report submission fails, do not send a success notification.
```

The agent drafts the spec, clarifies unresolved business decisions, validates it,
and exports it when ready. You can review and edit the spec in your project.

## License

Apache-2.0. Built with OpenSpec; see [third-party notices](THIRD_PARTY_NOTICES.md).
