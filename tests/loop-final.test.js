// Loop tests: screen runs and the final run, including final runs with an
// errored attempt. A loop states where it stands as facts (situation, final,
// gates) with at most one suggestion; only a passing final run of reviewed
// code can be accepted, and only by the user.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { checkEval, startRun } from '../src/run.js';
import { REVIEWERS, acceptLoop, budgetLoop, loopStatus, writeReport } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  AFTER, CHANGE, CONSENT, allowedActions, assertGapShape, confirmChecks, editChecks, readRecord, readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, codes, refusedWith, inLoop, changeCode, fullRun, runRecord, FAILURE, SUCCESS, resultsOutsideCode, liveLoop, STRENGTH_3, finalsLoop,
  passingScreen, refusedBeforeRun, assertEnded, assertFinalDue, assertStopBudget, reviewRun, startLoop,
} from './helpers/loop.js';

// --- Screen runs and the final run ---

// The -k each of the last count Harbor runs was given, by package.
const attemptsAsked = (tools, count) => Object.fromEntries(tools.runs().slice(-count)
  .map((call) => [path.basename(call.argv[call.argv.indexOf('-p') + 1]), call.argv[call.argv.indexOf('-k') + 1]]));
// The packages of the last count Harbor runs, in the order they ran.
const ranInOrder = (tools, count) => tools.runs().slice(-count).map((call) => path.basename(call.argv[call.argv.indexOf('-p') + 1]));
// The gap codes loop accept refuses a run with.
const acceptRefusal = (repo, run) => {
  let gaps = null;
  assert.throws(() => acceptLoop(repo, CHANGE, { run, ...CONSENT }), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    ({ gaps } = error);
    return true;
  });
  return gaps;
};
// A situation without its message, which states the same facts in words.
const factsOf = (situation) => Object.fromEntries(Object.entries(situation).filter(([key]) => key !== 'message'));
// A head run refused before anything runs because the change's latest loop
// ended (for reason) without the user's acceptance.
function lockedBeforeRun(project, options, reason) {
  const refusal = refusedBeforeRun(project, options, 'change_locked');
  assertGapShape(refusal, { code: 'change_locked', owner: 'user', layer: 'loop', reason });
  return refusal;
}
// The run records as an earlier release left them: no run index, and no
// run.json that says it was listed in one.
function withoutLedger(project) {
  rmSync(path.join(project.runs, 'index.jsonl'), { force: true });
  for (const id of readdirSync(project.runs)) {
    const file = path.join(project.runs, id, 'run.json');
    if (!existsSync(file)) continue;
    const { indexed, ...record } = readJSON(file);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
}

const LINE_ZERO = '本次提交发送的成功通知数量为零';
// The strength sentence of the first final run of a change, which passed.
const STRENGTH_FIRST_FINAL = `${STRENGTH_3} This change made 1 final run over its loops, and 0 of them failed.`;

test('an acceptance an older CLI recorded for a screen run stays done, with a warning that loop accept would refuse it today', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, ...CONSENT }), refusedWith('not_final'));
  // accepted.json 1.0, as an older CLI wrote it for that screen run.
  const { run, compare } = readRecord(path.join(project.runs, screen.run_id));
  writeFileSync(path.join(project.root, 'accepted.json'), `${JSON.stringify({
    schema_version: '1.0', change: CHANGE, run_id: run.run_id, loop_started_at: project.loop.started_at,
    spec: run.spec_snapshot, baseline: run.baseline, baseline_unavailable_reason: run.baseline_unavailable_reason, commit: run.code_snapshot.commit,
    uncommitted_files: run.code_snapshot.changed_files ?? [], code_digest: run.code_snapshot.digest, code_digest_of: run.code_snapshot.digest_of,
    checks: compare.results.map(({ case: id, check, intent, role, before, after, verdict }) => ({ case: id, check, intent, role, before, after, verdict })),
    changed_packages: [], budget: project.loop.budget, used: { iterations: 1, minutes: 0 },
    accepted: { by: 'Dana', ref: 'thread 1', at: new Date().toISOString() },
  }, null, 2)}\n`);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.run_id, status.situation.by], ['done', 'accepted', screen.run_id, 'Dana'], JSON.stringify(status.situation));
  assert.equal(status.runs.find((entry) => entry.run_id === screen.run_id).role, 'screen');
  assert.ok(status.warnings.some((warning) => warning.startsWith(`The accepted run ${screen.run_id} is a screen run: its pass rests on one attempt of each package`)
    && warning.includes('(not_final)') && warning.endsWith('It stays recorded.')), JSON.stringify(status.warnings));
  // An acceptance of a final run says nothing of the kind.
  rmSync(path.join(project.root, 'accepted.json'));
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 2' });
  const done = loopStatus(repo, CHANGE);
  assert.deepEqual([done.phase, done.situation.run_id, done.situation.ref], ['done', final.run_id, 'thread 2']);
  assert.deepEqual(done.warnings.filter((warning) => warning.includes('is a screen run')), []);
});

test('in a loop whose plan runs a live package more than once, a full run is a screen run of one attempt each, and its final run is due without waiting for a review', (t) => {
  const project = liveLoop(t, 3);
  const { repo, tools } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict, screen.acceptable], ['screen', 'pass', false]);
  assert.deepEqual(attemptsAsked(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.deepEqual(screen.attempts, { [FAILURE]: 1, [SUCCESS]: 1 });
  const record = runRecord(project, screen);
  assert.deepEqual([record.role, record.final_of, record.run_order, record.environment_ref.attempts], ['screen', undefined, undefined, 1]);
  assert.deepEqual(screen.warnings.filter((warning) => warning.startsWith('The settings of this run differ')), []);
  // The run writes its report, and points at loop status for the rest.
  assert.equal(screen.report.created, true);
  assert.deepEqual(screen.suggestion.command, ['loop', 'status', CHANGE, '--repo', repo]);

  let status = loopStatus(repo, CHANGE);
  assertFinalDue(status, screen.run_id, repo);
  assert.deepEqual(status.final, { needed: true, attempts: 3, live: [FAILURE], candidate: screen.run_id, pending: true, finals: [], failed: [], incomplete: [], stops_at_failed: 2 });
  assert.deepEqual(status.situation.final_plan, { packages: [FAILURE], attempts: 3, others_once: [SUCCESS] });
  assert.deepEqual(status.runs.map((run) => [run.role, run.report]), [['screen', 'written']]);
  // What a final review of this code answers, and that acceptance needs it.
  assert.deepEqual([status.review.run_id, status.review.needed_for, status.review.recorded], [screen.run_id, 'acceptance of a final run of this code', []]);
  assert.deepEqual(status.review.flips, [{ case: FAILURE, check: 'c1', then: LINE_ZERO, before: 'fail' }]);
  assert.deepEqual(status.review.questions.map((question) => question.split(':')[0]), ['flips', 'special_cases', 'outside_spec', 'side_effects']);
  assert.deepEqual(status.review.reviewers, REVIEWERS);
  assert.ok(status.obligations.some((entry) => entry.kind === 'review' && entry.run_id === screen.run_id && entry.recorded === false), JSON.stringify(status.obligations));
  assert.deepEqual(codes(acceptRefusal(repo, screen.run_id)), ['not_final', 'review_missing']);

  // A final review of the screen run is recorded; the screen run still cannot be accepted.
  reviewRun(project, screen.run_id);
  status = loopStatus(repo, CHANGE);
  assertFinalDue(status, screen.run_id, repo);
  assert.ok(status.obligations.some((entry) => entry.kind === 'review' && entry.run_id === screen.run_id && entry.recorded === true), JSON.stringify(status.obligations));
  const gaps = acceptRefusal(repo, screen.run_id);
  assert.deepEqual(codes(gaps), ['not_final']);
  const entry = assertGapShape(gaps[0], { code: 'not_final', owner: 'agent', layer: 'loop', run: screen.run_id, candidate: screen.run_id });
  assert.ok(entry.message.includes('Only a passing final run can be accepted'), entry.message);
});

test('the final run follows the plan on the code of the screen run, its report says so, and only it is accepted, with the history of the loop', (t) => {
  const project = liveLoop(t, 3);
  const { repo, tools, root } = project;
  const screen = passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict, final.acceptable], ['final', 'pass', true]);
  assert.deepEqual(attemptsAsked(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  // FAILURE failed at the baseline, so it runs first.
  assert.deepEqual(ranInOrder(tools, 2), [FAILURE, SUCCESS]);
  const record = runRecord(project, final);
  assert.deepEqual([record.role, record.final_of, record.run_order], ['final', screen.run_id, [FAILURE, SUCCESS]]);
  assert.deepEqual(record.environment_ref.attempts_by_case, { [FAILURE]: 3, [SUCCESS]: 1 });
  // A final run repeats the code of its screen run by design.
  assert.ok(!loopStatus(repo, CHANGE).warnings.some((warning) => warning.startsWith('The last two runs used the same code')));

  // The run wrote its report: Result and Changes from the records, Notes free.
  const text = readFileSync(final.report.file, 'utf8');
  assert.match(text, new RegExp(`^# ${CHANGE}: run ${final.run_id} \\(final run of ${screen.run_id}\\)$`, 'm'));
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/3\) → pass \(3\/3\) \| holds \(fixed\) \|$/m);
  assert.ok(text.includes(`Eval package and project kit files changed since screen run ${screen.run_id}:\n- none\n\nSame code as screen run ${screen.run_id}: no file changed.\n`), text);
  assert.doesNotMatch(text, /^## Review/m);
  assert.match(text, /^## Notes$/m);
  assert.deepEqual(writeReport(repo, CHANGE).created, false);

  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(factsOf(status.situation), { code: 'acceptable', run_id: final.run_id, role: 'final', screen_run: screen.run_id });
  // The review of the screen run covers its final run, which ran the same code.
  assert.deepEqual(status.gates.accept, []);
  assert.deepEqual(status.suggestion.command, ['loop', 'accept', CHANGE, '--repo', repo, '--run', final.run_id, '--by', '<user>', '--ref', '<where they said so>']);
  assert.deepEqual([status.strength.attempts, status.strength.pass_all_chance, status.strength.single_sample, status.strength.sentence],
    [3, { fails_half: 0.125, fails_one_in_ten: 0.729 }, false, STRENGTH_FIRST_FINAL]);
  // What the user is shown before deciding.
  assert.deepEqual(Object.keys(status.must_show), ['checks', 'strength', 'reviews', 'usage', 'final_runs_of_change']);
  assert.equal(status.must_show.strength[0].sentence, STRENGTH_FIRST_FINAL);
  assert.deepEqual(status.must_show.reviews.map((review) => review.run_id), [screen.run_id]);
  assert.deepEqual(status.must_show.checks.map((entry) => [entry.case, entry.check, entry.label]), [[FAILURE, 'c1', 'holds (fixed)'], [SUCCESS, 'c1', 'holds (kept)'], [SUCCESS, 'c2', 'holds (kept)']]);
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'acceptance' && entry.by === 'user' && entry.run_id === final.run_id), JSON.stringify(status.obligations));
  assert.deepEqual(status.runs.map((run) => run.role), ['screen', 'final']);
  assert.deepEqual([status.final.pending, status.final.finals], [false, [{ run_id: final.run_id, verdict: 'pass' }]]);

  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, ...CONSENT }), refusedWith('not_final'));
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual([accepted.final_run, accepted.screen_run], [final.run_id, screen.run_id]);
  assert.deepEqual(accepted.history, [
    { run_id: screen.run_id, role: 'screen', verdict: 'pass', code_digest: accepted.history[0].code_digest },
    { run_id: final.run_id, role: 'final', verdict: 'pass', code_digest: accepted.history[0].code_digest }]);
  assert.deepEqual(accepted.strength, status.strength);
  assert.deepEqual(accepted.run_plan.attempts_by_case, { [FAILURE]: 3, [SUCCESS]: 1 });
  assert.deepEqual([accepted.review.run_id, accepted.self_review], [screen.run_id, false]);
  assert.deepEqual([accepted.accepted.by, accepted.accepted.ref], ['Dana', 'thread 1']);
  assert.deepEqual(readJSON(path.join(root, 'accepted.json')).history, accepted.history);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.suggestion], ['done', 'accepted', null]);
});

test('a final run runs first the packages that failed before, and stops at the first one that fails', (t) => {
  // The code before the change fails SUCCESS, not FAILURE.
  const before = { [FAILURE]: { c1: 'pass' }, [SUCCESS]: { c1: 'fail', c2: 'pass' } };
  const project = readyProject(t, { live: [FAILURE], attempts: 3, results: before });
  const { repo, tools } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'fail', [`${SUCCESS}/c2`]: 'pass' }) });
  startLoop(repo, CHANGE);
  resultsOutsideCode(repo);
  const screen = passingScreen(project);
  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'fail', c2: 'pass' } });
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'fail']);
  assert.deepEqual(ranInOrder(tools, 1), [SUCCESS]);
  assert.deepEqual(final.skipped, [{ case: FAILURE, reason: 'final_stopped', after: SUCCESS }]);
  assert.deepEqual(final.failures_count, { cases: [SUCCESS], final_failed: true });
  const record = runRecord(project, final);
  assert.deepEqual([record.final_of, record.run_order, record.environment_ref.attempts_by_case], [screen.run_id, [SUCCESS], { [SUCCESS]: 1 }]);
  assert.deepEqual(record.skipped, final.skipped);
});

test('one failed final run means changing the code: the same code again is a screen run whose pass cannot lead to a final run', (t) => {
  const project = finalsLoop(t);
  const { repo, tools } = project;
  const varies = { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } };
  const screen = passingScreen(project, varies, 'Try a change whose result varies');
  assertFinalDue(loopStatus(repo, CHANGE), screen.run_id, repo);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict, final.acceptable], ['final', 'fail', false]);
  assert.deepEqual(ranInOrder(tools, 1), [FAILURE]);
  assert.deepEqual(attemptsAsked(tools, 1), { [FAILURE]: '3' });
  assert.deepEqual(final.skipped, [{ case: SUCCESS, reason: 'final_stopped', after: FAILURE }]);
  // The failure counts for this code: no run of it can be accepted.
  assert.deepEqual(final.failures_count, { cases: [FAILURE], final_failed: true });
  assert.deepEqual(runRecord(project, final).run_order, [FAILURE]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(factsOf(status.situation), { code: 'final_failed', run_id: final.run_id, final_of: screen.run_id,
    failed: [{ case: FAILURE, check: 'c1', passed: 2, attempts: 3 }], errored: false });
  assert.match(status.situation.message, /one more failed final run of this loop stops it \(stop_unstable\)/);
  assert.deepEqual([status.final.failed, status.final.candidate, status.final.pending], [[final.run_id], null, false]);
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT }), refusedWith('not_passing'));

  // The same code again is a screen run; its pass is burned by the failure.
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict, again.acceptable, again.failed_before], ['screen', 'pass', false, [final.run_id]]);
  assert.deepEqual(attemptsAsked(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['screen_burned', again.run_id], JSON.stringify(status.situation));
  assert.deepEqual([...new Set(status.situation.failures.map((entry) => `${entry.case}/${entry.check} in ${entry.run_id}`))], [`${FAILURE}/c1 in ${final.run_id}`]);
  assert.equal(status.final.candidate, null);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: again.run_id, ...CONSENT }), (error) => {
    refusedWith('not_final')(error);
    refusedWith('unstable')(error);
    assertGapShape(error.gaps.find((entry) => entry.code === 'unstable'), { owner: 'user', layer: 'code' });
    return true;
  });
});

test('a second failed final run, on other code, stops the loop for good', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const first = startRun(repo, CHANGE);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'pass', 'fail'] } }, 'Try another change whose result varies');
  const second = startRun(repo, CHANGE);
  assert.deepEqual([second.role, second.verdict], ['final', 'fail']);
  let status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assertGapShape(status.gates.head_run, { code: 'stop_unstable', owner: 'user', layer: 'code' });
  const failed = [{ case: FAILURE, check: 'c1', passed: 2, attempts: 3 }];
  assert.deepEqual(status.ended.failed_finals, [{ run_id: first.run_id, failed }, { run_id: second.run_id, failed }]);
  assert.deepEqual(status.final.failed, [first.run_id, second.run_id]);
  // A new loop is the user's decision; it keeps the start code, and the failures of the same code still count.
  assert.deepEqual(status.ended.start_code, status.loop.start_code);
  assert.equal(status.ended.new_loop.gates.find((entry) => entry.gate === 'user_consent').holds, false);
  // Changing the code does not lift the stop: the third run is refused.
  changeCode(repo, AFTER, 'Make the notice handler deterministic');
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  lockedBeforeRun(project, {}, 'stop_unstable');
});

test('a final run that passed and a later failure of its code stop the loop as unstable, and the final run cannot be accepted', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.equal(final.verdict, 'pass');
  assert.equal(loopStatus(repo, CHANGE).situation.code, 'acceptable');
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } });
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.deepEqual([partial.role, partial.verdict], [null, 'fail']);
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.ended.contradicted.map((group) => [group.case, group.check, group.fail]), [[FAILURE, 'c1', [partial.run_id]]]);
  assert.ok(status.ended.contradicted[0].pass.includes(final.run_id), JSON.stringify(status.ended.contradicted));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT }), (error) => {
    refusedWith('unstable')(error);
    refusedWith('stop_unstable')(error);
    return true;
  });
});

test('a final run with missing evidence and no failure is run once more on the same code; a second one stops the loop for the user', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } });
  const first = startRun(repo, CHANGE);
  assert.deepEqual([first.role, first.verdict, first.execution_status, first.acceptable], ['final', 'unverified', 'completed', false]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: first.run_id, ...CONSENT }), refusedWith('not_passing'));
  // Without a failure the final run goes on to the next package.
  assert.deepEqual(runRecord(project, first).run_order, [FAILURE, SUCCESS]);
  let status = loopStatus(repo, CHANGE);
  assertFinalDue(status, screen.run_id, repo);
  assert.deepEqual([status.situation.incomplete, status.situation.unknown], [[first.run_id], [`${FAILURE}/c1`]]);
  assert.deepEqual([status.final.candidate, status.final.pending, status.final.incomplete], [screen.run_id, true, [first.run_id]]);
  const second = startRun(repo, CHANGE);
  assert.deepEqual([second.role, runRecord(project, second).final_of, second.verdict], ['final', screen.run_id, 'unverified']);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_incomplete');
  assertGapShape(status.gates.head_run, { code: 'stop_incomplete', owner: 'user', layer: 'loop' });
  assert.deepEqual([status.ended.runs, status.ended.screen_runs, status.ended.unknown], [[first.run_id, second.run_id], [screen.run_id], [`${FAILURE}/c1`]]);
  assert.deepEqual([status.final.pending, status.final.incomplete], [false, [first.run_id, second.run_id]]);
  // No further run of this loop: no third final run of that code.
  setResults(repo, AFTER);
  lockedBeforeRun(project, {}, 'stop_incomplete');
  // Once the user agrees to a new loop, the same code is screened and run once more.
  startLoop(repo, CHANGE);
  const next = fullRun(repo);
  assert.deepEqual([next.role, next.verdict], ['screen', 'pass']);
  assertFinalDue(loopStatus(repo, CHANGE), next.run_id, repo);
  const third = startRun(repo, CHANGE);
  assert.deepEqual([third.role, runRecord(project, third).final_of, third.verdict], ['final', next.run_id, 'pass']);
});

test('a final run whose execution errored does not count: the next run on the same code is the final run again', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: 'exception' });
  const errored = startRun(repo, CHANGE);
  assert.deepEqual([errored.role, errored.execution_status, errored.unverified_by.includes('execution_incomplete')], ['final', 'error', true]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(factsOf(status.situation), { code: 'execution_incomplete', run_id: errored.run_id, failed_checks: [] });
  assert.deepEqual([status.final.candidate, status.final.pending, status.final.incomplete, status.final.finals], [screen.run_id, true, [], []]);
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
  setResults(repo, AFTER);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, runRecord(project, final).final_of, final.verdict], ['final', screen.run_id, 'pass']);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', final.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.runs.map((run) => [run.role, run.execution_status]), [['screen', 'completed'], ['final', 'error'], ['final', 'completed']]);
});

test('stuck compares the last two full runs of any role over the packages both ran, and is a warning', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const final = startRun(repo, CHANGE);
  assert.deepEqual(final.skipped.map((entry) => entry.case), [SUCCESS]);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } }, 'Try another change');
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'fail']);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assert.ok(status.warnings.includes(`stuck: the same gating checks failed in the last two runs on different code: ${FAILURE}/c1=fail.`), JSON.stringify(status.warnings));
  // The user did not ask to stop on it, so the loop goes on.
  assert.deepEqual([status.phase, status.ended, status.gates.head_run, status.situation.code], ['live', null, null, 'open']);
});

test('final runs count toward the budget, and a final run past it stops on budget until the user revises it', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 2, minutes: 60 });
  passingScreen(project);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.loop.used.iterations], ['final_run_due', 1]);
  const final = startRun(repo, CHANGE);
  assert.equal(final.role, 'final');
  status = loopStatus(repo, CHANGE);
  // The budget is used up, and the passing final run can still be accepted.
  assert.deepEqual([status.phase, status.situation.code, status.loop.used.iterations, status.gates.accept], ['closing', 'acceptable', 2, []]);

  const short = readyProject(t, { live: [FAILURE], attempts: 3 });
  startRun(short.repo, CHANGE, { baseline: true, expect: writeExpectations(short.repo, EXPECT) });
  // The first full run is a screen run, so one run never reaches a final run.
  const started = startLoop(short.repo, CHANGE, { iterations: 1, minutes: 60 });
  assert.ok(started.warnings.includes('A budget of 1 full run leaves no room for a final run: in this loop the first full run is a screen run, and only a passing final run after it can be accepted.'), JSON.stringify(started.warnings));
  const only = passingScreen(short, AFTER, 'Stop the success notice when a submission fails', { review: false });
  status = loopStatus(short.repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  // Only the final run is left, and what it takes is stated.
  assert.equal(status.ended.screen_run, only.run_id);
  assert.deepEqual([status.ended.situation.code, status.ended.situation.candidate, status.ended.situation.final_plan],
    ['final_run_due', only.run_id, { packages: [FAILURE], attempts: 3, others_once: [SUCCESS] }]);
  assert.equal(typeof status.ended.situation.estimate.minutes, 'number');
  // The user lets the loop go on with one more run; the final run is due again.
  const revised = budgetLoop(short.repo, CHANGE, { iterations: 2, ...CONSENT });
  assert.deepEqual([revised.resumed, revised.budget.iterations, revised.revision.from.iterations, revised.revision.by], [true, 2, 1, CONSENT.by]);
  assertFinalDue(loopStatus(short.repo, CHANGE), only.run_id, short.repo);
  assert.equal(startRun(short.repo, CHANGE).role, 'final');
});

test('without a package that varies, or with one attempt, no run is a screen or a final run and a reviewed passing run is accepted', (t) => {
  const project = inLoop(t);
  const { repo, tools } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.deepEqual([run.role, runRecord(project, run).role, run.acceptable], [null, null, true]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.final, { needed: false, attempts: null, live: [], candidate: null, pending: false, finals: [], failed: [], incomplete: [], stops_at_failed: 2 });
  assert.deepEqual(status.runs.map((entry) => entry.role), [null]);
  assert.deepEqual(factsOf(status.situation), { code: 'acceptable', run_id: run.run_id, role: null, screen_run: null });
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  reviewRun(project, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.deepEqual([accepted.final_run, accepted.screen_run, accepted.history.map((entry) => entry.role)], [null, null, [null]]);
  // The plan of such a loop is fixed too, also once the user accepted it.
  const refusal = refusedBeforeRun(project, { model: 'synthetic/m1' }, 'run_plan_fixed');
  assert.deepEqual([refusal.differs, refusal.plan.tier], [[{ key: 'model', given: 'synthetic/m1', plan: null }], 'light']);
  assert.ok(tools.runs().length > 0);

  // One attempt of a live package: the plan has nothing to repeat.
  const one = liveLoop(t, 1);
  changeCode(one.repo, AFTER, 'Stop the success notice when a submission fails');
  const single = fullRun(one.repo);
  assert.deepEqual([single.role, single.attempts], [null, { [FAILURE]: 1, [SUCCESS]: 1 }]);
  status = loopStatus(one.repo, CHANGE);
  assert.deepEqual([status.final.needed, status.final.live], [false, [FAILURE]]);
});

test('a full run recorded before runs had a role that ran the plan\'s attempts reads as a final run, and is reviewed and accepted', (t) => {
  const project = liveLoop(t, 3);
  const { repo, runs, root } = project;
  const screen = passingScreen(project, AFTER, 'Stop the success notice when a submission fails', { review: false });
  const final = startRun(repo, CHANGE);
  // Today the run index keeps every run: a screen run whose folder is removed counts as a failure of its code, the final run's.
  rmSync(path.join(runs, screen.run_id), { recursive: true, force: true });
  rmSync(path.join(root, 'reports', `${screen.run_id}.md`));
  const lost = loopStatus(repo, CHANGE);
  assert.deepEqual(lost.loop.lost_runs, [screen.run_id]);
  assertEnded(lost, 'stop_unstable');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT }), refusedWith('unstable'));
  // The loop as an earlier release left it: no run index, no final review, and one full run that ran the plan, with no role.
  withoutLedger(project);
  const file = path.join(runs, final.run_id, 'run.json');
  const { role, final_of: finalOf, run_order: order, ...record } = readJSON(file);
  assert.deepEqual([role, finalOf, order], ['final', screen.run_id, [FAILURE, SUCCESS]]);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.role), ['final']);
  assert.deepEqual(factsOf(status.situation), { code: 'acceptable', run_id: final.run_id, role: 'final', screen_run: null });
  // Acceptance needs a final review of its code, recorded now.
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  reviewRun(project, final.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assert.ok(status.strength.sentence.startsWith(STRENGTH_3), status.strength.sentence);
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT });
  assert.deepEqual([accepted.final_run, accepted.screen_run, accepted.review.run_id], [final.run_id, null, final.run_id]);
});

test('a head run outside a loop is no final run: after it, one failed final run of the loop still means changing the code', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // A head run on the code before the change, before the loop: it fails as the baseline does.
  const outside = startRun(repo, CHANGE);
  assert.deepEqual([outside.role, outside.verdict, outside.in_loop, outside.acceptable, runRecord(project, outside).role], [null, 'fail', false, false, null]);
  startLoop(repo, CHANGE);
  resultsOutsideCode(repo);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'fail']);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'final_failed', JSON.stringify(status.situation));
  assert.match(status.situation.message, /one more failed final run of this loop stops it \(stop_unstable\)/);
  assert.deepEqual(status.final.failed, [final.run_id]);
});

test('full runs recorded before runs had a role that failed are ordinary iterations, not failed final runs', (t) => {
  const project = finalsLoop(t);
  const { repo, runs } = project;
  const failing = { ...AFTER, [FAILURE]: { c1: 'fail' } };
  const made = [];
  for (const label of ['First try', 'Second try']) {
    changeCode(repo, failing, label);
    const run = fullRun(repo);
    assert.deepEqual([run.role, run.verdict], ['screen', 'fail']);
    made.push(run);
  }
  assert.equal(loopStatus(repo, CHANGE).stuck, true);
  // As an earlier release recorded them: no run index, no role, and the plan's attempts.
  withoutLedger(project);
  for (const run of made) {
    const file = path.join(runs, run.run_id, 'run.json');
    const { role, ...record } = readJSON(file);
    assert.equal(role, 'screen');
    record.environment_ref.attempts_by_case = { [FAILURE]: 3, [SUCCESS]: 1 };
    record.environment_ref.attempts = 3;
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  // A failed run without a role is a screen run, whatever attempts it made, so two of them stop nothing.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.role), ['screen', 'screen']);
  assert.deepEqual(status.final.failed, []);
  assert.deepEqual([status.phase, status.ended, status.stuck, status.situation.code], ['live', null, true, 'open'], JSON.stringify(status.situation));
});

test('a full run of the code of a passing final run is a screen run, and the final run stays the one to accept', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  // Run again on the same code.
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict, again.acceptable, again.final_passed_before], ['screen', 'pass', false, final.run_id]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(factsOf(status.situation), { code: 'acceptable', run_id: final.run_id, role: 'final', screen_run: screen.run_id, repeated_by: again.run_id });
  assert.equal(status.suggestion.command[status.suggestion.command.indexOf('--run') + 1], final.run_id);
  assert.equal(status.strength.sentence, STRENGTH_FIRST_FINAL);
  // Another run of it changes nothing.
  const third = fullRun(repo);
  assert.equal(third.role, 'screen');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id, status.situation.repeated_by], ['acceptable', final.run_id, third.run_id]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: again.run_id, ...CONSENT }), refusedWith('not_final'));
  acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT });
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
});

test('a screen run that passed on code that already failed stops on budget once the runs are used up', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 3, minutes: 60 });
  resultsOutsideCode(repo);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'fail']);
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.loop.used.iterations, 3);
  // Where the loop stood when the budget ran out.
  assert.deepEqual([status.ended.situation.code, status.ended.situation.run_id], ['screen_burned', again.run_id], JSON.stringify(status.ended.situation));
  assert.deepEqual([...new Set(status.ended.situation.failures.map((entry) => entry.run_id))], [final.run_id]);
});

test('after two failed final runs, another run of the same code keeps the loop stopped for the user', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const first = startRun(repo, CHANGE);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'pass', 'fail'] } }, 'Try another change whose result varies');
  const second = startRun(repo, CHANGE);
  assertEnded(loopStatus(repo, CHANGE), 'stop_unstable');
  // The same code again, with no change, is refused before Harbor.
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } });
  lockedBeforeRun(project, {}, 'stop_unstable');
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.ended.failed_finals.map((entry) => entry.run_id), [first.run_id, second.run_id]);
});

test('a final run records its packages in the order they ran', (t) => {
  // The code before the change fails SUCCESS, which sorts after FAILURE.
  const before = { [FAILURE]: { c1: 'pass' }, [SUCCESS]: { c1: 'fail', c2: 'pass' } };
  const project = readyProject(t, { live: [FAILURE], attempts: 3, results: before });
  const { repo, tools } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'fail', [`${SUCCESS}/c2`]: 'pass' }) });
  startLoop(repo, CHANGE);
  resultsOutsideCode(repo);
  passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  assert.deepEqual(ranInOrder(tools, 2), [SUCCESS, FAILURE]);
  const record = runRecord(project, final);
  assert.deepEqual(record.run_order, [SUCCESS, FAILURE]);
  assert.deepEqual(record.cases.map((item) => item.id), [SUCCESS, FAILURE]);
});

test('loop status names the final run whenever one is due on the code as it is now, as run start makes it', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const label = 'Stop the success notice when a submission fails';
  const screen = passingScreen(project, AFTER, label);
  assertFinalDue(loopStatus(repo, CHANGE), screen.run_id, repo);
  changeCode(repo, BROKEN, 'Try something else');
  const other = fullRun(repo);
  assert.deepEqual([other.role, other.verdict], ['screen', 'fail']);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'regression', JSON.stringify(status.situation));
  assert.deepEqual(status.regressions.map((entry) => [entry.case, entry.check, entry.failing_run]), [[SUCCESS, 'c1', other.run_id]]);
  // The code of the screen run again: its final run is due.
  changeCode(repo, AFTER, label);
  status = loopStatus(repo, CHANGE);
  assertFinalDue(status, screen.run_id, repo);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, runRecord(project, final).final_of], ['final', screen.run_id]);
});

test('in a new project the user confirms the checks before the packages are connected, and the baseline then records that nothing could run', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], live: [FAILURE], confirm: false, results: {} });
  const { repo } = project;
  let flow = checkWorkflow(repo, 'run-eval', CHANGE);
  // The user's confirmation is pending: eval review gives what they decide on.
  assert.deepEqual(flow.suggestion.command, ['eval', 'review', CHANGE, '--repo', repo]);
  assert.ok(allowedActions(flow).includes('eval confirm --verdicts --by --ref'), JSON.stringify(allowedActions(flow)));
  assert.ok(!allowedActions(flow).includes('loop start --by --ref'));
  // A baseline before the confirmation cannot settle the number of attempts, not even one that runs nothing.
  const undecided = refusedBeforeRun(project, { baseline: true, unavailable: 'no_implementation', attempts: 3 }, 'attempts_undecided');
  assertGapShape(undecided, { owner: 'user', layer: 'confirmation' });
  const confirmed = confirmChecks(project, { attempts: 3, tier: 'full' });
  assert.deepEqual([confirmed.new_loop_needs, confirmed.connect_first, confirmed.baseline.recorded], [{ baseline: true, user_consent: true }, true, null]);
  flow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.ok(allowedActions(flow).includes('run start --baseline --unavailable'), JSON.stringify(allowedActions(flow)));
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.is_baseline, base.run_plan.attempts, base.run_plan.source, base.loop_baseline.usable], [false, 3, 'confirmation', true]);
  flow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.ok(allowedActions(flow).includes('loop start --by --ref'), JSON.stringify(allowedActions(flow)));
  assert.deepEqual(flow.suggestion.command.slice(0, 2), ['loop', 'start']);
});

test('a baseline cannot fix its own number of attempts before the user confirms them, and a confirmed budget of one full run leaves no room for a final run', (t) => {
  const project = readyProject(t, { live: [FAILURE], confirm: false });
  const { repo } = project;
  const undecided = refusedBeforeRun(project, { baseline: true, attempts: 3, expect: writeExpectations(repo, EXPECT) }, 'attempts_undecided');
  assertGapShape(undecided, { owner: 'user', layer: 'confirmation' });
  const result = confirmChecks(project, { attempts: 3, iterations: 1, minutes: 60 });
  assert.ok(result.warnings.includes('A budget of 1 full run leaves no room for a final run: a package with a live dependency runs 3 times, so each iteration\'s full run is a screen run, and only a passing final run after it can be accepted.'), JSON.stringify(result.warnings));
  assert.deepEqual([result.new_loop_needs, result.suggestion.command.slice(0, 3)], [{ baseline: true, user_consent: true }, ['run', 'start', CHANGE]]);
  // The baseline reads the plan from the confirmation.
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([base.is_baseline, base.run_plan.attempts, base.run_plan.source, base.run_plan.confirmation], [true, 3, 'confirmation', result.confirmation.id]);
});

// --- Later runs against an acceptance, final runs with an errored attempt. ---

test('a gating check added after the acceptance that fails in a later full run of the accepted code withdraws the acceptance', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  // app/results.json already says c3 fails; until c3 is declared, it is ignored.
  changeCode(repo, { ...AFTER, [SUCCESS]: { ...AFTER[SUCCESS], c3: 'fail' } }, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  reviewRun(project, passed.run_id);
  acceptLoop(repo, CHANGE, { run: passed.run_id, ...CONSENT });
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks.push({ ...declared.checks.find((check) => check.id === 'c1'), id: 'c3' });
    for (const fixture of declared.fixtures) fixture.expect.c3 = fixture.expect.c1;
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const later = startRun(repo, CHANGE);
  assert.deepEqual([later.execution_status, later.verdict], ['completed', 'fail']);
  const status = loopStatus(repo, CHANGE);
  assert.notEqual(status.phase, 'done', JSON.stringify(status.situation));
  assert.equal(status.accepted, false);
  assert.equal(status.acceptance.outdated, true);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Run ${later.run_id}, after the user accepted run ${passed.run_id}, fails, so the acceptance no longer covers this loop.`)), JSON.stringify(status.warnings));
});

test('a latest run that did not complete is not compared for regressions, also as an older CLI recorded its graded failure', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'the fix');
  fullRun(repo);
  changeCode(repo, { ...AFTER, [SUCCESS]: 'exception' }, 'another edit');
  const errored = startRun(repo, CHANGE);
  assert.deepEqual([errored.execution_status, errored.verdict], ['error', 'unverified']);
  // As an older release recorded an exception trial: no run index, the verifier's results kept, the run failed.
  withoutLedger(project);
  const folder = path.join(project.runs, errored.run_id);
  writeFileSync(path.join(folder, 'run.json'), `${JSON.stringify({ ...readJSON(path.join(folder, 'run.json')), verdict: 'fail' }, null, 2)}\n`);
  rmSync(path.join(folder, SUCCESS, 'attempts.json'), { force: true });
  writeFileSync(path.join(folder, SUCCESS, 'check-results.json'), JSON.stringify({ results: [{ id: 'c1', result: 'fail', evidence: 'x' }, { id: 'c2', result: 'pass', evidence: 'x' }] }));
  const compare = readJSON(path.join(folder, 'compare.json'));
  for (const entry of compare.results) if (entry.case === SUCCESS && entry.check === 'c1') Object.assign(entry, { after: 'fail', verdict: 'violated' });
  writeFileSync(path.join(folder, 'compare.json'), `${JSON.stringify(compare, null, 2)}\n`);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['execution_incomplete', errored.run_id], JSON.stringify(status.situation));
  assert.deepEqual([status.regressions, status.lost_progress], [[], []]);
});

test('a final run that failed in an attempt that completed counts as a failed final run, also when another attempt errored', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: ['exception', { c1: 'fail' }, { c1: 'pass' }] });
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.execution_status, final.verdict], ['final', 'error', 'fail']);
  assert.deepEqual(final.skipped.filter((entry) => entry.reason === 'final_stopped').map((entry) => entry.case), [SUCCESS]);
  // The failure is a result of the code and counts, whatever else errored.
  assert.deepEqual(final.failures_count, { cases: [FAILURE], final_failed: true });
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.final.failed, [final.run_id]);
  assert.equal(status.final.candidate, null);
  assert.deepEqual(factsOf(status.situation), { code: 'final_failed', run_id: final.run_id, final_of: screen.run_id,
    failed: [{ case: FAILURE, check: 'c1', passed: 1, attempts: 3 }], errored: true });
});

test('a screen run with an errored package and a failure in an attempt that completed says the failure counts', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  changeCode(repo, { [FAILURE]: { c1: 'fail' }, [SUCCESS]: 'exception' }, 'A first try');
  const screen = startRun(repo, CHANGE);
  assert.deepEqual([screen.role, screen.execution_status, screen.verdict], ['screen', 'error', 'fail']);
  assert.deepEqual(screen.failures_count, { cases: [FAILURE] });
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(factsOf(status.situation), { code: 'execution_incomplete', run_id: screen.run_id, failed_checks: [`${FAILURE}/c1`] });
});

test('a loop that needs a final run keeps needing it once the live package\'s git-ignored eval check record is gone, so its screen run is not accepted', (t) => {
  const project = finalsLoop(t);
  const { repo, root } = project;
  const screen = passingScreen(project);
  assert.equal(loopStatus(repo, CHANGE).final.needed, true);
  // checks/ is not in Git: a fresh checkout of it, or a removal, takes the record away.
  rmSync(path.join(root, 'checks', FAILURE), { recursive: true, force: true });
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.final.needed, status.final.live], [true, [FAILURE]], JSON.stringify(status.final));
  assertFinalDue(status, screen.run_id);
  // A run would skip the package until eval check proves it again.
  assert.deepEqual(status.situation.unchecked, [FAILURE]);
  assert.deepEqual(status.suggestion.command, ['eval', 'check', CHANGE, '--repo', repo]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, ...CONSENT }), refusedWith('not_final'));
  assert.equal(existsSync(path.join(root, 'accepted.json')), false);
  // Proved again, the final run follows as before.
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict, final.attempts[FAILURE]], ['final', 'pass', 3]);
});
