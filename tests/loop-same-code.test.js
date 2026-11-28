// Loop tests: results of the same code, and the packages a run executed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, loopStatus } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, commit, confirmChecks, connect, git, harborThen, readRecord, readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, runRecord, FAILURE, SUCCESS,
  changePackage, restoreStart, resultsOutsideCode, runsOf, refusedBeforeRun, assertEnded, assertStopBudget, reviewRun, gapOf, startLoop, actionOf, assertGapShape,
} from './helpers/loop.js';

// --- Results of the same code and the packages a run executed ---

// Appends to a package's Dockerfile after each Harbor call, as an edit during a run would.
const editPackageDuringRun = (id) => `appendFileSync(path.join(repo, '.genesis/edd/${CHANGE}/evals/${id}/environment/Dockerfile'), 'RUN true\\n');`;

// A loop whose baseline ran on a commit without app/results.json, so the
// results can change while the code stays the baseline's. options go to
// readyProject.
function loopWithResultsOutsideCode(t, expect = EXPECT, options = {}) {
  const project = readyProject(t, options);
  resultsOutsideCode(project.repo);
  commit(project.repo, 'Keep the results out of the code');
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, expect) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  return { ...project, base };
}

// The full head run of a workflow status: run start with neither --baseline
// nor --trial.
const headRunAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && !entry.command.includes('--baseline') && !entry.command.includes('--trial'));
const baselineAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && entry.command.includes('--baseline') && !entry.command.includes('--at-start') && !entry.command.includes('--unavailable'));

test('a gating check that fails and then passes on the same code ends the loop as unstable, and the pass cannot be accepted', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');

  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assertGapShape(status.gates.head_run, { code: 'stop_unstable', owner: 'user', layer: 'code' });
  assert.deepEqual(status.unstable, [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure', agent: AGENT, model: null, pass: [passed.run_id], fail: [failed.run_id] }]);
  assert.deepEqual(status.ended.checks, [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  // The facts, and no recipe: what varied, that it always counts, and what the light tier means.
  assert.equal(status.ended.message, `${FAILURE}/c1 passed in ${passed.run_id} and failed in ${failed.run_id}, on the same code and packages. A failure of the same code always counts, so no run of this code can be accepted. In the light tier this means the result of the code is not fixed.`);
  assert.ok(status.ended.new_loop.gates.some((gate) => gate.gate === 'user_consent' && gate.holds === false), JSON.stringify(status.ended.new_loop));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('unstable')(error);
    refusedWith('stop_unstable')(error);
    const entry = assertGapShape(gapOf(error, 'unstable'), { owner: 'user', kind: 'business', layer: 'code', run: passed.run_id,
      failures: [{ check: `${FAILURE}/c1`, runs: [failed.run_id] }] });
    assert.ok(entry.message.startsWith(`${FAILURE}/c1 failed in ${failed.run_id}, on the code and packages of ${passed.run_id}. A failure of the same code always counts, and a later pass does not cancel it, so ${passed.run_id} cannot be accepted.`), entry.message);
    return true;
  });
  assert.equal(existsSync(path.join(root, 'accepted.json')), false);
});

test('a gating check that passes and then fails on the same code ends the loop for good, with no regression or lost progress', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  setResults(repo, BEFORE);
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  let status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  // Two runs of the same code are never a regression or lost progress.
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, []);

  // Changing the code does not lift the stop.
  writeFileSync(path.join(repo, 'app/handler.txt'), 'Another approach\n');
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  assert.deepEqual(status.regressions, []);
  // Nor does anything run in it: the change is locked until the user agrees to a new loop.
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_unstable');
});

test('a failure of the same code counts across loops', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const failed = fullRun(repo);
  assertStopBudget(loopStatus(repo, CHANGE), 'budget_used_up');
  // A new loop, on the user's consent, keeps the start code and the baseline;
  // the same code passes in it.
  const next = startLoop(repo, CHANGE).loop;
  assert.deepEqual([next.baseline, next.start_code], [project.base.run_id, project.loop.start_code]);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [passed.run_id]);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('unstable'));
});

test('a baseline failure counts for a head run of the same code: the loop ends as unstable and the pass is refused', (t) => {
  const { repo, base } = loopWithResultsOutsideCode(t);
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [base.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('unstable')(error);
    assert.match(gapOf(error, 'unstable').message, new RegExp(`^${FAILURE}/c1 failed in ${base.run_id},`));
    return true;
  });
});

test('two baselines of the same code that disagree on a check only warn in the full tier: the loop goes on and the warning says the result can vary', (t) => {
  const expect = { ...EXPECT, [`${SUCCESS}/c2`]: 'any' };
  const { repo, base: first } = loopWithResultsOutsideCode(t, expect, { tier: 'full' });
  setResults(repo, { ...BEFORE, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  const second = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, expect) });
  assert.equal(second.is_baseline, true, JSON.stringify(second));
  setResults(repo, BEFORE);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, second.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'open'], JSON.stringify(status.situation));
  assert.deepEqual(status.unstable, []);
  assert.ok(status.warnings.includes(`On the code before the change, ${SUCCESS}/c2 passed and failed (${first.run_id}, ${second.run_id}). Its result can vary.`), JSON.stringify(status.warnings));
});

test('two baselines of the same code that disagree on a check keep a loop out of the light tier', (t) => {
  const expect = { ...EXPECT, [`${SUCCESS}/c2`]: 'any' };
  const { repo } = loopWithResultsOutsideCode(t, expect);
  setResults(repo, { ...BEFORE, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  assert.equal(startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, expect) }).is_baseline, true);
  setResults(repo, BEFORE);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('tier_light_unfit')(error);
    assertGapShape(gapOf(error, 'tier_light_unfit'), { owner: 'user', layer: 'confirmation' });
    return true;
  });
});

// Rewrites the model a run recorded, as for a run with another model, which a
// loop now refuses before it runs.
function recordModel(project, run, model) {
  const file = path.join(project.runs, run.run_id, 'run.json');
  const record = readJSON(file);
  record.environment_ref.model = model;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

test('a failure with another model is another count, so the pass of the default model can be accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  setResults(repo, BEFORE);
  assert.throws(() => startRun(repo, CHANGE, { case: [FAILURE], model: 'other-model' }), refusedWith('run_plan_fixed'));
  const other = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(other.verdict, 'fail');
  recordModel(project, other, 'other-model');
  setResults(repo, AFTER);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', passed.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.unstable, []);
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  reviewRun(project, passed.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
});

test('a diagnostic check that passes and fails on the same code only warns', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  const file = path.join(root, 'evals', SUCCESS, 'tests/checks.json');
  const declared = readJSON(file);
  declared.checks.find((check) => check.id === 'c2').role = 'diagnostic';
  // A diagnostic check covers no line, so the user judges c2's line.
  declared.scenario.manual = [{ then: declared.checks.find((check) => check.id === 'c2').then, reason: 'synthetic' }];
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  confirmChecks(project, { reason: 'c2 became diagnostic; the user judges its line.' });
  resultsOutsideCode(repo);
  commit(repo, 'Make c2 diagnostic and keep the results out of the code');
  assert.equal(startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) }).is_baseline, true);
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  const second = fullRun(repo);
  assert.equal(second.verdict, 'pass');
  reviewRun(project, second.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.run_id], ['live', 'acceptable', second.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.gates.accept, []);
  assert.deepEqual(status.unstable, []);
  assert.ok(status.warnings.includes(`Diagnostic ${SUCCESS}/c2 passed and failed on the code as it is now (${first.run_id}, ${second.run_id}). It does not decide the verdict.`), JSON.stringify(status.warnings));
});

test('a run during which the code changed adds nothing to the results of the code it started on', (t) => {
  const { repo, tools } = inLoop(t);
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
  const moved = fullRun(repo);
  assert.equal(moved.verdict, 'unverified');
  assert.equal(readRecord(moved).compare.results.find((entry) => entry.case === FAILURE).after, 'fail');
  tools.harbor(true);
  rmSync(path.join(repo, 'app/edited.txt'));
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', passed.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.unstable, []);
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
});

test('a run whose execution errored still counts the packages that completed, and an attempt or a package that did not complete counts no pass', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, { [FAILURE]: 'error', [SUCCESS]: { c1: 'fail', c2: 'pass' } }, 'Try a change that breaks a package');
  const errored = startRun(repo, CHANGE);
  assert.equal(errored.execution_status, 'error');
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  assert.deepEqual(loopStatus(repo, CHANGE).unstable.map(runsOf), [{ case: SUCCESS, check: 'c1', pass: [passed.run_id], fail: [errored.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('unstable')(error);
    assert.match(gapOf(error, 'unstable').message, new RegExp(`^${SUCCESS}/c1 failed in ${errored.run_id},`));
    return true;
  });
  // An attempt that did not complete contributes no pass.
  const attempts = path.join(project.runs, passed.run_id, SUCCESS, 'attempts.json');
  const recorded = readJSON(attempts);
  recorded.attempts[0].status = 'error';
  writeFileSync(attempts, `${JSON.stringify(recorded, null, 2)}\n`);
  assert.deepEqual(loopStatus(repo, CHANGE).unstable, []);
  // Nor does a package that did not complete, in a run recorded before attempts.json.
  rmSync(attempts);
  assert.equal(loopStatus(repo, CHANGE).unstable.length, 1);
  const file = path.join(project.runs, passed.run_id, 'run.json');
  const record = readJSON(file);
  record.cases.find((entry) => entry.id === SUCCESS).execution = { status: 'error', reason: 'Edited for the test.' };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  assert.deepEqual(loopStatus(repo, CHANGE).unstable, []);
});

test('a package whose agent stopped on a rate limit adds no failure, even one its verifier recorded, so a rerun of the same code can be accepted', (t) => {
  const project = inLoop(t);
  const { repo, tools } = project;
  resultsOutsideCode(repo);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } }, 'Stop the success notice when a submission fails');
  // Harbor still grades a trial whose agent raised, as after a rate limit.
  harborThen(t, `if (argv[argv.indexOf('-p') + 1].endsWith('${FAILURE}')) {
    const file = path.join(logs, 'harbor', 'trial-1', 'result.json');
    const outcome = JSON.parse(readFileSync(file, 'utf8'));
    outcome.exception_info = { exception_type: 'ApiRateLimitError', exception_message: 'rate limited' };
    writeFileSync(file, JSON.stringify(outcome));
  }`);
  const errored = startRun(repo, CHANGE);
  assert.equal(errored.execution_status, 'error');
  assert.equal(errored.cases.find((entry) => entry.id === FAILURE).execution.status, 'error');
  // The graded fail is kept in attempts.json, but the check is unknown: it was
  // pinned as fail, and so the run's verdict, until a fail graded after an
  // error stopped counting anywhere.
  assert.equal(errored.verdict, 'unverified');
  assert.equal(readJSON(path.join(project.runs, errored.run_id, FAILURE, 'check-results.json')).results.find((entry) => entry.id === 'c1').result, 'unknown');
  assert.equal(readJSON(path.join(project.runs, errored.run_id, FAILURE, 'attempts.json')).attempts[0].graded.c1, 'fail');
  let status = loopStatus(repo, CHANGE);
  // The run did not complete, and no check failed in an attempt that did.
  assert.deepEqual([status.situation.code, status.situation.run_id, status.situation.failed_checks], ['execution_incomplete', errored.run_id, []], JSON.stringify(status.situation));
  assert.match(status.situation.message, /A build or timeout fault is no result of the code/);
  tools.harbor(true);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', passed.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.unstable, []);
  reviewRun(project, passed.run_id);
  acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
});

test('an acceptance given before a failure of the same code that started earlier stays done, with a warning', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  reviewRun(project, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  setResults(repo, AFTER);
  // As if the partial run had started before the accepted run, so before the rule.
  const file = path.join(project.runs, partial.run_id, 'run.json');
  const record = readJSON(file);
  record.started_at = new Date(Date.parse(runRecord(project, accepted).started_at) - 1000).toISOString();
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done', JSON.stringify(status.situation));
  assert.ok(status.warnings.includes(`${FAILURE}/c1 failed on the code of the accepted run ${accepted.run_id} in ${partial.run_id}, which started before it. A failure of the same code now always counts, so this acceptance would be refused today. It stays recorded.`), JSON.stringify(status.warnings));
});

test('after acceptance a failing run of the accepted code is no regression: with another model the loop goes on, and with the same one it ends as unstable', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  reviewRun(project, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  setResults(repo, BEFORE);
  const other = startRun(repo, CHANGE);
  assert.equal(other.verdict, 'fail');
  recordModel(project, other, 'other-model');
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'open'], JSON.stringify(status.situation));
  assert.equal(status.acceptance.outdated, true);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.unstable, []);
  const failed = fullRun(repo);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, []);
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [accepted.run_id], fail: [failed.run_id] }]);
});

test('an unstable end stays the reason when the budget is used up too, and the budget facts say so', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  fullRun(repo);
  setResults(repo, AFTER);
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual([status.loop.exhausted, status.loop.used.iterations, status.loop.budget.iterations], [true, 2, 2]);
  // A bigger budget would not lift this end, so only a new loop is the user's to decide.
  assert.ok(!status.ended.new_loop.consents.includes('budget'), JSON.stringify(status.ended.new_loop));
  assert.deepEqual(status.must_show.budget.map((entry) => entry.used.iterations), [2]);
});

test('a package changed after a passing run ends the loop, and that run cannot be accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  assert.equal(loopStatus(repo, CHANGE).situation.code, 'acceptable');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assert.equal(status.ended.message, `The eval packages or the project kit differ from the checks the user confirmed for this loop: ${SUCCESS}/environment/Dockerfile. A loop's packages and kit are fixed, so this loop has ended.`);
  // A new loop needs the user's confirmation of the packages as they are, and their consent.
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
  assert.deepEqual(status.ended.new_loop.gates.find((gate) => gate.gate === 'checks_confirmation'), { gate: 'checks_confirmation', holds: false,
    confirmation: status.confirmation.id, packages: [SUCCESS] });
  assertGapShape(status.gates.head_run, { code: 'loop_ended', owner: 'agent', layer: 'package', reason: 'packages_changed' });
  assert.throws(() => acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('packages_changed')(error);
    refusedWith('loop_ended')(error);
    assert.equal(gapOf(error, 'packages_changed').message, `The eval packages changed after ${first.run_id}: ${SUCCESS}, so it cannot be accepted. A loop's packages are fixed; this loop has ended.`);
    return true;
  });
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'packages_changed');
});

test('a package edited during a loop run ends the loop while the edit stays, and that run cannot be accepted', (t) => {
  const project = inLoop(t);
  const { repo, root, tools } = project;
  const dockerfile = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  const kept = readFileSync(dockerfile, 'utf8');
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  harborThen(t, editPackageDuringRun(SUCCESS));
  const run = fullRun(repo);
  tools.harbor(true);
  assert.equal(run.verdict, 'unverified');
  let status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.ok(status.warnings.includes(`The eval packages changed while ${run.run_id} executed (${SUCCESS}), so its results do not belong to one version of them.`), JSON.stringify(status.warnings));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('not_passing')(error);
    refusedWith('loop_ended')(error);
    const during = assertGapShape(gapOf(error, 'packages_changed_during_run'), { owner: 'agent', layer: 'package', run: run.run_id });
    assert.equal(during.message, `The eval packages changed while ${run.run_id} executed, so no one version of them passed.`);
    return true;
  });
  // With the edit undone, the loop goes on: the run is made again.
  writeFileSync(dockerfile, kept);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.packages_changed, status.situation.packages], ['live', 'run_not_settled', true, [SUCCESS]], JSON.stringify(status.situation));
  assert.equal(status.situation.message, `The eval packages changed while ${run.run_id} executed (${SUCCESS}), so its results do not belong to one version of them.`);
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
});

test('after acceptance a changed package only warns: the loop stays done', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  reviewRun(project, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended], ['done', null], JSON.stringify(status.situation));
  assert.ok(status.warnings.includes(`The eval packages changed after the accepted run ${accepted.run_id}: ${SUCCESS}. The acceptance stays as it was given. It was given in the light tier: the packages ran with the network sealed, and each check ran once.`), JSON.stringify(status.warnings));
  // No new confirmation is asked for: the acceptance is given.
  assert.ok(!status.warnings.some((warning) => warning.startsWith('The eval packages changed since the user confirmed the checks')), JSON.stringify(status.warnings));
  assert.equal(status.confirmation.current, false);
});

test('a loop does not start on a baseline of other packages: workflow status says so and offers the baseline again', (t) => {
  const project = withBaseline(t);
  const { repo, root, base } = project;
  changePackage(project, SUCCESS);
  // The user confirms the changed package, so only the baseline is left.
  confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  const message = `The baseline ${base.run_id} ran other eval packages than the ones now: ${SUCCESS} changed since. Every run of a loop is compared with its baseline, so it must have run these packages.`;
  let status = workflowStatus(repo, CHANGE);
  const differ = status.layers.baseline.gaps.find((entry) => entry.code === 'baseline_packages_differ');
  assertGapShape(differ, { owner: 'agent', layer: 'baseline', kind: 'artifact', run: base.run_id, message });
  assert.equal(status.layers.baseline.recorded.packages_differ, true);
  const start = actionOf(status, 'loop', 'start');
  assert.equal(start.allowed, false);
  assert.ok(start.blocked_by.includes('baseline_packages_differ'), JSON.stringify(start));
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_packages_differ'));
  const again = baselineAction(status);
  assert.deepEqual([again.allowed, again.needed], [true, true], JSON.stringify(again));
  assert.deepEqual(again.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', `.genesis/edd/${CHANGE}/baseline-expectations.json`]);
  assert.deepEqual(status.suggestion.command, again.command);
  const recorded = startRun(repo, CHANGE, { baseline: true, expect: path.join(root, 'baseline-expectations.json') });
  assert.equal(recorded.is_baseline, true);
  status = workflowStatus(repo, CHANGE);
  assert.equal(actionOf(status, 'loop', 'start').allowed, true, JSON.stringify(actionOf(status, 'loop', 'start')));
  assert.equal(startLoop(repo, CHANGE).loop.baseline, recorded.run_id);
});

test('a loop does not start on a baseline that did not run a package connected after it', (t) => {
  const { repo, base } = (() => {
    const project = readyProject(t, { unconnected: [SUCCESS] });
    const recorded = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
    assert.equal(recorded.is_baseline, true, JSON.stringify(recorded));
    return { ...project, base: recorded };
  })();
  connect(repo, SUCCESS);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_packages_differ')(error);
    const differ = assertGapShape(gapOf(error, 'baseline_packages_differ'), { owner: 'agent', layer: 'baseline' });
    assert.ok(differ.message.startsWith(`The baseline ${base.run_id} ran other eval packages than the ones now: ${SUCCESS} did not run in it.`), differ.message);
    return true;
  });
});

test('a failure of the code as it is now with an earlier version of a package warns that the changed package starts a new count, across loops', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  changePackage(project, SUCCESS);
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  // The baseline again on the start code, then the code back and a new loop
  // on the user's consent.
  restoreStart(project);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  git(repo, ['checkout', '-q', 'HEAD', '--', 'app']);
  startLoop(repo, CHANGE);
  const later = fullRun(repo);
  assert.equal(later.verdict, 'fail');
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(`On the code as it is now, ${SUCCESS}/c1 failed with an earlier version of its package (${failed.run_id}), and the package changed since. A changed package starts a new count; the user hears of the failure before they accept.`), JSON.stringify(status.warnings));
  assert.deepEqual(status.unstable, []);
});

test('loop status lists no unstable checks in a loop whose runs agree', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.unstable, []);
  assert.equal(status.loop.task_digest_from, undefined);
  assert.deepEqual(status.changed_packages, []);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', run.run_id]);
  assert.equal(headRunAction(workflowStatus(repo, CHANGE)).in_loop, true);
});
