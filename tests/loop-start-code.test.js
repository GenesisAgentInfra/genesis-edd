// Loop tests: the rules a baseline is held to. Every base record goes on the
// pinned start code until a loop is accepted or the change abandoned, and
// --at-start rebuilds that code; code the user accepted takes no base record;
// the light tier needs a baseline that ran; the first loop's start code is
// the baseline's; an expectation written after a baseline is the user's to
// decide; and what a new loop after an end or a new plan needs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startRun } from '../src/run.js';
import { abandonChange, acceptLoop, endLoop, loopStatus } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { reviewEval } from '../src/confirm.js';
import { AFTER, CHANGE, commit, confirmChecks, git, readRecord, readyProject, setResults, writeExpectations } from './helpers/edd.js';
import {
  EXPECT, BROKEN, CONSENT, inLoop, liveLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, gapOf, newProjectLoop, resultsOutsideCode,
  refusedBeforeRun, assertEnded, assertStopBudget, reviewRun, startLoop, assertGapShape,
} from './helpers/loop.js';

// A .dockerignore that keeps .genesis out of an image built from the code:
// --at-start rebuilds the start code only with one.
const ignoreGenesis = (repo) => writeFileSync(path.join(repo, '.dockerignore'), '.genesis\n');
const digestOf = (run) => readRecord(run).run.code_snapshot.digest;
const baselineAction = (status, ...flags) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start' && entry.command.includes('--baseline')
  && ['--at-start', '--unavailable'].every((flag) => entry.command.includes(flag) === flags.includes(flag)));
const trialAction = (status, ...flags) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start' && entry.command.includes('--trial')
  && entry.command.includes('--at-start') === flags.includes('--at-start'));
const loopStartAction = (status) => status.actions.find((entry) => entry.command[0] === 'loop' && entry.command[1] === 'start');
const newLoopGates = (status) => Object.fromEntries(status.ended.new_loop.gates.map((entry) => [entry.gate, entry.holds]));

// A ready project whose code has a .dockerignore with the .genesis rule,
// committed, a baseline of EXPECT on that code, and a loop the user agreed to
// (budget as startLoop takes it). options go to readyProject.
function sealedLoop(t, budget = {}, options = {}) {
  const project = readyProject(t, options);
  ignoreGenesis(project.repo);
  commit(project.repo, 'Keep .genesis out of the image');
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const started = startLoop(project.repo, CHANGE, budget);
  return { ...project, base, loop: started.loop, started };
}

// What git says the working directory holds, and HEAD.
const worktree = (repo) => ({ head: git(repo, ['rev-parse', 'HEAD']), status: git(repo, ['status', '--porcelain']), stashes: git(repo, ['stash', 'list']) });

test('off the pinned start code a base record is refused before it runs, and --at-start records one of the start code without touching the working directory', (t) => {
  const project = sealedLoop(t);
  const { repo, loop, base } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  setResults(repo, { ...AFTER, note: 'uncommitted' });
  const refusal = refusedBeforeRun(project, { baseline: true, expect: writeExpectations(repo, EXPECT) }, 'baseline_after_change');
  assertGapShape(refusal, { owner: 'agent', layer: 'baseline', start_code: `commit ${loop.start_code.commit}` });
  assert.ok(refusal.message.includes('`--at-start` rebuilds the start code outside the project and leaves the working directory as it is'), refusal.message);

  const before = worktree(repo);
  const again = startRun(repo, CHANGE, { baseline: true, atStart: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.is_baseline, again.loop_baseline.usable], [true, true], JSON.stringify(again));
  const snapshot = readRecord(again).run.code_snapshot;
  assert.deepEqual([snapshot.commit, snapshot.digest], [loop.start_code.commit, loop.start_code.digest]);
  assert.equal(digestOf(again), digestOf(base));
  // The working directory, HEAD and the stash are as they were.
  assert.deepEqual(worktree(repo), before);
  // The running loop keeps comparing with its own baseline.
  assert.deepEqual(again.loop, { started_at: loop.started_at, baseline: base.run_id, ended: false });
  assert.equal(fullRun(repo).base_run, base.run_id);
});

test('once a loop ended off its start code, workflow status refuses a base record and a trial of the working directory and allows both --at-start, and a new loop starts on that base record', (t) => {
  const project = sealedLoop(t);
  const { repo, loop } = project;
  changeCode(repo, BROKEN, 'A first try');
  completeReport(repo, fullRun(repo).run_id);
  endLoop(repo, CHANGE, { reason: 'The approach is wrong; the user wants another one.' });
  assertEnded(loopStatus(repo, CHANGE), 'loop_end');

  let work = workflowStatus(repo, CHANGE);
  assert.equal(work.layers.baseline.start_code.code_is_start, false);
  const record = baselineAction(work);
  assert.equal(record.allowed, false);
  assert.ok(record.blocked_by.includes('baseline_after_change'), JSON.stringify(record));
  // The loop's own baseline is on the start code, so a new one is allowed, not needed.
  const atStart = baselineAction(work, '--at-start');
  assert.deepEqual([atStart.allowed, atStart.blocked_by, atStart.needed], [true, [], false], JSON.stringify(atStart));
  assert.ok(trialAction(work).blocked_by.includes('change_locked'), JSON.stringify(trialAction(work)));
  assert.equal(trialAction(work, '--at-start').allowed, true);
  assert.equal(newLoopGates(loopStatus(repo, CHANGE)).baseline_on_start_code, true);

  const again = startRun(repo, CHANGE, { baseline: true, atStart: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  work = workflowStatus(repo, CHANGE);
  assert.deepEqual([work.layers.baseline.recorded.run_id, work.layers.baseline.recorded.on_start_code], [again.run_id, true]);
  const start = loopStartAction(work);
  assert.deepEqual([start.allowed, start.by, start.start_code], [true, 'user', 'pinned'], JSON.stringify(start));
  const next = startLoop(repo, CHANGE).loop;
  assert.deepEqual([next.baseline, next.start_from, next.start_code], [again.run_id, 'pinned', loop.start_code]);
  // The working directory still holds the change, so the new loop says so.
  assert.equal(next.worktree_moved, true);
});

test('in a new project, a record that nothing could run off the pinned start code is refused, as workflow status lists it', (t) => {
  const project = newProjectLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'The first implementation');
  assertEnded(loopStatus(repo, CHANGE), 'packages_changed');
  const work = workflowStatus(repo, CHANGE);
  const unavailable = baselineAction(work, '--unavailable');
  assert.equal(unavailable.allowed, false);
  assert.ok(unavailable.blocked_by.includes('baseline_after_change'), JSON.stringify(unavailable));
  const refusal = refusedBeforeRun(project, { baseline: true, unavailable: 'no_implementation' }, 'baseline_after_change');
  assertGapShape(refusal, { owner: 'agent', layer: 'baseline' });
  // A record that nothing could run describes the working directory, so --at-start does not apply to it.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation', atStart: true }), /--at-start belongs to a baseline or a trial that runs/);
});

test('on the code the user accepted a base record is refused, and workflow status does not suggest one', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const refusal = refusedBeforeRun(project, { baseline: true, expect: writeExpectations(repo, EXPECT) }, 'code_holds_accepted_change');
  assertGapShape(refusal, { owner: 'agent', layer: 'baseline', run: run.run_id, path: `.genesis/edd/${CHANGE}/accepted.json`, code_digest: digestOf(run) });
  const work = workflowStatus(repo, CHANGE);
  assert.deepEqual(baselineAction(work).blocked_by, ['code_holds_accepted_change']);
  assert.notDeepEqual(work.suggestion?.command?.slice(0, 6), ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  // Once the accepted loop is done, no start code is pinned: there is nothing to rebuild.
  assert.equal(refusedBeforeRun(project, { baseline: true, atStart: true, expect: writeExpectations(repo, EXPECT) }, 'start_code_unknown').layer, 'code');

  // In a fresh clone, which has accepted.json but no runs or loop.json, the
  // same code is refused too.
  commit(repo, 'Record the accepted change');
  const clone = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-clone-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(clone, ['clone', '-q', repo, '.']);
  const status = loopStatus(clone, CHANGE);
  assert.deepEqual([status.phase, status.situation.local_records, status.situation.code_matches], ['done', false, true]);
  assert.throws(() => startRun(clone, CHANGE, { baseline: true, expect: writeExpectations(clone, EXPECT) }), (error) => {
    assertGapShape(gapOf(error, 'code_holds_accepted_change'), { owner: 'agent', layer: 'baseline', run: run.run_id });
    return true;
  });
  const cloned = workflowStatus(clone, CHANGE);
  assert.ok(baselineAction(cloned).blocked_by.includes('code_holds_accepted_change'), JSON.stringify(baselineAction(cloned)));
  assert.notDeepEqual(cloned.suggestion?.command?.slice(0, 2), ['run', 'start'], JSON.stringify(cloned.suggestion));
});

test('in the light tier an existing project records a baseline that runs: a record that nothing could run is refused, until the user confirms the full tier', (t) => {
  const project = readyProject(t, { unconnected: [FAILURE, SUCCESS], confirm: false });
  const { repo } = project;
  const work = workflowStatus(repo, CHANGE);
  assert.equal(work.layers.packages.tier.readiness, 'light');
  const unavailable = baselineAction(work, '--unavailable');
  assert.ok(unavailable.blocked_by.includes('light_baseline_required'), JSON.stringify(unavailable));
  const refusal = refusedBeforeRun(project, { baseline: true, unavailable: 'no_implementation' }, 'light_baseline_required');
  assertGapShape(refusal, { owner: 'agent', layer: 'baseline' });
  // The full tier is the user's, and allows it.
  confirmChecks(project, { tier: 'full' });
  assert.equal(baselineAction(workflowStatus(repo, CHANGE), '--unavailable').blocked_by.includes('light_baseline_required'), false);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.is_baseline, base.baseline_unavailable_reason], [false, 'no_implementation']);
});

test('a light-tier confirmation does not start a loop on a baseline recorded as unavailable in an existing project', (t) => {
  const project = readyProject(t, { tier: 'full' });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.is_baseline, false);
  confirmChecks(project, { tier: 'light', reason: 'The user chose the light tier.' });
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assertGapShape(gapOf(error, 'light_baseline_required'), { owner: 'agent', layer: 'baseline', run: base.run_id });
    return true;
  });
  assert.ok(loopStartAction(workflowStatus(repo, CHANGE)).blocked_by.includes('light_baseline_required'));
});

test('--at-start needs a pinned start code: before any loop, and once the user abandoned the change, it is refused, and abandoning releases the pin', (t) => {
  const project = sealedLoop(t);
  const { repo } = project;
  // Before any loop there is no start code to rebuild: a fresh project.
  const fresh = readyProject(t);
  startRun(fresh.repo, CHANGE, { baseline: true, expect: writeExpectations(fresh.repo, EXPECT) });
  assertGapShape(refusedBeforeRun(fresh, { baseline: true, atStart: true, expect: writeExpectations(fresh.repo, EXPECT) }, 'start_code_unknown'), { owner: 'agent', layer: 'code' });

  changeCode(repo, BROKEN, 'A first try');
  refusedBeforeRun(project, { baseline: true, expect: writeExpectations(repo, EXPECT) }, 'baseline_after_change');
  const abandoned = abandonChange(repo, CHANGE, { ...CONSENT, reason: 'The user drops this approach.' });
  assert.equal(abandoned.loop_ended.reason, 'change_abandon');
  assert.equal(abandoned.released_start_code.digest, project.loop.start_code.digest);
  assertEnded(loopStatus(repo, CHANGE), 'change_abandon');
  assert.equal(workflowStatus(repo, CHANGE).layers.baseline.start_code, null);
  assertGapShape(refusedBeforeRun(project, { baseline: true, atStart: true, expect: writeExpectations(repo, EXPECT) }, 'start_code_unknown'), { owner: 'agent', layer: 'code' });
  // The next base record goes on the code as it is now.
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'fail', [`${SUCCESS}/c2`]: 'pass' }) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  const next = startLoop(repo, CHANGE).loop;
  assert.deepEqual([next.baseline, next.start_from, next.start_code.digest], [again.run_id, 'baseline', digestOf(again)]);
  assert.deepEqual(next.after_abandon && [next.after_abandon.by, next.after_abandon.ref], [CONSENT.by, CONSENT.ref]);
});

test('a first loop does not start when the code its baseline ran on cannot be rebuilt', (t) => {
  const { repo, runs } = readyProject(t);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  rmSync(path.join(runs, base.run_id, 'code.patch'));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    const gap = assertGapShape(gapOf(error, 'start_code_unrecoverable'), { owner: 'agent', layer: 'baseline', run: base.run_id, path: `.genesis/edd/${CHANGE}/runs/${base.run_id}/code.patch` });
    assert.match(gap.message, /cannot be rebuilt/);
    return true;
  });
});

test('a new loop after a stop keeps counting the failures of the same code, and says what the earlier loops used', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, base } = project;
  resultsOutsideCode(repo);
  changeCode(repo, BROKEN, 'A first try');
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  assertStopBudget(loopStatus(repo, CHANGE), 'budget_used_up');
  const started = startLoop(repo, CHANGE, { iterations: 2 });
  assert.deepEqual([started.loop.baseline, started.loop.start_from], [base.run_id, 'pinned']);
  assert.deepEqual([started.earlier_loops.total.loops, started.earlier_loops.total.iterations], [1, 1]);
  assert.ok(started.warnings.some((warning) => warning.startsWith('Earlier loops of this change (1) used 1 full run;') && warning.includes('This loop\'s budget is its own (2 full runs')), JSON.stringify(started.warnings));
  // The same code now passes, but its failure in the earlier loop still counts.
  setResults(repo, AFTER);
  const passed = fullRun(repo);
  assert.equal(passed.verdict, 'pass');
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.deepEqual(status.unstable.map(({ case: id, check, pass, fail }) => [id, check, pass, fail]), [[SUCCESS, 'c1', [passed.run_id], [failed.run_id]]]);
});

test('a confirmation of another plan ends a running loop with what changed, and the next loop needs a baseline of that plan on the start code', (t) => {
  const project = liveLoop(t, 3);
  const { repo, base, loop } = project;
  const confirmed = confirmChecks(project, { attempts: 5, reason: 'The user wants more attempts.' });
  assert.deepEqual([confirmed.loop.ended, confirmed.loop.reason], [true, 'confirmation_changed'], JSON.stringify(confirmed.loop));
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'confirmation_changed');
  assert.deepEqual([status.ended.plan, status.ended.confirmation], [['attempts'], confirmed.confirmation.id]);
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assertGapShape(gapOf(error, 'baseline_plan_differs'), { owner: 'agent', layer: 'baseline', run: base.run_id, differs: ['attempts'] });
    return true;
  });
  // The code is still the start code: the baseline of the new plan goes there.
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.is_baseline, again.run_plan.attempts, again.run_plan.source, again.run_plan.confirmation], [true, 5, 'confirmation', confirmed.confirmation.id]);
  const next = startLoop(repo, CHANGE).loop;
  assert.deepEqual([next.baseline, next.start_from, next.start_code, next.previous.length], [again.run_id, 'pinned', loop.start_code, 1]);
  assert.equal(next.checks_confirmation.id, confirmed.confirmation.id);
});

test('an expected baseline result changed or added after a baseline ran is a decision eval review puts to the user, and the confirmation records it with who decided', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const { [`${SUCCESS}/c2`]: _, ...partial } = EXPECT;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, partial) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  // After the result was seen: one expectation flips, one is added.
  writeExpectations(repo, { ...EXPECT, [`${FAILURE}/c1`]: 'pass' });
  const review = reviewEval(repo, CHANGE);
  const changed = review.must_decide.find((item) => item.code === 'expectation_changed_after_baseline');
  assert.deepEqual(changed?.changes, [{ case: FAILURE, check: 'c1', was: 'fail', now: 'pass', after: [base.run_id], results_seen: [{ run_id: base.run_id, result: 'fail' }] }], JSON.stringify(changed));
  const added = review.must_decide.find((item) => item.code === 'expectation_added_after_baseline');
  assert.deepEqual(added?.additions, [{ case: SUCCESS, check: 'c2', was: null, now: 'pass', after: [base.run_id], results_seen: [{ run_id: base.run_id, result: 'pass' }] }], JSON.stringify(added));
  // Both are put in front of the user before a confirmation.
  const shown = review.must_show.must_decide.map((item) => item.code);
  assert.ok(shown.includes('expectation_changed_after_baseline') && shown.includes('expectation_added_after_baseline'), JSON.stringify(shown));
  const { confirmation } = confirmChecks(project, { reason: 'The user agreed to the new expectations.' });
  const recorded = confirmation.must_decide.filter((item) => item.code.startsWith('expectation_'));
  assert.deepEqual(recorded.map((item) => [item.code, item.decision]), [['expectation_changed_after_baseline', 'confirmed_as_shown'], ['expectation_added_after_baseline', 'confirmed_as_shown']]);
  assert.deepEqual([confirmation.confirmed.by, confirmation.confirmed.ref], [CONSENT.by, CONSENT.ref]);
});

test('loop status names, as the gate of a head run, a gap that run start refuses the head run of an ended loop with', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BROKEN, 'A first try');
  completeReport(repo, fullRun(repo).run_id);
  endLoop(repo, CHANGE, { reason: 'The approach is wrong.' });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'loop_end');
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    const refused = error.gaps.map((entry) => entry.code);
    assert.ok(refused.includes(status.gates.head_run.code), `run start refused with ${refused.join(', ')}; loop status names ${status.gates.head_run.code}`);
    return true;
  });
});
