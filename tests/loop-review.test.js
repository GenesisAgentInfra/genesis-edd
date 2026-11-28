// Loop tests of the main path the earlier tests do not cover: the user's
// decisions recorded with who and where through the CLI, the answers a final
// review gives and what the user sees of them, what a report says of checks
// and fixtures, the eval literals a final review is pointed at, a new export
// during a loop, and results that state facts with at most one suggestion.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { checkEval } from '../src/run.js';
import { acceptLoop, declineLoop, endLoop, loopStatus, reviewLoop, startLoop as startLoopBare } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { readDecisions } from '../src/records.js';
import {
  AFTER, BEFORE, CHANGE, CONSENT, CONSENT_FLAGS, REF, SPECS, USER, actionOf, assertGapShape, assertNoRoutes, cli, commit, editChecks, readRecord, setResults,
  writeFixtureScripts, writeSpec,
} from './helpers/edd.js';
import {
  FAILURE, REVISED, SUCCESS, assertEnded, blockedWith, changeCode, codes, fullRun, gapOf, inLoop, refusedWith, reviewRun, startLoop, withBaseline,
} from './helpers/loop.js';

const decisionsOf = (project, type) => readDecisions(project.root).entries.filter((entry) => entry.type === type);
// Every gap of a refusal has the shape a gap has: code, kind, owner, layer and
// message, and no route or resume.
const refusal = (code) => (error) => {
  blockedWith(code)(error);
  for (const entry of error.gaps) assertGapShape(entry);
  return true;
};

test('the main path through the CLI records each decision of the user with who and where: the loop start and the acceptance, beside the final review', (t) => {
  const project = withBaseline(t);
  const { repo } = project;
  // --by and --ref go together.
  const half = cli(['loop', 'start', CHANGE, '--repo', repo, '--by', USER]);
  assert.equal(half.status, 1, half.stdout);
  assert.match(half.json.error, /--by and --ref go together/);

  const started = cli(['loop', 'start', CHANGE, '--repo', repo, ...CONSENT_FLAGS]);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual([started.json.consent.by, started.json.consent.ref, started.json.loop.consent.by, started.json.loop.consent.ref], [USER, REF, USER, REF]);
  assert.deepEqual(decisionsOf(project, 'loop_start').map((entry) => [entry.by, entry.ref, entry.loop_started_at]), [[USER, REF, started.json.loop.started_at]]);

  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([run.json.verdict, run.json.in_loop, run.json.acceptable, run.json.suggestion.command.slice(0, 2)], ['pass', true, true, ['loop', 'status']]);

  const answers = path.join(project.tools.directory, 'answers.json');
  writeFileSync(answers, `${JSON.stringify({ flips: [{ case: FAILURE, check: 'c1', explained_by: 'app/handler.txt reads the submission result first.' }],
    special_cases: { found: false, detail: null }, outside_spec: { found: false, detail: null }, side_effects: { found: false, detail: null }, notes: 'Read the Spec and the diff.' })}\n`);
  const reviewed = cli(['loop', 'review', CHANGE, '--repo', repo, '--run', run.json.run_id, '--answers', answers, '--reviewer', 'human', '--by', 'Riley']);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.deepEqual([reviewed.json.review.reviewer, reviewed.json.review.by, reviewed.json.covers], ['human', 'Riley', [run.json.run_id]]);
  const [review] = decisionsOf(project, 'loop_review');
  assert.deepEqual([review.reviewer, review.by, review.run_id, review.loop_started_at], ['human', 'Riley', run.json.run_id, started.json.loop.started_at]);

  // Acceptance is the user's: it is refused without --by and --ref, and recorded with them.
  const unnamed = cli(['loop', 'accept', CHANGE, '--repo', repo, '--run', run.json.run_id]);
  assert.equal(unnamed.status, 1, unnamed.stdout);
  assert.match(unnamed.json.error, /--by and --ref/);
  const accepted = cli(['loop', 'accept', CHANGE, '--repo', repo, '--run', run.json.run_id, '--by', 'Dana', '--ref', 'review thread 12']);
  assert.equal(accepted.status, 0, accepted.stderr);
  const record = readJSON(path.join(project.root, 'accepted.json'));
  assert.deepEqual([record.accepted.by, record.accepted.ref, record.loop_consent.by, record.loop_consent.ref], ['Dana', 'review thread 12', USER, REF]);
  assert.deepEqual([record.review.reviewer, record.review.by], ['human', 'Riley']);
});

test('a loop started on the words that confirmed the checks cites that confirmation, and a later loop needs the user\'s consent again', (t) => {
  const project = withBaseline(t, { startLoop: true });
  const { repo } = project;
  const { id } = project.confirmation.confirmation;
  assert.equal(project.confirmation.start_loop, true);
  // workflow status reads that consent from the confirmation.
  const before = actionOf(workflowStatus(repo, CHANGE), 'loop', 'start');
  assert.deepEqual([before.allowed, before.command.includes('--by'), before.needs[0]], [true, false, `user consent: recorded by checks confirmation ${id}`]);
  const started = cli(['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual([started.json.consent.via, started.json.consent.confirmation, started.json.consent.by, started.json.consent.ref], ['confirmation', id, USER, REF]);
  assert.deepEqual(decisionsOf(project, 'loop_start').map((entry) => [entry.via, entry.confirmation, entry.by]), [['confirmation', id, undefined]]);

  endLoop(repo, CHANGE, { reason: 'The agent ends the loop to rethink the approach.' });
  // The confirmation agreed to one loop: the next one needs --by and --ref.
  assert.throws(() => startLoopBare(repo, CHANGE), (error) => {
    refusal('loop_consent_missing')(error);
    const entry = assertGapShape(gapOf(error, 'loop_consent_missing'), { owner: 'user', layer: 'loop', confirmation: id, start_loop: true, loop_started_since: true });
    assert.match(entry.message, new RegExp(`the checks confirmation ${id} recorded that agreement, but a loop started after it`));
    return true;
  });
  const after = actionOf(workflowStatus(repo, CHANGE), 'loop', 'start');
  assert.ok(after.command.includes('--by') && after.command.includes('--ref'), JSON.stringify(after.command));
  assert.deepEqual(startLoop(repo, CHANGE).consent.by, USER);
});

test('a budget above the one the user confirmed needs the user\'s consent too, even when the confirmation agreed to the loop', (t) => {
  const project = withBaseline(t, { startLoop: true });
  const { repo } = project;
  assert.throws(() => startLoopBare(repo, CHANGE, { iterations: 8 }), (error) => {
    refusal('budget_over_confirmed')(error);
    assert.deepEqual(codes(error.gaps), ['budget_over_confirmed']);
    assertGapShape(gapOf(error, 'budget_over_confirmed'), { owner: 'user', layer: 'loop', budget: { iterations: 8, minutes: null, run_minutes: 30 }, confirmed_budget: { iterations: 5, minutes: null, run_minutes: 30 } });
    return true;
  });
  const started = startLoopBare(repo, CHANGE, { iterations: 8, ...CONSENT });
  assert.deepEqual([started.loop.budget.iterations, started.loop.budget_source, started.loop.budget_consent.by, started.loop.budget_consent.ref], [8, 'loop_start', USER, REF]);
  assert.deepEqual(started.loop.confirmed_budget, { iterations: 5, minutes: null, run_minutes: 30 });
  assert.deepEqual(decisionsOf(project, 'loop_start').map((entry) => [entry.by, entry.budget_over_confirmed]), [[USER, true]]);

  // A smaller budget than the confirmed one needs no further consent.
  const within = withBaseline(t, { startLoop: true });
  const smaller = startLoopBare(within.repo, CHANGE, { iterations: 3 });
  assert.deepEqual([smaller.loop.budget.iterations, smaller.consent.via, smaller.loop.budget_consent], [3, 'confirmation', undefined]);
});

test('loop review needs every flip explained and an answer on special cases, changes outside the Spec and side effects, each with a detail when found', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const problems = (answers) => {
    let found = null;
    assert.throws(() => reviewRun(project, run.run_id, answers), (error) => {
      refusal('review_answers_incomplete')(error);
      found = gapOf(error, 'review_answers_incomplete').problems;
      return true;
    });
    return found;
  };
  assert.deepEqual(problems({ flips: [] }), [`no explained_by for ${FAILURE}/c1, which went from not passing to passing against the baseline`]);
  for (const field of ['special_cases', 'outside_spec', 'side_effects']) {
    assert.deepEqual(problems({ [field]: undefined }), [`${field}.found is not true or false`]);
    assert.deepEqual(problems({ [field]: { found: 'no', detail: null } }), [`${field}.found is not true or false`]);
    assert.deepEqual(problems({ [field]: { found: true, detail: ' ' } }), [`${field}.detail is empty although ${field}.found is true`]);
  }
  assert.throws(() => reviewRun(project, run.run_id, { reviewer: 'robot' }), /--reviewer is one of subagent, human, genesis, self/);
  // Nothing was recorded, and acceptance still waits for a review.
  assert.deepEqual([loopStatus(repo, CHANGE).reviews, decisionsOf(project, 'loop_review')], [[], []]);
  assert.deepEqual(codes(loopStatus(repo, CHANGE).gates.accept), ['review_missing']);
  assert.deepEqual(reviewRun(project, run.run_id).findings, []);
  assert.deepEqual(loopStatus(repo, CHANGE).gates.accept, []);
});

test('a side effect the review found is a finding the user is shown before acceptance, and the reviewer\'s notes stay with the review', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const detail = 'The handler now also writes an audit line that no check reads.';
  const notes = 'Read the Spec, the diff from the start code and the report.';
  const reviewed = reviewRun(project, run.run_id, { side_effects: { found: true, detail }, notes });
  const finding = { review: 'review-1', reviewer: 'subagent', finding: 'side_effects', detail };
  assert.deepEqual(reviewed.findings, [finding]);
  assert.deepEqual(reviewed.must_show, { review_findings: [finding] });
  assert.deepEqual([reviewed.review.findings, reviewed.review.notes], [{ special_cases: false, outside_spec: false, side_effects: true }, notes]);

  // A finding does not refuse the acceptance; it is put in front of the user.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assert.deepEqual(status.must_show.review_findings, [finding]);
  assert.deepEqual(status.must_show.reviews.map((entry) => [entry.id, entry.notes]), [['review-1', notes]]);
  assert.deepEqual(status.reviews.map((entry) => entry.notes), [notes]);
  assert.ok(status.obligations.find((entry) => entry.kind === 'disclosure' && entry.before === 'acceptance').items.includes('review_findings'), JSON.stringify(status.obligations));

  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.deepEqual(accepted.must_show.review_findings, [finding]);
  assert.deepEqual([accepted.accepted.review_findings, accepted.accepted.review.notes, accepted.accepted.reviews.map((entry) => entry.notes)], [[finding], notes, [notes]]);
});

test('a report labels a check that went from not passing to passing holds (fixed) and one that passed before holds (kept), while the records keep holds', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const report = readFileSync(run.report.file, 'utf8');
  assert.ok(report.includes(`| ${FAILURE} | c1 | REQ-submit-failure | 本次提交发送的成功通知数量为零 | gating | fail (0/1) → pass (1/1) | holds (fixed) |`), report);
  assert.ok(report.includes(`| ${SUCCESS} | c1 | REQ-submit-success | 本次提交发送的成功通知数量为一 | gating | pass (1/1) → pass (1/1) | holds (kept) |`), report);
  assert.ok(report.includes(`| ${SUCCESS} | c2 | REQ-submit-success | 本次提交发送的失败通知数量为零 | gating | pass (1/1) → pass (1/1) | holds (kept) |`), report);
  // compare.json keeps the verdict holds; what the user is shown labels it.
  assert.deepEqual(readRecord(run).compare.results.map((entry) => entry.verdict), ['holds', 'holds', 'holds']);
  const { checks } = loopStatus(repo, CHANGE).must_show;
  assert.deepEqual(checks.map((entry) => [entry.case, entry.check, entry.verdict, entry.label]), [
    [FAILURE, 'c1', 'holds', 'holds (fixed)'], [SUCCESS, 'c1', 'holds', 'holds (kept)'], [SUCCESS, 'c2', 'holds', 'holds (kept)'],
  ]);
  reviewRun(project, run.run_id);
  assert.deepEqual(acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT }).accepted.checks.map((entry) => entry.verdict), ['holds', 'holds', 'holds']);
});

test('a fixture added during a loop changes nothing a run executes: the loop goes on, and the next report lists it apart from the package changes', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  const runDigest = project.loop.run_digest[SUCCESS];
  editChecks(repo, SUCCESS, (declared) => {
    declared.fixtures.push({ name: 'review-extra', origin: 'review', note: 'Synthetic extra counterexample.', expect: { c1: 'fail', c2: 'pass' } });
  });
  writeFixtureScripts(repo, SUCCESS, ['review-extra']);
  // The package's run digest leaves fixtures out: the loop's packages are as they were.
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended, status.changed_packages], ['live', null, []]);
  // Until eval check proves it again, a run skips it.
  assert.deepEqual(status.situation.unchecked, [SUCCESS]);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.unchecked], ['live', []]);

  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const second = fullRun(repo);
  assert.deepEqual([second.verdict, readRecord(second).run.run_digest[SUCCESS]], ['pass', runDigest]);
  const report = readFileSync(second.report.file, 'utf8');
  const folder = `.genesis/edd/${CHANGE}/evals/${SUCCESS}`;
  assert.ok(report.includes(`Eval package and project kit files changed since run ${first.run_id}:\n- none\n`), report);
  assert.ok(report.includes(`Fixtures added or changed (what a run executes is unchanged):\n- \`${folder}/tests/checks.json\`\n- \`${folder}/tests/fixtures/review-extra.sh\`\n`), report);
});

test('eval_literals points the final review at literals of the packages\' input in the added lines, marks lines of test files and literals found only there, and lists the others first', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  setResults(repo, AFTER);
  // The test file sorts before the application file, and the literal of the
  // first package is found only in the test file.
  mkdirSync(path.join(repo, 'app/__tests__'), { recursive: true });
  writeFileSync(path.join(repo, 'app/__tests__/handler.test.js'), `// Synthetic test.\ntest('${FAILURE}');\ntest('${SUCCESS}');\n`);
  writeFileSync(path.join(repo, 'app/handler.txt'), `if (scenario === '${SUCCESS}') skip();\n`);
  commit(repo, 'A change that names an eval input');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  const expected = [
    { literal: SUCCESS, packages: [SUCCESS], lines: [{ file: 'app/handler.txt', line: 1 }, { file: 'app/__tests__/handler.test.js', line: 3, test: true }] },
    { literal: FAILURE, packages: [FAILURE], only_tests: true, lines: [{ file: 'app/__tests__/handler.test.js', line: 2, test: true }] },
  ];
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.review.eval_literals, expected);
  // A hint for the review and the user, never a verdict: nothing refuses for it.
  assert.deepEqual(status.must_show.eval_literals, expected);
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
});

test('a new export ends a running loop and says so, while an export that changes nothing ends nothing, and one after the acceptance ends no loop that runs', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  writeSpec(repo, REVISED);
  const action = actionOf(workflowStatus(repo, CHANGE), 'spec', 'export');
  assert.deepEqual([action.allowed, action.effect], [true, 'ends_loop']);
  const exported = cli(['spec', 'export', CHANGE, '--repo', repo]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(exported.json.ends_loop, true);
  assert.deepEqual(exported.json.loop, { started_at: project.loop.started_at, export: project.loop.spec, phase: 'live', accepted: false });
  assert.deepEqual(exported.json.must_show.loop_ended, [{ started_at: project.loop.started_at, export: project.loop.spec }]);
  assertEnded(loopStatus(repo, CHANGE), 'spec_exported');
  const again = cli(['spec', 'export', CHANGE, '--repo', repo]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([again.json.unchanged, again.json.ends_loop, again.json.loop, again.json.must_show.loop_ended], [true, false, null, undefined]);

  // After the user's acceptance the loop is done, so an export ends no loop that runs.
  const done = inLoop(t);
  changeCode(done.repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(done.repo);
  reviewRun(done, run.run_id);
  acceptLoop(done.repo, CHANGE, { run: run.run_id, ...CONSENT });
  writeSpec(done.repo, REVISED);
  const after = cli(['spec', 'export', CHANGE, '--repo', done.repo]);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual([after.json.ends_loop, after.json.loop.accepted, after.json.must_show.loop_ended], [false, true, undefined]);
  const status = loopStatus(done.repo, CHANGE);
  assert.deepEqual([status.ended.reason, status.ended.accepted, status.accepted], ['spec_exported', true, true]);
});

test('loop results state facts, the user\'s decisions and at most one suggestion, never a next command or a route', (t) => {
  const project = withBaseline(t);
  const { repo } = project;
  const facts = (value, where) => {
    assertNoRoutes(value, where);
    assert.ok(value.suggestion === null || (Array.isArray(value.suggestion.command) && typeof value.suggestion.why === 'string'), `${where}: ${JSON.stringify(value.suggestion)}`);
    return value;
  };
  assert.throws(() => startLoopBare(repo, CHANGE), refusal('loop_consent_missing'));
  facts(startLoop(repo, CHANGE), 'loop start');
  facts(loopStatus(repo, CHANGE), 'loop status, open');
  changeCode(repo, BEFORE, 'first attempt');
  facts(fullRun(repo), 'run start, failing');
  facts(loopStatus(repo, CHANGE), 'loop status, failing');
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = facts(fullRun(repo), 'run start, passing');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT }), refusal('review_missing'));
  let status = facts(loopStatus(repo, CHANGE), 'loop status, acceptable');
  // The user's decision is a fact of its own, beside the suggestion.
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'acceptance' && entry.by === 'user'), JSON.stringify(status.obligations));
  facts(reviewRun(project, run.run_id), 'loop review');
  facts(workflowStatus(repo, CHANGE), 'workflow status');
  const accepted = facts(acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT }), 'loop accept');
  assert.deepEqual([accepted.suggestion, accepted.needs_user.map((entry) => entry.decision)], [null, ['commit, merge or pull request']]);
  status = facts(loopStatus(repo, CHANGE), 'loop status, done');
  assert.equal(status.suggestion, null);

  // An ended loop states why and what a new loop needs; nothing is suggested.
  const other = inLoop(t);
  const ended = facts(endLoop(other.repo, CHANGE, { reason: 'The user asked to stop for today.', ...CONSENT }), 'loop end');
  assert.deepEqual([ended.loop_ended.reason, ended.loop_ended.by, ended.new_loop.consents], ['loop_end', USER, ['new_loop']]);
  status = facts(loopStatus(other.repo, CHANGE), 'loop status, ended');
  assertEnded(status, 'loop_end');
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'new loop' && entry.by === 'user'), JSON.stringify(status.obligations));
  assert.throws(() => reviewLoop(other.repo, CHANGE, { run: 'none', answers: path.join(other.tools.directory, 'none.json'), reviewer: 'subagent' }), /cannot be read/);
  facts(workflowStatus(other.repo, CHANGE), 'workflow status, ended');
});

test('an accepted loop stays done while the Spec files are edited but not exported, so a decline does not withdraw the acceptance', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.throws(() => declineLoop(repo, CHANGE, CONSENT), refusedWith('already_accepted'));
  // An edit of the Spec files is no export: the accepted loop is still done.
  writeSpec(repo, REVISED);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.accepted, status.acceptance.holds], ['done', true, true], JSON.stringify(status.situation));
  assert.throws(() => declineLoop(repo, CHANGE, { ...CONSENT, reason: 'Declined after the Spec was edited.' }), refusedWith('already_accepted'));
  writeSpec(repo, SPECS.two);
  assert.deepEqual([loopStatus(repo, CHANGE).phase, loopStatus(repo, CHANGE).accepted], ['done', true]);
});
