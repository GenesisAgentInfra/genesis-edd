import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initProject, projectRoot, readJSON } from '../src/project.js';
import { exportSpec, newSpec, validateSpec } from '../src/spec.js';
import { newEval, validateEval } from '../src/eval.js';
import { checkEval, codeSnapshot, startRun } from '../src/run.js';
import { acceptLoop, extendLoop, loopStatus, reportGaps, startLoop, writeReport } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FIXTURES, SPECS, cli, commit, connect, git, readRecord, readyProject, setResults, useFakeTools,
  writeExpectations, writeSpec,
} from './helpers/edd.js';

// What the code before the change does: a failed submission still sends a
// success notice, and a successful one behaves.
const EXPECT = { 'submit-failure-s1/c1': 'fail', 'submit-success-s1/c1': 'pass', 'submit-success-s1/c2': 'pass' };
// A change that fixes the failed submission and breaks the successful one.
const BROKEN = { 'submit-failure-s1': { c1: 'pass' }, 'submit-success-s1': { c1: 'fail', c2: 'pass' } };
const TEMPLATE_MARK = 'GENESIS_EDD_TEMPLATE';
const SKELETON_GAPS = ['the template line is still there', 'a check in Cause has no cause yet', 'section Next is empty'];

const codes = (gaps) => (gaps ?? []).map((entry) => entry.code);
const blockedWith = (code) => (error) => {
  assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
  assert.ok(codes(error.gaps).includes(code), `expected ${code} in ${JSON.stringify(error.gaps)}`);
  return true;
};
const refusedWith = (code) => (error) => {
  assert.ok(codes(error.gaps).includes(code), `expected ${code} in ${error.message} ${JSON.stringify(error.gaps)}`);
  return true;
};

// A ready project whose baseline ran on the code before the change.
function withBaseline(t, options = {}) {
  const project = readyProject(t, options);
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  return { ...project, base };
}

// The same, with a loop started on that code.
function inLoop(t, budget = {}) {
  const project = withBaseline(t);
  const started = startLoop(project.repo, CHANGE, budget);
  return { ...project, loop: started.loop };
}

// Changes the application and commits it. app/results.json is what the fake
// verifier records; app/handler.txt stands in for the code that was edited, so
// every label gives different code.
function changeCode(repo, results, label) {
  setResults(repo, results);
  writeFileSync(path.join(repo, 'app/handler.txt'), `${label}\n`);
  return commit(repo, label);
}

function fullRun(repo) {
  const run = startRun(repo, CHANGE);
  assert.equal(run.execution_status, 'completed', JSON.stringify(run));
  assert.equal(run.scope, 'full');
  return run;
}

// Completes a run's report as an agent would: the template line goes, every
// check under Cause gets a cause, Next gets content, and Review too unless
// review is false.
function completeReport(repo, runId, { review = true } = {}) {
  const { file } = writeReport(repo, CHANGE, { run: runId });
  let text = readFileSync(file, 'utf8').split('\n').filter((line) => !line.includes(TEMPLATE_MARK)).join('\n')
    .replace(/^(- `[^`]+` `[^`]+` \([a-z_]+\):)[ \t]*$/gm, '$1 code logic: the handler ignores the submission result (see logs/harbor.log).')
    .replace(/^## Next[ \t]*$/m, '## Next\n\nChange the notification handler, then run every package again.');
  if (review) text = text.replace(/^## Review[ \t]*$/m, '## Review\n\nA fresh reviewer compared the whole diff with the Spec and found nothing to change.');
  writeFileSync(file, text);
  return file;
}

const runRecord = (project, run) => readRecord(path.join(project.runs, run.run_id)).run;

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
    assert.equal(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').route, 'run-eval');
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

test('an unavailable baseline does not pin the code and the loop records that no baseline ran', (t) => {
  const { repo } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.execution_status, 'not_run');
  setResults(repo, AFTER);
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(loop.baseline_available, false);
});

test('loop start records the Spec, the baseline, the starting commit, the budget and each package digest, and runs once per Spec', (t) => {
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
  assert.equal(result.loop.spec, loop.spec);

  // A second start for the same Spec is refused and leaves the loop as it was.
  const written = readFileSync(file, 'utf8');
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('loop_running'));
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
    '| submit-failure-s1 | c1 | REQ-submit-failure | gating | fail | fail | violated |',
    '| submit-success-s1 | c1 | REQ-submit-success | gating | pass | pass | holds |',
    '| submit-success-s1 | c2 | REQ-submit-success | gating | pass | pass | holds |',
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

test('two full runs on the same code warn that nothing new was tried and do not count as stuck', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  const second = fullRun(repo);
  const file = completeReport(repo, second.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.some((warning) => /The last two runs used the same code/.test(warning)), JSON.stringify(status.warnings));
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
  assert.ok(status.warnings.some((warning) => /Passed in the run before and fails again: submit-failure-s1\/c1/.test(warning)), JSON.stringify(status.warnings));
  assert.equal(status.stuck, false);
  assert.equal(status.next.action, 'iterate');
});

test('the loop stops on budget once its full runs are used up', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
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
  assert.equal(status.next.action, 'stop_budget');
  assert.equal(status.next.owner, 'user');
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
  // The run was on a clean commit, so nothing is left to commit.
  assert.equal(result.json.commit, head);
  assert.match(result.json.next, new RegExp(`committed in ${head.slice(0, 7)}`));
  assert.doesNotMatch(result.json.next, /Offer to commit/);
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
  assert.deepEqual(accepted.checks, [
    { case: 'submit-failure-s1', check: 'c1', intent: 'REQ-submit-failure', role: 'gating', before: 'fail', after: 'pass', verdict: 'holds' },
    { case: 'submit-success-s1', check: 'c1', intent: 'REQ-submit-success', role: 'gating', before: 'pass', after: 'pass', verdict: 'holds' },
    { case: 'submit-success-s1', check: 'c2', intent: 'REQ-submit-success', role: 'gating', before: 'pass', after: 'pass', verdict: 'holds' },
  ]);
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

// --- Budget clock, loop extend, restarts, next-step order, same-package
// comparison, acceptance across loops and moved impact evidence. ---

const FAILURE = 'submit-failure-s1';
const SUCCESS = 'submit-success-s1';
const BUDGET_RULE = /--max-iterations is a whole number of 1 or more and --max-minutes a number above 0/;
// The same Spec with a revision bump: a different export once exported.
const REVISED = SPECS.two.replace('revision: 1', 'revision: 2');

const loopPath = (project) => path.join(project.root, 'loop.json');
const loopRecord = (project) => readJSON(loopPath(project));
// Rewrites loop.json, e.g. to move its clock back in time.
function editLoop(project, edit) {
  const loop = loopRecord(project);
  edit(loop);
  writeFileSync(loopPath(project), `${JSON.stringify(loop, null, 2)}\n`);
}
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1, `${actual} minutes, expected about ${expected}`);
const withoutKey = (value, key) => Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));
const brief = ({ runs_used: runsUsed, iterations, minutes }) => ({ runs_used: runsUsed, iterations, minutes });

// A stop_budget step whose command raises the budget with loop extend.
function assertStopBudget(next, repo) {
  assert.equal(next.action, 'stop_budget', JSON.stringify(next));
  const { command } = next;
  assert.deepEqual(command.slice(0, 5), ['loop', 'extend', CHANGE, '--repo', repo], JSON.stringify(command));
  assert.equal(command[command.indexOf('--max-iterations') + 1], '<N>', JSON.stringify(command));
  assert.equal(command[command.indexOf('--max-minutes') + 1], '<M>', JSON.stringify(command));
}

// Changes the application without committing it; a run keeps it as commit plus patch.
function editApp(repo, results, label) {
  setResults(repo, results);
  writeFileSync(path.join(repo, 'app/handler.txt'), `${label}\n`);
}

// Puts the application back exactly as committed before the loop, the code its baseline ran on.
function restoreStart(project) {
  setResults(project.repo, BEFORE);
  rmSync(path.join(project.repo, 'app/handler.txt'), { force: true });
  assert.equal(codeSnapshot(project.repo).snapshot.digest, loopRecord(project).start_code.digest);
}

// Changes what a package executes, which makes it a different package, then proves it again.
function changePackage(project, id) {
  const file = path.join(project.root, 'evals', id, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  const checked = checkEval(project.repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked, null, 2));
}

// Exports the revised Spec and brings every package in line with it, as write-eval would.
function exportRevision(project) {
  writeSpec(project.repo, REVISED);
  const exported = exportSpec(project.repo, CHANGE);
  for (const id of Object.keys(project.packages)) {
    const file = path.join(project.root, 'evals', id, 'tests/checks.json');
    const declared = readJSON(file);
    declared.spec_ref.sha256 = exported.id;
    writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  }
  assert.equal(checkEval(project.repo, CHANGE).passed, true);
  return exported;
}

const IMPACT = '---\ngenesis_impact: 1\nentries:\n  - entry: notify()\n    effect: changes\n    evidence: app/notify.py:2\n---\n';
const MOVED = /impact\.md evidence no longer matches the code/;

// readyProject(t, { mode: 'existing' }) with app/notify.py and an impact.md that
// points at it, both written before the Spec is exported. readyProject exports
// right after writing the Spec, so this project is built by hand the same way.
function projectWithImpact(t) {
  const tools = useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Genesis Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  initProject(repo, 'existing', 'none');
  mkdirSync(path.join(repo, 'app'), { recursive: true });
  writeFileSync(path.join(repo, 'app/notify.py'), 'def notify(result):\n    return result\n');
  newSpec(repo, CHANGE);
  writeSpec(repo, SPECS.two);
  writeFileSync(path.join(repo, 'openspec/changes', CHANGE, 'impact.md'), IMPACT);
  const exported = exportSpec(repo, CHANGE);
  assert.deepEqual(exported.impact.map((entry) => entry.evidence), ['app/notify.py:2']);
  newEval(repo, CHANGE);
  const root = path.join(repo, '.genesis/edd', CHANGE);
  const kit = path.join(repo, '.genesis/edd/harness');
  writeFileSync(path.join(kit, 'harness.json'), `${JSON.stringify({ agent: AGENT }, null, 2)}\n`);
  writeFileSync(path.join(kit, 'PROJECT.md'), '# Eval notes for this project\n\nSynthetic project. app/results.json stands in for the application.\n');
  const packages = {};
  for (const id of readdirSync(path.join(root, 'evals')).sort()) {
    const directory = path.join(root, 'evals', id);
    const file = path.join(directory, 'tests/checks.json');
    const declared = readJSON(file);
    const ids = declared.checks.map((check) => check.id);
    declared.fixtures = FIXTURES.map((name) => ({ name, expect: Object.fromEntries(ids.map((check) => [check, name])) }));
    writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
    mkdirSync(path.join(directory, 'tests/fixtures'), { recursive: true });
    for (const name of FIXTURES) {
      writeFileSync(path.join(directory, 'tests/fixtures', `${name}.sh`), `#!/bin/sh\n# Synthetic fixture: leaves a state the verifier judges as ${name}.\nexit 0\n`, { mode: 0o755 });
    }
    mkdirSync(path.join(directory, 'environment'), { recursive: true });
    writeFileSync(path.join(directory, 'environment/Dockerfile'), 'FROM alpine:3.20\nWORKDIR /app\n');
    writeFileSync(path.join(directory, 'tests/test.sh'), `#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\n# Synthetic verifier. In these tests the fake Harbor stands in for it.\n${ids.map((check) => `gate ${check} unknown "synthetic"`).join('\n')}\nfinish\n`, { mode: 0o755 });
    writeFileSync(path.join(directory, 'Task.md'), `# ${id}\n\n## Trigger\nSynthetic.\n\n## Environment\nSynthetic.\n\n## Evidence\nSynthetic.\n\n## Choices made here\nNone.\n\n## Not covered\nEverything real.\n`);
    connect(repo, id);
    packages[id] = ids;
  }
  setResults(repo, BEFORE);
  commit(repo, 'Add the application and its evals');
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked, null, 2));
  return { repo, name: CHANGE, tools, packages, root, runs: path.join(root, 'runs'), spec: exported.id };
}

// That project with its baseline recorded and a loop started on the code before the change.
function impactLoop(t) {
  const project = projectWithImpact(t);
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const { loop } = startLoop(project.repo, CHANGE);
  assert.equal(loop.spec, project.spec);
  return { ...project, base, loop };
}

// L1: loop.json and restarts.

test('loop start records the code it starts from, starts the budget clock with the loop and has no extensions yet', (t) => {
  const project = withBaseline(t);
  const { repo, base } = project;
  const head = git(repo, ['rev-parse', 'HEAD']);
  startLoop(repo, CHANGE);
  const loop = loopRecord(project);
  assert.deepEqual(loop.start_code, { commit: head, digest: readRecord(base).run.code_snapshot.digest, digest_of: 'content' });
  assert.equal(loop.start_code.digest, codeSnapshot(repo).snapshot.digest);
  assert.equal(loop.clock_started_at, loop.started_at);
  assert.deepEqual(loop.extensions, []);
  assert.deepEqual(loop.previous ?? [], []);
});

test('loop start --restart replaces the loop of the same Spec, keeps the replaced loops under previous, and loop status counts only the runs after it', (t) => {
  const project = inLoop(t);
  const { repo, base } = project;
  const first = loopRecord(project);
  const early = fullRun(repo);
  extendLoop(repo, CHANGE, { iterations: 2, minutes: 30 });
  const replaced = loopRecord(project);
  assert.equal(replaced.extensions.length, 1);
  assert.deepEqual(loopStatus(repo, CHANGE).runs.map((entry) => entry.run_id), [early.run_id]);

  const restarted = cli(['loop', 'start', CHANGE, '--repo', repo, '--restart', '--max-iterations', '3']);
  assert.equal(restarted.status, 0, restarted.stderr);
  const second = loopRecord(project);
  assert.ok(second.started_at > first.started_at, `${second.started_at} after ${first.started_at}`);
  assert.ok(second.started_at > readRecord(early).run.started_at);
  assert.equal(second.clock_started_at, second.started_at);
  assert.deepEqual(second.extensions, []);
  assert.deepEqual(second.budget, { iterations: 3, minutes: 60 });
  assert.equal(second.spec, first.spec);
  assert.equal(second.baseline, base.run_id);
  assert.deepEqual(second.start_code, first.start_code);
  assert.deepEqual(second.previous, [withoutKey(replaced, 'previous')]);

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.started_at, second.started_at);
  assert.deepEqual(status.runs, []);
  assert.equal(status.loop.used.iterations, 0);
  assert.equal(status.next.action, 'iterate');
  const late = fullRun(repo);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [late.run_id]);
  assert.equal(status.loop.used.iterations, 1);

  // A second restart keeps both replaced loops, neither with a previous of its own.
  startLoop(repo, CHANGE, { restart: true });
  const third = loopRecord(project);
  assert.deepEqual(third.previous, [withoutKey(replaced, 'previous'), withoutKey(second, 'previous')]);
  assert.ok(third.previous.every((entry) => !('previous' in entry)), JSON.stringify(third.previous));
  assert.deepEqual(loopStatus(repo, CHANGE).runs, []);
});

// L2 and L3: loop extend and the budget clock.

test('loop extend needs a running loop and follows the budget rules of loop start, with 5 runs and 60 minutes by default', (t) => {
  const project = withBaseline(t);
  const { repo } = project;
  assert.throws(() => extendLoop(repo, CHANGE), refusedWith('loop_missing'));
  const missing = cli(['loop', 'extend', CHANGE, '--repo', repo]);
  assert.equal(missing.status, 1, missing.stdout);
  assert.ok(codes(missing.json.gaps).includes('loop_missing'), missing.stderr);
  assert.equal(existsSync(loopPath(project)), false);

  startLoop(repo, CHANGE, { iterations: 2, minutes: 20 });
  const written = readFileSync(loopPath(project), 'utf8');
  for (const iterations of [0, -1, 1.5, Number.NaN]) assert.throws(() => extendLoop(repo, CHANGE, { iterations }), BUDGET_RULE);
  for (const minutes of [0, -5, Number.NaN]) assert.throws(() => extendLoop(repo, CHANGE, { minutes }), BUDGET_RULE);
  for (const flags of [['--max-iterations', 'two'], ['--max-iterations', '0'], ['--max-minutes', '0'], ['--max-minutes', 'soon']]) {
    const refused = cli(['loop', 'extend', CHANGE, '--repo', repo, ...flags]);
    assert.equal(refused.status, 1, `${flags.join(' ')}: ${refused.stdout}`);
    assert.match(refused.json.error, BUDGET_RULE);
  }
  assert.equal(readFileSync(loopPath(project), 'utf8'), written);

  extendLoop(repo, CHANGE);
  const loop = loopRecord(project);
  assert.deepEqual(loop.budget, { iterations: 5, minutes: 60 });
  assert.deepEqual(loop.extensions.map(brief), [{ runs_used: 0, iterations: 5, minutes: 60 }]);
});

test('loop extend after the runs are used up adds N runs to the full runs used and M minutes from now, keeps the loop and its runs, and lets it go on', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  // A partial run is a quick look, not one of the budget's full runs.
  startRun(repo, CHANGE, { case: [FAILURE] });
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assertStopBudget(status.next, repo);
  const before = loopRecord(project);

  const from = new Date().toISOString();
  const extended = cli(['loop', 'extend', CHANGE, '--repo', repo, '--max-iterations', '2', '--max-minutes', '30']);
  const to = new Date().toISOString();
  assert.equal(extended.status, 0, extended.stderr);
  const loop = loopRecord(project);
  assert.deepEqual(loop.budget, { iterations: 3, minutes: 30 });
  assert.ok(loop.clock_started_at >= from && loop.clock_started_at <= to, `${loop.clock_started_at} not in ${from}..${to}`);
  assert.equal(loop.extensions.length, 1);
  const [extension] = loop.extensions;
  assert.deepEqual(Object.keys(extension).sort(), ['at', 'iterations', 'minutes', 'runs_used']);
  assert.deepEqual(brief(extension), { runs_used: 1, iterations: 2, minutes: 30 });
  assert.ok(extension.at >= from && extension.at <= to, `${extension.at} not in ${from}..${to}`);
  for (const key of ['started_at', 'spec', 'baseline', 'baseline_available', 'base_commit', 'start_code', 'task_digest']) {
    assert.deepEqual(loop[key], before[key], key);
  }

  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.partial_runs, 1);
  assert.equal(status.loop.used.iterations, 1);
  assert.deepEqual(status.loop.budget, { iterations: 3, minutes: 30 });
  assert.equal(status.next.action, 'iterate');

  // A second extension is appended and counts from the runs used by then.
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'second attempt');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  extendLoop(repo, CHANGE, { iterations: 1, minutes: 10 });
  const again = loopRecord(project);
  assert.deepEqual(again.budget, { iterations: 3, minutes: 10 });
  assert.equal(again.extensions.length, 2);
  assert.deepEqual(again.extensions[0], extension);
  assert.deepEqual(brief(again.extensions[1]), { runs_used: 2, iterations: 1, minutes: 10 });
  assert.deepEqual(loopStatus(repo, CHANGE).runs.map((entry) => entry.run_id), [run.run_id, second.run_id]);
});

test('loop status counts minutes from the budget clock, or from started_at in an older loop.json without one, and loop extend restarts the clock', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo } = project;
  near(loopStatus(repo, CHANGE).loop.used.minutes, 0);

  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(30); });
  near(loopStatus(repo, CHANGE).loop.used.minutes, 30);

  // The clock counts, not the start of the loop.
  editLoop(project, (loop) => { loop.started_at = minutesAgo(120); loop.clock_started_at = minutesAgo(10); });
  let status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 10);
  assert.equal(status.next.action, 'iterate');

  // A loop.json written before the clock existed counts from started_at.
  const started = minutesAgo(90);
  editLoop(project, (loop) => { delete loop.clock_started_at; loop.started_at = started; });
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 90);
  assertStopBudget(status.next, repo);

  // Raising the budget gives M minutes from now.
  extendLoop(repo, CHANGE, { iterations: 1, minutes: 15 });
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 0);
  assert.deepEqual(status.loop.budget, { iterations: 1, minutes: 15 });
  assert.equal(status.next.action, 'iterate');
  assert.equal(loopRecord(project).started_at, started);
});

test('an edited Spec that was not exported asks to repair it, not to restart, a new export asks to restart, and neither loop can be extended', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const written = readFileSync(loopPath(project), 'utf8');

  writeSpec(repo, REVISED);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'repair_spec', JSON.stringify(status.next));
  assert.throws(() => extendLoop(repo, CHANGE), blockedWith('spec_changed'));
  const refused = cli(['loop', 'extend', CHANGE, '--repo', repo]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.code, 'LOOP_INPUT_BLOCKED');
  assert.ok(codes(refused.json.gaps).includes('spec_changed'), refused.stderr);

  // The exported Spec put back resumes the loop.
  writeSpec(repo, SPECS.two);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');

  writeSpec(repo, REVISED);
  exportSpec(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'restart', JSON.stringify(status.next));
  assert.throws(() => extendLoop(repo, CHANGE, { iterations: 2 }), blockedWith('spec_changed'));
  assert.equal(readFileSync(loopPath(project), 'utf8'), written);
});

// L4: the order of next.action.

test('a full run that did not complete asks to repair execution, and stops on budget once the runs are used up', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'break the environment');
  const first = startRun(repo, CHANGE);
  assert.equal(first.execution_status, 'error');
  assert.equal(first.scope, 'full');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.next.action, 'repair_execution', JSON.stringify(status.next));

  const second = startRun(repo, CHANGE);
  assert.equal(second.execution_status, 'error');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 2);
  assertStopBudget(status.next, repo);
  assert.equal(status.next.owner, 'user');

  extendLoop(repo, CHANGE, { iterations: 1 });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'repair_execution');
});

test('with the budget used up, a passing run still asks for its report, its review and acceptance before the budget stops it', (t) => {
  const { repo } = inLoop(t, { iterations: 1 });
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.next.action, 'write_report');
  completeReport(repo, run.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');
  completeReport(repo, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance');
  assert.equal(status.next.owner, 'user');
});

test('with the budget used up, a regression stops on budget, and loop extend lets the loop go on to split the changes', (t) => {
  const { repo } = inLoop(t, { iterations: 1 });
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice');
  const run = fullRun(repo);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'write_report');
  completeReport(repo, run.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions, [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assertStopBudget(status.next, repo);

  extendLoop(repo, CHANGE, { iterations: 1 });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'split_changes');
  assert.match(status.next.message, /submit-success-s1\/c1/);
});

test('with the budget used up, a stuck loop stops on budget, and once extended it stops as stuck', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  changeCode(repo, BEFORE, 'first attempt');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, BEFORE, 'second attempt');
  completeReport(repo, fullRun(repo).run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assertStopBudget(status.next, repo);

  extendLoop(repo, CHANGE, { iterations: 3 });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_stuck');
  assert.equal(status.next.owner, 'user');
});

// L5: regressions and lost progress compare the same package only.

test('a check that passed in the baseline and fails after its package changed and was checked again is not a regression', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  assert.deepEqual(loopStatus(repo, CHANGE).checks.map((entry) => [entry.case, entry.check, entry.baseline_comparable]), [
    [FAILURE, 'c1', true], [SUCCESS, 'c1', true], [SUCCESS, 'c2', true],
  ]);

  changePackage(project, SUCCESS);
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'fail');
  completeReport(repo, run.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.changed_packages, [SUCCESS]);
  assert.deepEqual(status.checks.map((entry) => [entry.case, entry.check, entry.baseline_comparable, entry.runs]), [
    [FAILURE, 'c1', true, ['pass']], [SUCCESS, 'c1', false, ['fail']], [SUCCESS, 'c2', false, ['pass']],
  ]);
  assert.deepEqual(status.regressions, []);
  assert.notEqual(status.next.action, 'split_changes');
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
});

test('a check that passed in the run before and fails after its package changed is neither a regression nor lost progress', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'fix the failure notice');
  const first = fullRun(repo);
  assert.equal(first.verdict, 'pass');
  completeReport(repo, first.run_id);

  changePackage(project, FAILURE);
  changeCode(repo, BEFORE, 'undo the fix by accident');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.checks.find((entry) => entry.case === FAILURE).runs, ['pass', 'fail']);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, []);
  assert.ok(!status.warnings.some((warning) => /Passed in the run before/.test(warning)), JSON.stringify(status.warnings));
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
});

test('without a baseline result, a check that passed in the run before and fails now is a regression only while its package is unchanged', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.execution_status, 'not_run');
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'first version');
  const first = fullRun(repo);
  assert.equal(first.verdict, 'pass');
  completeReport(repo, first.run_id);

  // The package changed between the two runs: their results are not comparable.
  changePackage(project, SUCCESS);
  changeCode(repo, BROKEN, 'second version');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.ok(status.checks.every((entry) => entry.baseline_comparable === false), JSON.stringify(status.checks));
  assert.deepEqual(status.regressions, []);
  assert.notEqual(status.next.action, 'split_changes');

  // The same package passing, then failing: a regression.
  changeCode(repo, AFTER, 'third version');
  const third = fullRun(repo);
  assert.equal(third.verdict, 'pass');
  completeReport(repo, third.run_id);
  changeCode(repo, BROKEN, 'fourth version');
  const fourth = fullRun(repo);
  completeReport(repo, fourth.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions, [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assert.equal(status.next.action, 'split_changes');
});

// L6: acceptance belongs to one loop.

test('after acceptance loop status reports done with who accepted, even with the budget used up, and warns once the code moves past the accepted run', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.equal(record.loop_started_at, loopRecord(project).started_at);

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.deepEqual(status.accepted, { run_id: run.run_id, by: 'Dana', ref: 'review thread 12', at: record.accepted.at });
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
  const shown = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.next.action, 'done');

  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'an edit after the acceptance\n');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.ok(status.warnings.some((warning) => /acceptance covers that run's code only/i.test(warning)), JSON.stringify(status.warnings));
  rmSync(scratch);

  // The Spec comes before acceptance: an edit without export, then a new export.
  writeSpec(repo, REVISED);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'repair_spec');
  exportSpec(repo, CHANGE);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'restart');
  writeSpec(repo, SPECS.two);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  // Acceptance comes before a later run that did not complete.
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'an edit after the acceptance');
  assert.equal(startRun(repo, CHANGE).execution_status, 'error');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.accepted.run_id, run.run_id);
});

test('a restarted loop can accept its own passing run, and each acceptance keeps the ones before it under earlier', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  const acceptIn = (label, by) => {
    editApp(repo, AFTER, label);
    const run = fullRun(repo);
    assert.equal(run.verdict, 'pass');
    completeReport(repo, run.run_id);
    acceptLoop(repo, CHANGE, { run: run.run_id, by, ref: `${label} thread` });
    const record = readJSON(file);
    assert.equal(record.run_id, run.run_id);
    assert.equal(record.loop_started_at, loopRecord(project).started_at);
    const status = loopStatus(repo, CHANGE);
    assert.equal(status.next.action, 'done');
    assert.deepEqual(status.accepted, { run_id: run.run_id, by, ref: `${label} thread`, at: record.accepted.at });
    return record;
  };
  const restart = () => {
    restoreStart(project);
    startLoop(repo, CHANGE, { restart: true });
    const status = loopStatus(repo, CHANGE);
    assert.equal(status.accepted, null);
    assert.equal(status.next.action, 'iterate');
  };

  const first = acceptIn('first loop', 'Dana');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'again' }), refusedWith('already_accepted'));
  restart();
  const second = acceptIn('second loop', 'Lee');
  assert.deepEqual(second.earlier, [withoutKey(first, 'earlier')]);
  restart();
  const third = acceptIn('third loop', 'Kim');
  assert.deepEqual(third.earlier, [withoutKey(first, 'earlier'), withoutKey(second, 'earlier')]);
  assert.ok(third.earlier.every((entry) => !('earlier' in entry)), JSON.stringify(third.earlier));
});

test('a loop for a newly exported Spec can accept its own passing run, and the record keeps the earlier Spec\'s acceptance under earlier', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  editApp(repo, AFTER, 'first Spec');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'thread 1' });
  const earlier = readJSON(file);

  restoreStart(project);
  const exported = exportRevision(project);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'restart');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  startLoop(repo, CHANGE, { restart: true });
  const loop = loopRecord(project);
  assert.equal(loop.spec, exported.id);
  assert.equal(loop.baseline, base.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted, null);
  assert.equal(status.next.action, 'iterate');

  editApp(repo, AFTER, 'second Spec');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  acceptLoop(repo, CHANGE, { run: second.run_id, by: 'Lee', ref: 'thread 2' });
  const record = readJSON(file);
  assert.equal(record.run_id, second.run_id);
  assert.equal(record.spec.sha256, exported.id);
  assert.equal(record.loop_started_at, loop.started_at);
  assert.deepEqual(record.earlier, [withoutKey(earlier, 'earlier')]);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.accepted.run_id, second.run_id);
});

test('an accepted.json without loop_started_at belongs to a loop when its Spec matches and its run is one of that loop\'s runs', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  const save = (record) => writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  editApp(repo, AFTER, 'the fix');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const legacy = withoutKey(readJSON(file), 'loop_started_at');

  save(legacy);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.accepted, { run_id: run.run_id, by: 'Dana', ref: 'thread 1', at: legacy.accepted.at });
  assert.equal(status.next.action, 'done');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('already_accepted'));

  // Another Spec, or a run this loop never made, is not this loop's acceptance.
  save({ ...legacy, spec: { ...legacy.spec, sha256: `sha256:${'0'.repeat(64)}` } });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted, null);
  assert.equal(status.next.action, 'ask_acceptance');
  save({ ...legacy, run_id: '20990101-000000-0000' });
  assert.equal(loopStatus(repo, CHANGE).accepted, null);

  // After a restart the run it names belongs to the loop before.
  save(legacy);
  restoreStart(project);
  startLoop(repo, CHANGE, { restart: true });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted, null);
  assert.equal(status.next.action, 'iterate');
  editApp(repo, AFTER, 'the fix again');
  const again = fullRun(repo);
  completeReport(repo, again.run_id);
  acceptLoop(repo, CHANGE, { run: again.run_id, by: 'Lee', ref: 'thread 3' });
  const record = readJSON(file);
  assert.equal(record.run_id, again.run_id);
  assert.deepEqual(record.earlier, [legacy]);
});

// L7: code in the loop moves impact.md evidence.

test('code in the loop that moves a file impact.md evidence points to keeps the exported Spec: loop status, run start and workflow check go on, and run start and workflow check warn', (t) => {
  const project = impactLoop(t);
  const { repo, loop } = project;
  renameSync(path.join(repo, 'app/notify.py'), path.join(repo, 'app/notifier.py'));
  setResults(repo, AFTER);
  commit(repo, 'Move the notifier and stop the success notice on failure');
  // The working tree no longer holds the evidence the export recorded.
  const strict = validateSpec(repo, CHANGE);
  assert.ok(strict.gaps.some((entry) => entry.code === 'impact_invalid' && entry.working_tree), JSON.stringify(strict.gaps));

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));

  const checked = cli(['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(checked.json.status, 'ready');
  assert.deepEqual(checked.json.gaps, []);
  assert.equal(checked.json.next.action, 'loop_status');
  assert.match(checked.json.warnings.join('\n'), MOVED);

  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  assert.match(run.warnings.join('\n'), MOVED);
  const record = runRecord(project, run);
  assert.equal(record.spec_snapshot.sha256, loop.spec);
  assert.equal(record.baseline, loop.baseline);

  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.next.action, 'write_report', JSON.stringify(status.next));
});

test('code in the loop that deletes a file impact.md evidence points to keeps the loop on the same exported Spec', (t) => {
  const project = impactLoop(t);
  const { repo, loop } = project;
  rmSync(path.join(repo, 'app/notify.py'));
  setResults(repo, AFTER);

  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');
  const checked = cli(['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(checked.json.next.action, 'loop_status');
  assert.match(checked.json.warnings.join('\n'), MOVED);

  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  assert.match(run.warnings.join('\n'), MOVED);
  assert.equal(runRecord(project, run).spec_snapshot.sha256, loop.spec);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
});

test('loop status warns that impact.md evidence no longer matches the code once code in the loop deleted the file it points to', (t) => {
  const project = impactLoop(t);
  const { repo } = project;
  rmSync(path.join(repo, 'app/notify.py'));
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate');
  assert.ok(status.warnings.some((warning) => MOVED.test(warning)), JSON.stringify(status.warnings));
});

// --- Found in review: the loop's pinned baseline everywhere, restarts that keep
// the starting code, and how to get back to it. ---

test('workflow checks follow the loop baseline when a later baseline attempt on the starting code did not run', (t) => {
  const { repo, root, base } = inLoop(t);
  // A kit edit makes every package stale, so this baseline attempt is blocked.
  const harness = path.join(root, '..', 'harness', 'harness.json');
  writeFileSync(harness, `${JSON.stringify({ agent: AGENT, note: 'reads both output streams' })}\n`);
  const attempt = startRun(repo, CHANGE, { baseline: true });
  assert.equal(attempt.execution_status, 'blocked');
  assert.match(attempt.next, /Execution did not complete/);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  changeCode(repo, AFTER, 'Fix the failed submission');

  const loopCheck = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(loopCheck.status, 'ready', JSON.stringify(loopCheck.gaps));
  assert.equal(loopCheck.next.action, 'loop_status');
  const runCheck = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(runCheck.next.action, 'run_eval', JSON.stringify(runCheck.next));
  assert.equal(runRecord({ runs: path.join(root, 'runs') }, fullRun(repo)).base_run, base.run_id);
});

test('a base record on the starting code says the loop still compares with its own baseline', (t) => {
  const { repo, base } = inLoop(t);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  assert.match(again.next, new RegExp(`still compares every run with ${base.run_id}`));
  assert.doesNotMatch(again.next, /later runs are compared with this baseline/);
});

test('a restart keeps the starting code, so it starts over from changed code with a baseline recorded on that code', (t) => {
  const { repo, base, loop } = inLoop(t);
  changeCode(repo, BROKEN, 'First attempt');
  fullRun(repo);
  const restarted = startLoop(repo, CHANGE, { restart: true }).loop;
  assert.deepEqual(restarted.start_code, loop.start_code);
  assert.equal(restarted.base_commit, loop.start_code.commit);
  assert.equal(restarted.baseline, base.run_id);
  assert.equal(loopStatus(repo, CHANGE).runs.length, 0);
  // Every base record of the restarted loop still has to be on that code.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'execution_blocked' }), refusedWith('baseline_after_change'));
});

test('a loop that starts on uncommitted code keeps it as loop-start.patch, and the baseline refusal points there', (t) => {
  const { repo, root } = readyProject(t);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.start_code.patch, 'loop-start.patch');
  assert.ok(existsSync(path.join(root, 'loop-start.patch')));
  assert.match(readFileSync(path.join(root, '..', '.gitignore'), 'utf8'), /^\/\*\/loop-start\.patch$/m);

  changeCode(repo, AFTER, 'Change the handler');
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    const refusal = error.gaps.find((entry) => entry.code === 'baseline_after_change');
    assert.ok(refusal.message.includes(`commit ${loop.start_code.commit} plus \`git apply\` .genesis/edd/${CHANGE}/loop-start.patch`), refusal.message);
    return true;
  });

  // That commit plus the patch is the starting code again.
  const clone = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-start-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', loop.start_code.commit]);
  git(clone, ['apply', path.join(root, 'loop-start.patch')]);
  assert.equal(readFileSync(path.join(clone, 'app/handler.txt'), 'utf8'), 'the code before the change\n');
  assert.equal(codeSnapshot(clone).snapshot.digest, loop.start_code.digest);
});

test('a commit that changes no content is not a code change: the loop takes a base record and a restart on it, and accepts a run committed after it ran', (t) => {
  const { repo } = readyProject(t);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.start_code.digest_of, 'content');
  commit(repo, 'Commit the starting code');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), loop.start_code.commit);
  assert.equal(codeSnapshot(repo).snapshot.digest, loop.start_code.digest);

  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  const restarted = startLoop(repo, CHANGE, { restart: true }).loop;
  assert.equal(restarted.baseline, again.run_id);
  assert.deepEqual(restarted.start_code, loop.start_code);

  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  commit(repo, 'Stop the success notice when a submission fails');
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
});

test('two full runs on the same content warn that nothing new was tried, even when a commit lies between them', (t) => {
  const { repo } = inLoop(t);
  editApp(repo, BROKEN, 'First attempt');
  fullRun(repo);
  commit(repo, 'First attempt');
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.some((warning) => /last two runs used the same code/.test(warning)), JSON.stringify(status.warnings));
  assert.notEqual(status.next.action, 'stop_stuck');
});

test('a baseline recorded before the digest covered content only still starts a loop when it ran on a clean commit', (t) => {
  const project = withBaseline(t);
  const file = path.join(project.runs, project.base.run_id, 'run.json');
  const record = readJSON(file);
  assert.deepEqual(record.code_snapshot.changed_files, []);
  record.code_snapshot = withoutKey({ ...record.code_snapshot, digest: 'sha256:from-the-commit-and-its-changes' }, 'digest_of');
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const { loop } = startLoop(project.repo, CHANGE);
  assert.equal(loop.baseline, project.base.run_id);
  assert.equal(loop.start_code.digest, codeSnapshot(project.repo).snapshot.digest);
});

test('an edited Spec that was not exported is repaired in agent-spec, never exported from inside the loop', (t) => {
  const { repo } = inLoop(t);
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2'));
  const { next } = loopStatus(repo, CHANGE);
  assert.equal(next.action, 'repair_spec');
  assert.equal(next.route, 'agent-spec');
  assert.equal(next.owner, 'agent');
  assert.match(next.message, /differ from the export this loop started from/);
  assert.doesNotMatch(next.message, /Export the current/);
});

test('the Changes section lists both paths of a committed rename and not a file committed unchanged under a line-ending filter', (t) => {
  const { repo } = readyProject(t);
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt text eol=crlf\n');
  writeFileSync(path.join(repo, 'app/old-name.txt'), 'a module that moves\r\n');
  commit(repo, 'Add a module');
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the handler\r\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  git(repo, ['mv', 'app/old-name.txt', 'app/new-name.txt']);
  commit(repo, 'Rename the module and commit the handler as it was');
  fullRun(repo);
  const report = readFileSync(writeReport(repo, CHANGE).file, 'utf8');
  assert.ok(report.includes(`Files changed since the baseline ${base.run_id}:\n- \`app/new-name.txt\`\n- \`app/old-name.txt\`\n\n## Next`), report);
});

test('a missing loop baseline blocks workflow check run-eval too, and the restore hint names the loop\'s commit', (t) => {
  const { repo, base, loop } = inLoop(t);
  rmSync(base.directory, { recursive: true, force: true });
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.status, 'blocked');
  assert.ok(codes(check.gaps).includes('loop_baseline_missing'), JSON.stringify(check.gaps));
  assert.equal(check.next.route, 'run-eval');
  assert.match(loopStatus(repo, CHANGE).warnings.join('\n'), /no longer in runs/);

  // A loop.json from before start_code was recorded still names its commit.
  const file = path.join(repo, '.genesis/edd', CHANGE, 'loop.json');
  const { start_code: _, ...older } = readJSON(file);
  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
  const gap = checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((entry) => entry.code === 'loop_baseline_missing');
  assert.ok(gap.message.includes(`commit ${loop.base_commit}`), gap.message);
});

test('after acceptance the minutes stop at the acceptance, and done offers a commit until the accepted code is committed', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo, root } = project;
  // The change is left uncommitted when it runs and is accepted.
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'Stop the success notice when a submission fails\n');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const result = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  assert.equal(result.commit, undefined);
  assert.match(result.next, /Offer to commit the change/);

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, undefined);
  assert.match(status.next.message, /Offer to commit the change/);

  // The clock stops when the user accepts, however long ago that was.
  const accepted = readJSON(path.join(root, 'accepted.json'));
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(50); });
  accepted.accepted.at = minutesAgo(43);
  writeFileSync(path.join(root, 'accepted.json'), `${JSON.stringify(accepted, null, 2)}\n`);
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 7);
  assert.equal(status.next.action, 'done');

  // Committing the accepted code leaves only a merge or a pull request.
  const head = commit(repo, 'Stop the success notice when a submission fails');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, head);
  assert.match(status.next.message, new RegExp(`committed in ${head.slice(0, 7)}`));
  assert.doesNotMatch(status.next.message, /Offer to commit/);
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));

  // A later edit is not covered by the acceptance, committed or not.
  writeFileSync(path.join(repo, 'app/handler.txt'), 'another edit\n');
  commit(repo, 'Another edit');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.commit, undefined);
  assert.ok(status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
});

test('without the accepted run folder, loop status still tells whether the code moved past the accepted run, also for an older record', (t) => {
  const project = inLoop(t);
  const { repo, root, runs } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const file = path.join(root, 'accepted.json');
  const record = readJSON(file);
  assert.equal(record.code_digest_of, 'content');
  rmSync(path.join(runs, run.run_id), { recursive: true });

  const moved = () => loopStatus(repo, CHANGE).warnings.some((warning) => /covers that run's code only/.test(warning));
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');
  assert.equal(moved(), false);
  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'an edit after the acceptance\n');
  assert.equal(moved(), true);
  rmSync(scratch);

  // A record written before code_digest_of compares by its commit, since the
  // accepted run had nothing uncommitted.
  const { code_digest_of: kind, ...older } = record;
  assert.equal(kind, 'content');
  writeFileSync(file, `${JSON.stringify({ ...older, code_digest: 'sha256:digest-of-commit-and-files' }, null, 2)}\n`);
  assert.equal(moved(), false);
  writeFileSync(scratch, 'an edit after the acceptance\n');
  assert.equal(moved(), true);
});

test('once a run of the loop is accepted, workflow check run-eval points at loop status instead of another run', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'run_eval');
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.status, 'ready');
  assert.equal(check.next.action, 'loop_done');
  assert.deepEqual(check.next.command, ['loop', 'status', CHANGE, '--repo', repo]);
  assert.match(check.next.note, new RegExp(run.run_id));

  // A finished loop needs no Docker: stopping it afterwards blocks nothing.
  project.tools.docker(false);
  const stopped = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(stopped.status, 'ready', JSON.stringify(stopped.gaps));
  assert.equal(stopped.next.action, 'loop_done');
  project.tools.docker(true);

  // A new export starts a new loop; the old acceptance does not finish it.
  exportRevision(project);
  const revised = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(revised.status, 'ready', JSON.stringify(revised.gaps));
  assert.equal(revised.next.action, 'record_baseline');
});

test('an acceptance of uncommitted code still tells whether the code moved once the run folder is gone', (t) => {
  const project = inLoop(t);
  const { repo, root, runs } = project;
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'Stop the success notice when a submission fails\n');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.ok(record.uncommitted_files.length, JSON.stringify(record));
  assert.equal(record.code_digest_of, 'content');
  rmSync(path.join(runs, run.run_id), { recursive: true });

  const moved = () => loopStatus(repo, CHANGE).warnings.some((warning) => /covers that run's code only/.test(warning));
  assert.equal(moved(), false);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'another edit\n');
  assert.equal(moved(), true);
});

test('the report marks each check gating or diagnostic and says only gating checks decide', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'evals', SUCCESS, 'tests/checks.json');
  const declared = readJSON(file);
  declared.checks = declared.checks.map((check) => (check.id === 'c2' ? { ...check, role: 'diagnostic' } : check));
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  checkEval(repo, CHANGE, { case: SUCCESS });
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.deepEqual(run.compare_gating, { holds: 1, violated: 0, base_mismatch: 0, head_only: 1, unverified: 0 });
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.match(text, /Only gating checks decide the verdict/);
  assert.match(text, /^\| Case \| Check \| Requirement \| Role \| Before \| After \| Verdict \|$/m);
  assert.match(text, /^\| submit-success-s1 \| c2 \| REQ-submit-success \| diagnostic \| — \| pass \| head_only \|$/m);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  assert.deepEqual(readJSON(path.join(root, 'accepted.json')).checks.map((entry) => [entry.case, entry.check, entry.role]), [
    ['submit-failure-s1', 'c1', 'gating'], ['submit-success-s1', 'c1', 'gating'], ['submit-success-s1', 'c2', 'diagnostic'],
  ]);
});
