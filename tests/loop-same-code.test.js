// Loop tests: results of the same code, and the packages a run executed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ignoredArtifacts, initProject, projectRoot, readJSON } from '../src/project.js';
import { exportSpec, newSpec, validateSpec } from '../src/spec.js';
import { newEval, validateEval } from '../src/eval.js';
import { checkEval, codeSnapshot, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, reportGaps, startLoop, writeReport } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import { reviewEval } from '../src/confirm.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FIXTURES, LIVE_DEPENDENCY, SPECS, cli, commit, commitConfirmation, confirmChecks, connect, dropCheck, editChecks, git, harborThen, legacyWarning, readRecord,
  readyProject, reviewFixtures, setResults, toLegacy, useFakeTools, writeExpectations, writeFixtureScripts, writeSpec,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord, FAILURE, SUCCESS,
  REVISED, loopPath, loopRecord, editLoop, withoutKey, restoreStart, changePackage, exportRevision, resultsOutsideCode, runsOf,
  refusedBeforeRun, assertEnded, assertStopBudget,
} from './helpers/loop.js';

// --- Results of the same code and the packages a run executed ---

// Appends to a package's Dockerfile after each Harbor call, as an edit during a run would.
const editPackageDuringRun = (id) => `appendFileSync(path.join(repo, '.genesis/edd/${CHANGE}/evals/${id}/environment/Dockerfile'), 'RUN true\\n');`;

// A loop whose baseline ran on a commit without app/results.json, so the
// results can change while the code stays the baseline's.
function loopWithResultsOutsideCode(t, expect = EXPECT) {
  const project = readyProject(t);
  resultsOutsideCode(project.repo);
  commit(project.repo, 'Keep the results out of the code');
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, expect) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  return { ...project, base };
}

test('a gating check that fails and then passes on the same code stops the loop as unstable, and the pass cannot be accepted', (t) => {
  const { repo, root } = inLoop(t);
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  completeReport(repo, failed.run_id);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  completeReport(repo, passed.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.equal(status.next.owner, 'user');
  assert.equal(status.next.route, undefined);
  assert.equal(status.next.command, undefined);
  assert.deepEqual(status.unstable, [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure', agent: AGENT, model: null, pass: [passed.run_id], fail: [failed.run_id] }]);
  assert.equal(status.next.message, `${FAILURE}/c1 passed in ${passed.run_id} and failed in ${failed.run_id}, on the same code and packages. A failure of the same code always counts: running it again only adds to the count, and no run of this code can be accepted. Stop and tell the user what the runs showed. This loop has ended: a code change does not lift this stop, and \`run start\` refuses its head runs. The user decides: find and fix what makes the result vary, or change the requirement through agent-spec. A new loop needs their go-ahead; it keeps the start code, and the failures of the same code still count.`);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    assert.deepEqual(codes(error.gaps), ['unstable', 'stop_unstable']);
    const [entry] = error.gaps;
    assert.deepEqual([entry.owner, entry.kind, entry.route], ['user', 'business', 'loop-and-implement']);
    assert.ok(entry.message.startsWith(`${FAILURE}/c1 failed in ${failed.run_id}, on the code and packages of ${passed.run_id}. A failure of the same code always counts, and a later pass does not cancel it, so ${passed.run_id} cannot be accepted.`), entry.message);
    return true;
  });
  assert.equal(existsSync(path.join(root, 'accepted.json')), false);
});

test('a gating check that passes and then fails on the same code stops the loop for good, with no regression or lost progress', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  completeReport(repo, passed.run_id);
  setResults(repo, BEFORE);
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  completeReport(repo, failed.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  // Two runs of the same code are never a regression or lost progress.
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, []);

  // Changing the code does not lift the stop.
  writeFileSync(path.join(repo, 'app/handler.txt'), 'Another approach\n');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  assert.deepEqual(status.regressions, []);
  refusedBeforeRun(project, {}, 'stop_unstable');
});

test('a failure of the same code counts across loops', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const failed = fullRun(repo);
  completeReport(repo, failed.run_id);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'budget_used_up');
  // A new loop keeps the start code and the baseline; the same code passes in it.
  const next = startLoop(repo, CHANGE).loop;
  assert.deepEqual([next.baseline, next.start_code], [project.base.run_id, project.loop.start_code]);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  completeReport(repo, passed.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [passed.run_id]);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [failed.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('unstable'));
});

test('a baseline failure counts for a head run of the same code: the loop stops as unstable and the pass is refused', (t) => {
  const { repo, base } = loopWithResultsOutsideCode(t);
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  completeReport(repo, passed.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [base.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('unstable')(error);
    assert.match(error.gaps.find((entry) => entry.code === 'unstable').message, new RegExp(`^${FAILURE}/c1 failed in ${base.run_id},`));
    return true;
  });
});

test('two baselines of the same code that disagree on a check only warn: the loop iterates and says the result can vary', (t) => {
  const expect = { ...EXPECT, [`${SUCCESS}/c2`]: 'any' };
  const { repo, base: first } = loopWithResultsOutsideCode(t, expect);
  setResults(repo, { ...BEFORE, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  const second = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, expect) });
  assert.equal(second.is_baseline, true, JSON.stringify(second));
  setResults(repo, BEFORE);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, second.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.deepEqual(status.unstable, []);
  assert.ok(status.warnings.includes(`On the code before the change, ${SUCCESS}/c2 passed and failed (${first.run_id}, ${second.run_id}). Its result can vary; say so in the report.`), JSON.stringify(status.warnings));
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
  completeReport(repo, passed.run_id, { review: false });
  setResults(repo, BEFORE);
  assert.throws(() => startRun(repo, CHANGE, { case: [FAILURE], model: 'other-model' }), refusedWith('run_plan_fixed'));
  const other = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(other.verdict, 'fail');
  recordModel(project, other, 'other-model');
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_review', JSON.stringify(status.next));
  assert.deepEqual(status.unstable, []);
  completeReport(repo, passed.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
  acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
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
  completeReport(repo, first.run_id);
  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  const second = fullRun(repo);
  assert.equal(second.verdict, 'pass');
  completeReport(repo, second.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.deepEqual(status.unstable, []);
  assert.ok(status.warnings.includes(`Diagnostic ${SUCCESS}/c2 passed and failed on the code as it is now (${first.run_id}, ${second.run_id}). It does not decide the verdict; say so in the report.`), JSON.stringify(status.warnings));
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
  completeReport(repo, passed.run_id, { review: false });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_review', JSON.stringify(status.next));
  assert.deepEqual(status.unstable, []);
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
  completeReport(repo, passed.run_id);
  assert.deepEqual(loopStatus(repo, CHANGE).unstable.map(runsOf), [{ case: SUCCESS, check: 'c1', pass: [passed.run_id], fail: [errored.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('unstable')(error);
    assert.match(error.gaps.find((entry) => entry.code === 'unstable').message, new RegExp(`^${SUCCESS}/c1 failed in ${errored.run_id},`));
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
  assert.equal(status.next.action, 'repair_execution', JSON.stringify(status.next));
  assert.match(status.next.message, /Neither is a result of the code\.$/);
  tools.harbor(true);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  completeReport(repo, passed.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.deepEqual(status.unstable, []);
  acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
});

test('an acceptance given before a failure of the same code that started earlier stays done, with a warning', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
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
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.ok(status.warnings.includes(`${FAILURE}/c1 failed on the code of the accepted run ${accepted.run_id} in ${partial.run_id}, which started before it. A failure of the same code now always counts, so this acceptance would be refused today. It stays recorded; tell the user.`), JSON.stringify(status.warnings));
});

test('after acceptance a failing run of the accepted code is no regression: with another model the loop iterates, and with the same one it stops as unstable', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  setResults(repo, BEFORE);
  const other = startRun(repo, CHANGE);
  assert.equal(other.verdict, 'fail');
  recordModel(project, other, 'other-model');
  completeReport(repo, other.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, true);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.unstable, []);
  const failed = fullRun(repo);
  completeReport(repo, failed.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, []);
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [accepted.run_id], fail: [failed.run_id] }]);
});

test('stop_unstable stays the step when the budget is used up too, and says so', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const failed = fullRun(repo);
  completeReport(repo, failed.run_id);
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  completeReport(repo, passed.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.match(status.next.message, / The budget is used up too \(2 of 2 runs, \d+ of 60 minutes\)\.$/);
});

test('a package changed after a passing run ends the loop, and that run cannot be accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assert.ok(status.next.message.startsWith(`The eval packages or the project kit differ from the checks the user confirmed for this loop: ${SUCCESS}/environment/Dockerfile. A loop's packages and kit are fixed, so this loop has ended: \`run start\` and \`loop accept\` refuse it. Going on needs the user's \`eval confirm\` of the packages as they are.`), status.next.message);
  assert.equal(status.next.revision, undefined);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    assert.deepEqual(codes(error.gaps), ['packages_changed', 'loop_ended']);
    assert.equal(error.gaps[0].message, `The eval packages changed after ${first.run_id}: ${SUCCESS}, so it cannot be accepted. A loop's packages are fixed; this loop has ended, and going on needs the user's \`eval confirm\` and a new loop.`);
    return true;
  });
  refusedBeforeRun(project, {}, 'loop_ended');
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
  assert.ok(status.warnings.some((warning) => warning.startsWith(`The eval packages changed while ${run.run_id} executed (${SUCCESS}), so its results do not belong to one version of them.`)), JSON.stringify(status.warnings));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('not_passing')(error);
    refusedWith('packages_changed_during_run')(error);
    refusedWith('loop_ended')(error);
    assert.equal(error.gaps.find((entry) => entry.code === 'packages_changed_during_run').message, `The eval packages changed while ${run.run_id} executed, so no one version of them passed. Prove them again with \`eval check\`, run again without editing them during the run, and accept that run.`);
    return true;
  });
  // With the edit undone, the loop goes on: the run is made again.
  writeFileSync(dockerfile, kept);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'run_again', JSON.stringify(status.next));
  assert.equal(status.next.message, `The eval packages changed while ${run.run_id} executed (${SUCCESS}), so its results do not belong to one version of them. Leave the packages and the project kit as they are during a run, and run every package again with \`run start\`.`);
});

test('after acceptance a changed package only warns: the loop stays done', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.ok(status.warnings.includes(`The eval packages changed after the accepted run ${accepted.run_id}: ${SUCCESS}. The acceptance stays as it was given; tell the user what changed and why.`), JSON.stringify(status.warnings));
  // No revision is asked for: the acceptance is given.
  assert.ok(!status.warnings.some((warning) => warning.startsWith('The eval packages changed since the user confirmed the checks')), JSON.stringify(status.warnings));
  assert.equal(status.confirmation.current, false);
});

test('a loop does not start on a baseline of other packages: workflow check says so and gives the baseline command again', (t) => {
  const project = withBaseline(t);
  const { repo, root, base } = project;
  changePackage(project, SUCCESS);
  // The user confirms the changed package, so only the baseline is left.
  confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  const message = `The baseline ${base.run_id} ran other eval packages than the ones now: ${SUCCESS} changed since. Every run of a loop is compared with its baseline, so it must have run these packages. Record the baseline again on the code before the change, with the same --expect file and no --attempts, --agent or --model; the baseline reads the plan from confirmed.json, then run \`loop start\` again.`;
  const check = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(check.status, 'blocked');
  assert.deepEqual(codes(check.gaps), ['baseline_packages_differ']);
  assert.equal(check.gaps[0].message, message);
  assert.deepEqual([check.gaps[0].owner, check.gaps[0].route, check.gaps[0].kind], ['agent', 'run-eval', 'artifact']);
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_packages_differ'));
  const run = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(run.next.action, 'record_baseline', JSON.stringify(run.next));
  assert.deepEqual(run.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', path.join(root, 'baseline-expectations.json')]);
  assert.equal(run.next.note, message);
  const again = startRun(repo, CHANGE, { baseline: true, expect: path.join(root, 'baseline-expectations.json') });
  assert.equal(again.is_baseline, true);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
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
    assert.ok(error.gaps.find((entry) => entry.code === 'baseline_packages_differ').message
      .startsWith(`The baseline ${base.run_id} ran other eval packages than the ones now: ${SUCCESS} did not run in it.`), error.message);
    return true;
  });
});

test('a failure of the code as it is now with an earlier version of a package warns that the changed package starts a new count, across loops', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  completeReport(repo, failed.run_id);
  changePackage(project, SUCCESS);
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  // The baseline again on the start code, then the code back and a new loop.
  git(repo, ['checkout', '-q', 'HEAD~1', '--', 'app']);
  rmSync(path.join(repo, 'app/handler.txt'), { force: true });
  assert.equal(startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) }).is_baseline, true);
  git(repo, ['checkout', '-q', 'HEAD', '--', 'app']);
  startLoop(repo, CHANGE);
  const again = fullRun(repo);
  assert.equal(again.verdict, 'fail');
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(`On the code as it is now, ${SUCCESS}/c1 failed with an earlier version of its package (${failed.run_id}), and the package changed since. A changed package starts a new count: say in the report why it changed, and tell the user before they accept.`), JSON.stringify(status.warnings));
  assert.deepEqual(status.unstable, []);
});

test('loop status lists no unstable checks in a loop whose runs agree', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  completeReport(repo, fullRun(repo).run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.unstable, []);
  assert.equal(status.loop.task_digest_from, undefined);
  assert.deepEqual(status.changed_packages, []);
  assert.equal(status.next.action, 'ask_acceptance');
});
