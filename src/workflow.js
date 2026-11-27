import { existsSync } from 'node:fs';
import path from 'node:path';
import { changeDirectory, requireProject } from './project.js';
import { frozenSpec } from './spec.js';
import { checksConfirmation, eddDirectory, legacyPackages, manualLines, unnamedMessage, unnamedPackages, unpackagedScenarios, validateEval } from './eval.js';
import { recordedPlan } from './confirm.js';
import {
  activeLoop, codeSnapshot, noRunnableCase, pinnedStart, planNeeds, recordedBaseline, restoreHint, runTools, sameCode, undecidedLive,
} from './run.js';
import {
  baselinePackagesDiffer, baselinePlanDiffers, hasLoop, loopAcceptance, loopInputs, loopPhase, loopStatus, mismatchMessage, waitsForCheck,
} from './loop.js';

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
  let unpackaged = null;
  let unnamed = null;
  let baseline = null;
  let afterBaseline = null;
  let confirm = null;
  let prove = null;
  // Inside a loop: one whose head runs are refused while only its report, its
  // final review or the acceptance is left, and one that ended or stopped.
  let closing = false;
  let endedLoop = null;
  // A live loop with no package to run yet, as the first loop of a new project.
  let liveUnconnected = null;
  let endedNote = '';
  // Until a loop of this change is accepted, a new loop keeps the start code
  // of its first unaccepted loop.
  let pinned = null;
  let replaced = false;
  if (stage === 'spec-export' || stage === 'write-eval') {
    const spec = frozenSpec(repo, name, { exported: stage === 'write-eval' });
    validation = spec.validation;
    gaps.push(...spec.gaps);
    if (spec.handoff) handoff = { id: spec.handoff.id, file: spec.handoff.file };
    inputsReady = gaps.length === 0;
    if (stage === 'write-eval' && inputsReady) {
      unnamed = unnamedPackages(repo, name);
      unpackaged = unpackagedScenarios(repo, name, spec.handoff.handoff);
    }
  } else if (stage === 'run-eval') {
    evals = validateEval(repo, name);
    // Packages still waiting for a connection are skipped by a run, not a blocker.
    gaps.push(...evals.gaps.filter((gap) => gap.code !== 'integration_pending'));
    // Once the user has accepted a run of the loop for this Spec, nothing is
    // left to run, so neither the tools nor a runnable package are needed.
    accepted = evals.spec ? loopAcceptance(repo, name, evals.spec) : null;
    // The loop for this Spec, while it goes on. Once it ended or stopped, the
    // path is the one without a loop, but it never names a head run: a new
    // loop needs the user's go-ahead.
    const current = evals.spec ? activeLoop(repo, name, evals.spec) : null;
    const status = current && !accepted ? loopStatus(repo, name) : null;
    const phase = status ? loopPhase(status) : null;
    const loop = phase === 'live' ? current : null;
    closing = phase === 'closing';
    endedLoop = phase === 'ended' ? status : null;
    const recorded = evals.spec && !loop && !closing ? recordedBaseline(repo, name, evals.spec) : null;
    // After a loop ended, or a re-export mid-loop, the code before the change
    // is the start code of the change's first unaccepted loop: the baseline
    // goes there, whatever the code is now, and the changes come back before
    // `loop start`, which keeps that code.
    const unaccepted = evals.spec && !loop && !closing ? pinnedStart(repo, name) : null;
    pinned = unaccepted;
    // With a baseline and no loop yet, the loop starts next, before any code
    // changes: `loop start` refuses a baseline that ran on other code, as it
    // does when it cannot tell. Once the code has changed, only head runs
    // outside a loop are left.
    // A loop on a baseline that records that nothing could run, as the first
    // loop of a new project, starts before any package is connected:
    // \`loop status\` says what comes first.
    let unavailable = Boolean(loop) && status.loop.baseline_available === false;
    let moved = false;
    let offStart = false;
    let movedUnavailable = false;
    let staleUnavailable = false;
    // A loop does not start on packages in checks.json 1.0, and a baseline
    // recorded before they are upgraded compares nothing with them.
    const legacy = legacyPackages(evals);
    const upgrade = legacy.length ? `First upgrade ${legacy.join(', ')} to checks.json 1.1, as \`workflow check loop-and-implement\` says: a loop does not start on 1.0 packages, and a baseline recorded before the upgrade compares nothing with the upgraded ones. ` : '';
    // The lines no check verifies are the user's to judge at acceptance.
    const manual = manualLines(evals);
    const judged = manual.length ? ` No check verifies ${manual.map((row) => `"${row.then}" (${row.case})`).join(', ')}: the user judges ${manual.length === 1 ? 'it' : 'them'} at acceptance. Tell the user before the baseline.` : '';
    // A loop starts only on a baseline of the packages as they are now, and
    // one that fixed the number of attempts when a package declares a live
    // dependency.
    const differ = recorded?.is_baseline && !recorded.baseline_mismatch?.length ? baselinePackagesDiffer(recorded, evals.cases) : null;
    const readyCases = evals.cases.filter((item) => item.integration?.state === 'ready');
    const undecided = recorded && !recorded.baseline_mismatch?.length ? undecidedLive(recorded, readyCases) : [];
    endedNote = endedLoop ? ` The loop for this Spec ended (${endedLoop.ended?.reason ?? endedLoop.next.action}); start a new loop only once the user agrees.` : '';
    if (recorded && !recorded.baseline_mismatch?.length) {
      const snapshot = codeSnapshot(repo).snapshot;
      offStart = Boolean(unaccepted) && sameCode(recorded.code_snapshot, unaccepted.start, repo) !== true;
      moved = !unaccepted && recorded.is_baseline && snapshot.changed_files !== null && sameCode(recorded.code_snapshot, snapshot, repo) !== true;
      // A record that nothing could run says so of the code and the packages
      // it was recorded with: once either changed, it is recorded again.
      movedUnavailable = !unaccepted && !recorded.is_baseline && snapshot.changed_files !== null && sameCode(recorded.code_snapshot, snapshot, repo) === false;
      const digests = Object.fromEntries(evals.cases.map((item) => [item.id, item.task_digest]));
      staleUnavailable = !recorded.is_baseline && [...new Set([...Object.keys(recorded.task_digest ?? {}), ...Object.keys(digests)])]
        .some((id) => recorded.task_digest?.[id] !== digests[id]);
      unavailable = !recorded.is_baseline;
      afterBaseline = unaccepted
        ? { action: 'start_loop', route: 'loop-and-implement', command: ['loop', 'start', name, '--repo', repo],
          note: `${upgrade}${recorded.is_baseline ? `The baseline ${recorded.run_id} is recorded` : `That no baseline could run is recorded (${recorded.run_id})`} on the start code of the change's first unaccepted loop. Bring back any changes you set aside and, once the user agrees, run \`loop start\`: the new loop keeps that start code and takes the budget the user confirmed with the checks; pass --max-iterations and --max-minutes only for another budget the user agreed to.` }
        : moved
        ? { action: 'run_eval', command: ['run', 'start', name, '--repo', repo],
          note: `The code changed after the baseline ${recorded.run_id}, so a loop cannot start on it while the code differs; \`run start\` still compares a head run with it. To implement the change in a loop instead, \`workflow check loop-and-implement\` says how to get back to the baseline's code first.${differ ? ' The eval packages changed after it too; once the code is the baseline\'s again, record the baseline again before `loop start`.' : ''}` }
        : { action: 'start_loop', route: 'loop-and-implement', command: ['loop', 'start', name, '--repo', repo],
          note: `${upgrade}${recorded.is_baseline
            ? 'The baseline is recorded. Start the loop before changing any code: `loop start` takes the budget the user confirmed with the checks; pass --max-iterations and --max-minutes only for another budget the user agreed to. To change the code without a loop, change it, then run `run start`; a loop does not start on code other than the baseline\'s.'
            : 'That no baseline could run is recorded. Start the loop to implement the change: `loop start` takes the budget the user confirmed with the checks; pass --max-iterations and --max-minutes only for another budget the user agreed to.'}` };
    }
    // The user confirms the checks once, before the baseline: a loop starts
    // only on packages they confirmed.
    const confirmations = evals.spec ? checksConfirmation(repo, name, evals.spec) : null;
    const confirmed = confirmations?.current ?? null;
    // A new project has no implementation to run yet: the user confirms the
    // checks before its packages are connected, and its baseline records that
    // nothing could run.
    const nothingYet = Boolean(evals.spec) && !loop && !recorded && !evals.ready_for_run && requireProject(repo).mode === 'new';
    if (!accepted && !closing) {
      // After an unavailable baseline, as in a new project, connecting the
      // packages is part of the loop, which needs none to start.
      if (!gaps.length && !evals.ready_for_run && !unavailable && !nothingYet) {
        gaps.push(noRunnableCase(Boolean(loop)));
      }
      if (!gaps.length) gaps.push(...runTools().gaps);
    }
    inputsReady = gaps.length === 0;
    if (loop && !evals.ready_for_run && unavailable) liveUnconnected = status;
    // A loop starts only on a baseline that ran the plan the user confirmed.
    // One that records that nothing could run is compared by its plan, as
    // `loop start` compares it.
    const planDiffers = confirmed && recorded && !recorded.baseline_mismatch?.length
      ? baselinePlanDiffers(evals, recorded, confirmed, { undecided: undecided.length > 0 }) : null;
    if (evals.spec && !loop && !closing && !accepted && !confirmed) {
      // After a package changed since the user confirmed this export, their
      // new confirmation is a revision, with its reason. A baseline recorded
      // before it with a plan of its own is named, as eval review lists it.
      let own = null;
      try { own = recorded ? recordedPlan(repo, name) : null; } catch { /* eval review says why */ }
      const ownNote = own ? ` ${own.text}` : '';
      confirm = { action: 'confirm_checks', owner: 'user', route: 'run-eval', command: ['eval', 'review', name, '--repo', repo],
        note: confirmations?.latest
          ? `${upgrade}The eval packages changed since the user confirmed the checks of this Spec export, so they confirm them again before the next baseline, as a revision: run \`eval review\`, have the reviewer read the diff and answer into review.json, then show the user what changed, must_decide and the run plan in one message, and record their words with \`eval confirm --reason\`.${ownNote}${judged}`
          : `${upgrade}The user confirms the checks once, before the baseline: run \`eval review\`, have a reviewer write review.json, then show the user the line table, must_decide, the expected baseline results, the number of attempts, the model, the cost and the budget in one message, and record their words with \`eval confirm\`.${ownNote}${judged}` };
    }
    // A finished package that waits only for `eval check` is skipped by every
    // run, so it is proved first: a loop starts only on a baseline that ran it.
    const unchecked = evals.cases.filter(waitsForCheck).map((item) => item.id);
    if (unchecked.length && !accepted && !closing) {
      const one = unchecked.length === 1;
      prove = { action: 'check_evals', command: ['eval', 'check', name, '--repo', repo],
        note: `${unchecked.join(', ')} changed since ${one ? 'its' : 'their'} last \`eval check\`, and a run skips a package whose verifier is not proved for it as it is. Prove ${one ? 'it' : 'them'} with \`eval check\` before the next run${loop ? '' : ': a loop starts only on a baseline that ran every finished package'}.` };
    }
    // The first run of a Spec export is its baseline; a head run would be
    // refused. It is recorded again while the recorded one did not behave as
    // declared, or while it ran other packages than the current ones on the
    // code still the baseline's, since no loop starts on it. A running loop
    // has pinned its baseline already.
    if (evals.spec && !loop && !closing && (!recorded || recorded.baseline_mismatch?.length || offStart || movedUnavailable || staleUnavailable || ((differ || undecided.length || planDiffers) && !moved))) {
      // The expected baseline results kept beside the packages go with the
      // baseline command, so a baseline is never recorded without them by mistake.
      const expectations = path.join(eddDirectory(repo, name), 'baseline-expectations.json');
      const expect = existsSync(expectations) ? ['--expect', expectations] : [];
      const add = `Add --expect FILE with the expected baseline result of each check, kept as .genesis/edd/${name}/baseline-expectations.json`;
      // The baseline reads the number of attempts, the agent and the model from
      // the user's confirmation of the checks, which comes before it.
      const needs = planNeeds(evals.cases, readyCases, confirmed?.run_plan?.model ?? null);
      const attempts = needs.needed ? ' The baseline reads the number of attempts, the agent and the model the user confirmed from confirmed.json: pass none of them.' : '';
      const undecidedNote = `The baseline ${recorded?.run_id} fixed no number of attempts, so no loop can run ${undecided.join(', ')} on it: record it again.`;
      // A baseline that declared nothing could run is recorded again the same way.
      const declared = recorded && !recorded.is_baseline ? ['--unavailable', recorded.baseline_unavailable_reason ?? 'no_implementation']
        : nothingYet ? ['--unavailable', 'no_implementation'] : null;
      // After a re-export mid-loop, the baseline of the new export goes on the
      // starting code of the loop the user has not accepted.
      const restore = unaccepted && sameCode(codeSnapshot(repo).snapshot, unaccepted.start, repo) !== true
        ? ` Until a loop of this change is accepted, a new loop keeps the start code of the change's first unaccepted loop, ${restoreHint(name, unaccepted.loop, null)}: that is still the code before the change. Set your changes aside, restore that code, record this baseline there, bring your changes back, then run \`loop start\`.` : '';
      const elsewhere = `The baseline ${recorded?.run_id} ran on other code than the code before the change, so no loop starts on it: record it again.`;
      const movedNote = `The baseline ${recorded?.run_id} records that nothing could run on other code than the code now: record it again on the code the loop starts from.`;
      const staleNote = `The baseline ${recorded?.run_id} records that nothing could run with other eval packages than the ones now: record it again on the code the loop starts from.`;
      baseline = { action: 'record_baseline',
        command: ['run', 'start', name, '--repo', repo, '--baseline', ...(declared ?? expect)],
        note: `${upgrade}${recorded ? `${recorded.baseline_mismatch?.length ? mismatchMessage(recorded) : offStart ? elsewhere : movedUnavailable ? movedNote : differ ? differ.message : planDiffers ? planDiffers.message : undecided.length ? undecidedNote : staleNote}${expect.length || declared ? '' : ` ${add}.`}`
          : nothingYet ? 'No package can run yet in this new project, so the baseline records that nothing could run: --unavailable no_implementation. Connecting the packages is part of the loop.'
          : expect.length
            ? 'The expected baseline result of each check comes from baseline-expectations.json. When nothing can run yet, use --unavailable no_implementation instead of --expect.'
            : `${add}, or --unavailable no_implementation when nothing can run yet.`}${restore}${attempts}${judged}` };
    }
  } else if (stage === 'loop-and-implement') {
    const inputs = loopInputs(repo, name);
    evals = inputs.evals;
    // A loop whose baseline is gone, once a baseline is recorded again on its
    // start code, is read as the loop that ended: a new loop is next.
    replaced = Boolean(evals.spec && hasLoop(repo, name, evals.spec) && !inputs.loop);
    pinned = evals.spec && (!hasLoop(repo, name, evals.spec) || replaced) ? inputs.pin : null;
    gaps.push(...inputs.gaps);
    if (!gaps.length) gaps.push(...runTools().gaps);
    inputsReady = gaps.length === 0;
  }
  // A package or the kit changed while a loop runs ends it. Once the user
  // accepted the loop, a package changed since only warns.
  const loopOf = stage === 'write-eval' && handoff ? activeLoop(repo, name, handoff.id) : null;
  let loopNow = null;
  if (loopOf && !loopAcceptance(repo, name, handoff.id)) {
    try { loopNow = loopStatus(repo, name); } catch { /* read as a running loop */ }
  }
  const loopEnd = loopNow && loopPhase(loopNow) === 'ended' ? loopNow.ended?.reason ?? loopNow.next.action : null;
  const loopNote = !loopOf ? 'run-eval then asks the user to confirm.'
    : loopAcceptance(repo, name, handoff.id) ? 'the user accepted the loop for this Spec, so `loop status` only warns about a package changed since: tell the user what changed and why.'
      : loopEnd ? `the loop for this Spec has ended (${loopEnd}): a changed package or kit needs \`eval review\` and the user's \`eval confirm\`, then the baseline again on the loop's start code and a new loop once they agree.`
        : 'a loop runs for this Spec, and changing a package or the kit while it runs ends it (packages_changed): `eval review` and the user\'s `eval confirm`, then a new loop once they agree.';
  const inputGap = gaps.find((gap) => gap.owner === 'agent') ?? gaps[0];
  // A loop that ended or stopped gets no head run from workflow check, and
  // every step after it says that a new loop needs the user's go-ahead.
  const endedHeadRun = (step) => (!endedLoop ? step : step.action === 'run_eval'
    ? { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo], note: 'The loop for this Spec has ended or stopped: `loop status` says why. A new loop needs the user\'s go-ahead.' }
    : { ...step, note: `${step.note ?? ''}${endedNote}`.trim() });
  const proceed = {
    'spec-export': { action: 'export_spec', command: ['spec', 'export', name, '--repo', repo] },
    // Once every scenario has a package, `eval new` has nothing left to write.
    // While a folder under evals/ names no scenario, it writes nothing.
    'write-eval': unnamed?.length
      ? { action: 'finish_evals', command: ['eval', 'validate', name, '--repo', repo],
        note: `${unnamedMessage(unnamed).problem} ${unnamedMessage(unnamed).repair} \`eval new\` writes nothing until then.` }
      : unpackaged && !unpackaged.length
        ? { action: 'finish_evals', command: ['eval', 'validate', name, '--repo', repo],
          // Inside a loop, as when the packages of a new project are
          // connected, the change ends the loop.
          note: `Every scenario of this Spec has a package, so \`eval new\` has nothing to write. \`eval validate\` lists what each package still needs; \`eval check\` proves the finished ones. Run \`eval new\` again only after changing the kit's verifier/ folder. Once each package is missing only \`review\`, run \`eval review\`: a reviewer writes the counterexamples, \`eval check\` proves them, and the reviewer answers the questions of a second \`eval review\` into review.json; ${loopNote}` }
        : { action: 'write_eval', command: ['eval', 'new', name, '--repo', repo] },
    // Once the user has accepted a run of the loop, another run adds nothing.
    'run-eval': accepted
      ? { action: 'loop_done', command: ['loop', 'status', name, '--repo', repo],
        note: `The user accepted run ${accepted.run_id}; the loop for this Spec is finished. \`loop status\` says what is left, such as a commit.` }
      : closing ? { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo],
        note: '`loop status` names the step left in this loop: the report, the final review or the acceptance. No head run is left.' }
        : liveUnconnected ? { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo],
          note: `No package is connected yet, so \`run start\` has nothing to run: \`loop status\` says what comes first (${liveUnconnected.next.action}).` }
          : endedHeadRun(confirm ?? prove ?? baseline ?? afterBaseline ?? { action: 'run_eval', command: ['run', 'start', name, '--repo', repo] }),
    'loop-and-implement': evals?.spec && hasLoop(repo, name, evals.spec) && !replaced
      ? { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo] }
      : { action: 'start_loop', command: ['loop', 'start', name, '--repo', repo],
        note: `${replaced ? 'The loop for this Spec ended (baseline_missing), and a baseline is recorded again on its start code: start a new loop only once the user agrees. ' : ''}${pinned ? 'The new loop keeps the start code of the change\'s first unaccepted loop: bring back any changes you set aside first. ' : ''}The budget comes from confirmed.json. Ask the user again only when \`loop start\` says budget_unfit. In a loop whose packages vary, each iteration's full run is a screen run; the final run comes after the final review.` },
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
