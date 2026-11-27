import { parseArgs } from 'node:util';
import { initProject, projectRoot } from './project.js';
import { exportSpec, newSpec, specInstructions, specStatus, validateSpec } from './spec.js';
import { newEval, validateEval } from './eval.js';
import { checkEval, startRun } from './run.js';
import { confirmEval, reviewEval } from './confirm.js';
import { acceptLoop, loopStatus, startLoop, writeReport } from './loop.js';
import { checkWorkflow } from './workflow.js';

const help = `Genesis EDD 0.2.0 — requirements and evals for evaluation-driven development

genesis-edd init --repo PATH --mode new|existing [--agent codex|claude|both|none]
genesis-edd spec new NAME --repo PATH [--mode new|existing] [--map PATH]
genesis-edd spec instructions NAME --repo PATH
genesis-edd spec status NAME --repo PATH
genesis-edd spec validate NAME --repo PATH
genesis-edd spec export NAME --repo PATH
genesis-edd eval new NAME --repo PATH
genesis-edd eval validate NAME --repo PATH
genesis-edd eval check NAME --repo PATH [--case ID] [--timeout MINUTES] [--yes]
genesis-edd eval review NAME --repo PATH
genesis-edd eval confirm NAME --repo PATH --verdicts FILE --by NAME --ref REF [--reason TEXT]
                         [--attempts N] [--agent NAME|module:Class] [--model MODEL]
                         [--max-iterations N] [--max-minutes M]
genesis-edd run start NAME --repo PATH [--baseline [--unavailable REASON] [--expect FILE]]
                           [--case ID]... [--attempts N] [--agent NAME|module:Class]
                           [--model MODEL] [--timeout MINUTES] [--yes]
genesis-edd loop start NAME --repo PATH [--max-iterations N] [--max-minutes M]
genesis-edd loop status NAME --repo PATH
genesis-edd loop report NAME --repo PATH [--run RUN_ID]
genesis-edd loop accept NAME --repo PATH --run RUN_ID --by NAME --ref REF
genesis-edd workflow check STAGE NAME --repo PATH

All commands return JSON. init defaults to --agent both. Specs, eval packages and
verifiers are authored by your coding agent using the installed skills, not by a
CLI model.
validate exits 1 for malformed specs; valid drafts report ready_for_eval_design=false.
It rejects more explicit requirements than their quoted source states.
It checks impact.md, when present, against the recorded Map and the project files.
spec new --map takes the business-map.json of a full Genesis map, not of a
change review (mode change, or change-report.json beside it), and copies it
into the change folder: commit it with the Spec. A Map without a mode is
recorded as unknown. freshness says whether every file the Map was read from
is unchanged at the current commit: verified, stale, or unverified when the
Map has no source, was read with uncommitted changes or left files out.
Genesis writes mode and source from commit 9c0c914 on; a Map without them is
accepted, with mode unknown and freshness unverified.
Once a Spec is exported, code that moves that evidence is a warning for later
stages; a new export needs evidence that matches the code.
export requires a valid spec with no proposed requirements or open questions and
returns a review of each requirement beside the words and outcomes it rests on.
The handoff carries structured requirements and impact for later stages.
eval new writes one Harbor task package per scenario of the exported Spec under
.genesis/edd/NAME/evals/, with one check per THEN or AND line (checks.json
1.1): its then names the line and its expect starts as the line's text. It
never rewrites what an existing package owns; it does bring the shipped helper
and the shared verifier code of the project kit (.genesis/edd/harness/) in line
in every package. eval validate is read-only: it checks structure and sources,
and that every THEN or AND line of a package's scenario has a gating check
whose then is that line, or is listed in scenario.manual for the user to judge
(then_uncovered blocks eval check and run start). It works out which packages
can run and what the others still need. checks.json 1.0 is read with a warning.
eval check runs each finished package's fixtures through Harbor with the real
verifier and records whether every fixture got the result it expects. A
package is ready only while that record matches the package and the kit.
Packages whose record still matches are skipped; --case proves one again. A
1.1 package is ready only when every line a program checks has a reviewer's
counterexample: a fixture with origin review or self-review that fails only
that line's gating checks.
eval review is read-only: it lists every THEN line of the packages with its
status, checks, fixtures, counterexamples and baseline expectation, the
decisions the user must make, ranked, the questions and the brief for a
reviewer, a template for the reviewer's answers and a proposed run plan.
eval confirm records the user's confirmation of the checks, with the
reviewer's verdict on each line and the run plan (attempts, agent, model,
budget), in .genesis/edd/NAME/confirmed.json; a line a program checks must be
faithful, and a scenario.manual line not_observable. A second confirmation of
the same Spec export is a revision and needs --reason. A baseline reads the
plan from it. A confirmation whose run plan or packages differ from those of
a running loop ends that loop (loop_ended, confirmation_changed); one with the
same plan and packages, such as a new budget, does not. loop start refuses
packages that differ from the latest confirmation, a baseline that ran another
plan, and, without --max-iterations or --max-minutes, a confirmed budget that
the estimate from earlier attempts shows cannot fit. loop accept refuses
packages that differ from the latest confirmation.
run start runs the ready packages with Harbor in local Docker and writes one
immutable record under .genesis/edd/NAME/runs/. --baseline records the code
before a change; --unavailable (no_implementation, execution_blocked or
incompatible_tasks) records why no baseline could run instead of inventing one.
Later runs are compared with that baseline check by check; while a loop runs,
with the loop's baseline. Until a loop of the change is accepted, a base
record is refused on code other than the start code of the change's first
unaccepted loop (baseline_after_change). A baseline warns when it skips a package
that waits only for eval check, and its next says to prove it and record the
baseline again. run start exits 1
when execution was blocked or failed; a failing business check is a result.
--case runs only the named packages: a quick look that never passes.
--attempts N is the user's number of attempts for each package that declares a
live dependency; every other package runs once, and a check passes only when
every attempt passes. Outside a loop, a baseline reads it, the agent and the
model from the user's confirmation of the checks (eval confirm) and refuses
other values (run_plan_differs). Without a confirmation, give it with
--baseline, which records it. Once a package changed after the confirmation,
a baseline without --attempts, --agent and --model takes the plan last
confirmed for this Spec export, with the agent and model of harness.json once
it changed since. Without any number, such a baseline is refused while a
package declares a live dependency, or while a model is set and a ready
package declares none. Later runs follow the baseline, and a partial run runs
each package once. Inside a loop, run start reads the plan of the loop's
checks confirmation and refuses --attempts, --agent and --model before
anything runs, on a base record too (run_plan_fixed); outside a loop other
settings warn. Each package's attempts are kept in <case>/attempts.json.
Every run records its time, and the cost and tokens the agent adapter
reports, per attempt in <case>/attempts.json and in total in run.json; eval
check records its time in check.json. loop status estimates a screen run and
the final run from earlier attempts, and loop start uses that estimate to
check the confirmed budget.
In a loop whose run plan runs a package with a live dependency more than
once, every full run of an iteration is a screen run, with one attempt of
each package. Once a screen run passes, its report is complete and the final
review is done, the next full run on the same code is the final run: packages
with a live dependency run the planned number of attempts, every other
package once, packages that failed before first, and it stops at the first
package that fails. Only a passing final run can be accepted. Final runs
count toward the budget. loop status says final_run; stop_unstable after two
failed final runs of the loop; stop_incomplete after two final runs with
missing evidence on the same code; and stop_budget (final_run_does_not_fit)
when the final run, estimated from the loop's own runs, does not fit what is
left of the budget.
Runs add up: a failure on the same code, package, agent and model always
counts, across every loop of the Spec export, and a later pass never cancels
it. The count reads runs/, which Git ignores, so it covers this machine only.
A pass or a failure counts only
from an attempt that completed: a check graded after the agent or the harness
raised, as on a rate limit, is unknown in that run's verdict and comparison,
for the stuck and regression comparisons and for an acceptance too. A failure
in another attempt of the run that completed still counts; a final run with
one counts as a failed final run. Every run records the digest of
each eval package and kit file it ran, and reads the code, the packages and
the kit again after each package, by content and by when each file was last
written; a run during which one changed, even when it was put back, neither
passes nor is a baseline. A head run records the loop it was made in; only
those runs are the loop's.
--yes lets Harbor read host environment variables a task asks for.
loop start fixes the Spec, the baseline, the starting commit, the packages and
the budget (default: the confirmed one, else 5 full runs, 60 minutes) for one
implementation loop. It needs a Git repository; nothing has to be committed,
because every run stores its code as the commit it started from plus
code.patch. It refuses a baseline with a baseline_mismatch, or one that ran
other eval packages than the current ones, a package that waits only for eval
check included, a base record whose run plan differs from the confirmed one,
one recorded with --unavailable included, packages still in checks.json 1.0
(then_unbound), and a change whose every THEN line is in scenario.manual,
which no run can pass (gating_missing). It refuses while a loop for the Spec
has not ended and can still make a head run (loop_running), and after its
loop was accepted (loop_accepted); once the budget is used up and only the
report, the final review or the acceptance is left, a new loop may start. After a loop ended or stopped, it starts a new one: until a
loop of the change is accepted, the new loop keeps the start code of the
change's first unaccepted loop, and its baseline must have run there
(baseline_not_at_start). It reports what the earlier loops used
(earlier_loops). After an accepted loop, the loop for a new export starts on
the code as it is and records the loop it follows. A baseline recorded with
--unavailable is refused once the code changed since it.
loop status is read-only: it follows every check through the loop's runs and
names the next step: iterate, write the report, split changes after a
regression, review, run the final run, run again after the code changed, or
ask the user to accept. Or it names a step that ends the loop: stop_stuck,
stop_budget, stop_unstable, stop_incomplete, stop_no_gating, or loop_ended
once a fixed input changed (spec_exported, baseline_missing,
confirmation_changed, packages_changed). A loop that ended or stopped stays
so when the code changes: run start refuses its head runs, and loop accept
refuses it. The budget is hard: run start refuses a head run once it is used
up, until the user's acceptance covers the loop (loop status says done).
After acceptance it reports done, and the minutes stop, while the code is
still the accepted run's and no later run fails. With a recorded Map, the review step
names the genesis map prepare arguments (--base, --entries-from) that start a
Genesis review from the Spec's Map (--entries-from needs Genesis 9c0c914 or
later).
loop report writes a run's report skeleton under
.genesis/edd/NAME/reports/ and never overwrites one. loop accept records the
user's acceptance of a passing run whose report is complete, for the code and
the eval packages that ran. It refuses a run whose code and packages had a
failing run of a gating check, and a screen run (not_final). An earlier
acceptance, of an earlier loop or one that no longer covers this loop, is
kept in the record under earlier.
workflow check is read-only and returns gaps, repair routes and a resume command.
Stages: spec-export, write-eval, run-eval, loop-and-implement. Blocked checks
exit 1. No stage is executed by a check.

Planned module: prepare. Genesis Map is a separate tool.
Harbor and Docker are separate tools that run-eval needs on this machine.
`;

export function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  if (argv.length === 1 && argv[0] === '--version') return { version: '0.2.0', openspec: '2.1.0' };
  const [command, action, name] = argv;
  if (command === 'workflow') {
    const change = argv[3];
    if (action !== 'check' || !name || !change || change.startsWith('-')) throw new Error('Use workflow check STAGE NAME --repo PATH.');
    const { values } = parseArgs({ args: argv.slice(4), options: { repo: { type: 'string', default: '.' } }, strict: true, allowPositionals: false });
    const result = checkWorkflow(projectRoot(values.repo), name, change);
    if (result.status !== 'ready') process.exitCode = 1;
    return result;
  }
  if (['prepare', 'write-eval', 'run-eval', 'loop-and-implement'].includes(command)) {
    if (command !== 'prepare' && action && !action.startsWith('-')) {
      const { values } = parseArgs({ args: argv.slice(2), options: { repo: { type: 'string', default: '.' } }, strict: true, allowPositionals: false });
      const result = checkWorkflow(projectRoot(values.repo), command, action);
      if (result.status !== 'ready') process.exitCode = 1;
      return result;
    }
    throw new Error(command === 'prepare'
      ? 'prepare is planned and not implemented in v0.1.'
      : `Use workflow check ${command} NAME --repo PATH, then the ${{ 'write-eval': 'eval', 'run-eval': 'run', 'loop-and-implement': 'loop' }[command]} commands.`);
  }
  const init = command === 'init';
  const actions = { spec: ['new', 'instructions', 'status', 'validate', 'export'], eval: ['new', 'validate', 'check', 'review', 'confirm'], run: ['start'],
    loop: ['start', 'status', 'report', 'accept'] }[command];
  if (!init && (!actions?.includes(action) || !name || name.startsWith('-'))) {
    throw new Error('Unknown command. Run genesis-edd --help.');
  }
  const options = { repo: { type: 'string', default: '.' } };
  if (init || (command === 'spec' && action === 'new')) options.mode = { type: 'string' };
  if (init) options.agent = { type: 'string', default: 'both' };
  if (command === 'spec' && action === 'new') options.map = { type: 'string' };
  if (command === 'eval' && action === 'check') {
    Object.assign(options, { case: { type: 'string' }, timeout: { type: 'string' }, yes: { type: 'boolean' } });
  }
  if (command === 'eval' && action === 'confirm') {
    Object.assign(options, { verdicts: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' }, reason: { type: 'string' },
      attempts: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' } });
  }
  if (command === 'run') {
    Object.assign(options, { baseline: { type: 'boolean' }, unavailable: { type: 'string' }, expect: { type: 'string' },
      case: { type: 'string', multiple: true }, attempts: { type: 'string' },
      agent: { type: 'string' }, model: { type: 'string' }, timeout: { type: 'string' }, yes: { type: 'boolean' } });
  }
  if (command === 'loop') {
    Object.assign(options, {
      start: { 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' } },
      status: {}, report: { run: { type: 'string' } },
      accept: { run: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    }[action]);
  }
  const { values } = parseArgs({ args: argv.slice(init ? 1 : 3), options, strict: true, allowPositionals: false });
  const repo = projectRoot(values.repo);
  if (init) return initProject(repo, values.mode, values.agent);
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(timeout > 0)) throw new Error('--timeout is a number of minutes.');
  const number = (value) => (value === undefined ? undefined : Number(value));
  if (command === 'eval') {
    if (action === 'new') return newEval(repo, name);
    // eval review only reads, so it exits 0; eval confirm exits 1 on a refusal.
    if (action === 'review') return reviewEval(repo, name);
    if (action === 'confirm') {
      return confirmEval(repo, name, { verdicts: values.verdicts, by: values.by, ref: values.ref, reason: values.reason, agent: values.agent, model: values.model,
        attempts: number(values.attempts), iterations: number(values['max-iterations']), minutes: number(values['max-minutes']) });
    }
    const result = action === 'check' ? checkEval(repo, name, { ...values, timeout }) : validateEval(repo, name);
    if (!(action === 'check' ? result.passed : result.valid)) process.exitCode = 1;
    return result;
  }
  if (command === 'loop') {
    if (action === 'start') return startLoop(repo, name, { iterations: number(values['max-iterations']), minutes: number(values['max-minutes']) });
    if (action === 'report') return writeReport(repo, name, values);
    if (action === 'accept') return acceptLoop(repo, name, values);
    return loopStatus(repo, name);
  }
  if (command === 'run') {
    const attempts = values.attempts === undefined ? undefined : Number(values.attempts);
    const result = startRun(repo, name, { ...values, timeout, attempts });
    if (!['completed', 'not_run'].includes(result.execution_status)) process.exitCode = 1;
    return result;
  }
  if (action === 'new') return newSpec(repo, name, values);
  if (action === 'instructions') return specInstructions(repo, name);
  if (action === 'status') return specStatus(repo, name);
  if (action === 'export') return exportSpec(repo, name);
  const result = validateSpec(repo, name);
  if (!result.valid) process.exitCode = 1;
  const { specs, ...summary } = result;
  return { ...summary, specs: specs.map(({ content, ...spec }) => spec) };
}
