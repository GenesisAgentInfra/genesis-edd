import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { checkEval, codeSnapshot, readCounts, runTools, sameCode, savePatch, startRun } from '../src/run.js';
import { loopStatus, startLoop } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FAKE_HARBOR_VERSION, LIVE_DEPENDENCY, cli, commit, confirmChecks, connect, dropCheck, editChecks, git, harborThen, readRecord,
  readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import {
  FAILURE, SUCCESS, runIds, rows, find, tally, sha256, valueOf, refused, scratch, tree,
} from './helpers/run.js';

test('a head run is refused until a baseline is recorded, and workflow check suggests recording one', (t) => {
  const { repo, tools, runs } = readyProject(t);
  const calls = tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE), refused('baseline_missing'));
  assert.deepEqual(runIds(runs), []);
  assert.equal(tools.runs().length, calls);

  const refusal = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(refusal.status, 1);
  assert.equal(refusal.json.code, 'RUN_INPUT_BLOCKED');
  assert.deepEqual(refusal.json.gaps.map((gap) => gap.code), ['baseline_missing']);
  assert.equal(refusal.json.gaps[0].route, 'run-eval');
  assert.deepEqual(refusal.json.resume.command, ['workflow', 'check', 'run-eval', CHANGE, '--repo', repo]);
  assert.deepEqual(runIds(runs), []);

  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.status, 'ready');
  assert.equal(workflow.next.action, 'record_baseline');
  assert.deepEqual(workflow.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
});

test('a baseline attempt that errored does not count: head runs are still refused and the baseline is still suggested', (t) => {
  const { repo, runs } = readyProject(t, { results: { ...BEFORE, [SUCCESS]: 'error' } });
  const attempt = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.equal(attempt.status, 1, attempt.stderr);
  assert.equal(attempt.json.execution_status, 'error');
  assert.equal(attempt.json.is_baseline, false);
  assert.equal(attempt.json.baseline_unavailable_reason, 'execution_blocked');
  const byCase = Object.fromEntries(attempt.json.cases.map((item) => [item.id, item.execution]));
  assert.deepEqual(byCase[FAILURE], { status: 'completed' });
  assert.equal(byCase[SUCCESS].status, 'error');
  assert.match(byCase[SUCCESS].reason, /0 of 1 trial results \(exit 1\)/);
  assert.equal(readRecord(path.join(runs, attempt.json.run_id)).run.is_baseline, false);

  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('baseline_missing')(error);
    assert.ok(error.gaps[0].message.startsWith(`The last baseline attempt, ${attempt.json.run_id}, did not run; fix the cause and record it again.`), error.gaps[0].message);
    return true;
  });
  const head = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(head.status, 1);
  assert.deepEqual(head.json.gaps.map((gap) => gap.code), ['baseline_missing']);
  assert.deepEqual(runIds(runs), [attempt.json.run_id]);

  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.next.action, 'record_baseline');
  assert.deepEqual(workflow.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
});

test('a baseline with no runnable package is blocked, executes nothing and does not count', (t) => {
  const { repo, tools } = readyProject(t, { unconnected: [FAILURE, SUCCESS] });
  assert.deepEqual(tools.calls(), []);
  const base = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.equal(base.status, 1, base.stderr);
  assert.equal(base.json.execution_status, 'blocked');
  assert.equal(base.json.is_baseline, false);
  assert.deepEqual(base.json.cases, []);
  assert.deepEqual(base.json.skipped.map(({ case: id, reason, missing }) => [id, reason, missing]),
    [[FAILURE, 'awaiting_integration', ['instruction']], [SUCCESS, 'awaiting_integration', ['instruction']]]);
  assert.deepEqual(tools.calls(), []);
  assert.throws(() => startRun(repo, CHANGE), refused('baseline_missing'));

  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.status, 'blocked');
  assert.ok(workflow.gaps.some((gap) => gap.code === 'no_runnable_case'), JSON.stringify(workflow.gaps));
});

test('an unavailable baseline records not_run without running anything, and head runs compare with no baseline result', (t) => {
  const { repo, tools, runs } = readyProject(t, { mode: 'new', results: {} });
  // Nothing is probed or executed, so it works with Docker down and Harbor missing.
  tools.docker(false);
  tools.harbor(false);
  const calls = tools.calls().length;
  const base = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', 'no_implementation']);
  assert.equal(base.status, 0, base.stderr);
  assert.equal(base.json.execution_status, 'not_run');
  assert.equal(base.json.is_baseline, false);
  assert.equal(base.json.baseline_unavailable_reason, 'no_implementation');
  assert.deepEqual(base.json.cases, []);
  assert.deepEqual(base.json.baseline_mismatch, []);
  assert.equal(tools.calls().length, calls);
  const directory = path.join(runs, base.json.run_id);
  assert.deepEqual(readdirSync(directory), ['run.json']);
  const { run, compare } = readRecord(directory);
  assert.equal(run.side, 'base');
  assert.equal(run.verdict, null);
  assert.deepEqual([run.environment_ref.harbor, run.environment_ref.agent, run.environment_ref.model], [null, null, null]);
  // What the packages and the kit held is recorded even though nothing ran.
  assert.deepEqual(Object.keys(run.eval_snapshot.packages), [FAILURE, SUCCESS]);
  assert.ok('harness.json' in run.eval_snapshot.kit, JSON.stringify(run.eval_snapshot.kit));
  assert.equal(run.packages_changed_during_run, false);
  assert.equal(compare, null);

  tools.docker(true);
  tools.harbor(true);
  // Nothing ran, so any code is the code before the change: the loop starts next.
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');

  // A failure the head run proves is a violation even with no baseline result.
  setResults(repo, BEFORE);
  commit(repo, 'Add a first implementation');
  const first = startRun(repo, CHANGE);
  assert.equal(first.execution_status, 'completed', JSON.stringify(first));
  assert.equal(first.verdict, 'fail');
  assert.equal(first.baseline, null);
  assert.equal(first.baseline_unavailable_reason, 'no_implementation');
  const firstRecord = readRecord(first);
  assert.equal(firstRecord.run.baseline, null);
  assert.equal(firstRecord.compare.baseline, null);
  assert.deepEqual(rows(firstRecord.compare), [
    [FAILURE, 'c1', null, 'fail', 'violated'],
    [SUCCESS, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c2', null, 'pass', 'head_only'],
  ]);
  assert.ok(firstRecord.compare.results.every((entry) => entry.before_unavailable_reason === 'no_implementation'));

  // With no baseline a run can still pass; every check is head_only.
  setResults(repo, AFTER);
  commit(repo, 'Stop the success notice when a submission fails');
  const second = startRun(repo, CHANGE);
  assert.equal(second.verdict, 'pass');
  assert.deepEqual(second.compare, tally({ head_only: 3 }));
  assert.ok(readRecord(second).compare.results.every((entry) => entry.before === null && entry.before_unavailable_reason === 'no_implementation'));
  assert.match(second.next, /head_only/);
});

test('a baseline records its declared expectations, and a result that differs is a baseline_mismatch that makes the passing head check base_mismatch', (t) => {
  const { repo } = readyProject(t);
  // The success notice already works before the change, so expecting c1 to fail there is wrong.
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'fail', [`${SUCCESS}/c2`]: 'pass' });
  const base = startRun(repo, CHANGE, { baseline: true, expect });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.equal(base.is_baseline, true);
  const mismatch = [{ case: SUCCESS, check: 'c1', expected: 'fail', got: 'pass' }];
  assert.deepEqual(base.baseline_mismatch, mismatch);
  assert.match(base.next, /baseline_mismatch/);
  const { run } = readRecord(base);
  assert.deepEqual(run.baseline_mismatch, mismatch);
  assert.deepEqual(run.baseline_expectations, [
    { case: FAILURE, check: 'c1', expected: 'fail', reason: `Synthetic expectation for ${FAILURE}/c1.` },
    { case: SUCCESS, check: 'c1', expected: 'fail', reason: `Synthetic expectation for ${SUCCESS}/c1.` },
    { case: SUCCESS, check: 'c2', expected: 'pass', reason: `Synthetic expectation for ${SUCCESS}/c2.` },
  ]);

  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.deepEqual(rows(readRecord(head).compare), [
    [FAILURE, 'c1', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', 'pass', 'pass', 'base_mismatch'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);
  assert.deepEqual(head.compare, tally({ holds: 2, base_mismatch: 1 }));
  assert.match(head.next, /base_mismatch/);
});

test('--expect is refused unless it names declared checks with pass, fail or any and a reason, and then nothing runs', (t) => {
  const { repo, tools, runs } = readyProject(t);
  const calls = tools.runs().length;
  const reason = 'Synthetic reason.';
  const invalid = {
    'an unknown check': [{ case: FAILURE, check: 'c9', expected: 'fail', reason }],
    'an unknown package': [{ case: 'no-such-package', check: 'c1', expected: 'fail', reason }],
    'an unknown result': [{ case: FAILURE, check: 'c1', expected: 'maybe', reason }],
    'no reason': [{ case: FAILURE, check: 'c1', expected: 'fail' }],
    'a blank reason': [{ case: FAILURE, check: 'c1', expected: 'fail', reason: '  ' }],
  };
  for (const [label, entries] of Object.entries(invalid)) {
    const expect = writeExpectations(repo, entries);
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, expect }), /--expect needs a JSON array/, label);
  }
  const object = writeExpectations(repo, []);
  writeFileSync(object, `${JSON.stringify({ [`${FAILURE}/c1`]: 'fail' })}\n`);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, expect: object }), /--expect needs a JSON array/);

  const expect = writeExpectations(repo, { [`${FAILURE}/c9`]: 'fail' });
  const refusal = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', expect]);
  assert.equal(refusal.status, 1);
  assert.match(refusal.json.error, /--expect needs a JSON array/);
  assert.deepEqual(runIds(runs), []);
  assert.equal(tools.runs().length, calls);
});

test('--expect, --case and --unavailable are refused on the wrong side of a run', (t) => {
  const { repo, tools, runs } = readyProject(t);
  const calls = tools.runs().length;
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail' });
  assert.throws(() => startRun(repo, CHANGE, { expect }), /--expect belongs to a baseline that actually runs/);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation', expect }), /--expect belongs to a baseline that actually runs/);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, case: [FAILURE] }), /--case belongs to a head run/);
  assert.throws(() => startRun(repo, CHANGE, { unavailable: 'no_implementation' }), /--unavailable belongs to --baseline/);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'not_today' }), /must be one of no_implementation, execution_blocked, incompatible_tasks/);

  for (const args of [['--expect', expect], ['--baseline', '--case', FAILURE], ['--unavailable', 'no_implementation']]) {
    const result = cli(['run', 'start', CHANGE, '--repo', repo, ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.json.error, /belongs to/);
  }
  assert.deepEqual(runIds(runs), []);
  assert.equal(tools.runs().length, calls);
});

test('a passing head check holds against the baseline, and each run is written once in its own folder that Git ignores', (t) => {
  const { repo, root, runs } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.is_baseline, true);
  const baseText = readFileSync(path.join(base.directory, 'run.json'), 'utf8');
  for (const id of [FAILURE, SUCCESS]) {
    for (const file of ['check-results.json', 'reward.json', 'logs/harbor.log']) assert.ok(existsSync(path.join(base.directory, id, file)), `${id}/${file}`);
  }

  setResults(repo, AFTER);
  const head = commit(repo, 'Stop the success notice when a submission fails');
  const run = startRun(repo, CHANGE);
  assert.equal(run.execution_status, 'completed', JSON.stringify(run));
  assert.equal(run.verdict, 'pass');
  assert.equal(run.baseline, base.run_id);
  assert.deepEqual(run.compare, tally({ holds: 3 }));
  const record = readRecord(run);
  assert.equal(record.run.side, 'head');
  assert.equal(record.run.scope, 'full');
  assert.equal(record.run.is_baseline, false);
  assert.equal(record.run.baseline_unavailable_reason, null);
  assert.equal(record.run.code_version, head);
  assert.equal(record.run.code_snapshot.commit, head);
  assert.deepEqual(record.run.code_snapshot.changed_files, []);
  assert.equal(record.run.code_snapshot.patch, undefined);
  assert.ok(!existsSync(path.join(run.directory, 'code.patch')));
  assert.deepEqual(Object.keys(record.run.task_digest), [FAILURE, SUCCESS]);
  // Each run records the package and kit files it ran, and that none changed meanwhile.
  for (const recorded of [readRecord(base).run, record.run]) {
    assert.equal(recorded.packages_changed_during_run, false);
    assert.deepEqual(Object.keys(recorded.eval_snapshot), ['packages', 'kit']);
    assert.deepEqual(Object.keys(recorded.eval_snapshot.packages), [FAILURE, SUCCESS]);
    assert.ok(Object.keys(recorded.eval_snapshot.packages[SUCCESS]).includes('environment/Dockerfile'), JSON.stringify(recorded.eval_snapshot));
    assert.ok('harness.json' in recorded.eval_snapshot.kit, JSON.stringify(recorded.eval_snapshot.kit));
  }
  assert.equal(record.compare.run_id, run.run_id);
  assert.equal(record.compare.baseline, base.run_id);
  assert.deepEqual(record.compare.results.map(({ case: id, check, intent, role, before, after, verdict }) => [id, check, intent, role, before, after, verdict]), [
    [FAILURE, 'c1', 'REQ-submit-failure', 'gating', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', 'REQ-submit-success', 'gating', 'pass', 'pass', 'holds'],
    [SUCCESS, 'c2', 'REQ-submit-success', 'gating', 'pass', 'pass', 'holds'],
  ]);
  assert.match(find(record.compare, FAILURE, 'c1').evidence, /fake verifier: submit-failure-s1\/c1 attempt 1 is pass/);

  assert.deepEqual(runIds(runs), [base.run_id, run.run_id].sort());
  assert.equal(readFileSync(path.join(base.directory, 'run.json'), 'utf8'), baseText);
  assert.equal(readFileSync(path.join(root, '..', '.gitignore'), 'utf8'), '/*/runs/\n/*/checks/\n/*/loop.json\n/*/loop-start.patch\n__pycache__/\n');
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all']).split('\n');
  assert.ok(status.every((line) => !line.includes('/runs/') && !line.includes('/checks/')), status.join('\n'));
});

test('a failing head check is violated and fails the run whatever reward the verifier wrote, and the CLI exits 0', (t) => {
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  // The verifier claims reward 1 although its gating check failed.
  setResults(repo, { [FAILURE]: { c1: 'fail', $reward: 1 }, [SUCCESS]: { c1: 'pass', c2: 'missing' } });
  const run = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.execution_status, 'completed');
  assert.equal(run.json.verdict, 'fail');
  assert.deepEqual(run.json.compare, tally({ violated: 1, holds: 1, unverified: 1 }));
  const { compare } = readRecord(run.json.directory);
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'fail', 'fail', 'violated'],
    [SUCCESS, 'c1', 'pass', 'pass', 'holds'],
    [SUCCESS, 'c2', 'pass', 'unknown', 'unverified'],
  ]);
  assert.equal(readJSON(path.join(run.json.directory, FAILURE, 'reward.json')).reward, 0);
  assert.ok(run.json.warnings.some((warning) => /submit-failure-s1: the verifier wrote reward 1, but its gating results give 0/.test(warning)), JSON.stringify(run.json.warnings));
  assert.deepEqual(run.json.cases.find((item) => item.id === FAILURE).gating, { pass: 0, fail: 1, unknown: 0 });
});

test('missing or unrecognized evidence is unverified on either side, is never a baseline mismatch, and keeps the run from passing', (t) => {
  const { repo } = readyProject(t, { results: { [FAILURE]: { c1: 'missing' }, [SUCCESS]: { c1: 'pass', c2: 'pass' } } });
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c2`]: 'pass' });
  const base = startRun(repo, CHANGE, { baseline: true, expect });
  assert.equal(base.is_baseline, true);
  assert.deepEqual(base.baseline_mismatch, []);
  const { run } = readRecord(base);
  assert.deepEqual(run.baseline_expectations.map(({ case: id, check, expected }) => [id, check, expected]),
    [[FAILURE, 'c1', 'fail'], [SUCCESS, 'c1', 'any'], [SUCCESS, 'c2', 'pass']]);

  setResults(repo, { [FAILURE]: { c1: 'pass' }, [SUCCESS]: { c1: 'maybe', c2: 'missing' } });
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed');
  assert.equal(head.verdict, 'unverified');
  const { compare } = readRecord(head);
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'unknown', 'pass', 'unverified'],
    [SUCCESS, 'c1', 'pass', 'unknown', 'unverified'],
    [SUCCESS, 'c2', 'pass', 'unknown', 'unverified'],
  ]);
  assert.equal(find(compare, SUCCESS, 'c2').evidence, 'No result was recorded for this check.');
  assert.deepEqual(head.compare, tally({ unverified: 3 }));
});

test('a package changed after the baseline is skipped until checked again, then compares as head_only', (t) => {
  const { repo, root } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  writeFileSync(path.join(root, 'evals', SUCCESS, 'environment/Dockerfile'), 'FROM alpine:3.20\nWORKDIR /app\nRUN true\n');
  const changed = validateEval(repo, CHANGE).cases.find((item) => item.id === SUCCESS);
  assert.notEqual(changed.task_digest, readRecord(base).run.task_digest[SUCCESS]);
  assert.deepEqual(changed.integration.missing, ['check']);

  setResults(repo, AFTER);
  commit(repo);
  const unchecked = startRun(repo, CHANGE);
  assert.equal(unchecked.verdict, 'unverified');
  assert.deepEqual(unchecked.skipped.map(({ case: id, reason, missing }) => [id, reason, missing]), [[SUCCESS, 'awaiting_integration', ['check']]]);
  assert.deepEqual(rows(readRecord(unchecked).compare), [[FAILURE, 'c1', 'fail', 'pass', 'holds']]);

  assert.equal(checkEval(repo, CHANGE).passed, true);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.deepEqual(head.skipped, []);
  const { compare } = readRecord(head);
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c2', null, 'pass', 'head_only'],
  ]);
  assert.equal(find(compare, SUCCESS, 'c1').before_unavailable_reason, 'incompatible_tasks');
  assert.equal(find(compare, SUCCESS, 'c2').before_unavailable_reason, 'incompatible_tasks');
  assert.equal(find(compare, FAILURE, 'c1').before_unavailable_reason, undefined);
  assert.deepEqual(head.compare, tally({ holds: 1, head_only: 2 }));
  assert.match(head.next, /head_only/);
});

test('a package that is not connected yet is skipped, so the run is unverified and never passes', (t) => {
  const { repo, tools } = readyProject(t, { unconnected: [SUCCESS] });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.is_baseline, true);
  assert.deepEqual(base.cases.map((item) => item.id), [FAILURE]);
  assert.deepEqual(base.skipped.map(({ case: id, reason, missing }) => [id, reason, missing]), [[SUCCESS, 'awaiting_integration', ['instruction']]]);

  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed');
  assert.equal(head.verdict, 'unverified');
  assert.deepEqual(head.skipped.map(({ case: id, reason }) => [id, reason]), [[SUCCESS, 'awaiting_integration']]);
  assert.deepEqual(rows(readRecord(head).compare), [[FAILURE, 'c1', 'fail', 'pass', 'holds']]);
  assert.ok(tools.runs().every((call) => !valueOf(call.argv, '-p').endsWith(SUCCESS)));
});

test('a failing diagnostic check is reported as violated but does not fail the run', (t) => {
  const { repo } = readyProject(t, { check: false });
  // A diagnostic check beside the gating one that verifies the same line.
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks.push({ id: 'c3', intent: 'REQ-submit-success', then: declared.checks[1].then, expect: '失败通知服务没有收到请求', role: 'diagnostic' });
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  startRun(repo, CHANGE, { baseline: true });

  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'pass', c3: 'fail' } });
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  const entry = find(readRecord(head).compare, SUCCESS, 'c3');
  assert.deepEqual([entry.role, entry.after, entry.verdict, entry.then], ['diagnostic', 'fail', 'violated', '本次提交发送的失败通知数量为零']);
  assert.deepEqual(head.cases.find((item) => item.id === SUCCESS).gating, { pass: 2, fail: 0, unknown: 0 });
  assert.equal(readJSON(path.join(head.directory, SUCCESS, 'reward.json')).reward, 1);
});

test('compare.json names the THEN line of each check and lists the lines no check verifies of the packages that ran; check-results.json does not', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.scenario.manual = [{ then: '本次提交发送的失败通知数量为零', reason: 'synthetic: a person reads it' }];
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  commit(repo, 'Leave a line to the user');
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  const { compare } = readRecord(head);
  assert.deepEqual(compare.results.map((entry) => [entry.case, entry.check, entry.then]), [
    [FAILURE, 'c1', '本次提交发送的成功通知数量为零'], [SUCCESS, 'c1', '本次提交发送的成功通知数量为一']]);
  assert.deepEqual(compare.manual, [{ case: SUCCESS, then: '本次提交发送的失败通知数量为零', reason: 'synthetic: a person reads it' }]);
  assert.ok(readJSON(path.join(head.directory, SUCCESS, 'check-results.json')).results.every((entry) => !('then' in entry)));
  // A partial run lists only the lines of the packages it ran.
  assert.deepEqual(readRecord(startRun(repo, CHANGE, { case: [FAILURE] })).compare.manual, []);
  assert.deepEqual(readRecord(startRun(repo, CHANGE, { case: [SUCCESS] })).compare.manual, compare.manual);
});

test('--case runs only the named packages, lists the others as not_selected and never passes', (t) => {
  const { repo, tools } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  const calls = tools.runs().length;
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.execution_status, 'completed');
  assert.equal(partial.scope, 'partial');
  assert.equal(partial.verdict, 'unverified');
  assert.deepEqual(partial.cases.map((item) => item.id), [FAILURE]);
  assert.deepEqual(partial.skipped, [{ case: SUCCESS, reason: 'not_selected' }]);
  assert.match(partial.next, /partial run/);
  const record = readRecord(partial);
  assert.equal(record.run.scope, 'partial');
  assert.deepEqual(rows(record.compare), [[FAILURE, 'c1', 'fail', 'pass', 'holds']]);
  assert.equal(tools.runs().length, calls + 1);
  assert.ok(valueOf(tools.runs().at(-1).argv, '-p').endsWith(FAILURE));

  // A partial run can still prove a failure.
  setResults(repo, BEFORE);
  const failing = cli(['run', 'start', CHANGE, '--repo', repo, '--case', FAILURE]);
  assert.equal(failing.status, 0, failing.stderr);
  assert.equal(failing.json.scope, 'partial');
  assert.equal(failing.json.verdict, 'fail');

  const unknown = cli(['run', 'start', CHANGE, '--repo', repo, '--case', 'no-such-package']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.json.error, /No package named no-such-package/);
});

test('--case naming every package is still a partial run and never gives verdict pass', (t) => {
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  const every = startRun(repo, CHANGE, { case: [FAILURE, SUCCESS] });
  assert.equal(every.execution_status, 'completed', JSON.stringify(every));
  assert.equal(every.scope, 'partial');
  assert.deepEqual(every.skipped, []);
  assert.equal(every.verdict, 'unverified');
  assert.match(every.next, /partial run/);
  assert.equal(startRun(repo, CHANGE).verdict, 'pass');
});

test('the baseline\'s --attempts runs each package with a live dependency N times: any failing attempt fails the check, a pass and a fail are flaky, and a missing result is not', (t) => {
  const { repo, tools } = readyProject(t, { live: [FAILURE, SUCCESS] });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  assert.deepEqual(tools.runs().slice(-2).map((call) => valueOf(call.argv, '-k')), ['3', '3']);
  setResults(repo, {
    [FAILURE]: { c1: ['pass', 'unknown', 'pass'] },
    [SUCCESS]: { c1: ['pass', 'fail', 'pass'], c2: ['pass', 'pass', 'pass'] },
  });
  commit(repo);
  // A head run follows the baseline's plan without the flag.
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  assert.equal(head.verdict, 'fail');
  assert.equal(head.baseline, base.run_id);
  const calls = tools.runs().slice(-2);
  assert.deepEqual(calls.map((call) => valueOf(call.argv, '-k')), ['3', '3']);
  const { run, compare } = readRecord(head);
  assert.equal(run.environment_ref.attempts, 3);
  assert.deepEqual(run.environment_ref.attempts_by_case, { [FAILURE]: 3, [SUCCESS]: 3 });
  for (const id of [FAILURE, SUCCESS]) {
    assert.deepEqual(readdirSync(path.join(head.directory, id, 'logs/harbor')).sort(), ['trial-1', 'trial-2', 'trial-3']);
  }
  // Every attempt is kept with its own results.
  const attempts = readJSON(path.join(head.directory, SUCCESS, 'attempts.json'));
  assert.deepEqual([attempts.schema_version, attempts.case, attempts.planned], ['1.0', SUCCESS, 3]);
  assert.deepEqual(attempts.attempts.map((entry) => [entry.attempt, entry.trial, entry.status, entry.results]), [
    [1, 'logs/harbor/trial-1', 'completed', { c1: 'pass', c2: 'pass' }],
    [2, 'logs/harbor/trial-2', 'completed', { c1: 'fail', c2: 'pass' }],
    [3, 'logs/harbor/trial-3', 'completed', { c1: 'pass', c2: 'pass' }],
  ]);
  assert.deepEqual(readJSON(path.join(head.directory, FAILURE, 'attempts.json')).attempts.map((entry) => entry.results.c1), ['pass', 'unknown', 'pass']);

  const success = Object.fromEntries(readJSON(path.join(head.directory, SUCCESS, 'check-results.json')).results.map((entry) => [entry.id, entry]));
  assert.equal(success.c1.result, 'fail');
  assert.equal(success.c1.flaky, true);
  assert.match(success.c1.evidence, /^2 pass, 1 fail, 0 unknown over 3 attempts\./);
  assert.equal(success.c2.result, 'pass');
  assert.equal(success.c2.flaky, undefined);
  assert.match(success.c2.evidence, /^3 pass, 0 fail, 0 unknown over 3 attempts\./);
  const failure = readJSON(path.join(head.directory, FAILURE, 'check-results.json')).results[0];
  // An attempt without evidence is missing evidence, not a different result.
  assert.deepEqual([failure.result, failure.flaky], ['unknown', undefined]);

  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'fail', 'unknown', 'unverified'],
    [SUCCESS, 'c1', 'pass', 'fail', 'violated'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);
  assert.equal(find(compare, SUCCESS, 'c1').flaky, true);
  assert.equal(find(compare, FAILURE, 'c1').flaky, undefined);
  assert.equal(find(compare, SUCCESS, 'c2').flaky, undefined);
  assert.ok(head.warnings.includes(`${SUCCESS}: c1 passed in some attempts and failed in others.`), JSON.stringify(head.warnings));
  assert.ok(!head.warnings.some((warning) => warning.startsWith(`${FAILURE}: c1`)), JSON.stringify(head.warnings));
});

test('an attempt without a trial result is an execution error and the CLI exits 1, and --attempts must be a whole number of 1 or more', (t) => {
  const { repo, runs } = readyProject(t, { spec: 'example', live: [FAILURE], attempts: 2 });
  for (const attempts of [0, -1, 1.5]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, attempts }), /--attempts is a whole number of 1 or more/, String(attempts));
  }
  assert.deepEqual(runIds(runs), []);
  startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  setResults(repo, { [FAILURE]: [{ c1: 'pass' }, 'error'] });
  const run = cli(['run', 'start', CHANGE, '--repo', repo, '--attempts', '2']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.json.execution_status, 'error');
  assert.equal(run.json.verdict, 'unverified');
  assert.match(run.json.cases[0].execution.reason, /1 of 2 trial results \(exit 1\)/);
  assert.match(run.json.next, /Execution did not complete/);
  assert.equal(readRecord(run.json.directory).run.environment_ref.attempts, 2);

  const before = runIds(runs);
  for (const attempts of [0, -1, 1.5]) {
    assert.throws(() => startRun(repo, CHANGE, { attempts }), /--attempts is a whole number of 1 or more/, String(attempts));
  }
  const words = cli(['run', 'start', CHANGE, '--repo', repo, '--attempts', 'two']);
  assert.equal(words.status, 1);
  assert.match(words.json.error, /--attempts is a whole number/);
  assert.deepEqual(runIds(runs), before);
});

test('an attempt without a trial result leaves the checks of its package unknown', (t) => {
  const { repo } = readyProject(t, { spec: 'example', live: [FAILURE], attempts: 2 });
  startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  setResults(repo, { [FAILURE]: [{ c1: 'pass' }, 'error'] });
  const run = startRun(repo, CHANGE, { attempts: 2 });
  assert.equal(run.execution_status, 'error');
  const result = readJSON(path.join(run.directory, FAILURE, 'check-results.json')).results[0];
  assert.deepEqual([result.result, result.flaky], ['unknown', undefined]);
  assert.match(result.evidence, /^1 pass, 0 fail, 1 unknown over 2 attempts\./);
  const entry = find(readRecord(run).compare, FAILURE, 'c1');
  assert.deepEqual([entry.after, entry.verdict], ['unknown', 'unverified']);
});

test('an exception in a trial is an execution error, not a business failure', (t) => {
  const { repo } = readyProject(t, { live: [FAILURE], attempts: 2 });
  startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  setResults(repo, { ...AFTER, [FAILURE]: 'exception' });
  const run = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.json.execution_status, 'error');
  assert.equal(run.json.verdict, 'unverified');
  const byCase = Object.fromEntries(run.json.cases.map((item) => [item.id, item]));
  assert.equal(byCase[FAILURE].execution.status, 'error');
  assert.match(byCase[FAILURE].execution.reason, /^RuntimeError: /);
  assert.deepEqual(byCase[FAILURE].gating, { pass: 0, fail: 0, unknown: 1 });
  assert.deepEqual(byCase[SUCCESS].execution, { status: 'completed' });
  assert.deepEqual(rows(readRecord(run.json.directory).compare), [
    [FAILURE, 'c1', 'fail', 'unknown', 'unverified'],
    [SUCCESS, 'c1', 'pass', 'pass', 'holds'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);
  assert.equal(run.json.compare.violated, 0);

  // One attempt that raised is enough.
  setResults(repo, { ...AFTER, [FAILURE]: [{ c1: 'pass' }, 'exception'] });
  const again = startRun(repo, CHANGE, { attempts: 2 });
  assert.equal(again.execution_status, 'error');
  assert.match(again.cases.find((item) => item.id === FAILURE).execution.reason, /^RuntimeError: /);
  assert.notEqual(again.verdict, 'pass');
  const entry = find(readRecord(again).compare, FAILURE, 'c1');
  assert.deepEqual([entry.after, entry.verdict], ['unknown', 'unverified']);
});

test('a run hands Harbor the package, agent, model and attempts, and the application root in its environment', (t) => {
  const { repo, root, tools } = readyProject(t, { live: [FAILURE], confirm: false });
  const kit = path.join(repo, '.genesis/edd/harness');
  const base = startRun(repo, CHANGE, { baseline: true, agent: 'other_agent:OtherAgent', model: 'synthetic/model-1', attempts: 2, yes: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  const calls = tools.runs().slice(-2).sort((a, b) => valueOf(a.argv, '-p').localeCompare(valueOf(b.argv, '-p')));
  assert.deepEqual(calls.map((call) => call.argv), [[FAILURE, '2'], [SUCCESS, '1']].map(([id, attempts]) => ['run', '-p', path.join(root, 'evals', id),
    '-a', 'other_agent:OtherAgent', '-k', attempts, '-n', '1', '-o', path.join(base.directory, id, 'logs'), '--job-name', 'harbor', '--quiet',
    '-m', 'synthetic/model-1', '--yes']));
  for (const call of calls) {
    assert.equal(call.env.GENESIS_EDD_REPO, repo);
    assert.equal(call.env.GENESIS_EDD_HARNESS, kit);
    assert.equal(call.env.PYTHONPATH.split(path.delimiter)[0], kit);
    assert.equal(call.env.GENESIS_EDD_FIXTURE, undefined);
  }
  assert.deepEqual(readRecord(base).run.environment_ref, { harbor: FAKE_HARBOR_VERSION, agent: 'other_agent:OtherAgent',
    model: 'synthetic/model-1', attempts: 2, attempts_by_case: { [FAILURE]: 2, [SUCCESS]: 1 },
    run_plan: { attempts: 2, pass_rule: 'all', agent: 'other_agent:OtherAgent', model: 'synthetic/model-1', source: 'baseline' },
    dependencies: { [FAILURE]: [LIVE_DEPENDENCY], [SUCCESS]: [] } });

  // Without options the agent comes from the kit's harness.json, with no model and no --yes.
  const head = startRun(repo, CHANGE);
  const last = tools.runs().at(-1);
  assert.equal(valueOf(last.argv, '-a'), AGENT);
  assert.ok(!last.argv.includes('-m') && !last.argv.includes('--yes'), last.argv.join(' '));
  const environment = readRecord(head).run.environment_ref;
  assert.deepEqual([environment.harbor, environment.agent, environment.model], [FAKE_HARBOR_VERSION, AGENT, null]);
});

test('code.patch on top of the recorded commit restores the exact code of a run', (t) => {
  const { repo } = readyProject(t);
  mkdirSync(path.join(repo, 'app/lib'), { recursive: true });
  writeFileSync(path.join(repo, 'app/lib/notify.txt'), 'send the success notice\n');
  writeFileSync(path.join(repo, 'app/legacy.txt'), 'an old module\n');
  const start = commit(repo, 'Add notification modules');
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(readRecord(base).run.code_version, start);

  // A modified tracked file, a deleted one, and new untracked text and binary files.
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/lib/notify.txt'), 'send the success notice only when the submission succeeded\n');
  unlinkSync(path.join(repo, 'app/legacy.txt'));
  mkdirSync(path.join(repo, 'app/lib/failure'), { recursive: true });
  writeFileSync(path.join(repo, 'app/lib/failure/notice.txt'), 'send the failure notice\n');
  const binary = Buffer.from([0, 1, 2, 254, 255, 0, 10, 13]);
  writeFileSync(path.join(repo, 'app/lib/failure/template.bin'), binary);
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  const snapshot = readRecord(head).run.code_snapshot;
  assert.equal(readRecord(head).run.code_version, 'uncommitted');
  assert.equal(snapshot.commit, start);
  assert.equal(snapshot.patch, 'code.patch');
  assert.deepEqual([...snapshot.changed_files].sort(),
    ['app/legacy.txt', 'app/lib/failure/notice.txt', 'app/lib/failure/template.bin', 'app/lib/notify.txt', 'app/results.json']);
  assert.equal(snapshot.file_digests['app/legacy.txt'], 'deleted');
  assert.equal(snapshot.file_digests['app/lib/failure/template.bin'], sha256(binary));
  assert.equal(snapshot.file_digests['app/results.json'], sha256(readFileSync(path.join(repo, 'app/results.json'))));
  const patch = path.join(head.directory, 'code.patch');
  assert.ok(!readFileSync(patch, 'utf8').includes('.genesis/'));

  const clone = scratch(t, 'genesis-edd-clone-');
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', snapshot.commit]);
  git(clone, ['apply', patch]);
  assert.deepEqual(tree(path.join(clone, 'app')), tree(path.join(repo, 'app')));
  assert.ok(!existsSync(path.join(clone, 'app/legacy.txt')));
});

test('code.patch restores files whose names Git quotes, and a renamed file', (t) => {
  const { repo } = readyProject(t);
  writeFileSync(path.join(repo, 'app/old-name.txt'), 'a module that moves\n');
  const start = commit(repo, 'Add a module');
  startRun(repo, CHANGE, { baseline: true });
  const quoted = 'app/say "hi" \\ back.txt';
  writeFileSync(path.join(repo, quoted), 'hello\n');
  git(repo, ['mv', 'app/old-name.txt', 'app/new name.txt']);
  const head = startRun(repo, CHANGE);
  const snapshot = readRecord(head).run.code_snapshot;
  assert.equal(snapshot.commit, start);
  assert.equal(snapshot.file_digests[quoted], sha256('hello\n'));
  assert.equal(snapshot.file_digests['app/new name.txt'], sha256('a module that moves\n'));
  assert.equal(snapshot.file_digests['app/old-name.txt'], 'deleted');

  const clone = scratch(t, 'genesis-edd-quoted-');
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', snapshot.commit]);
  git(clone, ['apply', path.join(head.directory, 'code.patch')]);
  assert.deepEqual(tree(path.join(clone, 'app')), tree(path.join(repo, 'app')));
});

test('code.patch alone restores the code of a project with no commit', (t) => {
  const { repo } = readyProject(t, { commit: false });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  const { run } = readRecord(base);
  assert.equal(run.code_version, 'uncommitted');
  assert.equal(run.code_snapshot.commit, null);
  assert.deepEqual(run.code_snapshot.changed_files, ['app/results.json']);
  assert.equal(run.code_snapshot.patch, 'code.patch');

  const empty = scratch(t, 'genesis-edd-restore-');
  git(empty, ['init', '-q']);
  git(empty, ['apply', path.join(base.directory, 'code.patch')]);
  assert.deepEqual(tree(path.join(empty, 'app')), tree(path.join(repo, 'app')));
});

test('Docker not running or Harbor missing blocks a run with the matching gaps and writes no run folder', (t) => {
  const { repo, tools, runs } = readyProject(t);
  const calls = tools.runs().length;

  tools.docker(false);
  const docker = runTools();
  assert.deepEqual([docker.harbor, docker.docker], [FAKE_HARBOR_VERSION, false]);
  assert.deepEqual(docker.gaps.map((gap) => gap.code), ['docker_unavailable']);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    refused('docker_unavailable')(error);
    assert.deepEqual(error.resume.command, ['workflow', 'check', 'run-eval', CHANGE, '--repo', repo]);
    return true;
  });
  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.status, 'blocked');
  assert.deepEqual(workflow.gaps.map((gap) => gap.code), ['docker_unavailable']);
  assert.equal(workflow.next.action, 'repair_inputs');

  tools.harbor(false);
  const both = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.equal(both.status, 1);
  assert.equal(both.json.code, 'RUN_INPUT_BLOCKED');
  assert.deepEqual(both.json.gaps.map((gap) => gap.code), ['harbor_missing', 'docker_unavailable']);

  tools.docker(true);
  const harbor = runTools();
  assert.deepEqual([harbor.harbor, harbor.docker], [null, true]);
  assert.deepEqual(harbor.gaps.map((gap) => gap.code), ['harbor_missing']);
  assert.match(harbor.gaps[0].message, /no-such-harbor/);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refused('harbor_missing'));
  assert.deepEqual(runIds(runs), []);
  assert.equal(tools.runs().length, calls);

  // Once a baseline exists, a head run is blocked the same way.
  tools.harbor(true);
  const base = startRun(repo, CHANGE, { baseline: true });
  tools.docker(false);
  setResults(repo, AFTER);
  assert.throws(() => startRun(repo, CHANGE), refused('docker_unavailable'));
  const head = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(head.status, 1);
  assert.deepEqual(head.json.gaps.map((gap) => gap.code), ['docker_unavailable']);
  assert.deepEqual(runIds(runs), [base.run_id]);
});
