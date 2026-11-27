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
  EXPECT, BROKEN, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord,
  refusedBeforeRun, assertEnded, assertStopBudget,
} from './helpers/loop.js';

const SKELETON_GAPS = ['the template line is still there', 'a check in Cause has no cause yet', 'section Next is empty'];

test('workflow check for loop-and-implement waits for a baseline, then points at loop start and later at loop status', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const check = ['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo];

  const before = cli(check);
  assert.equal(before.status, 1, before.stdout);
  assert.equal(before.json.status, 'blocked');
  assert.equal(before.json.inputs_ready, false);
  assert.deepEqual(codes(before.json.gaps), ['baseline_missing']);
  assert.equal(before.json.gaps[0].route, 'run-eval');
  assert.equal(before.json.next.route, 'run-eval');
  assert.equal(before.json.next.action, 'repair_inputs');

  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const ready = cli(check);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.json.status, 'ready');
  assert.deepEqual(ready.json.gaps, []);
  assert.equal(ready.json.next.route, 'loop-and-implement');
  assert.equal(ready.json.next.action, 'start_loop');
  assert.deepEqual(ready.json.next.command, ['loop', 'start', CHANGE, '--repo', repo]);

  const started = cli(['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(started.status, 0, started.stderr);
  const running = cli(check);
  assert.equal(running.status, 0, running.stderr);
  assert.equal(running.json.next.action, 'loop_status');
  assert.deepEqual(running.json.next.command, ['loop', 'status', CHANGE, '--repo', repo]);
  // The stage name works as a shorthand for the same check.
  assert.equal(cli(['loop-and-implement', CHANGE, '--repo', repo]).json.next.action, 'loop_status');
});

test('outside Git the loop cannot start, because every run records its code as a commit plus a patch', (t) => {
  const { repo, root } = withBaseline(t);
  rmSync(path.join(repo, '.git'), { recursive: true, force: true });

  const checked = cli(['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 1, checked.stdout);
  assert.equal(checked.json.status, 'blocked');
  assert.deepEqual(codes(checked.json.gaps), ['git_missing']);
  assert.equal(checked.json.gaps[0].route, 'loop-and-implement');

  assert.throws(() => startLoop(repo, CHANGE), blockedWith('git_missing'));
  assert.equal(existsSync(path.join(root, 'loop.json')), false);
});

test('loop start refuses a Spec without a baseline and loop status refuses a change without a loop', (t) => {
  const { repo, root } = readyProject(t);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_missing')(error);
    assert.deepEqual(error.resume.command, ['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
    return true;
  });
  const started = cli(['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(started.status, 1, started.stdout);
  assert.equal(started.json.code, 'LOOP_INPUT_BLOCKED');
  assert.ok(codes(started.json.gaps).includes('baseline_missing'));
  assert.equal(existsSync(path.join(root, 'loop.json')), false);

  assert.throws(() => loopStatus(repo, CHANGE), blockedWith('loop_missing'));
  const status = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(status.status, 1, status.stdout);
  assert.deepEqual(codes(status.json.gaps), ['loop_missing']);
});

test('loop start refuses code that changed after a baseline that ran, committed or not, and starts once the code is restored', (t) => {
  const { repo, root, base } = withBaseline(t);
  const start = git(repo, ['rev-parse', 'HEAD']);

  setResults(repo, AFTER);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    assert.equal(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').route, 'loop-and-implement');
    return true;
  });
  commit(repo, 'Change the code before the loop');
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_not_at_start'));
  assert.equal(existsSync(path.join(root, 'loop.json')), false);

  git(repo, ['reset', '-q', '--hard', start]);
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(loop.base_commit, start);
});

test('an unavailable baseline pins the code it was recorded on, and the loop records that no baseline ran', (t) => {
  const { repo } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.execution_status, 'not_run');
  setResults(repo, AFTER);
  commit(repo, 'A first implementation');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    assert.equal(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').message, `The baseline ${base.run_id} records that nothing could run on other code than the code now. A loop starts on the code its baseline was recorded on: record the baseline again on the code the loop starts from, with \`run start --baseline --unavailable no_implementation\`.`);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, again.run_id);
  assert.equal(loop.baseline_available, false);
});

test('loop start records the Spec, the baseline, the starting commit, the budget and each package digest, and runs one loop at a time per Spec', (t) => {
  const { repo, root, base } = withBaseline(t);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const evals = validateEval(repo, CHANGE);

  const result = startLoop(repo, CHANGE, { iterations: 3, minutes: 20 });
  assert.deepEqual(result.next, { action: 'loop_status', command: ['loop', 'status', CHANGE, '--repo', repo] });
  const file = path.join(root, 'loop.json');
  const loop = readJSON(file);
  assert.equal(loop.change, CHANGE);
  assert.equal(loop.spec, evals.spec);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(loop.baseline_available, true);
  assert.equal(loop.base_commit, head);
  assert.deepEqual(loop.budget, { iterations: 3, minutes: 20 });
  assert.deepEqual(loop.task_digest, Object.fromEntries(evals.cases.map((item) => [item.id, item.task_digest])));
  assert.deepEqual(Object.keys(loop.task_digest), ['submit-failure-s1', 'submit-success-s1']);
  assert.equal(loop.task_digest_from, undefined);
  assert.equal(result.loop.spec, loop.spec);
  assert.deepEqual(result.earlier_loops, { loops: [], total: { loops: 0, iterations: 0, minutes: null, run_minutes: null, cost_usd: null } });

  // A second start for the same Spec is refused and leaves the loop as it was.
  const written = readFileSync(file, 'utf8');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('loop_running')(error);
    const entry = error.gaps.find((gap) => gap.code === 'loop_running');
    assert.equal(entry.message, `A loop for this Spec started at ${loop.started_at} and has not ended: continue it with \`loop status\`. A new loop starts only after it ended or stopped, and only with the user's go-ahead.`);
    assert.doesNotMatch(entry.message, /--restart|loop extend/);
    return true;
  });
  const again = cli(['loop', 'start', CHANGE, '--repo', repo, '--max-iterations', '4']);
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
    const refused = cli(['loop', 'start', CHANGE, '--repo', repo, ...flags]);
    assert.equal(refused.status, 1, `${flags.join(' ')}: ${refused.stdout}`);
    assert.match(refused.json.error, message);
  }
  assert.equal(existsSync(path.join(root, 'loop.json')), false);

  const started = cli(['loop', 'start', CHANGE, '--repo', repo, '--max-iterations', '2', '--max-minutes', '15']);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(started.json.loop.budget, { iterations: 2, minutes: 15 });
});

test('before any head run loop status says iterate and lists the gating checks the baseline did not pass', (t) => {
  const { repo, base } = inLoop(t);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.change, CHANGE);
  assert.equal(status.loop.baseline, base.run_id);
  assert.equal(status.loop.baseline_available, true);
  assert.deepEqual(status.loop.budget, { iterations: 5, minutes: 60 });
  assert.equal(status.loop.used.iterations, 0);
  assert.deepEqual(status.runs, []);
  assert.equal(status.partial_runs, 0);
  assert.deepEqual(status.checks.map((entry) => [entry.case, entry.check, entry.role, entry.baseline, entry.runs]), [
    ['submit-failure-s1', 'c1', 'gating', 'fail', []],
    ['submit-success-s1', 'c1', 'gating', 'pass', []],
    ['submit-success-s1', 'c2', 'gating', 'pass', []],
  ]);
  assert.equal(status.next.action, 'iterate');
  assert.match(status.next.message, /Open: submit-failure-s1\/c1=fail\./);
  assert.match(status.next.message, /nothing has to be committed/);
  assert.doesNotMatch(status.next.message, /submit-success-s1/);
  assert.deepEqual(status.next.pending_packages, []);
  assert.deepEqual(status.regressions, []);
  assert.equal(status.stuck, false);

  const shown = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.next.action, 'iterate');
});

test('a failing full run asks for its report, which loop report writes once and never overwrites', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, BEFORE, 'first attempt');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'fail');
  const record = runRecord(project, run);
  assert.deepEqual(reportGaps(repo, CHANGE, record), [`no report at reports/${run.run_id}.md`]);

  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => [entry.run_id, entry.verdict, entry.report]), [[run.run_id, 'fail', 'incomplete']]);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.next.action, 'write_report');
  assert.deepEqual(status.next.command, ['loop', 'report', CHANGE, '--repo', repo]);
  assert.match(status.next.message, new RegExp(`no report at reports/${run.run_id}\\.md`));

  const written = writeReport(repo, CHANGE);
  assert.equal(written.created, true);
  assert.equal(written.file, path.join(root, 'reports', `${run.run_id}.md`));
  const skeleton = readFileSync(written.file, 'utf8');
  assert.ok(skeleton.split('\n')[0].includes(TEMPLATE_MARK));
  for (const row of [
    '| submit-failure-s1 | c1 | REQ-submit-failure | 本次提交发送的成功通知数量为零 | gating | fail (0/1) → fail (0/1) | violated |',
    '| submit-success-s1 | c1 | REQ-submit-success | 本次提交发送的成功通知数量为一 | gating | pass (1/1) → pass (1/1) | holds |',
    '| submit-success-s1 | c2 | REQ-submit-success | 本次提交发送的失败通知数量为零 | gating | pass (1/1) → pass (1/1) | holds |',
  ]) assert.ok(skeleton.includes(row), `${row} in\n${skeleton}`);
  assert.match(skeleton, /^- `submit-failure-s1` `c1` \(violated\):$/m);
  assert.doesNotMatch(skeleton, /^## Review/m);
  assert.deepEqual(reportGaps(repo, CHANGE, record), SKELETON_GAPS);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.match(status.next.message, /the template line is still there/);

  // Writing it again keeps what the agent wrote.
  const edited = skeleton.replace('## Changes\n', '## Changes\n\nThe agent wrote this line.\n');
  assert.notEqual(edited, skeleton);
  writeFileSync(written.file, edited);
  const again = writeReport(repo, CHANGE, { run: run.run_id });
  assert.equal(again.created, false);
  assert.deepEqual(again.missing, SKELETON_GAPS);
  const shown = cli(['loop', 'report', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.created, false);
  assert.equal(readFileSync(written.file, 'utf8'), edited);

  // Each part of a complete report is checked on its own.
  writeFileSync(written.file, edited.split('\n').slice(1).join('\n'));
  assert.deepEqual(reportGaps(repo, CHANGE, record), ['a check in Cause has no cause yet', 'section Next is empty']);
  writeFileSync(written.file, readFileSync(written.file, 'utf8').replace(/^## Changes[\s\S]*?(?=^## Next)/m, '## Changes\n\n<!-- nothing yet -->\n\n'));
  assert.deepEqual(reportGaps(repo, CHANGE, record), ['a check in Cause has no cause yet', 'section Changes is empty', 'section Next is empty']);
});

test('a complete report of a failing run lets the loop iterate on the checks that still fail', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BEFORE, 'first attempt');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(reportGaps(repo, CHANGE, { run_id: run.run_id, verdict: run.verdict }), []);
  assert.deepEqual(status.runs.map((entry) => entry.report), ['complete']);
  assert.equal(status.next.action, 'iterate');
  assert.match(status.next.message, /Open: submit-failure-s1\/c1=fail\./);
  assert.deepEqual(status.checks.map((entry) => [entry.case, entry.check, entry.runs, entry.verdict]), [
    ['submit-failure-s1', 'c1', ['fail'], 'violated'],
    ['submit-success-s1', 'c1', ['pass'], 'holds'],
    ['submit-success-s1', 'c2', ['pass'], 'holds'],
  ]);
});

test('partial runs are not counted by the loop and cannot be reported or accepted', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'fix the failure notice');
  const partial = startRun(repo, CHANGE, { case: ['submit-failure-s1'] });
  assert.equal(partial.scope, 'partial');
  assert.equal(partial.execution_status, 'completed');

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.partial_runs, 1);
  assert.deepEqual(status.runs, []);
  assert.equal(status.loop.used.iterations, 0);
  assert.equal(status.next.action, 'iterate');

  assert.throws(() => writeReport(repo, CHANGE, { run: partial.run_id }), /is not a full run of this loop/);
  assert.throws(() => writeReport(repo, CHANGE), /not a full run of this loop/);
  const reported = cli(['loop', 'report', CHANGE, '--repo', repo, '--run', partial.run_id]);
  assert.equal(reported.status, 1, reported.stdout);
  assert.match(reported.json.error, /not a full run/);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: partial.run_id, by: 'Dana', ref: 'chat' }), refusedWith('run_unknown'));
});

test('the same gating checks failing in the last two full runs on different code stop the loop as stuck', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');

  // A partial run in between is a quick look and changes nothing.
  changeCode(repo, AFTER, 'quick look');
  startRun(repo, CHANGE, { case: ['submit-failure-s1'] });
  changeCode(repo, BEFORE, 'second attempt');
  const second = fullRun(repo);
  assert.equal(second.verdict, 'fail');
  completeReport(repo, second.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.partial_runs, 1);
  assert.equal(status.loop.used.iterations, 2);
  assert.notEqual(status.runs[0].commit, status.runs[1].commit);
  assert.equal(status.stuck, true);
  assert.deepEqual(status.regressions, []);
  assert.equal(status.next.action, 'stop_stuck');
  assert.equal(status.next.owner, 'user');
  assert.match(status.next.message, /submit-failure-s1\/c1=fail/);
  assert.ok(!status.warnings.some((warning) => /same code/.test(warning)), JSON.stringify(status.warnings));
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
  assert.equal(status.next.action, 'iterate');
  const report = readFileSync(file, 'utf8');
  assert.ok(report.includes(`Files changed since run ${first.run_id}:\n- none\n`), report);
});

test('a gating check that passed in the baseline and fails now asks to split the changes', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'fail');
  completeReport(repo, run.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.changed_packages, []);
  // The failed submission was fixed; only the check that worked before counts.
  assert.deepEqual(status.regressions, [{ case: 'submit-success-s1', check: 'c1', intent: 'REQ-submit-success' }]);
  assert.equal(status.next.action, 'split_changes');
  assert.match(status.next.message, /submit-success-s1\/c1/);
  assert.doesNotMatch(status.next.message, /submit-failure-s1/);
});

test('a check that passed only during the loop and fails again is lost progress, not a regression', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'fix the failure notice');
  const first = fullRun(repo);
  assert.equal(first.verdict, 'pass');
  completeReport(repo, first.run_id);
  changeCode(repo, BEFORE, 'undo the fix by accident');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, [{ case: 'submit-failure-s1', check: 'c1', intent: 'REQ-submit-failure' }]);
  assert.ok(status.warnings.some((warning) => /Passed in an earlier run and fails again: submit-failure-s1\/c1/.test(warning)), JSON.stringify(status.warnings));
  assert.equal(status.stuck, false);
  assert.equal(status.next.action, 'iterate');
});

test('the loop stops on budget once its full runs are used up, which ends it', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');

  // Different failing evidence, so the loop is not stuck, and no regression.
  changeCode(repo, { ...AFTER, 'submit-failure-s1': { c1: 'unknown' } }, 'second attempt');
  const second = fullRun(repo);
  assert.equal(second.verdict, 'unverified');
  completeReport(repo, second.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 2);
  assert.equal(status.stuck, false);
  assert.deepEqual(status.regressions, []);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.equal(status.next.owner, 'user');
  assert.match(status.next.message, /This loop has ended: `run start` refuses its head runs\. A bigger budget goes to a new loop, once the user agrees: `loop start --max-iterations N --max-minutes M`\.$/);
  // The budget is hard: no further head run, full or partial.
  refusedBeforeRun(project, {}, 'stop_budget');
  refusedBeforeRun(project, { case: ['submit-failure-s1'] }, 'stop_budget');
});

test('the final review starts a Genesis review from the Map copy, so every clone lands the change on the same flows', (t) => {
  const { repo } = withBaseline(t, { map: { snapshot_id: 'sha256:loop', analysis_status: 'complete', mode: 'map', flows: [] } });
  const { loop } = startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  writeReport(repo, CHANGE);
  completeReport(repo, run.run_id, { review: false });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_review');
  const copy = `openspec/changes/${CHANGE}/business-map.json`;
  assert.deepEqual(status.next.genesis_review, {
    base: loop.base_commit, entries_from: copy,
    prepare: ['map', 'prepare', '--base', loop.base_commit, '--entries-from', copy],
  });
  assert.ok(status.next.message.includes(`\`genesis map prepare --base ${loop.base_commit} --entries-from ${copy}\``), status.next.message);
  // Acceptance does not wait for it: the Review section is what counts.
  completeReport(repo, run.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
});

test('a passing full run needs a final review in its report before acceptance is asked for', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  assert.equal(loopStatus(repo, CHANGE).next.action, 'write_report');

  const { file } = writeReport(repo, CHANGE);
  const skeleton = readFileSync(file, 'utf8');
  assert.match(skeleton, /^## Review$/m);
  assert.match(skeleton, /^- Every check holds\.$/m);
  const record = { run_id: run.run_id, verdict: run.verdict };
  assert.deepEqual(reportGaps(repo, CHANGE, record), ['the template line is still there', 'section Next is empty', 'section Review is empty']);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'write_report');

  completeReport(repo, run.run_id, { review: false });
  assert.deepEqual(reportGaps(repo, CHANGE, record), ['section Review is empty']);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_review');
  // No Map was recorded, so there is no Genesis review to start from it.
  assert.equal(status.next.genesis_review, undefined);
  assert.doesNotMatch(status.next.message, /genesis map prepare/);
  assert.deepEqual(status.runs.map((entry) => entry.report), ['incomplete']);

  completeReport(repo, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.report), ['complete']);
  assert.equal(status.next.action, 'ask_acceptance');
  assert.equal(status.next.owner, 'user');
  assert.deepEqual(status.next.command.slice(0, 7), ['loop', 'accept', CHANGE, '--repo', repo, '--run', run.run_id]);
  assert.ok(status.next.command.includes('--by') && status.next.command.includes('--ref'), JSON.stringify(status.next.command));
  assert.equal(status.accepted, null);
});

test('loop accept needs who accepted and where, and refuses failing runs, incomplete reports and changed code', (t) => {
  const { repo, root } = inLoop(t);
  const accepted = path.join(root, 'accepted.json');
  changeCode(repo, BEFORE, 'first attempt');
  const failing = fullRun(repo);
  completeReport(repo, failing.run_id);
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

  assert.throws(() => accept(passing.run_id), refusedWith('report_incomplete'));
  completeReport(repo, passing.run_id, { review: false });
  assert.throws(() => accept(passing.run_id), refusedWith('report_incomplete'));
  completeReport(repo, passing.run_id);

  // Code that changed after the run is not the code that was accepted.
  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'an edit after the run\n');
  assert.throws(() => accept(passing.run_id), (error) => {
    assert.deepEqual(codes(error.gaps), ['code_changed']);
    return true;
  });
  assert.equal(existsSync(accepted), false);

  rmSync(scratch);
  assert.equal(accept(passing.run_id).accepted.run_id, passing.run_id);
  assert.ok(existsSync(accepted));
});

test('an accepted run is recorded with its checks and the acceptance, and the same loop cannot be accepted twice', (t) => {
  const project = inLoop(t);
  const { repo, root, base } = project;
  const head = changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const record = runRecord(project, run);

  const command = ['loop', 'accept', CHANGE, '--repo', repo, '--run', run.run_id, '--by', ' Dana ', '--ref', ' review thread 12 '];
  const result = cli(command);
  assert.equal(result.status, 0, result.stderr);
  // The run was on a clean commit, but the report and the acceptance record
  // belong in Git too and are not committed yet.
  assert.equal(result.json.commit, undefined);
  assert.deepEqual(result.json.uncommitted, [`.genesis/edd/${CHANGE}/accepted.json`, `.genesis/edd/${CHANGE}/reports/`]);
  assert.match(result.json.next, new RegExp(`The accepted code is committed in ${head.slice(0, 7)}, but the commit is incomplete: \\.genesis/edd/${CHANGE}/accepted\\.json, \\.genesis/edd/${CHANGE}/reports/ are not committed\\.`));
  assert.doesNotMatch(result.json.next, /The accepted change is committed/);
  assert.deepEqual(result.json.warnings, []);
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
  const once = (result) => ({ pass: 0, fail: 0, unknown: 0, [result]: 1 });
  assert.equal(accepted.schema_version, '1.1');
  assert.deepEqual(accepted.checks, [
    { case: 'submit-failure-s1', check: 'c1', intent: 'REQ-submit-failure', role: 'gating', before: 'fail', after: 'pass', before_counts: once('fail'), after_counts: once('pass'), verdict: 'holds' },
    { case: 'submit-success-s1', check: 'c1', intent: 'REQ-submit-success', role: 'gating', before: 'pass', after: 'pass', before_counts: once('pass'), after_counts: once('pass'), verdict: 'holds' },
    { case: 'submit-success-s1', check: 'c2', intent: 'REQ-submit-success', role: 'gating', before: 'pass', after: 'pass', before_counts: once('pass'), after_counts: once('pass'), verdict: 'holds' },
  ]);
  const { confirmation } = project.confirmation;
  assert.deepEqual(accepted.run_plan, { attempts: null, pass_rule: 'all', agent: AGENT, model: null, source: 'confirmation', confirmation: confirmation.id,
    attempts_by_case: { 'submit-failure-s1': 1, 'submit-success-s1': 1 } });
  assert.deepEqual(accepted.strength, { attempts: null, pass_all_chance: null, single_sample: false,
    sentence: 'No package declares a live dependency, so each check ran once. That stands for later runs only while those packages give the same result every time.' });
  // The checks confirmation the loop started on covers the accepted packages.
  assert.deepEqual(accepted.checks_confirmation, { id: confirmation.id, at: confirmation.confirmed.at, by: 'Test User', ref: 'test setup', kind: 'initial', review_origin: 'review' });
  assert.deepEqual(accepted.loop_confirmation, { id: confirmation.id, at: confirmation.confirmed.at });
  assert.deepEqual([accepted.changed_since_confirmation, accepted.revisions, accepted.self_review_lines, accepted.manual], [[], [], [], []]);
  assert.equal(accepted.accepted.by, 'Dana');
  assert.equal(accepted.accepted.ref, 'review thread 12');
  assert.ok(!Number.isNaN(Date.parse(accepted.accepted.at)), accepted.accepted.at);
  assert.deepEqual(result.json.accepted, accepted);

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
  assert.ok(firstReport.includes(`Files changed since the baseline ${base.run_id}:\n- \`app/handler.txt\`\n\n## Next`), firstReport);
  completeReport(repo, first.run_id);

  // Uncommitted edits count as well: they are part of the code that ran.
  writeFileSync(path.join(repo, 'app/handler.txt'), 'second version\n');
  writeFileSync(path.join(repo, 'app/extra.txt'), 'a new file\n');
  const second = fullRun(repo);
  const { file } = writeReport(repo, CHANGE);
  const secondReport = readFileSync(file, 'utf8');
  assert.ok(secondReport.includes(`Files changed since run ${first.run_id}:\n- \`app/extra.txt\`\n- \`app/handler.txt\`\n\n## Next`), secondReport);
  assert.equal(path.basename(file), `${second.run_id}.md`);
  assert.match(secondReport, /^Code `[0-9a-f]{7}` \+ code\.patch · verdict `fail`/m);
});

test('the Changes section compares content: files committed after a baseline with no commit are listed, unchanged ones are not', (t) => {
  const { repo, base } = withBaseline(t, { commit: false });
  startLoop(repo, CHANGE);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'first version\n');
  // app/results.json was uncommitted at the baseline and is committed unchanged.
  commit(repo, 'Add the handler');
  fullRun(repo);
  const report = readFileSync(writeReport(repo, CHANGE).file, 'utf8');
  assert.ok(report.includes(`Files changed since the baseline ${base.run_id}:\n- \`app/handler.txt\`\n\n## Next`), report);
});
