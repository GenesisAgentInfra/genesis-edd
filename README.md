# Genesis EDD

Evaluation-driven development for coding agents: agree on what a feature must
do, turn that into evals, and check your change against them.

Genesis EDD is a set of skills for Claude Code and Codex. Your coding agent does
the reasoning; Genesis keeps what it produces structured and checks it. No
Genesis service or extra model key is needed.

## How it works

1. **agent-spec.** Describe a feature in plain words. The agent writes a spec
   with requirements and acceptance scenarios, asks only about decisions that
   change what is accepted, and exports a fixed version.
2. **write-eval.** Each scenario becomes a [Harbor](https://docs.harborframework.com)
   task package with expected results taken from the spec. What all packages
   of a project share, such as how your agent is started and what stands in for
   its dependencies, is built once in a project kit. A package can run only
   after its checking script has been proved against results whose verdict is
   known.
3. **run-eval.** Run the packages on the code before your change and after it,
   and compare them check by check. A run that could not execute is reported as
   such, never as a failed check.
4. **loop-and-implement.** Change the code until the checks pass, within a
   budget the user agrees to. The spec, the expected results and the baseline
   stay fixed while the code changes. Every run gets a short report; the loop
   stops when the checks pass, the budget runs out, the same checks keep
   failing, or the user must decide. Acceptance is the user's.

The loop needs the project in Git. It records the code of every run and never
commits for you.
The skills start from ordinary requests. Each stage checks its inputs first and
sends the agent back to the stage that owns a gap. It works in a new project or
an existing one, and uses a Genesis Map when you have one: a copy goes into Git
with the spec.

## Install

You need **Node.js 22.20.0 or later**.

### Claude Code

```text
/plugin marketplace add GenesisAgentInfra/genesis-edd
/plugin install genesis-edd@genesis-edd
```

Or from your shell:

```bash
claude plugin marketplace add GenesisAgentInfra/genesis-edd
```

```bash
claude plugin install genesis-edd@genesis-edd
```

Start a new session afterwards.

### Codex

```bash
codex plugin marketplace add GenesisAgentInfra/genesis-edd
```

```bash
codex plugin add genesis-edd@genesis-edd
```

The first time a skill runs, it installs two pinned npm packages inside the
plugin folder. Codex's sandbox cannot write there, so Codex may ask you to
approve that one command.

### In your project

Nothing to set up with the plugin. The first time you use `agent-spec` in a
project, the agent creates an `openspec/` folder there.

### Docker and Harbor

Writing specs and packages works without them. Proving packages
(`eval check`), running them and the implementation loop need:

- Docker, running.
- Harbor. Install it with `uv tool install harbor`, or run it without a global
  install by setting
  `GENESIS_EDD_HARBOR='["uvx","--from","harbor","harbor"]'`.

<details>
<summary>Install into one project from a checkout</summary>

Use this for a coding agent without plugin support that reads skills from
`.agents/skills/` or `.claude/skills/`, or to pin a version per project. Do not
also install the plugin: the agent would see each skill twice.

You can ask your agent:

```text
Install Genesis EDD in this project from https://github.com/GenesisAgentInfra/genesis-edd.
Follow "Install into one project from a checkout" in its README.
```

Steps for the agent, or by hand. Keep the target project's absolute path.
Clone into a tools folder outside the project, or reuse an existing checkout:

```bash
git clone https://github.com/GenesisAgentInfra/genesis-edd.git
cd genesis-edd
npm ci --ignore-scripts
node bin/genesis-edd.js init --repo /absolute/path/to/your-project --mode existing --agent codex
```

- `--mode new` for a project without application code, `--mode existing` for
  an existing codebase.
- `--agent codex` writes `.agents/skills/`, `--agent claude` writes
  `.claude/skills/`, `--agent both` writes both.

Check the install from the project:

```bash
node .agents/skills/agent-spec/scripts/run.mjs --version
```

Use `.claude/skills/...` for Claude Code. Keep the checkout where it is: the
installed skills run its CLI. Copying only the skill folders does not work.

`init` also creates `openspec/`. Each skill folder it installs holds a
`.gitignore` that keeps the folder out of Git, because it points at this
machine's checkout: everyone who clones the project runs `init` from their own
checkout. A `.gitignore` does not untrack files already committed; if an
earlier install's skill folders are in Git, `init` names them and the
`git rm -r --cached` command that takes them out.

</details>

## Use

Ask for what you want; the matching skill starts.

```text
I want to add report notifications. When report submission fails, do not send a
success notification. Help me write the requirements and acceptance scenarios.
```

```text
Write evals for the report notifications spec.
```

```text
Record the baseline, then implement the change until the evals pass. Stop after
five runs.
```

Whether a skill starts on its own is up to your coding agent. To choose one
explicitly, use `/genesis-edd:agent-spec` in Claude Code (`/agent-spec` for a
project install), or type `$` in Codex and pick the skill.

## What it writes in your project

| Path | Holds | In Git |
| --- | --- | --- |
| `openspec/` | specs, their exported versions, and the Genesis Map each was written against (`business-map.json`) | yes |
| `.genesis/edd/harness/` | the project kit shared by every eval package | yes |
| `.genesis/edd/<change>/evals/` | one Harbor task package per scenario | yes |
| `.genesis/edd/<change>/checks/` | proofs that each package's checks work | no |
| `.genesis/edd/<change>/runs/` | run records and before/after comparisons | no |
| `.genesis/edd/<change>/reports/` | one report per run of the implementation loop | yes |
| `.genesis/edd/<change>/accepted.json` | the user's acceptance of a passing run, with earlier ones | yes |
| `.agents/skills/<skill>/`, `.claude/skills/<skill>/` | the four Genesis EDD skills, installed from a checkout by `init` | no |

## Skills

| Skill | Purpose | Status |
| --- | --- | --- |
| `agent-spec` | Clarify requirements, write acceptance scenarios, export a validated spec | Available |
| `write-eval` | Turn an exported spec into eval packages and prove their checks | Available |
| `run-eval` | Run eval packages and compare the baseline with later runs | Available |
| `loop-and-implement` | Implement the change and iterate on eval results until the checks pass | Available |

## Update

- **Claude Code:** run `/plugin marketplace update genesis-edd`, then start a
  new session. To update automatically, open `/plugin`, choose
  **Marketplaces**, select `genesis-edd` and enable auto-update.
- **Codex:** run `codex plugin marketplace upgrade genesis-edd`, then start a
  new session.
- **Checkout:** run `git pull` and `npm ci --ignore-scripts`, then run `init`
  again for each project. Installed files you edited are left as they are.
  Read its `warnings`: it names skill folders an earlier install committed.

## License

Apache-2.0. Built with OpenSpec; see [third-party notices](THIRD_PARTY_NOTICES.md).
