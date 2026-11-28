// Loop tests: what ends a loop. A fixed input that changes (the Spec export,
// the packages and the kit, the user's confirmation, the baseline) and every
// stop end it. An ended loop states the facts of its end and what a new loop
// needs; run start and loop accept refuse it, and the change stays locked
// until the user agrees to a new loop or abandons the change.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, budgetLoop, loopStatus, writeReport } from '../src/loop.js';
import { reviewEval } from '../src/confirm.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, CONSENT, actionOf, allowedActions, assertGapShape, assertNoRoutes, confirmChecks, readyProject, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, inLoop, changeCode, fullRun, FAILURE, SUCCESS, assertStopBudget, changePackage, exportRevision, liveLoop, passingScreen, refusedBeforeRun, assertEnded,
  refusedWith, restoreStart, reviewRun, startLoop, withBaseline,
} from './helpers/loop.js';

// A head run refused before anything runs because the change is locked: its
// latest loop ended (for reason) without the user's acceptance. The lock is
// the user's to lift. Returns the gap.
function lockedBeforeRun(project, options, reason) {
  const refusal = refusedBeforeRun(project, options, 'change_locked');
  assertGapShape(refusal, { code: 'change_locked', owner: 'user', layer: 'loop', reason });
  assert.equal(refusal.loop.started_at, project.loop.started_at, JSON.stringify(refusal));
  return refusal;
}

// The full head run of the loop's plan, as `workflow status` lists it: no flag
// besides --repo.
const headRunAction = (flow) => flow.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && !entry.command.some((word) => word.startsWith('--') && word !== '--repo'));

test('a new export ends the loop and does not lift the lock on the change: run start and loop accept refuse it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const exported = exportRevision(project);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.deepEqual([status.ended.spec, status.ended.loop_spec, status.ended.accepted, status.accepted], [exported.id, project.loop.spec, false, false]);
  assertGapShape(status.gates.head_run, { code: 'loop_ended', reason: 'spec_exported', owner: 'user', layer: 'spec' });
  // The end states what changed and what a new loop needs; the user sees it.
  assert.deepEqual(status.ended.code_files, ['app/handler.txt', 'app/results.json']);
  assert.deepEqual(status.ended.new_loop.consents, ['new_loop', 'checks_confirmation']);
  assert.deepEqual(Object.keys(status.must_show), ['end', 'usage', 'budget']);
  assert.equal(status.must_show.end[0].reason, 'spec_exported');
  // The lock is on the change, not on the export: a head run of the new export is refused too.
  lockedBeforeRun(project, {}, 'spec_exported');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT }), refusedWith('loop_ended'));
});

test('a package change ends the loop and names the file, and putting the file back lifts the end', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  const kept = readFileSync(file, 'utf8');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assertGapShape(status.gates.head_run, { code: 'loop_ended', reason: 'packages_changed', owner: 'agent', layer: 'package' });
  // Going on needs the user's confirmation of the packages as they are: a gate of a new loop, not a recipe.
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
  const confirmation = status.ended.new_loop.gates.find((entry) => entry.gate === 'checks_confirmation');
  assert.deepEqual([confirmation.holds, confirmation.packages], [false, [SUCCESS]], JSON.stringify(confirmation));
  assertNoRoutes(status.ended, 'ended');
  // The agent may still prove and review the packages.
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.ok(reviewEval(repo, CHANGE).must_decide.some((entry) => entry.code === 'changed_since_confirmation'));
  lockedBeforeRun(project, {}, 'packages_changed');
  // The end is worked out from the files, not kept: with the file back the loop is live again.
  writeFileSync(file, kept);
  const back = loopStatus(repo, CHANGE);
  assert.deepEqual([back.ended, back.phase, back.gates.head_run], [null, 'live', null]);
  assert.equal(back.situation.code, 'open', JSON.stringify(back.situation));
  // The proof of the package is of the changed file, so a run would skip it until eval check proves it as it is.
  assert.deepEqual(back.situation.unchecked, [SUCCESS]);
  assert.deepEqual(back.suggestion.command, ['eval', 'check', CHANGE, '--repo', repo]);
});

test('a newer confirmation ends the loop only when its plan or packages differ: a new budget does not', (t) => {
  const project = liveLoop(t, 3);
  const { repo } = project;
  const before = loopStatus(repo, CHANGE).situation;
  const budget = confirmChecks(project, { iterations: 7, reason: 'The user gives more runs.' });
  assert.deepEqual([budget.loop.phase, budget.loop.ended], ['live', false]);
  const kept = loopStatus(repo, CHANGE);
  assert.equal(kept.ended, null);
  assert.deepEqual(kept.situation, before);
  // A confirmed budget is for the next loop; this one keeps its own.
  assert.deepEqual(kept.loop.budget, project.loop.budget);
  const confirmed = confirmChecks(project, { attempts: 5, reason: 'The user wants 5 attempts.' });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'confirmation_changed');
  assert.deepEqual([status.ended.confirmation, status.ended.plan, status.ended.packages], [confirmed.confirmation.id, ['attempts'], []]);
  assert.equal(status.ended.at, confirmed.confirmation.confirmed.at);
  assertGapShape(status.gates.head_run, { code: 'loop_ended', reason: 'confirmation_changed', owner: 'user', layer: 'confirmation' });
  // The message names both plans.
  assert.match(status.ended.message, new RegExp(`it confirms 5 attempts, agent ${AGENT}, model none where the loop runs 3 attempts, agent ${AGENT}, model none`));
  lockedBeforeRun(project, {}, 'confirmation_changed');
});

test('a missing baseline ends the loop, and run start refuses it before Harbor', (t) => {
  const project = inLoop(t);
  rmSync(project.base.directory, { recursive: true, force: true });
  const status = loopStatus(project.repo, CHANGE);
  assertEnded(status, 'baseline_missing');
  assert.equal(status.ended.baseline, project.base.run_id);
  assertGapShape(status.gates.head_run, { code: 'loop_ended', reason: 'baseline_missing', owner: 'agent', layer: 'baseline' });
  assert.deepEqual(status.ended.new_loop.consents, ['new_loop']);
  lockedBeforeRun(project, {}, 'baseline_missing');
});

test('in a loop, a plan flag of another value is refused before anything runs, and the plan\'s own value is taken', (t) => {
  const project = liveLoop(t, 3);
  const { repo, tools } = project;
  for (const [options, key] of [[{ attempts: 5 }, 'attempts'], [{ agent: 'other_agent:OtherAgent' }, 'agent'], [{ model: 'synthetic/m1' }, 'model'], [{ case: [FAILURE], attempts: 1 }, 'attempts']]) {
    const refusal = refusedBeforeRun(project, options, 'run_plan_fixed');
    assertGapShape(refusal, { code: 'run_plan_fixed', owner: 'agent', layer: 'loop' });
    assert.deepEqual(refusal.differs.map((entry) => entry.key), [key], JSON.stringify(refusal.differs));
    assert.deepEqual(refusal.plan, { attempts: 3, agent: AGENT, model: null, tier: 'full' });
  }
  // The plan's own values change nothing: the run is the loop's screen run.
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const calls = tools.runs().length;
  const run = startRun(repo, CHANGE, { attempts: 3, agent: AGENT });
  assert.deepEqual([run.execution_status, run.role, run.attempts], ['completed', 'screen', { [FAILURE]: 1, [SUCCESS]: 1 }]);
  assert.equal(tools.runs().length, calls + 2);
});

test('when the final run, estimated from the loop\'s own runs, does not fit the minutes left, the loop stops on budget until the user revises it', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  project.loop = startLoop(repo, CHANGE, { iterations: 5, minutes: 0.01 }).loop;
  const screen = passingScreen(project, AFTER, 'Stop the success notice when a submission fails', { review: false });
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'final_run_does_not_fit');
  assert.equal(status.loop.exhausted, false);
  assert.equal(status.stop.code, 'stop_budget');
  // The facts of the stop: the screen run, the final run's plan and its estimate against what is left.
  assert.equal(status.ended.screen_run, screen.run_id);
  assert.deepEqual(status.ended.final_plan, { packages: [FAILURE], attempts: 3, others_once: [SUCCESS] });
  assert.equal(status.ended.estimate.basis, 'loop_attempts');
  assert.equal(status.loop.estimate.basis, 'loop_attempts');
  assert.ok(status.ended.estimate.minutes > status.loop.estimate.remaining.minutes, JSON.stringify([status.ended.estimate, status.loop.estimate.remaining]));
  lockedBeforeRun(project, {}, 'stop_budget');
  // A code change does not lift it.
  changeCode(repo, AFTER, 'Another change after the stop');
  assertStopBudget(loopStatus(repo, CHANGE), 'final_run_does_not_fit');
  // The user's revised budget, recorded with who decided and where, lets the loop go on.
  assert.throws(() => budgetLoop(repo, CHANGE, { minutes: 600 }), /--by and --ref/);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const revised = budgetLoop(repo, CHANGE, { minutes: 600, ...CONSENT });
  assert.deepEqual([revised.resumed, revised.phase, revised.revision.by, revised.revision.ref], [true, 'live', CONSENT.by, CONSENT.ref]);
  const going = loopStatus(repo, CHANGE);
  assert.deepEqual([going.phase, going.situation.code, going.situation.candidate], ['live', 'final_run_due', screen.run_id], JSON.stringify(going.situation));
});

test('a final run that does not fit stops the loop with or without a final review and a report of its screen run, and no head run follows', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  project.loop = startLoop(repo, CHANGE, { iterations: 5, minutes: 0.01 }).loop;
  // No final review is waited for: the stop comes as soon as the screen run passed.
  const screen = passingScreen(project, AFTER, 'Stop the success notice when a submission fails', { review: false });
  assertStopBudget(loopStatus(repo, CHANGE), 'final_run_does_not_fit');
  // Nor does its report matter.
  rmSync(path.join(root, 'reports', `${screen.run_id}.md`));
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'final_run_does_not_fit');
  assert.equal(status.runs.find((entry) => entry.run_id === screen.run_id).report, 'missing');
  // No head run follows, partial ones included, so none can lower the estimate.
  lockedBeforeRun(project, { case: [FAILURE, SUCCESS] }, 'stop_budget');
  lockedBeforeRun(project, {}, 'stop_budget');
  // A loop that ended takes no final review either.
  assert.throws(() => reviewRun(project, screen.run_id), refusedWith('stop_budget'));
  // The report can be written again, and changes nothing.
  writeReport(repo, CHANGE, { run: screen.run_id });
  assertStopBudget(loopStatus(repo, CHANGE), 'final_run_does_not_fit');
  lockedBeforeRun(project, {}, 'stop_budget');
});

test('the final run is estimated from the loop\'s full runs only, so quick partial runs do not make it fit', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 30 });
  // Two partial runs whose attempts take no time, then a screen run whose attempts take 10 minutes each.
  const quick = (seconds) => ({ [FAILURE]: { c1: 'pass', $seconds: seconds }, [SUCCESS]: { c1: 'pass', c2: 'pass', $seconds: seconds } });
  changeCode(repo, quick(0), 'A quick look');
  for (let i = 0; i < 2; i += 1) assert.equal(startRun(repo, CHANGE, { case: [FAILURE, SUCCESS] }).scope, 'partial');
  passingScreen(project, quick(600), 'A slower change', { review: false });
  const status = loopStatus(repo, CHANGE);
  // 3 attempts of FAILURE and 1 of SUCCESS at 10 minutes each: 40 minutes, more than the 30 left.
  assertStopBudget(status, 'final_run_does_not_fit');
  assert.deepEqual([status.ended.estimate.minutes, status.ended.estimate.basis], [40, 'loop_attempts']);
  assert.equal(status.partial_runs, 2);
});

test('the same failure on different code is a warning: the loop goes on, and another run is made', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  fullRun(repo);
  changeCode(repo, BEFORE, 'second attempt');
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assert.ok(status.warnings.includes(`stuck: the same gating checks failed in the last two runs on different code: ${FAILURE}/c1=fail.`), JSON.stringify(status.warnings));
  assert.deepEqual([status.phase, status.ended, status.stop, status.gates.head_run], ['live', null, null, null]);
  assert.deepEqual(status.situation.open, [`${FAILURE}/c1=fail`]);
  changeCode(repo, AFTER, 'third attempt');
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('when the user\'s confirmation asks to stop on it, a stuck loop stays stopped once the code changes, and run start refuses it', (t) => {
  const project = withBaseline(t);
  const { repo } = project;
  const confirmed = confirmChecks(project, { stopOnStuck: true, reason: 'The user wants the loop to stop when it is stuck.' });
  assert.equal(confirmed.stop_on_stuck, true);
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.stop_on_stuck, true);
  project.loop = loop;
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  changeCode(repo, BEFORE, 'second attempt');
  const second = fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_stuck');
  assert.deepEqual([status.ended.runs, status.ended.failing], [[second.run_id, first.run_id], [`${FAILURE}/c1=fail`]]);
  assertGapShape(status.gates.head_run, { code: 'stop_stuck', owner: 'user', layer: 'code' });
  changeCode(repo, AFTER, 'third attempt');
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_stuck');
  lockedBeforeRun(project, {}, 'stop_stuck');
});

test('with the budget used up, a passing run can still be reviewed and accepted, and no further head run is made until then', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.loop.exhausted, status.ended], ['closing', true, null]);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', run.run_id]);
  assertGapShape(status.gates.head_run, { code: 'stop_budget', reason: 'budget_used_up', owner: 'user', layer: 'loop' });
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'budget'), JSON.stringify(status.obligations));
  refusedBeforeRun(project, {}, 'stop_budget');
  // What is left: the final review, then the user's acceptance.
  assert.deepEqual(status.suggestion.command.slice(0, 2), ['loop', 'review']);
  reviewRun(project, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assert.deepEqual(status.suggestion.command.slice(0, 2), ['loop', 'accept']);
  acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  // Once the user accepted the loop, head runs go on.
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
  assert.equal(startRun(repo, CHANGE, { case: [FAILURE] }).execution_status, 'completed');
});

test('every full run of a loop writes its report, and an ended loop asks for none: a missing report gates nothing', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, BEFORE, 'A first try');
  const run = fullRun(repo);
  assert.equal(run.report.created, true);
  assert.equal(run.report.file, path.join(root, 'reports', `${run.run_id}.md`));
  // The failing attempts show a fault in a package: the agent fixes it.
  changePackage(project, SUCCESS);
  let status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.equal(status.runs.find((entry) => entry.run_id === run.run_id).report, 'written');
  rmSync(run.report.file);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.equal(status.runs.find((entry) => entry.run_id === run.run_id).report, 'missing');
  assert.doesNotMatch(status.ended.message, /report/);
  // It can be written again from the records.
  const written = writeReport(repo, CHANGE, { run: run.run_id });
  assert.deepEqual([written.created, written.written], [true, ['Result', 'Changes']]);
  assert.match(readFileSync(written.file, 'utf8'), new RegExp(`^# ${CHANGE}: run ${run.run_id}$`, 'm'));
});

test('an ended loop gives the facts and every action allowed now, each with whose decision it is, not a single next step', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, base } = project;
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assertNoRoutes(status, 'loop status');
  assert.deepEqual(Object.keys(status.must_show), ['end', 'usage', 'budget']);
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'budget or new loop'), JSON.stringify(status.obligations));
  // workflow status, by its old name with a stage it ignores.
  const flow = checkWorkflow(repo, 'write-eval', CHANGE);
  assert.equal(flow.stage_ignored, 'write-eval');
  assertNoRoutes(flow, 'workflow status');
  assert.equal(flow.layers.loop.phase, 'ended');
  const allowed = allowedActions(flow);
  for (const entry of ['loop start --by --ref', 'loop budget --max-iterations --by --ref', 'change abandon --by --ref --reason', 'run start --baseline --at-start']) {
    assert.ok(allowed.includes(entry), `${entry} in ${JSON.stringify(allowed)}`);
  }
  for (const words of [['loop', 'start'], ['loop', 'budget'], ['change', 'abandon']]) assert.equal(actionOf(flow, ...words).by, 'user', words.join(' '));
  // A head run waits for the user's decision.
  const head = headRunAction(flow);
  assert.deepEqual([head.allowed, head.blocked_by], [false, ['change_locked']]);
  assert.equal(flow.must_show.change_lock[0].reason, 'stop_budget');
  // A base record goes on the start code, with the confirmed plan; it says the loop has ended.
  restoreStart(project);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, model: 'synthetic/m1' }), refusedWith('run_plan_differs'));
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(again.loop, { started_at: project.loop.started_at, baseline: base.run_id, ended: true });
  // eval review says the loop has ended and the change is locked.
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual([review.loop.phase, review.loop.ends_if_plan_or_packages_differ], ['ended', false]);
  assertGapShape(review.change_lock, { code: 'change_locked', owner: 'user', layer: 'loop', reason: 'stop_budget' });
});
