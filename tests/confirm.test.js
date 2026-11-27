import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ignoredArtifacts, readJSON } from '../src/project.js';
import { exportSpec } from '../src/spec.js';
import { confirmationFile, confirmationId, evalSnapshot, readConfirmation, reviewFile } from '../src/eval.js';
import { checkEval, startRun } from '../src/run.js';
import { loopStatus, startLoop } from '../src/loop.js';
import { confirmEval, reviewEval } from '../src/confirm.js';
import {
  AGENT, CHANGE, LIVE_DEPENDENCY, SPECS, cli, commit, confirmChecks, connect, dropCheck, editChecks, readRecord, readyProject, reviewFixtures, toLegacy,
  writeExpectations, writeFixtureScripts, writeSpec,
} from './helpers/edd.js';

const FAILURE = 'submit-failure-s1';
const SUCCESS = 'submit-success-s1';
const LINE_FAILURE = '本次提交发送的成功通知数量为零';
const LINE_ONE = '本次提交发送的成功通知数量为一';
const LINE_NONE = '本次提交发送的失败通知数量为零';
const EXPECT = { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' };
// What eval review's estimate leaves out, as run_plan.not_counted names it.
const NOT_COUNTED = [
  'the reviewer\'s passes in eval review and in the final review, which run in your coding agent',
  'model calls, which fixtures do not make; the baseline shows their cost',
];

const codes = (gaps) => (gaps ?? []).map((entry) => entry.code);
const refusedWith = (code) => (error) => {
  assert.equal(error.code, 'CONFIRM_INPUT_BLOCKED', error.message);
  assert.ok(codes(error.gaps).includes(code), `expected ${code} in ${JSON.stringify(error.gaps)}`);
  return true;
};

// Writes review.json from the review_template of eval review, with change
// applied to the answers, and returns its path.
function writeReview(repo, change = () => {}) {
  const answers = structuredClone(reviewEval(repo, CHANGE).review_template);
  answers.review = { origin: 'review', note: 'A fresh reviewer read the scenario, then the verifier.' };
  for (const line of answers.lines) {
    line.verdict ??= 'faithful';
    line.note ??= 'Says what the line says.';
  }
  for (const item of answers.packages ?? []) Object.assign(item, { loosens: false, note: 'The diff only adds a build step.' });
  change(answers);
  const file = reviewFile(repo, CHANGE);
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  return file;
}

const confirm = (repo, options = {}) => confirmEval(repo, CHANGE, { verdicts: reviewFile(repo, CHANGE), by: 'Dana', ref: 'thread 1', ...options });

// Changes what a package executes, then proves it again unless check is false.
function changePackage(project, id, { check = true } = {}) {
  const file = path.join(project.root, 'evals', id, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  if (check) assert.equal(checkEval(project.repo, CHANGE).passed, true);
}

// Sets values in the project kit's harness.json.
function setKit(repo, values) {
  const file = path.join(repo, '.genesis/edd/harness/harness.json');
  writeFileSync(file, `${JSON.stringify({ ...readJSON(file), ...values }, null, 2)}\n`);
}

test('eval review lists every THEN line with its checks and counterexamples, the reviewer\'s questions and brief, a template and a run plan', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const review = reviewEval(repo, CHANGE);
  assert.equal(review.confirmation, null);
  assert.equal(review.current, false);
  assert.deepEqual(review.lines.map((line) => [line.package, line.then, line.status]), [[FAILURE, LINE_FAILURE, 'gating'], [SUCCESS, LINE_ONE, 'gating'], [SUCCESS, LINE_NONE, 'gating']]);
  assert.deepEqual(review.lines[2], {
    requirement: 'REQ-submit-success', scenario: '提交成功', package: SUCCESS, then: LINE_NONE, status: 'gating',
    checks: [{ id: 'c2', expect: LINE_NONE, role: 'gating' }], diagnostic: [],
    fixtures: { author: ['pass', 'fail', 'unknown'], review: ['review-c1', 'review-c2'], 'self-review': [] },
    counterexamples: [{ fixture: 'review-c2', origin: 'review' }],
    baseline: [{ check: 'c2', expected: null, result: null }], review: null,
  });
  assert.deepEqual(review.must_decide, []);
  assert.equal(review.questions.length, 3);
  assert.ok(review.questions.every((question) => question.package && question.then && question.ask.includes('faithful')));
  assert.equal(review.review_template.schema_version, '1.0');
  assert.equal(review.review_template.spec, review.spec);
  assert.deepEqual(review.review_template.review, { origin: null, note: null });
  assert.deepEqual(review.review_template.lines.map((line) => [line.package, line.then, line.verdict, line.note]),
    [[FAILURE, LINE_FAILURE, null, null], [SUCCESS, LINE_ONE, null, null], [SUCCESS, LINE_NONE, null, null]]);
  assert.deepEqual(review.review_template.lines.map((line) => line.task_digest), [FAILURE, SUCCESS, SUCCESS].map((id) => evalSnapshot(repo, CHANGE).task_digest[id]));
  assert.equal(review.review_template.packages, undefined);
  assert.deepEqual(review.run_plan, { live: [], undeclared: [], agent: AGENT, model: null, attempts_needed: false, proposal: { attempts: 5, tight: 3 },
    strength: [{ attempts: 1, fails_half: 0.5, fails_one_in_ten: 0.9 }, { attempts: 3, fails_half: 0.125, fails_one_in_ten: 0.729 }, { attempts: 5, fails_half: 0.03125, fails_one_in_ten: 0.5905 }],
    // Each fixture of the fake Harbor takes a second, well under a tenth of a minute.
    estimate: [1, 3, 5].map((attempts) => ({ attempts, baseline_minutes: 0, screen_minutes: 0, final_minutes: 0, cost_usd: null })),
    basis: 'eval_check', estimate_missing: [], not_counted: NOT_COUNTED,
    budget: { iterations: 5, minutes: 60 }, confirmed: null });
  // The reviewer gets the scenario, the bindings and the author's pass fixtures, not the verifier.
  const brief = review.reviewer_brief;
  assert.ok(brief.give.includes(`openspec/changes/${CHANGE}/specs`));
  assert.ok(brief.give.includes(`.genesis/edd/${CHANGE}/evals/${FAILURE}/tests/checks.json`));
  assert.ok(brief.give.includes(`.genesis/edd/${CHANGE}/evals/${FAILURE}/tests/fixtures/pass.sh`));
  assert.ok(brief.give.includes('.genesis/edd/harness/PROJECT.md'));
  assert.ok(!brief.give.some((file) => file.endsWith('test.sh') || file.includes('/shared/') || file.includes('fail.sh')), JSON.stringify(brief.give));
  assert.ok(brief.withhold.includes(`.genesis/edd/${CHANGE}/evals/${SUCCESS}/tests/test.sh`));
  assert.ok(brief.withhold.includes('.genesis/edd/harness/verifier/'));
  assert.match(brief.first, /Without reading tests\/test\.sh/);
  assert.equal(review.spec_diff, null);
  assert.match(review.next, /^Give the reviewer reviewer_brief and nothing else/);
  // The CLI only reads, and exits 0.
  const shown = cli(['eval', 'review', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.lines.length, 3);
  assert.equal(existsSync(confirmationFile(repo, CHANGE)), false);
});

test('eval confirm records the reviewer\'s verdicts and the run plan in confirmed.json, under an id that recomputes', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  writeExpectations(repo, EXPECT);
  writeReview(repo);
  const before = evalSnapshot(repo, CHANGE);
  const result = confirm(repo);
  assert.equal(result.file, confirmationFile(repo, CHANGE));
  const stored = readJSON(result.file);
  assert.deepEqual(stored, result.confirmation);
  assert.equal(stored.schema_version, '1.0');
  assert.equal(stored.change, CHANGE);
  assert.equal(stored.id, confirmationId(stored));
  assert.deepEqual(Object.keys(stored).slice(0, 3), ['schema_version', 'change', 'id']);
  assert.equal(stored.spec.id, CHANGE);
  assert.deepEqual(Object.fromEntries(Object.entries(stored.packages).map(([id, item]) => [id, item.task_digest])), before.task_digest);
  assert.deepEqual(stored.packages[FAILURE].files, before.packages[FAILURE]);
  assert.equal(stored.packages[FAILURE].ready, true);
  assert.deepEqual(stored.kit.files, before.kit);
  assert.deepEqual(stored.lines.map((line) => [line.package, line.then, line.status, line.checks, line.verdict]),
    [[FAILURE, LINE_FAILURE, 'gating', ['c1'], 'faithful'], [SUCCESS, LINE_ONE, 'gating', ['c1'], 'faithful'], [SUCCESS, LINE_NONE, 'gating', ['c2'], 'faithful']]);
  assert.deepEqual(stored.lines[0].counterexamples, [{ fixture: 'review-c1', origin: 'review' }]);
  assert.deepEqual(stored.review, { origin: 'review', note: 'A fresh reviewer read the scenario, then the verifier.' });
  assert.deepEqual(stored.baseline_expectations.map((entry) => [entry.case, entry.check, entry.expected]), [[FAILURE, 'c1', 'fail'], [SUCCESS, 'c1', 'pass'], [SUCCESS, 'c2', 'pass']]);
  assert.deepEqual(stored.run_plan, { attempts: null, pass_rule: 'all', agent: AGENT, model: null, budget: { iterations: 5, minutes: 60 } });
  assert.deepEqual(Object.keys(stored.confirmed), ['by', 'ref', 'at', 'kind']);
  assert.equal(stored.confirmed.kind, 'initial');
  assert.equal(stored.earlier, undefined);
  assert.match(result.next, /^The checks are confirmed\. Record the baseline next/);
  const read = readConfirmation(repo, CHANGE);
  assert.equal(read.gap, null);
  assert.deepEqual(read.entries.map((entry) => entry.id), [stored.id]);
  // eval review now names it as current.
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.confirmation, { id: stored.id, at: stored.confirmed.at, by: 'Dana', kind: 'initial' });
  assert.equal(review.current, true);
  assert.deepEqual(review.lines[0].baseline, [{ check: 'c1', expected: 'fail', result: null }]);
});

test('eval confirm refuses lines a reviewer did not judge faithful, disputed manual lines, stale answers and a missing --by or --ref', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  const file = confirmationFile(repo, CHANGE);
  assert.throws(() => confirmEval(repo, CHANGE, { verdicts: writeReview(repo), by: 'Dana' }), (error) => !error.code && /--by and --ref/.test(error.message));
  assert.throws(() => confirmEval(repo, CHANGE, { verdicts: writeReview(repo), ref: 'thread 1' }), /--by and --ref/);

  writeReview(repo, (answers) => { Object.assign(answers.lines[1], { verdict: 'weaker', note: 'It counts any notice.' }); });
  assert.throws(() => confirm(repo), (error) => {
    refusedWith('line_not_faithful')(error);
    assert.equal(error.gaps[0].message, `The reviewer judged these lines not faithful: ${SUCCESS} "${LINE_ONE}": weaker (It counts any notice.). Fix the check in write-eval and prove it with \`eval check\`, or list the line in scenario.manual when no program can judge it; then review again.`);
    assert.deepEqual(error.resume.command, ['workflow', 'check', 'run-eval', CHANGE, '--repo', repo]);
    return true;
  });
  assert.equal(existsSync(file), false);

  writeReview(repo, (answers) => { answers.lines[0].task_digest = 'sha256:other'; });
  assert.throws(() => confirm(repo), (error) => refusedWith('review_stale')(error) && error.gaps[0].message.includes('was answered for another version of the package'));
  writeReview(repo, (answers) => { answers.lines.pop(); });
  assert.throws(() => confirm(repo), (error) => refusedWith('review_stale')(error) && error.gaps[0].message.includes(`"${LINE_NONE}" (${SUCCESS}) has no answer`));
  writeReview(repo, (answers) => { answers.lines[0].verdict = null; });
  assert.throws(() => confirm(repo), refusedWith('review_unreadable'));
  writeFileSync(reviewFile(repo, CHANGE), '{ not json');
  assert.throws(() => confirm(repo), refusedWith('review_unreadable'));
  assert.equal(existsSync(file), false);

  // A line the user judges must be one no program can judge.
  editChecks(repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.fixtures = declared.fixtures.filter((fixture) => fixture.name !== 'review-c2');
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: judged by a person' }];
  });
  writeReview(repo);
  assert.throws(() => confirm(repo), (error) => refusedWith('manual_disputed')(error)
    && error.gaps[0].message.startsWith(`The reviewer thinks a program can judge these scenario.manual lines: ${SUCCESS} "${LINE_NONE}": faithful.`));
  writeReview(repo, (answers) => { answers.lines.find((line) => line.then === LINE_NONE).verdict = 'not_observable'; });
  const result = confirm(repo);
  assert.deepEqual(result.confirmation.lines.at(-1), { package: SUCCESS, requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_NONE, status: 'manual',
    checks: [], expect: [], counterexamples: [], verdict: 'not_observable', note: 'Says what the line says.', reason: 'synthetic: judged by a person' });
});

test('a second confirmation of the same export is a revision with a reason, and the first one is kept under earlier', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  writeReview(repo);
  const first = confirm(repo).confirmation;
  writeReview(repo);
  assert.throws(() => confirm(repo), (error) => refusedWith('reason_missing')(error)
    && error.gaps[0].message === `This Spec export was confirmed before (${first.confirmed.at}, by Dana). A new confirmation is a revision: pass --reason with why the packages or the run plan changed.`);
  const second = confirm(repo, { reason: 'Nothing changed; confirmed again for the record.', by: 'Lee' });
  assert.equal(second.confirmation.confirmed.kind, 'revision');
  assert.equal(second.confirmation.confirmed.reason, 'Nothing changed; confirmed again for the record.');
  const stored = readJSON(confirmationFile(repo, CHANGE));
  assert.deepEqual(stored.earlier, [first]);
  assert.deepEqual(readConfirmation(repo, CHANGE).entries.map((entry) => entry.id), [second.confirmation.id, first.id]);
  // A revision outside a loop asks for the baseline next.
  assert.match(second.next, /^The checks are confirmed\. Record the baseline next/);
});

test('confirmed.json edited by hand is confirmation_invalid: loop start refuses it, and eval confirm records the confirmation again', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const file = confirmationFile(repo, CHANGE);
  const stored = readJSON(file);
  writeFileSync(file, `${JSON.stringify({ ...stored, run_plan: { ...stored.run_plan, budget: { iterations: 50, minutes: 600 } } }, null, 2)}\n`);
  const read = readConfirmation(repo, CHANGE);
  assert.equal(read.gap.code, 'confirmation_invalid');
  assert.equal(read.gap.message, `.genesis/edd/${CHANGE}/confirmed.json was edited by hand: the id of the entry of ${stored.confirmed.at} no longer matches its content. Restore it from Git, or record the confirmation again with \`eval confirm\`.`);
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED');
    assert.deepEqual(codes(error.gaps), ['confirmation_invalid']);
    return true;
  });
  writeFileSync(file, '{ not json');
  assert.equal(readConfirmation(repo, CHANGE).gap.code, 'confirmation_unreadable');
  assert.throws(() => startLoop(repo, CHANGE), (error) => codes(error.gaps).includes('confirmation_unreadable'));
  writeReview(repo);
  assert.throws(() => confirm(repo), refusedWith('confirmation_unreadable'));
  // An invalid file is replaced by a new confirmation, which keeps no history.
  writeFileSync(file, `${JSON.stringify({ ...stored, run_plan: { ...stored.run_plan, budget: { iterations: 50, minutes: 600 } } }, null, 2)}\n`);
  const again = confirm(repo);
  assert.equal(again.confirmation.confirmed.kind, 'initial');
  assert.ok(again.warnings.some((warning) => warning.includes('was edited by hand, so its earlier confirmations are not kept')), JSON.stringify(again.warnings));
  assert.equal(readConfirmation(repo, CHANGE).gap, null);
  assert.equal(startLoop(repo, CHANGE).loop.checks_confirmation.id, again.confirmation.id);
});

test('the user fixes the number of attempts when a package is live, and inside a loop a confirmation of another plan ends it, while a new budget does not', (t) => {
  const project = readyProject(t, { live: [FAILURE], confirm: false });
  const { repo } = project;
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual([review.run_plan.live, review.run_plan.attempts_needed], [[FAILURE], true]);
  writeReview(repo);
  assert.throws(() => confirm(repo), (error) => refusedWith('attempts_undecided')(error) && error.gaps.find((entry) => entry.code === 'attempts_undecided').owner === 'user');
  const confirmed = confirm(repo, { attempts: 3, minutes: 90 });
  assert.deepEqual(confirmed.confirmation.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, budget: { iterations: 5, minutes: 90 } });
  // The baseline runs the confirmed plan.
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(base.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'confirmation', confirmation: confirmed.confirmation.id });
  const { loop } = startLoop(repo, CHANGE);
  writeReview(repo);
  // A new budget leaves the loop as it is, with its own budget.
  const budget = confirm(repo, { minutes: 120, reason: 'More time.' });
  assert.deepEqual(budget.confirmation.run_plan.budget, { iterations: 5, minutes: 120 });
  assert.equal(budget.next, 'The checks are confirmed. `loop status` says what comes next (now iterate).');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.ended, null);
  assert.deepEqual(status.loop.budget, loop.budget);
  // Another number of attempts ends it.
  const five = confirm(repo, { attempts: 5, reason: 'The user chose 5 attempts.' });
  assert.equal(five.confirmation.run_plan.attempts, 5);
  assert.ok(five.next.startsWith('The loop for this Spec has ended (confirmation_changed). The checks are confirmed. Record the baseline next: `run start --baseline` reads N, the agent and the model from confirmed.json.'), five.next);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason, status.ended.plan], ['loop_ended', 'confirmation_changed', ['attempts']]);
  // A new loop, once the user agrees, starts on a baseline of that plan on the start code.
  assert.throws(() => startLoop(repo, CHANGE), (error) => codes(error.gaps).includes('baseline_plan_differs'));
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.run_plan.attempts, again.run_plan.source], [5, 'confirmation']);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('eval review estimates the baseline, a screen run and the final run for 1, 3 and 5 attempts from eval check, and names what it does not count', (t) => {
  const project = readyProject(t, { live: [FAILURE], check: false });
  const { repo } = project;
  // Before eval check there is nothing to go by.
  let review = reviewEval(repo, CHANGE);
  assert.equal(review.run_plan.basis, null);
  assert.deepEqual(review.run_plan.estimate[1], { attempts: 3, baseline_minutes: null, screen_minutes: null, final_minutes: null, cost_usd: null });
  assert.deepEqual(review.run_plan.estimate_missing, [FAILURE, SUCCESS]);
  assert.ok(review.next.endsWith(' run_plan.estimate has minutes once `eval check` has run the packages\' fixtures.'), review.next);
  // A fixture of the live package takes 30 seconds, one of the other 6.
  for (const [id, seconds] of [[FAILURE, 30], [SUCCESS, 6]]) {
    editChecks(repo, id, (declared) => { for (const fixture of declared.fixtures) fixture.$seconds = seconds; });
  }
  assert.equal(checkEval(repo, CHANGE).passed, true);
  review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.run_plan.estimate, [
    { attempts: 1, baseline_minutes: 0.6, screen_minutes: 0.6, final_minutes: 0.6, cost_usd: null },
    { attempts: 3, baseline_minutes: 1.6, screen_minutes: 0.6, final_minutes: 1.6, cost_usd: null },
    { attempts: 5, baseline_minutes: 2.6, screen_minutes: 0.6, final_minutes: 2.6, cost_usd: null },
  ]);
  assert.equal(review.run_plan.basis, 'eval_check');
  assert.deepEqual(review.run_plan.estimate_missing, []);
  assert.deepEqual(review.run_plan.not_counted, NOT_COUNTED);
  assert.ok(review.next.endsWith('and the plan they agreed. The estimate counts Docker time from eval check; add the reviewer\'s passes and the model calls, which the CLI cannot see.'), review.next);

  // A package changed since its eval check is left out of every row, and
  // the next step says to prove it before the user hears the cost.
  const verifier = path.join(project.root, 'evals', FAILURE, 'tests/test.sh');
  writeFileSync(verifier, `${readFileSync(verifier, 'utf8')}# Reworded.\n`);
  review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.run_plan.live, [FAILURE]);
  assert.deepEqual(review.run_plan.estimate.map((row) => [row.attempts, row.baseline_minutes, row.screen_minutes, row.final_minutes]), [[1, 0.1, 0.1, 0.1], [3, 0.1, 0.1, 0.1], [5, 0.1, 0.1, 0.1]]);
  assert.deepEqual([review.run_plan.basis, review.run_plan.estimate_missing], ['eval_check', [FAILURE]]);
  assert.ok(review.next.endsWith(`and the plan they agreed. run_plan.estimate leaves out ${FAILURE}, which is not ready (run_plan.estimate_missing): finish it, prove it with \`eval check\`, and run \`eval review\` again before you show the user the cost. The estimate counts Docker time from eval check; add the reviewer's passes and the model calls, which the CLI cannot see.`), review.next);

  // In a new project no package runs before the loop connects it, so the CLI has no estimate.
  const fresh = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], live: [FAILURE], confirm: false, results: {} });
  review = reviewEval(fresh.repo, CHANGE);
  assert.deepEqual([review.run_plan.basis, review.run_plan.estimate_missing], [null, [FAILURE, SUCCESS]]);
  assert.ok(review.next.endsWith(' The CLI has no estimate yet: in a new project the packages are connected inside the loop, and `loop status` gives loop.estimate once their `eval check` has run. Give the user your own estimate of a run, and say that the CLI has none yet.'), review.next);
});

test('must_decide ranks what the user decides: a reworded expect, a manual line, a self-review, a changed package, a changed Spec and a failure with an old package', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const first = readJSON(confirmationFile(repo, CHANGE));
  // A changed package: the verdicts of the others carry over.
  changePackage(project, FAILURE);
  let review = reviewEval(repo, CHANGE);
  assert.equal(review.current, false);
  assert.deepEqual(review.must_decide.map((entry) => [entry.code, entry.package, entry.files]), [['changed_since_confirmation', FAILURE, [`${FAILURE}/environment/Dockerfile`]]]);
  assert.deepEqual(review.review_template.lines.map((line) => [line.package, line.verdict]), [[FAILURE, null], [SUCCESS, 'faithful'], [SUCCESS, 'faithful']]);
  assert.deepEqual(review.review_template.packages.map((item) => [item.package, item.loosens]), [[FAILURE, null]]);
  // review.json still answers the unchanged lines; without it they carry the confirmed verdicts.
  assert.deepEqual(review.lines.map((line) => line.review?.carried ?? null), [null, false, false]);
  rmSync(reviewFile(repo, CHANGE));
  assert.deepEqual(reviewEval(repo, CHANGE).lines.map((line) => line.review), [null, { verdict: 'faithful', note: 'Synthetic verdict.', carried: true },
    { verdict: 'faithful', note: 'Synthetic verdict.', carried: true }]);
  assert.deepEqual(review.questions.map((question) => [question.package, question.then ?? null]), [[FAILURE, LINE_FAILURE], [FAILURE, null]]);
  // A revision needs the answer about the diff.
  writeReview(repo, (answers) => { delete answers.packages; });
  assert.throws(() => confirm(repo, { reason: 'The Dockerfile gained a build step.' }), (error) => refusedWith('review_stale')(error)
    && error.gaps[0].message.includes(`${FAILURE} changed since the checks were confirmed, and no answer says whether its diff loosens a THEN line`));
  writeReview(repo, (answers) => { Object.assign(answers.packages[0], { loosens: true, note: 'It drops a stand-in.' }); });
  assert.throws(() => confirm(repo, { reason: 'The Dockerfile gained a build step.' }), refusedWith('package_loosens'));
  confirmChecks(project, { reason: 'The Dockerfile gained a build step.' });

  // A reworded expect, a manual line and a self-review counterexample.
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks[0].expect = '本次提交只发出一条成功通知';
    dropCheck(declared, 'c2');
    declared.fixtures = declared.fixtures.filter((fixture) => fixture.name !== 'review-c2');
    declared.fixtures.find((fixture) => fixture.name === 'review-c1').origin = 'self-review';
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: judged by a person' }];
  });
  review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.must_decide.map((entry) => [entry.code, entry.package]), [['manual_line', SUCCESS], ['expect_differs', SUCCESS], ['self_review_only', SUCCESS],
    ['changed_since_confirmation', SUCCESS]]);
  assert.equal(review.must_decide[1].message, `${SUCCESS}/c1 expects "本次提交只发出一条成功通知" for the line "${LINE_ONE}". The user reads whether it says the same, no less and no more.`);
  assert.deepEqual(review.lines.find((line) => line.then === LINE_ONE).counterexamples, [{ fixture: 'review-c1', origin: 'self-review' }]);

  // A new export: the lines added and removed since the last confirmation.
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace(`- **AND** ${LINE_NONE}`, '- **AND** 本次提交没有发出失败通知'));
  const exported = exportSpec(repo, CHANGE);
  for (const id of [FAILURE, SUCCESS]) {
    editChecks(repo, id, (declared) => {
      declared.spec_ref.sha256 = exported.id;
      if (id === SUCCESS) declared.scenario.manual = [{ then: '本次提交没有发出失败通知', reason: 'synthetic: judged by a person' }];
    });
  }
  review = reviewEval(repo, CHANGE);
  assert.equal(review.confirmation, null);
  assert.deepEqual(review.spec_diff, { from: first.spec.sha256, added: [{ requirement: 'REQ-submit-success', scenario: '提交成功', then: '本次提交没有发出失败通知' }],
    removed: [{ requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_NONE }] });
  assert.ok(review.must_decide.some((entry) => entry.code === 'spec_changed_since_confirmation'), JSON.stringify(review.must_decide));
  assert.equal(review.must_decide.at(-1).code, 'spec_changed_since_confirmation');
  // No verdict carries over to another export.
  assert.ok(review.review_template.lines.every((line) => line.verdict === null));
});

test('must_decide names a check that failed with an earlier version of its package and passed with this one on the same code', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo, runs } = project;
  // The code before the change fails submit-failure-s1 c1 with the package as it was.
  const old = startRun(repo, CHANGE, { baseline: true });
  changePackage(project, FAILURE);
  const again = startRun(repo, CHANGE, { baseline: true });
  // On the same code, the changed package passes: what a loosened check would show.
  const file = path.join(runs, again.run_id, FAILURE, 'attempts.json');
  const attempts = readJSON(file);
  attempts.attempts[0].results.c1 = 'pass';
  writeFileSync(file, `${JSON.stringify(attempts, null, 2)}\n`);
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.must_decide.map((entry) => [entry.code, entry.package, entry.check]), [['failed_with_old_package', FAILURE, 'c1']]);
  assert.equal(review.must_decide[0].message, `${FAILURE}/c1 failed with an earlier version of its package (${old.run_id}) and passed with the package as it is now on the same code (${again.run_id}). A changed package starts a new count, so the user decides whether the change fixed the check or hid a failure.`);
  assert.deepEqual(readJSON(path.join(runs, again.run_id, 'run.json')).checks_confirmation, null);
});

test('eval confirm on the command line exits 1 with its gaps, and a .gitignore rule that keeps confirmed.json out of Git is named', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  writeReview(repo, (answers) => { answers.lines[0].verdict = 'vacuous'; });
  const refused = cli(['eval', 'confirm', CHANGE, '--repo', repo, '--verdicts', reviewFile(repo, CHANGE), '--by', 'Dana', '--ref', 'thread 1']);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.code, 'CONFIRM_INPUT_BLOCKED');
  assert.deepEqual(codes(refused.json.gaps), ['line_not_faithful']);
  writeReview(repo);
  const done = cli(['eval', 'confirm', CHANGE, '--repo', repo, '--verdicts', reviewFile(repo, CHANGE), '--by', 'Dana', '--ref', 'thread 1', '--max-iterations', '3', '--max-minutes', '20']);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.json.confirmation.run_plan.budget, { iterations: 3, minutes: 20 });
  writeFileSync(path.join(repo, '.gitignore'), 'confirmed.json\nreview.json\n');
  const { paths, warning } = ignoredArtifacts(repo, CHANGE);
  assert.deepEqual(paths, [`.genesis/edd/${CHANGE}/review.json`, `.genesis/edd/${CHANGE}/confirmed.json`]);
  assert.ok(warning.includes('Without them a clone has no reviewer verdicts or checks confirmation.'), warning);
});

test('a revision takes the model of a harness.json changed since the confirmation, eval review says so, and the model needs the user\'s number', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  assert.equal(project.confirmation.confirmation.run_plan.model, null);
  setKit(repo, { model: 'synthetic/model-m' });
  commit(repo, 'The kit names a model');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual([review.run_plan.model, review.run_plan.attempts_needed, review.run_plan.undeclared], ['synthetic/model-m', true, [FAILURE, SUCCESS]]);
  const item = review.must_decide.find((entry) => entry.code === 'plan_changed_since_confirmation');
  assert.deepEqual(item.changed, [{ key: 'model', confirmed: null, kit: 'synthetic/model-m' }]);
  assert.equal(item.message, 'harness.json changed since the user confirmed the checks: it names model synthetic/model-m where they confirmed model none. run_plan shows what `eval confirm` records unless --model says otherwise, and the baseline runs it. The user decides which one runs.');
  // With a model, the packages that declare no live dependency need the user's number.
  assert.throws(() => confirmChecks(project, { reason: 'The kit names a model.' }), refusedWith('attempts_undecided'));
  const revision = confirmChecks(project, { reason: 'The kit names a model.', attempts: 1 });
  assert.equal(revision.confirmation.run_plan.model, 'synthetic/model-m');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([base.run_plan.model, base.run_plan.source, base.run_plan.confirmation], ['synthetic/model-m', 'confirmation', revision.confirmation.id]);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, base.run_id);
});

test('a revision keeps a confirmed model while harness.json is as it was, and takes the one a changed harness.json names', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  // The user confirmed a model harness.json does not name.
  confirmChecks(project, { model: 'synthetic/model-a', attempts: 1 });
  changePackage(project, SUCCESS);
  assert.deepEqual(reviewEval(repo, CHANGE).must_decide.filter((entry) => entry.code === 'plan_changed_since_confirmation'), []);
  assert.equal(reviewEval(repo, CHANGE).run_plan.model, 'synthetic/model-a');
  assert.equal(confirmChecks(project, { reason: 'A build step.' }).confirmation.run_plan.model, 'synthetic/model-a');
  setKit(repo, { model: 'synthetic/model-b' });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const review = reviewEval(repo, CHANGE);
  assert.equal(review.run_plan.model, 'synthetic/model-b');
  assert.deepEqual(review.must_decide.find((entry) => entry.code === 'plan_changed_since_confirmation').changed, [{ key: 'model', confirmed: 'synthetic/model-a', kit: 'synthetic/model-b' }]);
  const changed = confirmChecks(project, { reason: 'The kit names model b.' });
  assert.equal(changed.confirmation.run_plan.model, 'synthetic/model-b');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.run_plan.model, 'synthetic/model-b');
  startLoop(repo, CHANGE);
  // Every run of the loop runs the model harness.json names, so none is refused.
  const head = startRun(repo, CHANGE);
  assert.equal(readRecord(head).run.environment_ref.model, 'synthetic/model-b');
});

test('a model written into harness.json ends a running loop, and the revision and the baseline after it take that model', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  setKit(repo, { model: 'synthetic/model-m' });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason], ['loop_ended', 'packages_changed']);
  assert.ok(status.ended.files.includes('kit/harness.json'), JSON.stringify(status.ended));
  const review = reviewEval(repo, CHANGE);
  assert.equal(review.run_plan.model, 'synthetic/model-m');
  assert.ok(review.must_decide.some((entry) => entry.code === 'plan_changed_since_confirmation'), JSON.stringify(review.must_decide));
  const revision = confirmChecks(project, { reason: 'The kit names a model.', attempts: 1 });
  assert.equal(revision.confirmation.run_plan.model, 'synthetic/model-m');
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.run_plan.model, again.run_plan.source], ['synthetic/model-m', 'confirmation']);
  assert.equal(readRecord(again).run.environment_ref.model, 'synthetic/model-m');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('inside a loop, a package that declares a live dependency ends the loop, and its confirmation needs the user\'s number', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  editChecks(repo, FAILURE, (declared) => { declared.dependencies = [LIVE_DEPENDENCY]; });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason, status.ended.packages], ['loop_ended', 'packages_changed', [FAILURE]]);
  const reason = `${FAILURE} calls the model.`;
  // Without the number, the confirmation is refused.
  assert.throws(() => confirmChecks(project, { reason }), (error) => {
    refusedWith('attempts_undecided')(error);
    const entry = error.gaps.find((gap) => gap.code === 'attempts_undecided');
    assert.deepEqual([entry.owner, entry.kind], ['user', 'business']);
    assert.doesNotMatch(entry.message, /--restart|in this loop/);
    return true;
  });
  const confirmed = confirmChecks(project, { reason, attempts: 3 });
  assert.equal(confirmed.confirmation.run_plan.attempts, 3);
  // Its confirmation covers other packages than the loop's, which ends it too.
  assert.ok(confirmed.next.startsWith('The loop for this Spec has ended (confirmation_changed). The checks are confirmed. Record the baseline next'), confirmed.next);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.run_plan.attempts, 3);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('the documented review order: counterexamples proved with eval check, then answers into the template of a second eval review', (t) => {
  const project = readyProject(t, { confirm: false, check: false });
  const { repo } = project;
  for (const id of Object.keys(project.packages)) editChecks(repo, id, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.origin !== 'review'); });
  // Packages missing only their counterexamples are not checked yet.
  const waiting = checkEval(repo, CHANGE);
  assert.equal(waiting.passed, false);
  assert.equal(waiting.next, `No package is finished enough to check. \`eval validate\` lists what each one still needs. ${FAILURE}, ${SUCCESS} wait only for the reviewer's counterexamples: run \`eval review\` and give its reviewer_brief to a reviewer.`);
  const first = reviewEval(repo, CHANGE);
  assert.ok(first.next.startsWith('Give the reviewer reviewer_brief and nothing else. First they write the counterexamples, without tests/test.sh, and prove them with `eval check`. Then run `eval review` again, since the counterexamples change each package\'s task_digest, and they answer its questions, with the verifier, into review.json from the review_template of that new review.'), first.next);
  assert.ok(first.reviewer_brief.then.startsWith('Then run `eval review` again: the counterexamples change each package\'s task_digest'), first.reviewer_brief.then);
  for (const id of Object.keys(project.packages)) {
    const written = editChecks(repo, id, (declared) => { declared.fixtures.push(...reviewFixtures(declared)); });
    writeFixtureScripts(repo, id, written.fixtures.map((fixture) => fixture.name));
  }
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true);
  assert.equal(checked.next, 'Every checked verifier told its fixtures apart, so those packages are ready. `workflow check run-eval` says what comes next: the user confirms the checks before the baseline (`eval review`, `eval confirm`).');
  // Answers written into the first template are for the packages before the counterexamples.
  const stale = structuredClone(first.review_template);
  stale.review = { origin: 'review', note: 'A fresh reviewer.' };
  for (const line of stale.lines) Object.assign(line, { verdict: 'faithful', note: 'Says what the line says.' });
  writeFileSync(reviewFile(repo, CHANGE), `${JSON.stringify(stale, null, 2)}\n`);
  assert.throws(() => confirm(repo), (error) => {
    refusedWith('review_stale')(error);
    assert.ok(error.gaps.find((gap) => gap.code === 'review_stale').message.endsWith('Any edit to a package, a new counterexample included, changes its task_digest. Run `eval review` again and write review.json from its review_template, with the reviewer\'s answers for the packages as they are now.'));
    return true;
  });
  const second = reviewEval(repo, CHANGE);
  assert.ok(second.next.startsWith('Give the reviewer reviewer_brief and nothing else, and have them answer its questions, with the verifier, into review.json from review_template. Show the user'), second.next);
  assert.ok(second.reviewer_brief.then.startsWith('Then read the verifier'), second.reviewer_brief.then);
  writeReview(repo);
  assert.equal(confirm(repo).confirmation.confirmed.kind, 'initial');
});

test('eval confirm names a package changed since its last eval check, and eval review refuses a package in checks.json 1.0', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  changePackage(project, FAILURE, { check: false });
  const revision = confirmChecks(project, { reason: 'A build step.' });
  assert.ok(revision.warnings.includes(`${FAILURE} changed since its last \`eval check\`. Run it before the next run: a run skips a package whose verifier is not proved for it as it is.`), JSON.stringify(revision.warnings));
  assert.ok(!revision.warnings.some((warning) => warning.includes('once it is connected')), JSON.stringify(revision.warnings));
  editChecks(repo, SUCCESS, toLegacy);
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.gaps.filter((gap) => gap.code === 'then_unbound').map((gap) => gap.cases), [[SUCCESS]]);
});

test('in a new project with no package to run yet, eval review has the reviewer judge the checks now and write the counterexamples once the loop connects the packages', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const review = reviewEval(project.repo, CHANGE);
  assert.ok(review.next.startsWith('Give the reviewer reviewer_brief and nothing else. No package can run yet in this new project, so they judge each check against its line now, from checks.json'), review.next);
  assert.ok(review.reviewer_brief.first.startsWith('No package can run yet: in a new project the packages are connected inside the loop.'), review.reviewer_brief.first);
  assert.ok(!review.reviewer_brief.then.includes('the verifier'), review.reviewer_brief.then);
});

test('in a new project, once the loop connects a package that still has no counterexample, eval review gives the brief of an existing project', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo, root } = project;
  for (const id of [FAILURE, SUCCESS]) {
    editChecks(repo, id, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.origin !== 'review'); });
  }
  confirmChecks(project);
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  // Connecting the packages ends the loop, as the expected step.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason], ['loop_ended', 'packages_changed']);
  const review = reviewEval(repo, CHANGE);
  assert.ok(!review.next.includes('No package can run yet'), review.next);
  assert.ok(review.next.startsWith('Give the reviewer reviewer_brief and nothing else. First they write the counterexamples, without tests/test.sh, and prove them with `eval check`. Then run `eval review` again'), review.next);
  assert.ok(review.reviewer_brief.first.startsWith('Without reading tests/test.sh, tests/shared/ or the kit\'s verifier/, write for every line a program checks a counterexample'), review.reviewer_brief.first);
  assert.ok(review.reviewer_brief.then.startsWith('Then run `eval review` again'), review.reviewer_brief.then);
  // Following that brief, the second review's answers confirm the revision.
  for (const id of [FAILURE, SUCCESS]) {
    const extra = reviewFixtures(readJSON(path.join(root, 'evals', id, 'tests/checks.json')));
    editChecks(repo, id, (declared) => { declared.fixtures.push(...extra); });
    writeFixtureScripts(repo, id, extra.map((fixture) => fixture.name));
  }
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.equal(confirmChecks(project, { reason: 'The reviewer wrote the counterexamples once the packages were connected.' }).confirmation.confirmed.kind, 'revision');
});
