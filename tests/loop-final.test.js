// Loop tests: screen runs and the final run, including final runs with an
// errored attempt.
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
  loopPath, loopRecord, changePackage, resultsOutsideCode, liveLoop, gapOf, STRENGTH_3, FINAL_COST, FINAL_RUN, finalsLoop, passingScreen, newProjectLoop,
  refusedBeforeRun, assertEnded, assertStopBudget,
} from './helpers/loop.js';

// --- Screen runs and the final run ---

// The -k each of the last count Harbor runs was given, by package.
const attemptsAsked = (tools, count) => Object.fromEntries(tools.runs().slice(-count)
  .map((call) => [path.basename(call.argv[call.argv.indexOf('-p') + 1]), call.argv[call.argv.indexOf('-k') + 1]]));
// The packages of the last count Harbor runs, in the order they ran.
const ranInOrder = (tools, count) => tools.runs().slice(-count).map((call) => path.basename(call.argv[call.argv.indexOf('-p') + 1]));
// The sentence ask_acceptance gives for what the loop's runs took, where the
// adapter reported no usage.
const usedText = (status) => ` The loop used ${status.loop.usage.minutes} minutes over ${status.loop.usage.runs} run${status.loop.usage.runs === 1 ? '' : 's'}.`;

const LINE_ZERO = '本次提交发送的成功通知数量为零';

test('an acceptance an older CLI recorded for a screen run stays done, with a warning that loop accept would refuse it today', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('not_final'));
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
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.equal(status.runs.find((entry) => entry.run_id === screen.run_id).role, 'screen');
  assert.ok(status.warnings.includes(`The accepted run ${screen.run_id} is a screen run: its pass rests on one attempt of each package, and this loop needs a passing final run, which \`loop accept\` asks for now (not_final). So this acceptance would be refused today. It stays recorded; tell the user.`), JSON.stringify(status.warnings));
  // An acceptance of a final run says nothing of the kind.
  const accepted = path.join(project.root, 'accepted.json');
  rmSync(accepted);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  completeReport(repo, final.run_id);
  acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 2' });
  const done = loopStatus(repo, CHANGE);
  assert.equal(done.next.action, 'done', JSON.stringify(done.next));
  assert.deepEqual(done.warnings.filter((warning) => warning.includes('is a screen run')), []);
});

test('in a loop whose plan runs a live package more than once, a full run is a screen run of one attempt each, and its final review asks two questions before the final run', (t) => {
  const project = liveLoop(t, 3);
  const { repo, tools } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass']);
  assert.deepEqual(attemptsAsked(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.deepEqual(screen.attempts, { [FAILURE]: 1, [SUCCESS]: 1 });
  const record = runRecord(project, screen);
  assert.deepEqual([record.role, record.final_of, record.run_order, record.environment_ref.attempts], ['screen', undefined, undefined, 1]);
  assert.deepEqual(screen.warnings.filter((warning) => warning.startsWith('The settings of this run differ')), []);
  assert.equal(screen.next, 'The screen run passed: one attempt of each package is a lead, not a result. Run `loop status` next: the report and the final review come before the final run.');

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.deepEqual(status.final, { needed: true, attempts: 3, live: [FAILURE], candidate: null, pending: false, finals: [], failed: [], incomplete: [] });
  assert.deepEqual(status.runs.map((run) => run.role), ['screen']);
  completeReport(repo, screen.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_review', JSON.stringify(status.next));
  assert.deepEqual(status.next.flips, [{ case: FAILURE, check: 'c1', then: LINE_ZERO }]);
  assert.equal(status.next.message, 'The screen run passed: one attempt of each package. Before the final run, have the whole change reviewed in a fresh context against the Spec. The reviewer answers two things: for each gating check that went from fail to pass (next.flips), which change explains it; and whether each check is still faithful to its THEN line. Then write the Review section of this run\'s report: who reviewed, what they checked and found, and how each finding was handled, in at least 40 characters.');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('not_final'));

  completeReport(repo, screen.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.owner], ['final_run', 'agent']);
  assert.deepEqual(status.next.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(status.next.message, FINAL_RUN(screen.run_id, project.base.run_id));
  assert.deepEqual(status.final, { needed: true, attempts: 3, live: [FAILURE], candidate: screen.run_id, pending: true, finals: [], failed: [], incomplete: [] });
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    blockedWith('not_final')(error);
    assert.deepEqual(codes(error.gaps), ['not_final']);
    const entry = gapOf(error, 'not_final');
    assert.deepEqual([entry.owner, entry.route, entry.message], ['agent', 'loop-and-implement',
      `${screen.run_id} is a screen run: its pass rests on one attempt of each package. Run the final run, which \`loop status\` names as final_run, and accept that one.`]);
    return true;
  });
});

test('the final run follows the plan on the code of the screen run, its report says so, and only it is accepted, with the history of the loop', (t) => {
  const project = liveLoop(t, 3);
  const { repo, tools, root } = project;
  const screen = passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  assert.deepEqual(attemptsAsked(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  // FAILURE failed at the baseline, so it runs first.
  assert.deepEqual(ranInOrder(tools, 2), [FAILURE, SUCCESS]);
  const record = runRecord(project, final);
  assert.deepEqual([record.role, record.final_of, record.run_order], ['final', screen.run_id, [FAILURE, SUCCESS]]);
  assert.deepEqual(record.environment_ref.attempts_by_case, { [FAILURE]: 3, [SUCCESS]: 1 });
  assert.equal(final.next, 'The final run passed. Run `loop status` next: write its report, then ask the user to accept.');
  // A final run repeats the code of its screen run by design.
  assert.ok(!loopStatus(repo, CHANGE).warnings.some((warning) => warning.startsWith('The last two runs used the same code')));

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.doesNotMatch(status.next.message, /Leave Review/);
  const written = writeReport(repo, CHANGE);
  // Same code, every check holding: only Next is left.
  assert.equal(written.next, 'Fill in Next, then delete the template line. Review is filled in: the final review of the screen run covers this code.');
  const text = readFileSync(written.file, 'utf8');
  assert.match(text.split('\n')[0], /keep Result as written; write Next, then delete this line/);
  assert.match(text, new RegExp(`^# ${CHANGE}: run ${final.run_id} \\(final run of ${screen.run_id}\\)$`, 'm'));
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/3\) → pass \(3\/3\) \| holds \|$/m);
  assert.ok(text.includes(`Eval package and project kit files changed since screen run ${screen.run_id}:\n- none\n\nSame code as screen run ${screen.run_id}: no file changed.\n`), text);
  assert.ok(text.includes(`## Review\n\nThe final review of screen run ${screen.run_id} covers this code; see reports/${screen.run_id}.md.\n`), text);
  assert.match(text, /^- Every check holds\.$/m);
  assert.deepEqual(writeReport(repo, CHANGE).missing, ['the template line is still there', 'section Next is empty']);
  completeReport(repo, final.run_id, { review: false });

  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.equal(status.next.command[status.next.command.indexOf('--run') + 1], final.run_id);
  assert.deepEqual(status.next.strength, { attempts: 3, pass_all_chance: { fails_half: 0.125, fails_one_in_ten: 0.729 }, single_sample: false, sentence: STRENGTH_3 });
  assert.equal(status.next.message, `Show the user the per-check comparison of final run ${final.run_id}, its report and the report of screen run ${screen.run_id} with its Review, and this: ${STRENGTH_3}${usedText(status)} Record acceptance only with their own words; a pass is not acceptance.`);
  assert.deepEqual(status.runs.map((run) => run.role), ['screen', 'final']);
  assert.deepEqual([status.final.pending, status.final.finals], [false, [{ run_id: final.run_id, verdict: 'pass' }]]);

  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('not_final'));
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual([accepted.final_run, accepted.screen_run], [final.run_id, screen.run_id]);
  assert.deepEqual(accepted.history, [
    { run_id: screen.run_id, role: 'screen', verdict: 'pass', code_digest: accepted.code_digest },
    { run_id: final.run_id, role: 'final', verdict: 'pass', code_digest: accepted.code_digest }]);
  assert.deepEqual(accepted.strength, status.next.strength);
  assert.deepEqual(accepted.run_plan.attempts_by_case, { [FAILURE]: 3, [SUCCESS]: 1 });
  assert.deepEqual(readJSON(path.join(root, 'accepted.json')).history, accepted.history);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
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
  const record = runRecord(project, final);
  assert.deepEqual([record.final_of, record.run_order, record.environment_ref.attempts_by_case], [screen.run_id, [SUCCESS], { [SUCCESS]: 1 }]);
  assert.deepEqual(record.skipped, final.skipped);
});

test('one failed final run means changing the code: the same code again is a screen run whose pass cannot lead to a final run', (t) => {
  const project = finalsLoop(t);
  const { repo, tools } = project;
  const varies = { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } };
  const screen = passingScreen(project, varies, 'Try a change whose result varies');
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_run');
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'fail']);
  assert.deepEqual(ranInOrder(tools, 1), [FAILURE]);
  assert.deepEqual(attemptsAsked(tools, 1), { [FAILURE]: '3' });
  assert.deepEqual(final.skipped, [{ case: SUCCESS, reason: 'final_stopped', after: FAILURE }]);
  assert.equal(final.next, 'The final run failed, so this code can never be accepted. Run `loop status` next.');
  assert.deepEqual(runRecord(project, final).run_order, [FAILURE]);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'write_report');
  completeReport(repo, final.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.equal(status.next.message, `Final run ${final.run_id} of the code of screen run ${screen.run_id} failed: ${FAILURE}/c1 passed 2 of 3 attempts. A failure of the same code always counts, so this code can never be accepted, and one more failed final run of this loop stops it (stop_unstable). Read the failing attempts' logs (<case>/attempts.json names each trial), find what makes the result vary, change the code, and screen it again.`);
  assert.deepEqual([status.final.failed, status.final.candidate, status.final.pending], [[final.run_id], null, false]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('not_passing'));

  // The same code again is a screen run; its pass is burned by the failure.
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  assert.deepEqual(attemptsAsked(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.equal(again.next, `The screen run passed, but its code already failed a gating check in ${final.run_id}, so no final run of it can be accepted. Run \`loop status\` next: write its report, then change the code.`);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.match(status.next.message, / Leave Review empty: no final review follows for this code\.$/);
  completeReport(repo, again.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.equal(status.next.message, `Screen run ${again.run_id} passed, but its code failed ${FAILURE}/c1 in ${final.run_id}. A pass never cancels a failure of the same code, so no final run of it can be accepted. Change the code and screen it again.`);
  assert.equal(status.final.candidate, null);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: again.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('not_final')(error);
    refusedWith('unstable')(error);
    return true;
  });
});

test('a second failed final run, on other code, stops the loop for good', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const first = startRun(repo, CHANGE);
  completeReport(repo, first.run_id);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'pass', 'fail'] } }, 'Try another change whose result varies');
  const second = startRun(repo, CHANGE);
  assert.deepEqual([second.role, second.verdict], ['final', 'fail']);
  completeReport(repo, second.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_unstable', 'user'], JSON.stringify(status.next));
  assert.equal(status.next.message, `Two final runs of this loop failed: ${first.run_id} (${FAILURE}/c1 passed 2 of 3 attempts) and ${second.run_id} (${FAILURE}/c1 passed 2 of 3 attempts). Checks that fail some of the time on code that passed its screen run are not settled by running again. Stop and tell the user what the runs showed. This loop has ended: a code change does not lift this stop, and \`run start\` refuses its head runs. The user decides: find and fix what makes the result vary, or change the requirement through agent-spec. A new loop needs their go-ahead; it keeps the start code, and the failures of the same code still count.`);
  assert.deepEqual(status.final.failed, [first.run_id, second.run_id]);
  // Changing the code does not lift the stop: the third run is refused.
  changeCode(repo, AFTER, 'Make the notice handler deterministic');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  refusedBeforeRun(project, {}, 'stop_unstable');
});

test('a final run that passed and a later failure of its code stop the loop as unstable, and the final run cannot be accepted', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.equal(final.verdict, 'pass');
  completeReport(repo, final.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } });
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.deepEqual([partial.role, partial.verdict], [null, 'fail']);
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_unstable', 'user'], JSON.stringify(status.next));
  assert.equal(status.next.message, `Final run ${final.run_id} passed, but ${FAILURE}/c1 failed on the same code in ${partial.run_id}. Checks that fail some of the time on code that passed its screen run are not settled by running again. Stop and tell the user what the runs showed. This loop has ended: a code change does not lift this stop, and \`run start\` refuses its head runs. The user decides: find and fix what makes the result vary, or change the requirement through agent-spec. A new loop needs their go-ahead; it keeps the start code, and the failures of the same code still count.`);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('unstable'));
});

test('a final run with missing evidence and no failure is run once more on the same code; a second one goes to the user', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } });
  const first = startRun(repo, CHANGE);
  assert.deepEqual([first.role, first.verdict, first.execution_status], ['final', 'unverified', 'completed']);
  // Without a failure the final run goes on to the next package.
  assert.deepEqual(runRecord(project, first).run_order, [FAILURE, SUCCESS]);
  completeReport(repo, first.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_run', JSON.stringify(status.next));
  assert.equal(status.next.message, `Final run ${first.run_id} found no failure but missing evidence (unknown): ${FAILURE}/c1. Read its logs. If nothing in the packages or the project kit needs changing, such as a fault of the machine or of Docker, fix that and run the final run again on the same code with \`run start\`; a second incomplete final run goes to the user.${FINAL_COST(project.base.run_id)}`);
  assert.deepEqual([status.final.candidate, status.final.pending, status.final.incomplete], [screen.run_id, true, [first.run_id]]);
  const second = startRun(repo, CHANGE);
  assert.deepEqual([second.role, runRecord(project, second).final_of, second.verdict], ['final', screen.run_id, 'unverified']);
  completeReport(repo, second.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_incomplete', 'user'], JSON.stringify(status.next));
  const STOP_INCOMPLETE = `Two final runs of the code of screen run ${screen.run_id}, ${first.run_id} and ${second.run_id}, found no failure but left ${FAILURE}/c1 unknown, so no further final run of this code and these packages is made. Stop and tell the user what kept the evidence from being read. This loop has ended. The user decides how to go on; a new loop, once they agree, screens and reviews the code again before its final run, and a fix to a package or the kit needs \`eval check\`, \`eval review\` and their \`eval confirm\` first.`;
  assert.equal(status.next.message, STOP_INCOMPLETE);
  assert.deepEqual([status.final.pending, status.final.incomplete], [false, [first.run_id, second.run_id]]);
  // No further run of this loop: no third final run of that code.
  setResults(repo, AFTER);
  refusedBeforeRun(project, {}, 'stop_incomplete');
  // Once the user agrees to a new loop, the same code is screened, reviewed and run once more.
  startLoop(repo, CHANGE);
  const next = fullRun(repo);
  assert.deepEqual([next.role, next.verdict], ['screen', 'pass']);
  completeReport(repo, next.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_run');
  const third = startRun(repo, CHANGE);
  assert.deepEqual([third.role, runRecord(project, third).final_of, third.verdict], ['final', next.run_id, 'pass']);
});

test('a final run whose execution errored goes to repair_execution and does not count: the next run on the same code is the final run again', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: 'exception' });
  const errored = startRun(repo, CHANGE);
  assert.deepEqual([errored.role, errored.execution_status], ['final', 'error']);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'repair_execution', JSON.stringify(status.next));
  assert.deepEqual([status.final.candidate, status.final.pending, status.final.incomplete, status.final.finals], [screen.run_id, true, [], []]);
  setResults(repo, AFTER);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, runRecord(project, final).final_of, final.verdict], ['final', screen.run_id, 'pass']);
  completeReport(repo, final.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.deepEqual(status.runs.map((run) => [run.role, run.execution_status]), [['screen', 'completed'], ['final', 'error'], ['final', 'completed']]);
});

test('stuck compares the last two full runs of any role over the packages both ran', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const final = startRun(repo, CHANGE);
  assert.deepEqual(final.skipped.map((entry) => entry.case), [SUCCESS]);
  completeReport(repo, final.run_id);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } }, 'Try another change');
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'fail']);
  completeReport(repo, screen.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_stuck', 'user'], JSON.stringify(status.next));
  assert.equal(status.next.message, `The same gating checks failed in the last two runs on different code: ${FAILURE}/c1=fail. Stop, report what was tried, and ask the user how to proceed. This loop has ended: \`run start\` refuses its head runs. A code change does not lift this stop.`);
});

test('final runs count toward the budget, and a final run past it stops on budget', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 2, minutes: 60 });
  const screen = passingScreen(project);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.loop.used.iterations], ['final_run', 1]);
  const final = startRun(repo, CHANGE);
  assert.equal(final.role, 'final');
  completeReport(repo, final.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.loop.used.iterations], ['ask_acceptance', 2]);

  const short = readyProject(t, { live: [FAILURE], attempts: 3 });
  const shortBase = startRun(short.repo, CHANGE, { baseline: true, expect: writeExpectations(short.repo, EXPECT) });
  // The first full run is a screen run, so one run never reaches a final run.
  assert.ok(startLoop(short.repo, CHANGE, { iterations: 1, minutes: 60 }).warnings.includes('A budget of 1 full run leaves no room for a final run: in this loop the first full run is a screen run, and only a passing final run after it can be accepted, so it needs at least 2 full runs. Tell the user before the first run.'));
  const only = passingScreen(short);
  status = loopStatus(short.repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_budget', 'user'], JSON.stringify(status.next));
  // It says what the final run takes, and that only the final run is left.
  assert.match(status.next.message, new RegExp(`^The budget is used up \\(1 of 1 runs, \\d+ of 60 minutes\\)\\. Screen run ${only.run_id} passed and its final review is done; the final run needs more budget: ${FAILURE} runs 3 times and every other package once\\.`));
  assert.ok(status.next.message.endsWith(`once.${FINAL_COST(shortBase.run_id)} Stop and tell the user that only the final run is left, and what it takes. This loop has ended: \`run start\` refuses its head runs. A bigger budget goes to a new loop, once the user agrees: \`loop start --max-iterations N --max-minutes M\`. A new loop counts only its own runs, so it screens and reviews this code again before its final run: a screen run of the code as it is, with no change, then its report and the final review.`), status.next.message);
  assertStopBudget(status.next, short.repo, 'budget_used_up');
  assert.ok(!status.next.message.includes('what still fails'), status.next.message);
  assert.equal(screen.role, 'screen');
});

test('without a package that varies, or with one attempt, no run is a screen or a final run and a passing run is accepted as before', (t) => {
  const project = inLoop(t);
  const { repo, tools } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.deepEqual([run.role, runRecord(project, run).role], [null, null]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.final, { needed: false, attempts: null, live: [], candidate: null, pending: false, finals: [], failed: [], incomplete: [] });
  assert.deepEqual(status.runs.map((entry) => entry.role), [null]);
  completeReport(repo, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance');
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual([accepted.final_run, accepted.screen_run, accepted.history.map((entry) => entry.role)], [null, null, [null]]);
  // The plan of such a loop is fixed too, also once the user accepted it.
  assert.throws(() => startRun(repo, CHANGE, { attempts: 1 }), (error) => {
    refusedWith('run_plan_fixed')(error);
    assert.ok(error.gaps[0].message.startsWith('The user accepted the loop for this Spec export, and its run plan stays fixed: run start reads'), error.gaps[0].message);
    assert.doesNotMatch(error.gaps[0].message, /ends this loop/);
    return true;
  });
  assert.ok(tools.runs().length > 0);

  // One attempt of a live package: the plan has nothing to repeat.
  const one = liveLoop(t, 1);
  changeCode(one.repo, AFTER, 'Stop the success notice when a submission fails');
  const single = fullRun(one.repo);
  assert.deepEqual([single.role, single.attempts], [null, { [FAILURE]: 1, [SUCCESS]: 1 }]);
  assert.deepEqual([loopStatus(one.repo, CHANGE).final.needed, loopStatus(one.repo, CHANGE).final.live], [false, [FAILURE]]);
});

test('a full run recorded before runs had a role that ran the plan\'s attempts reads as a final run, and is reviewed and accepted', (t) => {
  const project = liveLoop(t, 3);
  const { repo, runs, root } = project;
  const screen = passingScreen(project);
  const final = startRun(repo, CHANGE);
  // The loop as an earlier release left it: one full run that ran the plan, with no role.
  rmSync(path.join(runs, screen.run_id), { recursive: true, force: true });
  rmSync(path.join(root, 'reports', `${screen.run_id}.md`));
  const file = path.join(runs, final.run_id, 'run.json');
  const { role, final_of: finalOf, run_order: order, ...record } = readJSON(file);
  assert.deepEqual([role, finalOf, order], ['final', screen.run_id, [FAILURE, SUCCESS]]);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.role), ['final']);
  assert.equal(status.next.action, 'write_report');
  const text = readFileSync(writeReport(repo, CHANGE).file, 'utf8');
  assert.match(text, /^<!-- Leave this empty until `loop status` says final_review\./m);
  completeReport(repo, final.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');
  completeReport(repo, final.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.ok(status.next.message.startsWith(`Show the user the per-check comparison of final run ${final.run_id}, its report, and this: ${STRENGTH_3}`), status.next.message);
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual([accepted.final_run, accepted.screen_run], [final.run_id, null]);
});

test('a head run outside a loop is no final run: after it, one failed final run of the loop still means changing the code', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // A head run on the code before the change, before the loop: it fails as the baseline does.
  const outside = startRun(repo, CHANGE);
  assert.deepEqual([outside.role, outside.verdict, runRecord(project, outside).role], [null, 'fail', null]);
  startLoop(repo, CHANGE);
  resultsOutsideCode(repo);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'fail']);
  completeReport(repo, final.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.match(status.next.message, /one more failed final run of this loop stops it \(stop_unstable\)/);
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
    completeReport(repo, run.run_id);
    made.push(run);
  }
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_stuck');
  // As an earlier release recorded them: no role, and the plan's attempts.
  for (const run of made) {
    const file = path.join(runs, run.run_id, 'run.json');
    const { role, ...record } = readJSON(file);
    assert.equal(role, 'screen');
    record.environment_ref.attempts_by_case = { [FAILURE]: 3, [SUCCESS]: 1 };
    record.environment_ref.attempts = 3;
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  // A failed run without a role is a screen run, whatever attempts it made.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.role), ['screen', 'screen']);
  assert.deepEqual(status.final.failed, []);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_stuck', 'user'], JSON.stringify(status.next));
});

test('a full run of the code of a passing final run asks for acceptance of that final run, and a missing report of it comes first', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  // Run again before the final run's report is written.
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  assert.equal(again.next, `The screen run passed, and final run ${final.run_id} of this code passed already: that is the run to accept. Run \`loop status\` next: write this run's report first.`);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.match(status.next.message, / Leave Review empty: no final review follows for this code\.$/);
  completeReport(repo, again.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report', JSON.stringify(status.next));
  assert.deepEqual(status.next.command, ['loop', 'report', CHANGE, '--repo', repo, '--run', final.run_id]);
  assert.ok(status.next.message.startsWith(`Final run ${final.run_id} passed on the code and packages of ${again.run_id}, so it is the run to accept. Write its report first: `), status.next.message);
  completeReport(repo, final.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.equal(status.next.command[status.next.command.indexOf('--run') + 1], final.run_id);
  assert.equal(status.next.message, `Show the user the per-check comparison of final run ${final.run_id}, its report and the report of screen run ${screen.run_id} with its Review, and this: ${STRENGTH_3} Screen run ${again.run_id} ran the same code again and adds nothing to accept.${usedText(status)} Record acceptance only with their own words; a pass is not acceptance.`);
  // Another run of it changes nothing.
  const third = fullRun(repo);
  assert.equal(third.role, 'screen');
  completeReport(repo, third.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
  acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
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
  completeReport(repo, final.run_id);
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  completeReport(repo, again.run_id, { review: false });
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.loop.used.iterations], ['stop_budget', 3], JSON.stringify(status.next));
  assert.match(status.next.message, new RegExp(`^The budget is used up \\(3 of 3 runs, \\d+ of 60 minutes\\)\\. Screen run ${again.run_id} passed, but its code failed ${FAILURE}/c1 in ${final.run_id}\\. A pass never cancels a failure of the same code, so no final run of it can be accepted\\. Another screen run needs more budget\\. Stop and report`));
});

test('after two failed final runs, another run of the same code keeps the loop stopped for the user', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const first = startRun(repo, CHANGE);
  completeReport(repo, first.run_id);
  passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'pass', 'fail'] } }, 'Try another change whose result varies');
  const second = startRun(repo, CHANGE);
  completeReport(repo, second.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_unstable');
  // The same code again, with no change, is refused before Harbor.
  setResults(repo, { ...AFTER, [FAILURE]: { c1: 'fail' } });
  refusedBeforeRun(project, {}, 'stop_unstable');
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.owner], ['stop_unstable', 'user'], JSON.stringify(status.next));
  assert.ok(status.next.message.startsWith(`Two final runs of this loop failed: ${first.run_id} (${FAILURE}/c1 passed 2 of 3 attempts) and ${second.run_id} (${FAILURE}/c1 passed 2 of 3 attempts).`), status.next.message);
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
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_run');
  changeCode(repo, BROKEN, 'Try something else');
  const other = fullRun(repo);
  assert.deepEqual([other.role, other.verdict], ['screen', 'fail']);
  completeReport(repo, other.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'split_changes');
  // The code of the screen run again: its final run is due.
  changeCode(repo, AFTER, label);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.final.candidate, status.final.pending], ['final_run', screen.run_id, true], JSON.stringify(status.next));
  assert.equal(status.next.message, FINAL_RUN(screen.run_id, project.base.run_id));
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, runRecord(project, final).final_of], ['final', screen.run_id]);
});

test('in a new project the user confirms the checks before the packages are connected, and the baseline then records that nothing could run', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], live: [FAILURE], confirm: false, results: {} });
  const { repo } = project;
  let check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.deepEqual([check.next.action, check.next.command], ['confirm_checks', ['eval', 'review', CHANGE, '--repo', repo]]);
  assert.match(confirmChecks(project, { attempts: 3 }).next, /^The checks are confirmed\. Record the baseline next/);
  check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check));
  assert.deepEqual(check.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', 'no_implementation']);
  assert.ok(check.next.note.startsWith('No package can run yet in this new project, so the baseline records that nothing could run: --unavailable no_implementation.'), check.next.note);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.is_baseline, base.run_plan.attempts, base.run_plan.source], [false, 3, 'confirmation']);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');

  // An unavailable baseline recorded before the confirmation, with the plan the user then confirms, is the one the loop starts on.
  const other = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], live: [FAILURE], confirm: false, results: {} });
  const early = startRun(other.repo, CHANGE, { baseline: true, unavailable: 'no_implementation', attempts: 3 });
  assert.equal(confirmChecks(other, { attempts: 3 }).next, `The checks are confirmed. That no baseline could run is recorded already (${early.run_id}), with this plan: start the loop next with \`loop start\`, which takes the budget the user confirmed.`);
  assert.equal(checkWorkflow(other.repo, 'run-eval', CHANGE).next.action, 'start_loop');
});

test('a baseline that fixed its own number of attempts is recorded again from the confirmation, and a confirmed budget of one full run leaves no room for a final run', (t) => {
  const project = readyProject(t, { live: [FAILURE], confirm: false });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, attempts: 3, expect: writeExpectations(repo, EXPECT) });
  writeFileSync(path.join(repo, '.dockerignore'), 'node_modules\n');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    assert.ok(gapOf(error, 'baseline_not_at_start').message.includes('record the baseline again instead, with the same --expect file and no --attempts, --agent or --model; the baseline reads the plan from confirmed.json. Otherwise:'), error.message);
    return true;
  });
  const result = confirmChecks(project, { attempts: 3, iterations: 1, minutes: 60 });
  assert.ok(result.warnings.includes('A budget of 1 full run leaves no room for a final run: a package with a live dependency runs 3 times, so each iteration\'s full run is a screen run, and only a passing final run after it can be accepted. A loop needs at least 2 full runs; tell the user.'), JSON.stringify(result.warnings));
});

// --- Later runs against an acceptance, final runs with an errored attempt,
// and the commands the messages name. ---

test('a gating check added after the acceptance that fails in a later full run of the accepted code withdraws the acceptance', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  // app/results.json already says c3 fails; until c3 is declared, it is ignored.
  changeCode(repo, { ...AFTER, [SUCCESS]: { ...AFTER[SUCCESS], c3: 'fail' } }, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  completeReport(repo, passed.run_id);
  acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks.push({ ...declared.checks.find((check) => check.id === 'c1'), id: 'c3' });
    for (const fixture of declared.fixtures) fixture.expect.c3 = fixture.expect.c1;
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const later = startRun(repo, CHANGE);
  assert.deepEqual([later.execution_status, later.verdict], ['completed', 'fail']);
  const status = loopStatus(repo, CHANGE);
  assert.notEqual(status.next.action, 'done', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, true);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Run ${later.run_id}, after the user accepted run ${passed.run_id}, fails, so the acceptance no longer covers this loop.`)), JSON.stringify(status.warnings));
});

test('a latest run that did not complete is not compared for regressions, also as an older CLI recorded its graded failure', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'the fix');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, { ...AFTER, [SUCCESS]: 'exception' }, 'another edit');
  const errored = startRun(repo, CHANGE);
  assert.deepEqual([errored.execution_status, errored.verdict], ['error', 'unverified']);
  // As an older release recorded an exception trial: the verifier's results kept, the run failed.
  const folder = path.join(project.runs, errored.run_id);
  writeFileSync(path.join(folder, 'run.json'), `${JSON.stringify({ ...readJSON(path.join(folder, 'run.json')), verdict: 'fail' }, null, 2)}\n`);
  rmSync(path.join(folder, SUCCESS, 'attempts.json'), { force: true });
  writeFileSync(path.join(folder, SUCCESS, 'check-results.json'), JSON.stringify({ results: [{ id: 'c1', result: 'fail', evidence: 'x' }, { id: 'c2', result: 'pass', evidence: 'x' }] }));
  const compare = readJSON(path.join(folder, 'compare.json'));
  for (const entry of compare.results) if (entry.case === SUCCESS && entry.check === 'c1') Object.assign(entry, { after: 'fail', verdict: 'violated' });
  writeFileSync(path.join(folder, 'compare.json'), `${JSON.stringify(compare, null, 2)}\n`);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'repair_execution');
  assert.deepEqual([status.regressions, status.lost_progress], [[], []]);
});

test('a final run that failed in an attempt that completed counts as a failed final run, also when another attempt errored', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  passingScreen(project);
  setResults(repo, { ...AFTER, [FAILURE]: ['exception', { c1: 'fail' }, { c1: 'pass' }] });
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.execution_status, final.verdict], ['final', 'error', 'fail']);
  assert.deepEqual(final.skipped.filter((entry) => entry.reason === 'final_stopped').map((entry) => entry.case), [SUCCESS]);
  assert.ok(final.next.startsWith('Execution did not complete: read cases[].execution.reason and each case\'s logs/harbor.log, and fix the cause. But submit-failure-s1 failed a gating check in an attempt that completed, which is a result of the code and counts: this final run failed, and this code can never be accepted. Run `loop status` next.'), final.next);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.final.failed, [final.run_id]);
  assert.equal(status.final.candidate, null);
  assert.equal(status.next.action, 'write_report', JSON.stringify(status.next));
  completeReport(repo, final.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.ok(status.next.message.startsWith(`Final run ${final.run_id} of the code of screen run`), status.next.message);
  assert.ok(status.next.message.includes('Another attempt of it did not complete: read cases[].execution.reason and each logs/harbor.log, and fix that cause too'), status.next.message);
});

test('a screen run with an errored package and a failure in an attempt that completed says the failure counts', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  changeCode(repo, { [FAILURE]: { c1: 'fail' }, [SUCCESS]: 'exception' }, 'A first try');
  const screen = startRun(repo, CHANGE);
  assert.deepEqual([screen.role, screen.execution_status, screen.verdict], ['screen', 'error', 'fail']);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'repair_execution');
  assert.ok(status.next.message.endsWith(`But ${FAILURE}/c1 failed in an attempt that completed, which is a result of the code and counts: no run of this code with these packages can be accepted. Fix the cause, then change the code before the next run.`), status.next.message);
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
  assert.equal(status.next.action, 'final_run', JSON.stringify(status.next));
  // A run would skip the package until eval check proves it again.
  assert.deepEqual(status.next.command, ['eval', 'check', CHANGE, '--repo', repo]);
  assert.match(status.next.message, new RegExp(`Prove ${FAILURE} with \`eval check\` first`));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('not_final'));
  assert.equal(existsSync(path.join(root, 'accepted.json')), false);
  // Proved again, the final run follows as before.
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict, final.attempts[FAILURE]], ['final', 'pass', 3]);
});
