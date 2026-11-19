import { parseArgs } from 'node:util';
import { initProject, projectRoot } from './project.js';
import { exportSpec, newSpec, specInstructions, specStatus, validateSpec } from './spec.js';
import { checkWorkflow } from './workflow.js';

const help = `Genesis EDD 0.1.0 — requirements for evaluation-driven development

genesis-edd init --repo PATH --mode new|existing [--agent codex|claude|both|none]
genesis-edd spec new NAME --repo PATH [--mode new|existing] [--map PATH]
genesis-edd spec instructions NAME --repo PATH
genesis-edd spec status NAME --repo PATH
genesis-edd spec validate NAME --repo PATH
genesis-edd spec export NAME --repo PATH
genesis-edd workflow check STAGE NAME --repo PATH

All commands return JSON. init defaults to --agent both. Spec content is authored
by your coding agent using the installed agent-spec skill, not by a CLI model.
validate exits 1 for malformed specs; valid drafts report ready_for_eval_design=false.
It rejects more explicit requirements than their quoted source states.
export requires a valid spec with no proposed requirements or open questions and
returns a review of each requirement beside the words and outcomes it rests on.
workflow check is read-only and returns gaps, repair routes and a resume command.
Stages: spec-export, write-eval, run-eval, loop-and-implement. Only spec-export
executes in this release. write-eval checks its frozen Spec input; later stages
report inputs_ready=null because their input checks are not implemented.
Blocked or unavailable workflow checks exit 1. No stage is executed by a check.

Planned modules: prepare, write-eval, run-eval, loop-and-implement.
They are not implemented by this release. Genesis Map is a separate tool.
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
      process.exitCode = 1;
      return checkWorkflow(projectRoot(values.repo), command, action);
    }
    throw new Error(`${command} is planned and not implemented in v0.1.`);
  }
  const init = command === 'init';
  if (!init && (command !== 'spec' || !['new', 'instructions', 'status', 'validate', 'export'].includes(action) || !name || name.startsWith('-'))) {
    throw new Error('Unknown command. Run genesis-edd --help.');
  }
  const options = { repo: { type: 'string', default: '.' } };
  if (init || action === 'new') options.mode = { type: 'string' };
  if (init) options.agent = { type: 'string', default: 'both' };
  if (action === 'new') options.map = { type: 'string' };
  const { values } = parseArgs({ args: argv.slice(init ? 1 : 3), options, strict: true, allowPositionals: false });
  const repo = projectRoot(values.repo);
  if (init) return initProject(repo, values.mode, values.agent);
  if (action === 'new') return newSpec(repo, name, values);
  if (action === 'instructions') return specInstructions(repo, name);
  if (action === 'status') return specStatus(repo, name);
  if (action === 'export') return exportSpec(repo, name);
  const result = validateSpec(repo, name);
  if (!result.valid) process.exitCode = 1;
  const { specs, ...summary } = result;
  return { ...summary, specs: specs.map(({ content, ...spec }) => spec) };
}
