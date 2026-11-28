// Loop tests: a new loop after one ended or stopped. It keeps the start code
// of the change's first unaccepted loop, reports what the earlier loops used,
// takes the budget it is given, and the failures of the same code still count.
// Every new loop is the user's decision.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, startLoop as startLoopBare } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { reviewEval } from '../src/confirm.js';
import { AFTER, BEFORE, CHANGE, actionOf, assertGapShape, cli, confirmChecks, connect, readyProject, setResults, startLoop, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, inLoop, changeCode, fullRun, FAILURE, SUCCESS, assertStopBudget, assertFinalDue, changePackage, finalsLoop, passingScreen, loopPath,
  refusedBeforeRun, assertEnded, blockedWith, refusedWith, editLoop, gapOf, minutesAgo, near, restoreStart, reviewRun,
} from './helpers/loop.js';

// A loop of one full run that ends on its budget after one failing run.
function endedOnBudget(t) {
  const project = inLoop(t, { iterations: 1 });
  changeCode(project.repo, BEFORE, 'A first try that changes nothing');
  fullRun(project.repo);
  assertStopBudget(loopStatus(project.repo, CHANGE), 'budget_used_up');
  return project;
}

// The head run among the actions of a workflow status: run start without
// --baseline or --trial.
const headRunAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && !entry.command.includes('--baseline') && !entry.command.includes('--trial'));

test('loop start refuses a second loop while one runs, starts one after a stop, and after an acceptance starts one for the same export only with the user\'s consent', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('loop_running'));
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  // A fix after an acceptance may go to a new loop of the same export, once
  // the user agrees: that loop follows the accepted one.
  assert.throws(() => startLoopBare(repo, CHANGE), (error) => {
    blockedWith('loop_consent_missing')(error);
    assertGapShape(gapOf(error, 'loop_consent_missing'), { owner: 'user', layer: 'loop', loop_started_since: true });
    return true;
  });
  const after = startLoop(repo, CHANGE).loop;
  assert.deepEqual(after.follows, { loop_started_at: project.loop.started_at, run_id: run.run_id, spec: project.loop.spec });
  // The accepted loop released the start code it pinned.
  assert.equal(after.start_from, 'baseline');
  assert.equal(loopStatus(repo, CHANGE).situation.passed_before, run.run_id);

  const stopped = endedOnBudget(t);
  const next = startLoop(stopped.repo, CHANGE).loop;
  assert.equal(next.previous.length, 1);
  assert.equal(next.start_from, 'pinned');
  assert.deepEqual(next.start_code, stopped.loop.start_code);
});

test('a new loop reports what the earlier loops used and takes the budget it is given', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  fullRun(repo);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'second attempt');
  fullRun(repo);
  assertStopBudget(loopStatus(repo, CHANGE), 'budget_used_up');
  const started = startLoop(repo, CHANGE, { iterations: 4 });
  const [earlier] = started.earlier_loops.loops;
  assert.equal(started.earlier_loops.loops.length, 1);
  assert.deepEqual([earlier.started_at, earlier.spec, earlier.accepted, earlier.iterations], [project.loop.started_at, project.loop.spec, false, 2]);
  assert.ok(typeof earlier.minutes === 'number' && typeof earlier.run_minutes === 'number', JSON.stringify(earlier));
  assert.equal(earlier.cost_usd, null);
  assert.deepEqual(earlier.budget, { iterations: 2, minutes: null, run_minutes: 30 });
  assert.deepEqual([started.earlier_loops.total.loops, started.earlier_loops.total.iterations], [1, 2]);
  assert.deepEqual(started.loop.budget, { iterations: 4, minutes: null, run_minutes: 30 });
  assert.ok(started.warnings.some((warning) => warning.startsWith('Earlier loops of this change (1) used 2 full runs; with the runs outside a loop, ')
    && warning.endsWith('This loop\'s budget is its own (4 full runs and 30 run minutes).')), JSON.stringify(started.warnings));
  assert.deepEqual(loopStatus(repo, CHANGE).runs, []);
});

test('until a loop is accepted, every base record goes on its start code, and a new loop refuses a baseline that ran elsewhere', (t) => {
  const project = endedOnBudget(t);
  const { repo, root } = project;
  const [head] = loopStatus(repo, CHANGE).runs;
  const moved = (entries, back = false) => { for (const [from, to] of entries) renameSync(back ? to : from, back ? from : to); };
  // With loop.json and the loop's head run moved away, the run index still
  // names that loop and its start code.
  const records = [[loopPath(project), path.join(root, 'loop.away.json')], [path.join(project.runs, head.run_id), path.join(root, `${head.run_id}.away`)]];
  moved(records);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) }), (error) => {
    refusedWith('baseline_after_change')(error);
    assert.match(gapOf(error, 'baseline_after_change').message, /loop\.json is missing or cannot be read, so this comes from the head runs of the loop that started at/);
    return true;
  });
  // With the run index moved away too, a base record of the changed code
  // gets written; loop start still refuses it.
  const index = path.join(project.runs, 'index.jsonl');
  const all = [...records, [index, path.join(root, 'index.away.jsonl')]];
  moved([all[2]]);
  const other = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(other.is_baseline, true);
  const added = readFileSync(index, 'utf8');
  moved(all, true);
  appendFileSync(index, added);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    const entry = assertGapShape(gapOf(error, 'baseline_not_at_start'), { owner: 'agent', layer: 'baseline', run: other.run_id });
    assert.equal(entry.start_code.digest, project.loop.start_code.digest);
    assert.equal(entry.message, `Until a loop of this change is accepted or the user abandons the change, every new loop keeps the start code of the change's first unaccepted loop (commit ${project.loop.start_code.commit.slice(0, 7)}). The baseline ${other.run_id} ran on other code, so a new loop needs a base record of the start code, which can be rebuilt outside the project (--at-start).`);
    return true;
  });
});

test('failed final runs stop only their own loop, while the code that failed in an earlier loop stays burned', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const varies = (results) => ({ ...AFTER, [FAILURE]: { c1: results } });
  passingScreen(project, varies(['pass', 'fail', 'pass']), 'Try a change whose result varies');
  const first = startRun(repo, CHANGE);
  passingScreen(project, varies(['pass', 'pass', 'fail']), 'Try another change whose result varies');
  const second = startRun(repo, CHANGE);
  assert.deepEqual([first.role, first.verdict, second.role, second.verdict], ['final', 'fail', 'final', 'fail']);
  assertEnded(loopStatus(repo, CHANGE), 'stop_unstable');
  // In a new loop, one failed final run means changing the code again.
  startLoop(repo, CHANGE);
  passingScreen(project, varies(['pass', 'fail', 'fail']), 'A third change whose result varies');
  const third = startRun(repo, CHANGE);
  assert.deepEqual([third.role, third.verdict], ['final', 'fail']);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.run_id], ['live', 'final_failed', third.run_id]);
  assert.deepEqual(status.final.failed, [third.run_id]);
  assert.match(status.situation.message, /one more failed final run of this loop stops it \(stop_unstable\)/);
  // The code of the first failed final run still cannot reach a final run.
  changeCode(repo, AFTER, 'Try a change whose result varies');
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.failures], ['screen_burned', [{ case: FAILURE, check: 'c1', run_id: first.run_id }]]);
  assert.ok(status.situation.message.startsWith(`Screen run ${again.run_id} passed, but its code failed ${FAILURE}/c1 in ${first.run_id}.`), status.situation.message);
  assert.equal(status.final.candidate, null);
});

test('in a new project, connecting the packages ends the first loop, and after the user\'s confirmation a new loop on the start code runs them', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  // The light tier needs a proof for every line, which waits for the packages.
  assert.throws(() => confirmChecks(project), refusedWith('line_unproven'));
  confirmChecks(project, { tier: 'full' });
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const first = startLoop(repo, CHANGE).loop;
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  changeCode(repo, AFTER, 'The first implementation');
  const ended = loopStatus(repo, CHANGE);
  assertEnded(ended, 'packages_changed');
  assert.deepEqual([ended.ended.connecting, ended.ended.packages], [true, [FAILURE, SUCCESS]]);
  assert.ok(ended.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(ended.ended.new_loop));
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.ok(reviewEval(repo, CHANGE).must_decide.some((entry) => entry.code === 'changed_since_confirmation'));
  confirmChecks(project, { tier: 'full', reason: 'The packages are connected.' });
  // The record that nothing could run on the start code stands for the
  // connected packages, and a new one is not made on the implementation.
  const status = workflowStatus(repo, CHANGE);
  assert.deepEqual(actionOf(status, 'run', 'start', '--baseline', '--unavailable').blocked_by, ['baseline_after_change']);
  const start = actionOf(status, 'loop', 'start');
  assert.deepEqual([start.allowed, start.by], [true, 'user']);
  const loop = startLoop(repo, CHANGE).loop;
  assert.deepEqual([loop.baseline, loop.start_code], [base.run_id, first.start_code]);
  const run = fullRun(repo);
  assert.deepEqual(run.cases.map((item) => item.id), [FAILURE, SUCCESS]);
  assert.equal(run.verdict, 'pass');
});

test('after a loop ended, workflow status allows no head run until the user agrees to a new loop, and says whose each step is', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changePackage(project, SUCCESS);
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  const look = () => {
    const status = workflowStatus(repo, CHANGE);
    assert.equal(status.layers.loop.phase, 'ended');
    assertGapShape(status.gaps.find((entry) => entry.code === 'change_locked'), { owner: 'user', layer: 'loop' });
    assert.ok(headRunAction(status).blocked_by.includes('change_locked'), JSON.stringify(headRunAction(status)));
    assert.equal(actionOf(status, 'loop', 'start').by, 'user');
    assert.equal(actionOf(status, 'eval', 'confirm').by, 'user');
    return status;
  };
  let status = look();
  assert.equal(status.layers.loop.change_lock.reason, 'packages_changed');
  assert.deepEqual(actionOf(status, 'loop', 'start').blocked_by, ['baseline_packages_differ', 'checks_unconfirmed']);
  assertGapShape(status.gaps.find((entry) => entry.code === 'checks_unconfirmed'), { owner: 'user', layer: 'confirmation' });
  confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  // The user's new confirmation of other packages is why the loop ended now.
  status = look();
  assert.equal(status.layers.loop.change_lock.reason, 'confirmation_changed');
  assert.deepEqual(actionOf(status, 'loop', 'start').blocked_by, ['baseline_packages_differ']);
  assert.equal(actionOf(status, 'run', 'start', '--baseline').by, 'agent');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  status = look();
  assert.deepEqual([actionOf(status, 'loop', 'start').allowed, status.suggestion.command.slice(0, 2)], [true, ['loop', 'start']]);
  setResults(repo, AFTER);
  refusedBeforeRun(project, {}, 'change_locked');
  // The user's new loop lifts the lock.
  startLoop(repo, CHANGE);
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('loop start takes no --restart and loop extend is no command, and --help names neither', (t) => {
  const { repo } = inLoop(t);
  const restart = cli(['loop', 'start', CHANGE, '--repo', repo, '--restart']);
  assert.equal(restart.status, 1, restart.stdout);
  assert.match(restart.json.error, /--restart/);
  const extend = cli(['loop', 'extend', CHANGE, '--repo', repo]);
  assert.equal(extend.status, 1, extend.stdout);
  assert.match(extend.json.error, /^Unknown command/);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--restart|loop extend/);
});

test('without loop.json, the head runs in runs/ keep the start code: a base record on changed code is refused, and a new loop keeps that code', (t) => {
  const project = endedOnBudget(t);
  const { repo } = project;
  // While loop.json is there, the start code holds.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  rmSync(loopPath(project));
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    refusedWith('baseline_after_change')(error);
    assert.match(gapOf(error, 'baseline_after_change').message, new RegExp(`loop\\.json is missing or cannot be read, so this comes from the head runs of the loop that started at ${project.loop.started_at} \\(`));
    return true;
  });
  // A new loop keeps that start code too, and says what was lost with loop.json.
  const started = startLoop(repo, CHANGE, { iterations: 3 });
  assert.deepEqual(started.loop.start_code, project.loop.start_code);
  assert.deepEqual(started.loop.previous.map((entry) => entry.started_at), [project.loop.started_at]);
  assert.equal(started.earlier_loops.loops[0].iterations, 1);
  assert.ok(started.warnings.some((warning) => warning.startsWith(`loop.json is missing or cannot be read. The loop that started at ${project.loop.started_at} is known from its runs only (`)
    && warning.endsWith('its budget and the loops before it are lost.')), JSON.stringify(started.warnings));
});

test('a new loop after a stop that left only the final run runs the same code again, unchanged, from a screen run', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 20 });
  // FAILURE's attempts take 10 minutes each, so a final run takes about 30.
  const screen = passingScreen(project, { ...AFTER, [FAILURE]: { c1: 'pass', $seconds: 600 } }, undefined, { review: false });
  const stopped = loopStatus(repo, CHANGE);
  assertStopBudget(stopped, 'final_run_does_not_fit');
  assert.deepEqual([stopped.ended.screen_run, stopped.ended.estimate.minutes], [screen.run_id, 30]);
  startLoop(repo, CHANGE, { iterations: 5, minutes: 120 });
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.passed_before, status.suggestion.command], ['open', screen.run_id, ['run', 'start', CHANGE, '--repo', repo]], JSON.stringify(status.situation));
  assert.ok(status.situation.message.startsWith(`The code as it is now passed run ${screen.run_id} outside this loop, with these packages, and no run of it failed; this loop counts only its own runs.`), status.situation.message);
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  assertFinalDue(loopStatus(repo, CHANGE), again.run_id, repo);
});

test('a new loop with another model does not take the earlier pass of the same code as its starting point', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 20 });
  const results = { ...AFTER, [FAILURE]: { c1: 'pass', $seconds: 600 } };
  const label = 'Stop the success notice when a submission fails';
  const screen = passingScreen(project, results, label, { review: false });
  assertStopBudget(loopStatus(repo, CHANGE), 'final_run_does_not_fit');
  // The user picks another model: the baseline is recorded again on the start code, and the code comes back.
  confirmChecks(project, { model: 'synthetic/m9', attempts: 3, reason: 'The user chose another model.' });
  restoreStart(project);
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  changeCode(repo, results, label);
  startLoop(repo, CHANGE, { iterations: 5, minutes: 120 });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'open', JSON.stringify(status.situation));
  assert.equal(status.situation.passed_before, undefined, `${screen.run_id} ran another model: ${JSON.stringify(status.situation)}`);
});

test('a budget counts run minutes, not the time spent waiting, and loop start reports both for an earlier loop', (t) => {
  const project = inLoop(t, { iterations: 1, minutes: 60 });
  const { repo } = project;
  // The user took 70 minutes to answer: the loop's 60 run minutes are not spent.
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(70); });
  let status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 70);
  assert.deepEqual([status.loop.budget, status.loop.exhausted, status.phase], [{ iterations: 1, minutes: null, run_minutes: 60 }, false, 'live']);
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  fullRun(repo);
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.ok(status.loop.used.run_minutes < 60, JSON.stringify(status.loop.used));
  const started = startLoop(repo, CHANGE, { minutes: 120 });
  const [earlier] = started.earlier_loops.loops;
  near(earlier.minutes, 70);
  assert.deepEqual(earlier.budget, { iterations: 1, minutes: null, run_minutes: 60 });
  assert.equal(typeof earlier.run_minutes, 'number');
  const warning = started.warnings.find((entry) => entry.startsWith('Earlier loops of this change'));
  assert.match(warning, /^Earlier loops of this change \(1\) used 1 full run; with the runs outside a loop, [\d.]+ run minutes\. This loop's budget is its own \(5 full runs and 120 run minutes\)\.$/);
});

// A new project through its second loop: the packages connected and
// confirmed, and a new loop on the record that nothing could run on the start
// code, with the first implementation.
function secondNewProjectLoop(t) {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project, { tier: 'full' });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  confirmChecks(project, { tier: 'full', reason: 'The packages are connected.' });
  const { loop } = startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'The first implementation');
  return { ...project, loop };
}

test('in the second loop of a new project, a package fix ends the loop as a package fix, not as the connection of the packages', (t) => {
  const project = secondNewProjectLoop(t);
  const { repo } = project;
  assert.equal(loopStatus(repo, CHANGE).phase, 'live');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual([status.ended.connecting, status.ended.packages, status.ended.files], [false, [SUCCESS], [`${SUCCESS}/environment/Dockerfile`]]);
  assert.doesNotMatch(status.ended.message, /connecting the packages ends it as expected/);
  // The end states facts and what a new loop needs, never a recipe.
  assert.doesNotMatch(status.ended.message, /What follows|then run/);
  assert.deepEqual(status.ended.start_code.digest, project.loop.start_code.digest);
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
});

test('in the first loop of a new project, loop status says no package is connected yet, and workflow status allows no head run until one is', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project, { tier: 'full' });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.no_package_connected, status.situation.pending_packages], ['live', 'open', true, [FAILURE, SUCCESS]]);
  const workflow = workflowStatus(repo, CHANGE);
  assert.equal(workflow.layers.loop.phase, 'live');
  assert.deepEqual(headRunAction(workflow).blocked_by, ['no_runnable_case']);
  refusedBeforeRun(project, {}, 'no_runnable_case');
});

test('in the first loop of a new project, neither loop status nor workflow status suggests a head run that run start refuses', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project, { tier: 'full' });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  const refused = ['run', 'start', CHANGE, '--repo', repo];
  assert.notDeepEqual(loopStatus(repo, CHANGE).suggestion?.command, refused);
  const workflow = workflowStatus(repo, CHANGE);
  assert.notDeepEqual(workflow.suggestion?.command, refused);
  // A suggestion is always one of the actions allowed now.
  if (workflow.suggestion) assert.ok(workflow.actions.some((entry) => entry.allowed && JSON.stringify(entry.command) === JSON.stringify(workflow.suggestion.command)), JSON.stringify(workflow.suggestion));
});
