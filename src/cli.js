import { parseArgs } from 'node:util';
import { initProject, projectRoot } from './project.js';
import { exportSpec, newSpec, specInstructions, specStatus, validateSpec } from './spec.js';
import { newEval, validateEval } from './eval.js';
import { checkEval, startRun } from './run.js';
import { acceptLoop, extendLoop, loopStatus, startLoop, writeReport } from './loop.js';
import { checkWorkflow } from './workflow.js';

const help = `Genesis EDD 0.1.0 — requirements and evals for evaluation-driven development

genesis-edd init --repo PATH --mode new|existing [--agent codex|claude|both|none]
genesis-edd spec new NAME --repo PATH [--mode new|existing] [--map PATH]
genesis-edd spec instructions NAME --repo PATH
genesis-edd spec status NAME --repo PATH
genesis-edd spec validate NAME --repo PATH
genesis-edd spec export NAME --repo PATH
genesis-edd eval new NAME --repo PATH
genesis-edd eval validate NAME --repo PATH
genesis-edd eval check NAME --repo PATH [--case ID] [--timeout MINUTES] [--yes]
genesis-edd run start NAME --repo PATH [--baseline [--unavailable REASON] [--expect FILE]]
                           [--case ID]... [--attempts N] [--agent NAME|module:Class]
                           [--model MODEL] [--timeout MINUTES] [--yes]
genesis-edd loop start NAME --repo PATH [--max-iterations N] [--max-minutes M] [--restart]
genesis-edd loop status NAME --repo PATH
genesis-edd loop extend NAME --repo PATH [--max-iterations N] [--max-minutes M]
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
.genesis/edd/NAME/evals/, with expected results copied from its THEN lines. It
never rewrites what an existing package owns; it does bring the shipped helper
and the shared verifier code of the project kit (.genesis/edd/harness/) in line
in every package. eval validate is read-only: it checks structure, sources and
coverage, and works out which packages can run and what the others still need.
eval check runs each finished package's fixtures through Harbor with the real
verifier and records whether every fixture got the result it expects. A
package is ready only while that record matches the package and the kit.
Packages whose record still matches are skipped; --case proves one again.
run start runs the ready packages with Harbor in local Docker and writes one
immutable record under .genesis/edd/NAME/runs/. --baseline records the code
before a change; --unavailable (no_implementation, execution_blocked or
incompatible_tasks) records why no baseline could run instead of inventing one.
Later runs are compared with that baseline check by check; while a loop runs,
with the loop's baseline, and a base record is refused on code other than the
loop's starting code. run start exits 1
when execution was blocked or failed; a failing business check is a result.
--case runs only the named packages: a quick look that never passes.
--attempts runs each package N times; a check fails if any attempt fails.
--yes lets Harbor read host environment variables a task asks for.
loop start fixes the Spec, the baseline, the starting commit, the packages and
the budget (default 5 full runs, 60 minutes) for one implementation loop. It
needs a Git repository; nothing has to be committed, because every run stores
its code as the commit it started from plus code.patch. It refuses a baseline
with a baseline_mismatch. loop status is read-only: it follows every check
through the loop's runs and names the next step: iterate, write the report,
split changes after a regression, stop when stuck or out of budget, review,
run again after the code changed, or ask the user to accept. After acceptance
it reports done, and the minutes stop, while the code is still the accepted
run's and no later run fails. With a recorded Map, the review step names the
genesis map prepare arguments (--base, --entries-from) that start a Genesis
review from the Spec's Map (--entries-from needs Genesis 9c0c914 or later).
loop extend raises the budget once the user agrees: N more full runs and M
minutes from now (default 5 and 60), keeping runs and the baseline.
loop start --restart starts the loop over, keeping its starting code; while a
loop runs, every base record must be on that code. loop report writes a
run's report skeleton under .genesis/edd/NAME/reports/ and never overwrites
one. loop accept records the user's acceptance of a passing run whose report
is complete, for the code that ran. An earlier acceptance, of an earlier loop or
one that no longer covers this loop, is kept in the record under earlier.
workflow check is read-only and returns gaps, repair routes and a resume command.
Stages: spec-export, write-eval, run-eval, loop-and-implement. Blocked checks
exit 1. No stage is executed by a check.

Planned module: prepare. Genesis Map is a separate tool.
Harbor and Docker are separate tools that run-eval needs on this machine.
`;

export function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  if (argv.length === 1 && argv[0] === '--version') return { version: '0.1.0', openspec: '2.1.0' };
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
  const actions = { spec: ['new', 'instructions', 'status', 'validate', 'export'], eval: ['new', 'validate', 'check'], run: ['start'],
    loop: ['start', 'status', 'extend', 'report', 'accept'] }[command];
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
  if (command === 'run') {
    Object.assign(options, { baseline: { type: 'boolean' }, unavailable: { type: 'string' }, expect: { type: 'string' },
      case: { type: 'string', multiple: true }, attempts: { type: 'string' },
      agent: { type: 'string' }, model: { type: 'string' }, timeout: { type: 'string' }, yes: { type: 'boolean' } });
  }
  if (command === 'loop') {
    Object.assign(options, {
      start: { 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' }, restart: { type: 'boolean' } },
      extend: { 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' } },
      status: {}, report: { run: { type: 'string' } },
      accept: { run: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    }[action]);
  }
  const { values } = parseArgs({ args: argv.slice(init ? 1 : 3), options, strict: true, allowPositionals: false });
  const repo = projectRoot(values.repo);
  if (init) return initProject(repo, values.mode, values.agent);
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(timeout > 0)) throw new Error('--timeout is a number of minutes.');
  if (command === 'eval') {
    if (action === 'new') return newEval(repo, name);
    const result = action === 'check' ? checkEval(repo, name, { ...values, timeout }) : validateEval(repo, name);
    if (!(action === 'check' ? result.passed : result.valid)) process.exitCode = 1;
    return result;
  }
  if (command === 'loop') {
    const number = (value) => (value === undefined ? undefined : Number(value));
    if (action === 'start') return startLoop(repo, name, { iterations: number(values['max-iterations']), minutes: number(values['max-minutes']), restart: values.restart });
    if (action === 'extend') return extendLoop(repo, name, { iterations: number(values['max-iterations']), minutes: number(values['max-minutes']) });
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
