// Loop tests: what acceptance rests on and records. The final review of the
// accepted code, the files still to commit, the lines whose weaker or
// stronger checks the user accepted, an acceptance read in a clone without
// the run records, and failures the ledger keeps counting.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { reviewEval } from '../src/confirm.js';
import { startRun } from '../src/run.js';
import { acceptLoop, loopStatus, reviewLoop, startLoop as startLoopBare } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, BEFORE, CHANGE, CONSENT, commit, commitConfirmation, confirmChecks, git, readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, FAILURE, SUCCESS, assertEnded, assertGapShape, changeCode, codes, editApp, fullRun, gapOf, inLoop, refusedWith, resultsOutsideCode,
  reviewRun, runsOf, startLoop, withBaseline,
} from './helpers/loop.js';

const DECISION = { by: 'Dana', ref: 'thread 1' };

test('acceptance needs a final review of the accepted code: a review of other code does not cover it, and a self review is recorded and shown', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  reviewRun(project, first.run_id);
  changeCode(repo, AFTER, 'The same fix, written another way');
  const second = fullRun(repo);
  assert.equal(second.verdict, 'pass');
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', second.run_id]);
  // The review of the first run's code is recorded, and covers only that code.
  assert.deepEqual(status.reviews.map((entry) => entry.run_id), [first.run_id]);
  assert.deepEqual([status.review.run_id, status.review.satisfied, status.review.recorded], [second.run_id, false, []]);
  assertGapShape(status.gates.accept.find((entry) => entry.code === 'review_missing'), { owner: 'agent', layer: 'loop', run: second.run_id });
  assert.throws(() => acceptLoop(repo, CHANGE, { run: second.run_id, ...DECISION }), (error) => {
    assertGapShape(gapOf(error, 'review_missing'), { owner: 'agent', layer: 'loop', run: second.run_id });
    // The refusal carries what the user must be shown, as loop status gives it.
    assert.deepEqual(error.must_show, status.must_show);
    return true;
  });
  // A run that is no full run of this loop gets no review.
  const answers = path.join(project.tools.directory, 'answers-unknown.json');
  writeFileSync(answers, `${JSON.stringify({ flips: [], special_cases: { found: false, detail: null }, outside_spec: { found: false, detail: null }, side_effects: { found: false, detail: null } })}\n`);
  assert.throws(() => reviewLoop(repo, CHANGE, { run: 'no-such-run', answers, reviewer: 'subagent' }), (error) => {
    assertGapShape(gapOf(error, 'run_unknown'), { owner: 'agent', layer: 'loop', run: 'no-such-run' });
    return true;
  });

  // The agent that changed the code reviews it itself, and finds a side effect.
  const self = reviewRun(project, second.run_id, { reviewer: 'self', side_effects: { found: true, detail: 'The handler now logs each notice it skips.' } });
  assert.equal(self.review.reviewer, 'self');
  assert.ok(self.warnings.some((warning) => warning.startsWith('This is a self review')), JSON.stringify(self.warnings));
  assert.deepEqual(self.must_show.review_findings, [{ review: self.review.id, reviewer: 'self', finding: 'side_effects', detail: 'The handler now logs each notice it skips.' }]);
  assert.deepEqual(self.must_show.self_review.map((entry) => entry.id), [self.review.id]);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assert.deepEqual(status.must_show.self_review.map((entry) => entry.id), [self.review.id]);
  assert.deepEqual(status.must_show.review_findings, self.must_show.review_findings);
  assert.deepEqual(status.must_show.reviews.map((entry) => [entry.id, entry.reviewer, entry.notes]), [[self.review.id, 'self', 'Synthetic final review.']]);

  const accepted = acceptLoop(repo, CHANGE, { run: second.run_id, ...DECISION });
  assert.ok(accepted.warnings.includes('The final review was a self review: the agent that changed the code reviewed it. accepted.json records that.'), JSON.stringify(accepted.warnings));
  assert.deepEqual(accepted.must_show.self_review.map((entry) => entry.id), [self.review.id]);
  assert.deepEqual(accepted.must_show.review_findings, self.must_show.review_findings);
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual([record.self_review, record.review.id, record.review.reviewer, record.review.notes, record.reviews.map((entry) => entry.id)],
    [true, self.review.id, 'self', 'Synthetic final review.', [self.review.id]]);
  assert.deepEqual(record.review_findings, self.must_show.review_findings);
  assert.deepEqual([record.accepted.by, record.accepted.ref], [DECISION.by, DECISION.ref]);
  // The review is a decision record of the loop, as is the acceptance's consent to the loop.
  const decisions = readFileSync(path.join(root, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(decisions.filter((entry) => entry.type === 'loop_review').map((entry) => [entry.run_id, entry.reviewer]), [[first.run_id, 'subagent'], [second.run_id, 'self']]);
  assert.deepEqual([record.loop_consent.by, record.loop_consent.ref], [CONSENT.by, CONSENT.ref]);
});

test('a final review is refused for a run that did not pass and once the loop ended', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const failed = fullRun(repo);
  assert.throws(() => reviewRun(project, failed.run_id), (error) => {
    assertGapShape(gapOf(error, 'not_passing'), { owner: 'agent', layer: 'loop', run: failed.run_id });
    return true;
  });
  // The same code passes: a failure of it always counts, so the loop ended.
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assertEnded(loopStatus(repo, CHANGE), 'stop_unstable');
  assert.throws(() => reviewRun(project, passed.run_id), refusedWith('stop_unstable'));
});

test('loop accept names the accepted application files Git does not hold beside the change\'s own files, and once all is committed the user decides on a merge or a pull request', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  // The change is in the working directory and not committed.
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, ...DECISION });
  const edd = `.genesis/edd/${CHANGE}`;
  assert.equal(accepted.committed, false);
  assert.equal(accepted.commit, undefined);
  assert.deepEqual(accepted.uncommitted, ['.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports/`, 'app/handler.txt', 'app/results.json'].sort());
  assert.deepEqual(accepted.needs_user, [{ decision: 'commit, merge or pull request', why: 'The user decides whether and how the accepted change goes into Git.' }]);
  // Nothing is committed for the user.
  assert.deepEqual(git(repo, ['ls-files', '--modified', '--others', '--exclude-standard', '--', 'app']).split('\n').sort(), ['app/handler.txt', 'app/results.json']);

  const all = commit(repo, 'Commit the change, its evals, reports and acceptance');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.code_commit, status.situation.uncommitted], [true, all, []]);
  assert.deepEqual(status.situation.needs_user, [{ decision: 'merge or pull request',
    why: `The accepted change is committed in ${all.slice(0, 7)}; the user decides whether to merge it or open a pull request.` }]);
  assert.equal(status.suggestion, null);
});

test('the lines whose weaker checks the user accepted at the confirmation appear in the strength sentence, in what the user is shown and in accepted.json', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo, root } = project;
  const line = reviewEval(repo, CHANGE).review_template.lines.find((entry) => entry.package === SUCCESS);
  const reason = 'The user says a count of success notices is enough for this change.';
  const confirmed = confirmChecks(project, { verdict: (entry) => (entry.package === line.package && entry.then === line.then ? 'weaker' : undefined),
    acceptVerdict: `${line.package}:${line.then}`, acceptReason: reason });
  commitConfirmation(repo);
  assert.deepEqual(confirmed.confirmation.accepted_verdicts.map((entry) => [entry.package, entry.then, entry.verdict]), [[line.package, line.then, 'weaker']]);
  assert.equal(startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) }).is_baseline, true);
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);

  const sentence = `The user accepted, when confirming the checks: the checks of "${line.then}" (${line.package}) ask less than the line says, so a pass there does not show the whole line holds.`;
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.strength.sentence.endsWith(sentence), status.strength.sentence);
  assert.ok(status.must_show.strength[0].sentence.endsWith(sentence), JSON.stringify(status.must_show.strength));
  assert.deepEqual(status.must_show.accepted_verdicts.map((entry) => [entry.package, entry.then, entry.verdict]), [[line.package, line.then, 'weaker']]);
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, ...DECISION });
  assert.ok(accepted.must_show.strength[0].sentence.endsWith(sentence), JSON.stringify(accepted.must_show.strength));
  assert.deepEqual(accepted.must_show.accepted_verdicts, accepted.accepted.accepted_verdicts);
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.ok(record.strength.sentence.endsWith(sentence), record.strength.sentence);
  assert.deepEqual(record.strength.accepted_verdicts, record.accepted_verdicts);
  assert.deepEqual(record.accepted_verdicts.map((entry) => [entry.package, entry.then, entry.verdict]), [[line.package, line.then, 'weaker']]);
  assert.equal(record.tier, 'light');
});

test('in a clone without loop.json and the run records, loop status reads the committed accepted.json as a read-only acceptance, and says whether the code is the accepted code', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, ...DECISION });
  const head = commit(repo, 'Commit the acceptance');
  const parent = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-clone-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const clone = path.join(parent, 'app');
  git(parent, ['clone', '-q', repo, clone]);
  const root = path.join(clone, '.genesis/edd', CHANGE);
  assert.throws(() => readFileSync(path.join(root, 'loop.json')));

  let status = loopStatus(clone, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.code, status.situation.local_records, status.situation.code_matches, status.situation.run_id, status.situation.by, status.situation.ref],
    ['accepted', false, true, run.run_id, DECISION.by, DECISION.ref]);
  assert.deepEqual(status.acceptance, { run_id: run.run_id, by: DECISION.by, ref: DECISION.ref, at: status.situation.at, local_records: false, code_matches: true });
  assert.equal(status.loop.local_records, false);
  assert.deepEqual([status.runs, status.suggestion, status.gates], [[], null, { head_run: null, accept: [] }]);
  assert.ok(status.warnings[0].startsWith('This machine has no loop.json and no run records of this change: they stay on the machine where the loop ran, and accepted.json is the record of the acceptance.'), status.warnings[0]);
  assert.equal(status.warnings.length, 1, JSON.stringify(status.warnings));
  assert.deepEqual([status.situation.committed, status.situation.code_commit], [true, head]);
  // Nothing that needs the local records is done here.
  assert.throws(() => acceptLoop(clone, CHANGE, { run: run.run_id, ...DECISION }), (error) => {
    assertGapShape(gapOf(error, 'loop_missing'), { owner: 'user', layer: 'loop' });
    return true;
  });
  const answers = path.join(parent, 'answers.json');
  writeFileSync(answers, `${JSON.stringify({ flips: [], special_cases: { found: false, detail: null }, outside_spec: { found: false, detail: null }, side_effects: { found: false, detail: null } })}\n`);
  assert.throws(() => reviewLoop(clone, CHANGE, { run: run.run_id, answers, reviewer: 'subagent' }), refusedWith('loop_missing'));
  // A baseline on the accepted code would describe the change, so it is refused, and not offered.
  assert.throws(() => startRun(clone, CHANGE, { baseline: true, expect: writeExpectations(clone, EXPECT) }), refusedWith('code_holds_accepted_change'));
  const baseline = workflowStatus(clone, CHANGE).actions.find((entry) => entry.command[1] === 'start' && entry.command.includes('--baseline') && !entry.command.includes('--unavailable'));
  assert.ok(baseline.blocked_by.includes('code_holds_accepted_change'), JSON.stringify(baseline));
  const offered = workflowStatus(clone, CHANGE).suggestion;
  assert.ok(!offered?.command.includes('--baseline'), JSON.stringify(offered));

  // Other code: the acceptance says nothing about it.
  setResults(clone, BEFORE);
  status = loopStatus(clone, CHANGE);
  assert.deepEqual([status.phase, status.situation.local_records, status.situation.code_matches, status.acceptance.code_matches], ['done', false, false, false]);
  assert.equal(status.situation.committed, undefined);
  assert.ok(status.warnings.includes('The code differs from the accepted code (code_digest), so the acceptance says nothing about the code now.'), JSON.stringify(status.warnings));
});

test('a trial that fails on the code of a loop run counts like any run: the loop ends as unstable and the pass is refused', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  setResults(repo, BEFORE);
  const trial = startRun(repo, CHANGE, { trial: true });
  assert.equal(trial.verdict, 'fail', JSON.stringify(trial));
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  const status = loopStatus(repo, CHANGE);
  // The trial is no run of the loop, but it spends its budget, and its failure counts.
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [passed.run_id]);
  assert.deepEqual(status.loop.trials, [trial.run_id]);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [trial.run_id] }]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, ...DECISION }), (error) => {
    assert.match(gapOf(error, 'unstable').message, new RegExp(`^${FAILURE}/c1 failed in ${trial.run_id},`));
    return true;
  });
  // A trial is never accepted.
  assert.throws(() => acceptLoop(repo, CHANGE, { run: trial.run_id, ...DECISION }), refusedWith('trial_not_acceptable'));
});

test('a run whose folder was deleted, or whose run.json cannot be read, still counts as a failure of its code and toward the budget', (t) => {
  const project = inLoop(t, { iterations: 5 });
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BEFORE, 'Try a change that keeps the failure');
  const deleted = fullRun(repo);
  const broken = fullRun(repo);
  rmSync(path.join(project.runs, deleted.run_id), { recursive: true, force: true });
  writeFileSync(path.join(project.runs, broken.run_id, 'run.json'), '{ not json');
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.loop.lost_runs, [deleted.run_id, broken.run_id]);
  assert.equal(status.loop.used.iterations, 3);
  assert.ok(status.warnings.includes(`${deleted.run_id} and ${broken.run_id} of this loop are in runs/index.jsonl, but their run records are gone or cannot be read: each counts as a failure of its code and packages, and toward the budget.`), JSON.stringify(status.warnings));
  // Each lost run failed every gating check of its packages on that code.
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(runsOf), [
    { case: FAILURE, check: 'c1', pass: [passed.run_id], fail: [deleted.run_id, broken.run_id] },
    { case: SUCCESS, check: 'c1', pass: [passed.run_id], fail: [deleted.run_id, broken.run_id] },
    { case: SUCCESS, check: 'c2', pass: [passed.run_id], fail: [deleted.run_id, broken.run_id] },
  ]);
  assert.deepEqual(status.must_show.lost_runs.map((entry) => entry.run_id), [deleted.run_id, broken.run_id]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, ...DECISION }), (error) => {
    refusedWith('unstable')(error);
    assert.deepEqual(gapOf(error, 'unstable').failures.map((entry) => entry.check), [`${FAILURE}/c1`, `${SUCCESS}/c1`, `${SUCCESS}/c2`]);
    return true;
  });
});

test('without the run index, a loop is neither accepted nor started: the ledger could not show a deleted run', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  rmSync(path.join(project.runs, 'index.jsonl'));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, ...DECISION }), (error) => {
    assertGapShape(gapOf(error, 'ledger_index_missing'), { owner: 'user', layer: 'ledger', path: `.genesis/edd/${CHANGE}/runs/index.jsonl` });
    return true;
  });
  const status = workflowStatus(repo, CHANGE);
  assert.ok(codes(status.gaps).includes('ledger_index_missing'), JSON.stringify(codes(status.gaps)));
  assert.equal(status.layers.ledger.index_missing, true);
  // Nor does a new loop start on it, even with the user's consent.
  const other = withBaseline(t);
  rmSync(path.join(other.runs, 'index.jsonl'));
  assert.throws(() => startLoopBare(other.repo, CHANGE, { ...CONSENT }), refusedWith('ledger_index_missing'));
});

test('a pass outside a loop is no acceptance: loop accept refuses it, and the loop that starts on code already changed records that run and needs its own pass', (t) => {
  const project = withBaseline(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const outside = fullRun(repo);
  assert.equal(outside.verdict, 'pass');
  assert.equal(outside.not_acceptance, 'This pass was made outside a loop: no budget, final review or final run applies to it, so it is not an acceptance.');
  const { loop } = startLoop(repo, CHANGE);
  // The working directory already held the change when the loop started.
  assert.equal(loop.worktree_moved, true);
  assert.deepEqual(loop.pre_loop.runs, 1);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs, []);
  // The loop counts only its own runs: the code that passed outside it runs again.
  assert.deepEqual([status.situation.code, status.situation.passed_before], ['open', outside.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: outside.run_id, ...DECISION }), (error) => {
    assertGapShape(gapOf(error, 'outside_loop'), { owner: 'agent', layer: 'loop', run: outside.run_id });
    return true;
  });
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.must_show.pre_loop, [loop.pre_loop]);
  assert.deepEqual(status.must_show.worktree_moved, [{ files: loop.moved_files }]);
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, ...DECISION });
  assert.deepEqual(accepted.must_show.pre_loop, [loop.pre_loop]);
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual([record.run_id, record.worktree_moved, record.pre_loop], [run.run_id, true, loop.pre_loop]);
});

test('the strength sentence and accepted.json count the attempts on the accepted code that left a gating check unknown', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  resultsOutsideCode(repo);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'Stop the success notice when a submission fails');
  const unclear = fullRun(repo);
  assert.equal(unclear.verdict, 'unverified');
  // The same code again: an unknown is no failure, so its pass can be accepted.
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  reviewRun(project, passed.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.gates.accept, status.unstable], ['acceptable', [], []]);
  assert.deepEqual(status.unknown_attempts, { attempts: 4, unknown: 1, runs: [unclear.run_id] });
  const sentence = 'Light tier: the packages ran with the network sealed, no model was called, and each check ran once. That shows only that code whose result is fixed holds in these scenarios. On the accepted code, 1 of 4 attempts left a gating check unknown.';
  assert.equal(status.strength.sentence, sentence);
  assert.deepEqual(status.must_show.unknown_attempts, [status.unknown_attempts]);
  acceptLoop(repo, CHANGE, { run: passed.run_id, ...DECISION });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual(record.unknown_attempts, { attempts: 4, unknown: 1, runs: [unclear.run_id] });
  assert.deepEqual([record.strength.sentence, record.strength.unknown_attempts], [sentence, { attempts: 4, unknown: 1 }]);
  assert.equal(record.final_runs_of_change.total, 0);
});
