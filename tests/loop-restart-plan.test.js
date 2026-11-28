// Loop tests: the end of a loop when its plan or packages change, revisions, and the model and agent
// every named run start carries.
import assert from 'node:assert/strict';
import { appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, loopStatus } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { reviewEval } from '../src/confirm.js';
import { AFTER, BEFORE, CHANGE, APPROVAL, confirmChecks, readyProject, setResults, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, codes, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, loopRecord, finalsLoop,
  refusedBeforeRun, assertEnded, reviewRun, startLoop, assertGapShape, assertNoRoutes,
} from './helpers/loop.js';

const confirmAction = (status) => status.actions.find((entry) => entry.command[0] === 'eval' && entry.command[1] === 'confirm');

test('loop accept gives not_final only for a screen run that passed: a failing run is refused as not passing alone', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  const failing = fullRun(repo);
  assert.deepEqual([failing.role, failing.verdict], ['screen', 'fail']);
  completeReport(repo, failing.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: failing.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    assert.ok(codes(error.gaps).includes('not_passing'), error.message);
    assert.ok(!codes(error.gaps).includes('not_final'), error.message);
    return true;
  });
});

test('in a new project, the first loop says no package is connected yet, and that connecting the packages ends the loop', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project, { tier: 'full', attempts: 3 });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'live');
  const { situation } = status;
  assert.deepEqual([situation.code, situation.no_package_connected, situation.pending_packages], ['open', true, [FAILURE, SUCCESS]], JSON.stringify(situation));
  assert.ok(situation.message.startsWith('No package is connected yet, so a run has nothing to run; connecting the packages changes them, which ends this loop.'), situation.message);
  assertNoRoutes(situation, 'situation');
  // A head run has nothing to run until a package is connected.
  refusedBeforeRun(project, {}, 'no_runnable_case');
});

test('loop status and workflow status suggest no head run while no package is connected, since run start refuses it', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project, { tier: 'full', attempts: 3 });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.no_package_connected, true);
  // A suggestion is never an action the CLI lists as refused.
  const work = workflowStatus(repo, CHANGE);
  const suggested = work.actions.find((entry) => JSON.stringify(entry.command) === JSON.stringify(work.suggestion?.command));
  assert.ok(!suggested || suggested.allowed, JSON.stringify({ suggestion: work.suggestion, blocked_by: suggested?.blocked_by }));
  assert.notDeepEqual(status.suggestion?.command?.slice(0, 2), ['run', 'start'], JSON.stringify(status.suggestion));
});

test('after the user accepted the loop, a package change no longer ends it: loop status only warns', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  assert.equal(workflowStatus(repo, CHANGE).layers.packages.editing_ends_loop, true);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(workflowStatus(repo, CHANGE).layers.packages.editing_ends_loop, false);
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done', JSON.stringify(status.situation));
  assert.equal(status.ended, null);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`The eval packages changed after the accepted run ${run.run_id}: ${FAILURE}. The acceptance stays as it was given.`)), JSON.stringify(status.warnings));
});

test('outside a loop, a package changed since the confirmation is a revision the user confirms, with an optional reason', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true);
  const work = workflowStatus(repo, CHANGE);
  assert.deepEqual([work.layers.confirmation.current, work.layers.confirmation.changed_since], [false, [FAILURE]]);
  const unconfirmed = work.layers.confirmation.gaps.find((entry) => entry.code === 'checks_unconfirmed');
  assertGapShape(unconfirmed, { owner: 'user', layer: 'confirmation', cases: [FAILURE], files: [`${FAILURE}/tests/test.sh`] });
  const confirm = confirmAction(work);
  assert.deepEqual([confirm.by, confirm.allowed, confirm.needed], ['user', true, true], JSON.stringify(confirm));
  // A baseline recorded now runs, but takes the plan as its own: the user has not confirmed these packages.
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.confirmation_current, false);
  assert.ok(again.warnings.includes(unconfirmed.message), JSON.stringify(again.warnings));
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual([review.confirm.owner, review.confirm.revision, review.confirm.reason], ['user', true, 'optional']);
  assert.deepEqual(review.confirm.needs, ['--by', '--ref', '--verdicts']);
  assert.ok(review.must_decide.some((item) => item.code === 'changed_since_confirmation' && item.package === FAILURE), JSON.stringify(review.must_decide));
  const confirmed = confirmChecks(project, { reason: 'The verifier of the failure case was fixed.' }).confirmation.confirmed;
  assert.deepEqual([confirmed.kind, confirmed.reason], ['revision', 'The verifier of the failure case was fixed.']);
  // The reason is optional.
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# another fix\n');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.equal(confirmChecks(project).confirmation.confirmed.kind, 'revision');
});

test('while the loop\'s baseline is missing from runs/, the loop has ended for the agent to restore, and restoring it lifts the end', (t) => {
  const project = readyProject(t, { model: 'synthetic/m1' });
  const { repo, root } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  const folder = path.join(root, 'runs', base.run_id);
  const away = path.join(root, 'away');
  renameSync(folder, away);
  const missing = loopStatus(repo, CHANGE);
  assertEnded(missing, 'baseline_missing');
  assertGapShape(missing.gates.head_run, { owner: 'agent', layer: 'baseline' });
  const { start_code: start } = loopRecord(project);
  assert.deepEqual([missing.ended.baseline, missing.ended.start_code], [base.run_id, { commit: start.commit, digest: start.digest, patch: null, uncommitted_files: [] }]);
  assert.equal(missing.ended.message, `The loop's baseline ${base.run_id} is no longer in runs/, so this loop has ended.`);
  setResults(repo, AFTER);
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'baseline_missing');
  renameSync(away, folder);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.ended, null);
  assert.equal(status.phase, 'live');
  assert.equal(status.situation.code, 'open', JSON.stringify(status.situation));
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
});

test('in a new project, eval review warns that N is not known while no package declares its dependencies, and eval confirm without --attempts warns', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {}, check: false });
  const { repo } = project;
  const later = 'No package declares its dependencies yet, since none is connected, so whether a scenario calls a model is not known. Declaring a live dependency later changes the package: a running loop ends, and the number of attempts is the user\'s decision before a new one.';
  const review = reviewEval(repo, CHANGE);
  assert.equal(review.run_plan.attempts_needed, false);
  assert.ok(review.warnings.includes(later), JSON.stringify(review.warnings));
  const confirmed = confirmChecks(project, { tier: 'full' });
  assert.equal(confirmed.confirmation.run_plan.attempts, null);
  assert.ok(confirmed.warnings.includes(`This confirmation fixes no number of attempts. ${later}`), JSON.stringify(confirmed.warnings));
  // Once the user fixes N, neither warns.
  const fixed = confirmChecks(project, { tier: 'full', attempts: 3, reason: 'The user chose 3 attempts.' });
  assert.equal(fixed.confirmation.run_plan.attempts, 3);
  assert.ok(!fixed.warnings.some((warning) => warning.includes(later)), JSON.stringify(fixed.warnings));
  assert.ok(!reviewEval(repo, CHANGE).warnings.includes(later));
});

test('a baseline given plan flags before the user confirmed is a decision eval review puts to the user, with its plan', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const flagAgent = 'flag_agent:FlagAgent';
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT), agent: flagAgent });
  assert.deepEqual([base.run_plan.agent, base.run_plan.source, base.confirmation_current], [flagAgent, 'baseline', false]);
  const item = reviewEval(repo, CHANGE).must_decide.find((entry) => entry.code === 'baseline_plan_recorded');
  assert.deepEqual([item?.baseline, item?.keys], [base.run_id, ['agent']], JSON.stringify(item));
  assert.ok(item.message.includes(`The baseline ${base.run_id} ran with`) && item.message.includes(`agent ${flagAgent}`), item.message);
  assert.ok(item.message.endsWith('The user decides which one runs.'), item.message);
  const work = workflowStatus(repo, CHANGE);
  assert.ok(work.layers.confirmation.review.must_decide.includes('baseline_plan_recorded'), JSON.stringify(work.layers.confirmation.review));
  assert.ok(work.must_show.must_decide.some((entry) => entry.code === 'baseline_plan_recorded'), JSON.stringify(Object.keys(work.must_show)));
  // Confirmed with that agent, in the full tier where an agent can be given, the loop starts on that baseline.
  confirmChecks(project, { tier: 'full', agent: flagAgent });
  assert.ok(!reviewEval(repo, CHANGE).must_decide.some((entry) => entry.code === 'baseline_plan_recorded'));
  assert.equal(startLoop(repo, CHANGE).loop.baseline, base.run_id);
});

test('before any confirmation, a baseline of a model-calling change is refused until the user decides the number of attempts, whatever --attempts says', (t) => {
  for (const options of [{ live: [FAILURE] }, { model: 'synthetic/m1' }]) {
    const project = readyProject(t, { ...options, confirm: false });
    const { repo } = project;
    const refusal = refusedBeforeRun(project, { baseline: true, expect: writeExpectations(repo, EXPECT), attempts: 3, ...APPROVAL }, 'attempts_undecided');
    assertGapShape(refusal, { owner: 'user', layer: 'confirmation' });
    // The user's confirmation of N settles it.
    confirmChecks(project, { attempts: 3 });
    const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
    assert.deepEqual([base.is_baseline, base.run_plan.attempts, base.run_plan.source], [true, 3, 'confirmation'], JSON.stringify(options));
  }
});
