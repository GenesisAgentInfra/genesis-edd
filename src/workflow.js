import { changeDirectory } from './project.js';
import { handoffStatus, specHandoff, validateSpec } from './spec.js';

const stages = ['spec-export', 'write-eval', 'run-eval', 'loop-and-implement'];

// Checks are read-only. The calling agent resolves gaps and retries this same
// request; readiness is always derived from artifacts, never a saved status flag.
export function checkWorkflow(repo, stage, name) {
  if (!stages.includes(stage)) throw new Error(`Unknown stage: ${stage}. Expected ${stages.join(', ')}.`);
  changeDirectory(repo, name);
  const implemented = stage === 'spec-export';
  const gaps = [];
  let inputsReady = null;
  let validation;
  let handoff;
  if (stage === 'spec-export' || stage === 'write-eval') {
    validation = validateSpec(repo, name);
    gaps.push(...validation.gaps);
    if (validation.ready_for_eval_design) {
      const expected = specHandoff(repo, name, validation);
      const status = handoffStatus(expected);
      if (status === 'invalid') {
        gaps.push({ code: 'handoff_invalid', kind: 'technical', owner: 'agent', route: 'spec-export', path: expected.file,
          message: 'Restore the original frozen handoff before retrying; do not overwrite it.' });
      } else if (stage === 'write-eval' && status === 'missing') {
        gaps.push({ code: 'handoff_missing', kind: 'artifact', owner: 'agent', route: 'spec-export',
          message: 'Export the current validated Spec. Older exports do not represent the current draft.' });
      } else if (status === 'valid') {
        handoff = { id: expected.id, file: expected.file };
      }
    }
    inputsReady = gaps.length === 0;
  }
  const inputGap = gaps.find((gap) => gap.owner === 'agent') ?? gaps[0];
  if (!implemented) {
    gaps.push({ code: 'stage_unavailable', kind: 'capability', owner: 'framework', route: null,
      message: `${stage} is planned and not implemented in v0.1. Missing implementation is not a user business question.` });
  }
  const next = inputGap
    ? { owner: inputGap.owner, route: inputGap.route, action: inputGap.owner === 'user' ? 'resolve_business_decisions' : 'repair_inputs' }
    : implemented
      ? { owner: 'agent', route: 'spec-export', action: 'export_spec', command: ['spec', 'export', name, '--repo', repo] }
      : { owner: 'framework', route: null, action: 'stage_unavailable' };
  return {
    version: 1, stage, change: name, implemented, inputs_ready: inputsReady,
    status: inputsReady === false ? 'blocked' : implemented ? 'ready' : 'unavailable',
    gaps, warnings: validation?.warnings ?? [], next,
    resume: { stage, change: name, command: ['workflow', 'check', stage, name, '--repo', repo] },
    ...(validation ? { validation: { valid: validation.valid, ready_for_eval_design: validation.ready_for_eval_design,
      errors: validation.errors, blockers: validation.blockers, openspec: validation.openspec } } : {}),
    ...(handoff ? { handoff } : {}),
  };
}
