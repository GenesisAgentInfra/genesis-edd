// Loop tests: a baseline recorded again after a package changed, and the plan,
// agent and model it takes.
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, loopStatus } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, AGENT, CHANGE, LIVE_DEPENDENCY, confirmChecks, connect, editChecks, readRecord, readyProject, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, codes, blockedWith, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, gapOf, finalsLoop, passingScreen, newProjectLoop,
  refusedBeforeRun, assertEnded, startLoop, assertGapShape, assertNoRoutes,
} from './helpers/loop.js';

const evalAction = (status, command) => status.actions.find((entry) => entry.command[0] === 'eval' && entry.command[1] === command);

test('before a loop, a baseline recorded again after a package changed reads the number the user confirmed, and the revision confirmed then lets the loop start on it', (t) => {
  const project = readyProject(t, { live: [FAILURE] });
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.deepEqual(codes(error.gaps), ['baseline_packages_differ', 'checks_unconfirmed']);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.is_baseline, again.run_plan.attempts, again.run_plan.source], [true, 3, 'baseline']);
  assert.deepEqual([again.loop_baseline.usable, again.confirmation_current], [true, false]);
  assert.ok(again.warnings.includes(`This baseline takes 3 attempts of each package with a live dependency, agent ${AGENT} and model none from the plan the user last confirmed for this Spec export. The user's checks confirmation does not cover the packages as they are, so the baseline records them as its own.`), JSON.stringify(again.warnings));
  const confirmed = confirmChecks(project, { reason: 'The verifier of the failure case was fixed.' });
  assert.equal(confirmed.confirmation.confirmed.kind, 'revision');
  // The baseline ran these packages with this plan on this code: the loop starts on it once the user agrees.
  assert.deepEqual([confirmed.baseline.recorded, confirmed.baseline.kept], [again.run_id, true]);
  assert.deepEqual(confirmed.new_loop_needs, { baseline: false, user_consent: true });
  assert.deepEqual(confirmed.suggestion.command, ['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('a baseline that skipped a package waiting for eval check is no baseline a loop starts on, and says which package and why', (t) => {
  const project = readyProject(t, { live: [FAILURE] });
  const { repo, root } = project;
  appendFileSync(path.join(root, 'evals', SUCCESS, 'tests/test.sh'), '# a fix to the verifier\n');
  confirmChecks(project, { reason: 'The verifier of the success case was fixed.' });
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(base.skipped.map((entry) => [entry.case, entry.missing]), [[SUCCESS, ['check']]]);
  assert.deepEqual(base.loop_baseline, { usable: false, reasons: ['skipped_unproved'] });
  assert.ok(base.warnings.includes(`${SUCCESS} changed since its last \`eval check\`, so this baseline skips it, and a loop does not start on it.`), JSON.stringify(base.warnings));
  assert.equal(base.suggestion, null);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_packages_differ')(error);
    assertGapShape(gapOf(error, 'baseline_packages_differ'), { owner: 'agent', layer: 'baseline', unchecked: [SUCCESS] });
    return true;
  });
});

test('a package that no longer validates ends the loop with the file that changed, and eval check is neither offered for it nor runs it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editChecks(repo, FAILURE, (declared) => { delete declared.dependencies; });
  const invalid = validateEval(repo, CHANGE).gaps.find((entry) => entry.code === 'case_invalid');
  assertGapShape(invalid, { owner: 'agent', layer: 'package', case: FAILURE });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual(status.ended.files, [`${FAILURE}/tests/checks.json`]);
  assert.deepEqual(status.ended.packages, [FAILURE]);
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
  const work = workflowStatus(repo, CHANGE);
  assert.ok(work.gaps.some((entry) => entry.code === 'case_invalid' && entry.case === FAILURE), JSON.stringify(work.gaps));
  assert.deepEqual(work.layers.packages.waiting_for_check, []);
  assert.equal(evalAction(work, 'check'), undefined);
  assert.ok(evalAction(work, 'confirm').blocked_by.includes('case_invalid'), JSON.stringify(evalAction(work, 'confirm')));
  // eval check goes package by package: it skips the invalid one, runs nothing for it, and proves nothing of it.
  const calls = project.tools.runs().length;
  const checked = checkEval(repo, CHANGE);
  const skipped = checked.skipped.find((entry) => entry.case === FAILURE);
  assert.equal(skipped?.reason, 'invalid', JSON.stringify(checked.skipped));
  assert.deepEqual(codes(skipped.gaps), ['case_invalid']);
  assert.ok(!checked.proved.includes(FAILURE), JSON.stringify(checked.proved));
  assert.equal(project.tools.runs().length, calls);
});

test('in a new project, a confirmation before the packages are connected says so, and the plan changed after an unavailable baseline needs it recorded again', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  const first = confirmChecks(project, { tier: 'full' });
  assert.deepEqual([first.connect_first, first.unconnected, first.baseline.recorded], [true, [FAILURE, SUCCESS], null]);
  assert.deepEqual(first.new_loop_needs, { baseline: true, user_consent: true });
  assert.equal(first.suggestion, null);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.is_baseline, base.loop_baseline.usable], [false, true]);
  const revised = confirmChecks(project, { model: 'synthetic/m9', reason: 'The user chose a model.' });
  assert.deepEqual([revised.baseline.recorded, revised.baseline.kept, revised.baseline.unavailable], [base.run_id, false, 'no_implementation']);
  assert.deepEqual(revised.suggestion.command, ['run', 'start', CHANGE, '--baseline', '--unavailable', 'no_implementation', '--repo', repo]);
  const work = workflowStatus(repo, CHANGE);
  const differs = work.layers.baseline.gaps.find((entry) => entry.code === 'baseline_plan_differs');
  assertGapShape(differs, { owner: 'agent', layer: 'baseline', run: base.run_id, differs: ['model'] });
  const unavailable = work.actions.find((entry) => entry.command[0] === 'run' && entry.command.includes('--unavailable'));
  assert.deepEqual(unavailable.command.slice(-3), ['--baseline', '--unavailable', 'no_implementation']);
  assert.deepEqual([unavailable.allowed, unavailable.needed], [true, true], JSON.stringify(unavailable));
});

test('on a baseline that records that nothing could run, loop start refuses a live package until the user decides the number of attempts', (t) => {
  const fresh = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  confirmChecks(fresh, { tier: 'full' });
  const base = startRun(fresh.repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  for (const id of [FAILURE, SUCCESS]) connect(fresh.repo, id);
  editChecks(fresh.repo, FAILURE, (declared) => { declared.dependencies = [LIVE_DEPENDENCY]; });
  assert.equal(checkEval(fresh.repo, CHANGE).passed, true);
  assert.throws(() => startLoop(fresh.repo, CHANGE), (error) => {
    const undecided = assertGapShape(gapOf(error, 'attempts_undecided'), { owner: 'user', layer: 'confirmation', run: base.run_id, cases: [FAILURE], confirmed_attempts: null });
    assert.ok(undecided.message.endsWith('That number is the user\'s decision, and no checks confirmation records it yet.'), undecided.message);
    assert.doesNotMatch(undecided.message, /`run start/);
    return true;
  });
});

test('in a new project loop, connecting the packages ends the loop as expected, with the gates of a new loop, and a head run is refused', (t) => {
  const project = newProjectLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'The first implementation');
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.connecting], [[FAILURE, SUCCESS], true]);
  assert.ok(status.ended.message.includes('it started on a baseline recorded as unavailable, and connecting the packages ends it as expected'), status.ended.message);
  assert.doesNotMatch(status.ended.message, /What follows/);
  assert.deepEqual(status.ended.new_loop.consents, ['new_loop', 'checks_confirmation']);
  const gates = Object.fromEntries(status.ended.new_loop.gates.map((entry) => [entry.gate, entry.holds]));
  assert.deepEqual(gates, { checks_confirmation: false, baseline_on_start_code: true, user_consent: false });
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'packages_changed');
  // What a new loop needs is visible in workflow status: eval check proves the
  // connected packages, and the user confirms them.
  const work = workflowStatus(repo, CHANGE);
  assert.deepEqual(evalAction(work, 'check').cases, [FAILURE, SUCCESS]);
  assert.deepEqual([evalAction(work, 'confirm').by, evalAction(work, 'confirm').needed], ['user', true]);
});

test('a baseline recorded again after a package changed takes the agent and the model the user confirmed, and those of harness.json once it changed', (t) => {
  const project = readyProject(t, { live: [FAILURE], model: 'synthetic/m1', confirm: false });
  const { repo, root } = project;
  confirmChecks(project, { attempts: 3, model: 'synthetic/m2' });
  assert.equal(startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) }).run_plan.model, 'synthetic/m2');
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.run_plan.attempts, again.run_plan.model, again.run_plan.source], [3, 'synthetic/m2', 'baseline']);
  assert.equal(readRecord(again).run.environment_ref.model, 'synthetic/m2');
  assert.ok(again.warnings.includes(`This baseline takes 3 attempts of each package with a live dependency, agent ${AGENT} and model synthetic/m2 from the plan the user last confirmed for this Spec export. The user's checks confirmation does not cover the packages as they are, so the baseline records them as its own.`), JSON.stringify(again.warnings));
  assert.equal(confirmChecks(project, { reason: 'The verifier of the failure case was fixed.' }).confirmation.run_plan.model, 'synthetic/m2');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);

  // Once harness.json names another model, the baseline and the revision both take it.
  const other = readyProject(t, { live: [FAILURE], model: 'synthetic/m1', confirm: false });
  confirmChecks(other, { attempts: 3, model: 'synthetic/m2' });
  startRun(other.repo, CHANGE, { baseline: true, expect: writeExpectations(other.repo, EXPECT) });
  writeFileSync(path.join(other.repo, '.genesis/edd/harness/harness.json'), `${JSON.stringify({ agent: AGENT, model: 'synthetic/m3' }, null, 2)}\n`);
  assert.equal(checkEval(other.repo, CHANGE).passed, true);
  const moved = startRun(other.repo, CHANGE, { baseline: true, expect: writeExpectations(other.repo, EXPECT) });
  assert.deepEqual([moved.run_plan.attempts, moved.run_plan.model], [3, 'synthetic/m3']);
  assert.equal(confirmChecks(other, { reason: 'The kit names another model.' }).confirmation.run_plan.model, 'synthetic/m3');
  assert.equal(startLoop(other.repo, CHANGE).loop.baseline, moved.run_id);
});

test('inside a loop, a package set to draft ends the loop, and the draft is the user\'s decision, which no run can go around', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  completeReport(repo, fullRun(repo).run_id);
  editChecks(repo, SUCCESS, (declared) => { declared.status = 'draft'; });
  const draft = validateEval(repo, CHANGE).gaps.find((entry) => entry.code === 'case_draft');
  assertGapShape(draft, { owner: 'user', case: SUCCESS });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual(status.ended.packages, [SUCCESS]);
  assert.doesNotMatch(status.ended.message, /agent-spec|write-eval/);
  const work = workflowStatus(repo, CHANGE);
  assert.ok(work.gaps.some((entry) => entry.code === 'case_draft' && entry.owner === 'user' && entry.case === SUCCESS), JSON.stringify(work.gaps));
  assertNoRoutes(work.gaps, 'gaps');
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    const refusal = error.gaps.find((entry) => entry.code === 'case_draft');
    assertGapShape(refusal, { owner: 'user', case: SUCCESS });
    return true;
  });
});

test('inside a loop, workflow status says a change to a package or the kit ends the loop', (t) => {
  const project = inLoop(t);
  const work = workflowStatus(project.repo, CHANGE);
  assert.equal(work.layers.packages.editing_ends_loop, true);
  assert.equal(work.layers.loop.phase, 'live');
  // A confirmation of the same plan and packages does not end it.
  const confirm = evalAction(work, 'confirm');
  assert.equal(confirm.effect, null);
  assert.ok(confirm.needs.includes('a confirmation with another plan or tier ends the running loop'), JSON.stringify(confirm.needs));
});

test('a passing full run recorded before runs had a role, with other attempts than the plan, is a screen run whose final run is due, and acceptance says what its pass rests on', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project, AFTER, 'Stop the success notice when a submission fails', { review: false });
  // As an older CLI recorded it: no role, two attempts of the live package.
  const file = path.join(project.runs, screen.run_id, 'run.json');
  const { role, ...rest } = readJSON(file);
  assert.equal(role, 'screen');
  writeFileSync(file, `${JSON.stringify({ ...rest, environment_ref: { ...rest.environment_ref, attempts: 2, attempts_by_case: { ...rest.environment_ref.attempts_by_case, [FAILURE]: 2 } } }, null, 2)}\n`);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((run) => run.role), ['screen']);
  assert.deepEqual([status.situation.code, status.situation.candidate, status.final.pending], ['final_run_due', screen.run_id, true], JSON.stringify(status.situation));
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    assert.ok(gapOf(error, 'not_final').message.startsWith(`${screen.run_id} is a screen run: its pass rests on 2 attempts of each package that a final run runs 3 times.`), error.message);
    return true;
  });
});
