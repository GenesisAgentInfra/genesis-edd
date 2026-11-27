// Loop tests: a new loop after one ended or stopped. It keeps the start code
// of the change's first unaccepted loop, reports what the earlier loops used,
// takes the budget it is given, and the failures of the same code still count.
import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, startLoop } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import { reviewEval } from '../src/confirm.js';
import { AFTER, BEFORE, CHANGE, cli, confirmChecks, connect, git, readyProject, setResults, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, assertStopBudget, changePackage, finalsLoop, passingScreen, loopPath,
  refusedBeforeRun, assertEnded, blockedWith, refusedWith, editLoop, minutesAgo, near, restoreStart,
} from './helpers/loop.js';

// A loop of the given budget that ends on budget after one failing full run.
function endedOnBudget(t) {
  const project = inLoop(t, { iterations: 1 });
  changeCode(project.repo, BEFORE, 'A first try that changes nothing');
  completeReport(project.repo, fullRun(project.repo).run_id);
  assertStopBudget(loopStatus(project.repo, CHANGE).next, project.repo, 'budget_used_up');
  return project;
}

test('loop start refuses a second loop while one runs and after its loop was accepted, and starts one after a stop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('loop_running'));
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('loop_accepted')(error);
    assert.equal(error.gaps.find((entry) => entry.code === 'loop_accepted').message, `The user accepted run ${run.run_id} of the loop for this Spec export. A new loop for this change follows a new Spec export.`);
    return true;
  });

  const stopped = endedOnBudget(t);
  const next = startLoop(stopped.repo, CHANGE).loop;
  assert.equal(next.previous.length, 1);
});

test('a new loop reports what the earlier loops used and takes the budget it is given', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'second attempt');
  completeReport(repo, fullRun(repo).run_id);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'budget_used_up');
  const started = startLoop(repo, CHANGE, { iterations: 4 });
  const [earlier] = started.earlier_loops.loops;
  assert.equal(started.earlier_loops.loops.length, 1);
  assert.deepEqual([earlier.started_at, earlier.spec, earlier.accepted, earlier.iterations], [project.loop.started_at, project.loop.spec, false, 2]);
  assert.ok(typeof earlier.minutes === 'number', JSON.stringify(earlier));
  assert.equal(earlier.cost_usd, null);
  assert.deepEqual([started.earlier_loops.total.loops, started.earlier_loops.total.iterations], [1, 2]);
  assert.equal(started.loop.budget.iterations, 4);
  assert.ok(started.warnings.some((warning) => warning.startsWith('Earlier loops of this change (1) used 2 full runs, ')
    && warning.endsWith('This loop\'s budget is the one loop start was given (4 runs, 60 minutes); tell the user what the earlier loops used.')), JSON.stringify(started.warnings));
  assert.deepEqual(loopStatus(repo, CHANGE).runs, []);
});

test('until a loop is accepted, a new loop refuses a baseline on other code than the start code it keeps', (t) => {
  const project = endedOnBudget(t);
  const { repo, root } = project;
  // A base record on the changed code, as one made while neither loop.json
  // nor a head run of the loop was there to name its start code.
  const away = path.join(root, 'loop.away.json');
  const [head] = loopStatus(repo, CHANGE).runs;
  const headAway = path.join(root, `${head.run_id}.away`);
  renameSync(loopPath(project), away);
  renameSync(path.join(project.runs, head.run_id), headAway);
  const other = startRun(repo, CHANGE, { baseline: true, unavailable: 'execution_blocked' });
  renameSync(away, loopPath(project));
  renameSync(headAway, path.join(project.runs, head.run_id));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    assert.equal(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').message, `Until a loop of this change is accepted, every new loop keeps the start code of the change's first unaccepted loop, commit ${project.loop.start_code.commit}. The baseline ${other.run_id} ran on other code. Set your changes aside, restore that code, record the baseline there, bring your changes back, then run \`loop start\` again.`);
    return true;
  });
});

test('failed final runs stop only their own loop, while the code that failed in an earlier loop stays burned', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const varies = (results) => ({ ...AFTER, [FAILURE]: { c1: results } });
  passingScreen(project, varies(['pass', 'fail', 'pass']), 'Try a change whose result varies');
  const first = startRun(repo, CHANGE);
  completeReport(repo, first.run_id);
  passingScreen(project, varies(['pass', 'pass', 'fail']), 'Try another change whose result varies');
  const second = startRun(repo, CHANGE);
  completeReport(repo, second.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_unstable');
  // In a new loop, one failed final run means changing the code again.
  startLoop(repo, CHANGE);
  passingScreen(project, varies(['pass', 'fail', 'fail']), 'A third change whose result varies');
  const third = startRun(repo, CHANGE);
  assert.deepEqual([third.role, third.verdict], ['final', 'fail']);
  completeReport(repo, third.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.deepEqual(status.final.failed, [third.run_id]);
  assert.match(status.next.message, /one more failed final run of this loop stops it \(stop_unstable\)/);
  // The code of the first failed final run still cannot reach a final run.
  changeCode(repo, AFTER, 'Try a change whose result varies');
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  completeReport(repo, again.run_id, { review: false });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
  assert.ok(status.next.message.startsWith(`Screen run ${again.run_id} passed, but its code failed ${FAILURE}/c1 in ${first.run_id}.`), status.next.message);
});

test('in a new project, connecting the packages ends the first loop, and after the user\'s confirmation and the baseline again a new loop runs them', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const first = startLoop(repo, CHANGE).loop;
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  changeCode(repo, AFTER, 'The first implementation');
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  // What follows: eval check, eval review, the user's confirmation, the baseline again on the start code.
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.ok(reviewEval(repo, CHANGE).must_decide.some((entry) => entry.code === 'changed_since_confirmation'));
  confirmChecks(project, { reason: 'The packages are connected.' });
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check.next));
  assert.deepEqual(check.next.command.slice(-3), ['--baseline', '--unavailable', 'no_implementation']);
  git(repo, ['checkout', '-q', 'HEAD~1', '--', 'app']);
  rmSync(path.join(repo, 'app/handler.txt'), { force: true });
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  git(repo, ['checkout', '-q', 'HEAD', '--', 'app']);
  assert.notEqual(again.run_id, base.run_id);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  const loop = startLoop(repo, CHANGE).loop;
  assert.deepEqual([loop.baseline, loop.start_code], [again.run_id, first.start_code]);
  const run = fullRun(repo);
  assert.deepEqual(run.cases.map((item) => item.id), [FAILURE, SUCCESS]);
  assert.equal(run.verdict, 'pass');
});

test('after a loop ended, workflow check names no head run, and each step it names asks for the user\'s go-ahead', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changePackage(project, SUCCESS);
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  assert.equal(checkWorkflow(repo, 'loop-and-implement', CHANGE).next.action, 'loop_status');
  const steps = [];
  const look = () => {
    const { next } = checkWorkflow(repo, 'run-eval', CHANGE);
    assert.notEqual(next.action, 'run_eval', JSON.stringify(next));
    assert.match(next.note, /start a new loop only once the user agrees/);
    steps.push(next.action);
  };
  look();
  confirmChecks(project, { reason: 'The Dockerfile of submit-success-s1 gained a build step.' });
  look();
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  look();
  assert.deepEqual(steps, ['confirm_checks', 'record_baseline', 'start_loop']);
  setResults(repo, AFTER);
  refusedBeforeRun(project, {}, 'loop_ended');
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
    assert.match(error.gaps[0].message, new RegExp(`loop\\.json is missing or cannot be read, so this comes from the head runs of the loop that started at ${project.loop.started_at} \\(`));
    return true;
  });
  // A new loop keeps that start code too, and says what was lost with loop.json.
  const started = startLoop(repo, CHANGE, { iterations: 3 });
  assert.deepEqual(started.loop.start_code, project.loop.start_code);
  assert.deepEqual(started.loop.previous.map((entry) => entry.started_at), [project.loop.started_at]);
  assert.equal(started.earlier_loops.loops[0].iterations, 1);
  assert.ok(started.warnings.some((warning) => warning.startsWith(`loop.json is missing or cannot be read. The loop that started at ${project.loop.started_at} is known from its head runs only`)), JSON.stringify(started.warnings));
});

test('a new loop after a stop that left only the final run runs the same code again, unchanged, from a screen run', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 20 });
  // FAILURE's attempts take 10 minutes each, so a final run takes about 30.
  const screen = passingScreen(project, { ...AFTER, [FAILURE]: { c1: 'pass', $seconds: 600 } });
  const stopped = loopStatus(repo, CHANGE).next;
  assertStopBudget(stopped, repo, 'final_run_does_not_fit');
  assert.match(stopped.message, /A new loop counts only its own runs, so it screens and reviews this code again before its final run/);
  startLoop(repo, CHANGE, { iterations: 5, minutes: 120 });
  const { next } = loopStatus(repo, CHANGE);
  assert.deepEqual([next.action, next.command, next.passed_before], ['iterate', ['run', 'start', CHANGE, '--repo', repo], screen.run_id], JSON.stringify(next));
  assert.equal(next.message, `The code as it is now passed run ${screen.run_id} (a screen run) in an earlier loop of this change, with these packages, and no run of it failed. This loop counts only its own runs, so run it again with \`run start\`, without changing it: a screen run, whose report and final review come before the final run.`);
  const again = fullRun(repo);
  assert.deepEqual([again.role, again.verdict], ['screen', 'pass']);
  completeReport(repo, again.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_run');
});

test('a new loop with another model does not take the earlier pass of the same code as its starting point', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE, { iterations: 5, minutes: 20 });
  const results = { ...AFTER, [FAILURE]: { c1: 'pass', $seconds: 600 } };
  const label = 'Stop the success notice when a submission fails';
  const screen = passingScreen(project, results, label);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'final_run_does_not_fit');
  // The user picks another model: the baseline is recorded again on the start code, and the code comes back.
  confirmChecks(project, { model: 'synthetic/m9', attempts: 3, reason: 'The user chose another model.' });
  restoreStart(project);
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  changeCode(repo, results, label);
  startLoop(repo, CHANGE, { iterations: 5, minutes: 120 });
  const { next } = loopStatus(repo, CHANGE);
  assert.equal(next.action, 'iterate', JSON.stringify(next));
  assert.equal(next.passed_before, undefined, `${screen.run_id} ran another model: ${JSON.stringify(next)}`);
});

test('loop start reports the minutes an earlier loop used of its budget, as its own stop counted them', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  completeReport(repo, fullRun(repo).run_id);
  // The agent worked for 70 minutes of the loop's 60.
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(70); });
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status.next, repo, 'budget_used_up');
  near(status.loop.used.minutes, 70);
  const started = startLoop(repo, CHANGE, { minutes: 120 });
  const [earlier] = started.earlier_loops.loops;
  near(earlier.minutes, 70);
  assert.equal(earlier.budget.minutes, 60);
  assert.equal(typeof earlier.run_minutes, 'number');
  const warning = started.warnings.find((entry) => entry.startsWith('Earlier loops of this change'));
  assert.match(warning, /^Earlier loops of this change \(1\) used 1 full run, (69|70|71) minutes of their budget, counted as a budget counts them, from each loop's start until the next one started or the user accepted it \(their runs took [\d.]+ minutes\)\./);
});

// A new project through its second loop: the packages connected, confirmed,
// the unavailable baseline recorded again on the start code, a new loop.
function secondNewProjectLoop(t) {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project);
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  confirmChecks(project, { reason: 'The packages are connected.' });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const { loop } = startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'The first implementation');
  return { ...project, loop };
}

test('in the second loop of a new project, a package fix ends the loop as a package fix, not as the connection of the packages', (t) => {
  const project = secondNewProjectLoop(t);
  const { repo } = project;
  assert.notEqual(loopStatus(repo, CHANGE).next.action, 'loop_ended');
  changePackage(project, SUCCESS);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.doesNotMatch(status.next.message, /this end is the expected step once the packages are connected/);
  assert.ok(status.next.message.includes(`A new loop, once the user agrees, needs a baseline of those packages on the loop's start code. What follows: \`eval check\` proves the changed packages; \`eval review\` gives the reviewer's brief and questions, and the reviewer writes the answers, and any counterexample a line lacks, into review.json; the user confirms the packages with \`eval confirm --reason\`; the baseline is recorded again on the loop's start code (commit ${project.loop.start_code.commit}) with \`run start --baseline --unavailable no_implementation\`; then a new loop starts with \`loop start\` once the user agrees.`), status.next.message);
});

test('in the first loop of a new project, workflow check run-eval names loop status, as no package is connected yet', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project);
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.deepEqual([check.next.action, check.next.command], ['loop_status', ['loop', 'status', CHANGE, '--repo', repo]]);
  assert.equal(check.next.note, 'No package is connected yet, so `run start` has nothing to run: `loop status` says what comes first (iterate).');
});
