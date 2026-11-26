# Genesis EDD

Genesis EDD is a **spec-driven development** plugin for Claude Code and Codex.
Use OpenSpec to describe the scenarios a feature should handle. Your coding agent
turns those scenarios into runnable acceptance tests before it changes the code.
On an existing project, run the same tests before and after the change to see
what it fixed and which behaviors still pass.

## A failed report still sent a success notification

Reportbot told the team their report was submitted even when the reporting
service rejected it. The fix had to stop that message and keep the notification
people expected after a successful submission. Here's what the two evals showed.

| What the team should see | Before the fix | After the fix |
| --- | --- | --- |
| Submission rejected (HTTP 503) → no success notification | Fail · 1 sent | Pass · 0 sent |
| Submission accepted (HTTP 201) → one success notification | Pass · 1 sent | Pass · 1 sent |

The check reads the service’s record of submissions and notifications. If the bot
never submits the report, zero notifications alone would look correct. Genesis
records that case as `unknown`. The example includes the two evals, seven fixtures
with known answers, and the results of running them locally with Docker and Harbor.
[See the worked example and recorded run](skills/write-eval/examples/reportbot/README.md#what-ran).

## Quick start

### Install

You'll need **Node.js 22.20.0 or later**. Choose the plugin for your coding agent.

**Claude Code** — enter these in a Claude Code session, then start a new session.

```text
/plugin marketplace add GenesisAgentInfra/genesis-edd
/plugin install genesis-edd@genesis-edd
```

From a shell, the equivalent Claude Code commands are
`claude plugin marketplace add GenesisAgentInfra/genesis-edd` and
`claude plugin install genesis-edd@genesis-edd`.

**Codex** — run these in your terminal, then open a new Codex session.

```sh
codex plugin marketplace add GenesisAgentInfra/genesis-edd
codex plugin add genesis-edd@genesis-edd
```

On first use the plugin installs its pinned npm dependencies. Codex may ask for
permission to write them into the plugin directory.

### Use

Open your project in Claude Code or Codex. Give it one behavior you want to
change and one you want to preserve. For a project like Reportbot, you could ask the following.

```text
When a report submission fails, nobody should get a success notification.
When it succeeds, the team should still get exactly one. Write the spec
and acceptance scenarios for these two cases before changing the code.
```

The agent creates an OpenSpec change under `openspec/changes/`. Read the
scenarios and settle any open questions. You can do this part with just the plugin.
To select the skill explicitly, use `/genesis-edd:agent-spec` in Claude Code
(`/agent-spec` for a checkout install), or type `$` in Codex and choose `agent-spec`.

To run the evals, start **Docker** and install **[Harbor](https://docs.harborframework.com)**
with `uv tool install harbor`. For the implementation loop, work in a Git repository.
Continue in the same session.

```text
Write the evals for the agreed spec and check them against known outcomes.
Run them on the current code to record a baseline. Then implement the fix
and run the same evals again. Stop after five runs and show me what changed.
```

Read the before-and-after results in `.genesis/edd/<change>/reports/`.
During this evaluation-driven development (EDD) loop, the spec, checks and
baseline stay fixed. You decide whether to accept the change.

## How it works

| Skill | What it gives you |
| --- | --- |
| [agent-spec](skills/agent-spec/SKILL.md) | An OpenSpec feature spec with the source of each requirement, acceptance scenarios and a validated export. |
| [write-eval](skills/write-eval/SKILL.md) | One Harbor task per scenario. The tasks share a project harness and each verifier is checked against fixtures with known outcomes. |
| [run-eval](skills/run-eval/SKILL.md) | A baseline and a check-by-check comparison with the changed code. The record distinguishes a failed expectation from an eval that could not run. |
| [loop-and-implement](skills/loop-and-implement/SKILL.md) | An implementation and a report for each full run. The agent stops when the checks pass, the agreed budget runs out, progress stalls or it needs your decision. |

The loop records the Git revision and local changes for each run. You control
commits and acceptance. Genesis uses your coding agent for reasoning and does
not require a separate Genesis service or model key.

## Setup options

### Docker and Harbor

You can write specs and task packages before setting up Docker. Checking the
verifiers (`eval check`), running evals and iterating on the results require
a running Docker daemon and Harbor. You can also run Harbor through `uvx` by setting
this environment variable in the shell where you launch your agent.

```sh
export GENESIS_EDD_HARBOR='["uvx","--from","harbor","harbor"]'
```

### Genesis Map

If you already use [Genesis Map](https://github.com/GenesisAgentInfra/genesis),
map your project before writing the spec. EDD saves a copy of the map with the
spec so a final change review can use the same business flows. The four EDD
skills also work on their own.

Map coverage, source information and reviews based on a committed map require
Genesis Map commit `9c0c914` or later. EDD accepts older maps with coverage
marked `unknown` and freshness marked `unverified`. If `genesis map prepare`
rejects `--entries-from`, follow the
[Genesis Map update instructions](https://github.com/GenesisAgentInfra/genesis/blob/main/docs/install.md#update).

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

## What it writes in your project

| Path | Holds | In Git |
| --- | --- | --- |
| `openspec/` | specs, their exported versions, and any Genesis Map they were written against (`business-map.json`) | yes |
| `.genesis/edd/.gitignore` | keeps the package proofs, run records and loop state below out of Git; lines you add are kept | yes |
| `.genesis/edd/harness/` | the project kit shared by every eval package | yes |
| `.genesis/edd/<change>/evals/` | one Harbor task package per scenario | yes |
| `.genesis/edd/<change>/baseline-expectations.json` | the expected baseline result of each check, written by the agent before the baseline runs | yes |
| `.genesis/edd/<change>/checks/` | proofs that each package's checks work | no |
| `.genesis/edd/<change>/runs/` | run records and before/after comparisons, each with its code as a commit plus `code.patch` | no |
| `.genesis/edd/<change>/loop.json`, `loop-start.patch` | the running loop: its Spec, baseline, budget and starting code, with what the starting commit does not hold | no |
| `.genesis/edd/<change>/reports/` | one report per full run of the implementation loop | yes |
| `.genesis/edd/<change>/accepted.json` | the user's acceptance of a passing run, with earlier ones | yes |
| `.dockerignore` | a `.genesis` line, which the agent adds when a package builds from the project root, so expected results stay out of the image | yes |
| `.agents/skills/<skill>/`, `.claude/skills/<skill>/` | the four Genesis EDD skills, installed from a checkout by `init` | no |

The paths marked no belong to this machine. A fresh clone has no package
proofs, no runs, the baseline among them, and no loop: prove the packages there
with `eval check` before running them.

Do not ignore `openspec/` or all of `.genesis/` in your `.gitignore`: the
files marked yes would stay out of Git, and Genesis EDD warns when they do. To
keep other output under `.genesis/` out of Git, ignore `.genesis/*` and add
`!.genesis/edd/` after it, or ignore only `.genesis/out/`.

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
