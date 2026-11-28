# Genesis EDD: an open-source framework for eval-driven development of software products

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
with `uv tool install harbor==0.27.0`. For the implementation loop, work in a Git repository.
Continue in the same session.

```text
Write the evals for the agreed spec and check them against known outcomes.
Run them on the current code to record a baseline. Then implement the fix
and run the same evals again. Stop after five runs and show me what changed.
```

A reviewer in a fresh context writes counterexamples the checks must reject.
Before the implementation loop starts, the agent shows you what Genesis EDD
lists for your decision: each outcome line with its checks and the reviewer's
verdict, the expected results before the change, the tier and why, the number
of attempts and the budget. Your confirmation is recorded with your name and
where you gave it. Read the before-and-after results in
`.genesis/edd/<change>/reports/`. During this evaluation-driven development
(EDD) loop, the spec, checks, baseline and confirmed plan stay fixed. If one
of them changes, the loop ends, says why and hands back to your coding agent,
which chooses how to go on. You decide whether to accept the change.

## How it works

| Skill | What it gives you |
| --- | --- |
| [agent-spec](skills/agent-spec/SKILL.md) | An OpenSpec feature spec with the source of each requirement, acceptance scenarios and a validated export. |
| [write-eval](skills/write-eval/SKILL.md) | One Harbor task per scenario, sealed from the network unless it declares a live dependency. The tasks share a project harness. Each verifier is checked by a probe in which nothing happens; in the full tier, a check that asserts absence, or belongs to a package with a live dependency, is also checked with the scenario run and its evidence missing. A reviewer writes counterexamples the checks must reject. |
| [run-eval](skills/run-eval/SKILL.md) | Your confirmation of the checks and the run plan, a baseline, trial runs, and a check-by-check comparison with the changed code. A pass outside a loop is a comparison, never an acceptance. The record distinguishes a failed expectation from an eval that could not run. A package with a live dependency, such as a model call, runs the number of attempts you confirm, and a check passes only when every attempt passes. |
| [loop-and-implement](skills/loop-and-implement/SKILL.md) | An implementation, or a verdict on code already written, with a report for each full run and a recorded final review. A failure on the same code always counts, the budget stops the loop, and with more than one attempt only a passing final run can be accepted. A stop holds, except a stop on budget, which more budget from you lifts. A new loop needs your go-ahead. |

Each skill does its own part and works on its own; your coding agent chooses
the order. Every command reports facts: what each part of the change holds,
what is missing, in which layer and whose decision it is, and the actions
allowed now. `workflow status` shows all of it at once.

The loop records the Git revision and local changes for each run. You control
commits and acceptance. Genesis uses your coding agent for reasoning and does
not require a separate Genesis service or model key.

## Your decisions

Genesis EDD refuses to go on without your decision at these points, and
records who decided and where you said so (`--by`, `--ref`):

- confirming the checks and the run plan: the tier, the number of attempts,
  the model and the budget, and whether a judge check, which runs your
  project's own judging program, decides its line or only informs
  (`eval confirm`, `--judge-gating`), and whether a check the reviewer found
  weaker or stronger than its line is good enough (`--accept-verdict`);
- paying for a run that calls a model before any confirmation
  (`run start --approved-by`);
- starting a loop, which your confirmation can include (`--start-loop`), and
  a budget above the confirmed one (`loop start`, `loop budget`);
- ruling on a check the agent disputes during a loop (`loop dispute`);
- accepting a passing run, declining it, or abandoning the change
  (`loop accept`, `loop decline`, `change abandon`).

Host environment variables reach an eval only when you agree
(`--yes` or `--allow-env NAME`). After a loop ends without your acceptance,
runs of the changed code are refused until you agree to a new loop or abandon
the change.

## Two tiers

Genesis EDD puts each change in one of two tiers, worked out from the eval
packages and the run records, and says why. Your coding agent does not choose
it. You can move any change to the full tier; a change that does not qualify
for the light tier cannot be confirmed in it.

| | Light tier | Full tier |
| --- | --- | --- |
| Fits | Code with fixed results: rules, amounts, permissions, helpers, or an agent app's logic tested against a scripted model | Prompts, model settings, and anything whose result depends on a model's reply |
| Needs | No live dependency, no model in the harness, every package sealed from the network, an adapter that imports no model SDK or HTTP client, and no run on this machine where the same package varied, called a model or was lost | Every package sealed or declaring its live dependency, a rule of both tiers |
| Runs | Each check once. A baseline that runs shows each line the change fixes failing before the change, and one confirmation can also start the loop | Packages with a live dependency run the number of attempts you confirm, and only a passing final run can be accepted |
| Proves the checks with | A probe in which nothing happens, the real failure before the change, and a reviewer's counterexample where that failure is missing | Fixtures with known outcomes, and a reviewer's counterexample for every outcome line |
| Acceptance shows | Sealed runs with no model calls, each check run once: code with fixed results holds in these scenarios | What the attempts of each check rule out, by a fixed formula |

A light change tests the code around a model, not the model's answers. If a
light run calls a model or a check passes and fails on the same code, the
loop ends, and the change goes on in the full tier or with that source of
variation replaced by a fixed stand-in.

## Setup options

### Docker and Harbor

You can write specs and task packages before setting up Docker. Checking the
verifiers (`eval check`), running evals and iterating on the results require
a running Docker daemon and Harbor. You can also run Harbor through `uvx` by setting
this environment variable in the shell where you launch your agent.

```sh
export GENESIS_EDD_HARBOR='["uvx","--from","harbor==0.27.0","harbor"]'
```

Harbor needs the Docker Compose plugin (`docker compose`). Genesis EDD is
checked with Harbor 0.27.0. Proving a package and running it each take a minute
or more per package, so a small change spends some minutes in Docker for each
run. Each run records its time, and the cost and tokens your agent adapter
reports, so the loop can tell whether the agreed budget fits. A budget counts
full runs and the minutes runs spend in Docker, plus an optional cost cap when
a package calls a model; time spent waiting for you does not count.

### Genesis Map

If you already use [Genesis Map](https://github.com/GenesisAgentInfra/genesis),
map your project before writing the spec. EDD saves a copy of the map with the
spec so a final change review can use the same business flows. The four EDD
skills also work on their own. A map from a Genesis change review covers only
the flows that review analyzed; the loop status, a final review from it and
the acceptance record say so.

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
Clone into a tools folder outside the project, or reuse an existing checkout;
the CLI refuses to judge a project that holds it:

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

To add your project's own instructions to a skill, write a `LOCAL.md` in its
installed folder. The skill reads it beside its own instructions, and `init`
never creates, changes or deletes it. It can add instructions; it cannot
override the skill's Rules. Like the rest of the folder, it stays out of Git
unless you change that folder's `.gitignore`.

`init` also creates `openspec/`. Each skill folder it installs holds a
`.gitignore` that keeps the folder out of Git, because it points at this
machine's checkout: everyone who clones the project runs `init` from their own
checkout. A `.gitignore` does not untrack files already committed; if an
earlier install's skill folders are in Git, `init` names them and the
`git rm -r --cached` command that takes them out.

</details>

## Commands

Your coding agent runs these through the installed skills, each of which
carries its own launcher, `scripts/run.mjs`. Every command prints JSON and
takes `--repo PATH`; `--help` lists every flag. The CLI refuses to judge a
project it is installed inside.

| Group | Commands | What they do |
| --- | --- | --- |
| Project | `init` | Installs the OpenSpec project files, the Spec schema and the skills. |
| Spec | `spec new`, `spec import`, `spec remap`, `spec instructions`, `spec status`, `spec validate`, `spec export` | Start a change, or adopt an existing OpenSpec change (`--adopt`); take a handoff written elsewhere; replace the Map before the first export; check the draft; export a content-addressed handoff of the accepted requirements, listing the ones left out. |
| Eval packages | `eval new`, `eval validate`, `eval rebind`, `eval sync`, `eval check` | Write one Harbor task per scenario, also against a Spec draft (`--draft`); check structure and coverage; bind packages whose scenario did not change to a new export; write the shared verifier code into packages; prove each package. |
| Confirmation | `eval review`, `eval confirm` | List what you decide on, and record your confirmation of the checks and the run plan. |
| Runs | `run start`, `run list`, `run show`, `run compare`, `run cleanup` | Record a baseline, a head run or a trial in local Docker; read and compare runs; remove the containers of one run. |
| Loop | `loop start`, `loop status`, `loop report`, `loop review`, `loop accept`, `loop decline`, `loop end`, `loop budget`, `loop dispute`, `loop tests`, `change abandon` | Start a loop and see where it stands; write a run's report; record the final review, your acceptance or refusal, an end, a budget, a disputed check and its ruling, and the project's own test results; abandon the change. |
| Status | `workflow status` | The facts of every layer of the change, every gap and every action allowed now (`workflow check` is the same). |

## What it writes in your project

| Path | Holds | In Git |
| --- | --- | --- |
| `openspec/` | specs, their exported versions, and any Genesis Map they were written against (`business-map.json`) | yes |
| `.genesis/edd/.gitignore` | keeps the package proofs, run records, loop state and decision log below out of Git; lines you add are kept | yes |
| `.genesis/edd/harness/` | the project kit shared by every eval package | yes |
| `.genesis/edd/<change>/evals/` | one Harbor task package per scenario | yes |
| `.genesis/edd/<change>/spec-drafts/` | the Spec drafts that packages written before an export (`eval new --draft`) were bound to | yes |
| `.genesis/edd/<change>/baseline-expectations.json` | the expected baseline result of each check, written by the agent before the baseline runs | yes |
| `.genesis/edd/<change>/review.json` | the reviewer's answers: a verdict on each outcome line, and on each package changed since your last confirmation | yes |
| `.genesis/edd/<change>/confirmed.json` | your confirmations of the checks and the run plan (tier, attempts, agent, model, budget), each with what you were shown and decided, who confirmed and where | yes |
| `.genesis/edd/<change>/checks/` | proofs that each package's checks work | no |
| `.genesis/edd/<change>/runs/` | run records and before/after comparisons, with every attempt of each package, each with its code as a commit plus `code.patch` and the digest of every eval package and kit file it ran, and `index.jsonl`, which lists every run when it starts and ends: a run whose folder is deleted still counts as a failure. The failures counted for the same code come from here, so they are per machine | no |
| `.genesis/edd/<change>/loop.json`, `loop-start.patch` | the current loop (its Spec, baseline, budget and its revisions, starting code with what the starting commit does not hold, final reviews, disputes and test records) and the earlier loops of the change, whose starting code and usage a new loop takes; do not delete it: only it keeps the budget and the earlier loops | no |
| `.genesis/edd/<change>/decisions.jsonl` | every recorded decision of the change, with who decided and where: starting, ending, declining and abandoning, budgets, reviews, disputes, test runs and cost approvals | no |
| `.genesis/edd/<change>/reports/` | one report per full run of the implementation loop: the results and changes from the records, and the agent's notes | yes |
| `.genesis/edd/<change>/accepted.json` | your acceptance of a passing run, with what it rests on and what you were shown, and earlier ones | yes |
| `.dockerignore` | a `.genesis` line, which the agent adds when a package builds from the project root, so expected results stay out of the image. The file decides what enters the image, so it counts as application code: added after `spec new`, it shows at confirmation as a code change before the baseline. Other lines in it are your call | yes |
| `.agents/skills/<skill>/`, `.claude/skills/<skill>/` | the four Genesis EDD skills, installed from a checkout by `init`, each with its own launcher, and your `LOCAL.md` if you add one | no |

The paths marked no belong to this machine. A fresh clone has no package
proofs, no runs, the baseline among them, and no loop: prove the packages there
with `eval check` before running them. On a clone, `accepted.json` is the
record of the acceptance, and re-proving the change there needs the start
commit for its baseline, for example in a worktree.

Do not ignore `openspec/` or all of `.genesis/` in your `.gitignore`: the
files marked yes would stay out of Git, and Genesis EDD warns when they do. To
keep other output under `.genesis/` out of Git, ignore `.genesis/*` and add
`!.genesis/edd/` after it, or ignore only `.genesis/out/`.

## Update

- **Claude Code:** run `/plugin marketplace update genesis-edd`, then start a
  new session. To update automatically, open `/plugin`, choose
  **Marketplaces**, select `genesis-edd` and enable auto-update. A plugin
  update arrives with a new plugin version.
- **Codex:** run `codex plugin marketplace upgrade genesis-edd`, then start a
  new session.
- **Checkout:** run `git pull` and `npm ci --ignore-scripts`, then run `init`
  again for each project. A shipped skill file you edited is left as it is
  and listed under `conflicts`, and a `LOCAL.md` is never touched; the
  launchers and their `runtime.json` are written again every time. Read its
  `warnings`: it names skill folders an earlier install committed.
- **Eval packages:** version 0.2.0 writes checks.json 1.1, which earlier
  versions of Genesis EDD reject, so update every checkout and plugin that
  works on a project. Packages in 1.0 keep working with a warning, but a loop
  does not start on them until they are upgraded. Version 0.2.0 also no
  longer restarts a loop or raises its budget in place: a loop that ends
  hands back to your coding agent, and `loop start` begins a new one, with
  the budget you give it.
- **Tiers and budgets:** version 0.3.0 writes records that earlier versions
  refuse: confirmations with a tier and a budget in run minutes, and
  light-tier packages without fixtures. Update every checkout and plugin
  that works on a project together. The rule that a package must be sealed
  or declare a live dependency applies to the full tier too: a package with
  only a Dockerfile and the `public` network that earlier versions of
  `eval new` wrote is refused at the next confirmation until it is sealed or
  declares one, while confirmations recorded before only warn. Budgets count
  run minutes, the time runs spend in Docker, instead of the minutes since
  the loop started; loops confirmed before keep their minutes. To record a
  baseline on a loop's starting code, `run start --baseline --at-start`
  rebuilds that code in a temporary folder, so you no longer set your
  changes aside by hand.
- **Decisions and status:** version 0.3.0 also records your decisions
  instead of assuming them, and reports facts instead of one next step.
  `loop start` needs your recorded consent (`--by`, `--ref`) unless your
  confirmation included `--start-loop`; a run that calls a model before any
  confirmation needs your approval (`--approved-by`, `--ref`); and
  `loop accept` needs a final review recorded with `loop review`, where it
  used to read the report's Review section. Results no longer carry `next`
  or a skill `route`: each gap names its layer and owner, and
  `workflow status` replaces the stage-by-stage `workflow check`, which now
  returns the same status. Every run is listed in `runs/index.jsonl`, and one
  whose folder is deleted counts as a failure. A loop that ended without your
  acceptance locks the change until you agree to a new loop or abandon the
  change, and a stuck loop only warns unless your confirmation asked it to
  stop.

## License

Apache-2.0. Built with OpenSpec; see [third-party notices](THIRD_PARTY_NOTICES.md).
