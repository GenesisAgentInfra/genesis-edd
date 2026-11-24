import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { checkEval, codeSnapshot, runTools, sameCode, savePatch, startRun } from '../src/run.js';
import { startLoop } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FAKE_HARBOR_VERSION, cli, commit, connect, git, harborThen, readRecord, readyProject, setResults, writeExpectations,
} from './helpers/edd.js';

const FAILURE = 'submit-failure-s1';
const SUCCESS = 'submit-success-s1';

// Run folders under runs/, in name order. None when runs/ does not exist yet.
const runIds = (runs) => (existsSync(runs)
  ? readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []);
// compare.json as [case, check, before, after, verdict] rows.
const rows = (compare) => compare.results.map(({ case: id, check, before, after, verdict }) => [id, check, before, after, verdict]);
const find = (compare, id, check) => compare.results.find((entry) => entry.case === id && entry.check === check);
const tally = (counts) => ({ holds: 0, violated: 0, base_mismatch: 0, head_only: 0, unverified: 0, ...counts });
const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

// assert.throws validator for a run that was refused with exactly these gaps.
const refused = (...codes) => (error) => {
  assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
  assert.deepEqual(error.gaps.map((gap) => gap.code), codes);
  return true;
};

function scratch(t, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Every file under directory with its bytes, keyed by its path relative to directory.
function tree(directory, base = directory) {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(tree(file, base))
      : [[path.relative(base, file).split(path.sep).join('/'), readFileSync(file).toString('base64')]];
  }));
}

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
  assert.equal(compare, null);

  tools.docker(true);
  tools.harbor(true);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'run_eval');

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
  const { repo, root } = readyProject(t, { check: false });
  const file = path.join(root, 'evals', SUCCESS, 'tests/checks.json');
  const declared = readJSON(file);
  declared.checks = declared.checks.map((check) => (check.id === 'c2' ? { ...check, role: 'diagnostic' } : check));
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  startRun(repo, CHANGE, { baseline: true });

  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  const entry = find(readRecord(head).compare, SUCCESS, 'c2');
  assert.deepEqual([entry.role, entry.after, entry.verdict], ['diagnostic', 'fail', 'violated']);
  assert.deepEqual(head.cases.find((item) => item.id === SUCCESS).gating, { pass: 1, fail: 0, unknown: 0 });
  assert.equal(readJSON(path.join(head.directory, SUCCESS, 'reward.json')).reward, 1);
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

test('--attempts runs every package N times: any failing attempt fails the check and mixed results are flaky', (t) => {
  const { repo, tools } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  setResults(repo, {
    [FAILURE]: { c1: ['pass', 'unknown', 'pass'] },
    [SUCCESS]: { c1: ['pass', 'fail', 'pass'], c2: ['pass', 'pass', 'pass'] },
  });
  commit(repo);
  const head = startRun(repo, CHANGE, { attempts: 3 });
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  assert.equal(head.verdict, 'fail');
  assert.equal(head.baseline, base.run_id);
  const calls = tools.runs().slice(-2);
  assert.deepEqual(calls.map((call) => valueOf(call.argv, '-k')), ['3', '3']);
  const { run, compare } = readRecord(head);
  assert.equal(run.environment_ref.attempts, 3);
  for (const id of [FAILURE, SUCCESS]) {
    assert.deepEqual(readdirSync(path.join(head.directory, id, 'logs/harbor')).sort(), ['trial-1', 'trial-2', 'trial-3']);
  }

  const success = Object.fromEntries(readJSON(path.join(head.directory, SUCCESS, 'check-results.json')).results.map((entry) => [entry.id, entry]));
  assert.equal(success.c1.result, 'fail');
  assert.equal(success.c1.flaky, true);
  assert.match(success.c1.evidence, /^2 pass, 1 fail, 0 unknown over 3 attempts\./);
  assert.equal(success.c2.result, 'pass');
  assert.equal(success.c2.flaky, undefined);
  assert.match(success.c2.evidence, /^3 pass, 0 fail, 0 unknown over 3 attempts\./);
  const failure = readJSON(path.join(head.directory, FAILURE, 'check-results.json')).results[0];
  assert.deepEqual([failure.result, failure.flaky], ['unknown', true]);

  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'fail', 'unknown', 'unverified'],
    [SUCCESS, 'c1', 'pass', 'fail', 'violated'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);
  assert.equal(find(compare, SUCCESS, 'c1').flaky, true);
  assert.equal(find(compare, FAILURE, 'c1').flaky, true);
  assert.equal(find(compare, SUCCESS, 'c2').flaky, undefined);
  assert.ok(head.warnings.includes(`${SUCCESS}: c1 gave different results across attempts.`), JSON.stringify(head.warnings));
  assert.ok(head.warnings.includes(`${FAILURE}: c1 gave different results across attempts.`), JSON.stringify(head.warnings));
});

test('an attempt without a trial result is an execution error and the CLI exits 1, and --attempts must be a whole number of 1 or more', (t) => {
  const { repo, runs } = readyProject(t, { spec: 'example' });
  startRun(repo, CHANGE, { baseline: true });
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
  const { repo } = readyProject(t, { spec: 'example' });
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, { [FAILURE]: [{ c1: 'pass' }, 'error'] });
  const run = startRun(repo, CHANGE, { attempts: 2 });
  assert.equal(run.execution_status, 'error');
  const result = readJSON(path.join(run.directory, FAILURE, 'check-results.json')).results[0];
  assert.deepEqual([result.result, result.flaky], ['unknown', true]);
  assert.match(result.evidence, /^1 pass, 0 fail, 1 unknown over 2 attempts\./);
  const entry = find(readRecord(run).compare, FAILURE, 'c1');
  assert.deepEqual([entry.after, entry.verdict], ['unknown', 'unverified']);
});

test('an exception in a trial is an execution error, not a business failure', (t) => {
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
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
  const { repo, root, tools } = readyProject(t);
  const kit = path.join(repo, '.genesis/edd/harness');
  const base = startRun(repo, CHANGE, { baseline: true, agent: 'other_agent:OtherAgent', model: 'synthetic/model-1', yes: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  const calls = tools.runs().slice(-2).sort((a, b) => valueOf(a.argv, '-p').localeCompare(valueOf(b.argv, '-p')));
  assert.deepEqual(calls.map((call) => call.argv), [FAILURE, SUCCESS].map((id) => ['run', '-p', path.join(root, 'evals', id),
    '-a', 'other_agent:OtherAgent', '-k', '1', '-n', '1', '-o', path.join(base.directory, id, 'logs'), '--job-name', 'harbor', '--quiet',
    '-m', 'synthetic/model-1', '--yes']));
  for (const call of calls) {
    assert.equal(call.env.GENESIS_EDD_REPO, repo);
    assert.equal(call.env.GENESIS_EDD_HARNESS, kit);
    assert.equal(call.env.PYTHONPATH.split(path.delimiter)[0], kit);
    assert.equal(call.env.GENESIS_EDD_FIXTURE, undefined);
  }
  assert.deepEqual(readRecord(base).run.environment_ref, { harbor: FAKE_HARBOR_VERSION, agent: 'other_agent:OtherAgent',
    model: 'synthetic/model-1', attempts: 1, dependencies: { [FAILURE]: [], [SUCCESS]: [] } });

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

// Which base record a head run compares with, and how a running loop pins it.

// assert.throws validator for a run refused with RUN_INPUT_BLOCKED and a gap with this code.
const refusedWith = (code) => (error) => {
  assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
  assert.ok((error.gaps ?? []).some((gap) => gap.code === code), `expected ${code} in ${JSON.stringify(error.gaps)}`);
  return true;
};
const loopFile = (root) => path.join(root, 'loop.json');
// The base record a head run compared with, as run.json and compare.json name it.
const baseRuns = (run) => {
  const { run: record, compare } = readRecord(run);
  return { run: record.base_run, compare: compare.base_run, baseline: record.baseline, compareBaseline: compare.baseline };
};
// baseline_expectations as sorted [case, check, expected] rows.
const expectationRows = (record) => record.baseline_expectations.map(({ case: id, check, expected }) => [id, check, expected])
  .sort((a, b) => `${a[0]}/${a[1]}`.localeCompare(`${b[0]}/${b[1]}`));
const restartWarning = (warnings) => warnings.some((warning) => /loop start --restart/.test(warning));

test('a head run records as base_run, in run.json and compare.json, the base record it compared with, real or unavailable', (t) => {
  const { repo } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.is_baseline, true);
  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.deepEqual(baseRuns(head), { run: base.run_id, compare: base.run_id, baseline: base.run_id, compareBaseline: base.run_id });

  // An unavailable baseline is still the base record the head run compared with.
  const unavailable = startRun(repo, CHANGE, { baseline: true, unavailable: 'execution_blocked' });
  assert.equal(unavailable.execution_status, 'not_run');
  const next = startRun(repo, CHANGE);
  assert.deepEqual(baseRuns(next), { run: unavailable.run_id, compare: unavailable.run_id, baseline: null, compareBaseline: null });
  assert.equal(readRecord(next).run.baseline_unavailable_reason, 'execution_blocked');
});

test('a head run in a new project with only an unavailable baseline records that record as base_run', (t) => {
  const { repo } = readyProject(t, { mode: 'new', results: {} });
  const base = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', 'no_implementation']);
  assert.equal(base.status, 0, base.stderr);
  setResults(repo, AFTER);
  commit(repo, 'Add a first implementation');
  const head = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(head.status, 0, head.stderr);
  assert.deepEqual(baseRuns(head.json.directory), { run: base.json.run_id, compare: base.json.run_id, baseline: null, compareBaseline: null });
});

test('without a loop, a head run compares with the latest base run that executed or was declared unavailable', (t) => {
  const { repo } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const second = startRun(repo, CHANGE, { baseline: true });
  assert.equal(second.is_baseline, true);
  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.notEqual(first.run_id, second.run_id);
  assert.deepEqual(baseRuns(head), { run: second.run_id, compare: second.run_id, baseline: second.run_id, compareBaseline: second.run_id });
  assert.deepEqual(rows(readRecord(head).compare), [
    [FAILURE, 'c1', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', 'pass', 'pass', 'holds'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);

  const third = startRun(repo, CHANGE, { baseline: true, unavailable: 'incompatible_tasks' });
  const again = startRun(repo, CHANGE);
  assert.deepEqual(baseRuns(again), { run: third.run_id, compare: third.run_id, baseline: null, compareBaseline: null });
  assert.ok(readRecord(again).compare.results.every((entry) => entry.before === null && entry.before_unavailable_reason === 'incompatible_tasks'));
});

test('while a loop runs for the current Spec, every head run compares with the loop baseline even after a later base run', (t) => {
  const { repo, root } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, first.run_id);
  // A later baseline on the starting code that expects the success notice to
  // fail: compared with it, SUCCESS/c1 would be base_mismatch, not holds.
  const later = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${SUCCESS}/c1`]: 'fail' }) });
  assert.equal(later.is_baseline, true, JSON.stringify(later));
  assert.deepEqual(later.baseline_mismatch, [{ case: SUCCESS, check: 'c1', expected: 'fail', got: 'pass' }]);

  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  assert.equal(head.baseline, first.run_id);
  assert.deepEqual(baseRuns(head), { run: first.run_id, compare: first.run_id, baseline: first.run_id, compareBaseline: first.run_id });
  assert.deepEqual(rows(readRecord(head).compare), [
    [FAILURE, 'c1', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', 'pass', 'pass', 'holds'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);

  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  commit(repo);
  const second = startRun(repo, CHANGE);
  assert.deepEqual(baseRuns(second), { run: first.run_id, compare: first.run_id, baseline: first.run_id, compareBaseline: first.run_id });

  // Once there is no loop, the latest base run is the reference again.
  rmSync(loopFile(root));
  setResults(repo, AFTER);
  commit(repo);
  const free = startRun(repo, CHANGE);
  assert.deepEqual(baseRuns(free), { run: later.run_id, compare: later.run_id, baseline: later.run_id, compareBaseline: later.run_id });
  assert.equal(find(readRecord(free).compare, SUCCESS, 'c1').verdict, 'base_mismatch');
});

test('a loop pins an unavailable baseline too: later base runs on the starting code do not replace it', (t) => {
  const { repo } = readyProject(t, { mode: 'new', results: {} });
  const first = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, first.run_id);
  const blockedBase = startRun(repo, CHANGE, { baseline: true, unavailable: 'execution_blocked' });
  assert.equal(blockedBase.execution_status, 'not_run');
  const executed = startRun(repo, CHANGE, { baseline: true });
  assert.equal(executed.is_baseline, true, JSON.stringify(executed));

  setResults(repo, BEFORE);
  commit(repo, 'Add a first implementation');
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  assert.deepEqual(baseRuns(head), { run: first.run_id, compare: first.run_id, baseline: null, compareBaseline: null });
  assert.equal(head.baseline_unavailable_reason, 'no_implementation');
  const { compare } = readRecord(head);
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', null, 'fail', 'violated'],
    [SUCCESS, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c2', null, 'pass', 'head_only'],
  ]);
  assert.ok(compare.results.every((entry) => entry.before_unavailable_reason === 'no_implementation'), JSON.stringify(compare.results));
});

test('a loop.json for a different Spec is not a running loop: head runs compare with the latest base and baselines run on any code', (t) => {
  const { repo, root } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  const stale = readJSON(loopFile(root));
  writeFileSync(loopFile(root), `${JSON.stringify({ ...stale, spec: sha256('a Spec exported before this one') }, null, 2)}\n`);

  setResults(repo, AFTER);
  commit(repo);
  // Not refused with baseline_after_change, because no loop runs for this Spec.
  const later = startRun(repo, CHANGE, { baseline: true });
  assert.equal(later.is_baseline, true, JSON.stringify(later));
  assert.ok(!restartWarning(later.warnings), JSON.stringify(later.warnings));
  const head = startRun(repo, CHANGE);
  assert.notEqual(later.run_id, first.run_id);
  assert.deepEqual(baseRuns(head), { run: later.run_id, compare: later.run_id, baseline: later.run_id, compareBaseline: later.run_id });

  // Nor does a missing baseline folder of that other loop matter.
  rmSync(first.directory, { recursive: true, force: true });
  const again = startRun(repo, CHANGE);
  assert.equal(again.execution_status, 'completed', JSON.stringify(again));
  assert.equal(readRecord(again).run.base_run, later.run_id);
});

test('while a loop runs, a baseline that executes on changed code is refused with baseline_after_change, writes nothing, and the CLI exits 1', (t) => {
  const { repo, tools, runs } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  const before = runIds(runs);
  const calls = tools.runs().length;
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail' });

  // Uncommitted code that differs from the start.
  setResults(repo, AFTER);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, expect }), refusedWith('baseline_after_change'));
  const uncommitted = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.equal(uncommitted.status, 1, uncommitted.stdout);
  assert.equal(uncommitted.json.code, 'RUN_INPUT_BLOCKED');
  assert.ok(uncommitted.json.gaps.some((gap) => gap.code === 'baseline_after_change'), JSON.stringify(uncommitted.json));

  // The same change, committed.
  commit(repo);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  const committed = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', expect]);
  assert.equal(committed.status, 1, committed.stdout);
  assert.equal(committed.json.code, 'RUN_INPUT_BLOCKED');
  assert.ok(committed.json.gaps.some((gap) => gap.code === 'baseline_after_change'), JSON.stringify(committed.json));

  assert.deepEqual(runIds(runs), before);
  assert.equal(tools.runs().length, calls);
});

test('while a loop runs, --baseline --unavailable is refused on changed code too, so it cannot replace the loop baseline', (t) => {
  const { repo, runs } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  commit(repo);
  const before = runIds(runs);
  for (const reason of ['no_implementation', 'execution_blocked', 'incompatible_tasks']) {
    const result = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', reason]);
    assert.equal(result.status, 1, `${reason}: ${result.stdout}`);
    assert.ok(result.json.gaps.some((gap) => gap.code === 'baseline_after_change'), JSON.stringify(result.json));
  }
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' }), refusedWith('baseline_after_change'));
  assert.deepEqual(runIds(runs), before);
  // So a restart cannot move the loop onto the changed code with such a record.
  assert.equal(startLoop(repo, CHANGE, { restart: true }).loop.start_code.digest, readJSON(path.join(runs, first.run_id, 'run.json')).code_snapshot.digest);

  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.deepEqual(baseRuns(head), { run: first.run_id, compare: first.run_id, baseline: first.run_id, compareBaseline: first.run_id });
});

test('while a loop runs, a baseline on the starting code is allowed and warns that the loop keeps its baseline until loop start --restart', (t) => {
  const { repo, runs } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  assert.ok(!restartWarning(first.warnings), JSON.stringify(first.warnings));
  const { loop } = startLoop(repo, CHANGE);
  const start = loop.start_code.commit;

  // Right after loop start; an --expect file under .genesis/ is not a code change.
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' });
  const again = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', expect]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.is_baseline, true);
  assert.ok(restartWarning(again.json.warnings), JSON.stringify(again.json.warnings));

  // After an uncommitted change is undone.
  setResults(repo, AFTER);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  git(repo, ['checkout', '--', 'app/results.json']);
  const restored = startRun(repo, CHANGE, { baseline: true });
  assert.equal(restored.is_baseline, true, JSON.stringify(restored));
  assert.ok(restartWarning(restored.warnings), JSON.stringify(restored.warnings));

  // After a committed change, back on the starting commit.
  setResults(repo, AFTER);
  commit(repo);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  git(repo, ['checkout', '-q', '--detach', start]);
  const back = startRun(repo, CHANGE, { baseline: true });
  assert.equal(back.is_baseline, true, JSON.stringify(back));
  assert.ok(restartWarning(back.warnings), JSON.stringify(back.warnings));
  assert.equal(runIds(runs).length, 4);

  // None of them moved the loop's reference.
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.equal(readRecord(head).run.base_run, first.run_id);
});

test('a head run is refused with loop_baseline_missing when the loop baseline folder is gone, even though another baseline exists', (t) => {
  const { repo, tools, runs } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  const later = startRun(repo, CHANGE, { baseline: true });
  assert.equal(later.is_baseline, true);
  rmSync(first.directory, { recursive: true, force: true });
  setResults(repo, AFTER);
  commit(repo);
  const before = runIds(runs);
  const calls = tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE), refusedWith('loop_baseline_missing'));
  const refusal = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(refusal.status, 1, refusal.stdout);
  assert.equal(refusal.json.code, 'RUN_INPUT_BLOCKED');
  assert.ok(refusal.json.gaps.some((gap) => gap.code === 'loop_baseline_missing'), JSON.stringify(refusal.json));
  assert.deepEqual(runIds(runs), before);
  assert.equal(tools.runs().length, calls);
});

test('a baseline that runs records an expectation for every declared check, including packages awaiting integration, and an unavailable one records none', (t) => {
  const { repo } = readyProject(t, { unconnected: [SUCCESS] });
  // An expectation may name a check of the package that is not connected yet.
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c2`]: 'pass' });
  const base = startRun(repo, CHANGE, { baseline: true, expect });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  assert.deepEqual(base.skipped.map(({ case: id, reason }) => [id, reason]), [[SUCCESS, 'awaiting_integration']]);
  const { run } = readRecord(base);
  assert.deepEqual(expectationRows(run), [[FAILURE, 'c1', 'fail'], [SUCCESS, 'c1', 'any'], [SUCCESS, 'c2', 'pass']]);
  const byKey = Object.fromEntries(run.baseline_expectations.map((entry) => [`${entry.case}/${entry.check}`, entry]));
  assert.equal(byKey[`${FAILURE}/c1`].reason, `Synthetic expectation for ${FAILURE}/c1.`);
  assert.equal(byKey[`${SUCCESS}/c2`].reason, `Synthetic expectation for ${SUCCESS}/c2.`);
  assert.equal(typeof byKey[`${SUCCESS}/c1`].reason, 'string');

  // Without --expect every declared check is expected 'any'.
  const plain = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(expectationRows(readRecord(plain.json.directory).run), [[FAILURE, 'c1', 'any'], [SUCCESS, 'c1', 'any'], [SUCCESS, 'c2', 'any']]);

  const none = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', 'no_implementation']);
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(readRecord(none.json.directory).run.baseline_expectations, []);
});

test('a check with no baseline result says why: not_run_at_baseline for a package connected later, incompatible_tasks for one changed since', (t) => {
  const { repo, root } = readyProject(t, { unconnected: [SUCCESS] });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.deepEqual(base.cases.map((item) => item.id), [FAILURE]);

  // The skipped package is connected and proven after the baseline.
  connect(repo, SUCCESS);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  setResults(repo, AFTER);
  commit(repo);
  const connected = startRun(repo, CHANGE);
  assert.equal(connected.execution_status, 'completed', JSON.stringify(connected));
  let compare = readRecord(connected).compare;
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c2', null, 'pass', 'head_only'],
  ]);
  assert.equal(find(compare, FAILURE, 'c1').before_unavailable_reason, undefined);
  assert.equal(find(compare, SUCCESS, 'c1').before_unavailable_reason, 'not_run_at_baseline');
  assert.equal(find(compare, SUCCESS, 'c2').before_unavailable_reason, 'not_run_at_baseline');

  // Then the verifier of the package that did run at the baseline changes.
  const verifier = path.join(root, 'evals', FAILURE, 'tests/test.sh');
  writeFileSync(verifier, `${readFileSync(verifier, 'utf8')}# Synthetic: the verifier was revised after the baseline.\n`);
  assert.notEqual(validateEval(repo, CHANGE).cases.find((item) => item.id === FAILURE).task_digest, readRecord(base).run.task_digest[FAILURE]);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const changed = startRun(repo, CHANGE);
  compare = readRecord(changed).compare;
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c2', null, 'pass', 'head_only'],
  ]);
  assert.equal(find(compare, FAILURE, 'c1').before_unavailable_reason, 'incompatible_tasks');
  assert.equal(find(compare, SUCCESS, 'c1').before_unavailable_reason, 'not_run_at_baseline');
  assert.equal(find(compare, SUCCESS, 'c2').before_unavailable_reason, 'not_run_at_baseline');
});

test('with no baseline run, every check without a result carries the reason the baseline was declared unavailable', (t) => {
  const { repo } = readyProject(t);
  setResults(repo, AFTER);
  commit(repo);
  for (const reason of ['execution_blocked', 'incompatible_tasks', 'no_implementation']) {
    startRun(repo, CHANGE, { baseline: true, unavailable: reason });
    const head = startRun(repo, CHANGE);
    const { run, compare } = readRecord(head);
    assert.equal(run.baseline_unavailable_reason, reason);
    assert.deepEqual(compare.results.map((entry) => [entry.before, entry.before_unavailable_reason]), [[null, reason], [null, reason], [null, reason]], reason);
  }
});

// --- Found in the second review: the code identity and code.patch must not
// depend on the index or on the user's Git settings. ---

test('the code identity covers content only: a commit keeps it, files of the evals and the Spec never enter it, and a content change moves it', (t) => {
  const { repo } = readyProject(t);
  writeFileSync(path.join(repo, 'app/a.txt'), 'a new module\n');
  const before = codeSnapshot(repo).snapshot;
  assert.equal(before.digest_of, 'content');
  commit(repo, 'Add a module');
  const after = codeSnapshot(repo).snapshot;
  assert.notEqual(after.commit, before.commit);
  assert.deepEqual(after.changed_files, []);
  assert.equal(after.digest, before.digest);

  writeFileSync(path.join(repo, '.genesis/edd/notes.md'), 'not code\n');
  assert.equal(codeSnapshot(repo).snapshot.digest, before.digest);
  commit(repo, 'Add notes');
  assert.equal(codeSnapshot(repo).snapshot.digest, before.digest);

  writeFileSync(path.join(repo, 'app/a.txt'), 'a changed module\n');
  assert.notEqual(codeSnapshot(repo).snapshot.digest, before.digest);
  rmSync(path.join(repo, 'app/a.txt'));
  assert.notEqual(codeSnapshot(repo).snapshot.digest, before.digest);
});

test('a record written before the digest covered content only compares by its commit when it had no uncommitted change, and cannot be compared otherwise', (t) => {
  const { repo } = readyProject(t);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const clean = { commit: head, changed_files: [], digest: sha256(head) };
  assert.equal(sameCode(clean, codeSnapshot(repo).snapshot, repo), true);
  assert.equal(sameCode(clean, codeSnapshot(repo).snapshot), null, 'without the project its commit cannot be read');
  writeFileSync(path.join(repo, 'app/a.txt'), 'a new module\n');
  assert.equal(sameCode(clean, codeSnapshot(repo).snapshot, repo), false);
  const dirty = { commit: head, changed_files: ['app/a.txt'], digest: sha256(`${head}\napp/a.txt`) };
  assert.equal(sameCode(dirty, codeSnapshot(repo).snapshot, repo), null);
});

test('the code identity does not depend on what is staged, and code.patch restores staged files and renames', (t) => {
  const { repo } = readyProject(t);
  writeFileSync(path.join(repo, 'app/old-name.txt'), 'a module that moves\n');
  writeFileSync(path.join(repo, 'app/m.txt'), 'tracked\n');
  const start = commit(repo, 'Add modules');
  writeFileSync(path.join(repo, 'app/a.txt'), 'a new module\n');
  writeFileSync(path.join(repo, 'app/m.txt'), 'tracked, edited\n');
  git(repo, ['add', 'app/a.txt']);
  git(repo, ['mv', 'app/old-name.txt', 'app/new-name.txt']);
  const staged = codeSnapshot(repo).snapshot;
  git(repo, ['reset', '-q']);
  assert.equal(codeSnapshot(repo).snapshot.digest, staged.digest);
  git(repo, ['add', '-A']);
  assert.equal(codeSnapshot(repo).snapshot.digest, staged.digest);

  const run = startRun(repo, CHANGE, { baseline: true });
  const clone = scratch(t, 'genesis-edd-staged-');
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', start]);
  git(clone, ['apply', path.join(run.directory, 'code.patch')]);
  assert.deepEqual(tree(path.join(clone, 'app')), tree(path.join(repo, 'app')));
  assert.equal(codeSnapshot(clone).snapshot.digest, readRecord(run).run.code_snapshot.digest);
});

test('code.patch applies whatever the user\'s diff settings are, including for a file removed from the index but kept', (t) => {
  const { repo, tools } = readyProject(t);
  writeFileSync(path.join(repo, 'app/kept.txt'), 'kept on disk\n');
  writeFileSync(path.join(repo, 'app/m.txt'), 'tracked\n');
  const start = commit(repo, 'Add modules');
  writeFileSync(tools.gitConfig, '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n[color]\n\tui = always\n\tdiff = always\n');
  git(repo, ['rm', '-q', '--cached', 'app/kept.txt']);
  writeFileSync(path.join(repo, 'app/m.txt'), 'tracked, edited\n');
  const run = startRun(repo, CHANGE, { baseline: true });
  const patch = readFileSync(path.join(run.directory, 'code.patch'), 'utf8');
  assert.ok(!patch.includes('\u001b['), 'no colour codes');
  assert.match(patch, /^diff --git a\/app\/m\.txt b\/app\/m\.txt$/m);

  const clone = scratch(t, 'genesis-edd-config-');
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', start]);
  git(clone, ['apply', path.join(run.directory, 'code.patch')]);
  assert.deepEqual(tree(path.join(clone, 'app')), tree(path.join(repo, 'app')));
});

test('eval check skips packages whose record still matches, proves the changed one, and proves a named one again', (t) => {
  const { repo, root, tools } = readyProject(t);
  const proved = (id) => readJSON(path.join(root, 'checks', id, 'check.json')).checked_at;
  const before = { [FAILURE]: proved(FAILURE), [SUCCESS]: proved(SUCCESS) };
  let calls = tools.runs().length;

  // Nothing changed: nothing runs, and the command still passes.
  const again = checkEval(repo, CHANGE);
  assert.equal(again.passed, true);
  assert.deepEqual(again.cases, []);
  assert.deepEqual(again.already_proved, [FAILURE, SUCCESS]);
  assert.match(again.next, /proved already/);
  assert.equal(tools.runs().length, calls);
  const shown = cli(['eval', 'check', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.json.already_proved, [FAILURE, SUCCESS]);

  // A changed package is proved again; the other one is left as it is.
  const file = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  const changed = checkEval(repo, CHANGE);
  assert.equal(changed.passed, true);
  assert.deepEqual(changed.cases.map((item) => item.case), [SUCCESS]);
  assert.deepEqual(changed.already_proved, [FAILURE]);
  assert.ok(tools.runs().slice(calls).every((call) => valueOf(call.argv, '-p').endsWith(SUCCESS)));
  assert.equal(proved(FAILURE), before[FAILURE]);
  calls = tools.runs().length;

  // --case proves a package again even when its record matches.
  const named = checkEval(repo, CHANGE, { case: FAILURE });
  assert.deepEqual(named.cases.map((item) => item.case), [FAILURE]);
  assert.deepEqual(named.already_proved, []);
  assert.ok(tools.runs().length > calls);
  assert.notEqual(proved(FAILURE), before[FAILURE]);
});

test('eval check proves again a package whose last proof failed, and a failed proof fails the command beside a proved package', (t) => {
  const { repo, root, tools } = readyProject(t);
  const file = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  // A Harbor that answers --version but fails every run: the proof fails.
  const fake = process.env.GENESIS_EDD_HARBOR;
  process.env.GENESIS_EDD_HARBOR = JSON.stringify([process.execPath, '-e',
    "if (process.argv[1] === '--version') console.log('harbor 0.0.0 (broken)'); else process.exit(1);"]);
  let failed;
  try { failed = checkEval(repo, CHANGE); } finally { process.env.GENESIS_EDD_HARBOR = fake; }
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.cases.map((item) => [item.case, item.passed]), [[SUCCESS, false]]);
  assert.deepEqual(failed.already_proved, [FAILURE]);
  assert.match(failed.next, /did not get the result it expects/);

  // The failed record matches the package, but it proves nothing: it runs again.
  const missing = validateEval(repo, CHANGE).cases.find((item) => item.id === SUCCESS).integration.missing;
  assert.deepEqual(missing, ['check']);
  const calls = tools.runs().length;
  const again = checkEval(repo, CHANGE);
  assert.equal(again.passed, true);
  assert.deepEqual(again.cases.map((item) => item.case), [SUCCESS]);
  assert.deepEqual(again.already_proved, [FAILURE]);
  assert.ok(tools.runs().length > calls);
});

// Each package's run edits the application once Harbor is done with it, as an
// agent or the user editing while a run executes would.
const EDIT_DURING_RUN = "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');";

test('code edited while a run executes makes it neither a baseline nor a pass, and the run says to run again on stable code', (t) => {
  const { repo, tools } = readyProject(t);
  harborThen(t, EDIT_DURING_RUN);
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.equal(base.is_baseline, false);
  assert.equal(base.baseline_unavailable_reason, 'execution_blocked');
  assert.match(base.next, /The code changed while this run executed/);
  assert.equal(readRecord(base).run.code_changed_during_run, true);
  // The attempt ran; it is no baseline because the code changed meanwhile.
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('baseline_missing')(error);
    const { message } = error.gaps[0];
    assert.ok(message.startsWith(`The last baseline attempt, ${base.run_id}, ran while the code changed, so it is not a baseline; record it again without editing the code during the run.`), message);
    assert.doesNotMatch(message, /did not run/);
    return true;
  });

  tools.harbor(true);
  rmSync(path.join(repo, 'app/edited.txt'));
  const stable = startRun(repo, CHANGE, { baseline: true });
  assert.equal(stable.is_baseline, true);
  assert.equal(readRecord(stable).run.code_changed_during_run, false);
  assert.ok(stable.warnings.every((warning) => !warning.includes('changed while this run executed')), JSON.stringify(stable.warnings));

  setResults(repo, AFTER);
  harborThen(t, EDIT_DURING_RUN);
  const head = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(head.status, 0, head.stderr);
  assert.equal(head.json.execution_status, 'completed');
  assert.deepEqual(head.json.compare, tally({ holds: 3 }));
  assert.equal(head.json.verdict, 'unverified');
  assert.ok(head.json.warnings.includes('The code changed while this run executed, so its results do not belong to one version of the code. Do not edit the code during a run; run again once it is stable.'),
    JSON.stringify(head.json.warnings));
  assert.match(head.json.next, /run the same command again/);
  const { run } = readRecord(head.json.directory);
  assert.equal(run.code_changed_during_run, true);
  assert.equal(run.verdict, 'unverified');
  // The record keeps the code the run started from.
  assert.equal(run.code_snapshot.file_digests['app/edited.txt'], undefined);
});

// Makes .git read-only, as a sandbox that lets a run read the repository but
// not write to it does, until the returned function makes it writable again.
function readOnlyGit(repo) {
  const chmod = (mode) => assert.equal(spawnSync('chmod', ['-R', mode, path.join(repo, '.git')]).status, 0);
  chmod('a-w');
  return () => chmod('u+w');
}

test('code.patch is written while .git is read-only, nothing is written into its objects, and it restores the code', (t) => {
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/wip.txt'), 'work in progress\n');
  const objects = tree(path.join(repo, '.git/objects'));
  const writable = readOnlyGit(repo);
  let head;
  try { head = startRun(repo, CHANGE); } finally { writable(); }
  assert.equal(head.verdict, 'pass', JSON.stringify(head));
  assert.ok(head.warnings.every((warning) => !warning.includes('could not be written')), JSON.stringify(head.warnings));
  assert.deepEqual(tree(path.join(repo, '.git/objects')), objects);
  const snapshot = readRecord(head).run.code_snapshot;
  assert.equal(snapshot.patch, 'code.patch');
  assert.deepEqual(snapshot.changed_files, ['app/results.json', 'app/wip.txt']);

  const clone = scratch(t, 'genesis-edd-read-only-');
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', snapshot.commit]);
  git(clone, ['apply', path.join(head.directory, 'code.patch')]);
  assert.deepEqual(tree(path.join(clone, 'app')), tree(path.join(repo, 'app')));
});

test('a run whose code.patch cannot be written warns that its code cannot be restored', (t) => {
  // File modes do not stop root from reading a file, so the patch would not fail.
  if (process.getuid?.() === 0) { t.skip('needs a user that file modes apply to'); return; }
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  const locked = path.join(repo, 'app/locked.bin');
  writeFileSync(locked, 'unreadable\n');
  chmodSync(locked, 0o000);
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  const warning = head.warnings.find((entry) => entry.startsWith('code.patch could not be written'));
  assert.match(warning ?? '', /^code\.patch could not be written \(git add failed: .+\), so the code of this run cannot be restored: its commit does not hold the uncommitted files\.$/);
  const { run } = readRecord(head);
  assert.ok(run.warnings.includes(warning));
  assert.equal(run.code_snapshot.patch, undefined);
  assert.ok(!existsSync(path.join(head.directory, 'code.patch')));
});

test('code.patch and loop-start.patch are written when the project path holds a colon, and they restore the code', (t) => {
  if (process.platform === 'win32') { t.skip('a folder name cannot hold a colon on Windows'); return; }
  const { repo, root } = readyProject(t, { parent: scratch(t, 'genesis-edd-a:b-') });
  assert.match(repo, /:/);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  const start = tree(path.join(repo, 'app'));
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.warnings, []);
  assert.equal(started.loop.start_code.patch, 'loop-start.patch');

  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/wip.txt'), 'work in progress\n');
  const head = startRun(repo, CHANGE);
  for (const run of [base, head]) {
    assert.ok(run.warnings.every((warning) => !warning.includes('could not be written')), JSON.stringify(run.warnings));
    assert.equal(readRecord(run).run.code_snapshot.patch, 'code.patch');
  }

  const { commit: at } = readRecord(head).run.code_snapshot;
  for (const [patch, code] of [[path.join(base.directory, 'code.patch'), start], [path.join(root, 'loop-start.patch'), start],
    [path.join(head.directory, 'code.patch'), tree(path.join(repo, 'app'))]]) {
    const clone = scratch(t, 'genesis-edd-colon-clone-');
    git(clone, ['clone', '-q', repo, '.']);
    git(clone, ['checkout', '-q', '--detach', at]);
    git(clone, ['apply', patch]);
    assert.deepEqual(tree(path.join(clone, 'app')), code, patch);
  }
});

test('code.patch is written when the commit is found only through the user\'s GIT_ALTERNATE_OBJECT_DIRECTORIES', (t) => {
  const { repo } = readyProject(t);
  // A clone with no objects of its own, which reads the project's only through the variable.
  const shared = scratch(t, 'genesis-edd-shared-');
  git(shared, ['clone', '-q', '--shared', repo, '.']);
  rmSync(path.join(shared, '.git/objects/info/alternates'));
  const saved = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = saved;
  });
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(repo, '.git/objects');
  writeFileSync(path.join(shared, 'app/wip.txt'), 'work in progress\n');
  const { snapshot } = codeSnapshot(shared);
  assert.deepEqual(snapshot.changed_files, ['app/wip.txt']);
  const file = path.join(scratch(t, 'genesis-edd-patch-'), 'code.patch');
  assert.deepEqual(savePatch(shared, snapshot, file), { patch: 'code.patch', error: null });

  const clone = scratch(t, 'genesis-edd-shared-clone-');
  git(clone, ['clone', '-q', repo, '.']);
  git(clone, ['checkout', '-q', '--detach', snapshot.commit]);
  git(clone, ['apply', file]);
  assert.deepEqual(tree(path.join(clone, 'app')), tree(path.join(shared, 'app')));
});

test('the records .gitignore keeps the lines a user added and gains only the built-in lines it lacks', (t) => {
  const { repo, root } = readyProject(t);
  const file = path.join(root, '..', '.gitignore');
  writeFileSync(file, '# Large logs stay local\n*.log\n!keep-me/\n/*/runs/');
  startRun(repo, CHANGE, { baseline: true });
  const merged = '# Large logs stay local\n*.log\n!keep-me/\n/*/runs/\n/*/checks/\n/*/loop.json\n/*/loop-start.patch\n__pycache__/\n';
  assert.equal(readFileSync(file, 'utf8'), merged);
  setResults(repo, AFTER);
  startRun(repo, CHANGE);
  assert.equal(readFileSync(file, 'utf8'), merged);
});

test('a head run with no ready package is refused with no_runnable_case, as workflow check is, and writes no run', (t) => {
  const { repo, root, runs, tools } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  // An edited package waits for `eval check` again.
  for (const id of [FAILURE, SUCCESS]) writeFileSync(path.join(root, 'evals', id, 'instruction.md'), `Submit the weekly report for scenario ${id} twice.\n`);
  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.status, 'blocked');
  const calls = tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('no_runnable_case')(error);
    assert.deepEqual(error.gaps, workflow.gaps);
    assert.deepEqual(error.resume, workflow.resume);
    assert.match(error.message, /^No package is ready to run\. Waiting: submit-failure-s1 \(check: run `eval check`/);
    return true;
  });
  const refusal = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(refusal.status, 1);
  assert.deepEqual(refusal.json.gaps.map((gap) => [gap.code, gap.route]), [['no_runnable_case', 'write-eval']]);
  assert.deepEqual(refusal.json.resume.command, ['workflow', 'check', 'run-eval', CHANGE, '--repo', repo]);
  assert.deepEqual(runIds(runs), [base.run_id]);
  assert.equal(tools.runs().length, calls);
});

test('a run stopped at its timeout records the timeout, also when Harbor wrote a cancelled trial result on its way out', (t) => {
  const { repo } = readyProject(t, { spec: 'example' });
  startRun(repo, CHANGE, { baseline: true });
  // Like Harbor, this one records the trial it is in as cancelled when told to stop.
  const harbor = path.join(scratch(t, 'genesis-edd-slow-'), 'harbor.mjs');
  writeFileSync(harbor, `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('harbor 0.0.0 (slow)'); process.exit(0); }
const trial = path.join(argv[argv.indexOf('-o') + 1], 'harbor', 'trial-1');
process.on('SIGTERM', () => {
  mkdirSync(trial, { recursive: true });
  writeFileSync(path.join(trial, 'result.json'), JSON.stringify({ exception_info: { exception_type: 'CancelledError', exception_message: '' } }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
  process.env.GENESIS_EDD_HARBOR = JSON.stringify([process.execPath, harbor]);
  const run = startRun(repo, CHANGE, { timeout: 0.03 });
  assert.equal(run.execution_status, 'error');
  assert.equal(run.verdict, 'unverified');
  assert.ok(existsSync(path.join(run.directory, FAILURE, 'logs/harbor/trial-1/result.json')));
  assert.equal(run.cases[0].execution.reason, 'Harbor did not finish within 0.03 minutes and was stopped. Raise --timeout, or find what hangs in logs/.');
});

test('a trial result.json that cannot be read is an execution error with its reason, and the run goes on and is recorded', (t) => {
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  // Harbor stops while it writes the result of the first package's trial.
  harborThen(t, `if (argv[argv.indexOf('-p') + 1].endsWith('${FAILURE}')) {
    const file = path.join(logs, 'harbor', 'trial-1', 'result.json');
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, 20));
  }`);
  const run = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.json.execution_status, 'error');
  assert.equal(run.json.verdict, 'unverified');
  const byCase = Object.fromEntries(run.json.cases.map((item) => [item.id, item]));
  assert.equal(byCase[FAILURE].execution.status, 'error');
  assert.match(byCase[FAILURE].execution.reason, /^logs\/harbor\/trial-1\/result\.json cannot be read \(.+\)\. Harbor may have stopped while writing it; see logs\/harbor\.log\.$/);
  assert.deepEqual(byCase[FAILURE].gating, { pass: 0, fail: 0, unknown: 1 });
  assert.deepEqual(byCase[SUCCESS].execution, { status: 'completed' });
  assert.deepEqual(rows(readRecord(run.json.directory).compare), [
    [FAILURE, 'c1', 'fail', 'unknown', 'unverified'],
    [SUCCESS, 'c1', 'pass', 'pass', 'holds'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);
});

test('a run folder without run.json, left by an interrupted run, is named in a warning that says it can be deleted', (t) => {
  const { repo, runs } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  const interrupted = '20260101-000000-dead';
  mkdirSync(path.join(runs, interrupted, FAILURE, 'logs'), { recursive: true });
  writeFileSync(path.join(runs, interrupted, 'code.patch'), '');
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.equal(head.baseline, base.run_id);
  assert.deepEqual(head.warnings.filter((warning) => warning.startsWith('Run folders')), [`Run folders without a readable run.json, left by a run that was interrupted or is still running: ${interrupted}. They are not counted or compared. Delete them once their logs are no longer needed.`]);
  assert.deepEqual(readRecord(head).run.warnings, head.warnings);
});

test('a head run whose agent, model or attempts differ from the baseline warns which ones, and its verdicts stay as they are', (t) => {
  const { repo } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true, model: 'synthetic/model-a' });
  setResults(repo, AFTER);
  const differs = (run) => run.warnings.filter((warning) => warning.startsWith('The settings of this run differ'));
  const same = startRun(repo, CHANGE, { model: 'synthetic/model-a' });
  assert.deepEqual(differs(same), []);

  const other = startRun(repo, CHANGE, { agent: 'other_agent:OtherAgent', model: 'synthetic/model-b', attempts: 2 });
  assert.equal(other.verdict, 'pass');
  assert.deepEqual(other.compare, tally({ holds: 3 }));
  assert.deepEqual(differs(other), [`The settings of this run differ from those of the baseline ${base.run_id}: agent other_agent:OtherAgent here, ${AGENT} in the baseline; model synthetic/model-b here, synthetic/model-a in the baseline; attempts 2 here, 1 in the baseline. A different result may come from that, not from the change. Run with the baseline's settings to compare like with like.`]);
  assert.deepEqual(readRecord(other).run.warnings, other.warnings);

  const unnamed = startRun(repo, CHANGE);
  assert.deepEqual(differs(unnamed), [`The settings of this run differ from those of the baseline ${base.run_id}: model none here, synthetic/model-a in the baseline. A different result may come from that, not from the change. Run with the baseline's settings to compare like with like.`]);
});
