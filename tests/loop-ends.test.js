// Loop tests: what ends a loop. A fixed input that changes (the Spec export,
// the packages and the kit, the user's confirmation, the baseline) and every
// stop end it; run start and loop accept then refuse it.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, startLoop } from '../src/loop.js';
import { reviewEval } from '../src/confirm.js';
import { checkWorkflow } from '../src/workflow.js';
import { AFTER, AGENT, BEFORE, CHANGE, confirmChecks, readyProject, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, assertStopBudget, changePackage, exportRevision, liveLoop, passingScreen,
  refusedBeforeRun, assertEnded, refusedWith, restoreStart,
} from './helpers/loop.js';

test('a new export ends the loop: run start and loop accept refuse it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const exported = exportRevision(project);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.deepEqual([status.ended.spec, status.ended.loop_spec, status.ended.accepted], [exported.id, project.loop.spec, false]);
  assert.equal(status.next.owner, 'user');
  // A head run of the new export has no baseline yet, and the old loop is not accepted.
  refusedBeforeRun(project, {}, 'baseline_missing');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('loop_ended'));
});

test('a package change ends the loop and names the file, and putting the file back gives the loop\'s step again', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  const kept = readFileSync(file, 'utf8');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assert.equal(status.next.route, 'write-eval');
  assert.ok(status.next.message.includes('Going on needs the user\'s `eval confirm` of the packages as they are. You may fix the packages in write-eval and run `eval check` and `eval review`.'), status.next.message);
  // The agent may still prove and review the packages.
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.ok(reviewEval(repo, CHANGE).must_decide.some((entry) => entry.code === 'changed_since_confirmation'));
  refusedBeforeRun(project, {}, 'loop_ended');
  // The end is worked out from the files, not kept.
  writeFileSync(file, kept);
  const back = loopStatus(repo, CHANGE);
  assert.equal(back.ended, null);
  assert.equal(back.next.action, 'iterate', JSON.stringify(back.next));
});

test('a newer confirmation ends the loop only when its plan or packages differ: a new budget does not', (t) => {
  const project = liveLoop(t, 3);
  const { repo } = project;
  const before = loopStatus(repo, CHANGE).next;
  confirmChecks(project, { iterations: 7, reason: 'The user gives more runs.' });
  const budget = loopStatus(repo, CHANGE);
  assert.equal(budget.ended, null);
  assert.deepEqual(budget.next, before);
  assert.deepEqual(budget.loop.budget, project.loop.budget);
  const confirmed = confirmChecks(project, { attempts: 5, reason: 'The user wants 5 attempts.' });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'confirmation_changed');
  assert.deepEqual([status.ended.confirmation, status.ended.plan, status.ended.packages], [confirmed.confirmation.id, ['attempts'], []]);
  assert.ok(status.next.message.startsWith(`The user's newest checks confirmation (${confirmed.confirmation.confirmed.at}) differs from this loop's: it confirms 5 attempts, agent ${AGENT}, model none where the loop runs 3 attempts, agent ${AGENT}, model none.`), status.next.message);
  refusedBeforeRun(project, {}, 'loop_ended');
});

test('a missing baseline ends the loop, and run start refuses it before Harbor', (t) => {
  const project = inLoop(t);
  rmSync(project.base.directory, { recursive: true, force: true });
  const status = loopStatus(project.repo, CHANGE);
  assertEnded(status, 'baseline_missing');
  assert.equal(status.ended.baseline, project.base.run_id);
  const refusal = refusedBeforeRun(project, {}, 'loop_ended');
  assert.equal(refusal.reason, 'baseline_missing');
});

test('plan flags are refused in a loop before anything runs, the plan\'s own values included', (t) => {
  const project = liveLoop(t, 3);
  for (const options of [{ attempts: 3 }, { agent: AGENT }, { model: 'synthetic/m1' }, { case: [FAILURE], attempts: 1 }]) {
    refusedBeforeRun(project, options, 'run_plan_fixed');
  }
});

test('when the final run, estimated from the loop\'s own runs, does not fit the minutes left, the loop stops on budget for good', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 0.01 });
  const screen = passingScreen(project);
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status.next, repo, 'final_run_does_not_fit');
  assert.equal(status.loop.exhausted, false);
  assert.deepEqual(status.stop.action, 'stop_budget');
  assert.equal(status.next.estimate.basis, 'loop_attempts');
  assert.equal(status.loop.estimate.basis, 'loop_attempts');
  assert.ok(status.next.message.startsWith(`Screen run ${screen.run_id} passed and its final review is done, but the final run (${FAILURE} runs 3 times and every other package once) takes about ${status.next.estimate.minutes} minutes (by the attempts of this loop's runs), more than the 0 minutes left of the budget.`), status.next.message);
  const refusal = refusedBeforeRun(project, {}, 'stop_budget');
  assert.equal(refusal.reason, 'final_run_does_not_fit');
  // A code change does not lift it.
  changeCode(repo, AFTER, 'Another change after the stop');
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'final_run_does_not_fit');
});

test('a final run that does not fit stops the loop whatever its screen run\'s report says, and no head run follows', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 0.01 });
  const screen = passingScreen(project);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'final_run_does_not_fit');
  // The Review written at the final review is emptied again.
  const file = path.join(root, 'reports', `${screen.run_id}.md`);
  const kept = readFileSync(file, 'utf8');
  writeFileSync(file, kept.replace(/^## Review[\s\S]*$/m, '## Review\n'));
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.stop?.action, status.stop?.reason], ['stop_budget', 'final_run_does_not_fit'], JSON.stringify(status.stop));
  assert.equal(status.next.action, 'final_review', JSON.stringify(status.next));
  assert.ok(status.stop.message.startsWith(`Screen run ${screen.run_id} passed, but the final run`), status.stop.message);
  assert.match(status.stop.message, /write the report and do the final review first/);
  // No head run follows, partial ones included, so none can lower the estimate.
  refusedBeforeRun(project, { case: [FAILURE, SUCCESS] }, 'stop_budget');
  refusedBeforeRun(project, {}, 'stop_budget');
  // With the Review back, the final run stays refused.
  writeFileSync(file, kept);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'final_run_does_not_fit');
  refusedBeforeRun(project, {}, 'stop_budget');
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
  passingScreen(project, quick(600));
  const status = loopStatus(repo, CHANGE);
  // 3 attempts of FAILURE and 1 of SUCCESS at 10 minutes each: 40 minutes, more than the 30 left.
  assertStopBudget(status.next, repo, 'final_run_does_not_fit');
  assert.deepEqual([status.next.estimate.minutes, status.next.estimate.basis], [40, 'loop_attempts']);
  assert.equal(status.partial_runs, 2);
});

test('a stuck loop stays stopped once the code changes, and run start refuses it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, BEFORE, 'second attempt');
  completeReport(repo, fullRun(repo).run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_stuck');
  changeCode(repo, AFTER, 'third attempt');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_stuck');
  assert.equal(status.stop.action, 'stop_stuck');
  refusedBeforeRun(project, {}, 'stop_stuck');
});

test('with the budget used up, a passing run waits for its report and acceptance, and no further head run is made', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.equal(status.loop.exhausted, true);
  assert.equal(status.ended, null);
  refusedBeforeRun(project, {}, 'stop_budget');
  completeReport(repo, run.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  // Once the user accepted the loop, head runs go on.
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
  assert.equal(startRun(repo, CHANGE, { case: [FAILURE] }).execution_status, 'completed');
});

test('a loop that ends while the latest full run has no report asks for that report first', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'A first try');
  const run = fullRun(repo);
  // The failing attempts show a fault in a package: the agent fixes it in write-eval.
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.equal(status.runs.find((entry) => entry.run_id === run.run_id).report, 'incomplete');
  assert.deepEqual(status.next.command, ['loop', 'report', CHANGE, '--repo', repo, '--run', run.run_id]);
  assert.ok(status.next.message.endsWith(`Before anything else, write the report for ${run.run_id} with \`loop report --run ${run.run_id}\` (no report at reports/${run.run_id}.md): every full run gets one, and it holds what this loop found.`), status.next.message);
  // Once it is written, the end no longer asks for it.
  completeReport(repo, run.run_id);
  const written = loopStatus(repo, CHANGE);
  assertEnded(written, 'packages_changed');
  assert.equal(written.next.command, undefined);
  assert.doesNotMatch(written.next.message, /write the report for/);
});

test('after a loop stopped, a refused plan flag, a base record, eval review and workflow check write-eval say it has ended, not that it runs', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, base } = project;
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  completeReport(repo, fullRun(repo).run_id);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'budget_used_up');
  restoreStart(project);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, model: 'synthetic/m1' }), (error) => {
    refusedWith('run_plan_fixed')(error);
    assert.ok(error.gaps[0].message.startsWith('The loop for this Spec export has ended, and its run plan stays fixed until a new loop starts: a baseline reads'), error.gaps[0].message);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.ok(again.warnings.includes(`The loop for this Spec has ended; it compared every run with its own baseline ${base.run_id}. A new loop, once the user agrees, may start on this one.`), JSON.stringify(again.warnings));
  assert.ok(again.next.startsWith('The loop for this Spec has ended. The baseline is recorded on the start code of the change\'s first unaccepted loop'), again.next);
  assert.match(again.next, /Bring back any changes you set aside and, once the user agrees, run `loop start`/);
  assert.ok(reviewEval(repo, CHANGE).next.endsWith(' The loop for this Spec export has ended: a new loop, once the user agrees, starts on the checks they confirm and on a baseline of that plan on the loop\'s start code.'));
  const note = checkWorkflow(repo, 'write-eval', CHANGE).next.note;
  assert.ok(note.endsWith('the loop for this Spec has ended (stop_budget): a changed package or kit needs `eval review` and the user\'s `eval confirm`, then the baseline again on the loop\'s start code and a new loop once they agree.'), note);
});
