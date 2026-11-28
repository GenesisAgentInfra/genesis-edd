// What makes a package ready in each tier, and what the user's checks
// confirmation shows and records: the probe, counterexamples, the fixtures a
// check that asserts absence needs, checks.json 1.0, accepted verdicts,
// judge checks made gating, the must_decide items of baselines and trials,
// the digest of what was shown, and --start-loop.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest, initProject, projectRoot } from '../src/project.js';
import { exportSpec, newSpec } from '../src/spec.js';
import { newEval, rebindEval, reviewFile, syncEval, validateEval } from '../src/eval.js';
import { checkEval, startRun } from '../src/run.js';
import { confirmEval, reviewEval } from '../src/confirm.js';
import { endLoop, startLoop as startLoopBare } from '../src/loop.js';
import { readDecisions } from '../src/records.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AGENT, BEFORE, CHANGE, REF, SPECS, USER, actionOf, assertGapShape, assertNoRoutes, cli, commit, confirmChecks, connect, dropCheck, editChecks, git, harborWhile,
  readyProject, reviewFixtures, setResults, startLoop, toLegacy, useFakeTools, writeExpectations, writeFixtureScripts, writeSpec,
} from './helpers/edd.js';

const FAILURE = 'submit-failure-s1';
const SUCCESS = 'submit-success-s1';
const LINE_FAILURE = '本次提交发送的成功通知数量为零';
const LINE_ONE = '本次提交发送的成功通知数量为一';
const LINE_NONE = '本次提交发送的失败通知数量为零';
const EXPECT = { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' };

const codes = (gaps) => (gaps ?? []).map((entry) => entry.code);
const packageOf = (repo, id) => validateEval(repo, CHANGE).cases.find((item) => item.id === id);
const decided = (review, code) => review.must_decide.filter((entry) => entry.code === code);
const refusedWith = (code) => (error) => {
  assert.equal(error.code, 'CONFIRM_INPUT_BLOCKED', error.message);
  assert.ok(codes(error.gaps).includes(code), `expected ${code} in ${JSON.stringify(error.gaps)}`);
  return true;
};

// Writes review.json from the review_template of eval review, every line
// faithful (a scenario.manual line not_observable) unless verdicts gives
// { 'package\nthen': [verdict, note] }, and returns its path.
function writeReview(repo, verdicts = {}) {
  const review = reviewEval(repo, CHANGE);
  const manual = new Set(review.lines.filter((line) => line.status === 'manual').map((line) => `${line.package}\n${line.then}`));
  const answers = structuredClone(review.review_template);
  answers.review = { origin: 'review', note: 'A fresh reviewer read the scenario, then the verifier.' };
  for (const line of answers.lines) {
    const [verdict, note] = verdicts[`${line.package}\n${line.then}`] ?? [manual.has(`${line.package}\n${line.then}`) ? 'not_observable' : 'faithful', 'Says what the line says.'];
    Object.assign(line, { verdict, note });
  }
  for (const item of answers.packages ?? []) Object.assign(item, { loosens: false, note: 'The diff only adds a build step.' });
  const file = reviewFile(repo, CHANGE);
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  return file;
}

const confirm = (repo, options = {}) => confirmEval(repo, CHANGE, { verdicts: reviewFile(repo, CHANGE), by: 'Dana', ref: 'thread 1', ...options });

// Adds a build step to a package's Dockerfile: what a run executes changes.
function touchPackage(root, id) {
  const file = path.join(root, 'evals', id, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
}

// Readiness: the probe, counterexamples and fixtures by tier.

test('in both tiers a package is ready only once the empty-run probe left every gating check unknown', (t) => {
  for (const tier of ['light', 'full']) {
    const { repo, root } = readyProject(t, tier === 'full' ? { tier: 'full' } : {});
    touchPackage(root, FAILURE);
    // A verifier that judges without evidence of a run: the probe catches it.
    writeFileSync(path.join(repo, 'app/probe.json'), `${JSON.stringify({ [FAILURE]: { c1: 'pass' } })}\n`);
    const caught = checkEval(repo, CHANGE);
    assert.equal(validateEval(repo, CHANGE).tier.readiness, tier);
    assert.deepEqual([caught.passed, caught.failed.probe_judged], [false, [FAILURE]], tier);
    assert.deepEqual(caught.cases[0].probe.unexpected, [{ check: 'c1', result: 'pass' }], tier);
    const item = packageOf(repo, FAILURE);
    assert.deepEqual([item.integration.state, item.integration.missing], ['awaiting_integration', ['check']], tier);
    assert.match(item.integration.detail[0], /the probe judged a result when nothing was done: c1 pass\. Every gating check but a code test must come out unknown/, tier);
    // A run skips the package that is not ready.
    assert.deepEqual(validateEval(repo, CHANGE).gaps.filter((gap) => gap.code === 'integration_pending').map((gap) => gap.case), [FAILURE], tier);
    rmSync(path.join(repo, 'app/probe.json'));
    assert.equal(checkEval(repo, CHANGE).passed, true, tier);
    assert.equal(packageOf(repo, FAILURE).integration.state, 'ready', tier);
  }
});

test('in the full tier a package in checks.json 1.1 needs no author fixture: the probe and a reviewer counterexample for each gating line make it ready', (t) => {
  const { repo, check } = readyProject(t, { tier: 'full', authorFixtures: false });
  const result = validateEval(repo, CHANGE);
  assert.equal(result.tier.readiness, 'full');
  assert.deepEqual(result.cases.map((item) => [item.id, item.integration.state]), [[FAILURE, 'ready'], [SUCCESS, 'ready']]);
  assert.deepEqual(check.cases.map((item) => [item.case, item.fixtures.map((fixture) => fixture.name), item.probe.ok]),
    [[FAILURE, ['review-c1'], true], [SUCCESS, ['review-c1', 'review-c2'], true]]);
  // Without its counterexample a line holds its package back.
  editChecks(repo, SUCCESS, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.name !== 'review-c2'); });
  const item = packageOf(repo, SUCCESS);
  assert.deepEqual([item.integration.missing, item.integration.detail], [['review'], [`review: no reviewer counterexample fails only "${LINE_NONE}"`]]);
});

const TRIGGERED = (entries) => `fixtures: no fixture leaves ${entries} unknown with the scenario run and its evidence missing; the probe never runs the scenario, so it cannot show this`;

test('in the full tier a gating check that asserts absence, and every gating check of a live package, needs a fixture that leaves it unknown with the scenario run; the light tier asks for neither', (t) => {
  const full = readyProject(t, { tier: 'full', authorFixtures: false });
  editChecks(full.repo, SUCCESS, (declared) => { declared.checks[1].absence = true; });
  let item = packageOf(full.repo, SUCCESS);
  assert.deepEqual([item.integration.missing, item.integration.detail], [['fixtures'], [TRIGGERED('c2 (asserts absence)')]]);
  // A fixture that runs the scenario and leaves the evidence of the notices unreadable.
  editChecks(full.repo, SUCCESS, (declared) => {
    declared.fixtures.push({ name: 'notices-unreadable', origin: 'author', note: '报告提交成功，通知记录却读不到', expect: { c1: 'pass', c2: 'unknown' } });
  });
  writeFixtureScripts(full.repo, SUCCESS, ['notices-unreadable']);
  assert.deepEqual(packageOf(full.repo, SUCCESS).integration.missing, ['check']);
  assert.equal(checkEval(full.repo, CHANGE).passed, true);
  assert.equal(packageOf(full.repo, SUCCESS).integration.state, 'ready');
  // absence belongs to a check that reads what the program left.
  editChecks(full.repo, SUCCESS, (declared) => { declared.checks[1].absence = 'yes'; });
  assert.ok(validateEval(full.repo, CHANGE).gaps.some((gap) => gap.code === 'case_invalid' && gap.message.includes('check c2: absence is true for a check that passes when something is not found')));

  // Every gating check of a package that declares a live dependency.
  const live = readyProject(t, { live: [FAILURE], authorFixtures: false });
  assert.equal(validateEval(live.repo, CHANGE).tier.readiness, 'full');
  item = packageOf(live.repo, FAILURE);
  assert.deepEqual([item.integration.missing, item.integration.detail], [['fixtures'], [TRIGGERED('c1 (live package)')]]);
  assert.equal(packageOf(live.repo, SUCCESS).integration.state, 'ready');

  // The light tier proves "cannot tell when nothing happened" by the probe alone.
  const light = readyProject(t, { authorFixtures: false });
  editChecks(light.repo, SUCCESS, (declared) => { declared.checks[1].absence = true; });
  assert.equal(validateEval(light.repo, CHANGE).tier.readiness, 'light');
  assert.deepEqual(packageOf(light.repo, SUCCESS).integration.missing, ['check']);
  assert.equal(checkEval(light.repo, CHANGE).passed, true);
  assert.equal(packageOf(light.repo, SUCCESS).integration.state, 'ready');
});

test('a package in checks.json 1.0 still needs the three author fixtures of every gating check, in the light tier too, and runs no probe', (t) => {
  const { repo } = readyProject(t);
  editChecks(repo, FAILURE, (declared) => toLegacy({ ...declared, fixtures: declared.fixtures.filter((fixture) => fixture.name !== 'unknown') }));
  assert.equal(validateEval(repo, CHANGE).tier.readiness, 'light');
  const item = packageOf(repo, FAILURE);
  assert.deepEqual([item.schema_version, item.integration.missing, item.integration.detail], ['1.0', ['fixtures'], ['fixtures: no fixture expects c1 unknown']]);
  editChecks(repo, FAILURE, (declared) => { declared.fixtures.push({ name: 'unknown', expect: { c1: 'unknown' } }); });
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true);
  assert.deepEqual(checked.cases.map((entry) => [entry.case, entry.fixtures.map((fixture) => fixture.name).sort(), 'probe' in entry]), [[FAILURE, ['fail', 'pass', 'review-c1', 'unknown'], false]]);
  assert.equal(packageOf(repo, FAILURE).integration.state, 'ready');
});

const MOVED = (text, rerun) => `check: \`eval check\` has not proved the package as it is: ${text}. The rest of the package and the kit are as they were then, and of the fixtures \`eval check\` runs ${rerun}`;

test('eval validate names the fixtures added, changed or removed since the last eval check while what a run executes is unchanged, and eval check runs only those', (t) => {
  const { repo } = readyProject(t);
  const before = packageOf(repo, SUCCESS);
  editChecks(repo, SUCCESS, (declared) => {
    declared.fixtures.push({ name: 'one-success', origin: 'review', note: '报告提交成功，却没有发出成功通知', expect: { c1: 'fail', c2: 'pass' } });
  });
  writeFixtureScripts(repo, SUCCESS, ['one-success']);
  let item = packageOf(repo, SUCCESS);
  assert.equal(item.run_digest, before.run_digest);
  assert.notEqual(item.task_digest, before.task_digest);
  assert.deepEqual([item.integration.missing, item.integration.detail], [['check'], [MOVED('fixture one-success was added or changed since it last ran', 'only that one')]]);
  const checked = checkEval(repo, CHANGE);
  assert.deepEqual(checked.cases.map((entry) => [entry.case, entry.ran_fixtures]), [[SUCCESS, ['one-success']]]);
  assert.equal(packageOf(repo, SUCCESS).integration.state, 'ready');
  // What a fixture's results rest on is as it was: nothing runs again.
  editChecks(repo, SUCCESS, (declared) => { declared.fixtures.find((fixture) => fixture.name === 'one-success').note = '报告提交成功，成功通知却没有发出'; });
  item = packageOf(repo, SUCCESS);
  assert.deepEqual(item.integration.detail, [MOVED('only fixture entries of checks.json or files under tests/fixtures/ changed since it last ran, none that a fixture\'s results rest on', 'none again')]);
  assert.deepEqual(checkEval(repo, CHANGE).cases.map((entry) => entry.ran_fixtures), [[]]);
  editChecks(repo, SUCCESS, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.name !== 'one-success'); });
  assert.deepEqual(packageOf(repo, SUCCESS).integration.detail, [MOVED('fixture one-success was removed since it last ran', 'none again')]);
  assert.equal(packageOf(repo, SUCCESS).run_digest, before.run_digest);
});

const AGENT_LOGS = 'names /logs/agent. Harbor copies what the adapter saved there before the verifier runs, and the evaluated program can write there too, so it is no evidence. Read the evidence from where the program cannot reach it.';

test('eval validate warns when a package\'s verifier or the kit\'s verifier/ reads /logs/agent, which the evaluated program can write', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  const script = path.join(root, 'evals', FAILURE, 'tests/test.sh');
  writeFileSync(script, `${readFileSync(script, 'utf8')}# Synthetic: grep -c notice /logs/agent/output.txt\n`);
  // A fixture stands in for the agent, so it may write there.
  writeFileSync(path.join(root, 'evals', SUCCESS, 'tests/fixtures/pass.sh'), '#!/bin/sh\necho done > /logs/agent/output.txt\n');
  // Another folder of that name is no such place.
  const other = path.join(root, 'evals', SUCCESS, 'tests/test.sh');
  writeFileSync(other, `${readFileSync(other, 'utf8')}# Synthetic: ls /logs/agent-notes\n`);
  let warnings = validateEval(repo, CHANGE).warnings;
  assert.deepEqual(warnings.filter((warning) => warning.includes('/logs/agent')), [`${FAILURE}: tests/test.sh ${AGENT_LOGS}`]);
  const verifier = path.join(repo, '.genesis/edd/harness/verifier');
  mkdirSync(verifier, { recursive: true });
  writeFileSync(path.join(verifier, 'reply.py'), 'REPLY = "/logs/agent/reply.txt"\n');
  warnings = validateEval(repo, CHANGE).warnings;
  assert.ok(warnings.includes(`The kit's verifier/reply.py ${AGENT_LOGS}`), JSON.stringify(warnings));
});

// What eval review shows and eval confirm records.

test('eval confirm takes a weaker or stronger line only when the user accepts it with a reason, and records each accepted verdict', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  const weaker = ['weaker', 'It counts any notice, not only those of this submission.'];
  const stronger = ['stronger', 'It also fails when a notice of an earlier submission is left.'];
  writeReview(repo, { [`${SUCCESS}\n${LINE_ONE}`]: weaker, [`${SUCCESS}\n${LINE_NONE}`]: stronger });
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(decided(review, 'verdict_acceptable').map((entry) => [entry.package, entry.then, entry.verdict, entry.note]),
    [[SUCCESS, LINE_ONE, ...weaker], [SUCCESS, LINE_NONE, ...stronger]]);
  // Not accepted, the lines are not confirmed.
  assert.throws(() => confirm(repo), (error) => refusedWith('line_not_faithful')(error) && error.gaps.find((gap) => gap.code === 'line_not_faithful').message.includes('--accept-verdict CASE:THEN with --accept-reason'));
  const one = `${SUCCESS}:${LINE_ONE}`;
  const none = `${SUCCESS}:${LINE_NONE}`;
  // The flags go together, as many reasons as lines or one for all.
  assert.throws(() => confirm(repo, { acceptVerdict: [one] }), /--accept-verdict needs --accept-reason/);
  assert.throws(() => confirm(repo, { acceptVerdict: [one], acceptReason: ['  '] }), /--accept-verdict needs --accept-reason/);
  assert.throws(() => confirm(repo, { acceptReason: ['Good enough.'] }), /^Error: --accept-reason goes with --accept-verdict\.$/);
  assert.throws(() => confirm(repo, { acceptVerdict: [one, none], acceptReason: ['First.', 'Second.', 'Third.'] }), /Give one --accept-reason for all the lines of --accept-verdict, or one for each, in the same order\./);
  assert.throws(() => confirm(repo, { acceptVerdict: [SUCCESS], acceptReason: ['No line named.'] }), /--accept-verdict names a line as CASE:THEN/);
  // Only one line accepted leaves the other unconfirmed.
  assert.throws(() => confirm(repo, { acceptVerdict: [one], acceptReason: ['Good enough.'] }), (error) => refusedWith('line_not_faithful')(error)
    && error.gaps.find((gap) => gap.code === 'line_not_faithful').message.includes(`${SUCCESS} "${LINE_NONE}": stronger`));
  // A faithful line, or one no gating check verifies, has nothing to accept.
  assert.throws(() => confirm(repo, { acceptVerdict: [one, none, `${FAILURE}:${LINE_FAILURE}`, `${FAILURE}:no such line`], acceptReason: ['Good enough.'] }), (error) => {
    refusedWith('verdict_not_acceptable')(error);
    const entry = assertGapShape(error.gaps.find((gap) => gap.code === 'verdict_not_acceptable'), { owner: 'agent', layer: 'package' });
    assert.deepEqual(entry.entries, [`${FAILURE} "${LINE_FAILURE}" is faithful, so there is nothing to accept`, `${FAILURE} "no such line" is not a line a gating check verifies`]);
    assert.ok(!codes(error.gaps).includes('line_not_faithful'), JSON.stringify(error.gaps));
    return true;
  });

  // One reason for every line.
  const result = confirm(repo, { acceptVerdict: [one, none], acceptReason: ['The user counts notices by hand once a week.'] });
  const stored = result.confirmation;
  assert.deepEqual(stored.accepted_verdicts, [
    { package: SUCCESS, then: LINE_ONE, verdict: weaker[0], note: weaker[1], reason: 'The user counts notices by hand once a week.' },
    { package: SUCCESS, then: LINE_NONE, verdict: stronger[0], note: stronger[1], reason: 'The user counts notices by hand once a week.' }]);
  assert.deepEqual(result.accepted_verdicts, stored.accepted_verdicts);
  assert.deepEqual(stored.lines.map((line) => [line.then, line.verdict, line.accepted_by_user ?? null]), [[LINE_FAILURE, 'faithful', null],
    [LINE_ONE, 'weaker', { reason: 'The user counts notices by hand once a week.' }], [LINE_NONE, 'stronger', { reason: 'The user counts notices by hand once a week.' }]]);
  assert.deepEqual(stored.must_decide.filter((entry) => entry.code === 'verdict_acceptable').map((entry) => [entry.then, entry.decision]), [[LINE_ONE, 'accepted'], [LINE_NONE, 'accepted']]);
  assert.deepEqual([stored.confirmed.by, stored.confirmed.ref], ['Dana', 'thread 1']);
  assert.ok(result.warnings.some((warning) => warning.startsWith(`The user accepted checks that ask less or more than their lines: "${LINE_ONE}" (${SUCCESS}) weaker; "${LINE_NONE}" (${SUCCESS}) stronger.`)), JSON.stringify(result.warnings));

  // One reason for each line, in the same order, on the command line.
  const shown = cli(['eval', 'confirm', CHANGE, '--repo', repo, '--verdicts', reviewFile(repo, CHANGE), '--by', 'Lee', '--ref', 'thread 2',
    '--accept-verdict', one, '--accept-reason', 'Counted by hand.', '--accept-verdict', none, '--accept-reason', 'Stricter is fine here.']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.json.accepted_verdicts.map((entry) => [entry.then, entry.reason]), [[LINE_ONE, 'Counted by hand.'], [LINE_NONE, 'Stricter is fine here.']]);
  assert.equal(shown.json.confirmation.confirmed.kind, 'revision');
});

test('eval confirm never accepts a line whose checks verify something else, or nothing', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  for (const verdict of ['different', 'vacuous']) {
    writeReview(repo, { [`${SUCCESS}\n${LINE_ONE}`]: [verdict, 'It reads another record.'] });
    assert.deepEqual(decided(reviewEval(repo, CHANGE), 'verdict_acceptable'), [], verdict);
    assert.throws(() => confirm(repo, { acceptVerdict: [`${SUCCESS}:${LINE_ONE}`], acceptReason: ['Good enough.'] }), (error) => {
      refusedWith('verdict_not_acceptable')(error);
      refusedWith('line_not_faithful')(error);
      assert.deepEqual(error.gaps.find((gap) => gap.code === 'verdict_not_acceptable').entries,
        [`${SUCCESS} "${LINE_ONE}" is ${verdict}: a check of something else, or of nothing, is never gating; fix it or move the line to scenario.manual`]);
      return true;
    }, verdict);
  }
});

test('expect_differs is one must_decide item for every gating check whose expect is worded otherwise than its line, and a confirmation records every item no flag decides as confirmed as shown', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  editChecks(repo, FAILURE, (declared) => { declared.checks[0].expect = '本次提交没有发出成功通知'; });
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks[1].expect = '本次提交没有发出失败通知';
    dropCheck(declared, 'c1');
    declared.fixtures = declared.fixtures.filter((fixture) => fixture.name !== 'review-c1');
    declared.scenario.manual = [{ then: LINE_ONE, reason: 'synthetic: judged by a person' }];
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const review = reviewEval(repo, CHANGE);
  const differs = decided(review, 'expect_differs');
  assert.equal(differs.length, 1);
  assert.deepEqual(differs[0].lines, [{ package: FAILURE, then: LINE_FAILURE, check: 'c1', expect: '本次提交没有发出成功通知' },
    { package: SUCCESS, then: LINE_NONE, check: 'c2', expect: '本次提交没有发出失败通知' }]);
  assert.equal(differs[0].message, `The expects of these gating checks are worded otherwise than their lines: ${FAILURE}/c1 expects "本次提交没有发出成功通知" for "${LINE_FAILURE}"; ${SUCCESS}/c2 expects "本次提交没有发出失败通知" for "${LINE_NONE}". The user reads whether each says the same, no less and no more.`);
  assert.deepEqual(review.must_decide.map((entry) => entry.code), ['manual_line', 'expect_differs']);
  assert.deepEqual(review.must_show.must_decide, review.must_decide);
  writeReview(repo);
  const result = confirm(repo);
  assert.deepEqual(result.confirmation.must_decide.map((entry) => [entry.code, entry.decision]), [['manual_line', 'confirmed_as_shown'], ['expect_differs', 'confirmed_as_shown']]);
  assert.deepEqual(result.confirmation.must_decide[1].lines, differs[0].lines);
  assert.deepEqual(result.must_decide, result.confirmation.must_decide);
  // One reworded expect is one item too, in the singular.
  editChecks(repo, FAILURE, (declared) => { declared.checks[0].expect = LINE_FAILURE; });
  const single = decided(reviewEval(repo, CHANGE), 'expect_differs');
  assert.deepEqual(single.map((entry) => entry.lines.length), [1]);
  assert.match(single[0].message, /^The expect of this gating check is worded otherwise than its line: /);
});

test('eval confirm records the digest of what eval review showed with the answers, and which file the answers came from', (t) => {
  const { repo, root } = readyProject(t, { confirm: false });
  const unanswered = reviewEval(repo, CHANGE);
  assert.equal(unanswered.shown, digest(JSON.stringify(unanswered.must_show)));
  writeReview(repo);
  const answered = reviewEval(repo, CHANGE);
  assert.equal(answered.shown, digest(JSON.stringify(answered.must_show)));
  // The answers are part of what the user sees.
  assert.notEqual(answered.shown, unanswered.shown);
  assert.deepEqual(answered.must_show.lines.map((line) => line.verdict), ['faithful', 'faithful', 'faithful']);
  // Answers given in another file are taken with a warning; the digest is
  // that of the review with them.
  const other = path.join(root, 'answers.json');
  writeFileSync(other, readFileSync(reviewFile(repo, CHANGE)));
  const result = confirmEval(repo, CHANGE, { verdicts: other, by: USER, ref: REF });
  assert.equal(result.confirmation.shown, answered.shown);
  assert.deepEqual(result.shown_source, { verdicts: `.genesis/edd/${CHANGE}/answers.json`, review_file: false });
  assert.ok(result.warnings.some((warning) => warning.startsWith(`--verdicts names .genesis/edd/${CHANGE}/answers.json, not .genesis/edd/${CHANGE}/review.json, which \`eval review\` reads`)), JSON.stringify(result.warnings));
});

// A project whose change was started with `spec new` on a commit that holds
// the application, with nothing uncommitted: the code before the change, as
// `spec new` records it. Its packages are those of readyProject, each line
// with a reviewer's counterexample, and eval check has proved them.
function startedOnCommit(t, { commitEvals = true } = {}) {
  useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Genesis Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  initProject(repo, 'existing', 'none');
  setResults(repo, BEFORE);
  const start = commit(repo, 'The application before the change');
  newSpec(repo, CHANGE);
  writeSpec(repo, SPECS.two);
  exportSpec(repo, CHANGE);
  newEval(repo, CHANGE);
  const root = path.join(repo, '.genesis/edd', CHANGE);
  writeFileSync(path.join(repo, '.genesis/edd/harness/harness.json'), `${JSON.stringify({ agent: AGENT }, null, 2)}\n`);
  for (const id of [FAILURE, SUCCESS]) {
    const directory = path.join(root, 'evals', id);
    const written = editChecks(repo, id, (declared) => { declared.fixtures = reviewFixtures(declared); });
    writeFixtureScripts(repo, id, written.fixtures.map((fixture) => fixture.name));
    writeFileSync(path.join(directory, 'environment/Dockerfile'), 'FROM alpine:3.20\nWORKDIR /app\n');
    writeFileSync(path.join(directory, 'tests/test.sh'), `#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\n# Synthetic verifier.\n${written.checks.map((check) => `gate ${check.id} unknown "synthetic"`).join('\n')}\nfinish\n`, { mode: 0o755 });
    connect(repo, id);
  }
  if (commitEvals) commit(repo, 'Add the evals');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  return { repo, root, start };
}

test('code_changed_before_baseline names the application files a base record ran with that differ from the code spec new recorded, also on a later commit', (t) => {
  const { repo, start } = startedOnCommit(t);
  // The evals are no application code: a baseline on that code shows nothing.
  const first = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(first.is_baseline, true);
  assert.deepEqual(decided(reviewEval(repo, CHANGE), 'code_changed_before_baseline'), []);
  // The application changed and was committed before another baseline.
  setResults(repo, { ...BEFORE, [FAILURE]: { c1: 'pass' } });
  commit(repo, 'Change the application before the baseline');
  const moved = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const [item] = decided(reviewEval(repo, CHANGE), 'code_changed_before_baseline');
  assert.deepEqual(item.records.map((entry) => [entry.run_id, entry.files, entry.spec_code.commit, entry.spec_code.basis]), [[moved.run_id, ['app/results.json'], start, 'content']]);
  assert.equal(item.message, `${moved.run_id} ran on other code than \`spec new\` recorded for this change (commit ${start.slice(0, 7)}): these application files differ from it: app/results.json. The user decides whether that code is the code before the change.`);
  // The confirmation records it as shown.
  writeReview(repo);
  const recorded = confirm(repo).confirmation.must_decide.find((entry) => entry.code === 'code_changed_before_baseline');
  assert.deepEqual([recorded.decision, recorded.records.map((entry) => entry.files)], ['confirmed_as_shown', [['app/results.json']]]);
});

test('code_changed_before_baseline names the uncommitted application files of a base record on the commit spec new recorded', (t) => {
  const { repo, start } = startedOnCommit(t, { commitEvals: false });
  // The Spec, the packages and the records are no application code.
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(decided(reviewEval(repo, CHANGE), 'code_changed_before_baseline'), []);
  setResults(repo, { ...BEFORE, [FAILURE]: { c1: 'pass' } });
  const moved = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const [item] = decided(reviewEval(repo, CHANGE), 'code_changed_before_baseline');
  assert.deepEqual(item.records.map((entry) => [entry.run_id, entry.code.commit, entry.uncommitted, entry.files]), [[moved.run_id, start, ['app/results.json'], ['app/results.json']]]);
  assert.match(item.message, /: these application files differ from it: app\/results\.json\. The user decides/);
});

test('code_changed_before_baseline explains that a .dockerignore is application code, since it decides what goes into the image', (t) => {
  const { repo, start } = startedOnCommit(t);
  writeFileSync(path.join(repo, '.dockerignore'), '.genesis\n');
  commit(repo, 'Keep the records out of the image');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const [item] = decided(reviewEval(repo, CHANGE), 'code_changed_before_baseline');
  assert.deepEqual(item.records.map((entry) => [entry.run_id, entry.files]), [[base.run_id, ['.dockerignore']]]);
  assert.equal(item.message, `${base.run_id} ran on other code than \`spec new\` recorded for this change (commit ${start.slice(0, 7)}): these application files differ from it: .dockerignore. A .dockerignore decides what goes into the image, so it counts as application code; a package that builds from the project root needs its .genesis rule. The user decides whether that code is the code before the change.`);
});

test('trials made before the first base record are a must_decide item with what they failed and passed, and the confirmation records them as shown', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  const trial = startRun(repo, CHANGE, { trial: true });
  let [item] = decided(reviewEval(repo, CHANGE), 'trial_before_baseline');
  const facts = ({ started_at: startedAt, ...rest }) => rest;
  assert.deepEqual(item.trials.map(facts), [{ run_id: trial.run_id, cases: [FAILURE, SUCCESS], code_matches: null, failed: [`${FAILURE}/c1`], passed: [`${SUCCESS}/c1`, `${SUCCESS}/c2`] }]);
  assert.equal(item.message, `${trial.run_id} is a trial made before the first base record of this Spec export, so its results were seen before any expectation was fixed by a baseline; failed: ${FAILURE}/c1. The user decides whether the expected results still say what the change is for.`);
  // The baseline after it ran on the same code; a trial after it is not listed.
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startRun(repo, CHANGE, { trial: true });
  [item] = decided(reviewEval(repo, CHANGE), 'trial_before_baseline');
  assert.deepEqual(item.trials.map((entry) => [entry.run_id, entry.code_matches]), [[trial.run_id, true]]);
  assert.match(item.message, /is a trial made before the first base record of this Spec export, on the code the base records describe, so/);
  writeReview(repo);
  const recorded = confirm(repo).confirmation.must_decide.find((entry) => entry.code === 'trial_before_baseline');
  assert.deepEqual([recorded.decision, recorded.trials.map((entry) => entry.run_id)], ['confirmed_as_shown', [trial.run_id]]);
});

// A judge check: the project's own judging program for a line the user judges.
function judgedProject(t) {
  const project = readyProject(t, { confirm: false });
  const { repo, root } = project;
  const tests = path.join(root, 'evals', SUCCESS, 'tests');
  editChecks(repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.fixtures = declared.fixtures.filter((fixture) => fixture.name !== 'review-c2');
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: a person reads the notices' }];
    declared.checks.push({ id: 'c3', intent: 'REQ-submit-success', then: LINE_NONE, expect: LINE_NONE, role: 'diagnostic', kind: 'judge', program: 'judges/notices.sh' });
  });
  mkdirSync(path.join(tests, 'judges'), { recursive: true });
  writeFileSync(path.join(tests, 'judges/notices.sh'), '#!/bin/sh\n# Synthetic judge.\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(tests, 'test.sh'), '#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\n# Synthetic verifier.\ngate c1 unknown "synthetic"\njudge c3 judges/notices.sh\nfinish\n', { mode: 0o755 });
  assert.deepEqual(validateEval(repo, CHANGE).gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  return project;
}

test('a judge check stays diagnostic unless the user makes its line gating at confirmation, which needs a faithful verdict and a proof that it can fail', (t) => {
  const { repo } = judgedProject(t);
  const judged = `${SUCCESS}:${LINE_NONE}`;
  let review = reviewEval(repo, CHANGE);
  const [item] = decided(review, 'judge_check');
  assert.deepEqual([item.package, item.check, item.then, item.gating, item.proof.sources], [SUCCESS, 'c3', LINE_NONE, false, []]);
  assert.deepEqual(review.must_show.judge_checks.map((entry) => [entry.package, entry.check, entry.then, entry.declared_role, entry.program, entry.gating]),
    [[SUCCESS, 'c3', LINE_NONE, 'diagnostic', 'judges/notices.sh', false]]);
  assert.throws(() => confirm(repo, { judgeGating: [SUCCESS] }), /--judge-gating names a line as CASE:THEN/);
  writeReview(repo);
  // A line no judge check verifies cannot be made gating.
  assert.throws(() => confirm(repo, { judgeGating: [`${SUCCESS}:${LINE_ONE}`] }), (error) => refusedWith('judge_gating_unknown')(error)
    && Boolean(assertGapShape(error.gaps.find((gap) => gap.code === 'judge_gating_unknown'), { entries: [`${SUCCESS}:${LINE_ONE}`] })));
  // Made gating, the line is held as a line a program checks: not_observable
  // is no faithful verdict, and nothing shows that the judge can fail.
  assert.throws(() => confirm(repo, { judgeGating: [judged] }), (error) => {
    refusedWith('line_not_faithful')(error);
    refusedWith('line_unproven')(error);
    assert.ok(error.gaps.find((gap) => gap.code === 'line_unproven').message.includes(`${SUCCESS} "${LINE_NONE}" (judged by c3)`), JSON.stringify(error.gaps));
    return true;
  });
  // A reviewer's counterexample that names the line and fails its judge check.
  editChecks(repo, SUCCESS, (declared) => {
    declared.fixtures.push({ name: 'judged-wrong', origin: 'review', then: LINE_NONE, note: '报告提交成功，却也发出了一条失败通知', expect: { c1: 'pass', c3: 'fail' } });
  });
  writeFixtureScripts(repo, SUCCESS, ['judged-wrong']);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  writeReview(repo, { [`${SUCCESS}\n${LINE_NONE}`]: ['faithful', 'The judge reads every notice of this submission.'] });
  // Left diagnostic, the user's line takes only not_observable.
  assert.throws(() => confirm(repo), refusedWith('manual_disputed'));
  const result = confirm(repo, { judgeGating: [judged] });
  const stored = result.confirmation;
  assert.deepEqual(stored.judge_gating, [judged]);
  const line = stored.lines.find((entry) => entry.then === LINE_NONE);
  assert.deepEqual([line.status, line.judge_gating, line.checks, line.verdict, line.proof.sources, line.proof.counterexamples], ['manual', true, ['c3'], 'faithful', ['counterexample'], ['judged-wrong']]);
  assert.deepEqual(stored.must_decide.map((entry) => [entry.code, entry.decision]), [['manual_line', 'confirmed_as_shown'], ['judge_check', 'gating']]);
  // The workflow status reads the confirmation's judge lines.
  assert.deepEqual(workflowStatus(repo, CHANGE).layers.confirmation.latest.judge_gating, [judged]);
  review = reviewEval(repo, CHANGE);
  assert.equal(decided(review, 'judge_check')[0].gating, true);
});

test('eval confirm --start-loop records that the user\'s words also start a loop: the next loop start needs no --by or --ref, and the one after it does', (t) => {
  const project = readyProject(t, { proof: 'baseline', startLoop: true });
  const { repo, root } = project;
  const entry = project.confirmation.confirmation;
  assert.deepEqual([entry.start_loop, project.confirmation.start_loop], [true, true]);
  assert.deepEqual(project.confirmation.new_loop_needs, { baseline: false, user_consent: false });
  const offered = actionOf(workflowStatus(repo, CHANGE), 'loop', 'start');
  assert.ok(offered.allowed && !offered.command.includes('--by'), JSON.stringify(offered));
  assert.ok(offered.needs[0].includes(`recorded by checks confirmation ${entry.id}`), JSON.stringify(offered.needs));
  const started = startLoopBare(repo, CHANGE);
  assert.deepEqual(started.consent, { via: 'confirmation', confirmation: entry.id, by: USER, ref: REF, at: entry.confirmed.at });
  const decision = readDecisions(root).entries.filter((item) => item.type === 'loop_start').at(-1);
  assert.deepEqual([decision.via, decision.confirmation, decision.by], ['confirmation', entry.id, undefined]);
  // Once a loop started after the confirmation, the next one is the user's decision again.
  endLoop(repo, CHANGE, { reason: 'Synthetic: the agent stops this loop.' });
  assert.throws(() => startLoopBare(repo, CHANGE), (error) => {
    const consent = assertGapShape(error.gaps.find((gap) => gap.code === 'loop_consent_missing'), { owner: 'user', layer: 'loop', start_loop: true, loop_started_since: true });
    assert.ok(consent.message.includes(`the checks confirmation ${entry.id} recorded that agreement, but a loop started after it`), consent.message);
    return true;
  });
  assert.ok(actionOf(workflowStatus(repo, CHANGE), 'loop', 'start').command.includes('--by'));
  assert.deepEqual(startLoop(repo, CHANGE).consent.by, USER);
  assertNoRoutes(started.consent);
});

// The packages a pass rests on: shared verifier code, a proof of one version,
// and a new export.

test('a package whose shared verifier code differs from the kit\'s is refused by eval check and eval confirm until eval sync writes the kit\'s code into it', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  const helper = path.join(root, 'evals', FAILURE, 'tests/genesis.sh');
  writeFileSync(helper, `${readFileSync(helper, 'utf8')}# Edited in the package.\n`);
  const gap = assertGapShape(validateEval(repo, CHANGE).gaps.find((entry) => entry.code === 'shared_code_mismatch'), { case: FAILURE, owner: 'agent', layer: 'package', files: ['tests/genesis.sh'] });
  assert.ok(gap.message.includes('`eval sync` writes it into the package'), gap.message);
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, false);
  assert.deepEqual(checked.refused.map((entry) => [entry.code, entry.case]), [['shared_code_mismatch', FAILURE]]);
  assert.throws(() => confirmChecks(project, { reason: 'An edited helper.' }), refusedWith('shared_code_mismatch'));
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => codes(error.gaps).includes('shared_code_mismatch'));
  // The kit's verifier code is shared too: a file added there differs from every package.
  const verifier = path.join(repo, '.genesis/edd/harness/verifier');
  mkdirSync(verifier, { recursive: true });
  writeFileSync(path.join(verifier, 'count.py'), 'def count(notices):\n    return len(notices)\n');
  assert.deepEqual(validateEval(repo, CHANGE).gaps.filter((entry) => entry.code === 'shared_code_mismatch').map((entry) => [entry.case, entry.files]),
    [[FAILURE, ['tests/genesis.sh', 'tests/shared/count.py']], [SUCCESS, ['tests/shared/count.py']]]);
  const synced = syncEval(repo, CHANGE);
  assert.deepEqual(synced.written.map((entry) => [entry.case, entry.files]), [[FAILURE, ['tests/genesis.sh', 'tests/shared/count.py']], [SUCCESS, ['tests/shared/count.py']]]);
  assert.ok(synced.written.every((entry) => entry.run_digest.from !== entry.run_digest.to));
  assert.deepEqual(validateEval(repo, CHANGE).gaps.filter((entry) => entry.code === 'shared_code_mismatch'), []);
  assert.equal(readFileSync(path.join(root, 'evals', SUCCESS, 'tests/shared/count.py'), 'utf8'), 'def count(notices):\n    return len(notices)\n');
  assert.deepEqual(syncEval(repo, CHANGE).written, []);
  assert.equal(checkEval(repo, CHANGE).passed, true);
});

test('a package that changes while eval check runs it keeps no proof, even when the change is undone before the check ends', (t) => {
  const { repo, root, tools } = readyProject(t);
  touchPackage(root, FAILURE);
  harborWhile(t, FAILURE, `.genesis/edd/${CHANGE}/evals/${FAILURE}/tests/test.sh`, '#!/bin/sh\n# Edited from another shell.\n');
  const checked = checkEval(repo, CHANGE);
  const [item] = checked.cases;
  assert.deepEqual([checked.passed, checked.failed.package_changed_during_check, checked.proved], [false, [FAILURE], []]);
  assert.deepEqual([item.case, item.package_changed_during_check, item.recorded], [FAILURE, true, false]);
  assert.ok(item.changed_files.includes(`${FAILURE}/tests/test.sh`), JSON.stringify(item.changed_files));
  assert.deepEqual(packageOf(repo, FAILURE).integration.missing, ['check']);
  tools.harbor(true);
  assert.deepEqual(checkEval(repo, CHANGE).proved, [FAILURE]);
  assert.equal(packageOf(repo, FAILURE).integration.state, 'ready');
});

test('eval rebind binds to a new export the packages whose scenario reads the same, keeps their proofs, lists the others as stale, and eval review shows the user each re-binding', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace(LINE_ONE, '本次提交只发送一条成功通知'));
  const exported = exportSpec(repo, CHANGE);
  const rebound = rebindEval(repo, CHANGE);
  assert.deepEqual(rebound.rebound.map((entry) => [entry.case, entry.to, entry.basis]), [[FAILURE, exported.id, 'export']]);
  assert.deepEqual(rebound.stale.map((entry) => entry.case), [SUCCESS]);
  assert.ok(rebound.stale[0].reasons.includes(`"${LINE_ONE}" is no THEN or AND line of the scenario in the current export`), JSON.stringify(rebound.stale));
  const declared = JSON.parse(readFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), 'utf8'));
  assert.equal(declared.spec_ref.sha256, exported.id);
  assert.deepEqual(declared.rebound.map((entry) => [entry.from.sha256, entry.to]), [[project.confirmation.confirmation.spec.sha256, exported.id]]);
  // Its proofs do not rest on the export it is bound to.
  const evals = validateEval(repo, CHANGE);
  assert.equal(evals.cases.find((item) => item.id === FAILURE).integration.state, 'ready');
  assert.deepEqual(evals.gaps.filter((gap) => gap.code === 'case_stale').map((gap) => gap.case), [SUCCESS]);
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.lines.filter((line) => line.package === FAILURE).map((line) => line.proof.sources), [['counterexample']]);
  const [item] = decided(review, 'package_rebound');
  assert.deepEqual(item.packages.map((entry) => entry.package), [FAILURE]);
  assert.match(item.message, /^`eval rebind` bound submit-failure-s1 \(from another export \w{12}, against the export it was written for\) to this Spec export/);
  // Running it again binds nothing more.
  assert.deepEqual([rebindEval(repo, CHANGE).rebound, rebindEval(repo, CHANGE).current], [[], [FAILURE]]);
  const shown = cli(['eval', 'rebind', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 1);
});

test('a package eval rebind binds to a new export keeps its reviewer\'s verdict in eval review', (t) => {
  const { repo } = readyProject(t);
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace(LINE_ONE, '本次提交只发送一条成功通知'));
  exportSpec(repo, CHANGE);
  assert.deepEqual(rebindEval(repo, CHANGE).rebound.map((entry) => entry.case), [FAILURE]);
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.review_template.lines.filter((line) => line.package === FAILURE).map((line) => line.verdict), ['faithful']);
  assert.deepEqual(review.lines.filter((line) => line.package === FAILURE).map((line) => line.review?.carried ?? null), [true]);
});

// The network: a package that can reach outside networks declares a live
// dependency, and the light tier holds only sealed packages.

const COMPOSE_NAME = 'environment/docker-compose.yaml';
const setNetwork = (root, id, { compose, task }) => {
  const directory = path.join(root, 'evals', id);
  if (compose === null) rmSync(path.join(directory, COMPOSE_NAME), { force: true });
  else if (compose !== undefined) writeFileSync(path.join(directory, COMPOSE_NAME), compose);
  if (task !== undefined) {
    const file = path.join(directory, 'task.toml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^network_mode = "[^"]*"$/m, `network_mode = "${task}"`));
  }
};

test('whether a package is sealed is read from its compose file and task.toml, as Harbor runs it', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  const sealed = () => packageOf(repo, FAILURE).sealed;
  // eval new writes network_mode: none for main.
  assert.deepEqual(sealed(), { value: true, reason: 'environment/docker-compose.yaml gives every service network_mode: none or only networks declared internal: true' });
  const stand = (internal) => `services:\n  main:\n    networks: [stand]\n  api:\n    image: python:3.12-slim\n    networks: [stand]\nnetworks:\n  stand:\n${internal ? '    internal: true\n' : '    driver: bridge\n'}`;
  setNetwork(root, FAILURE, { compose: stand(true) });
  assert.equal(sealed().value, true);
  setNetwork(root, FAILURE, { compose: stand(false) });
  assert.deepEqual(sealed(), { value: false, reason: 'service main joins network stand, which is not declared internal: true' });
  setNetwork(root, FAILURE, { compose: 'services:\n  main:\n    network_mode: host\n' });
  assert.deepEqual(sealed(), { value: false, reason: 'service main has network_mode host' });
  // A service that sets no network joins the default one.
  setNetwork(root, FAILURE, { compose: 'services:\n  main:\n    network_mode: none\n  api:\n    image: python:3.12-slim\n' });
  assert.deepEqual(sealed(), { value: false, reason: 'service api sets no network, so it joins the default network, which is not declared internal: true' });
  setNetwork(root, FAILURE, { compose: 'services:\n  main:\n    network_mode: none\n', task: 'allowlist' });
  assert.equal(sealed().value, false);
  assert.match(sealed().reason, /allowlist/);
  // With only a Dockerfile, task.toml decides: public reaches outside networks.
  setNetwork(root, FAILURE, { compose: null, task: 'public' });
  assert.deepEqual(sealed(), { value: false, reason: 'there is no environment/docker-compose.yaml and task.toml sets network_mode = "public", so the program can reach outside networks' });
  setNetwork(root, FAILURE, { task: 'no-network' });
  assert.equal(sealed().value, true);
  // A stand-in with no network of its own behind Harbor's egress sidecar is sealed, with a warning.
  setNetwork(root, FAILURE, { compose: 'services:\n  api:\n    image: python:3.12-slim\n' });
  assert.equal(sealed().value, true);
  assert.ok(validateEval(repo, CHANGE).warnings.some((warning) => warning.startsWith(`${FAILURE}: task.toml sets network_mode = "no-network", so Harbor puts api`)));
  setNetwork(root, FAILURE, { compose: 'services: [', task: 'public' });
  assert.equal(sealed().value, false);
  assert.match(sealed().reason, /^environment\/docker-compose\.yaml cannot be parsed/);
});

test('a package that can reach outside networks and declares no live dependency is a must_decide item, keeps the change out of the light tier, and no confirmation takes it until it is sealed or declared live', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  setNetwork(root, FAILURE, { compose: null });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const evals = validateEval(repo, CHANGE);
  assert.deepEqual([evals.tier.eligible, evals.tier.reasons.map((entry) => [entry.condition, entry.package])], [false, [['sealed', FAILURE]]]);
  const review = reviewEval(repo, CHANGE);
  const [item] = decided(review, 'network_undeclared');
  assert.deepEqual(item.packages, [FAILURE]);
  assert.ok(item.message.startsWith(`${FAILURE} (there is no environment/docker-compose.yaml and task.toml sets network_mode = "public", so the program can reach outside networks): this package can reach outside networks but declares no live dependency`), item.message);
  assert.equal(review.run_plan.tier.proposed, 'full');
  for (const tier of [undefined, 'full']) {
    assert.throws(() => confirmChecks(project, { reason: 'The package lost its compose file.', tier }), (error) => {
      refusedWith('network_undeclared')(error);
      assertGapShape(error.gaps.find((gap) => gap.code === 'network_undeclared'), { owner: 'agent', layer: 'package', cases: [FAILURE] });
      return true;
    }, String(tier));
  }
  // Declared live, the package runs the user's number of attempts in the full tier.
  editChecks(repo, FAILURE, (declared) => {
    declared.dependencies = [{ name: 'model', mode: 'live', note: 'Synthetic model call.' }];
    declared.fixtures.push({ name: 'model-unreadable', origin: 'author', note: '提交失败，模型的回复却读不到', expect: { c1: 'unknown' } });
  });
  writeFixtureScripts(repo, FAILURE, ['model-unreadable']);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.deepEqual(decided(reviewEval(repo, CHANGE), 'network_undeclared'), []);
  assert.throws(() => confirmChecks(project, { reason: 'It calls a model.' }), refusedWith('attempts_undecided'));
  const live = confirmChecks(project, { reason: 'It calls a model.', attempts: 3 });
  assert.deepEqual([live.confirmation.run_plan.tier, live.confirmation.run_plan.attempts], ['full', 3]);
});

test('in the light tier each package runs once with the agent of harness.json: eval confirm refuses --agent and --model, and records no number of attempts', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  writeReview(repo);
  assert.throws(() => confirm(repo, { agent: 'other_agent:Other' }), (error) => {
    refusedWith('light_plan_fixed')(error);
    assertGapShape(error.gaps.find((gap) => gap.code === 'light_plan_fixed'), { flags: ['agent'], layer: 'confirmation' });
    return true;
  });
  // A model makes the change of the full tier, which --tier light cannot overrule.
  assert.throws(() => confirm(repo, { model: 'synthetic/model-x', tier: 'light', attempts: 1 }), (error) => {
    refusedWith('tier_light_unfit')(error);
    refusedWith('light_plan_fixed')(error);
    assert.deepEqual(error.gaps.find((gap) => gap.code === 'tier_light_unfit').reasons.map((entry) => entry.condition), ['model']);
    return true;
  });
  assert.equal(reviewEval(repo, CHANGE).run_plan.tier.proposed, 'light');
  const result = confirm(repo, { attempts: 3 });
  assert.deepEqual([result.confirmation.run_plan.tier, result.confirmation.run_plan.attempts, result.confirmation.run_plan.agent, result.confirmation.run_plan.model],
    ['light', null, AGENT, null]);
  assert.ok(result.warnings.includes('In the light tier every package runs once, so --attempts 3 changes nothing and is not recorded.'), JSON.stringify(result.warnings));
  // The user may always ask for the full tier, which stays for later confirmations of the export.
  writeReview(repo);
  const full = confirm(repo, { tier: 'full', agent: 'other_agent:Other' });
  assert.deepEqual([full.confirmation.run_plan.tier, full.confirmation.run_plan.tier_by, full.confirmation.run_plan.agent], ['full', 'flag', 'other_agent:Other']);
  writeReview(repo);
  assert.equal(confirm(repo).confirmation.run_plan.tier, 'full');
});

test('the full tier the user asked for with --tier full stays for every later confirmation of the export', (t) => {
  const project = readyProject(t, { tier: 'full' });
  const { repo } = project;
  assert.deepEqual([project.confirmation.confirmation.run_plan.tier, project.confirmation.confirmation.run_plan.tier_by], ['full', 'flag']);
  for (const reason of ['Confirmed again.', 'And again.']) {
    assert.deepEqual([reviewEval(repo, CHANGE).run_plan.tier.proposed, reviewEval(repo, CHANGE).run_plan.tier.requested], ['full', 'full'], reason);
    writeReview(repo);
    assert.equal(confirm(repo, { reason }).confirmation.run_plan.tier, 'full', reason);
  }
});
