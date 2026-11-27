// Loop tests: the run plan and the strength of a pass, THEN lines, the user's
// checks confirmation, and the estimates of a screen run and the final run.
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
  EXPECT, BROKEN, TEMPLATE_MARK, codes, blockedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, REVISED, loopPath, loopRecord,
  changePackage, exportRevision, runsOf, liveLoop, gapOf, STRENGTH_3, FINAL_COST, FINAL_RUN, passingScreen, resultsOutsideCode,
  refusedBeforeRun, assertEnded, assertStopBudget, refusedWith, editLoop, minutesAgo,
} from './helpers/loop.js';

// Rewrites an attempts.json so that every attempt took this many seconds.
function timeAttempts(file, seconds) {
  const recorded = readJSON(file);
  for (const attempt of recorded.attempts) attempt.finished_at = new Date(Date.parse(attempt.started_at) + seconds * 1000).toISOString();
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
}

// --- The run plan: attempts, counts and the strength of a pass ---

// The strength loop status gives for a passing run of a loop with live FAILURE
// at N attempts: with more than one, of the final run after a screen run.
function strengthAt(t, attempts) {
  const { repo } = liveLoop(t, attempts);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  let run = fullRun(repo);
  completeReport(repo, run.run_id);
  if (attempts > 1) {
    assert.equal(run.role, 'screen');
    run = fullRun(repo);
    assert.equal(run.role, 'final');
    completeReport(repo, run.run_id, { review: false });
  }
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  return status.next;
}

test('a check that passed in some attempts and failed in others of a final run counts as both on that code', (t) => {
  const { repo } = liveLoop(t, 3);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } }, 'Try a change whose result varies');
  // The screen run makes one attempt, which passes; the final run makes three.
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass']);
  completeReport(repo, screen.run_id);
  const run = fullRun(repo);
  assert.deepEqual([run.role, run.verdict], ['final', 'fail']);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.deepEqual(status.unstable.map(runsOf), [{ case: FAILURE, check: 'c1', pass: [screen.run_id, run.run_id], fail: [run.run_id] }]);
});

test('the report shows each result with its passes out of its attempts, and acceptance records the counts, the plan and the strength', (t) => {
  const project = liveLoop(t, 3);
  const { repo, root, base } = project;
  const { id } = project.confirmation.confirmation;
  assert.deepEqual(loopStatus(repo, CHANGE).loop.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'confirmation', confirmation: id });
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // The screen run makes one attempt of each package.
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass']);
  const screenText = readFileSync(writeReport(repo, CHANGE, { run: screen.run_id }).file, 'utf8');
  assert.match(screenText, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/3\) → pass \(1\/1\) \| holds \|$/m);
  completeReport(repo, screen.run_id);
  // The final run runs the plan.
  const run = fullRun(repo);
  assert.deepEqual([run.role, run.verdict], ['final', 'pass']);
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.match(text, /^\| Case \| Check \| Requirement \| THEN \| Role \| Before → After \| Verdict \|$/m);
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/3\) → pass \(3\/3\) \| holds \|$/m);
  assert.match(text, /^\| submit-success-s1 \| c1 \| REQ-submit-success \| 本次提交发送的成功通知数量为一 \| gating \| pass \(1\/1\) → pass \(1\/1\) \| holds \|$/m);
  assert.doesNotMatch(text, /\(varied\)/);
  completeReport(repo, run.run_id, { review: false });

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  const sentence = 'The gating checks of packages with a live dependency each had 3 attempts with evidence, and none failed. A check that fails half the time passes all 3 with a 13% chance; one that fails one time in ten, with a 73% chance. That does not show the checks always hold.';
  assert.deepEqual(status.next.strength, { attempts: 3, pass_all_chance: { fails_half: 0.125, fails_one_in_ten: 0.729 }, single_sample: false, sentence });
  assert.ok(status.next.message.startsWith(`Show the user the per-check comparison of final run ${run.run_id}, its report and the report of screen run ${screen.run_id} with its Review, and this: ${sentence}`), status.next.message);
  assert.ok(status.next.message.endsWith(' Record acceptance only with their own words; a pass is not acceptance.'), status.next.message);

  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const accepted = readJSON(path.join(root, 'accepted.json'));
  assert.equal(accepted.schema_version, '1.1');
  assert.equal(accepted.baseline, base.run_id);
  assert.deepEqual(accepted.checks.map(({ case: id, check, before_counts: before, after_counts: after }) => [id, check, before, after]), [
    [FAILURE, 'c1', { pass: 0, fail: 3, unknown: 0 }, { pass: 3, fail: 0, unknown: 0 }],
    [SUCCESS, 'c1', { pass: 1, fail: 0, unknown: 0 }, { pass: 1, fail: 0, unknown: 0 }],
    [SUCCESS, 'c2', { pass: 1, fail: 0, unknown: 0 }, { pass: 1, fail: 0, unknown: 0 }],
  ]);
  assert.deepEqual(accepted.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'confirmation', confirmation: id, attempts_by_case: { [FAILURE]: 3, [SUCCESS]: 1 } });
  assert.deepEqual(accepted.strength, status.next.strength);
});

test('the strength of a pass comes from a fixed formula: one attempt is a single sample, five rule out more', (t) => {
  const one = strengthAt(t, 1);
  assert.deepEqual([one.strength.attempts, one.strength.single_sample, one.strength.pass_all_chance], [1, true, { fails_half: 0.5, fails_one_in_ten: 0.9 }]);
  assert.equal(one.strength.sentence, 'The gating checks of packages with a live dependency each had 1 attempt with evidence: a single sample. A check that fails half the time passes it with a 50% chance; one that fails one time in ten, with a 90% chance. That does not show the checks always hold.');
  const five = strengthAt(t, 5);
  assert.deepEqual([five.strength.attempts, five.strength.single_sample, five.strength.pass_all_chance], [5, false, { fails_half: 0.03125, fails_one_in_ten: 0.5905 }]);
  assert.match(five.strength.sentence, /passes all 5 with a 3% chance; one that fails one time in ten, with a 59% chance\./);
  assert.ok(five.message.includes(five.strength.sentence));
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
  assert.ok(legacy.warnings.includes(`The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs 3 times, as it did there. A new baseline asks for the number of attempts of each package that declares a live dependency.`), JSON.stringify(legacy.warnings));
  assert.deepEqual(legacy.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'legacy', uniform: true });
  assert.deepEqual(loopStatus(repo, CHANGE).loop.run_plan, legacy.run_plan);
});

test('workflow check run-eval asks for the user\'s confirmation of the number of attempts first, and then gives the baseline command without --attempts', (t) => {
  const unconfirmed = readyProject(t, { live: [SUCCESS], confirm: false });
  assert.equal(checkWorkflow(unconfirmed.repo, 'run-eval', CHANGE).next.action, 'confirm_checks');

  const live = readyProject(t, { live: [SUCCESS] });
  let check = checkWorkflow(live.repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline');
  assert.deepEqual(check.next.command, ['run', 'start', CHANGE, '--repo', live.repo, '--baseline']);
  assert.ok(check.next.note.endsWith(' The baseline reads the number of attempts, the agent and the model the user confirmed from confirmed.json: pass none of them.'), check.next.note);

  const model = readyProject(t, { model: 'synthetic/model-1' });
  check = checkWorkflow(model.repo, 'run-eval', CHANGE);
  assert.deepEqual(check.next.command, ['run', 'start', CHANGE, '--repo', model.repo, '--baseline']);
  assert.match(check.next.note, /The baseline reads the number of attempts/);
  const base = startRun(model.repo, CHANGE, { baseline: true });
  assert.deepEqual([base.run_plan.attempts, base.run_plan.model], [3, 'synthetic/model-1']);
});

test('under a baseline from before run plans every package ran its attempts, and the strength counts every gating check', (t) => {
  const { repo, root, runs } = readyProject(t);
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
  const run = fullRun(repo);
  assert.deepEqual([run.role, run.verdict], ['final', 'pass']);
  assert.deepEqual(run.attempts, { [FAILURE]: 2, [SUCCESS]: 2 });
  completeReport(repo, run.run_id, { review: false });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.deepEqual(status.final.live, [FAILURE, SUCCESS]);
  const sentence = 'The gating checks each had 2 attempts with evidence, and none failed. A check that fails half the time passes all 2 with a 25% chance; one that fails one time in ten, with an 81% chance. That does not show the checks always hold.';
  assert.deepEqual(status.next.strength, { attempts: 2, pass_all_chance: { fails_half: 0.25, fails_one_in_ten: 0.81 }, single_sample: false, sentence });
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual(readJSON(path.join(root, 'accepted.json')).strength, status.next.strength);
});

test('a baseline recorded again keeps the number of attempts the user chose: loop start and workflow check say it reads it from the confirmation', (t) => {
  const project = readyProject(t, { live: [FAILURE] });
  const { repo } = project;
  const expect = writeExpectations(repo, EXPECT);
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3, expect });
  // A file added only for the evals.
  writeFileSync(path.join(repo, '.dockerignore'), 'node_modules\n');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    assert.ok(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').message
      .includes('such as .dockerignore, record the baseline again instead, with the same --expect file and no --attempts, --agent or --model; the baseline reads the plan from confirmed.json. Otherwise:'), error.message);
    return true;
  });
  rmSync(path.join(repo, '.dockerignore'));
  changePackage(project, SUCCESS);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_packages_differ')(error);
    assert.ok(error.gaps.find((entry) => entry.code === 'baseline_packages_differ').message
      .endsWith('Record the baseline again on the code before the change, with the same --expect file and no --attempts, --agent or --model; the baseline reads the plan from confirmed.json, then run `loop start` again.'), error.message);
    return true;
  });
  // The user confirms the changed package; the confirmation keeps their number.
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'confirm_checks');
  assert.equal(confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' }).confirmation.run_plan.attempts, 3);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check.next));
  assert.deepEqual(check.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', expect]);
  assert.ok(check.next.note.endsWith(' The baseline reads the number of attempts, the agent and the model the user confirmed from confirmed.json: pass none of them.'), check.next.note);
  assert.ok(check.next.note.startsWith(`The baseline ${base.run_id} ran other eval packages than the ones now`), check.next.note);
  const again = startRun(repo, CHANGE, { baseline: true, expect });
  assert.equal(again.run_plan.attempts, 3);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

// checks.json 1.1: the THEN lines through the loop.

const LINE_NONE = '本次提交发送的失败通知数量为零';
const THEN_UNBOUND = (ids) => `${ids.join(', ')} ${ids.length === 1 ? 'uses' : 'use'} checks.json 1.0, whose checks do not name the THEN lines they verify, so a loop does not start on ${ids.length === 1 ? 'it' : 'them'}. Upgrade ${ids.length === 1 ? 'it' : 'each'} to 1.1 with write-eval: set schema_version to "1.1", give every gating check the line it verifies as then, and list a line no program can judge in scenario.manual. Then run \`eval check\`. A baseline that ran on the old packages compares nothing with the new ones, so record it again before \`loop start\`.`;
const UPGRADE_FIRST = (ids) => `First upgrade ${ids.join(', ')} to checks.json 1.1, as \`workflow check loop-and-implement\` says: a loop does not start on 1.0 packages, and a baseline recorded before the upgrade compares nothing with the upgraded ones. `;

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

test('loop start refuses packages in checks.json 1.0 with then_unbound, and workflow check loop-and-implement says so', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, toLegacy);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  commit(repo, 'Keep a package in checks.json 1.0');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true);
  // A 1.0 package cannot be confirmed either, so the checks stay unconfirmed.
  const unbound = { code: 'then_unbound', kind: 'artifact', owner: 'agent', route: 'write-eval', message: THEN_UNBOUND([SUCCESS]), cases: [SUCCESS] };
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    assert.deepEqual(codes(error.gaps), ['checks_unconfirmed', 'then_unbound']);
    assert.deepEqual(error.gaps[1], unbound);
    return true;
  });
  const check = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(check.status, 'blocked');
  assert.deepEqual(codes(check.gaps), ['checks_unconfirmed', 'then_unbound']);
  assert.deepEqual(check.gaps[1], unbound);
  assert.deepEqual([check.next.action, check.next.route], ['repair_inputs', 'write-eval']);
  assert.ok(check.warnings.includes(legacyWarning([SUCCESS])), JSON.stringify(check.warnings));
  // Both packages are named once both are in 1.0.
  editChecks(repo, FAILURE, toLegacy);
  assert.deepEqual(checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((gap) => gap.code === 'then_unbound').cases, [FAILURE, SUCCESS]);
});

const NO_GATING = 'No package of this change has a gating check: every THEN line is in scenario.manual, for the user to judge. A run passes only on gating checks, so no run of this change can pass and no loop on it can be accepted.';
const NO_GATING_REPAIR = 'A line a program can judge needs a gating check, written with write-eval; otherwise the user judges the change without a loop.';

// Leaves every THEN line of every package to the user: no check, no fixture,
// and a verifier that checks nothing.
function leaveEveryLineToTheUser(repo, root) {
  for (const id of [FAILURE, SUCCESS]) {
    editChecks(repo, id, (declared) => ({ ...declared, checks: [], fixtures: [],
      scenario: { ...declared.scenario, manual: declared.checks.map((check) => ({ then: check.then, reason: 'synthetic: a person reads it' })) } }));
    writeFileSync(path.join(root, 'evals', id, 'tests/test.sh'), '#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\nfinish\n', { mode: 0o755 });
  }
}

test('loop start refuses a change whose every THEN line the user judges, since no run of it can pass, and workflow check loop-and-implement says so', (t) => {
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
  const expected = [{ code: 'gating_missing', kind: 'business', owner: 'user', route: 'write-eval',
    message: `${NO_GATING} A loop does not start on it. Tell the user. ${NO_GATING_REPAIR}` }];
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    assert.deepEqual(error.gaps, expected);
    return true;
  });
  const check = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(check.status, 'blocked');
  assert.deepEqual(check.gaps, expected);
  assert.deepEqual([check.next.owner, check.next.action, check.next.route], ['user', 'resolve_business_decisions', 'write-eval']);
  // One gating check is enough for a loop to start.
  editChecks(repo, FAILURE, (declared) => ({ ...declared, scenario: { ...declared.scenario, manual: [] },
    checks: [{ id: 'c1', intent: 'REQ-submit-failure', then: '本次提交发送的成功通知数量为零', expect: '本次提交发送的成功通知数量为零', role: 'gating' }] }));
  assert.ok(!codes(checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps).includes('gating_missing'));
});

test('a running loop whose packages are changed to leave every line to the user ends, and its stop says that no run can pass', (t) => {
  const { repo, root } = inLoop(t);
  leaveEveryLineToTheUser(repo, root);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual(status.stop, { action: 'stop_no_gating', route: 'write-eval', message: `${NO_GATING} Stop and tell the user. ${NO_GATING_REPAIR}` });
  // A loop already running is not refused its inputs: loop status says what to do.
  assert.ok(!codes(checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps).includes('gating_missing'));
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
  refusedBeforeRun(project, {}, 'loop_ended');
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('then_unbound'));
});

test('loop status names the line each check verifies, and asks the user to judge the lines no check verifies at acceptance', (t) => {
  const { repo, root } = withManualLine(t);
  startLoop(repo, CHANGE);
  assert.deepEqual(loopStatus(repo, CHANGE).checks.map((entry) => [entry.case, entry.check, entry.then]), [
    [FAILURE, 'c1', '本次提交发送的成功通知数量为零'], [SUCCESS, 'c1', '本次提交发送的成功通知数量为一']]);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.ok(text.includes(`| ${SUCCESS} | ${LINE_NONE} | synthetic: a person reads it |`), text);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  assert.deepEqual(status.next.manual, [{ case: SUCCESS, then: LINE_NONE, reason: 'synthetic: a person reads it' }]);
  assert.ok(status.next.message.endsWith(` No check verifies "${LINE_NONE}" (${SUCCESS}): show the user what the evaluated agent produced for it, from that case's logs/, and record acceptance only when they say it holds.`), status.next.message);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 7' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
  assert.ok(existsSync(path.join(root, 'accepted.json')));
});

test('a report of a run recorded before compare.json named THEN lines shows a dash and no block of lines the user judges', (t) => {
  const { repo, runs } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  // As an earlier release wrote it.
  const file = path.join(runs, run.run_id, 'compare.json');
  const { manual, ...older } = readJSON(file);
  assert.deepEqual(manual, []);
  writeFileSync(file, `${JSON.stringify({ ...older, results: older.results.map(({ then, ...entry }) => entry) }, null, 2)}\n`);
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| — \| gating \| fail \(0\/1\) → pass \(1\/1\) \| holds \|$/m);
  assert.ok(!text.includes('No check verifies these lines'), text);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance');
  assert.equal(status.next.manual, undefined);
});

test('workflow check run-eval asks for 1.0 packages to be upgraded before the baseline and the loop, and names the lines the user judges', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, FAILURE, toLegacy);
  editChecks(repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: a person reads it' }];
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  commit(repo, 'Keep a 1.0 package and leave a line to the user');
  // The user confirms the checks before the baseline, which needs the upgrade first.
  const before = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(before.status, 'ready', JSON.stringify(before.gaps));
  assert.equal(before.next.action, 'confirm_checks');
  assert.ok(before.next.note.startsWith(UPGRADE_FIRST([FAILURE])), before.next.note);
  assert.ok(before.next.note.endsWith(` No check verifies "${LINE_NONE}" (${SUCCESS}): the user judges it at acceptance. Tell the user before the baseline.`), before.next.note);
  assert.throws(() => confirmChecks({ repo }), (error) => codes(error.gaps).includes('then_unbound'));
  // Once upgraded and confirmed, the baseline comes next, and its note names the line too.
  editChecks(repo, FAILURE, (declared) => ({ ...declared, schema_version: '1.1', checks: declared.checks.map((check) => ({ ...check, then: '本次提交发送的成功通知数量为零' })),
    fixtures: declared.fixtures.map((fixture) => ({ ...fixture, ...(fixture.name.startsWith('review-') ? { origin: 'review' } : {}) })) }));
  assert.equal(checkEval(repo, CHANGE).passed, true);
  confirmChecks({ repo });
  const recorded = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(recorded.next.action, 'record_baseline');
  assert.ok(recorded.next.note.endsWith(` No check verifies "${LINE_NONE}" (${SUCCESS}): the user judges it at acceptance. Tell the user before the baseline.`), recorded.next.note);
});

// The user's checks confirmation: loop start and loop accept hold to it.

const UNCONFIRMED = 'The user has not confirmed the checks of this Spec export. Run `eval review`, have a reviewer answer it in review.json, show the user the review and the run plan, and record their confirmation with `eval confirm` before `loop start`.';

test('loop start refuses checks the user has not confirmed, and workflow check run-eval asks for the confirmation before the baseline', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.deepEqual([check.next.action, check.next.owner, check.next.route], ['confirm_checks', 'user', 'run-eval']);
  assert.deepEqual(check.next.command, ['eval', 'review', CHANGE, '--repo', repo]);
  assert.equal(check.next.note, 'The user confirms the checks once, before the baseline: run `eval review`, have a reviewer write review.json, then show the user the line table, must_decide, the expected baseline results, the number of attempts, the model, the cost and the budget in one message, and record their words with `eval confirm`.');
  // A baseline recorded first still runs; the loop waits for the confirmation.
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'confirm_checks');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('checks_unconfirmed')(error);
    assert.deepEqual(codes(error.gaps), ['checks_unconfirmed']);
    const entry = gapOf(error, 'checks_unconfirmed');
    assert.deepEqual([entry.kind, entry.owner, entry.route, entry.message], ['business', 'user', 'run-eval', UNCONFIRMED]);
    return true;
  });
  assert.deepEqual(codes(checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps), ['checks_unconfirmed']);
  const { confirmation } = confirmChecks(project);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.loop.checks_confirmation, { id: confirmation.id, at: confirmation.confirmed.at });
  assert.equal(started.loop.budget_source, 'confirmation');
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.confirmation, { id: confirmation.id, at: confirmation.confirmed.at, by: 'Test User', kind: 'initial', current: true, unconfirmed: [] });
  assert.deepEqual(status.loop.checks_confirmation, started.loop.checks_confirmation);
});

test('a package changed inside a loop ends it, and a new loop waits for the user\'s confirmation of it and a baseline that ran it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.packages, status.ended.files], [[SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('checks_unconfirmed')(error);
    blockedWith('baseline_packages_differ')(error);
    assert.equal(gapOf(error, 'checks_unconfirmed').message, `${SUCCESS} changed since the user confirmed the checks (${SUCCESS}/environment/Dockerfile). A loop compares with the checks the user confirmed. Run \`eval review\`: the reviewer checks the diff and says whether it loosens a THEN line; then show the user and record \`eval confirm --reason\`.`);
    assert.deepEqual(gapOf(error, 'checks_unconfirmed').cases, [SUCCESS]);
    return true;
  });
  const revision = confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  assert.equal(revision.confirmation.confirmed.kind, 'revision');
  // The user's confirmation of the changed package differs from the loop's own.
  assert.ok(revision.next.startsWith('The loop for this Spec has ended (confirmation_changed). The checks are confirmed. Record the baseline next'), revision.next);
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const next = startLoop(repo, CHANGE);
  assert.equal(next.loop.checks_confirmation.id, revision.confirmation.id);
  assert.equal(next.earlier_loops.loops.length, 1);
});

test('loop start refuses a baseline that ran another plan than the user confirmed', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, model: 'synthetic/model-a', attempts: 1, expect: writeExpectations(repo, EXPECT) });
  const { confirmation } = confirmChecks(project, { model: 'synthetic/model-b', attempts: 1 });
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_plan_differs')(error);
    const entry = gapOf(error, 'baseline_plan_differs');
    assert.deepEqual([entry.owner, entry.route], ['agent', 'run-eval']);
    assert.equal(entry.message, `The baseline ${base.run_id} ran with model synthetic/model-a but the user confirmed 1 attempt, agent ${AGENT}, model synthetic/model-b (${confirmation.confirmed.at}). Record the baseline again on the code before the change, without --attempts, --agent and --model: \`run start --baseline\` reads the confirmed plan from confirmed.json, or the user confirms another plan.`);
    return true;
  });
  // workflow check run-eval asks for the same baseline again, never for loop start.
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check.next));
  assert.ok(check.next.note.startsWith(`The baseline ${base.run_id} ran with model synthetic/model-a but the user confirmed`), check.next.note);
  assert.deepEqual(check.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', path.join(project.root, 'baseline-expectations.json')]);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.run_plan.model, 'synthetic/model-b');
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('loop start takes the budget the user confirmed, unless flags give another, which it records beside the confirmed one', (t) => {
  // Each start is the first loop of a project whose user confirmed 3 runs and 20 minutes.
  const fresh = () => {
    const project = readyProject(t, { confirm: false });
    confirmChecks(project, { iterations: 3, minutes: 20 });
    startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
    return project;
  };
  const started = startLoop(fresh().repo, CHANGE);
  assert.deepEqual(started.loop.budget, { iterations: 3, minutes: 20 });
  assert.equal(started.loop.budget_source, 'confirmation');
  assert.equal(started.loop.confirmed_budget, undefined);
  assert.deepEqual(started.warnings, []);
  const flagged = startLoop(fresh().repo, CHANGE, { iterations: 4, minutes: 30 });
  assert.deepEqual(flagged.loop.budget, { iterations: 4, minutes: 30 });
  assert.equal(flagged.loop.budget_source, 'loop_start');
  assert.deepEqual(flagged.loop.confirmed_budget, { iterations: 3, minutes: 20 });
  assert.deepEqual(flagged.warnings, ['This budget, 4 full runs and 30 minutes, is more than the user confirmed with the checks: 3 full runs and 20 minutes in confirmed.json. Go on only if the user agreed to it, and say so in the next report.']);
  // One flag takes the other value from the confirmation.
  assert.deepEqual(startLoop(fresh().repo, CHANGE, { iterations: 2 }).loop.budget, { iterations: 2, minutes: 20 });
});

test('loop start refuses a confirmed budget the baseline\'s attempts show cannot fit, until flags give one', (t) => {
  const project = withBaseline(t);
  const { repo, base, runs } = project;
  // Each package made one attempt of 15 minutes: a full run takes 30.
  for (const id of [FAILURE, SUCCESS]) timeAttempts(path.join(runs, base.run_id, id, 'attempts.json'), 15 * 60);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('budget_unfit')(error);
    const entry = gapOf(error, 'budget_unfit');
    assert.deepEqual([entry.kind, entry.owner, entry.route], ['business', 'user', 'loop-and-implement']);
    assert.equal(entry.message, `The confirmed budget is 5 full runs and 60 minutes, but 5 runs of about 30 minutes each need about 150 minutes (by the attempts of the baseline ${base.run_id}). Ask the user for a budget that fits, or fewer runs, and pass it: \`loop start --max-iterations N --max-minutes M\`.`);
    return true;
  });
  const started = startLoop(repo, CHANGE, { iterations: 2, minutes: 60 });
  assert.deepEqual([started.loop.budget, started.loop.budget_source], [{ iterations: 2, minutes: 60 }, 'loop_start']);

  // A baseline that ran nothing has no run time to go by; the fixtures of
  // eval check, a second each, fit the budget.
  const empty = readyProject(t, { mode: 'new', results: {} });
  const unavailable = startRun(empty.repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const other = path.join(empty.runs, unavailable.run_id, 'run.json');
  const kept = readJSON(other);
  kept.started_at = new Date(Date.parse(kept.finished_at) - 30 * 60_000).toISOString();
  writeFileSync(other, `${JSON.stringify(kept, null, 2)}\n`);
  assert.deepEqual(startLoop(empty.repo, CHANGE).loop.budget, { iterations: 5, minutes: 60 });
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
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
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
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('packages_unconfirmed')(error);
    assert.equal(gapOf(error, 'packages_unconfirmed').message, `The eval packages of ${run.run_id} differ from the latest checks confirmation (none): no checks confirmation of this Spec export covers ${FAILURE}, ${SUCCESS}. The user accepts only packages they confirmed: they confirm these with \`eval review\` and \`eval confirm\`, which ends this loop when the packages or the plan differ from its own.`);
    return true;
  });
});

test('once the Spec is exported again, loop status ends the loop and reports the confirmation it started on, with no revision', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  exportRevision(project);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.confirmation.id, project.confirmation.confirmation.id);
  assert.equal(status.confirmation.current, false);
  assert.equal(status.next.revision, undefined);
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
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.next.self_review, [{ package: FAILURE, then: '本次提交发送的成功通知数量为零' }]);
  assert.ok(status.next.message.includes(` Only a self-review counterexample stands behind: "本次提交发送的成功通知数量为零" (${FAILURE}); say so.`), status.next.message);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual(accepted.self_review_lines, [{ package: FAILURE, then: '本次提交发送的成功通知数量为零' }]);
  assert.equal(accepted.checks_confirmation.review_origin, 'self-review');
});

test('workflow notes send write-eval to eval review and take the loop budget from confirmed.json', (t) => {
  const { repo } = withBaseline(t);
  assert.ok(checkWorkflow(repo, 'write-eval', CHANGE).next.note.endsWith('Once each package is missing only `review`, run `eval review`: a reviewer writes the counterexamples, `eval check` proves them, and the reviewer answers the questions of a second `eval review` into review.json; run-eval then asks the user to confirm.'));
  const loop = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(loop.next.action, 'start_loop');
  assert.equal(loop.next.note, 'The budget comes from confirmed.json. Ask the user again only when `loop start` says budget_unfit. In a loop whose packages vary, each iteration\'s full run is a screen run; the final run comes after the final review.');
  assert.match(checkWorkflow(repo, 'run-eval', CHANGE).next.note, /`loop start` takes the budget the user confirmed with the checks/);
});

test('loop start estimates a screen run from one attempt of each package and the final run from the plan\'s attempts', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, runs } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(base.attempts, { [FAILURE]: 3, [SUCCESS]: 1 });
  // Every attempt of the baseline took 7.5 minutes: a screen run of one
  // attempt each takes about 15, the final run of 3 and 1 about 30.
  for (const id of [FAILURE, SUCCESS]) timeAttempts(path.join(runs, base.run_id, id, 'attempts.json'), 7.5 * 60);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('budget_unfit')(error);
    assert.equal(gapOf(error, 'budget_unfit').message, `The confirmed budget is 5 full runs and 60 minutes, but 4 screen runs of about 15 minutes each and a final run of about 30 minutes need about 90 minutes (by the attempts of the baseline ${base.run_id}). Ask the user for a budget that fits, or fewer runs, and pass it: \`loop start --max-iterations N --max-minutes M\`.`);
    return true;
  });
  assert.deepEqual(startLoop(repo, CHANGE, { iterations: 2, minutes: 60 }).loop.budget, { iterations: 2, minutes: 60 });
});

test('loop status estimates a screen run and the final run from the baseline\'s attempts, with their cost and what the budget has left', (t) => {
  const usage = { cost_usd: 0.05, n_input_tokens: 100, n_output_tokens: 20 };
  const timed = (results) => ({ [FAILURE]: { ...results[FAILURE], $seconds: 30, $usage: usage }, [SUCCESS]: { ...results[SUCCESS], $seconds: 6 } });
  const project = readyProject(t, { live: [FAILURE], attempts: 3, results: timed(BEFORE) });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  let status = loopStatus(repo, CHANGE);
  // FAILURE's attempts took 30 seconds and cost $0.05 each, SUCCESS's 6 seconds.
  assert.deepEqual(status.loop.estimate, { basis: 'baseline_attempts',
    per_attempt: { [FAILURE]: { minutes: 0.5, cost_usd: 0.05, basis: 'baseline_attempts' }, [SUCCESS]: { minutes: 0.1, cost_usd: null, basis: 'baseline_attempts' } },
    screen: { minutes: 0.6, cost_usd: 0.05 }, final: { minutes: 1.6, cost_usd: 0.15 }, full: { minutes: 1.6, cost_usd: 0.15 },
    remaining: { runs: 5, minutes: 60 } });
  assert.deepEqual(status.loop.usage, { runs: 0, minutes: null, attempts: 0, reported: 0, cost_usd: null, n_input_tokens: null, n_cache_tokens: null, n_output_tokens: null });

  // A partial run counts toward the loop's usage too.
  const partial = startRun(repo, CHANGE, { case: [SUCCESS] });
  const screen = passingScreen(project, timed(AFTER));
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_run', JSON.stringify(status.next));
  assert.equal(status.next.message, FINAL_RUN(screen.run_id, base.run_id).replace(FINAL_COST(base.run_id), () => FINAL_COST(base.run_id, 'about 1.6 minutes, and about $0.15 in model calls')));
  assert.equal(status.loop.estimate.remaining.runs, 4);
  const final = startRun(repo, CHANGE);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
  completeReport(repo, final.run_id, { review: false });

  // A run recorded before runs kept their usage is read from its attempts.
  const file = path.join(project.runs, partial.run_id, 'run.json');
  const { usage: dropped, ...older } = readJSON(file);
  assert.equal(dropped.attempts, 1);
  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
  const used = status.loop.usage;
  // The screen run made 2 attempts and the final run 4; FAILURE's 4 reported.
  assert.deepEqual({ ...used, minutes: null }, { runs: 3, minutes: null, attempts: 7, reported: 4, cost_usd: 0.2, n_input_tokens: 400, n_cache_tokens: null, n_output_tokens: 80 });
  assert.ok(Number.isFinite(used.minutes), JSON.stringify(used));
  assert.ok(status.next.message.includes(`${STRENGTH_3} The loop used ${used.minutes} minutes, $0.20 and 480 tokens as the adapter reported them over 3 runs. Record acceptance only with their own words`), status.next.message);
  const { accepted } = acceptLoop(repo, CHANGE, { run: final.run_id, by: 'Dana', ref: 'thread 1' });
  assert.deepEqual(accepted.usage, used);
});

test('without the baseline\'s attempt times loop start estimates from the last eval check, and without those from the baseline\'s whole run', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, root, runs } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // Every fixture of eval check took 10 minutes; the baseline's attempts a second.
  const fixtures = (id) => readdirSync(path.join(root, 'checks', id), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, 'checks', id, entry.name, 'attempts.json'));
  for (const file of [...fixtures(FAILURE), ...fixtures(SUCCESS)]) timeAttempts(file, 10 * 60);
  startLoop(repo, CHANGE);
  assert.equal(loopStatus(repo, CHANGE).loop.estimate.basis, 'baseline_attempts');
  // That loop ends on budget; each start below would be a new loop.
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(61); });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_budget');
  const unfit = (basis) => (error) => {
    blockedWith('budget_unfit')(error);
    assert.ok(gapOf(error, 'budget_unfit').message.includes(` (${basis}). Ask the user`), gapOf(error, 'budget_unfit').message);
    assert.ok(gapOf(error, 'budget_unfit').message.endsWith('pass it: `loop start --max-iterations N --max-minutes M`.'), gapOf(error, 'budget_unfit').message);
    return true;
  };
  // One package without the baseline's attempt times takes those of eval check.
  rmSync(path.join(runs, base.run_id, FAILURE, 'attempts.json'));
  assert.throws(() => startLoop(repo, CHANGE), unfit(`by the attempts of the baseline ${base.run_id} and, for ${FAILURE}, of the last eval check`));
  rmSync(path.join(runs, base.run_id, SUCCESS, 'attempts.json'));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    unfit('by the attempts of the last eval check')(error);
    assert.ok(gapOf(error, 'budget_unfit').message.includes('but 4 screen runs of about 20 minutes each and a final run of about 40 minutes need about 120 minutes'), gapOf(error, 'budget_unfit').message);
    return true;
  });
  // Without any attempt times, the baseline's whole run is scaled.
  for (const file of fixtures(FAILURE)) rmSync(file);
  const record = path.join(runs, base.run_id, 'run.json');
  const kept = readJSON(record);
  kept.started_at = new Date(Date.parse(kept.finished_at) - 30 * 60_000).toISOString();
  writeFileSync(record, `${JSON.stringify(kept, null, 2)}\n`);
  assert.throws(() => startLoop(repo, CHANGE), unfit(`by the whole run of the baseline ${base.run_id}, 30 minutes`));
  startLoop(repo, CHANGE, { iterations: 2, minutes: 60 });
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
    .map((entry) => path.join(root, 'checks', id, entry.name, 'attempts.json'));
  for (const file of fixtures(FAILURE)) timeAttempts(file, 5 * 60);
  for (const file of fixtures(SUCCESS)) timeAttempts(file, 60);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.is_baseline, base.run_plan.attempts], [false, 3]);
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.loop.budget, { iterations: 5, minutes: 60 });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.final.needed, true);
  assert.deepEqual([status.loop.estimate.basis, status.loop.estimate.screen.minutes, status.loop.estimate.final.minutes], ['eval_check', 6, 16]);
  // One full run leaves no room for the final run here either, in a new loop once that one ended.
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(61); });
  const short = startLoop(repo, CHANGE, { iterations: 1, minutes: 60 });
  assert.ok(short.warnings.some((warning) => warning.startsWith('A budget of 1 full run leaves no room for a final run')), JSON.stringify(short.warnings));
});

test('a head run made while loop.json was away joins no loop, and a run of another plan than the loop\'s is not accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  assert.equal(fullRun(repo).verdict, 'fail');
  // Inside the loop another model is refused.
  assert.throws(() => startRun(repo, CHANGE, { model: 'synthetic/lenient' }), refusedWith('run_plan_fixed'));
  // The same code passes with another model, in a run made while loop.json is away.
  setResults(repo, AFTER);
  const away = `${loopPath(project)}.away`;
  renameSync(loopPath(project), away);
  const other = startRun(repo, CHANGE, { model: 'synthetic/lenient' });
  renameSync(away, loopPath(project));
  assert.equal(other.verdict, 'pass');
  assert.equal(readRecord(other).run.loop, null);
  assert.ok(!loopStatus(repo, CHANGE).runs.some((run) => run.run_id === other.run_id));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: other.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('run_unknown'));
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
  assert.deepEqual(readRecord(run).run.loop, { started_at: loop.started_at, baseline: loop.baseline, start_code: loop.start_code });
  completeReport(repo, run.run_id);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  // The acceptance records the agent and the model the run ran with.
  const ran = readRecord(run).run.environment_ref;
  assert.deepEqual([accepted.run_plan.agent, accepted.run_plan.model], [ran.agent, ran.model]);
});
