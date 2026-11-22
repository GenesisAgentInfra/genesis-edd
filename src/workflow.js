import { changeDirectory } from './project.js';
import { frozenSpec } from './spec.js';
import { validateEval } from './eval.js';
import { activeLoop, pinnedBase, recordedBaseline, runTools } from './run.js';
import { hasLoop, loopAcceptance, loopInputs } from './loop.js';

const stages = ['spec-export', 'write-eval', 'run-eval', 'loop-and-implement'];

// Checks are read-only. The calling agent resolves gaps and retries this same
// request; readiness is always derived from artifacts, never a saved status flag.
export function checkWorkflow(repo, stage, name) {
  if (!stages.includes(stage)) throw new Error(`Unknown stage: ${stage}. Expected ${stages.join(', ')}.`);
  changeDirectory(repo, name);
  const gaps = [];
  let inputsReady;
  let validation;
  let handoff;
  let evals;
  let accepted = null;
  if (stage === 'spec-export' || stage === 'write-eval') {
    const spec = frozenSpec(repo, name, { exported: stage === 'write-eval' });
    validation = spec.validation;
    gaps.push(...spec.gaps);
    if (spec.handoff) handoff = { id: spec.handoff.id, file: spec.handoff.file };
    inputsReady = gaps.length === 0;
  } else if (stage === 'run-eval') {
    evals = validateEval(repo, name);
    // Packages still waiting for a connection are skipped by a run, not a blocker.
    gaps.push(...evals.gaps.filter((gap) => gap.code !== 'integration_pending'));
    // Once the user has accepted a run of the loop for this Spec, nothing is
    // left to run, so neither the tools nor a runnable package are needed.
    accepted = evals.spec ? loopAcceptance(repo, name, evals.spec) : null;
    if (!accepted) {
      if (!gaps.length && !evals.ready_for_run) {
        gaps.push({ code: 'no_runnable_case', kind: 'artifact', owner: 'agent', route: 'write-eval',
          message: 'No package is ready to run. `eval validate` lists what each one still needs and `eval check` proves a finished one; a project without an implementation records an unavailable baseline instead.' });
      }
      // While a loop runs, head runs need the baseline it pinned.
      const loop = evals.spec ? activeLoop(repo, name, evals.spec) : null;
      const pinned = loop ? pinnedBase(repo, name, loop).gap : null;
      if (pinned) gaps.push(pinned);
      if (!gaps.length) gaps.push(...runTools().gaps);
    }
    inputsReady = gaps.length === 0;
  } else if (stage === 'loop-and-implement') {
    const inputs = loopInputs(repo, name);
    evals = inputs.evals;
    gaps.push(...inputs.gaps);
    if (!gaps.length) gaps.push(...runTools().gaps);
    inputsReady = gaps.length === 0;
  }
  const inputGap = gaps.find((gap) => gap.owner === 'agent') ?? gaps[0];
  const proceed = {
    'spec-export': { action: 'export_spec', command: ['spec', 'export', name, '--repo', repo] },
    'write-eval': { action: 'write_eval', command: ['eval', 'new', name, '--repo', repo] },
    // The first run of a Spec export is its baseline; a head run would be
    // refused. A running loop has pinned its baseline already. Once the user
    // has accepted a run of that loop, another run adds nothing.
    'run-eval': accepted
      ? { action: 'loop_done', command: ['loop', 'status', name, '--repo', repo],
        note: `The user accepted run ${accepted.run_id}; the loop for this Spec is finished. \`loop status\` says what is left, such as a commit.` }
      : evals?.spec && !activeLoop(repo, name, evals.spec) && !recordedBaseline(repo, name, evals.spec)
        ? { action: 'record_baseline', command: ['run', 'start', name, '--repo', repo, '--baseline'],
          note: 'Add --expect FILE with the expected baseline result of each check, or --unavailable no_implementation when nothing can run yet.' }
        : { action: 'run_eval', command: ['run', 'start', name, '--repo', repo] },
    'loop-and-implement': evals?.spec && hasLoop(repo, name, evals.spec)
      ? { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo] }
      : { action: 'start_loop', command: ['loop', 'start', name, '--repo', repo],
        note: 'Agree the budget with the user first: --max-iterations and --max-minutes.' },
  }[stage];
  const next = inputGap
    ? { owner: inputGap.owner, route: inputGap.route, action: inputGap.owner === 'user' ? 'resolve_business_decisions' : 'repair_inputs' }
    : { owner: 'agent', route: stage, ...proceed };
  return {
    version: 1, stage, change: name, inputs_ready: inputsReady,
    status: inputsReady ? 'ready' : 'blocked',
    gaps, warnings: validation?.warnings ?? evals?.warnings ?? [], next,
    resume: { stage, change: name, command: ['workflow', 'check', stage, name, '--repo', repo] },
    ...(validation ? { validation: { valid: validation.valid, ready_for_eval_design: validation.ready_for_eval_design,
      errors: validation.errors, blockers: validation.blockers, openspec: validation.openspec,
      openspec_advisory_issues: validation.openspec_advisory_issues } } : {}),
    ...(handoff ? { handoff } : {}),
    ...(evals ? { evals: { valid: evals.valid, business_ready: evals.business_ready, ready_for_run: evals.ready_for_run,
      cases: evals.cases.map(({ id, status, integration }) => ({ id, status, integration })) } } : {}),
  };
}
