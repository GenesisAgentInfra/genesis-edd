// Loop tests: the run plan and the strength of a pass, THEN lines, the user's
// checks confirmation, and the estimates of a screen run and the final run.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, endLoop, loopStatus, writeReport } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, commit, confirmChecks, dropCheck, editChecks, legacyWarning, readRecord,
  readyProject, toLegacy, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, USER, REF, actionOf, assertGapShape, assertSuggestion, codes, blockedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, loopPath, loopRecord,
  changePackage, exportRevision, runsOf, liveLoop, gapOf, STRENGTH_3, passingScreen, resultsOutsideCode, reviewRun, startLoop,
  refusedBeforeRun, assertEnded, assertFinalDue, refusedWith,
} from './helpers/loop.js';

// Rewrites an attempts.json so that every attempt took this many seconds.
function timeAttempts(file, seconds) {
  const recorded = readJSON(file);
  for (const attempt of recorded.attempts) attempt.finished_at = new Date(Date.parse(attempt.started_at) + seconds * 1000).toISOString();
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
}

// The action of a workflow status whose command is exactly these words after
// the change and --repo, such as ['run', 'start'] for a plain head run.
const exactAction = (status, repo, ...words) => status.actions.find((entry) => entry.command.join('\n') === [...words.slice(0, 2), CHANGE, '--repo', repo, ...words.slice(2)].join('\n'));

// --- The run plan: attempts, counts and the strength of a pass ---

// The status of a loop with live FAILURE at N attempts once a passing run of
// it can be accepted: with more than one attempt, the final run after a
// screen run, whose review covers the final run of its code.
function strengthAt(t, attempts) {
  const project = liveLoop(t, attempts);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  let run = fullRun(repo);
  completeReport(repo, run.run_id);
  if (attempts > 1) {
    assert.equal(run.role, 'screen');
    reviewRun(project, run.run_id);
    run = fullRun(repo);
    assert.equal(run.role, 'final');
    completeReport(repo, run.run_id);
  } else {
    reviewRun(project, run.run_id);
  }
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
  assert.equal(status.situation.run_id, run.run_id);
  return status;
}

test('a check that passed in some attempts and failed in others of a final run counts as both on that code', (t) => {
  const project = liveLoop(t, 3);
  const { repo } = project;
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  // The screen run makes one attempt, which passes; the final run makes three.
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass']);
  completeReport(repo, screen.run_id);
  const run = fullRun(repo);
  assert.deepEqual([run.role, run.verdict], ['final', 'fail']);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  // One failed final run: that code can never be accepted, and the loop goes on.
  assert.deepEqual([status.phase, status.situation.code, status.situation.run_id], ['live', 'final_failed', run.run_id], JSON.stringify(status.situation));
  assert.deepEqual(status.situation.failed, [{ case: FAILURE, check: 'c1', passed: 2, attempts: 3 }]);
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [screen.run_id, run.run_id], fail: [run.run_id] }]);
  assert.ok(status.gates.accept.some((entry) => entry.code === 'nothing_to_accept'), JSON.stringify(status.gates.accept));
});

test('the report shows each result with its passes out of its attempts, and acceptance records the counts, the plan and the strength', (t) => {
  const project = liveLoop(t, 3);
  const { repo, root, base } = project;
  const { id } = project.confirmation.confirmation;
  const plan = loopStatus(repo, CHANGE).loop.run_plan;
  assert.deepEqual([plan.attempts, plan.pass_rule, plan.agent, plan.model, plan.source, plan.confirmation], [3, 'all', AGENT, null, 'confirmation', id], JSON.stringify(plan));
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // The screen run makes one attempt of each package.
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass']);
  const screenText = readFileSync(writeReport(repo, CHANGE, { run: screen.run_id }).file, 'utf8');
  assert.match(screenText, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/3\) → pass \(1\/1\) \| holds \(fixed\) \|$/m);
  completeReport(repo, screen.run_id);
  reviewRun(project, screen.run_id);
  // The final run runs the plan.
  const run = fullRun(repo);
  assert.deepEqual([run.role, run.verdict], ['final', 'pass']);
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.match(text, /^\| Case \| Check \| Requirement \| THEN \| Role \| Before → After \| Verdict \|$/m);
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/3\) → pass \(3\/3\) \| holds \(fixed\) \|$/m);
  assert.match(text, /^\| submit-success-s1 \| c1 \| REQ-submit-success \| 本次提交发送的成功通知数量为一 \| gating \| pass \(1\/1\) → pass \(1\/1\) \| holds \(kept\) \|$/m);
  assert.doesNotMatch(text, /\(varied\)/);
  completeReport(repo, run.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
  const sentence = 'The gating checks of packages with a live dependency each had 3 attempts with evidence, and none failed. A check that fails half the time passes all 3 with a 13% chance; one that fails one time in ten, with a 73% chance. That does not show the checks always hold.';
  assert.deepEqual([status.strength.attempts, status.strength.pass_all_chance, status.strength.single_sample], [3, { fails_half: 0.125, fails_one_in_ten: 0.729 }, false]);
  assert.ok(status.strength.sentence.startsWith(sentence), status.strength.sentence);
  // What the user is shown before deciding: the per-check comparison of the
  // final run with its counts, and the strength sentence as it is.
  assert.equal(status.must_show.strength[0].sentence, status.strength.sentence);
  assert.deepEqual(status.must_show.checks.map((entry) => [entry.case, entry.check, entry.after_counts, entry.label]), [
    [FAILURE, 'c1', { pass: 3, fail: 0, unknown: 0 }, 'holds (fixed)'],
    [SUCCESS, 'c1', { pass: 1, fail: 0, unknown: 0 }, 'holds (kept)'],
    [SUCCESS, 'c2', { pass: 1, fail: 0, unknown: 0 }, 'holds (kept)'],
  ]);
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'acceptance' && entry.run_id === run.run_id), JSON.stringify(status.obligations));

  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const accepted = readJSON(path.join(root, 'accepted.json'));
  assert.equal(accepted.schema_version, '1.3');
  assert.equal(accepted.baseline, base.run_id);
  assert.deepEqual(accepted.checks.map(({ case: caseId, check, before_counts: before, after_counts: after }) => [caseId, check, before, after]), [
    [FAILURE, 'c1', { pass: 0, fail: 3, unknown: 0 }, { pass: 3, fail: 0, unknown: 0 }],
    [SUCCESS, 'c1', { pass: 1, fail: 0, unknown: 0 }, { pass: 1, fail: 0, unknown: 0 }],
    [SUCCESS, 'c2', { pass: 1, fail: 0, unknown: 0 }, { pass: 1, fail: 0, unknown: 0 }],
  ]);
  assert.deepEqual([accepted.run_plan.attempts, accepted.run_plan.agent, accepted.run_plan.model, accepted.run_plan.attempts_by_case],
    [3, AGENT, null, { [FAILURE]: 3, [SUCCESS]: 1 }]);
  assert.equal(accepted.checks_confirmation.id, id);
  assert.deepEqual([accepted.final_run, accepted.screen_run, accepted.tier], [run.run_id, screen.run_id, 'full']);
  assert.deepEqual(accepted.strength, status.strength);
});

test('the strength of a pass comes from a fixed formula: one attempt is a single sample, five rule out more', (t) => {
  const one = strengthAt(t, 1).strength;
  assert.deepEqual([one.attempts, one.single_sample, one.pass_all_chance], [1, true, { fails_half: 0.5, fails_one_in_ten: 0.9 }]);
  assert.ok(one.sentence.startsWith('The gating checks of packages with a live dependency each had 1 attempt with evidence: a single sample. A check that fails half the time passes it with a 50% chance; one that fails one time in ten, with a 90% chance. That does not show the checks always hold.'), one.sentence);
  const status = strengthAt(t, 5);
  const five = status.strength;
  assert.deepEqual([five.attempts, five.single_sample, five.pass_all_chance], [5, false, { fails_half: 0.03125, fails_one_in_ten: 0.5905 }]);
  assert.match(five.sentence, /passes all 5 with a 3% chance; one that fails one time in ten, with a 59% chance\./);
  assert.equal(status.must_show.strength[0].sentence, five.sentence);
});

test('a baseline from before run plans reads as uniform, and loop start says every package runs its number of times', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, runs } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // The baseline as written before run plans.
  const file = path.join(runs, base.run_id, 'run.json');
  const record = readJSON(file);
  delete record.environment_ref.run_plan;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const legacy = startLoop(repo, CHANGE);
  assert.ok(legacy.warnings.includes(`The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs 3 times, as it did there.`), JSON.stringify(legacy.warnings));
  assert.deepEqual(legacy.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'legacy', uniform: true });
  assert.deepEqual(loopStatus(repo, CHANGE).loop.run_plan, legacy.run_plan);
});

test('the number of attempts of a live package is the user\'s: before a confirmation workflow status refuses the baseline, and after one it lists the baseline without --attempts', (t) => {
  const unconfirmed = readyProject(t, { live: [SUCCESS], confirm: false });
  let status = workflowStatus(unconfirmed.repo, CHANGE);
  let baseline = actionOf(status, 'run', 'start', '--baseline');
  assert.ok(baseline.blocked_by.includes('attempts_undecided'), JSON.stringify(baseline));
  const confirm = actionOf(status, 'eval', 'confirm');
  assert.deepEqual([confirm.by, confirm.needed, confirm.allowed], ['user', true, true], JSON.stringify(confirm));
  assertSuggestion(status, ['eval', 'review']);
  // The agent's own --attempts does not settle it.
  assert.throws(() => startRun(unconfirmed.repo, CHANGE, { baseline: true, attempts: 3 }), (error) => {
    assert.ok(codes(error.gaps).includes('attempts_undecided'), JSON.stringify(error.gaps));
    return true;
  });

  const live = readyProject(t, { live: [SUCCESS] });
  status = workflowStatus(live.repo, CHANGE);
  baseline = actionOf(status, 'run', 'start', '--baseline');
  assert.deepEqual([baseline.allowed, baseline.needed], [true, true], JSON.stringify(baseline));
  assert.ok(!baseline.command.some((word) => ['--attempts', '--agent', '--model'].includes(word)), JSON.stringify(baseline.command));
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', live.repo, '--baseline']);

  const model = readyProject(t, { model: 'synthetic/model-1' });
  status = workflowStatus(model.repo, CHANGE);
  baseline = actionOf(status, 'run', 'start', '--baseline');
  assert.deepEqual([baseline.allowed, baseline.needed], [true, true], JSON.stringify(baseline));
  assert.ok(!baseline.command.some((word) => ['--attempts', '--agent', '--model'].includes(word)), JSON.stringify(baseline.command));
  const base = startRun(model.repo, CHANGE, { baseline: true });
  assert.deepEqual([base.run_plan.attempts, base.run_plan.model], [3, 'synthetic/model-1']);
});

test('under a baseline from before run plans every package ran its attempts, and the strength counts every gating check', (t) => {
  const project = readyProject(t, { tier: 'full' });
  const { repo, root, runs } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // The baseline as an earlier release wrote it, with --attempts 2.
  const file = path.join(runs, base.run_id, 'run.json');
  const record = readJSON(file);
  delete record.environment_ref.run_plan;
  delete record.environment_ref.attempts_by_case;
  delete record.baseline_unstable;
  record.environment_ref.attempts = 2;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  for (const id of [FAILURE, SUCCESS]) rmSync(path.join(runs, base.run_id, id, 'attempts.json'));
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // Every package ran more than once, so a full run of the loop is a screen
  // run, and the final run runs every package that number of times.
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.attempts], ['screen', { [FAILURE]: 1, [SUCCESS]: 1 }]);
  completeReport(repo, screen.run_id);
  reviewRun(project, screen.run_id);
  const run = fullRun(repo);
  assert.deepEqual([run.role, run.verdict], ['final', 'pass']);
  assert.deepEqual(run.attempts, { [FAILURE]: 2, [SUCCESS]: 2 });
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
  assert.deepEqual(status.final.live, [FAILURE, SUCCESS]);
  const sentence = 'The gating checks each had 2 attempts with evidence, and none failed. A check that fails half the time passes all 2 with a 25% chance; one that fails one time in ten, with an 81% chance. That does not show the checks always hold.';
  assert.deepEqual([status.strength.attempts, status.strength.pass_all_chance, status.strength.single_sample], [2, { fails_half: 0.25, fails_one_in_ten: 0.81 }, false]);
  assert.ok(status.strength.sentence.startsWith(sentence), status.strength.sentence);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual(readJSON(path.join(root, 'accepted.json')).strength, status.strength);
});

test('a baseline recorded again keeps the number of attempts the user chose: the confirmation of a changed package keeps it, and the baseline reads it from there', (t) => {
  const project = readyProject(t, { live: [FAILURE] });
  const { repo } = project;
  const expect = writeExpectations(repo, EXPECT);
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3, expect });
  assert.equal(base.run_plan.attempts, 3);
  changePackage(project, SUCCESS);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_packages_differ')(error);
    blockedWith('checks_unconfirmed')(error);
    const entry = assertGapShape(gapOf(error, 'baseline_packages_differ'), { owner: 'agent', layer: 'baseline', run: base.run_id });
    assert.ok(entry.message.includes(`${SUCCESS} changed since`), entry.message);
    return true;
  });
  // The user confirms the changed package; the confirmation keeps their number.
  let status = workflowStatus(repo, CHANGE);
  assert.equal(actionOf(status, 'eval', 'confirm').needed, true);
  assert.equal(confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' }).confirmation.run_plan.attempts, 3);
  status = workflowStatus(repo, CHANGE);
  assert.ok(codes(status.layers.baseline.gaps).includes('baseline_packages_differ'), JSON.stringify(status.layers.baseline.gaps));
  const baseline = actionOf(status, 'run', 'start', '--baseline');
  assert.deepEqual([baseline.allowed, baseline.needed], [true, true], JSON.stringify(baseline));
  assert.deepEqual(baseline.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', `.genesis/edd/${CHANGE}/baseline-expectations.json`]);
  assertSuggestion(status, baseline.command);
  const again = startRun(repo, CHANGE, { baseline: true, expect });
  assert.equal(again.run_plan.attempts, 3);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

// checks.json 1.1: the THEN lines through the loop.

const LINE_NONE = '本次提交发送的失败通知数量为零';

// A ready project whose SUCCESS package leaves its AND line to the user, with a
// baseline recorded on it.
function withManualLine(t) {
  const project = readyProject(t, { check: false });
  editChecks(project.repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: a person reads it' }];
  });
  assert.equal(checkEval(project.repo, CHANGE).passed, true);
  confirmChecks(project);
  commit(project.repo, 'Leave a line to the user');
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'pass' }) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  return { ...project, base };
}

test('loop start refuses packages in checks.json 1.0 with then_unbound, and workflow status names them', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, toLegacy);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  commit(repo, 'Keep a package in checks.json 1.0');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true);
  // A 1.0 package cannot be confirmed either, so the checks stay unconfirmed.
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    assert.ok(codes(error.gaps).includes('checks_unconfirmed'), JSON.stringify(error.gaps));
    const unbound = assertGapShape(gapOf(error, 'then_unbound'), { kind: 'artifact', owner: 'agent', layer: 'package', cases: [SUCCESS] });
    assert.ok(unbound.message.startsWith(`${SUCCESS} uses checks.json 1.0, whose checks do not name the THEN lines they verify, so a loop does not start on it.`), unbound.message);
    return true;
  });
  let status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.packages.legacy, [SUCCESS]);
  assert.ok(status.layers.packages.warnings.includes(legacyWarning([SUCCESS])), JSON.stringify(status.layers.packages.warnings));
  const start = actionOf(status, 'loop', 'start');
  assert.ok(start.blocked_by.includes('then_unbound') && start.blocked_by.includes('checks_unconfirmed'), JSON.stringify(start));
  // Both packages are named once both are in 1.0.
  editChecks(repo, FAILURE, toLegacy);
  status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.packages.legacy, [FAILURE, SUCCESS]);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.deepEqual(gapOf(error, 'then_unbound').cases, [FAILURE, SUCCESS]);
    return true;
  });
});

const NO_GATING = 'No package of this change has a gating check: every THEN line is in scenario.manual, for the user to judge. A run passes only on gating checks, so no run of this change can pass and no loop on it can be accepted.';

// Leaves every THEN line of every package to the user: no check, no fixture,
// and a verifier that checks nothing.
function leaveEveryLineToTheUser(repo, root) {
  for (const id of [FAILURE, SUCCESS]) {
    editChecks(repo, id, (declared) => ({ ...declared, checks: [], fixtures: [],
      scenario: { ...declared.scenario, manual: declared.checks.map((check) => ({ then: check.then, reason: 'synthetic: a person reads it' })) } }));
    writeFileSync(path.join(root, 'evals', id, 'tests/test.sh'), '#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\nfinish\n', { mode: 0o755 });
  }
}

test('loop start refuses a change whose every THEN line the user judges, since no run of it can pass, and workflow status says so', (t) => {
  const project = readyProject(t, { check: false });
  const { repo, root } = project;
  leaveEveryLineToTheUser(repo, root);
  assert.equal(validateEval(repo, CHANGE).valid, true);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  // The user confirms that they judge every line.
  assert.deepEqual(confirmChecks(project).confirmation.lines.map((line) => line.verdict), ['not_observable', 'not_observable', 'not_observable']);
  commit(repo, 'Leave every line to the user');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, []) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    assert.deepEqual(codes(error.gaps), ['gating_missing']);
    assertGapShape(error.gaps[0], { code: 'gating_missing', kind: 'business', owner: 'user', layer: 'package', message: `${NO_GATING} A loop does not start on it.` });
    return true;
  });
  const start = actionOf(workflowStatus(repo, CHANGE), 'loop', 'start');
  assert.deepEqual([start.by, start.blocked_by], ['user', ['gating_missing']], JSON.stringify(start));
  // One gating check is enough for a loop to start.
  editChecks(repo, FAILURE, (declared) => ({ ...declared, scenario: { ...declared.scenario, manual: [] },
    checks: [{ id: 'c1', intent: 'REQ-submit-failure', then: '本次提交发送的成功通知数量为零', expect: '本次提交发送的成功通知数量为零', role: 'gating' }] }));
  assert.ok(!actionOf(workflowStatus(repo, CHANGE), 'loop', 'start').blocked_by.includes('gating_missing'));
});

test('a running loop whose packages are changed to leave every line to the user ends, and its stop says that no run can pass', (t) => {
  const { repo, root } = inLoop(t);
  leaveEveryLineToTheUser(repo, root);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual(status.stop, { code: 'stop_no_gating', at: null, message: NO_GATING });
  // The loop's own status reports the stop; a new loop on these packages would be refused.
  const workflow = workflowStatus(repo, CHANGE);
  assert.ok(!codes(workflow.gaps).includes('gating_missing'), JSON.stringify(workflow.gaps));
  assert.ok(actionOf(workflow, 'loop', 'start').blocked_by.includes('gating_missing'), JSON.stringify(actionOf(workflow, 'loop', 'start')));
});

test('a package rewritten to checks.json 1.0 inside a loop ends it, and a new loop refuses it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editChecks(repo, SUCCESS, toLegacy);
  checkEval(repo, CHANGE, { case: SUCCESS });
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(legacyWarning([SUCCESS])), JSON.stringify(status.warnings));
  assertEnded(status, 'packages_changed');
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // The loop ended without acceptance: the change is locked, and the lock names the end.
  assertGapShape(refusedBeforeRun(project, {}, 'change_locked'), { owner: 'user', layer: 'loop', reason: 'packages_changed' });
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('then_unbound'));
});

test('loop status names the line each check verifies, and asks the user to judge the lines no check verifies at acceptance', (t) => {
  const project = withManualLine(t);
  const { repo, root } = project;
  startLoop(repo, CHANGE);
  assert.deepEqual(loopStatus(repo, CHANGE).checks.map((entry) => [entry.case, entry.check, entry.then]), [
    [FAILURE, 'c1', '本次提交发送的成功通知数量为零'], [SUCCESS, 'c1', '本次提交发送的成功通知数量为一']]);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.ok(text.includes(`| ${SUCCESS} | ${LINE_NONE} | synthetic: a person reads it |`), text);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
  // The user is shown the line no check verifies, which they judge themselves.
  assert.deepEqual(status.must_show.manual, [{ case: SUCCESS, then: LINE_NONE, reason: 'synthetic: a person reads it', final_attempts: 1 }]);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 7' });
  assert.deepEqual(accepted.manual, [{ case: SUCCESS, then: LINE_NONE, reason: 'synthetic: a person reads it' }]);
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
  assert.ok(existsSync(path.join(root, 'accepted.json')));
});

test('a report of a run recorded before compare.json named THEN lines shows a dash and no block of lines the user judges', (t) => {
  const project = inLoop(t);
  const { repo, runs } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  // As an earlier release wrote it, before its report was written.
  const file = path.join(runs, run.run_id, 'compare.json');
  const { manual, ...older } = readJSON(file);
  assert.deepEqual(manual, []);
  writeFileSync(file, `${JSON.stringify({ ...older, results: older.results.map(({ then, ...entry }) => entry) }, null, 2)}\n`);
  rmSync(path.join(project.root, 'reports', `${run.run_id}.md`), { force: true });
  const written = writeReport(repo, CHANGE, { run: run.run_id });
  assert.equal(written.created, true);
  const text = readFileSync(written.file, 'utf8');
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| — \| gating \| fail \(0\/1\) → pass \(1\/1\) \| holds \(fixed\) \|$/m);
  assert.ok(!text.includes('No check verifies these lines'), text);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable');
  assert.equal(status.must_show.manual, undefined);
});

test('workflow status names packages still in checks.json 1.0 and the lines the user judges, and a 1.0 package is not confirmed until it is upgraded', (t) => {
  const project = readyProject(t, { check: false });
  const { repo } = project;
  editChecks(repo, FAILURE, toLegacy);
  editChecks(repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: a person reads it' }];
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  commit(repo, 'Keep a 1.0 package and leave a line to the user');
  let status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.packages.legacy, [FAILURE]);
  assert.deepEqual(status.layers.packages.manual_lines, [{ case: SUCCESS, then: LINE_NONE }]);
  assert.ok(actionOf(status, 'eval', 'confirm').blocked_by.includes('then_unbound'), JSON.stringify(actionOf(status, 'eval', 'confirm')));
  assert.throws(() => confirmChecks({ repo }), (error) => codes(error.gaps).includes('then_unbound'));
  // Once upgraded, the user confirms, and the line they judge is what they were shown.
  editChecks(repo, FAILURE, (declared) => ({ ...declared, schema_version: '1.1', checks: declared.checks.map((check) => ({ ...check, then: '本次提交发送的成功通知数量为零' })),
    fixtures: declared.fixtures.map((fixture) => ({ ...fixture, ...(fixture.name.startsWith('review-') ? { origin: 'review' } : {}) })) }));
  assert.equal(checkEval(repo, CHANGE).passed, true);
  status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.packages.legacy, []);
  assert.ok(status.must_show.lines.some((line) => line.package === SUCCESS && line.then === LINE_NONE && line.status === 'manual'), JSON.stringify(status.must_show.lines));
  confirmChecks({ repo });
  status = workflowStatus(repo, CHANGE);
  const baseline = actionOf(status, 'run', 'start', '--baseline');
  assert.deepEqual([baseline.allowed, baseline.needed], [true, true], JSON.stringify(baseline));
  assert.deepEqual(status.layers.packages.manual_lines, [{ case: SUCCESS, then: LINE_NONE }]);
});

// The user's checks confirmation: loop start and loop accept hold to it.

test('loop start refuses checks the user has not confirmed, and workflow status names the confirmation as the user\'s pending decision', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  let status = workflowStatus(repo, CHANGE);
  assertGapShape(status.layers.confirmation.gaps.find((entry) => entry.code === 'checks_unconfirmed'), { owner: 'user', layer: 'confirmation', kind: 'business' });
  const confirm = actionOf(status, 'eval', 'confirm');
  assert.deepEqual([confirm.by, confirm.needed, confirm.allowed], ['user', true, true], JSON.stringify(confirm));
  // The agent's own step, a baseline, comes first in the light tier.
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  // A baseline recorded first still runs; the loop waits for the confirmation.
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(actionOf(workflowStatus(repo, CHANGE), 'eval', 'confirm').needed, true);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('checks_unconfirmed')(error);
    assert.deepEqual(codes(error.gaps), ['checks_unconfirmed']);
    assertGapShape(gapOf(error, 'checks_unconfirmed'), { kind: 'business', owner: 'user', layer: 'confirmation' });
    return true;
  });
  assert.ok(actionOf(workflowStatus(repo, CHANGE), 'loop', 'start').blocked_by.includes('checks_unconfirmed'));
  const { confirmation } = confirmChecks(project);
  status = workflowStatus(repo, CHANGE);
  const start = actionOf(status, 'loop', 'start');
  assert.deepEqual([start.by, start.allowed], ['user', true], JSON.stringify(start));
  assert.ok(start.command.includes('--by') && start.command.includes('--ref'), JSON.stringify(start.command));
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.loop.checks_confirmation, { id: confirmation.id, at: confirmation.confirmed.at });
  assert.equal(started.loop.budget_source, 'confirmation');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.confirmation, { id: confirmation.id, at: confirmation.confirmed.at, by: USER, kind: 'initial', current: true, unconfirmed: [] });
  assert.deepEqual(status.loop.checks_confirmation, started.loop.checks_confirmation);
});

test('a package changed inside a loop ends it, and a new loop waits for the user\'s confirmation of it and a baseline that ran it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('checks_unconfirmed')(error);
    blockedWith('baseline_packages_differ')(error);
    const unconfirmed = assertGapShape(gapOf(error, 'checks_unconfirmed'), { owner: 'user', layer: 'confirmation', cases: [SUCCESS] });
    assert.ok(unconfirmed.message.includes(`${SUCCESS}/environment/Dockerfile`), unconfirmed.message);
    return true;
  });
  const revision = confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  assert.equal(revision.confirmation.confirmed.kind, 'revision');
  // The user's confirmation of the changed package differs from the loop's
  // own; a new loop needs a baseline of it and the user's consent.
  assert.deepEqual(revision.loop, { started_at: project.loop.started_at, phase: 'ended', ended: true, reason: 'confirmation_changed' });
  assert.deepEqual(revision.new_loop_needs, { baseline: true, user_consent: true });
  assertSuggestion(revision, ['run', 'start', CHANGE, '--baseline']);
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const next = startLoop(repo, CHANGE);
  assert.equal(next.loop.checks_confirmation.id, revision.confirmation.id);
  assert.equal(next.earlier_loops.loops.length, 1);
});

test('loop start refuses a baseline that ran another plan than the user confirmed', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  confirmChecks(project, { tier: 'full', model: 'synthetic/model-a', attempts: 1 });
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.run_plan.model, 'synthetic/model-a');
  const { confirmation } = confirmChecks(project, { tier: 'full', model: 'synthetic/model-b', attempts: 1 });
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_plan_differs')(error);
    const entry = assertGapShape(gapOf(error, 'baseline_plan_differs'), { owner: 'agent', layer: 'baseline', run: base.run_id, differs: ['model'], confirmation: confirmation.id });
    assert.equal(entry.message, `The baseline ${base.run_id} ran with model synthetic/model-a but the user confirmed 1 attempt, agent ${AGENT}, model synthetic/model-b (${confirmation.confirmed.at}). A baseline reads the confirmed plan from confirmed.json.`);
    return true;
  });
  // workflow status asks for the same baseline again, and refuses the loop.
  let status = workflowStatus(repo, CHANGE);
  assert.ok(codes(status.layers.baseline.gaps).includes('baseline_plan_differs'), JSON.stringify(status.layers.baseline.gaps));
  const baseline = actionOf(status, 'run', 'start', '--baseline');
  assert.deepEqual([baseline.allowed, baseline.needed], [true, true], JSON.stringify(baseline));
  assert.ok(actionOf(status, 'loop', 'start').blocked_by.includes('baseline_plan_differs'));
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect']);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.run_plan.model, 'synthetic/model-b');
  status = workflowStatus(repo, CHANGE);
  assert.deepEqual(actionOf(status, 'loop', 'start').blocked_by, []);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('loop start takes the budget the user confirmed, unless flags give another, which it records beside the confirmed one with the user\'s consent', (t) => {
  // Each start is the first loop of a project whose user confirmed 3 runs and 20 run minutes.
  const fresh = () => {
    const project = readyProject(t, { confirm: false });
    confirmChecks(project, { iterations: 3, minutes: 20 });
    startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
    return project;
  };
  const confirmed = { iterations: 3, minutes: null, run_minutes: 20 };
  const started = startLoop(fresh().repo, CHANGE);
  assert.deepEqual(started.loop.budget, confirmed);
  assert.equal(started.loop.budget_source, 'confirmation');
  assert.equal(started.loop.confirmed_budget, undefined);
  assert.equal(started.loop.budget_consent, undefined);
  assert.deepEqual(started.warnings, []);
  const flagged = startLoop(fresh().repo, CHANGE, { iterations: 4, minutes: 30 });
  assert.deepEqual(flagged.loop.budget, { iterations: 4, minutes: null, run_minutes: 30 });
  assert.equal(flagged.loop.budget_source, 'loop_start');
  assert.deepEqual(flagged.loop.confirmed_budget, confirmed);
  // A budget above the confirmed one is the user's decision, kept with who and where.
  assert.deepEqual(flagged.loop.budget_consent, { by: USER, ref: REF, at: flagged.loop.started_at });
  // One flag takes the other value from the confirmation.
  assert.deepEqual(startLoop(fresh().repo, CHANGE, { iterations: 2 }).loop.budget, { iterations: 2, minutes: null, run_minutes: 20 });
});

test('loop start warns when the baseline\'s attempts show the confirmed budget may not hold the runs, and the budget still stops the loop', (t) => {
  const project = withBaseline(t);
  const { repo, base, runs } = project;
  // Each package made one attempt of 15 minutes: a full run takes 30.
  for (const id of [FAILURE, SUCCESS]) timeAttempts(path.join(runs, base.run_id, id, 'attempts.json'), 15 * 60);
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.loop.budget, { iterations: 5, minutes: null, run_minutes: 30 });
  assert.deepEqual(started.budget_fit, { needed_minutes: 150, minutes: 30, unit: 'run minutes', cost_needed: null, cost_cap: null, fits: false, basis: 'baseline_attempts' });
  assert.ok(started.warnings.includes(`budget_unfit: the budget is 5 full runs and 30 run minutes, but 5 runs of about 30 minutes each need about 150 run minutes (by the attempts of the baseline ${base.run_id}). The budget stops the loop when it is used up.`), JSON.stringify(started.warnings));

  // A baseline that ran nothing has no run time to go by; the fixtures of
  // eval check, a second each, fit the budget.
  const empty = readyProject(t, { mode: 'new', results: {} });
  const unavailable = startRun(empty.repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const other = path.join(empty.runs, unavailable.run_id, 'run.json');
  const kept = readJSON(other);
  kept.started_at = new Date(Date.parse(kept.finished_at) - 30 * 60_000).toISOString();
  writeFileSync(other, `${JSON.stringify(kept, null, 2)}\n`);
  const fits = startLoop(empty.repo, CHANGE);
  assert.deepEqual(fits.loop.budget, { iterations: 5, minutes: null, run_minutes: 30 });
  assert.equal(fits.budget_fit.fits, true);
  assert.ok(!fits.warnings.some((warning) => warning.startsWith('budget_unfit')), JSON.stringify(fits.warnings));
  assert.equal(loopStatus(empty.repo, CHANGE).loop.estimate.basis, 'eval_check');
});

test('a loop started before loops kept a checks confirmation ends when a package changes, and loop accept refuses it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const loop = loopRecord(project);
  delete loop.checks_confirmation;
  writeFileSync(loopPath(project), `${JSON.stringify(loop, null, 2)}\n`);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  assert.equal(loopStatus(repo, CHANGE).situation.code, 'acceptable');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  // Without a confirmation of its own, the loop compares with the packages it started on.
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], []]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('loop_ended')(error);
    refusedWith('packages_changed')(error);
    return true;
  });
});

test('a loop that kept no checks confirmation is not accepted without one, and the refusal names the packages the user did not confirm', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const loop = loopRecord(project);
  delete loop.checks_confirmation;
  writeFileSync(loopPath(project), `${JSON.stringify(loop, null, 2)}\n`);
  rmSync(path.join(project.root, 'confirmed.json'));
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('packages_unconfirmed')(error);
    const entry = assertGapShape(gapOf(error, 'packages_unconfirmed'), { owner: 'user', layer: 'confirmation', kind: 'business' });
    assert.ok(entry.message.startsWith(`The eval packages of ${run.run_id} differ from the latest checks confirmation (none): no checks confirmation of this Spec export covers ${FAILURE}, ${SUCCESS}. The user accepts only packages they confirmed`), entry.message);
    return true;
  });
});

test('once the Spec is exported again, loop status ends the loop and reports the confirmation it started on', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  exportRevision(project);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.confirmation.id, project.confirmation.confirmation.id);
  assert.equal(status.confirmation.current, false);
  assert.ok(!status.warnings.some((warning) => warning.includes('the user confirms the revision when they accept')), JSON.stringify(status.warnings));
});

test('the lines only a self-review counterexample stands behind are named at acceptance and kept with it', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  editChecks(repo, FAILURE, (declared) => { declared.fixtures.find((fixture) => fixture.name === 'review-c1').origin = 'self-review'; });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  confirmChecks(project, { origin: 'self-review' });
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.must_show.self_review_lines, [{ package: FAILURE, then: '本次提交发送的成功通知数量为零' }]);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual(accepted.self_review_lines, [{ package: FAILURE, then: '本次提交发送的成功通知数量为零' }]);
  assert.equal(accepted.checks_confirmation.review_origin, 'self-review');
});

test('workflow status reads the loop budget from the confirmation, and a bigger one needs the user\'s consent at loop start', (t) => {
  const project = withBaseline(t);
  const { repo } = project;
  const status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.confirmation.latest.budget, project.confirmation.confirmation.run_plan.budget);
  const start = actionOf(status, 'loop', 'start');
  assert.deepEqual([start.by, start.allowed, start.needed], ['user', true, true], JSON.stringify(start));
  assert.ok(start.needs.includes('user consent with --by and --ref for a budget above the confirmed one'), JSON.stringify(start.needs));
  assert.ok(start.needs.includes('user consent: starting a loop, recorded with --by and --ref'), JSON.stringify(start.needs));
  assertSuggestion(status, ['loop', 'start', CHANGE, '--repo', repo, '--by']);
});

test('loop start estimates a screen run from one attempt of each package and the final run from the plan\'s attempts', (t) => {
  // Every attempt of the baseline took 7.5 minutes: a screen run of one
  // attempt each takes about 15, the final run of 3 and 1 about 30.
  const timed = () => {
    const project = readyProject(t, { live: [FAILURE], attempts: 3 });
    const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
    assert.deepEqual(base.attempts, { [FAILURE]: 3, [SUCCESS]: 1 });
    for (const id of [FAILURE, SUCCESS]) timeAttempts(path.join(project.runs, base.run_id, id, 'attempts.json'), 7.5 * 60);
    return { ...project, base };
  };
  const project = timed();
  const started = startLoop(project.repo, CHANGE);
  assert.deepEqual(started.budget_fit, { needed_minutes: 90, minutes: 60, unit: 'run minutes', cost_needed: null, cost_cap: null, fits: false, basis: 'baseline_attempts' });
  assert.ok(started.warnings.includes(`budget_unfit: the budget is 5 full runs and 60 run minutes, but 4 screen runs of about 15 minutes each and a final run of about 30 minutes need about 90 run minutes (by the attempts of the baseline ${project.base.run_id}). The budget stops the loop when it is used up.`), JSON.stringify(started.warnings));
  // Two runs, a screen run and its final run, fit 60 run minutes.
  const fitting = startLoop(timed().repo, CHANGE, { iterations: 2, minutes: 60 });
  assert.deepEqual(fitting.loop.budget, { iterations: 2, minutes: null, run_minutes: 60 });
  assert.deepEqual([fitting.budget_fit.needed_minutes, fitting.budget_fit.fits], [45, true]);
  assert.ok(!fitting.warnings.some((warning) => warning.startsWith('budget_unfit')), JSON.stringify(fitting.warnings));
});

test('loop status estimates a screen run and the final run from the baseline\'s attempts, with their cost and what the budget has left', (t) => {
  const usage = { cost_usd: 0.05, n_input_tokens: 100, n_output_tokens: 20 };
  const timed = (results) => ({ [FAILURE]: { ...results[FAILURE], $seconds: 30, $usage: usage }, [SUCCESS]: { ...results[SUCCESS], $seconds: 6 } });
  const project = readyProject(t, { live: [FAILURE], attempts: 3, results: timed(BEFORE) });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  let status = loopStatus(repo, CHANGE);
  // FAILURE's attempts took 30 seconds and cost $0.05 each, SUCCESS's 6 seconds.
  const { run_overhead: overhead, ...estimate } = status.loop.estimate;
  assert.equal(overhead, undefined, JSON.stringify(overhead));
  assert.deepEqual(estimate, { basis: 'baseline_attempts',
    per_attempt: { [FAILURE]: { minutes: 0.5, cost_usd: 0.05, basis: 'baseline_attempts' }, [SUCCESS]: { minutes: 0.1, cost_usd: null, basis: 'baseline_attempts' } },
    screen: { minutes: 0.6, cost_usd: 0.05 }, final: { minutes: 1.6, cost_usd: 0.15 }, full: { minutes: 1.6, cost_usd: 0.15 },
    remaining: { runs: 5, minutes: 60 } });
  assert.deepEqual(status.loop.usage, { runs: 0, minutes: null, attempts: 0, reported: 0, cost_usd: null, n_input_tokens: null, n_cache_tokens: null, n_output_tokens: null });

  // A partial run counts toward the loop's usage too.
  const partial = startRun(repo, CHANGE, { case: [SUCCESS] });
  const screen = passingScreen(project, timed(AFTER));
  status = loopStatus(repo, CHANGE);
  assertFinalDue(status, screen.run_id, repo);
  // Once the loop's own runs timed every package, they are what the estimate rests on.
  assert.deepEqual(status.situation.estimate, { minutes: 1.6, cost_usd: 0.15, basis: 'loop_attempts', lower_bound: false });
  assert.equal(status.loop.estimate.remaining.runs, 4);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  completeReport(repo, final.run_id);

  // A run recorded before runs kept their usage is read from its attempts.
  const file = path.join(project.runs, partial.run_id, 'run.json');
  const { usage: dropped, ...older } = readJSON(file);
  assert.equal(dropped.attempts, 1);
  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
  const used = status.loop.usage;
  // The screen run made 2 attempts and the final run 4; FAILURE's 4 reported.
  assert.deepEqual({ ...used, minutes: null }, { runs: 3, minutes: null, attempts: 7, reported: 4, cost_usd: 0.2, n_input_tokens: 400, n_cache_tokens: null, n_output_tokens: 80 });
  assert.ok(Number.isFinite(used.minutes), JSON.stringify(used));
  // The user is shown what the loop used, with the strength of the pass.
  assert.ok(status.strength.sentence.startsWith(STRENGTH_3), status.strength.sentence);
  assert.deepEqual(status.must_show.usage, [{ runs: 3, minutes: used.minutes, cost_usd: 0.2, tokens: 480, trials: [], lost: [], interrupted: [] }]);
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual(accepted.usage, used);
});

test('without the baseline\'s attempt times loop start estimates from the last eval check, and without those from the baseline\'s whole run', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, root, runs } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // Every fixture of eval check took 10 minutes; the baseline's attempts a second.
  const fixtures = (id) => readdirSync(path.join(root, 'checks', id), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, 'checks', id, entry.name, 'attempts.json')).filter((file) => existsSync(file));
  for (const file of [...fixtures(FAILURE), ...fixtures(SUCCESS)]) timeAttempts(file, 10 * 60);
  startLoop(repo, CHANGE);
  assert.equal(loopStatus(repo, CHANGE).loop.estimate.basis, 'baseline_attempts');
  // Each start below is a new loop once the one before it ended.
  const again = (options = {}) => {
    endLoop(repo, CHANGE, { reason: 'synthetic: start again with another estimate' });
    return startLoop(repo, CHANGE, options);
  };
  const unfit = (started, basis) => {
    assert.equal(started.budget_fit.fits, false, JSON.stringify(started.budget_fit));
    const warning = started.warnings.find((entry) => entry.startsWith('budget_unfit: '));
    assert.ok(warning?.includes(` (${basis}). The budget stops the loop`), JSON.stringify(started.warnings));
    return warning;
  };
  // One package without the baseline's attempt times takes those of eval check.
  rmSync(path.join(runs, base.run_id, FAILURE, 'attempts.json'));
  unfit(again(), `by the attempts of the baseline ${base.run_id} and, for ${FAILURE}, of the last eval check`);
  rmSync(path.join(runs, base.run_id, SUCCESS, 'attempts.json'));
  const warning = unfit(again(), 'by the attempts of the last eval check');
  assert.ok(warning.includes('but 4 screen runs of about 20 minutes each and a final run of about 40 minutes need about 120 run minutes'), warning);
  // Without any attempt times, the baseline's whole run is scaled.
  for (const file of fixtures(FAILURE)) rmSync(file);
  const record = path.join(runs, base.run_id, 'run.json');
  const kept = readJSON(record);
  kept.started_at = new Date(Date.parse(kept.finished_at) - 30 * 60_000).toISOString();
  delete kept.usage;
  writeFileSync(record, `${JSON.stringify(kept, null, 2)}\n`);
  unfit(again(), `by the whole run of the baseline ${base.run_id}, 30 minutes`);
  again({ iterations: 2, minutes: 60 });
  const { estimate } = loopStatus(repo, CHANGE).loop;
  assert.deepEqual(estimate, { basis: 'baseline_run', baseline_minutes: 30, screen: { minutes: 15, cost_usd: null }, final: { minutes: 30, cost_usd: null },
    full: { minutes: 30, cost_usd: null }, remaining: { runs: 2, minutes: 60 } });
});

test('on a baseline that recorded that nothing could run, loop start checks the budget as loop status estimates it: screen runs and a final run', (t) => {
  const project = readyProject(t, { mode: 'new', results: {}, live: [FAILURE], attempts: 3 });
  const { repo, root } = project;
  // A fixture of FAILURE took 5 minutes, one of SUCCESS 1: a screen run takes
  // about 6, the final run of 3 and 1 about 16, and 4 screen runs and a final
  // run about 40 of the confirmed 60 minutes. 5 runs of the plan would need 80.
  const fixtures = (id) => readdirSync(path.join(root, 'checks', id), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, 'checks', id, entry.name, 'attempts.json')).filter((file) => existsSync(file) && !file.includes(`${path.sep}probe${path.sep}`));
  for (const file of fixtures(FAILURE)) timeAttempts(file, 5 * 60);
  for (const file of fixtures(SUCCESS)) timeAttempts(file, 60);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.is_baseline, base.run_plan.attempts], [false, 3]);
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.loop.budget, { iterations: 5, minutes: null, run_minutes: 60 });
  assert.deepEqual([started.budget_fit.needed_minutes, started.budget_fit.fits], [40, true]);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.final.needed, true);
  assert.deepEqual([status.loop.estimate.basis, status.loop.estimate.screen.minutes, status.loop.estimate.final.minutes], ['eval_check', 6, 16]);
  // One full run leaves no room for the final run here either, in a new loop once that one ended.
  endLoop(repo, CHANGE, { reason: 'synthetic: start again with one run' });
  const short = startLoop(repo, CHANGE, { iterations: 1, minutes: 60 });
  assert.ok(short.warnings.some((warning) => warning.startsWith('A budget of 1 full run leaves no room for a final run')), JSON.stringify(short.warnings));
});

test('a head run made while loop.json was away joins no loop, and a run of another plan than the loop\'s is not accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // Inside the loop another model is refused before anything runs.
  assertGapShape(refusedBeforeRun(project, { model: 'synthetic/lenient' }, 'run_plan_fixed'), { owner: 'agent', layer: 'loop' });
  // The same code passes with another model, in a run made while loop.json is away.
  const away = `${loopPath(project)}.away`;
  renameSync(loopPath(project), away);
  const other = startRun(repo, CHANGE, { model: 'synthetic/lenient' });
  renameSync(away, loopPath(project));
  assert.equal(other.verdict, 'pass');
  assert.equal(readRecord(other).run.loop, null);
  assert.ok(!loopStatus(repo, CHANGE).runs.some((run) => run.run_id === other.run_id));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: other.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('outside_loop'));
  // A run recorded before runs named their loop joins the loop by its start;
  // one of another plan than the loop's is still not accepted.
  const file = path.join(project.runs, other.run_id, 'run.json');
  const { loop: _, ...older } = readJSON(file);
  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
  assert.ok(loopStatus(repo, CHANGE).runs.some((run) => run.run_id === other.run_id));
  completeReport(repo, other.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: other.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('loop_plan_differs')(error);
    assert.match(gapOf(error, 'loop_plan_differs').message, new RegExp(`^${other.run_id} ran another plan than this loop's: model synthetic/lenient where the loop runs `));
    return true;
  });
});

test('a head run made in a loop names that loop, its baseline and its start code', (t) => {
  const project = inLoop(t);
  const { repo, loop } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const named = readRecord(run).run.loop;
  assert.deepEqual([named.started_at, named.baseline, named.start_code], [loop.started_at, loop.baseline, loop.start_code], JSON.stringify(named));
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  // The acceptance records the agent and the model the run ran with.
  const ran = readRecord(run).run.environment_ref;
  assert.deepEqual([accepted.run_plan.agent, accepted.run_plan.model], [ran.agent, ran.model]);
  assert.deepEqual(accepted.loop_consent, { by: USER, ref: REF, at: loop.started_at });
});
