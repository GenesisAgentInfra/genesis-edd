// Run tests of what a run records that a pass can be trusted on: trials, the
// run index, lost and interrupted runs, the accepted code, estimates, the
// read-only views of the runs and their cleanup, and code-level checks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { reviewEval } from '../src/confirm.js';
import { checkEval, cleanupRun, compareRuns, listRuns, readRuns, sameCodeResults, showRun, startRun } from '../src/run.js';
import { abandonChange, acceptLoop, endLoop, loopStatus } from '../src/loop.js';
import { readDecisions } from '../src/records.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, BEFORE, CHANGE, cli, commit, confirmChecks, git, harborThen, readRecord, readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import { EXPECT, changeCode, inLoop, reviewRun, withBaseline } from './helpers/loop.js';
import {
  APPROVAL_FLAGS, CONSENT, FAILURE, REF, SUCCESS, USER, actionOf, assertGapShape, assertNoRoutes, find, loopFile, refused, rows, runIds, scratch,
  startLoop, tally,
} from './helpers/run.js';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// The entries of the run index of a project, oldest first.
const indexOf = (runs) => {
  const file = path.join(runs, 'index.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const entryOf = (runs, id, event) => indexOf(runs).find((entry) => entry.run_id === id && entry.event === event);
// The failures on the code as it is now, as workflow status lists them, as
// case/check: failures.
const failuresNow = (repo) => Object.fromEntries(workflowStatus(repo, CHANGE).layers.ledger.failures_on_code_now
  .map((entry) => [`${entry.case}/${entry.check}`, entry.failures]));

// --- Trials ---

test('a trial runs before any baseline, never passes, is never a baseline, and its failures count for its code', (t) => {
  const { repo, runs, tools } = readyProject(t);
  const calls = tools.runs().length;
  const failing = startRun(repo, CHANGE, { trial: true });
  assert.deepEqual([failing.side, failing.scope, failing.role, failing.execution_status], ['trial', 'full', null, 'completed']);
  assert.equal(failing.verdict, 'fail');
  assert.equal(failing.is_baseline, false);
  assert.deepEqual([failing.baseline, failing.base_run], [null, null]);
  assert.match(failing.not_acceptance, /A trial is never a baseline, a run of a loop, an accepted run or a proof/);
  assert.equal(failing.acceptable, false);
  assert.ok(failing.unverified_by.includes('trial'), JSON.stringify(failing.unverified_by));
  assert.equal(tools.runs().length, calls + 2);
  const record = readRecord(failing);
  assert.deepEqual([record.run.side, record.run.is_baseline, record.run.loop, record.run.tier], ['trial', false, null, null]);
  assert.deepEqual(rows(record.compare), [
    [FAILURE, 'c1', null, 'fail', 'violated'],
    [SUCCESS, 'c1', null, 'pass', 'head_only'],
    [SUCCESS, 'c2', null, 'pass', 'head_only'],
  ]);
  assert.ok(record.compare.results.every((entry) => entry.before_unavailable_reason === 'no_baseline'));
  // A trial is no baseline: a head run still needs one.
  assert.throws(() => startRun(repo, CHANGE), refused('baseline_missing'));
  // Its completed failure counts for its code, like any run's.
  assert.deepEqual(failuresNow(repo), { [`${FAILURE}/c1`]: 1 });
  assert.equal(entryOf(runs, failing.run_id, 'start').side, 'trial');

  // A trial in which every gating check passed is still not a pass.
  setResults(repo, AFTER);
  const passing = startRun(repo, CHANGE, { trial: true });
  assert.deepEqual([passing.verdict, passing.trial_gating_passed], ['unverified', true]);
  assert.deepEqual(passing.unverified_by, ['trial']);
  assert.deepEqual(passing.compare_gating, tally({ head_only: 3 }));
  assert.equal(readRecord(passing).run.trial_gating_passed, true);
  assert.deepEqual(listRuns(repo, CHANGE, { side: 'trial' }).runs.map((run) => run.run_id), [failing.run_id, passing.run_id]);
  assert.deepEqual(listRuns(repo, CHANGE, { side: 'base' }).runs, []);
});

test('a trial runs packages that are valid but not ready, and skips those that cannot run', (t) => {
  const { repo, tools } = readyProject(t, { unconnected: [SUCCESS] });
  // The package that is not connected cannot be part of a baseline that runs ...
  const calls = tools.runs().length;
  const trial = startRun(repo, CHANGE, { trial: true });
  // ... but a trial runs it as it is.
  assert.deepEqual(trial.cases.map((item) => item.id), [FAILURE, SUCCESS]);
  assert.deepEqual(trial.skipped, []);
  assert.equal(tools.runs().length, calls + 2);
  // --case limits it, and the trial is partial.
  const one = startRun(repo, CHANGE, { trial: true, case: [SUCCESS] });
  assert.deepEqual([one.scope, one.cases.map((item) => item.id)], ['partial', [SUCCESS]]);
  assert.deepEqual(one.skipped, [{ case: FAILURE, reason: 'not_selected' }]);
});

test('a trial that calls a model before any checks confirmation needs the user\'s cost approval, recorded with who and where', (t) => {
  const { repo, root, runs, tools } = readyProject(t, { live: [FAILURE], confirm: false });
  const calls = tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE, { trial: true }), (error) => {
    refused('cost_unapproved')(error);
    const gap = assertGapShape(error.gaps[0], { kind: 'business', owner: 'user', layer: 'confirmation' });
    assert.deepEqual([gap.live, gap.model], [[FAILURE], null]);
    return true;
  });
  // Both flags go together.
  assert.throws(() => startRun(repo, CHANGE, { trial: true, approvedBy: USER }), /--approved-by and --ref go together/);
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), []);

  const trial = cli(['run', 'start', CHANGE, '--repo', repo, '--trial', ...APPROVAL_FLAGS]);
  assert.equal(trial.status, 0, trial.stderr);
  assert.deepEqual([trial.json.cost_approval.by, trial.json.cost_approval.ref], [USER, REF]);
  const recorded = readRecord(trial.json.directory).run;
  assert.deepEqual([recorded.cost_approval.by, recorded.cost_approval.ref], [USER, REF]);
  assert.deepEqual([entryOf(runs, trial.json.run_id, 'start').cost_approval.by, entryOf(runs, trial.json.run_id, 'start').cost_approval.ref], [USER, REF]);
  const decisions = readDecisions(root).entries.filter((entry) => entry.type === 'cost_approval');
  assert.deepEqual(decisions.map((entry) => [entry.by, entry.ref, entry.run_id, entry.side]), [[USER, REF, trial.json.run_id, 'trial']]);
  // The user sees, before they confirm, that a trial ran before any baseline
  // and that a model-calling run was approved before any confirmation.
  const codes = reviewEval(repo, CHANGE).must_decide.map((item) => item.code);
  assert.ok(codes.includes('trial_before_baseline') && codes.includes('cost_approved_runs'), JSON.stringify(codes));
});

test('a trial inside a loop is no run of the loop: it records the loop with role trial, cannot be reviewed or accepted, and spends the loop budget', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const trial = startRun(repo, CHANGE, { trial: true });
  assert.deepEqual([trial.role, trial.verdict, trial.trial_gating_passed, trial.tier], ['trial', 'unverified', true, 'light']);
  const record = readRecord(trial).run;
  assert.equal(record.loop.started_at, project.loop.started_at);
  assert.equal(record.base_run, project.base.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.ok(!status.runs.some((run) => run.run_id === trial.run_id), JSON.stringify(status.runs));
  // It spends the loop's budget like a run of the loop.
  assert.equal(status.loop.used.iterations, 1, JSON.stringify(status.loop.used));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: trial.run_id, ...CONSENT }), (error) => {
    assert.ok(error.gaps.some((gap) => gap.code === 'trial_not_acceptable'), JSON.stringify(error.gaps));
    return true;
  });
  assert.throws(() => reviewRun(project, trial.run_id));
  // The head run of the same code is the loop's run.
  const head = startRun(repo, CHANGE);
  assert.deepEqual([head.side, head.verdict, head.acceptable], ['head', 'pass', true]);
});

// A loop that ended without the user's acceptance, with the change in the
// working directory.
function endedLoop(t) {
  const project = inLoop(t);
  changeCode(project.repo, AFTER, 'Stop the success notice when a submission fails');
  endLoop(project.repo, CHANGE, { reason: 'Synthetic: the agent stops here.' });
  return project;
}

test('once a loop ended without acceptance, a head run or a trial of the application code is refused before anything runs', (t) => {
  const { repo, runs, tools } = endedLoop(t);
  const calls = tools.runs().length;
  const folders = runIds(runs);
  for (const options of [{ trial: true }, {}]) {
    assert.throws(() => startRun(repo, CHANGE, options), (error) => {
      refused('change_locked', 'loop_ended')(error);
      const gap = assertGapShape(error.gaps[0], { owner: 'user', layer: 'loop', reason: 'loop_end' });
      assert.equal(gap.unlocks.length, 2, JSON.stringify(gap.unlocks));
      return true;
    }, JSON.stringify(options));
  }
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), folders);
  const status = workflowStatus(repo, CHANGE);
  assert.ok(actionOf(status, 'run', 'start', '--trial').blocked_by.includes('change_locked'), JSON.stringify(actionOf(status, 'run', 'start', '--trial')));
  assert.equal(status.must_show.change_lock[0].reason, 'loop_end');
});

test('once a loop ended without acceptance, a trial on the pinned start code still runs', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  // The start code keeps the evals out of its images, so it can be rebuilt.
  writeFileSync(path.join(repo, '.dockerignore'), '.genesis\n');
  commit(repo, 'Keep the evals out of the image');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  endLoop(repo, CHANGE, { reason: 'Synthetic: the agent stops here.' });
  assert.throws(() => startRun(repo, CHANGE, { trial: true }), refused('change_locked', 'loop_ended'));
  // The start code is rebuilt outside the project and runs as a trial.
  const atStart = startRun(repo, CHANGE, { trial: true, atStart: true });
  assert.equal(atStart.execution_status, 'completed', JSON.stringify(atStart));
  assert.equal(atStart.verdict, 'fail');
  assert.equal(readRecord(atStart).run.at_start, true);
  assert.equal(readRecord(atStart).run.code_snapshot.digest, readRecord(base).run.code_snapshot.digest);
  // The working directory still holds the change.
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, 'app/results.json'), 'utf8')), AFTER);
});

// --- The run index ---

test('every run is listed in the run index: a start entry before Harbor runs and a finish entry once run.json is written', (t) => {
  const { repo, runs, tools } = readyProject(t);
  // While Harbor runs, the index already lists the run, unfinished.
  const seen = path.join(tools.directory, 'index-while-running.jsonl');
  harborThen(t, `appendFileSync(${JSON.stringify(seen)}, readFileSync(path.join(repo, '.genesis/edd/${CHANGE}/runs/index.jsonl'), 'utf8') + '---\\n');`);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail' }) });
  const during = readFileSync(seen, 'utf8').split('---\n')[0].split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(during.map((entry) => [entry.event, entry.run_id]), [['start', base.run_id]]);

  const start = entryOf(runs, base.run_id, 'start');
  const { run } = readRecord(base);
  assert.deepEqual([start.side, start.scope, start.role, start.loop, start.spec], ['base', 'full', null, null, run.spec_snapshot.sha256]);
  assert.deepEqual(start.code.snapshot.digest, run.code_snapshot.digest);
  assert.equal(typeof start.code.identity, 'string');
  assert.deepEqual(start.cases, [FAILURE, SUCCESS]);
  assert.deepEqual([start.task_digest, start.run_digest], [run.task_digest, run.run_digest]);
  assert.deepEqual(start.attempts, { [FAILURE]: 1, [SUCCESS]: 1 });
  assert.deepEqual(start.gating, { [FAILURE]: ['c1'], [SUCCESS]: ['c1', 'c2'] });
  assert.deepEqual(start.expectations.map((entry) => [entry.case, entry.check, entry.expected]), [[FAILURE, 'c1', 'fail']]);
  assert.deepEqual(start.run_plan, run.environment_ref.run_plan);
  const finish = entryOf(runs, base.run_id, 'finish');
  assert.deepEqual([finish.execution_status, finish.verdict, finish.minutes], ['completed', null, run.usage.minutes]);
  // The finish entry holds the digest of run.json as it was written.
  assert.equal(finish.run_json, sha256(readFileSync(path.join(base.directory, 'run.json'))));
  assert.equal(run.indexed, true);
  // Each later run adds its own two entries; nothing is rewritten.
  tools.harbor(true);
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.deepEqual(indexOf(runs).map((entry) => [entry.event, entry.run_id]),
    [['start', base.run_id], ['finish', base.run_id], ['start', head.run_id], ['finish', head.run_id]]);
  assert.equal(entryOf(runs, head.run_id, 'finish').verdict, 'pass');
});

test('a run whose folder is deleted still counts: it is lost, counts as a failure of every gating check of its packages on its code, and is disclosed', (t) => {
  const { repo, runs } = readyProject(t);
  const base = startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.deepEqual(failuresNow(repo), {});
  rmSync(head.directory, { recursive: true, force: true });

  // Even a run that passed counts as a failure once its record is gone.
  const lost = readRuns(runs).find((run) => run.run_id === head.run_id);
  assert.deepEqual([lost.lost, lost.execution_status, lost.verdict, lost.side], [true, 'lost', 'fail', 'head']);
  assert.deepEqual(lost.cases.map((item) => item.id), [FAILURE, SUCCESS]);
  assert.deepEqual(failuresNow(repo), { [`${FAILURE}/c1`]: 1, [`${SUCCESS}/c1`]: 1, [`${SUCCESS}/c2`]: 1 });
  const spec = readRecord(base).run.spec_snapshot.sha256;
  assert.ok(sameCodeResults(repo, runs, spec).some((entry) => entry.run_id === head.run_id && entry.result === 'fail'));
  // Every view names it.
  const status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.ledger.runs.lost, [head.run_id]);
  assert.ok(status.layers.ledger.text.includes(head.run_id), status.layers.ledger.text);
  assert.deepEqual(listRuns(repo, CHANGE).runs.find((run) => run.run_id === head.run_id).lost, true);
  assert.deepEqual(listRuns(repo, CHANGE).ledger.lost.map((entry) => entry.run_id), [head.run_id]);
  const shown = showRun(repo, CHANGE, { run: head.run_id });
  assert.deepEqual([shown.folder_exists, shown.run.lost, shown.index.start.run_id, shown.index.finish.verdict], [false, true, head.run_id, 'pass']);
  assert.throws(() => compareRuns(repo, CHANGE, { run: head.run_id }), /is lost: its record is gone/);
  // A lost run means the change no longer qualifies for the light tier.
  assert.equal(validateEval(repo, CHANGE).tier.eligible, false);
  // The next run says so.
  const next = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.ok(next.warnings.some((warning) => warning.startsWith('Run index: ') && warning.includes(head.run_id)), JSON.stringify(next.warnings));
  // Nothing tells anyone to delete a run folder.
  assert.ok(next.warnings.every((warning) => !/delete/i.test(warning)), JSON.stringify(next.warnings));
});

test('a run whose folder is there but that never finished is interrupted, and the attempts it completed count', (t) => {
  const { repo, runs } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true });
  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'fail');
  // As if the run stopped before it wrote run.json: no record and no finish entry.
  rmSync(path.join(head.directory, 'run.json'));
  const kept = indexOf(runs).filter((entry) => !(entry.run_id === head.run_id && entry.event === 'finish'));
  writeFileSync(path.join(runs, 'index.jsonl'), kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const interrupted = readRuns(runs).find((run) => run.run_id === head.run_id);
  assert.deepEqual([interrupted.interrupted, interrupted.execution_status, interrupted.lost], [true, 'interrupted', undefined]);
  // Only its completed failure counts, not a failure of every check.
  assert.deepEqual(failuresNow(repo), { [`${SUCCESS}/c2`]: 1 });
  assert.deepEqual(workflowStatus(repo, CHANGE).layers.ledger.runs.interrupted, [head.run_id]);
  const listed = listRuns(repo, CHANGE).runs.find((run) => run.run_id === head.run_id);
  assert.equal(listed.interrupted, true);
  assert.ok(showRun(repo, CHANGE, { run: head.run_id }).attempts[SUCCESS].length === 1);
  assert.throws(() => compareRuns(repo, CHANGE, { run: head.run_id }), /is interrupted: it never finished/);
  const next = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.ok(next.warnings.some((warning) => warning.startsWith('Run folders without a readable run.json') && warning.includes(head.run_id)), JSON.stringify(next.warnings));
});

test('a run index that is gone while runs were recorded in it is disclosed, and no loop starts until the user decides', (t) => {
  const { repo, runs } = withBaseline(t);
  rmSync(path.join(runs, 'index.jsonl'));
  const status = workflowStatus(repo, CHANGE);
  assert.equal(status.layers.ledger.index_missing, true);
  assertGapShape(status.layers.ledger.gaps[0], { code: 'ledger_index_missing', owner: 'user', layer: 'ledger' });
  assert.ok(actionOf(status, 'loop', 'start').blocked_by.includes('ledger_index_missing'), JSON.stringify(actionOf(status, 'loop', 'start')));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.ok(error.gaps.some((gap) => gap.code === 'ledger_index_missing'), JSON.stringify(error.gaps));
    return true;
  });
  // A run still runs, and says so.
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.ok(head.warnings.some((warning) => warning.startsWith('Run index: runs/index.jsonl is gone')), JSON.stringify(head.warnings));
});

// --- The accepted code ---

// A loop the user accepted: the change passed, its final review is recorded,
// and accepted.json is committed with the code.
function acceptedChange(t) {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = startRun(repo, CHANGE);
  assert.equal(run.verdict, 'pass', JSON.stringify(run));
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  commit(repo, 'Accept the change');
  return { ...project, accepted: run };
}

test('a baseline on the code the user accepted for this export is refused with code_holds_accepted_change before anything runs, on a fresh clone too', (t) => {
  const project = acceptedChange(t);
  const { repo, runs, tools } = project;
  const calls = tools.runs().length;
  const folders = runIds(runs);
  const accepted = path.join(project.root, 'accepted.json');
  assert.ok(existsSync(accepted));
  for (const options of [{ baseline: true }, { baseline: true, expect: writeExpectations(repo, EXPECT) }]) {
    assert.throws(() => startRun(repo, CHANGE, options), (error) => {
      refused('code_holds_accepted_change')(error);
      const gap = assertGapShape(error.gaps[0], { owner: 'agent', layer: 'baseline', path: `.genesis/edd/${CHANGE}/accepted.json`, run: project.accepted.run_id });
      assert.equal(gap.code_digest, readRecord(project.accepted).run.code_snapshot.digest);
      assert.equal(gap.start_code.digest, readRecord(project.base).run.code_snapshot.digest);
      return true;
    }, JSON.stringify(options));
  }
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), folders);

  // A fresh clone has accepted.json but no runs and no loop.json.
  const clone = scratch(t, 'genesis-edd-fresh-clone-');
  git(clone, ['clone', '-q', repo, '.']);
  assert.ok(!existsSync(path.join(clone, '.genesis/edd', CHANGE, 'runs')) && !existsSync(path.join(clone, '.genesis/edd', CHANGE, 'loop.json')));
  const refusal = cli(['run', 'start', CHANGE, '--repo', clone, '--baseline']);
  assert.equal(refusal.status, 1, refusal.stdout);
  assert.deepEqual(refusal.json.gaps.map((gap) => gap.code), ['code_holds_accepted_change']);
  assertNoRoutes(refusal.json, 'refusal');
  assert.ok(!existsSync(path.join(clone, '.genesis/edd', CHANGE, 'runs')), 'no run folder or index on the clone');
  assert.equal(tools.runs().length, calls);
  // workflow status does not suggest it either.
  const status = workflowStatus(clone, CHANGE);
  assert.ok(actionOf(status, 'run', 'start', '--baseline').blocked_by.includes('code_holds_accepted_change'), JSON.stringify(actionOf(status, 'run', 'start', '--baseline')));
  assert.ok(!(status.suggestion?.command ?? []).includes('--baseline'), JSON.stringify(status.suggestion));
  // With the code before the change back in the clone's working directory,
  // accepted.json still there, a baseline is allowed once the packages are proved here.
  setResults(clone, BEFORE);
  rmSync(path.join(clone, 'app/handler.txt'));
  assert.equal(checkEval(clone, CHANGE).passed, true);
  const before = startRun(clone, CHANGE, { baseline: true, expect: writeExpectations(clone, EXPECT) });
  assert.equal(before.is_baseline, true, JSON.stringify(before));
  assert.equal(readRecord(before).run.code_snapshot.digest, readRecord(project.base).run.code_snapshot.digest);
});

test('a baseline on the accepted code is allowed when that code is also the start code of the accepted loop', (t) => {
  // The code already behaves as the Spec asks: the loop is accepted with no code change.
  const project = readyProject(t, { results: AFTER });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' }) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  startLoop(repo, CHANGE);
  const run = startRun(repo, CHANGE);
  assert.equal(run.verdict, 'pass', JSON.stringify(run));
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, ...CONSENT });
  commit(repo, 'Accept the change');
  assert.equal(readRecord(run).run.code_snapshot.digest, readRecord(base).run.code_snapshot.digest);
  const again = startRun(repo, CHANGE, { baseline: true });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  assert.ok(!again.warnings.some((warning) => warning.includes('accepted')), JSON.stringify(again.warnings));
});

// --- Estimates ---

// Sleeps ms milliseconds inside a Harbor wrapper (harborThen), so the run's
// own minutes exceed the time its attempts recorded.
const SLEEP = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;

test('the run plan at confirmation estimates runs from the baseline\'s attempts plus its per-run overhead, which is never below 0', (t) => {
  // Attempts that record no time of their own, in a run that takes over three seconds.
  const project = readyProject(t, { spec: 'example', results: { [FAILURE]: { c1: 'fail', $seconds: 0 } } });
  const { repo } = project;
  harborThen(t, SLEEP(3200));
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail' }) });
  project.tools.harbor(true);
  const { usage } = readRecord(base).run;
  assert.deepEqual([usage.minutes, usage.attempt_minutes], [0.1, 0]);
  const plan = reviewEval(repo, CHANGE).run_plan;
  assert.equal(plan.basis, 'baseline_attempts');
  assert.deepEqual(plan.run_overhead, { minutes: 0.1, baseline: base.run_id });
  assert.deepEqual(plan.estimate, [{ attempts: 1, baseline_minutes: 0.1, screen_minutes: 0.1, final_minutes: 0.1, cost_usd: null }]);
  // A loop on that baseline estimates the same way.
  startLoop(repo, CHANGE);
  const estimate = loopStatus(repo, CHANGE).loop.estimate;
  assert.deepEqual(estimate.run_overhead, { minutes: 0.1, baseline: base.run_id });
  assert.equal(estimate.screen.minutes, 0.1);

  // Attempts that took longer than the run's own minutes add no overhead.
  const slow = readyProject(t, { spec: 'example', results: { [FAILURE]: { c1: 'fail', $seconds: 30 } } });
  const slowBase = startRun(slow.repo, CHANGE, { baseline: true });
  assert.ok(readRecord(slowBase).run.usage.minutes < readRecord(slowBase).run.usage.attempt_minutes, JSON.stringify(readRecord(slowBase).run.usage));
  const slowPlan = reviewEval(slow.repo, CHANGE).run_plan;
  assert.equal(slowPlan.basis, 'baseline_attempts');
  assert.equal(slowPlan.run_overhead, undefined);
  assert.deepEqual(slowPlan.estimate.map((entry) => [entry.screen_minutes, entry.final_minutes]), [[0.5, 0.5]]);
});

// --- Read-only views of the runs ---

test('run list, show and compare read the runs without writing anything, and compare again with another baseline', (t) => {
  const { repo, runs } = readyProject(t);
  const first = startRun(repo, CHANGE, { baseline: true });
  setResults(repo, AFTER);
  commit(repo);
  const head = startRun(repo, CHANGE);
  const trial = startRun(repo, CHANGE, { trial: true });
  // A later baseline that expects the success notice to fail before the change.
  git(repo, ['checkout', '-q', 'HEAD~1', '--', 'app/results.json']);
  const later = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${SUCCESS}/c1`]: 'fail' }) });
  const written = indexOf(runs).length;

  const listed = cli(['run', 'list', CHANGE, '--repo', repo]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.json.runs.map((run) => [run.run_id, run.side, run.verdict, run.is_baseline]),
    [[first.run_id, 'base', null, true], [head.run_id, 'head', 'pass', false], [trial.run_id, 'trial', 'unverified', false], [later.run_id, 'base', null, true]]);
  const entry = listed.json.runs.find((run) => run.run_id === head.run_id);
  assert.deepEqual([entry.scope, entry.role, entry.loop, entry.cases, entry.code.uncommitted], ['full', null, null, [FAILURE, SUCCESS], 0]);
  assert.equal(entry.code.commit, readRecord(head).run.code_snapshot.commit);
  assert.deepEqual(listRuns(repo, CHANGE, { side: 'head' }).runs.map((run) => run.run_id), [head.run_id]);
  assert.throws(() => listRuns(repo, CHANGE, { side: 'final' }), /--side is base, head or trial/);

  const shown = cli(['run', 'show', CHANGE, '--repo', repo, '--run', head.run_id]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.json.run, readRecord(head).run);
  assert.deepEqual(shown.json.compare, readRecord(head).compare);
  assert.deepEqual(Object.keys(shown.json.attempts), [FAILURE, SUCCESS]);
  assert.deepEqual(shown.json.attempts[FAILURE].map((attempt) => attempt.results), [{ c1: 'pass' }]);
  assert.deepEqual([shown.json.index.start.event, shown.json.index.finish.event, shown.json.folder_exists], ['start', 'finish', true]);
  assert.throws(() => showRun(repo, CHANGE, { run: 'no-such-run' }), /No run no-such-run/);
  assert.throws(() => showRun(repo, CHANGE, {}), /--run names the run to show/);

  // By default a run is compared with the latest valid baseline of its export.
  const latest = compareRuns(repo, CHANGE, { run: head.run_id });
  assert.equal(latest.against, later.run_id);
  assert.deepEqual(latest.results.map(({ case: id, check, before, after, verdict }) => [id, check, before, after, verdict]), [
    [FAILURE, 'c1', 'fail', 'pass', 'holds'],
    [SUCCESS, 'c1', 'pass', 'pass', 'base_mismatch'],
    [SUCCESS, 'c2', 'pass', 'pass', 'holds'],
  ]);
  assert.deepEqual(latest.compare_gating, tally({ holds: 2, base_mismatch: 1 }));
  // --against names another base record: the run's own comparison again.
  const again = cli(['run', 'compare', CHANGE, '--repo', repo, '--run', head.run_id, '--against', first.run_id]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.results.map(({ case: id, check, verdict }) => [id, check, verdict]), rows(readRecord(head).compare).map(([id, check, , , verdict]) => [id, check, verdict]));
  assert.deepEqual(again.json.compare, readRecord(head).compare.results.reduce((counts, item) => ({ ...counts, [item.verdict]: counts[item.verdict] + 1 }), tally({})));
  // A trial compares too; a head run is no base record to compare with.
  assert.equal(compareRuns(repo, CHANGE, { run: trial.run_id }).side, 'trial');
  assert.throws(() => compareRuns(repo, CHANGE, { run: trial.run_id, against: head.run_id }), /is no base record/);
  // Two base records of the same code say so.
  assert.ok(compareRuns(repo, CHANGE, { run: first.run_id, against: later.run_id }).warnings.includes(`${later.run_id} and ${first.run_id} ran the same code.`));
  // Nothing was written.
  assert.equal(indexOf(runs).length, written);
  assert.deepEqual(runIds(runs), [first.run_id, head.run_id, trial.run_id, later.run_id].sort());
});

// --- Cleanup ---

test('run cleanup removes the Docker objects of that run\'s Harbor projects only, also for a run that never finished, and never images', (t) => {
  const { repo, runs, tools } = readyProject(t, { spec: 'example', live: [FAILURE] });
  const base = startRun(repo, CHANGE, { baseline: true });
  const projects = readRecord(base).run.harbor_projects[FAILURE];
  assert.deepEqual(projects.map((entry) => entry.project), ['trial-1__env', 'trial-2__env', 'trial-3__env']);
  // A verifier in its own compose project, named after its trial, is this run's too.
  tools.dockerObjects({
    containers: [{ id: 'c1', project: 'trial-1__env' }, { id: 'c2', project: 'trial-2__verifier' }, { id: 'c9', project: 'other-app' }],
    networks: [{ id: 'n3', project: 'trial-3__env' }, { id: 'n9', project: 'other-app' }],
    volumes: [{ id: 'v9', project: 'other-app' }],
  });
  const cleaned = cli(['run', 'cleanup', CHANGE, '--repo', repo, '--run', base.run_id]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(cleaned.json.projects, ['trial-1__env', 'trial-2__env', 'trial-2__verifier', 'trial-3__env']);
  assert.deepEqual(cleaned.json.removed, { containers: ['c1', 'c2'], networks: ['n3'], volumes: [] });
  assert.deepEqual(cleaned.json.errors, []);
  assert.deepEqual(tools.dockerObjects(), { containers: [{ id: 'c9', project: 'other-app' }], networks: [{ id: 'n9', project: 'other-app' }], volumes: [{ id: 'v9', project: 'other-app' }] });
  assert.ok(tools.dockerCalls().every((call) => !['prune', 'rmi', 'image', 'system'].some((word) => call.argv.includes(word))), JSON.stringify(tools.dockerCalls()));

  // A run that never finished: its trial folders on disk name its projects.
  rmSync(path.join(base.directory, 'run.json'));
  const kept = indexOf(runs).filter((entry) => !(entry.run_id === base.run_id && entry.event === 'finish'));
  writeFileSync(path.join(runs, 'index.jsonl'), kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  tools.dockerObjects({ containers: [{ id: 'c4', project: 'trial-3__env' }] });
  const unfinished = cleanupRun(repo, CHANGE, { run: base.run_id });
  assert.deepEqual([unfinished.removed.containers, unfinished.still_running_possible], [['c4'], true]);

  assert.throws(() => cleanupRun(repo, CHANGE, { run: 'no-such-run' }), /No run no-such-run/);
  tools.docker(false);
  assert.throws(() => cleanupRun(repo, CHANGE, { run: base.run_id }), (error) => {
    assertGapShape(error.gaps[0], { code: 'docker_unavailable', owner: 'agent', layer: 'machine' });
    return true;
  });
});

// --- Code-level checks ---

// Makes c2 of SUCCESS a code test: a test program frozen in the package that
// runs against the application code with no adapter. In these tests the fake
// Harbor reads what a code test finds under the probe from app/probe.json,
// which stands for the code as it is; its counterexample is a code patch
// that breaks that code, applied by eval check to a copy of it.
function codeTest(repo, root) {
  const directory = path.join(root, 'evals', SUCCESS);
  const file = path.join(directory, 'tests/checks.json');
  const declared = readJSON(file);
  declared.checks = declared.checks.map((check) => (check.id === 'c2' ? { ...check, kind: 'code_test', command: 'code/no_failure_notice.sh' } : check));
  // The counterexample of c2's line breaks the code: under the nop agent the
  // verifier check c1 has no evidence, and the code test fails.
  declared.fixtures = declared.fixtures.map((fixture) => (fixture.name === 'review-c2' ? { ...fixture, kind: 'code_patch', expect: { c1: 'unknown', c2: 'fail' } } : fixture));
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  mkdirSync(path.join(directory, 'tests/code'), { recursive: true });
  writeFileSync(path.join(directory, 'tests/code/no_failure_notice.sh'), '#!/bin/sh\n# Synthetic code test: a successful submission sends no failure notice.\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(directory, 'tests/test.sh'), `#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\n# Synthetic verifier. In these tests the fake Harbor stands in for it.\ngate c1 unknown "synthetic"\ngate_code c2 code/no_failure_notice.sh\nfinish\n`, { mode: 0o755 });
  rmSync(path.join(directory, 'tests/fixtures/review-c2.sh'));
  // The code as it is: the code test passes even when nothing runs.
  writeFileSync(path.join(repo, 'app/probe.json'), `${JSON.stringify({ [SUCCESS]: { c2: 'pass' } }, null, 2)}\n`);
  commit(repo, 'Check the failure notice with a code test');
  writeFileSync(path.join(repo, 'app/probe.json'), `${JSON.stringify({ [SUCCESS]: { c2: 'fail' } }, null, 2)}\n`);
  writeFileSync(path.join(directory, 'tests/fixtures/review-c2.patch'), git(repo, ['diff', '--', 'app/probe.json']).concat('\n'));
  git(repo, ['checkout', '--', 'app/probe.json']);
}

test('a code-level check is exempt from the probe, is proved able to fail by a code patch on a copy of the code, and gates a run like any check', (t) => {
  const project = readyProject(t, { check: false, authorFixtures: false });
  const { repo, root } = project;
  codeTest(repo, root);
  const item = validateEval(repo, CHANGE).cases.find((entry) => entry.id === SUCCESS);
  assert.deepEqual(item.errors, []);
  assert.deepEqual(item.code_patches, ['review-c2']);
  const code = readFileSync(path.join(repo, 'app/probe.json'), 'utf8');
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked.cases.map((entry) => [entry.case, entry.probe, entry.fixtures])));
  const success = checked.cases.find((entry) => entry.case === SUCCESS);
  // The code test judged the code under the probe; only it may.
  assert.deepEqual([success.probe.results, success.probe.unexpected, success.probe.exempt], [{ c1: 'unknown', c2: 'pass' }, [], ['c2']]);
  const patched = success.fixtures.find((fixture) => fixture.name === 'review-c2');
  assert.deepEqual([patched.kind, patched.got, patched.ok], ['code_patch', { c1: 'unknown', c2: 'fail' }, true]);
  // The patch went to a copy: the project's code is as it was.
  assert.equal(readFileSync(path.join(repo, 'app/probe.json'), 'utf8'), code);
  // The user sees that this check tests the code directly.
  const review = reviewEval(repo, CHANGE);
  assert.deepEqual(review.must_show.code_checks.map((entry) => [entry.package, entry.check, entry.command]), [[SUCCESS, 'c2', 'code/no_failure_notice.sh']]);
  confirmChecks(project);

  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  setResults(repo, { ...AFTER, [SUCCESS]: { c1: 'pass', c2: 'fail' } });
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'fail');
  assert.deepEqual(find(readRecord(head).compare, SUCCESS, 'c2').verdict, 'violated');
  assert.deepEqual(head.failures_count, { cases: [SUCCESS] });
});

// --- The change lock: what lifts it ---

test('once the user abandons the change, the start code is released: a baseline goes on any code, and a new loop the user agrees to starts there', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refused('baseline_after_change'));
  const abandoned = abandonChange(repo, CHANGE, { ...CONSENT, reason: 'Synthetic: the user drops this approach.' });
  assert.deepEqual([abandoned.abandoned.by, abandoned.abandoned.ref, abandoned.loop_ended.reason], [USER, REF, 'change_abandon']);
  assert.deepEqual(readDecisions(root).entries.filter((entry) => entry.type === 'change_abandon').map((entry) => [entry.by, entry.ref]), [[USER, REF]]);
  const expect = writeExpectations(repo, { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' });
  const base = startRun(repo, CHANGE, { baseline: true, expect });
  assert.deepEqual([base.is_baseline, base.loop_baseline], [true, { usable: true, reasons: [] }]);
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(loop.start_code.digest, readRecord(base).run.code_snapshot.digest);
});

test('once the user abandons the change, a head run is no longer refused, and compares outside a loop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  abandonChange(repo, CHANGE, { ...CONSENT, reason: 'Synthetic: the user drops this approach.' });
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.equal(head.base_run, project.base.run_id);
  assert.equal(readRecord(head).run.not_acceptance, true);
});

test('a loop whose loop.json is gone counts as ended because its record is missing, and that is why the change is locked', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  startRun(repo, CHANGE);
  rmSync(loopFile(root));
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended.reason], ['ended', 'loop_record_missing'], JSON.stringify(status.ended));
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('change_locked')(error);
    assert.equal(error.gaps[0].reason, 'loop_record_missing');
    assert.ok(error.gaps[0].ended_at === null || error.gaps[0].ended_at >= project.loop.started_at, JSON.stringify(error.gaps[0]));
    return true;
  });
});
