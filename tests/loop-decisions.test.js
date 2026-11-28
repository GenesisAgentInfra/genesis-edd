// Loop tests: the records a loop keeps besides its runs, and the ways it ends
// that are recorded rather than worked out. A final review is bound to the code
// it reviewed; a loop ends with the agent's reason (loop end) or the user's
// decline; the user abandons a change, which releases its pinned start code;
// a disputed check waits for the user's ruling; the project's own tests are
// the agent's record. Each decision of the user is recorded with who decided
// and where, and acceptance shows what the user must see.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readDecisions } from '../src/records.js';
import { startRun } from '../src/run.js';
import { abandonChange, acceptLoop, budgetLoop, declineLoop, disputeLoop, endLoop, loopStatus, recordTests, reviewLoop } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { AFTER, BEFORE, CHANGE, CONSENT, REF, USER, allowedActions, assertGapShape, assertNoRoutes, cli, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, FAILURE, SUCCESS, assertEnded, blockedWith, changeCode, changePackage, codes, finalsLoop, fullRun, inLoop, passingScreen, refusedBeforeRun,
  refusedWith, reviewRun, runRecord, startLoop,
} from './helpers/loop.js';

const decisions = (project, type) => readDecisions(project.root).entries.filter((entry) => entry.type === type);
// A file outside the project with the given text: evidence or answers.
let files = 0;
function outside(project, text, name = 'evidence.txt') {
  files += 1;
  const file = path.join(project.tools.directory, `${files}-${name}`);
  writeFileSync(file, text);
  return file;
}
// A loop whose first full run failed on changed code, so the working
// directory holds other code than the loop's start code.
function triedLoop(t) {
  const project = inLoop(t);
  changeCode(project.repo, BEFORE, 'A first try that changes nothing');
  const run = fullRun(project.repo);
  assert.equal(run.verdict, 'fail');
  return { ...project, run };
}
// A loop with a passing full run of the light tier, whose final review is not recorded yet.
function passedLoop(t) {
  const project = inLoop(t);
  changeCode(project.repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(project.repo);
  assert.equal(run.verdict, 'pass');
  return { ...project, run };
}
// A base record on the code in the working directory, with the expectations of the code before the change.
const baseHere = (project) => ({ baseline: true, expect: writeExpectations(project.repo, EXPECT) });

// --- Final reviews ---

test('a final review covers only the code it reviewed: a passing final run of other code needs its own before acceptance', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const first = passingScreen(project, AFTER, 'Stop the success notice when a submission fails');
  // The code changes before the final run: the next full run is a screen run of that code.
  const second = passingScreen(project, AFTER, 'Read the submission result before any notice', { review: false });
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict, runRecord(project, final).final_of], ['final', 'pass', second.run_id]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', final.run_id]);
  assert.deepEqual(status.reviews.map((review) => review.run_id), [first.run_id]);
  const missing = status.gates.accept.find((entry) => entry.code === 'review_missing');
  assertGapShape(missing, { owner: 'agent', layer: 'loop', run: final.run_id });
  assert.deepEqual(status.suggestion.command.slice(0, 2), ['loop', 'review']);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT }), refusedWith('review_missing'));
  // A review of the final run covers both runs of its code.
  const reviewed = reviewRun(project, final.run_id, { reviewer: 'human', by: 'Reviewer Name' });
  assert.deepEqual([reviewed.covers, reviewed.review.reviewer, reviewed.review.by], [[second.run_id, final.run_id], 'human', 'Reviewer Name']);
  assert.equal(decisions(project, 'loop_review').length, 2);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT });
  assert.deepEqual([accepted.review.run_id, accepted.reviews.map((review) => review.run_id), accepted.self_review], [final.run_id, [final.run_id], false]);
});

test('loop review refuses a run that did not pass, a run the loop does not hold and answers that leave a flip unexplained, and a self review is shown to the user', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  const failing = fullRun(repo);
  assert.throws(() => reviewRun(project, failing.run_id), (error) => {
    blockedWith('not_passing')(error);
    assertGapShape(error.gaps[0], { code: 'not_passing', owner: 'agent', layer: 'loop', run: failing.run_id });
    return true;
  });
  const answers = outside(project, `${JSON.stringify({ flips: [], special_cases: { found: false, detail: null }, outside_spec: { found: false, detail: null },
    side_effects: { found: false, detail: null }, notes: null })}\n`, 'answers.json');
  assert.throws(() => reviewLoop(repo, CHANGE, { run: '20200101-000000-0000', answers, reviewer: 'subagent' }), blockedWith('run_unknown'));
  assert.throws(() => reviewRun(project, failing.run_id, { reviewer: 'robot' }), /--reviewer is one of subagent, human, genesis, self/);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  // Every check that went from not passing to passing needs the change that explains it, and a finding its detail.
  assert.throws(() => reviewRun(project, run.run_id, { flips: [] }), (error) => {
    blockedWith('review_answers_incomplete')(error);
    assert.ok(error.gaps[0].problems.some((problem) => problem.includes(`${FAILURE}/c1`)), JSON.stringify(error.gaps[0].problems));
    return true;
  });
  assert.throws(() => reviewRun(project, run.run_id, { special_cases: { found: true, detail: null } }), blockedWith('review_answers_incomplete'));
  assert.deepEqual(decisions(project, 'loop_review'), []);
  // A self review with a finding: the user is shown both, and the acceptance records them.
  const self = reviewRun(project, run.run_id, { reviewer: 'self', side_effects: { found: true, detail: 'The handler writes a log file no check reads.' } });
  assert.ok(self.warnings.some((warning) => warning.startsWith('This is a self review')), JSON.stringify(self.warnings));
  assert.deepEqual(Object.keys(self.must_show), ['review_findings', 'self_review']);
  assert.deepEqual(self.findings.map((entry) => [entry.finding, entry.detail]), [['side_effects', 'The handler writes a log file no check reads.']]);
  const status = loopStatus(repo, CHANGE);
  for (const key of ['reviews', 'review_findings', 'self_review']) assert.ok(key in status.must_show, `${key} in ${Object.keys(status.must_show)}`);
  const result = acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.equal(result.accepted.self_review, true);
  assert.deepEqual(result.accepted.review_findings.map((entry) => entry.finding), ['side_effects']);
  assert.ok(result.warnings.some((warning) => warning.startsWith('The final review was a self review')), JSON.stringify(result.warnings));
  assert.deepEqual(Object.keys(result.must_show).filter((key) => ['self_review', 'review_findings'].includes(key)), ['self_review', 'review_findings']);
});

// --- Final runs ---

test('a final run with --all-packages runs every package after a failure, and still counts as a failed final run', (t) => {
  const project = finalsLoop(t);
  const { repo, tools } = project;
  const screen = passingScreen(project, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  const calls = tools.runs().length;
  const final = startRun(repo, CHANGE, { allPackages: true });
  assert.deepEqual([final.role, final.verdict, final.skipped], ['final', 'fail', []]);
  assert.equal(tools.runs().length, calls + 2);
  const record = runRecord(project, final);
  assert.deepEqual([record.final_of, record.run_order, record.all_packages], [screen.run_id, [FAILURE, SUCCESS], true]);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.final.failed, status.situation.code, status.loop.used.iterations], [[final.run_id], 'final_failed', 2]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: final.run_id, ...CONSENT }), refusedWith('not_passing'));
  // Only a head run takes the flag.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, allPackages: true }), /--all-packages belongs to a head run/);
});

// --- Ends that are recorded ---

test('loop end records the reason and who ended the loop, keeps the start code pinned and locks the change', (t) => {
  const project = triedLoop(t);
  const { repo } = project;
  assert.throws(() => endLoop(repo, CHANGE, {}), /--reason/);
  assert.throws(() => endLoop(repo, CHANGE, { reason: 'Stop here.', by: USER }), /--by and --ref go together/);
  const ended = endLoop(repo, CHANGE, { reason: 'The approach does not reach the notice handler.' });
  assert.deepEqual(ended.loop_ended, { reason: 'loop_end', at: ended.loop_ended.at, text: 'The approach does not reach the notice handler.', by: null, ref: null, ended_by: 'agent',
    files: ['app/handler.txt'] });
  assert.deepEqual([ended.suggestion, ended.new_loop.consents, ended.start_code.digest], [null, ['new_loop'], project.loop.start_code.digest]);
  assert.equal(ended.must_show.end[0].reason, 'loop_end');
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'loop_end');
  assert.deepEqual([status.ended.kind, status.ended.text, status.ended.ended_by], ['recorded', 'The approach does not reach the notice handler.', 'agent']);
  assertGapShape(status.gates.head_run, { code: 'loop_ended', reason: 'loop_end', owner: 'user', layer: 'loop' });
  const [entry] = decisions(project, 'loop_end');
  assert.deepEqual([entry.ends_loop, entry.reason, entry.ended_by, entry.by], [project.loop.started_at, 'The approach does not reach the notice handler.', 'agent', undefined]);
  // A loop ends once.
  assert.throws(() => endLoop(repo, CHANGE, { reason: 'Again.' }), blockedWith('loop_not_running'));
  // The change is locked until the user agrees to a new loop, and the start code stays pinned.
  const lock = refusedBeforeRun(project, {}, 'change_locked');
  assertGapShape(lock, { owner: 'user', layer: 'loop', reason: 'loop_end' });
  refusedBeforeRun(project, baseHere(project), 'baseline_after_change');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: project.run.run_id, ...CONSENT }), refusedWith('loop_ended'));
  // Only a loop that ended on its budget goes on with a new one.
  assert.throws(() => budgetLoop(repo, CHANGE, { iterations: 9, ...CONSENT }), refusedWith('loop_ended'));
  const allowed = allowedActions(workflowStatus(repo, CHANGE));
  assert.ok(allowed.includes('loop start --by --ref') && allowed.includes('change abandon --by --ref --reason'), JSON.stringify(allowed));
  assert.ok(!allowed.some((action) => action.startsWith('loop budget')), JSON.stringify(allowed));
});

test('loop end with the user\'s name and where they said so records it as the user\'s call', (t) => {
  const project = inLoop(t);
  const { loop_ended: ended } = endLoop(project.repo, CHANGE, { reason: 'The user wants to stop.', ...CONSENT });
  assert.deepEqual([ended.by, ended.ref, ended.ended_by], [USER, REF, 'user']);
  const status = loopStatus(project.repo, CHANGE);
  assertEnded(status, 'loop_end');
  assert.deepEqual([status.ended.by, status.ended.ref, status.ended.ended_by], [USER, REF, 'user']);
  assert.deepEqual([decisions(project, 'loop_end')[0].by, decisions(project, 'loop_end')[0].ref], [USER, REF]);
});

test('loop decline records the user\'s refusal with who declined and where, and ends the loop; an acceptance is not declined', (t) => {
  const project = passedLoop(t);
  const { repo, run } = project;
  reviewRun(project, run.run_id);
  assert.throws(() => declineLoop(repo, CHANGE, { by: USER }), /--by and --ref/);
  const declined = declineLoop(repo, CHANGE, { ...CONSENT, reason: 'The user wants the notice text changed first.' });
  assert.deepEqual(declined.declined, { at: declined.declined.at, by: USER, ref: REF, reason: 'The user wants the notice text changed first.', run: run.run_id });
  assert.deepEqual([declined.loop_ended.reason, declined.loop_ended.files, declined.suggestion], ['loop_decline', ['app/handler.txt', 'app/results.json'], null]);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'loop_decline');
  assert.deepEqual([status.declined.by, status.declined.ref, status.declined.run], [USER, REF, run.run_id]);
  assert.deepEqual([status.ended.by, status.ended.ref, status.accepted], [USER, REF, false]);
  assert.deepEqual(decisions(project, 'loop_decline').map((entry) => [entry.by, entry.ref, entry.ends_loop]), [[USER, REF, project.loop.started_at]]);
  // The run the user declined is not accepted, and the change is locked.
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT }), refusedWith('loop_ended'));
  assertGapShape(refusedBeforeRun(project, {}, 'change_locked'), { owner: 'user', reason: 'loop_decline' });
  // A second decline of the ended loop is recorded, and the end stays as it was.
  const again = declineLoop(repo, CHANGE, { by: USER, ref: 'thread 2' });
  assert.deepEqual(again.loop_ended, { reason: 'loop_decline', at: status.ended.at, already: true });
  assert.equal(decisions(project, 'loop_decline').at(-1).ends_loop, null);

  // A loop the user accepted cannot be declined.
  const accepted = passedLoop(t);
  reviewRun(accepted, accepted.run.run_id);
  acceptLoop(accepted.repo, CHANGE, { run: accepted.run.run_id, ...CONSENT });
  assert.throws(() => declineLoop(accepted.repo, CHANGE, CONSENT), (error) => {
    blockedWith('already_accepted')(error);
    assertGapShape(error.gaps[0], { owner: 'user', layer: 'loop' });
    return true;
  });
  assert.equal(loopStatus(accepted.repo, CHANGE).phase, 'done');
});

test('change abandon records the user\'s decision, ends the running loop and releases the pinned start code', (t) => {
  const project = triedLoop(t);
  const { repo } = project;
  // While the start code is pinned, a base record goes there only.
  refusedBeforeRun(project, baseHere(project), 'baseline_after_change');
  assert.throws(() => abandonChange(repo, CHANGE, { by: USER, reason: 'No.' }), /--by and --ref/);
  assert.throws(() => abandonChange(repo, CHANGE, { ...CONSENT }), /--reason/);
  const abandoned = abandonChange(repo, CHANGE, { ...CONSENT, reason: 'The user drops this approach.' });
  assert.deepEqual(abandoned.abandoned, { at: abandoned.abandoned.at, by: USER, ref: REF, reason: 'The user drops this approach.' });
  assert.deepEqual([abandoned.loop_ended.reason, abandoned.loop_ended.files, abandoned.loop_phase_before], ['change_abandon', ['app/handler.txt'], 'live']);
  assert.equal(abandoned.released_start_code.digest, project.loop.start_code.digest);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'change_abandon');
  assert.deepEqual([status.abandoned.by, status.abandoned.ref, status.ended.by], [USER, REF, USER]);
  const [entry] = decisions(project, 'change_abandon');
  assert.deepEqual([entry.by, entry.ref, entry.ends_loop, entry.released_start_code], [USER, REF, project.loop.started_at, project.loop.start_code.digest]);
  // The pin is released: the next baseline is recorded on the code as it is now, and a new loop the user agrees to starts there.
  const base = startRun(repo, CHANGE, baseHere(project));
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const { loop } = startLoop(repo, CHANGE);
  assert.deepEqual([loop.baseline, loop.start_from, loop.after_abandon.by, loop.after_abandon.ref], [base.run_id, 'baseline', USER, REF]);
  assert.notEqual(loop.start_code.digest, project.loop.start_code.digest);
  assert.equal(loopStatus(repo, CHANGE).phase, 'live');
});

test('after the user abandons the change, head runs and trials of its application code are no longer refused', (t) => {
  const project = triedLoop(t);
  const { repo } = project;
  abandonChange(repo, CHANGE, { ...CONSENT, reason: 'The user drops this approach.' });
  const flow = workflowStatus(repo, CHANGE);
  assert.ok(allowedActions(flow).includes('run start'), JSON.stringify(allowedActions(flow)));
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed');
  const trial = startRun(repo, CHANGE, { trial: true });
  assert.equal(trial.execution_status, 'completed');
});

test('run start refuses a head run of a loop that ended with the end\'s own gap beside the lock, keeping its owner and layer', (t) => {
  const project = inLoop(t);
  changePackage(project, SUCCESS);
  assertEnded(loopStatus(project.repo, CHANGE), 'packages_changed');
  refusedBeforeRun(project, {}, 'change_locked');
  const refusal = refusedBeforeRun(project, {}, 'loop_ended');
  assertGapShape(refusal, { code: 'loop_ended', reason: 'packages_changed', owner: 'agent', layer: 'package' });
});

// --- Disputes and the project's own tests ---

test('loop dispute records the evidence against a check for the user to rule on; a rejection ends nothing, and acceptance shows the dispute', (t) => {
  const project = passedLoop(t);
  const { repo, run } = project;
  const evidence = outside(project, 'The verifier reads the failure notice log, which this scenario never writes.\n');
  assert.throws(() => disputeLoop(repo, CHANGE, { check: 'c2', evidence }), /CASE:CHECK/);
  assert.throws(() => disputeLoop(repo, CHANGE, { check: `${SUCCESS}:c9`, evidence }), (error) => {
    blockedWith('check_unknown')(error);
    assertGapShape(error.gaps[0], { owner: 'agent', layer: 'package', case: SUCCESS, check: 'c9' });
    return true;
  });
  const disputed = disputeLoop(repo, CHANGE, { check: `${SUCCESS}:c2`, evidence });
  const text = readFileSync(evidence, 'utf8');
  assert.deepEqual([disputed.dispute.id, disputed.dispute.case, disputed.dispute.check, disputed.dispute.ruling], ['dispute-1', SUCCESS, 'c2', null]);
  assert.deepEqual([disputed.dispute.evidence.file, disputed.dispute.evidence.bytes], [evidence, Buffer.byteLength(text)]);
  assert.match(disputed.dispute.evidence.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([disputed.loop_ended, disputed.needs_user.map((entry) => entry.decision), disputed.suggestion], [false, ['dispute ruling'], null]);
  assert.deepEqual(disputed.must_show.disputes, [disputed.dispute]);
  // The record keeps the evidence itself.
  const [entry] = decisions(project, 'loop_dispute');
  assert.deepEqual([entry.evidence.content, entry.evidence.encoding, entry.latest_run], [text, 'utf8', run.run_id]);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.disputes, [disputed.dispute]);
  assert.ok(status.obligations.some((item) => item.kind === 'consent' && item.decision === 'dispute ruling' && item.disputes.includes('dispute-1')), JSON.stringify(status.obligations));
  assert.equal(status.phase, 'live');
  // Only the user rules, with who and where.
  assert.throws(() => disputeLoop(repo, CHANGE, { resolve: 'dispute-1', ruling: 'reject' }), /--by and --ref/);
  assert.throws(() => disputeLoop(repo, CHANGE, { resolve: 'dispute-1', ruling: 'maybe', ...CONSENT }), /--ruling is accept or reject/);
  assert.throws(() => disputeLoop(repo, CHANGE, { resolve: 'dispute-7', ruling: 'reject', ...CONSENT }), blockedWith('dispute_unknown'));
  const ruled = disputeLoop(repo, CHANGE, { resolve: 'dispute-1', ruling: 'reject', ...CONSENT });
  assert.deepEqual([ruled.ruling.ruling, ruled.ruling.by, ruled.ruling.ref, ruled.package_change_agreed, ruled.loop_ended], ['reject', USER, REF, false, false]);
  assert.throws(() => disputeLoop(repo, CHANGE, { resolve: 'dispute-1', ruling: 'accept', ...CONSENT }), blockedWith('dispute_ruled'));
  assert.deepEqual(decisions(project, 'dispute_ruling').map((item) => [item.id, item.ruling, item.by, item.ref]), [['dispute-1', 'reject', USER, REF]]);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.disputes[0].ruling.ruling, status.disputes[0].ruling.by], ['live', 'reject', USER]);
  assert.deepEqual(status.must_show.disputes.map((item) => [item.id, item.ruling.ruling]), [['dispute-1', 'reject']]);
  reviewRun(project, run.run_id);
  const result = acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.deepEqual(result.must_show.disputes.map((item) => item.id), ['dispute-1']);
  assert.deepEqual(result.accepted.disputes.map((item) => [item.id, item.check, item.ruling.ruling]), [['dispute-1', 'c2', 'reject']]);
});

test('a dispute the user accepts agrees to a package change; only the change itself ends the loop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const disputed = disputeLoop(repo, CHANGE, { check: `${SUCCESS}:c1`, evidence: outside(project, 'The success notice is counted twice by the verifier.\n') });
  const ruled = disputeLoop(repo, CHANGE, { resolve: disputed.dispute.id, ruling: 'accept', ...CONSENT });
  assert.deepEqual([ruled.package_change_agreed, ruled.loop_ended], [true, false]);
  assert.equal(loopStatus(repo, CHANGE).phase, 'live');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  // The ended loop still shows its disputes to the user.
  assert.deepEqual(status.must_show.disputes.map((item) => [item.id, item.ruling.ruling]), [[disputed.dispute.id, 'accept']]);
  // A loop that ended takes no new dispute.
  assert.throws(() => disputeLoop(repo, CHANGE, { check: `${SUCCESS}:c2`, evidence: outside(project, 'More.\n') }), refusedWith('loop_ended'));
});

test('loop tests records the command, exit code and summary on the code as it is, and acceptance shows only those of the accepted code', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  assert.throws(() => recordTests(repo, CHANGE, { exitCode: 0 }), /--command/);
  assert.throws(() => recordTests(repo, CHANGE, { command: 'npm test', exitCode: 1.5 }), /--exit-code/);
  assert.throws(() => recordTests(repo, CHANGE, { command: 'npm test', exitCode: 'x' }), /--exit-code/);
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  const failed = recordTests(repo, CHANGE, { command: 'npm test', exitCode: 1, summary: '3 failed, 12 passed' });
  assert.deepEqual([failed.tests.command, failed.tests.exit_code, failed.tests.summary, failed.tests.recorded_by, failed.passed], ['npm test', 1, '3 failed, 12 passed', 'agent', false]);
  assert.deepEqual([failed.loop_started_at, failed.suggestion], [project.loop.started_at, null]);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  // The CLI takes the exit code as given on the command line.
  const done = cli(['loop', 'tests', CHANGE, '--repo', repo, '--command', 'uv run pytest -q', '--exit-code', '0']);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual([done.json.tests.command, done.json.tests.exit_code, done.json.tests.summary, done.json.passed], ['uv run pytest -q', 0, null, true]);
  assert.notEqual(done.json.tests.code_digest, failed.tests.code_digest);
  assert.deepEqual(decisions(project, 'loop_tests').map((entry) => [entry.command, entry.exit_code]), [['npm test', 1], ['uv run pytest -q', 0]]);
  const reviewed = reviewRun(project, run.run_id);
  assert.equal(done.json.tests.code_digest, reviewed.code_digest);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.tests.map((entry) => entry.command), ['npm test', 'uv run pytest -q']);
  assert.deepEqual(status.must_show.project_tests.map((entry) => [entry.command, entry.exit_code, entry.recorded_by]), [['uv run pytest -q', 0, 'agent']]);
  const result = acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.deepEqual(result.accepted.project_tests.map((entry) => entry.command), ['uv run pytest -q']);
  assert.deepEqual(result.must_show.project_tests.map((entry) => entry.command), ['uv run pytest -q']);
});

// --- The CLI ---

test('the CLI records a decline, an end and an abandonment only with the flags they need, and states facts with no next step', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const end = cli(['loop', 'end', CHANGE, '--repo', repo, '--reason', 'Stop here.', '--by', USER]);
  assert.equal(end.status, 1);
  const decline = cli(['loop', 'decline', CHANGE, '--repo', repo, '--by', USER, '--ref', REF, '--reason', 'Not this way.']);
  assert.equal(decline.status, 0, decline.stderr);
  assert.deepEqual([decline.json.declined.by, decline.json.declined.ref, decline.json.loop_ended.reason], [USER, REF, 'loop_decline']);
  assertNoRoutes(decline.json, 'loop decline');
  const status = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(status.status, 0, status.stderr);
  assertEnded(status.json, 'loop_decline');
  assertNoRoutes(status.json, 'loop status');
  // The loop has ended, so a second end is refused with the facts.
  const again = cli(['loop', 'end', CHANGE, '--repo', repo, '--reason', 'Stop here.']);
  assert.equal(again.status, 1);
  assert.deepEqual(codes(again.json.gaps), ['loop_not_running']);
  const abandon = cli(['change', 'abandon', CHANGE, '--repo', repo, '--by', USER, '--ref', REF, '--reason', 'The user drops this approach.']);
  assert.equal(abandon.status, 0, abandon.stderr);
  assert.deepEqual([abandon.json.abandoned.by, abandon.json.loop_ended, abandon.json.loop_phase_before], [USER, null, 'ended']);
  assert.equal(abandon.json.released_start_code.digest, project.loop.start_code.digest);
});
