// Run tests: which base record a head run compares with and how a running loop
// pins it, and the code identity and code.patch, which must not depend on the
// index or on the user's Git settings.
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
  FAILURE, SUCCESS, runIds, rows, find, tally, sha256, valueOf, refused, scratch, tree, loopFile,
} from './helpers/run.js';

// Which base record a head run compares with, and how a running loop pins it.

// assert.throws validator for a run refused with RUN_INPUT_BLOCKED and a gap with this code.
const refusedWith = (code) => (error) => {
  assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
  assert.ok((error.gaps ?? []).some((gap) => gap.code === code), `expected ${code} in ${JSON.stringify(error.gaps)}`);
  return true;
};

// The base record a head run compared with, as run.json and compare.json name it.
const baseRuns = (run) => {
  const { run: record, compare } = readRecord(run);
  return { run: record.base_run, compare: compare.base_run, baseline: record.baseline, compareBaseline: compare.baseline };
};
// baseline_expectations as sorted [case, check, expected] rows.
const expectationRows = (record) => record.baseline_expectations.map(({ case: id, check, expected }) => [id, check, expected])
  .sort((a, b) => `${a[0]}/${a[1]}`.localeCompare(`${b[0]}/${b[1]}`));
// The warning of a base record made while a loop for its Spec runs.
const keepsBaselineWarning = (warnings) => warnings.some((warning) => /keeps comparing with its own baseline .* a new loop/.test(warning));

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

test('a loop.json for a different Spec is not a running loop: head runs compare with the latest base, and until the user accepts that loop a baseline goes on its starting code', (t) => {
  const { repo, root } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  const stale = readJSON(loopFile(root));
  writeFileSync(loopFile(root), `${JSON.stringify({ ...stale, spec: sha256('a Spec exported before this one') }, null, 2)}\n`);

  setResults(repo, AFTER);
  commit(repo);
  // That loop's starting code is still the code before the change.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  setResults(repo, BEFORE);
  // On that code no loop of this Spec warns that it keeps its baseline.
  const later = startRun(repo, CHANGE, { baseline: true });
  assert.equal(later.is_baseline, true, JSON.stringify(later));
  assert.ok(!keepsBaselineWarning(later.warnings), JSON.stringify(later.warnings));
  setResults(repo, AFTER);
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

  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.deepEqual(baseRuns(head), { run: first.run_id, compare: first.run_id, baseline: first.run_id, compareBaseline: first.run_id });
});

test('while a loop runs, a baseline on the starting code is allowed and warns that the loop keeps its own baseline while it runs', (t) => {
  const { repo, runs } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  assert.ok(!keepsBaselineWarning(first.warnings), JSON.stringify(first.warnings));
  const { loop } = startLoop(repo, CHANGE);
  const start = loop.start_code.commit;

  // Right after loop start; an --expect file under .genesis/ is not a code change.
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' });
  const again = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', expect]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.is_baseline, true);
  assert.ok(keepsBaselineWarning(again.json.warnings), JSON.stringify(again.json.warnings));

  // After an uncommitted change is undone.
  setResults(repo, AFTER);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  git(repo, ['checkout', '--', 'app/results.json']);
  const restored = startRun(repo, CHANGE, { baseline: true });
  assert.equal(restored.is_baseline, true, JSON.stringify(restored));
  assert.ok(keepsBaselineWarning(restored.warnings), JSON.stringify(restored.warnings));

  // After a committed change, back on the starting commit.
  setResults(repo, AFTER);
  commit(repo);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refusedWith('baseline_after_change'));
  git(repo, ['checkout', '-q', '--detach', start]);
  const back = startRun(repo, CHANGE, { baseline: true });
  assert.equal(back.is_baseline, true, JSON.stringify(back));
  assert.ok(keepsBaselineWarning(back.warnings), JSON.stringify(back.warnings));
  assert.equal(runIds(runs).length, 4);

  // None of them moved the loop's reference.
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.equal(readRecord(head).run.base_run, first.run_id);
});

test('a head run is refused with loop_ended (baseline_missing) when the loop baseline folder is gone, even though another baseline exists', (t) => {
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
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refusedWith('loop_ended')(error);
    assert.equal(error.gaps[0].reason, 'baseline_missing');
    return true;
  });
  const refusal = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(refusal.status, 1, refusal.stdout);
  assert.equal(refusal.json.code, 'RUN_INPUT_BLOCKED');
  assert.ok(refusal.json.gaps.some((gap) => gap.code === 'loop_ended' && gap.reason === 'baseline_missing'), JSON.stringify(refusal.json));
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

// Appends to a package's Dockerfile after each Harbor call, as an edit during a run would.
const EDIT_PACKAGE = (id) => `appendFileSync(path.join(repo, '.genesis/edd/${CHANGE}/evals/${id}/environment/Dockerfile'), 'RUN true\\n');`;

test('a package or kit edited while a run executes makes it neither a pass nor a baseline, and the run names what changed and says to prove it again', (t) => {
  const { repo, tools } = readyProject(t);
  harborThen(t, EDIT_PACKAGE(SUCCESS));
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.equal(base.is_baseline, false);
  assert.equal(base.baseline_unavailable_reason, 'execution_blocked');
  assert.equal(readRecord(base).run.packages_changed_during_run, true);
  assert.match(base.next, /^The eval packages changed while this run executed/);
  // The attempt ran; it is no baseline because a package changed meanwhile.
  tools.harbor(true);
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('baseline_missing')(error);
    assert.ok(error.gaps[0].message.startsWith(`The last baseline attempt, ${base.run_id}, ran while the eval packages changed, so it is not a baseline; record it again without editing them during the run.`), error.gaps[0].message);
    return true;
  });
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.equal(startRun(repo, CHANGE, { baseline: true }).is_baseline, true);

  setResults(repo, AFTER);
  const digests = Object.fromEntries(validateEval(repo, CHANGE).cases.map((item) => [item.id, item.task_digest]));
  harborThen(t, EDIT_PACKAGE(SUCCESS));
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  assert.deepEqual(head.compare, tally({ holds: 3 }));
  assert.equal(head.verdict, 'unverified');
  const { run } = readRecord(head);
  assert.equal(run.packages_changed_during_run, true);
  assert.equal(run.code_changed_during_run, false);
  assert.deepEqual(run.eval_snapshot.changed_during_run, [SUCCESS]);
  // The record keeps the packages as the run started with them.
  assert.deepEqual(run.task_digest, digests);
  const warning = head.warnings.find((entry) => entry.startsWith('The eval packages changed while this run executed'));
  assert.equal(warning, `The eval packages changed while this run executed: ${SUCCESS} (${SUCCESS}/environment/Dockerfile). Its results do not belong to one version of them. Do not edit packages or the project kit during a run; prove them again with \`eval check\` and run again.`);
  assert.match(head.next, /prove them again with `eval check`, then run the same command again\.$/);

  // A change to the kit changes every package that ran.
  tools.harbor(true);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  harborThen(t, "appendFileSync(path.join(repo, '.genesis/edd/harness/harness.json'), '\\n');");
  const kit = readRecord(startRun(repo, CHANGE)).run;
  assert.equal(kit.verdict, 'unverified');
  assert.deepEqual(kit.eval_snapshot.changed_during_run, [FAILURE, SUCCESS]);
  assert.ok(kit.warnings.some((entry) => entry.includes(`${FAILURE}, ${SUCCESS} (kit/harness.json)`)), JSON.stringify(kit.warnings));

  // A package the run did not execute is no part of it.
  tools.harbor(true);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  harborThen(t, EDIT_PACKAGE(SUCCESS));
  const partial = readRecord(startRun(repo, CHANGE, { case: [FAILURE] })).run;
  assert.equal(partial.packages_changed_during_run, false);
  assert.equal(partial.eval_snapshot.changed_during_run, undefined);
  assert.ok(partial.warnings.every((entry) => !entry.includes('eval packages changed')), JSON.stringify(partial.warnings));
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

test('what a verifier graded in an attempt whose agent raised, a fail or a pass, counts as unknown, so the run did not complete and fails no check', (t) => {
  const { repo } = readyProject(t, { live: [FAILURE] });
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail' }) });
  setResults(repo, { ...AFTER, [FAILURE]: { c1: ['fail', 'pass', 'pass'] } });
  // Harbor still grades the first trial of each package after its agent hit a rate limit.
  harborThen(t, `{
    const file = path.join(logs, 'harbor', 'trial-1', 'result.json');
    const outcome = JSON.parse(readFileSync(file, 'utf8'));
    outcome.exception_info = { exception_type: 'ApiRateLimitError', exception_message: 'rate limited' };
    writeFileSync(file, JSON.stringify(outcome));
  }`);
  const run = startRun(repo, CHANGE);
  assert.deepEqual([run.execution_status, run.verdict], ['error', 'unverified']);
  assert.equal(run.next, 'Execution did not complete. Read cases[].execution.reason and each case\'s logs/harbor.log, fix the cause, then run the same command again.');
  assert.deepEqual(run.compare_gating, tally({ unverified: 3 }));
  const { compare } = readRecord(run);
  assert.deepEqual(rows(compare), [
    [FAILURE, 'c1', 'fail', 'unknown', 'unverified'],
    [SUCCESS, 'c1', 'pass', 'unknown', 'unverified'],
    [SUCCESS, 'c2', 'pass', 'unknown', 'unverified'],
  ]);
  // The fail of attempt 1 is neither a failure nor an attempt with evidence; the passes after it are.
  assert.deepEqual(find(compare, FAILURE, 'c1').after_counts, { pass: 2, fail: 0, unknown: 1 });
  assert.deepEqual(find(compare, SUCCESS, 'c1').after_counts, { pass: 0, fail: 0, unknown: 1 });
  const evidence = readJSON(path.join(run.directory, SUCCESS, 'check-results.json')).results.find((entry) => entry.id === 'c1');
  assert.equal(evidence.result, 'unknown');
  assert.ok(evidence.evidence.startsWith('Attempt 1 did not complete (ApiRateLimitError: rate limited), so what its verifier recorded (pass) is no result of the code.'), evidence.evidence);
  // attempts.json keeps what the verifier graded, beside results that are unknown.
  const attemptsFile = path.join(run.directory, FAILURE, 'attempts.json');
  const recorded = readJSON(attemptsFile);
  assert.deepEqual(recorded.attempts.map((entry) => [entry.status, entry.results.c1, entry.graded?.c1 ?? null]),
    [['error', 'unknown', 'fail'], ['completed', 'pass', null], ['completed', 'pass', null]]);
  // An attempts.json written before graded existed, with the fail as its result, is read the same way.
  const { graded, ...older } = recorded.attempts[0];
  assert.deepEqual(graded, { c1: 'fail' });
  recorded.attempts[0] = { ...older, results: { c1: 'fail' } };
  writeFileSync(attemptsFile, `${JSON.stringify(recorded, null, 2)}\n`);
  assert.deepEqual(readCounts(path.join(run.directory, FAILURE), [{ id: 'c1' }]), { c1: { pass: 2, fail: 0, unknown: 1 } });
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
  const { repo } = readyProject(t, { live: [FAILURE], confirm: false });
  const base = startRun(repo, CHANGE, { baseline: true, model: 'synthetic/model-a', attempts: 1 });
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

test('a multi-step package stays awaiting_integration, missing steps: eval check does not prove it and runs skip it', (t) => {
  const { repo, root } = readyProject(t);
  const directory = path.join(root, 'evals', FAILURE);
  for (const step of ['first', 'second']) {
    mkdirSync(path.join(directory, 'steps', step), { recursive: true });
    writeFileSync(path.join(directory, 'steps', step, 'instruction.md'), `Turn ${step} of the conversation.\n`);
  }
  const file = path.join(directory, 'tests/checks.json');
  const declared = readJSON(file);
  declared.checks = declared.checks.map((check) => ({ ...check, at: 'second' }));
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);

  const evals = validateEval(repo, CHANGE);
  assert.ok(evals.warnings.includes(`${FAILURE} is a multi-step package, which this release cannot run, so a full run of this change cannot pass. Tell the user before a loop starts.`), JSON.stringify(evals.warnings));
  const item = evals.cases.find((entry) => entry.id === FAILURE);
  assert.deepEqual(item.errors, []);
  assert.equal(item.integration.state, 'awaiting_integration');
  assert.ok(item.integration.missing.includes('steps'), JSON.stringify(item.integration));
  assert.ok(item.integration.detail.some((entry) => entry.startsWith('steps: multi-step packages are not supported yet')), JSON.stringify(item.integration));

  const checked = checkEval(repo, CHANGE);
  assert.ok(checked.skipped.some((entry) => entry.case === FAILURE && entry.missing.includes('steps')), JSON.stringify(checked));
  assert.ok(!checked.cases.some((entry) => entry.case === FAILURE));
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.ok(base.skipped.some((entry) => entry.case === FAILURE && entry.reason === 'awaiting_integration'), JSON.stringify(base.skipped));
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.notEqual(head.verdict, 'pass');
  assert.ok(head.skipped.some((entry) => entry.case === FAILURE));
});

test('in a new project with an unavailable baseline and no package connected yet, workflow check run-eval points at loop start', (t) => {
  const { repo } = readyProject(t, { mode: 'new', results: {}, unconnected: [FAILURE, SUCCESS] });
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.match(base.next, /^That no baseline could run is recorded\. To implement the change/);
  assert.doesNotMatch(base.next, /does not start on code other than/);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.equal(check.next.action, 'start_loop');
  assert.equal(check.next.route, 'loop-and-implement');
  assert.match(check.next.note, /^That no baseline could run is recorded/);
  // A record that nothing could run says so of the code it was recorded on:
  // once the code changed, it is recorded again before a loop starts.
  setResults(repo, AFTER);
  commit(repo, 'Write a first implementation');
  const moved = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(moved.next.action, 'record_baseline');
  assert.match(moved.next.note, new RegExp(`^The baseline ${base.run_id} records that nothing could run on other code than the code now: record it again on the code the loop starts from\\.`));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.ok(error.gaps.some((entry) => entry.code === 'baseline_not_at_start'), JSON.stringify(error.gaps));
    assert.equal(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').message, `The baseline ${base.run_id} records that nothing could run on other code than the code now. A loop starts on the code its baseline was recorded on: record the baseline again on the code the loop starts from, with \`run start --baseline --unavailable no_implementation\`.`);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});
