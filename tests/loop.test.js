// Loop tests: the main path. Starting a loop with the user's consent, what loop
// status reports, the reports head runs write, regressions and stuck loops,
// the budget, the final review and the user's acceptance.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { codeSnapshot, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, reportGaps, writeReport } from '../src/loop.js';
import { readDecisions } from '../src/records.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, CONSENT_FLAGS, REF, USER, actionOf, allowedActions, assertGapShape, assertNoRoutes, assertSuggestion, cli, commit, confirmChecks, git,
  readRecord, readyProject, setResults, startLoop, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, FAILURE, SUCCESS, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord,
  refusedBeforeRun, assertEnded, assertStopBudget, gapOf, reviewRun,
} from './helpers/loop.js';

// The strength sentence of an acceptance in the light tier, fixed by the CLI.
const LIGHT_STRENGTH = 'Light tier: the packages ran with the network sealed, no model was called, and each check ran once. That shows only that code whose result is fixed holds in these scenarios.';
const runCommand = (repo) => ['run', 'start', CHANGE, '--repo', repo];
// The head run among the actions of a workflow status: run start without
// --baseline or --trial.
const headRunAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && !entry.command.includes('--baseline') && !entry.command.includes('--trial'));
// Reads a read-only status through the CLI, which exits 0 whatever the change lacks.
function readStatus(args) {
  const result = cli(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertNoRoutes(result.json);
  return result.json;
}

test('workflow status gives the facts and every allowed action: loop start waits for a baseline, is the user\'s once one is there, and a loop suggests a head run', (t) => {
  const project = readyProject(t);
  const { repo } = project;

  const before = readStatus(['workflow', 'status', CHANGE, '--repo', repo]);
  assert.deepEqual(codes(before.gaps), ['baseline_missing']);
  assertGapShape(before.gaps[0], { code: 'baseline_missing', owner: 'agent', layer: 'baseline' });
  const waiting = actionOf(before, 'loop', 'start');
  assert.deepEqual([waiting.allowed, waiting.by, waiting.blocked_by], [false, 'user', ['baseline_missing']]);
  assert.ok(allowedActions(before).includes('run start --baseline'), JSON.stringify(allowedActions(before)));
  assert.deepEqual(before.suggestion.command, [...runCommand(repo), '--baseline']);

  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  // The stage name of earlier releases is read as the same status.
  const ready = readStatus(['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(ready.stage_ignored, 'loop-and-implement');
  assert.deepEqual(ready.gaps, []);
  const start = actionOf(ready, 'loop', 'start');
  assert.deepEqual([start.allowed, start.by, start.blocked_by], [true, 'user', []]);
  assert.ok(start.command.includes('--by') && start.command.includes('--ref'), JSON.stringify(start.command));
  assert.ok(start.needs.some((entry) => entry.startsWith('user consent')), JSON.stringify(start.needs));
  assertSuggestion(ready, ['loop', 'start', CHANGE, '--repo', repo, '--by']);

  const started = cli(['loop', 'start', CHANGE, '--repo', repo, ...CONSENT_FLAGS]);
  assert.equal(started.status, 0, started.stderr);
  const running = readStatus(['loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(running.layers.loop.phase, 'live');
  // One loop runs at a time, and its baseline stays: neither is offered now.
  assert.equal(actionOf(running, 'loop', 'start'), undefined);
  assert.equal(actionOf(running, 'run', 'start', '--baseline'), undefined);
  assert.deepEqual([headRunAction(running).allowed, headRunAction(running).in_loop, headRunAction(running).spends], [true, true, 'loop_budget']);
  assert.deepEqual(running.suggestion.command, runCommand(repo));
  assert.deepEqual(allowedActions(running), allowedActions(readStatus(['workflow', 'status', CHANGE, '--repo', repo])));
});

test('outside Git the loop cannot start, because every run records its code as a commit plus a patch', (t) => {
  const { repo, root } = withBaseline(t);
  rmSync(path.join(repo, '.git'), { recursive: true, force: true });

  const checked = readStatus(['workflow', 'status', CHANGE, '--repo', repo]);
  assert.equal(checked.layers.machine.git, false);
  assertGapShape(checked.gaps.find((entry) => entry.code === 'git_missing'), { owner: 'user', layer: 'machine' });

  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('git_missing')(error);
    assertGapShape(gapOf(error, 'git_missing'), { owner: 'user', layer: 'machine' });
    return true;
  });
  assert.equal(existsSync(path.join(root, 'loop.json')), false);
});

test('loop start refuses a Spec without a baseline and loop status refuses a change without a loop', (t) => {
  const { repo, root } = readyProject(t);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_missing')(error);
    assertGapShape(gapOf(error, 'baseline_missing'), { owner: 'agent', layer: 'baseline' });
    assertNoRoutes(error.gaps, 'gaps');
    return true;
  });
  // Without --by and --ref the user's consent is missing too.
  const started = cli(['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(started.status, 1, started.stdout);
  assert.equal(started.json.code, 'LOOP_INPUT_BLOCKED');
  assert.ok(codes(started.json.gaps).includes('baseline_missing'), JSON.stringify(started.json.gaps));
  assertGapShape(started.json.gaps.find((entry) => entry.code === 'loop_consent_missing'), { owner: 'user', layer: 'loop' });
  assert.equal(existsSync(path.join(root, 'loop.json')), false);

  assert.throws(() => loopStatus(repo, CHANGE), (error) => {
    blockedWith('loop_missing')(error);
    assertGapShape(gapOf(error, 'loop_missing'), { owner: 'user', layer: 'loop' });
    return true;
  });
  const status = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(status.status, 1, status.stdout);
  assert.deepEqual(codes(status.json.gaps), ['loop_missing']);
});

test('a loop starts on the code its baseline ran on, committed or not, when the working directory moved since, and records which files moved', (t) => {
  for (const committed of [false, true]) {
    const { repo, base } = withBaseline(t);
    const start = git(repo, ['rev-parse', 'HEAD']);
    const ranOn = readRecord(base).run.code_snapshot.digest;
    changeCode(repo, AFTER, 'Implemented before the loop');
    if (!committed) git(repo, ['reset', '-q', '--soft', start]);

    const started = startLoop(repo, CHANGE);
    const { loop } = started;
    assert.deepEqual([loop.baseline, loop.base_commit, loop.start_code.commit, loop.start_code.digest], [base.run_id, start, start, ranOn]);
    assert.deepEqual([loop.start_from, loop.worktree_moved, loop.moved_files], ['baseline', true, ['app/handler.txt', 'app/results.json']]);
    assert.deepEqual([started.worktree_moved, started.moved_files], [true, ['app/handler.txt', 'app/results.json']]);
    assert.ok(started.warnings.some((warning) => warning.startsWith(`The working directory differs from the code the baseline ${base.run_id} ran on in app/handler.txt, app/results.json`)), JSON.stringify(started.warnings));
    // The moved code is part of the loop's change, and the user hears of it.
    const status = loopStatus(repo, CHANGE);
    assert.equal(status.loop.worktree_moved, true);
    assert.ok(status.obligations.some((entry) => entry.kind === 'disclosure' && entry.item === 'worktree_moved'), JSON.stringify(status.obligations));
    // Its first run compares the moved code with the baseline.
    assert.equal(fullRun(repo).verdict, 'pass');
  }
});

test('an unavailable baseline pins the code it was recorded on, and the loop records that no baseline ran', (t) => {
  // The light tier needs a baseline that ran in an existing project.
  const { repo } = readyProject(t, { tier: 'full' });
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.execution_status, 'not_run');
  const recordedOn = codeSnapshot(repo).snapshot.digest;
  setResults(repo, AFTER);
  commit(repo, 'A first implementation');
  const { loop } = startLoop(repo, CHANGE);
  assert.deepEqual([loop.baseline, loop.baseline_available, loop.tier], [base.run_id, false, 'full']);
  assert.deepEqual([loop.start_code.digest, loop.worktree_moved], [recordedOn, true]);
});

test('loop start records the Spec, the baseline, the start code, the budget, the user\'s consent and each package digest, and runs one loop at a time per Spec export', (t) => {
  const project = withBaseline(t);
  const { repo, root, base } = project;
  const head = git(repo, ['rev-parse', 'HEAD']);
  const evals = validateEval(repo, CHANGE);

  const result = startLoop(repo, CHANGE, { iterations: 3, minutes: 20 });
  assertNoRoutes(result);
  assert.deepEqual(result.suggestion.command, runCommand(repo));
  const file = path.join(root, 'loop.json');
  const loop = readJSON(file);
  assert.equal(loop.change, CHANGE);
  assert.equal(loop.spec, evals.spec);
  assert.deepEqual([loop.baseline, loop.baseline_available, loop.base_commit, loop.start_code.commit, loop.start_from, loop.worktree_moved], [base.run_id, true, head, head, 'baseline', false]);
  // --max-minutes gives run minutes: the Docker time of the runs.
  assert.deepEqual(loop.budget, { iterations: 3, minutes: null, run_minutes: 20 });
  assert.equal(loop.budget_source, 'loop_start');
  assert.equal(loop.tier, 'light');
  assert.deepEqual(loop.checks_confirmation, { id: project.confirmation.confirmation.id, at: project.confirmation.confirmation.confirmed.at });
  assert.deepEqual([loop.consent.by, loop.consent.ref], [USER, REF]);
  assert.deepEqual(result.consent, loop.consent);
  assert.deepEqual(loop.task_digest, Object.fromEntries(evals.cases.map((item) => [item.id, item.task_digest])));
  assert.deepEqual(Object.keys(loop.run_digest), [FAILURE, SUCCESS]);
  assert.equal(result.loop.spec, loop.spec);
  assert.deepEqual([result.earlier_loops.loops, result.earlier_loops.total.loops, result.earlier_loops.total.iterations], [[], 0, 0]);
  const decisions = readDecisions(root).entries.filter((entry) => entry.type === 'loop_start');
  assert.deepEqual(decisions.map((entry) => [entry.loop_started_at, entry.by, entry.ref, entry.baseline]), [[loop.started_at, USER, REF, base.run_id]]);

  // A second start for the same Spec export is refused and leaves the loop as it was.
  const written = readFileSync(file, 'utf8');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('loop_running')(error);
    const entry = assertGapShape(gapOf(error, 'loop_running'), { owner: 'agent', layer: 'loop', loop_started_at: loop.started_at });
    assert.equal(entry.message, `A loop for this Spec export started at ${loop.started_at} and has not ended. One loop runs at a time for an export.`);
    assert.doesNotMatch(entry.message, /--restart|loop extend/);
    return true;
  });
  const again = cli(['loop', 'start', CHANGE, '--repo', repo, ...CONSENT_FLAGS, '--max-iterations', '4']);
  assert.equal(again.status, 1, again.stdout);
  assert.ok(codes(again.json.gaps).includes('loop_running'));
  assert.equal(readFileSync(file, 'utf8'), written);
});

test('loop start rejects a budget that is not a whole number of runs and a positive number of minutes', (t) => {
  const { repo, root } = withBaseline(t);
  const message = /--max-iterations is a whole number of 1 or more and --max-minutes a number above 0/;
  for (const iterations of [0, -1, 1.5, Number.NaN]) assert.throws(() => startLoop(repo, CHANGE, { iterations }), message);
  for (const minutes of [0, -5, Number.NaN]) assert.throws(() => startLoop(repo, CHANGE, { minutes }), message);
  for (const flags of [['--max-iterations', 'two'], ['--max-iterations', '0'], ['--max-minutes', '0'], ['--max-minutes', 'soon']]) {
    const refused = cli(['loop', 'start', CHANGE, '--repo', repo, ...CONSENT_FLAGS, ...flags]);
    assert.equal(refused.status, 1, `${flags.join(' ')}: ${refused.stdout}`);
    assert.match(refused.json.error, message);
  }
  assert.equal(existsSync(path.join(root, 'loop.json')), false);

  const started = cli(['loop', 'start', CHANGE, '--repo', repo, ...CONSENT_FLAGS, '--max-iterations', '2', '--max-minutes', '15']);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(started.json.loop.budget, { iterations: 2, minutes: null, run_minutes: 15 });
});

test('before any head run loop status gives the gating checks the baseline did not pass as open, and suggests a full run', (t) => {
  const { repo, base } = inLoop(t);
  const status = loopStatus(repo, CHANGE);
  assertNoRoutes(status, 'status');
  assert.equal(status.change, CHANGE);
  assert.equal(status.phase, 'live');
  assert.deepEqual([status.loop.baseline, status.loop.baseline_available, status.loop.tier], [base.run_id, true, 'light']);
  // The budget the user confirmed with the checks, the light tier's default.
  assert.deepEqual(status.loop.budget, { iterations: 5, minutes: null, run_minutes: 30 });
  assert.equal(status.loop.used.iterations, 0);
  assert.equal(status.loop.exhausted, false);
  assert.deepEqual(status.runs, []);
  assert.equal(status.partial_runs, 0);
  assert.deepEqual(status.checks.map((entry) => [entry.case, entry.check, entry.role, entry.baseline, entry.runs]), [
    [FAILURE, 'c1', 'gating', 'fail', []],
    [SUCCESS, 'c1', 'gating', 'pass', []],
    [SUCCESS, 'c2', 'gating', 'pass', []],
  ]);
  assert.deepEqual([status.situation.code, status.situation.open, status.situation.pending_packages], ['open', [`${FAILURE}/c1=fail`], []]);
  assert.deepEqual(status.suggestion.command, runCommand(repo));
  assert.deepEqual(status.regressions, []);
  assert.equal(status.stuck, false);
  // Nothing waits for the user: a head run is allowed, and nothing can be accepted yet.
  assert.equal(status.gates.head_run, null);
  assert.deepEqual(codes(status.gates.accept), ['nothing_to_accept']);
  assert.equal(status.must_show, null);

  const shown = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.situation.code, 'open');
});

test('a full head run of a loop writes its report itself, Result and Changes from the records, and loop report never overwrites it', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, BEFORE, 'first attempt');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'fail');
  const file = path.join(root, 'reports', `${run.run_id}.md`);
  assert.deepEqual(run.report, { file, created: true });
  const record = runRecord(project, run);
  assert.deepEqual(reportGaps(repo, CHANGE, record), []);

  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => [entry.run_id, entry.verdict, entry.report]), [[run.run_id, 'fail', 'written']]);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.situation.code, 'open');
  assert.deepEqual(status.suggestion.command, runCommand(repo));

  const report = readFileSync(file, 'utf8');
  for (const row of [
    '| submit-failure-s1 | c1 | REQ-submit-failure | 本次提交发送的成功通知数量为零 | gating | fail (0/1) → fail (0/1) | violated |',
    '| submit-success-s1 | c1 | REQ-submit-success | 本次提交发送的成功通知数量为一 | gating | pass (1/1) → pass (1/1) | holds (kept) |',
    '| submit-success-s1 | c2 | REQ-submit-success | 本次提交发送的失败通知数量为零 | gating | pass (1/1) → pass (1/1) | holds (kept) |',
  ]) assert.ok(report.includes(row), `${row} in\n${report}`);
  assert.match(report, /^## Result$/m);
  assert.match(report, /^## Changes$/m);
  assert.match(report, /^## Notes$/m);
  // No template line to remove and no section the CLI waits for.
  assert.ok(!report.includes(TEMPLATE_MARK), report);
  assert.doesNotMatch(report, /^## (Cause|Next|Review)$/m);

  // Writing it again keeps what the agent wrote.
  const edited = report.replace('## Notes\n', '## Notes\n\nThe agent wrote this line.\n');
  assert.notEqual(edited, report);
  writeFileSync(file, edited);
  assert.deepEqual(writeReport(repo, CHANGE, { run: run.run_id }), { file, created: false, written: ['Result', 'Changes'] });
  const shown = cli(['loop', 'report', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.created, false);
  assert.equal(readFileSync(file, 'utf8'), edited);

  // A report gates nothing: without it the loop stands where it stood, and
  // loop report writes it again from the records.
  rmSync(file);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.report), ['missing']);
  assert.deepEqual([status.situation.code, status.suggestion.command], ['open', runCommand(repo)]);
  assert.deepEqual(reportGaps(repo, CHANGE, record), [`no report at reports/${run.run_id}.md`]);
  assert.deepEqual(writeReport(repo, CHANGE), { file, created: true, written: ['Result', 'Changes'] });
  assert.equal(readFileSync(file, 'utf8'), report);
});

test('a failing run leaves the loop open on the gating checks that still fail, whatever its notes say', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BEFORE, 'first attempt');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(reportGaps(repo, CHANGE, { run_id: run.run_id, verdict: run.verdict }), []);
  assert.deepEqual(status.runs.map((entry) => entry.report), ['written']);
  assert.deepEqual([status.situation.code, status.situation.open], ['open', [`${FAILURE}/c1=fail`]]);
  assert.deepEqual(status.checks.map((entry) => [entry.case, entry.check, entry.runs, entry.verdict]), [
    [FAILURE, 'c1', ['fail'], 'violated'],
    [SUCCESS, 'c1', ['pass'], 'holds'],
    [SUCCESS, 'c2', ['pass'], 'holds'],
  ]);
});

test('partial runs are not counted by the loop and cannot be reported, reviewed or accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'fix the failure notice');
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.scope, 'partial');
  assert.equal(partial.execution_status, 'completed');
  assert.equal(partial.report, undefined);

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.partial_runs, 1);
  assert.deepEqual(status.runs, []);
  assert.equal(status.loop.used.iterations, 0);
  assert.equal(status.situation.code, 'open');

  assert.throws(() => writeReport(repo, CHANGE, { run: partial.run_id }), /is not a full run of this loop/);
  assert.throws(() => writeReport(repo, CHANGE), /not a full run of this loop/);
  const reported = cli(['loop', 'report', CHANGE, '--repo', repo, '--run', partial.run_id]);
  assert.equal(reported.status, 1, reported.stdout);
  assert.match(reported.json.error, /not a full run/);
  assert.throws(() => reviewRun(project, partial.run_id), refusedWith('run_unknown'));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: partial.run_id, by: 'Dana', ref: 'chat' }), refusedWith('run_unknown'));
});

test('the same gating checks failing in the last two full runs on different code are a warning, and stop the loop only when the user\'s plan asks for it', (t) => {
  const twoFailures = (repo) => {
    changeCode(repo, BEFORE, 'first attempt');
    const first = fullRun(repo);
    // A partial run in between is a quick look and changes nothing.
    changeCode(repo, AFTER, 'quick look');
    startRun(repo, CHANGE, { case: [FAILURE] });
    changeCode(repo, BEFORE, 'second attempt');
    const second = fullRun(repo);
    assert.equal(second.verdict, 'fail');
    return [first, second];
  };

  const { repo } = inLoop(t);
  twoFailures(repo);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.partial_runs, 1);
  assert.equal(status.loop.used.iterations, 2);
  assert.notEqual(status.runs[0].commit, status.runs[1].commit);
  assert.equal(status.stuck, true);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual([status.phase, status.situation.code, status.ended, status.gates.head_run], ['live', 'open', null, null]);
  assert.ok(status.warnings.includes(`stuck: the same gating checks failed in the last two runs on different code: ${FAILURE}/c1=fail.`), JSON.stringify(status.warnings));
  assert.ok(!status.warnings.some((warning) => /same code/.test(warning)), JSON.stringify(status.warnings));
  assert.deepEqual(status.suggestion.command, runCommand(repo));

  // The user's plan may ask to stop then (eval confirm --stop-on-stuck).
  const project = withBaseline(t);
  const confirmed = confirmChecks(project, { stopOnStuck: true, reason: 'The user asks to stop a loop that is stuck.' });
  assert.equal(confirmed.confirmation.run_plan.stop_on_stuck, true);
  assert.equal(startLoop(project.repo, CHANGE).loop.stop_on_stuck, true);
  const [first, second] = twoFailures(project.repo);
  status = loopStatus(project.repo, CHANGE);
  assertEnded(status, 'stop_stuck');
  assert.deepEqual([status.ended.runs, status.ended.failing], [[second.run_id, first.run_id], [`${FAILURE}/c1=fail`]]);
  assertGapShape(status.gates.head_run, { code: 'stop_stuck', owner: 'user', layer: 'code' });
});

test('two full runs on the same code warn that a run of the same code only adds to its count, and do not count as stuck', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  const second = fullRun(repo);
  const file = completeReport(repo, second.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes('The last two runs used the same code. A run of the same code only adds to its count: it never cancels a failure, and it tries nothing new.'), JSON.stringify(status.warnings));
  assert.equal(status.stuck, false);
  assert.equal(status.situation.code, 'open');
  const report = readFileSync(file, 'utf8');
  assert.ok(report.includes(`Files changed since run ${first.run_id}:\n- none\n`), report);
});

test('a gating check that passed in the baseline and fails now is a regression, with the run it last passed in and the files changed since', (t) => {
  const { repo, base } = inLoop(t);
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'fail');

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.changed_packages, []);
  // The failed submission was fixed; only the check that worked before counts.
  assert.deepEqual(status.regressions, [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success', failing_run: run.run_id, last_passed: base.run_id,
    files_changed: ['app/handler.txt', 'app/results.json'] }]);
  assert.deepEqual([status.situation.code, status.situation.regressions], ['regression', status.regressions]);
  assert.match(status.situation.message, /submit-success-s1\/c1/);
  assert.doesNotMatch(status.situation.message, /submit-failure-s1/);
  // The loop goes on: the next head run is the agent's to make.
  assert.equal(status.gates.head_run, null);
});

test('a check that passed only during the loop and fails again is lost progress, not a regression', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'fix the failure notice');
  const first = fullRun(repo);
  assert.equal(first.verdict, 'pass');
  changeCode(repo, BEFORE, 'undo the fix by accident');
  const second = fullRun(repo);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress.map(({ case: id, check, intent, failing_run: failing, last_passed: passed }) => ({ case: id, check, intent, failing, passed })),
    [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure', failing: second.run_id, passed: first.run_id }]);
  assert.ok(status.warnings.includes(`Passed in an earlier run and fails again: ${FAILURE}/c1 (passed in ${first.run_id}).`), JSON.stringify(status.warnings));
  assert.equal(status.stuck, false);
  assert.equal(status.situation.code, 'open');
});

test('the loop stops on budget once its full runs are used up, which ends it, and no head run starts after it', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  fullRun(repo);
  assert.equal(loopStatus(repo, CHANGE).phase, 'live');

  // Different failing evidence, so the loop is not stuck, and no regression.
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'second attempt');
  const second = fullRun(repo);
  assert.equal(second.verdict, 'unverified');

  const status = loopStatus(repo, CHANGE);
  assertNoRoutes(status, 'status');
  assert.equal(status.loop.used.iterations, 2);
  assert.equal(status.stuck, false);
  assert.deepEqual(status.regressions, []);
  assertStopBudget(status, 'budget_used_up');
  assertGapShape(status.gates.head_run, { code: 'stop_budget', owner: 'user', layer: 'loop' });
  assert.deepEqual([status.ended.budget, status.ended.used.iterations], [{ iterations: 2, minutes: null, run_minutes: 30 }, 2]);
  // What the user decides on next: a revised budget or a new loop, after
  // seeing why the loop ended and what it used.
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.by === 'user' && entry.decision === 'budget or new loop'), JSON.stringify(status.obligations));
  assert.deepEqual(Object.keys(status.must_show), ['end', 'usage', 'budget']);
  // The budget is hard: no further head run, full or partial, and nothing runs.
  refusedBeforeRun(project, {}, 'change_locked');
  refusedBeforeRun(project, { case: [FAILURE] }, 'change_locked');
});

test('a head run of a loop that ended on its budget is refused with the stop itself, not only with the lock it leaves', (t) => {
  const project = inLoop(t, { iterations: 1 });
  changeCode(project.repo, BEFORE, 'first attempt');
  fullRun(project.repo);
  assertStopBudget(loopStatus(project.repo, CHANGE), 'budget_used_up');
  refusedBeforeRun(project, {}, 'stop_budget');
});

test('the final review offers a Genesis review from the Map copy, so every clone lands the change on the same flows', (t) => {
  const project = withBaseline(t, { map: { snapshot_id: 'sha256:loop', analysis_status: 'complete', mode: 'map', flows: [] } });
  const { repo } = project;
  const { loop } = startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable');
  const copy = `openspec/changes/${CHANGE}/business-map.json`;
  assert.deepEqual(status.review.genesis_review, {
    base: loop.base_commit, entries_from: copy, prepare: ['map', 'prepare', '--base', loop.base_commit, '--entries-from', copy],
    scope: 'project', scope_limited: false, optional: true,
  });
  assert.deepEqual(status.map_scope, { scope: 'project', scope_limited: false });
  // A Genesis review is optional: any final review recorded for the code counts.
  reviewRun(project, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assertSuggestion(status, ['loop', 'accept', CHANGE, '--repo', repo, '--run', run.run_id]);
});

test('a passing full run needs a final review recorded for its code before it can be accepted, and loop status names what the review answers', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');

  let status = loopStatus(repo, CHANGE);
  assertNoRoutes(status, 'status');
  assert.deepEqual([status.phase, status.situation.code, status.situation.run_id], ['live', 'acceptable', run.run_id]);
  assertGapShape(status.gates.accept.find((entry) => entry.code === 'review_missing'), { owner: 'agent', layer: 'loop', run: run.run_id });
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  assert.deepEqual([status.review.run_id, status.review.needed_for, status.review.recorded, status.review.satisfied], [run.run_id, 'acceptance', [], false]);
  assert.deepEqual(status.review.flips, [{ case: FAILURE, check: 'c1', then: '本次提交发送的成功通知数量为零', before: 'fail' }]);
  assert.deepEqual(status.review.questions.map((entry) => entry.split(':')[0]), ['flips', 'special_cases', 'outside_spec', 'side_effects']);
  assert.deepEqual(status.review.reviewers, ['subagent', 'human', 'genesis', 'self']);
  // No Map was recorded, so no Genesis review starts from it.
  assert.equal(status.review.genesis_review, undefined);
  assertSuggestion(status, ['loop', 'review', CHANGE, '--repo', repo, '--run', run.run_id]);
  assert.ok(status.obligations.some((entry) => entry.kind === 'review' && entry.run_id === run.run_id && entry.recorded === false), JSON.stringify(status.obligations));
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'acceptance' && entry.by === 'user'), JSON.stringify(status.obligations));
  // The report is written and asks for nothing.
  assert.deepEqual(status.runs.map((entry) => entry.report), ['written']);

  const reviewed = reviewRun(project, run.run_id);
  assertNoRoutes(reviewed, 'review');
  assert.deepEqual([reviewed.review.reviewer, reviewed.covers, reviewed.findings, reviewed.suggestion], ['subagent', [run.run_id], [], null]);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assert.deepEqual([status.review.satisfied, status.review.recorded.map((entry) => entry.id)], [true, ['review-1']]);
  assert.deepEqual(status.suggestion.command, ['loop', 'accept', CHANGE, '--repo', repo, '--run', run.run_id, '--by', '<user>', '--ref', '<where they said so>']);
  assert.equal(status.accepted, false);
  assert.equal(status.acceptance, null);
});

test('loop accept needs who accepted and where, and refuses unknown and failing runs, a run without a final review, and changed code', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const accepted = path.join(root, 'accepted.json');
  changeCode(repo, BEFORE, 'first attempt');
  const failing = fullRun(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const passing = fullRun(repo);
  assert.equal(passing.verdict, 'pass');

  for (const options of [{}, { by: 'Dana' }, { ref: 'chat' }, { by: '  ', ref: 'chat' }, { by: 'Dana', ref: ' ' }]) {
    assert.throws(() => acceptLoop(repo, CHANGE, { run: passing.run_id, ...options }), /--by and --ref/);
  }
  const unnamed = cli(['loop', 'accept', CHANGE, '--repo', repo, '--run', passing.run_id, '--ref', 'chat']);
  assert.equal(unnamed.status, 1, unnamed.stdout);
  assert.match(unnamed.json.error, /--by and --ref/);

  const accept = (run) => acceptLoop(repo, CHANGE, { run, by: 'Dana', ref: 'review thread 12' });
  assert.throws(() => accept('20990101-000000-0000'), refusedWith('run_unknown'));
  assert.throws(() => accept(failing.run_id), refusedWith('not_passing'));
  const refused = cli(['loop', 'accept', CHANGE, '--repo', repo, '--run', failing.run_id, '--by', 'Dana', '--ref', 'review thread 12']);
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(codes(refused.json.gaps).includes('not_passing'));

  // Without a final review of its code the run is not accepted, and the
  // refusal carries what the user must be shown.
  assert.throws(() => accept(passing.run_id), (error) => {
    assert.deepEqual(codes(error.gaps), ['review_missing']);
    assert.deepEqual(Object.keys(error.must_show), ['checks', 'strength', 'usage']);
    return true;
  });
  const unreviewed = cli(['loop', 'accept', CHANGE, '--repo', repo, '--run', passing.run_id, '--by', 'Dana', '--ref', 'review thread 12']);
  assert.equal(unreviewed.status, 1, unreviewed.stdout);
  assert.deepEqual([codes(unreviewed.json.gaps), Object.keys(unreviewed.json.must_show)], [['review_missing'], ['checks', 'strength', 'usage']]);
  reviewRun(project, passing.run_id);

  // Code that changed after the run is not the code that was accepted.
  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'an edit after the run\n');
  assert.throws(() => accept(passing.run_id), (error) => {
    assert.deepEqual(codes(error.gaps), ['code_changed']);
    assertGapShape(error.gaps[0], { owner: 'agent', layer: 'code' });
    return true;
  });
  assert.equal(existsSync(accepted), false);

  rmSync(scratch);
  assert.equal(accept(passing.run_id).accepted.run_id, passing.run_id);
  assert.ok(existsSync(accepted));
});

test('an accepted run is recorded with its checks, plan, tier, proofs, review and the user\'s consent, and the same loop cannot be accepted twice', (t) => {
  const project = inLoop(t);
  const { repo, root, base } = project;
  const head = changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const record = runRecord(project, run);
  reviewRun(project, run.run_id);

  const command = ['loop', 'accept', CHANGE, '--repo', repo, '--run', run.run_id, '--by', ' Dana ', '--ref', ' review thread 12 '];
  const result = cli(command);
  assert.equal(result.status, 0, result.stderr);
  assertNoRoutes(result.json, 'accept');
  // The run was on a clean commit, but the report and the acceptance record
  // belong in Git too and are not committed yet. Committing is the user's call.
  assert.equal(result.json.commit, undefined);
  assert.equal(result.json.committed, false);
  assert.deepEqual(result.json.uncommitted, [`.genesis/edd/${CHANGE}/accepted.json`, `.genesis/edd/${CHANGE}/reports/`]);
  assert.deepEqual(result.json.needs_user.map((entry) => entry.decision), ['commit, merge or pull request']);
  assert.deepEqual(result.json.must_show, { strength: [{ sentence: LIGHT_STRENGTH }] });
  assert.deepEqual([result.json.warnings, result.json.suggestion], [[], null]);
  const file = path.join(root, 'accepted.json');
  assert.equal(result.json.file, file);
  const accepted = readJSON(file);
  assert.equal(accepted.change, CHANGE);
  assert.equal(accepted.run_id, run.run_id);
  assert.deepEqual(accepted.spec, record.spec_snapshot);
  assert.equal(accepted.baseline, base.run_id);
  assert.equal(accepted.commit, head);
  assert.equal(accepted.code_digest, record.code_snapshot.digest);
  assert.equal(accepted.code_digest_of, 'content');
  const once = (outcome) => ({ pass: 0, fail: 0, unknown: 0, [outcome]: 1 });
  assert.equal(accepted.schema_version, '1.3');
  // compare.json and accepted.json keep the verdict holds; only reports and
  // must_show label it fixed or kept.
  assert.deepEqual(accepted.checks, [
    { case: FAILURE, check: 'c1', intent: 'REQ-submit-failure', role: 'gating', before: 'fail', after: 'pass', before_counts: once('fail'), after_counts: once('pass'), verdict: 'holds' },
    { case: SUCCESS, check: 'c1', intent: 'REQ-submit-success', role: 'gating', before: 'pass', after: 'pass', before_counts: once('pass'), after_counts: once('pass'), verdict: 'holds' },
    { case: SUCCESS, check: 'c2', intent: 'REQ-submit-success', role: 'gating', before: 'pass', after: 'pass', before_counts: once('pass'), after_counts: once('pass'), verdict: 'holds' },
  ]);
  const { confirmation } = project.confirmation;
  const plan = accepted.run_plan;
  assert.deepEqual([plan.attempts, plan.pass_rule, plan.agent, plan.model, plan.tier, plan.attempts_by_case], [null, 'all', AGENT, null, 'light', { [FAILURE]: 1, [SUCCESS]: 1 }]);
  assert.equal(accepted.tier, 'light');
  assert.equal(accepted.strength.sentence, LIGHT_STRENGTH);
  // Each line a program checks with what proves its checks can fail.
  assert.deepEqual(accepted.lines.map((line) => [line.package, line.checks, line.proof.sources]), [
    [FAILURE, ['c1'], ['baseline_failure', 'counterexample']],
    [SUCCESS, ['c1'], ['counterexample']],
    [SUCCESS, ['c2'], ['counterexample']],
  ]);
  // The checks confirmation the loop started on covers the accepted packages.
  assert.deepEqual(accepted.checks_confirmation, { id: confirmation.id, at: confirmation.confirmed.at, by: USER, ref: REF, kind: 'initial', review_origin: 'review' });
  assert.deepEqual(accepted.loop_confirmation, { id: confirmation.id, at: confirmation.confirmed.at });
  assert.deepEqual([accepted.changed_since_confirmation, accepted.revisions, accepted.self_review_lines, accepted.manual], [[], [], [], []]);
  // The final review, and who agreed to the loop.
  assert.deepEqual([accepted.review.id, accepted.review.reviewer, accepted.review.run_id, accepted.self_review, accepted.review_findings], ['review-1', 'subagent', run.run_id, false, []]);
  assert.deepEqual([accepted.loop_consent.by, accepted.loop_consent.ref], [USER, REF]);
  assert.deepEqual(accepted.history.map((entry) => [entry.run_id, entry.verdict]), [[run.run_id, 'pass']]);
  assert.equal(accepted.accepted.by, 'Dana');
  assert.equal(accepted.accepted.ref, 'review thread 12');
  assert.ok(!Number.isNaN(Date.parse(accepted.accepted.at)), accepted.accepted.at);
  assert.deepEqual(result.json.accepted, accepted);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.accepted, status.suggestion], ['done', 'accepted', true, null]);
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'commit, merge or pull request'), JSON.stringify(status.obligations));

  const written = readFileSync(file, 'utf8');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 13' }), refusedWith('already_accepted'));
  const again = cli(command);
  assert.equal(again.status, 1, again.stdout);
  assert.ok(codes(again.json.gaps).includes('already_accepted'));
  assert.equal(readFileSync(file, 'utf8'), written);
});

test('the Changes section of a report lists the files changed since the baseline, then since the previous run', (t) => {
  const { repo, base } = inLoop(t);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'first version\n');
  // Genesis records committed beside the code are not application changes.
  writeFileSync(path.join(repo, '.genesis/edd/notes.txt'), 'not application code\n');
  commit(repo, 'Add the handler');
  const first = fullRun(repo);
  const firstReport = readFileSync(writeReport(repo, CHANGE).file, 'utf8');
  assert.ok(firstReport.includes(`Files changed since the baseline ${base.run_id}:\n- \`app/handler.txt\`\n\n## Notes`), firstReport);
  assert.ok(firstReport.includes(`Eval package and project kit files changed since the baseline ${base.run_id}:\n- none\n`), firstReport);
  completeReport(repo, first.run_id);

  // Uncommitted edits count as well: they are part of the code that ran.
  writeFileSync(path.join(repo, 'app/handler.txt'), 'second version\n');
  writeFileSync(path.join(repo, 'app/extra.txt'), 'a new file\n');
  const second = fullRun(repo);
  const { file } = writeReport(repo, CHANGE);
  const secondReport = readFileSync(file, 'utf8');
  assert.ok(secondReport.includes(`Files changed since run ${first.run_id}:\n- \`app/extra.txt\`\n- \`app/handler.txt\`\n\n## Notes`), secondReport);
  assert.equal(path.basename(file), `${second.run_id}.md`);
  assert.match(secondReport, /^Code `[0-9a-f]{7}` \+ code\.patch · verdict `fail` · baseline `\S+` · run 2 of 5 · tier `light`$/m);
});

test('the Changes section compares content: files committed after a baseline with no commit are listed, unchanged ones are not', (t) => {
  const { repo, base } = withBaseline(t, { commit: false });
  startLoop(repo, CHANGE);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'first version\n');
  // app/results.json was uncommitted at the baseline and is committed unchanged.
  commit(repo, 'Add the handler');
  fullRun(repo);
  const report = readFileSync(writeReport(repo, CHANGE).file, 'utf8');
  assert.ok(report.includes(`Files changed since the baseline ${base.run_id}:\n- \`app/handler.txt\`\n\n## Notes`), report);
});
