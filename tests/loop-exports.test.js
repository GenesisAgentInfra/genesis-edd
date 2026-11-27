// Loop tests: the code before the change across Spec exports, and the run plans
// a loop holds to.
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
  EXPECT, BROKEN, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, REVISED,
  loopPath, loopRecord, editApp, restoreStart, changePackage, exportRevision, resultsOutsideCode, liveLoop, gapOf, finalsLoop, passingScreen,
  newProjectLoop,
  refusedBeforeRun, assertEnded, assertStopBudget,
} from './helpers/loop.js';

// --- The code before the change across Spec exports, run plans a loop holds
// to, errored attempts, and the messages that go with them. ---

// Expected baseline results that hold on the code before the change and after it.
const ANY = { [`${FAILURE}/c1`]: 'any', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' };

test('after the Spec is exported again in a loop the user has not accepted, every base record of the new export goes on the loop\'s starting code, and the loop for it keeps that code', (t) => {
  // app/results.json stays uncommitted, so the starting code needs loop-start.patch.
  const project = withBaseline(t, { commit: false });
  const { repo, root } = project;
  startLoop(repo, CHANGE);
  const first = loopRecord(project);
  assert.equal(first.start_code.patch, 'loop-start.patch');
  const patch = readFileSync(path.join(root, 'loop-start.patch'), 'utf8');
  editApp(repo, AFTER, 'changed in the first loop');
  assert.equal(fullRun(repo).verdict, 'pass');
  const exported = exportRevision(project);
  const hint = `${first.start_code.commit ? `commit ${first.start_code.commit}` : 'no commit'} plus \`git apply\` .genesis/edd/${CHANGE}/loop-start.patch`;

  // The loop has ended; loop status and workflow check name the starting code.
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.deepEqual(status.ended.start_code, first.start_code);
  assert.ok(status.next.message.includes(`a new loop keeps its start code, ${hint}, until a loop of this change is accepted`), status.next.message);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check.next));
  assert.ok(check.next.note.includes(`Until a loop of this change is accepted, a new loop keeps the start code of the change's first unaccepted loop, ${hint}: that is still the code before the change.`), check.next.note);

  // A base record on the changed code is refused, one that records that nothing could run too.
  for (const options of [{ expect: writeExpectations(repo, ANY) }, { unavailable: 'execution_blocked' }]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, ...options }), (error) => {
      refusedWith('baseline_after_change')(error);
      assert.ok(error.gaps[0].message.startsWith(`Until a loop of this change is accepted, every base record goes on the start code of its first unaccepted loop, ${hint}.`), error.gaps[0].message);
      return true;
    });
  }
  assert.equal(readJSON(loopPath(project)).spec, first.spec);

  // On the starting code it goes through, and the new loop keeps that code.
  restoreStart(project);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  assert.ok(base.next.startsWith(`The baseline is recorded on the start code of the change's first unaccepted loop (${hint}). Bring back any changes you set aside and, once the user agrees, run \`loop start\``), base.next);
  editApp(repo, AFTER, 'changed in the first loop');
  // With the changes back, workflow check and eval confirm compare the new
  // baseline with that starting code: only loop start is left.
  const startCommand = ['loop', 'start', CHANGE, '--repo', repo];
  const runEval = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.deepEqual([runEval.status, runEval.next.action], ['ready', 'start_loop'], JSON.stringify(runEval.next));
  assert.deepEqual(runEval.next.command, startCommand);
  assert.ok(runEval.next.note.startsWith(`The baseline ${base.run_id} is recorded on the start code of the change's first unaccepted loop. Bring back any changes you set aside and, once the user agrees, run \`loop start\``), runEval.next.note);
  const implement = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(implement.status, 'ready', JSON.stringify(implement.gaps));
  assert.deepEqual(implement.next.command, startCommand);
  const revised = confirmChecks(project, { reason: 'The user read the checks of the new export again.' });
  assert.equal(revised.next, `The checks are confirmed. The baseline ${base.run_id} ran these packages with this plan on the start code of the change's first unaccepted loop: bring back any changes you set aside and start the loop next with \`loop start\`, once the user agrees, which keeps that start code and takes the budget the user confirmed.`);
  startLoop(repo, CHANGE);
  const second = loopRecord(project);
  assert.deepEqual([second.spec, second.baseline], [exported.id, base.run_id]);
  assert.deepEqual(second.start_code, first.start_code);
  assert.equal(second.base_commit, first.base_commit);
  assert.equal(readFileSync(path.join(root, 'loop-start.patch'), 'utf8'), patch);
  // The loop goes on from the changed code, compared with the new baseline.
  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('a loop for a new export keeps the starting code of the unaccepted loop before it, and goes on from the code as it is', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const first = loopRecord(project);
  exportRevision(project);
  // Recorded on the starting code, then the code changes before loop start.
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true);
  editApp(repo, AFTER, 'a change before the loop of the new export');
  const again = startLoop(repo, CHANGE).loop;
  assert.deepEqual(again.start_code, first.start_code, 'the loop keeps the starting code and goes on from the current code');
});

test('once the user accepted the loop, a new export may record its baseline on the accepted code, and its loop starts there', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const first = loopRecord(project);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  exportRevision(project);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.ended.accepted, true);
  assert.equal(status.ended.start_code, null);
  assert.ok(!status.next.message.includes('keeps its start code'), status.next.message);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, ANY) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const second = startLoop(repo, CHANGE).loop;
  assert.notEqual(second.start_code.digest, first.start_code.digest);
  assert.equal(second.start_code.digest, codeSnapshot(repo).snapshot.digest);
  assert.deepEqual(second.follows, { loop_started_at: first.started_at, run_id: run.run_id, spec: first.spec });
});

test('a baseline that records that nothing could run keeps its plan for the loop, so a confirmation of another plan asks for it again', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.run_plan.attempts, 3);
  const revised = confirmChecks(project, { attempts: 5, reason: 'The user asked for 5 attempts.' });
  assert.match(revised.next, /^The checks are confirmed\. Record the baseline next/);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check.next));
  assert.deepEqual(check.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', 'no_implementation']);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_plan_differs')(error);
    assert.ok(gapOf(error, 'baseline_plan_differs').message.startsWith(`The baseline ${base.run_id} records that nothing could run, and a loop on it runs with 3 attempts but the user confirmed 5 attempts`), error.message);
    assert.ok(gapOf(error, 'baseline_plan_differs').message.includes('`run start --baseline --unavailable no_implementation` reads the confirmed plan'), error.message);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(again.run_plan.attempts, 5);
  assert.equal(startLoop(repo, CHANGE).run_plan.attempts, 5);
});

test('a run plan confirmed inside a loop ends it, loop accept and run start refuse it, and a new loop needs a baseline of that plan', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const first = startLoop(repo, CHANGE).loop;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const screen = fullRun(repo);
  completeReport(repo, screen.run_id);
  // The user confirms 5 attempts: the confirmation is recorded and the loop ends.
  const confirmed = confirmChecks(project, { attempts: 5, reason: 'The user wants 5 attempts.' });
  assert.equal(confirmed.confirmation.run_plan.attempts, 5);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'confirmation_changed');
  assert.deepEqual([status.ended.plan, status.ended.packages, status.ended.confirmation], [['attempts'], [], confirmed.confirmation.id]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('loop_ended'));
  refusedBeforeRun(project, {}, 'loop_ended');
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_plan_differs'));
  // A baseline on the starting code reads the 5 attempts, and a new loop starts on it.
  git(repo, ['checkout', '-q', 'HEAD~1', '--', 'app']);
  rmSync(path.join(repo, 'app/handler.txt'), { force: true });
  assert.equal(codeSnapshot(repo).snapshot.digest, first.start_code.digest);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  assert.equal(again.run_plan.attempts, 5);
  git(repo, ['checkout', '-q', 'HEAD', '--', 'app']);
  const next = startLoop(repo, CHANGE).loop;
  assert.equal(next.baseline, again.run_id);
  assert.equal(next.checks_confirmation.id, confirmed.confirmation.id);
  const restarted = loopStatus(repo, CHANGE);
  assert.equal(restarted.ended, null);
  assert.equal(restarted.loop.run_plan.attempts, 5);
});

test('a fail graded after the agent errored neither withdraws an acceptance nor makes the loop stuck', (t) => {
  const project = inLoop(t);
  const { repo, tools } = project;
  // The adapter hits a rate limit in the first attempt of FAILURE on the first code; Harbor still grades it.
  harborThen(t, `if (argv[argv.indexOf('-p') + 1].endsWith('${FAILURE}')) {
    let label = '';
    try { label = readFileSync(path.join(repo, 'app/handler.txt'), 'utf8'); } catch {}
    if (label.includes('first')) {
      const file = path.join(logs, 'harbor', 'trial-1', 'result.json');
      const outcome = JSON.parse(readFileSync(file, 'utf8'));
      outcome.exception_info = { exception_type: 'ApiRateLimitError', exception_message: 'rate limited' };
      writeFileSync(file, JSON.stringify(outcome));
    }
  }`);
  editApp(repo, BEFORE, 'first try');
  assert.equal(startRun(repo, CHANGE).execution_status, 'error');
  // Other code, a completed run, the same check fails: the first valid result of the loop.
  editApp(repo, BEFORE, 'second try');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, false);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));

  // After an acceptance, a rerun of the accepted code that errored with a graded fail keeps it.
  tools.harbor(true);
  editApp(repo, AFTER, 'the fix');
  const passed = fullRun(repo);
  completeReport(repo, passed.run_id);
  acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' });
  harborThen(t, `if (argv[argv.indexOf('-p') + 1].endsWith('${SUCCESS}')) {
    const trial = path.join(logs, 'harbor', 'trial-1');
    const outcome = JSON.parse(readFileSync(path.join(trial, 'result.json'), 'utf8'));
    outcome.exception_info = { exception_type: 'ApiRateLimitError', exception_message: 'rate limited' };
    writeFileSync(path.join(trial, 'result.json'), JSON.stringify(outcome));
    const checks = JSON.parse(readFileSync(path.join(trial, 'verifier', 'check-results.json'), 'utf8'));
    for (const entry of checks.results) if (entry.id === 'c1') entry.result = 'fail';
    writeFileSync(path.join(trial, 'verifier', 'check-results.json'), JSON.stringify(checks));
  }`);
  const errored = startRun(repo, CHANGE);
  // This verdict was pinned as fail until a fail graded after an error stopped
  // counting: the check is unknown, so the run fails nothing.
  assert.deepEqual([errored.execution_status, errored.verdict], ['error', 'unverified']);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, undefined);
  // A run recorded before then, with the graded fail as its result and verdict, keeps the acceptance too.
  const folder = path.join(project.runs, errored.run_id);
  const record = readJSON(path.join(folder, 'run.json'));
  writeFileSync(path.join(folder, 'run.json'), `${JSON.stringify({ ...record, verdict: 'fail' }, null, 2)}\n`);
  const compare = readJSON(path.join(folder, 'compare.json'));
  for (const entry of compare.results) if (entry.case === SUCCESS && entry.check === 'c1') Object.assign(entry, { after: 'fail', verdict: 'violated' });
  writeFileSync(path.join(folder, 'compare.json'), `${JSON.stringify(compare, null, 2)}\n`);
  const attemptsFile = path.join(folder, SUCCESS, 'attempts.json');
  const attempts = readJSON(attemptsFile);
  attempts.attempts = attempts.attempts.map(({ graded, ...entry }) => ({ ...entry, results: graded ?? entry.results }));
  writeFileSync(attemptsFile, `${JSON.stringify(attempts, null, 2)}\n`);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, undefined);
});

test('a revision that leaves the recorded baseline as it ran says to start the loop, not to record the baseline again', (t) => {
  const { repo, ...project } = withBaseline(t);
  const revised = confirmChecks({ repo, ...project }, { iterations: 8, reason: 'The user raised the budget.' });
  assert.match(revised.next, /^The checks are confirmed\. The baseline \S+ ran these packages with this plan on this code: start the loop next with `loop start`/);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  assert.equal(startLoop(repo, CHANGE).loop.budget.iterations, 8);
});

test('a package that waits only for eval check comes first: eval confirm and workflow check say so, the baseline warns, and loop start refuses a baseline that skipped it', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  const file = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  const confirmed = confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  assert.ok(confirmed.next.startsWith(`The checks are confirmed. Prove ${SUCCESS} with \`eval check\` first`), confirmed.next);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.deepEqual([check.next.action, check.next.command], ['check_evals', ['eval', 'check', CHANGE, '--repo', repo]]);
  assert.ok(check.next.note.startsWith(`${SUCCESS} changed since its last \`eval check\``), check.next.note);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.ok(base.warnings.includes(`${SUCCESS} changed since its last \`eval check\`, so this baseline skips it, and a loop does not start on it. Prove it with \`eval check\`, then record the baseline again.`), JSON.stringify(base.warnings));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_packages_differ')(error);
    assert.ok(gapOf(error, 'baseline_packages_differ').message.includes(`${SUCCESS} did not run in it. Every run of a loop is compared with its baseline, so it must have run these packages. Prove ${SUCCESS} with \`eval check\` first`), error.message);
    return true;
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'record_baseline');
});

test('a final run that stops early names the packages it did not run in its report', (t) => {
  const project = liveLoop(t, 3, [FAILURE, SUCCESS]);
  const { repo } = project;
  resultsOutsideCode(repo);
  passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } });
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'fail']);
  const stopped = final.skipped.filter((entry) => entry.reason === 'final_stopped').map((entry) => entry.case);
  assert.equal(stopped.length, 1);
  const { file } = writeReport(repo, CHANGE, { run: final.run_id });
  const ran = stopped[0] === SUCCESS ? FAILURE : SUCCESS;
  assert.ok(readFileSync(file, 'utf8').includes(`\nNot run: ${stopped[0]} (the final run stopped after ${ran} failed).\n`), readFileSync(file, 'utf8'));
});

test('eval check stops asking for the confirmation once the user confirmed the checks as they are', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const checked = checkEval(repo, CHANGE, { case: FAILURE });
  assert.equal(checked.next, 'Every checked verifier told its fixtures apart, so those packages are ready. `workflow check run-eval` says what comes next.');
});

test('a full run recorded before runs had a role is a final run only when it passed', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  // Strips the role, as a run recorded before roles existed has none.
  const legacy = (run) => {
    const file = path.join(project.runs, run.run_id, 'run.json');
    const record = readJSON(file);
    delete record.role;
    delete record.final_of;
    delete record.run_order;
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  };
  passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } });
  const failed = startRun(repo, CHANGE);
  assert.deepEqual([failed.role, failed.verdict], ['final', 'fail']);
  legacy(failed);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.runs.find((entry) => entry.run_id === failed.run_id).role, 'screen');
  assert.deepEqual(status.final.failed, []);

  passingScreen(project, AFTER, 'Another fix');
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } });
  const incomplete = startRun(repo, CHANGE);
  assert.deepEqual([incomplete.role, incomplete.verdict], ['final', 'unverified']);
  legacy(incomplete);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.runs.find((entry) => entry.run_id === incomplete.run_id).role, 'screen');
  assert.deepEqual(status.final.incomplete, []);
});
