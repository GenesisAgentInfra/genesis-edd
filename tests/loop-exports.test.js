// Loop tests: the code before the change across Spec exports, and the run plans
// a loop holds to.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { checkEval, codeSnapshot, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, writeReport } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { AFTER, BEFORE, CHANGE, actionOf, assertGapShape, assertNoRoutes, confirmChecks, git, harborThen, readyProject, setResults, startLoop, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, FAILURE, SUCCESS,
  loopPath, loopRecord, editApp, restoreStart, exportRevision, resultsOutsideCode, liveLoop, gapOf, finalsLoop, passingScreen,
  refusedBeforeRun, assertEnded, reviewRun,
} from './helpers/loop.js';

// --- The code before the change across Spec exports, run plans a loop holds
// to, errored attempts, and what goes with them. ---

// Expected baseline results that hold on the code before the change and after it.
const ANY = { [`${FAILURE}/c1`]: 'any', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' };

test('after the Spec is exported again in a loop the user has not accepted, every base record of the new export goes on the loop\'s start code, and the loop for it keeps that code', (t) => {
  // app/results.json stays uncommitted, so the start code needs loop-start.patch.
  // The full tier, so a record that nothing could run is allowed at all.
  const project = withBaseline(t, { commit: false, tier: 'full' });
  const { repo, root } = project;
  startLoop(repo, CHANGE);
  const first = loopRecord(project);
  assert.equal(first.start_code.patch, 'loop-start.patch');
  const patch = readFileSync(path.join(root, 'loop-start.patch'), 'utf8');
  editApp(repo, AFTER, 'changed in the first loop');
  assert.equal(fullRun(repo).verdict, 'pass');
  const exported = exportRevision(project, { tier: 'full' });
  const hint = `${first.start_code.commit ? `commit ${first.start_code.commit}` : 'no commit'} plus \`git apply\` .genesis/edd/${CHANGE}/loop-start.patch`;

  // The loop has ended; loop status names the start code, and the change is
  // locked until the user agrees to a new loop.
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.deepEqual(status.ended.start_code, { commit: first.start_code.commit, digest: first.start_code.digest, patch: `.genesis/edd/${CHANGE}/loop-start.patch`, uncommitted_files: ['app/results.json'] });
  let workflow = workflowStatus(repo, CHANGE);
  assert.equal(workflow.layers.loop.change_lock.reason, 'spec_exported');
  assert.equal(workflow.layers.baseline.start_code.restore, hint);
  // A base record of the working directory is refused; one rebuilt on the start code is allowed.
  assert.deepEqual(actionOf(workflow, 'run', 'start', '--baseline', '--expect').blocked_by, ['baseline_after_change']);
  assert.equal(actionOf(workflow, 'run', 'start', '--baseline', '--at-start').allowed, true);
  assert.deepEqual(workflow.suggestion.command.slice(-2), ['--baseline', '--at-start']);

  // A base record on the changed code is refused, one that records that nothing could run too.
  for (const options of [{ expect: writeExpectations(repo, ANY) }, { unavailable: 'execution_blocked' }]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, ...options }), (error) => {
      refusedWith('baseline_after_change')(error);
      const entry = assertGapShape(gapOf(error, 'baseline_after_change'), { owner: 'agent', layer: 'baseline', start_code: hint });
      assert.ok(entry.message.startsWith(`Until a loop of this change is accepted or the user abandons the change, every base record goes on the start code of its first unaccepted loop, ${hint}, and the working directory holds other code.`), entry.message);
      return true;
    });
  }
  assert.equal(readJSON(loopPath(project)).spec, first.spec);

  // On the start code it goes through, and the new loop keeps that code.
  restoreStart(project);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  assert.deepEqual([base.start_code, base.loop_baseline, base.confirmation_current], [hint, { usable: true, reasons: [] }, true]);
  editApp(repo, AFTER, 'changed in the first loop');
  // With the changes back, only the user's go-ahead is left before loop start.
  workflow = workflowStatus(repo, CHANGE);
  const start = actionOf(workflow, 'loop', 'start');
  assert.deepEqual([start.allowed, start.by, start.start_code], [true, 'user', 'pinned']);
  assert.deepEqual(workflow.suggestion.command, ['loop', 'start', CHANGE, '--repo', repo, '--by', '<user>', '--ref', '<where they said so>']);
  // A confirmation after it keeps that baseline.
  const revised = confirmChecks(project, { tier: 'full', reason: 'The user read the checks of the new export again.' });
  assert.deepEqual([revised.baseline.recorded, revised.baseline.kept, revised.baseline.on], [base.run_id, true, 'start_code']);
  assert.deepEqual(revised.new_loop_needs, { baseline: false, user_consent: true });
  const started = startLoop(repo, CHANGE);
  const second = loopRecord(project);
  assert.deepEqual([second.spec, second.baseline, second.start_from], [exported.id, base.run_id, 'pinned']);
  assert.deepEqual(second.start_code, first.start_code);
  assert.equal(second.base_commit, first.base_commit);
  assert.equal(started.worktree_moved, true);
  assert.equal(readFileSync(path.join(root, 'loop-start.patch'), 'utf8'), patch);
  // The loop goes on from the changed code, compared with the new baseline.
  assert.equal(loopStatus(repo, CHANGE).situation.code, 'open');
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('a loop for a new export keeps the start code of the unaccepted loop before it, and goes on from the code as it is', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const first = loopRecord(project);
  exportRevision(project);
  // Recorded on the start code, then the code changes before loop start.
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true);
  editApp(repo, AFTER, 'a change before the loop of the new export');
  const again = startLoop(repo, CHANGE);
  assert.deepEqual(again.loop.start_code, first.start_code, 'the loop keeps the start code and goes on from the current code');
  assert.deepEqual([again.loop.start_from, again.worktree_moved], ['pinned', true]);
});

test('once the user accepted the loop, a new export may record its baseline on the accepted code, and its loop starts there', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const first = loopRecord(project);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  exportRevision(project);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.deepEqual([status.ended.accepted, status.accepted, status.ended.start_code], [true, true, null]);
  // The user accepted that loop: nothing is locked and no start code is pinned.
  const workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual([workflow.layers.loop.change_lock, workflow.layers.baseline.start_code], [null, null]);
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
  assert.deepEqual([revised.baseline.recorded, revised.baseline.kept, revised.baseline.unavailable], [base.run_id, false, 'no_implementation']);
  assert.deepEqual(revised.new_loop_needs, { baseline: true, user_consent: true });
  const workflow = workflowStatus(repo, CHANGE);
  assertGapShape(workflow.gaps.find((entry) => entry.code === 'baseline_plan_differs'), { owner: 'agent', layer: 'baseline', run: base.run_id, differs: ['attempts'] });
  assert.deepEqual(actionOf(workflow, 'loop', 'start').blocked_by, ['baseline_plan_differs']);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_plan_differs')(error);
    const { message } = gapOf(error, 'baseline_plan_differs');
    assert.ok(message.startsWith(`The baseline ${base.run_id} records that nothing could run, and a loop on it runs with 3 attempts but the user confirmed 5 attempts`), message);
    assert.ok(message.endsWith('A baseline reads the confirmed plan from confirmed.json.'), message);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(again.run_plan.attempts, 5);
  assert.equal(startLoop(repo, CHANGE).run_plan.attempts, 5);
});

test('a run plan confirmed inside a loop ends it, loop accept and run start refuse it, and a new loop needs a baseline of that plan on the start code', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const first = startLoop(repo, CHANGE).loop;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const screen = fullRun(repo);
  // The user confirms 5 attempts: the confirmation is recorded and the loop ends.
  const confirmed = confirmChecks(project, { attempts: 5, reason: 'The user wants 5 attempts.' });
  assert.equal(confirmed.confirmation.run_plan.attempts, 5);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'confirmation_changed');
  assert.deepEqual([status.ended.plan, status.ended.packages, status.ended.confirmation], [['attempts'], [], confirmed.confirmation.id]);
  assertGapShape(status.gates.head_run, { code: 'loop_ended', owner: 'user', layer: 'confirmation' });
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('loop_ended'));
  refusedBeforeRun(project, {}, 'change_locked');
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_plan_differs'));
  // A baseline on the start code reads the 5 attempts, and a new loop starts on it.
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
  assert.deepEqual(next.start_code.digest, first.start_code.digest);
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
  fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, false);
  assert.equal(status.situation.code, 'open', JSON.stringify(status.situation));

  // After an acceptance, a rerun of the accepted code that errored with a graded fail keeps it.
  tools.harbor(true);
  editApp(repo, AFTER, 'the fix');
  const passed = fullRun(repo);
  reviewRun(project, passed.run_id);
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
  // A fail graded after an error is no result: the check is unknown, so the run fails nothing.
  assert.deepEqual([errored.execution_status, errored.verdict], ['error', 'unverified']);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done', JSON.stringify(status.situation));
  assert.deepEqual([status.acceptance.holds, status.acceptance.outdated], [true, undefined]);
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
  assert.equal(status.phase, 'done', JSON.stringify(status.situation));
  assert.deepEqual([status.acceptance.holds, status.acceptance.outdated], [true, undefined]);
});

test('a revision that leaves the recorded baseline as it ran keeps it, so only the user\'s go-ahead is left before loop start', (t) => {
  const project = withBaseline(t);
  const { repo, base } = project;
  const revised = confirmChecks(project, { iterations: 8, reason: 'The user raised the budget.' });
  assertNoRoutes(revised, 'confirmation');
  assert.deepEqual([revised.baseline.recorded, revised.baseline.kept], [base.run_id, true]);
  assert.deepEqual(revised.new_loop_needs, { baseline: false, user_consent: true });
  assert.deepEqual(revised.suggestion.command.slice(0, 2), ['loop', 'start']);
  const workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual([actionOf(workflow, 'run', 'start', '--baseline').needed, actionOf(workflow, 'loop', 'start').allowed], [false, true]);
  const started = startLoop(repo, CHANGE);
  assert.deepEqual([started.loop.budget.iterations, started.loop.budget_source, started.loop.baseline], [8, 'confirmation', base.run_id]);
});

test('a package that waits only for eval check comes first: the light tier confirms no line it cannot prove, a baseline skips the package, and loop start refuses a baseline that skipped it', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  const file = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  const reason = 'The Dockerfile of submit-success-s1 gained a build step.';
  // The proofs of its lines were made for the package as it was.
  assert.throws(() => confirmChecks(project, { reason }), (error) => {
    refusedWith('line_unproven')(error);
    assert.match(gapOf(error, 'line_unproven').message, /review-c1 is not proved by the last `eval check` of submit-success-s1 as it is/);
    return true;
  });
  // The full tier confirms it and says it waits for eval check.
  const confirmed = confirmChecks(project, { tier: 'full', reason });
  assert.deepEqual([confirmed.unchecked, confirmed.new_loop_needs.baseline], [[SUCCESS], true]);
  let workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual([actionOf(workflow, 'eval', 'check').allowed, actionOf(workflow, 'eval', 'check').cases], [true, [SUCCESS]]);
  assert.deepEqual(workflow.suggestion.command, ['eval', 'check', CHANGE, '--repo', repo]);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.ok(base.warnings.includes(`${SUCCESS} changed since its last \`eval check\`, so this baseline skips it, and a loop does not start on it.`), JSON.stringify(base.warnings));
  assert.deepEqual(base.skipped.map((entry) => [entry.case, entry.reason, entry.missing]), [[SUCCESS, 'awaiting_integration', ['check']]]);
  assert.deepEqual(base.loop_baseline, { usable: false, reasons: ['skipped_unproved'] });
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_packages_differ')(error);
    const entry = assertGapShape(gapOf(error, 'baseline_packages_differ'), { owner: 'agent', layer: 'baseline', run: base.run_id, unchecked: [SUCCESS] });
    assert.ok(entry.message.includes(`${SUCCESS} did not run in it. Every run of a loop is compared with its baseline, so it must have run these packages. A run skips ${SUCCESS} until \`eval check\` proves its verifier for it as it is.`), entry.message);
    return true;
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual([actionOf(workflow, 'run', 'start', '--baseline').needed, actionOf(workflow, 'loop', 'start').blocked_by], [true, ['baseline_packages_differ']]);
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

test('eval check states what it proved and leaves the next step to the agent, before and after the user confirmed the checks', (t) => {
  for (const confirm of [false, true]) {
    const project = readyProject(t, { confirm });
    const checked = checkEval(project.repo, CHANGE, { case: FAILURE });
    assertNoRoutes(checked, 'eval check');
    assert.deepEqual([checked.passed, checked.proved, checked.suggestion], [true, [FAILURE], null]);
  }
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
