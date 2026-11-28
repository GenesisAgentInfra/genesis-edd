// Loop tests: the loop's pinned baseline, the start code a loop keeps and how
// it is rebuilt, and what workflow status and the results say after the
// baseline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { checkEval, codeSnapshot, startRun } from '../src/run.js';
import { acceptLoop, loopStatus, writeReport } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { readDecisions } from '../src/records.js';
import {
  AFTER, BEFORE, CHANGE, SPECS, commit, confirmChecks, editChecks, git, harborThen, readRecord, readyProject, setResults, writeExpectations, writeSpec,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, REF, USER, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS,
  editLoop, minutesAgo, near, withoutKey, editApp, exportRevision, sameCodeAsRun, resultsOutsideCode, assertStopBudget,
  refusedBeforeRun, assertEnded, restoreStart, reviewRun, startLoop, assertGapShape, assertNoRoutes,
} from './helpers/loop.js';

// The actions of a workflow status for a head run, a base record (with the
// flags that tell them apart, such as '--at-start'), and loop start.
const headAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && !entry.command.includes('--baseline') && !entry.command.includes('--trial'));
const baselineAction = (status, ...flags) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start' && entry.command.includes('--baseline')
  && ['--at-start', '--unavailable'].every((flag) => entry.command.includes(flag) === flags.includes(flag)));
const loopStartAction = (status) => status.actions.find((entry) => entry.command[0] === 'loop' && entry.command[1] === 'start');
const digestOf = (run) => readRecord(run).run.code_snapshot.digest;
// A .dockerignore that keeps .genesis out of an image built from the code:
// --at-start rebuilds the start code only with one.
const ignoreGenesis = (repo) => writeFileSync(path.join(repo, '.dockerignore'), '.genesis\n');

// --- The loop's pinned baseline everywhere, new loops that keep the start
// code, and how that code is rebuilt. ---

test('a baseline attempt on the start code that did not run leaves the loop on its own baseline, and workflow status allows the next head run', (t) => {
  const project = inLoop(t);
  const { repo, base, loop, tools } = project;
  // Harbor leaves no trial, so this baseline attempt does not complete.
  harborThen(t, "(await import('node:fs')).rmSync(path.join(logs, 'harbor'), { recursive: true, force: true });");
  const attempt = startRun(repo, CHANGE, { baseline: true });
  tools.harbor(true);
  assert.equal(attempt.execution_status, 'error');
  assert.equal(attempt.is_baseline, false);
  assert.deepEqual(attempt.loop_baseline, { usable: false, reasons: ['execution_incomplete'] });
  assert.deepEqual(attempt.loop, { started_at: loop.started_at, baseline: base.run_id, ended: false });
  changeCode(repo, AFTER, 'Fix the failed submission');

  const status = workflowStatus(repo, CHANGE);
  assert.equal(status.layers.loop.phase, 'live');
  assert.equal(status.layers.loop.baseline, base.run_id);
  assert.deepEqual(status.gaps, [], JSON.stringify(status.gaps));
  const head = headAction(status);
  assert.deepEqual([head.allowed, head.in_loop, head.spends], [true, true, 'loop_budget'], JSON.stringify(head));
  assert.deepEqual(status.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(fullRun(repo).base_run, base.run_id);
});

test('a base record on the start code says the loop still compares with its own baseline', (t) => {
  const { repo, base, loop } = inLoop(t);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));
  assert.deepEqual(again.loop, { started_at: loop.started_at, baseline: base.run_id, ended: false });
  assert.ok(again.warnings.includes(`The loop for this Spec keeps comparing with its own baseline ${base.run_id} while it runs.`), JSON.stringify(again.warnings));
  assert.ok(!again.warnings.some((warning) => /later runs are compared with this baseline/.test(warning)), JSON.stringify(again.warnings));
  assert.equal(loopStatus(repo, CHANGE).loop.baseline, base.run_id);
  changeCode(repo, AFTER, 'Fix the failed submission');
  assert.equal(fullRun(repo).base_run, base.run_id);
});

test('a new loop after an end keeps the start code of the first unaccepted loop, and every base record has to be on it', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, base, loop } = project;
  changeCode(repo, BROKEN, 'First attempt');
  completeReport(repo, fullRun(repo).run_id);
  assertStopBudget(loopStatus(repo, CHANGE), 'budget_used_up');
  changeCode(repo, AFTER, 'Second attempt');
  const started = startLoop(repo, CHANGE, { iterations: 3 });
  const next = started.loop;
  assert.deepEqual(next.start_code, loop.start_code);
  assert.equal(next.start_from, 'pinned');
  assert.equal(next.base_commit, loop.start_code.commit);
  assert.equal(next.baseline, base.run_id);
  assert.deepEqual([next.consent.by, next.consent.ref], [USER, REF]);
  assert.equal(next.previous.length, 1);
  assert.equal(next.previous[0].started_at, loop.started_at);
  assert.equal(loopStatus(repo, CHANGE).runs.length, 0);
  // Every base record still has to be on that code: one on the code now is
  // refused before anything runs.
  const refusal = refusedBeforeRun(project, { baseline: true, expect: writeExpectations(repo, EXPECT) }, 'baseline_after_change');
  assertGapShape(refusal, { owner: 'agent', layer: 'baseline', start_code: `commit ${loop.start_code.commit}` });
  // In the light tier a record that nothing could run is refused as well.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'execution_blocked' }), refusedWith('light_baseline_required'));
});

test('a loop that starts on uncommitted code keeps it as loop-start.patch, and the baseline refusal names it', (t) => {
  const { repo, root } = readyProject(t);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.start_code.patch, 'loop-start.patch');
  assert.ok(existsSync(path.join(root, 'loop-start.patch')));
  // The patch is the baseline's own code.patch: the loop starts on the code the baseline ran on.
  assert.equal(readFileSync(path.join(root, 'loop-start.patch'), 'utf8'), readFileSync(path.join(base.directory, 'code.patch'), 'utf8'));
  assert.equal(loop.start_code.digest, digestOf(base));
  assert.match(readFileSync(path.join(root, '..', '.gitignore'), 'utf8'), /^\/\*\/loop-start\.patch$/m);

  changeCode(repo, AFTER, 'Change the handler');
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    const refusal = assertGapShape(error.gaps.find((entry) => entry.code === 'baseline_after_change'), { owner: 'agent', layer: 'baseline' });
    const hint = `commit ${loop.start_code.commit} plus \`git apply\` .genesis/edd/${CHANGE}/loop-start.patch`;
    assert.equal(refusal.start_code, hint);
    assert.ok(refusal.message.includes(hint), refusal.message);
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

test('a commit that changes no content is not a code change: the loop takes a base record on it, and accepts a run committed after it ran', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.start_code.digest_of, 'content');
  commit(repo, 'Commit the starting code');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), loop.start_code.commit);
  assert.equal(codeSnapshot(repo).snapshot.digest, loop.start_code.digest);

  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true, JSON.stringify(again));

  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  commit(repo, 'Stop the success notice when a submission fails');
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done', JSON.stringify(status.situation));
  assert.equal(status.situation.code, 'accepted');
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
});

test('two full runs on the same content warn that a run of the same code only adds to its count, even when a commit lies between them, and are not stuck', (t) => {
  const { repo } = inLoop(t);
  editApp(repo, BROKEN, 'First attempt');
  fullRun(repo);
  commit(repo, 'First attempt');
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.some((warning) => /last two runs used the same code/.test(warning)), JSON.stringify(status.warnings));
  assert.equal(status.stuck, false);
  assert.ok(!status.warnings.some((warning) => warning.startsWith('stuck:')), JSON.stringify(status.warnings));
  assert.equal(status.phase, 'live', JSON.stringify(status.situation));
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

test('an edited Spec that was not exported is a fact of the spec layer for the agent, and the loop never exports it', (t) => {
  const { repo } = inLoop(t);
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2'));
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'live');
  const { situation } = status;
  assert.deepEqual([situation.code, situation.owner, situation.layer, situation.spec_edited], ['spec_invalid', 'agent', 'spec', true], JSON.stringify(situation));
  assert.match(situation.message, /differ from the export this loop started from/);
  assert.match(situation.message, /A loop never changes the Spec/);
  assert.doesNotMatch(situation.message, /Export the current/);
  assertNoRoutes(situation, 'situation');
  assert.equal(status.suggestion, null);
  assert.ok(codes(status.gates.accept).includes('spec_changed'), JSON.stringify(status.gates.accept));
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
  assert.ok(report.includes(`Files changed since the baseline ${base.run_id}:\n- \`app/new-name.txt\`\n- \`app/old-name.txt\`\n\n## Notes`), report);
});

test('a missing loop baseline ends the loop for the agent to record again, workflow status refuses a head run, and a new loop is the user\'s', (t) => {
  const { repo, base, loop } = inLoop(t);
  rmSync(base.directory, { recursive: true, force: true });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'baseline_missing');
  assertGapShape(status.gates.head_run, { code: 'loop_ended', owner: 'agent', layer: 'baseline' });
  assert.equal(status.ended.baseline, base.run_id);
  assert.deepEqual(status.ended.start_code, { commit: loop.start_code.commit, digest: loop.start_code.digest, patch: null, uncommitted_files: [] });
  assert.match(status.warnings.join('\n'), /no longer in runs/);
  const gates = Object.fromEntries(status.ended.new_loop.gates.map((entry) => [entry.gate, entry.holds]));
  assert.deepEqual(gates, { checks_confirmation: true, baseline_on_start_code: false, user_consent: false });

  const work = workflowStatus(repo, CHANGE);
  const head = headAction(work);
  assert.equal(head.allowed, false);
  assert.ok(head.blocked_by.includes('change_locked'), JSON.stringify(head));
  const record = baselineAction(work);
  assert.deepEqual([record.allowed, record.needed], [true, true], JSON.stringify(record));
  assert.equal(work.layers.baseline.start_code.code_is_start, true);
  const start = loopStartAction(work);
  assert.equal(start.by, 'user');
  assert.ok(start.blocked_by.includes('baseline_missing'), JSON.stringify(start));
  assert.ok(start.needs.some((entry) => entry.startsWith('user consent')), JSON.stringify(start.needs));

  // A loop.json from before start_code was recorded still names the commit
  // the loop started on; its start code is no longer known.
  const file = path.join(repo, '.genesis/edd', CHANGE, 'loop.json');
  const { start_code: _, ...older } = readJSON(file);
  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
  const olderStatus = loopStatus(repo, CHANGE);
  assertEnded(olderStatus, 'baseline_missing');
  assert.equal(olderStatus.loop.base_commit, loop.base_commit);
  assert.equal(olderStatus.ended.start_code, null);
});

test('after acceptance the minutes stop at the acceptance, and the commit is the user\'s decision until the accepted code is committed', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo, root } = project;
  // The change is left uncommitted when it runs and is accepted.
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'Stop the success notice when a submission fails\n');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  const result = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  assert.equal(result.commit, undefined);
  assert.equal(result.committed, false);
  assert.ok(result.uncommitted.includes('app/handler.txt'), JSON.stringify(result.uncommitted));
  assert.deepEqual(result.needs_user.map((entry) => entry.decision), ['commit, merge or pull request']);
  assert.equal(result.suggestion, null);

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.code, status.situation.committed, status.situation.code_commit], ['accepted', false, null]);
  assert.deepEqual(status.situation.needs_user.map((entry) => entry.decision), ['commit, merge or pull request']);
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'commit, merge or pull request' && entry.by === 'user'), JSON.stringify(status.obligations));

  // The clock stops when the user accepts, however long ago that was.
  const accepted = readJSON(path.join(root, 'accepted.json'));
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(50); });
  accepted.accepted.at = minutesAgo(43);
  writeFileSync(path.join(root, 'accepted.json'), `${JSON.stringify(accepted, null, 2)}\n`);
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 7);
  assert.equal(status.phase, 'done');

  // Committing the accepted code leaves only a merge or a pull request.
  const head = commit(repo, 'Stop the success notice when a submission fails');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.code_commit], [true, head]);
  assert.deepEqual(status.situation.needs_user.map((entry) => entry.decision), ['merge or pull request']);
  assert.match(status.situation.needs_user[0].why, new RegExp(`committed in ${head.slice(0, 7)}`));
  assert.ok(!status.obligations.some((entry) => entry.decision === 'commit, merge or pull request'), JSON.stringify(status.obligations));
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));

  // A later edit is not covered by the acceptance, committed or not.
  writeFileSync(path.join(repo, 'app/handler.txt'), 'another edit\n');
  commit(repo, 'Another edit');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.accepted_run], ['code_moved', true], JSON.stringify(status.situation));
  assert.equal(status.situation.code_commit, undefined);
  assert.ok(status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
});

test('without the accepted run folder, loop status still tells whether the code moved past the accepted run, also for an older record', (t) => {
  const project = inLoop(t);
  const { repo, root, runs } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const file = path.join(root, 'accepted.json');
  const record = readJSON(file);
  assert.equal(record.code_digest_of, 'content');
  rmSync(path.join(runs, run.run_id), { recursive: true });

  const moved = () => loopStatus(repo, CHANGE).warnings.some((warning) => /covers that run's code only/.test(warning));
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');
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

test('once a run of the loop is accepted, workflow status suggests no other run and refuses a base record on the accepted code', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const before = headAction(workflowStatus(repo, CHANGE));
  assert.deepEqual([before.allowed, before.in_loop], [true, true], JSON.stringify(before));
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.gaps, [], JSON.stringify(status.gaps));
  assert.deepEqual([status.layers.loop.phase, status.layers.loop.accepted, status.layers.loop.acceptance.run_id], ['done', true, run.run_id]);
  assert.equal(status.suggestion, null);
  const head = headAction(status);
  assert.deepEqual([head.in_loop, head.needed, head.acceptance], [false, false, false], JSON.stringify(head));
  // The code now is the accepted change: a base record on it would describe the change.
  const record = baselineAction(status);
  assert.deepEqual([record.allowed, record.blocked_by], [false, ['code_holds_accepted_change']], JSON.stringify(record));
  assert.equal(loopStartAction(status).needed, false);

  // A finished loop needs no Docker: stopping it afterwards blocks nothing of the loop.
  project.tools.docker(false);
  const stopped = workflowStatus(repo, CHANGE);
  assert.deepEqual(codes(stopped.gaps), ['docker_unavailable']);
  assert.deepEqual([stopped.layers.loop.phase, stopped.layers.loop.gaps], ['done', []]);
  assert.equal(stopped.suggestion, null);
  project.tools.docker(true);

  // A new export ends the accepted loop; its baseline may be on the accepted code.
  exportRevision(project);
  const revised = workflowStatus(repo, CHANGE);
  assert.deepEqual([revised.layers.loop.phase, revised.layers.loop.ended.reason, revised.layers.loop.ended.accepted], ['ended', 'spec_exported', true]);
  assert.ok(!codes(revised.gaps).includes('change_locked'), JSON.stringify(revised.gaps));
  const again = baselineAction(revised);
  assert.deepEqual([again.allowed, again.needed], [true, true], JSON.stringify(again));
  assert.deepEqual(revised.suggestion.command.slice(0, 6), ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
});

test('an acceptance of uncommitted code still tells whether the code moved once the run folder is gone', (t) => {
  const project = inLoop(t);
  const { repo, root, runs } = project;
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'Stop the success notice when a submission fails\n');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
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

test('the report marks each check gating or diagnostic, names the THEN line it verifies, and lists the lines the user judges', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  // c2 becomes diagnostic; no program judges its line, so the user does.
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks = declared.checks.map((check) => (check.id === 'c2' ? { ...check, role: 'diagnostic' } : check));
    declared.scenario.manual = [{ then: '本次提交发送的失败通知数量为零', reason: 'synthetic | read by\na person' }];
  });
  checkEval(repo, CHANGE, { case: SUCCESS });
  confirmChecks(project, { reason: 'c2 became diagnostic; the user judges its line.' });
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.deepEqual(run.compare_gating, { holds: 2, violated: 0, base_mismatch: 0, head_only: 0, unverified: 0 });
  // A full run of a loop writes its report itself.
  assert.equal(run.report.created, true);
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.match(text, /^Only gating checks decide the verdict; a diagnostic result is shown for reference\. Each result shows its passes out of its attempts\.$/m);
  assert.match(text, /^\| Case \| Check \| Requirement \| THEN \| Role \| Before → After \| Verdict \|$/m);
  assert.match(text, /^\| --- \| --- \| --- \| --- \| --- \| --- \| --- \|$/m);
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/1\) → pass \(1\/1\) \| holds \(fixed\) \|$/m);
  assert.match(text, /^\| submit-success-s1 \| c2 \| REQ-submit-success \| 本次提交发送的失败通知数量为零 \| diagnostic \| pass \(1\/1\) → pass \(1\/1\) \| holds \(kept\) \|$/m);
  // The block of lines the user judges, one line per row and its pipes escaped.
  assert.ok(text.includes(`\nNo check verifies these lines; the user judges them at acceptance:

| Case | THEN | Why no check |
| --- | --- | --- |
| submit-success-s1 | 本次提交发送的失败通知数量为零 | synthetic \\| read by a person |
`), text);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.must_show.manual.map((entry) => [entry.case, entry.then]), [[SUCCESS, '本次提交发送的失败通知数量为零']]);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const accepted = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual(accepted.checks.map((entry) => [entry.case, entry.check, entry.role]), [
    ['submit-failure-s1', 'c1', 'gating'], ['submit-success-s1', 'c1', 'gating'], ['submit-success-s1', 'c2', 'diagnostic'],
  ]);
  assert.deepEqual(accepted.manual, [{ case: SUCCESS, then: '本次提交发送的失败通知数量为零', reason: 'synthetic | read by\na person' }]);
});

test('a run during which the code changed is never accepted, even once the code is back where that run started', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // Each package's run edits the application once Harbor is done with it.
  harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
  const run = startRun(repo, CHANGE);
  assert.equal(run.verdict, 'unverified', JSON.stringify(run));
  assert.ok(run.unverified_by.includes('code_changed_during_run'), JSON.stringify(run.unverified_by));
  rmSync(path.join(repo, 'app/edited.txt'));
  assert.equal(sameCodeAsRun(repo, run), true);

  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(`The code changed while ${run.run_id} executed, so its results do not belong to one version of the code.`),
    JSON.stringify(status.warnings));
  assert.deepEqual([status.situation.code, status.situation.run_id, status.situation.code_changed], ['run_not_settled', run.run_id, true]);
  completeReport(repo, run.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'chat' }), (error) => {
    blockedWith('code_changed_during_run')(error);
    assert.ok(!codes(error.gaps).includes('code_changed'), JSON.stringify(error.gaps));
    return true;
  });
  assert.ok(!existsSync(path.join(root, 'accepted.json')));
});

test('loop start keeps uncommitted starting code as loop-start.patch while .git is read-only, without writing into its objects', (t) => {
  const { repo, root } = readyProject(t);
  writeFileSync(path.join(repo, 'app/handler.txt'), 'the code before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const objects = path.join(repo, '.git/objects');
  const before = spawnSync('find', [objects], { encoding: 'utf8' }).stdout;
  assert.equal(spawnSync('chmod', ['-R', 'a-w', path.join(repo, '.git')]).status, 0);
  let started;
  try { started = startLoop(repo, CHANGE); } finally { spawnSync('chmod', ['-R', 'u+w', path.join(repo, '.git')]); }
  assert.deepEqual(started.warnings, []);
  assert.equal(started.loop.start_code.patch, 'loop-start.patch');
  assert.match(readFileSync(path.join(root, 'loop-start.patch'), 'utf8'), /^\+the code before the change$/m);
  assert.equal(spawnSync('find', [objects], { encoding: 'utf8' }).stdout, before);
});

test('a base record whose code.patch cannot be written is refused before it runs, so no loop starts on code that cannot be restored', (t) => {
  // File modes do not stop root from reading a file, so the patch would not fail.
  if (process.getuid?.() === 0) { t.skip('needs a user that file modes apply to'); return; }
  const project = readyProject(t);
  const { repo, root } = project;
  const locked = path.join(repo, 'app/locked.bin');
  writeFileSync(locked, 'unreadable\n');
  chmodSync(locked, 0o000);
  const refusal = refusedBeforeRun(project, { baseline: true, expect: writeExpectations(repo, EXPECT) }, 'code_unrestorable');
  assertGapShape(refusal, { owner: 'agent', layer: 'code' });
  assert.match(refusal.message, /^code\.patch could not be written \(.+\), so the code of this base record could not be restored from its commit, and no loop could start from it\.$/);
  assert.ok(!existsSync(path.join(root, 'loop-start.patch')));
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_missing'));
});

test('loop status names run folders without run.json, left by interrupted runs, and keeps them as evidence', (t) => {
  const { repo, runs } = inLoop(t);
  const interrupted = '20260101-000000-dead';
  mkdirSync(path.join(runs, interrupted, 'submit-failure-s1', 'logs'), { recursive: true });
  writeFileSync(path.join(runs, interrupted, 'code.patch'), '');
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(`Run folders without a readable run.json, left by a run that was interrupted or is still running: ${interrupted}. A run the run index lists counts as interrupted: the attempts it completed count for its code. The folders hold that evidence and their logs.`),
    JSON.stringify(status.warnings));
  // Deleting a folder would drop that evidence, so no warning asks for it.
  assert.ok(!status.warnings.some((warning) => /\bdelete/i.test(warning)), JSON.stringify(status.warnings));
  assert.equal(status.loop.used.iterations, 0);
});

// --- The first loop and the baseline's code: the start code is the code the
// baseline ran on, whatever the working directory holds when the loop starts.
// ---

test('after a clean baseline loop start is the user\'s decision, and a loop that starts after the code moved starts on the baseline\'s code and records what moved', (t) => {
  const project = withBaseline(t);
  const { repo, root, base } = project;
  assert.deepEqual(base.loop_baseline, { usable: true, reasons: [] });
  assert.equal(base.confirmation_current, true);
  assert.equal(base.suggestion, null);
  let status = workflowStatus(repo, CHANGE);
  let start = loopStartAction(status);
  assert.deepEqual([start.by, start.allowed, start.needed], ['user', true, true], JSON.stringify(start));
  assert.ok(start.needs.includes('user consent: starting a loop, recorded with --by and --ref'), JSON.stringify(start.needs));
  assert.deepEqual(status.suggestion.command, ['loop', 'start', CHANGE, '--repo', repo, '--by', '<user>', '--ref', '<where they said so>']);
  // A pass outside a loop is a comparison, not an acceptance.
  assert.deepEqual([headAction(status).needed, headAction(status).acceptance], [false, false]);

  // The agent changes the code before starting the loop, without committing.
  setResults(repo, AFTER);
  status = workflowStatus(repo, CHANGE);
  assert.equal(status.layers.baseline.recorded.on_code_now, false);
  start = loopStartAction(status);
  assert.deepEqual([start.allowed, start.blocked_by], [true, []], JSON.stringify(start));
  assert.ok(!codes(status.gaps).includes('baseline_not_at_start'), JSON.stringify(status.gaps));
  const started = startLoop(repo, CHANGE);
  const { loop } = started;
  assert.deepEqual([started.worktree_moved, started.moved_files], [true, ['app/results.json']]);
  assert.deepEqual([loop.worktree_moved, loop.moved_files, loop.start_from], [true, ['app/results.json'], 'baseline']);
  assert.deepEqual([loop.start_code.commit, loop.start_code.digest], [readRecord(base).run.code_snapshot.commit, digestOf(base)]);
  assert.ok(started.warnings.includes(`The working directory differs from the code the baseline ${base.run_id} ran on in app/results.json: the loop starts on the baseline's code, so those edits are part of its change.`),
    JSON.stringify(started.warnings));
  // The edits stay where they were, and the user's consent is recorded with the loop.
  assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER);
  assert.deepEqual([loop.consent.by, loop.consent.ref], [USER, REF]);
  const decision = readDecisions(root).entries.filter((entry) => entry.type === 'loop_start').at(-1);
  assert.deepEqual([decision.by, decision.ref, decision.baseline, decision.start_code, decision.worktree_moved], [USER, REF, base.run_id, loop.start_code.digest, true]);

  // The run of the moved code is compared with the baseline, and the user hears what moved.
  const run = fullRun(repo);
  assert.deepEqual([run.verdict, run.base_run], ['pass', base.run_id]);
  const after = loopStatus(repo, CHANGE);
  assert.deepEqual(after.review.worktree_moved_at_start, ['app/results.json']);
  assert.deepEqual(after.must_show.worktree_moved, [{ files: ['app/results.json'] }]);
  assert.ok(after.obligations.some((entry) => entry.kind === 'disclosure' && entry.item === 'worktree_moved'), JSON.stringify(after.obligations));
});

// The stash entries as `git stash list` prints them.
const stashes = (repo) => git(repo, ['stash', 'list']).split('\n').filter(Boolean);

// Rebuilds a loop's start code in a fresh clone: its commit, or an empty
// tree, plus loop-start.patch. Returns the clone.
function rebuildStart(t, project, loop) {
  const clone = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-start-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(clone, ['clone', '-q', project.repo, '.']);
  if (loop.start_code.commit) git(clone, ['checkout', '-q', '--detach', loop.start_code.commit]);
  if (loop.start_code.patch) git(clone, ['apply', path.join(project.root, loop.start_code.patch)]);
  return clone;
}

test('a loop on a baseline of uncommitted code keeps that code as a copy of the baseline\'s code.patch and leaves the later edits in the working directory', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  setResults(repo, { ...BEFORE, note: 'uncommitted' });
  writeFileSync(path.join(repo, 'app/new.txt'), 'a new file before the baseline\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  // The edits touch a file the baseline's patch holds, and add another.
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/new.txt'), 'edited after the baseline\n');
  writeFileSync(path.join(repo, 'app/later.txt'), 'added after the baseline\n');

  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(loop.start_code.patch, 'loop-start.patch');
  assert.equal(readFileSync(path.join(root, 'loop-start.patch'), 'utf8'), readFileSync(path.join(base.directory, 'code.patch'), 'utf8'));
  assert.deepEqual([loop.worktree_moved, loop.moved_files], [true, ['app/later.txt', 'app/new.txt', 'app/results.json']]);
  // Nothing in the working directory moved.
  assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER);
  assert.equal(readFileSync(path.join(repo, 'app/new.txt'), 'utf8'), 'edited after the baseline\n');
  assert.equal(readFileSync(path.join(repo, 'app/later.txt'), 'utf8'), 'added after the baseline\n');
  // The start code is the baseline's code again from its commit and the patch.
  const clone = rebuildStart(t, project, loop);
  assert.equal(readFileSync(path.join(clone, 'app/new.txt'), 'utf8'), 'a new file before the baseline\n');
  assert.equal(existsSync(path.join(clone, 'app/later.txt')), false);
  assert.equal(codeSnapshot(clone).snapshot.digest, digestOf(base));
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('a loop starts on the baseline\'s commit when a later commit holds the change, and lists the files that commit moved', (t) => {
  const { repo, base } = withBaseline(t);
  const head = changeCode(repo, AFTER, 'Commit the change before starting the loop');
  const started = startLoop(repo, CHANGE);
  const { loop } = started;
  assert.equal(loop.start_code.commit, readRecord(base).run.code_snapshot.commit);
  assert.notEqual(loop.start_code.commit, head);
  assert.equal(loop.start_code.digest, digestOf(base));
  assert.deepEqual([loop.worktree_moved, loop.moved_files], [true, ['app/handler.txt', 'app/results.json']]);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('loop start touches neither the working directory nor the stash: an unrelated stash stays, and a file only the baseline ran on stays in loop-start.patch', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  writeFileSync(path.join(repo, 'app/unrelated.txt'), 'unrelated work\n');
  git(repo, ['stash', 'push', '--include-untracked', '-q', '-m', 'unrelated work', '--', 'app/unrelated.txt']);
  // The baseline runs on an uncommitted file, which is then removed again.
  writeFileSync(path.join(repo, 'app/extra.txt'), 'only at the baseline\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  rmSync(path.join(repo, 'app/extra.txt'));
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, base.run_id);
  assert.deepEqual([loop.worktree_moved, loop.moved_files], [true, ['app/extra.txt']]);
  assert.match(readFileSync(path.join(root, 'loop-start.patch'), 'utf8'), /^\+only at the baseline$/m);
  assert.equal(existsSync(path.join(repo, 'app/extra.txt')), false);
  assert.deepEqual(stashes(repo).map((entry) => entry.replace(/^stash@\{0\}: /, '')), ['On main: unrelated work']);
  assert.equal(readFileSync(path.join(rebuildStart(t, project, loop), 'app/extra.txt'), 'utf8'), 'only at the baseline\n');
});

test('committing only the Spec and the evals after the baseline moves no code: the loop lists only the application files that moved', (t) => {
  const { repo } = readyProject(t, { commit: false });
  git(repo, ['add', 'app']);
  git(repo, ['commit', '-q', '-m', 'Add the application']);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  commit(repo, 'Add the Spec and the evals');
  setResults(repo, AFTER);
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(loop.start_code.digest, digestOf(base));
  assert.deepEqual([loop.worktree_moved, loop.moved_files], [true, ['app/results.json']]);
  assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER);
  assert.deepEqual(stashes(repo), []);
});

test('a baseline on uncommitted code, or before the first commit, that was committed afterwards keeps its code, which --at-start rebuilds', (t) => {
  for (const before of ['uncommitted', 'no-commit']) {
    const project = readyProject(t, { commit: before === 'uncommitted' });
    const { repo } = project;
    ignoreGenesis(repo);
    if (before === 'uncommitted') setResults(repo, { ...BEFORE, note: 'uncommitted' });
    const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
    assert.ok(readRecord(base).run.code_snapshot.patch, before);
    commit(repo, 'Commit the code the baseline ran on');
    setResults(repo, AFTER);
    const { loop } = startLoop(repo, CHANGE);
    assert.equal(loop.start_code.digest, digestOf(base), before);
    assert.equal(loop.start_code.patch, 'loop-start.patch', before);
    // The working directory holds the change; --at-start records a base record
    // of the start code outside it.
    const again = startRun(repo, CHANGE, { baseline: true, atStart: true, expect: writeExpectations(repo, EXPECT) });
    assert.equal(again.is_baseline, true, `${before}: ${JSON.stringify(again)}`);
    assert.equal(digestOf(again), loop.start_code.digest, before);
    assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER, before);
  }
});

// --- A failing run after a passing one of the same code. ---

test('after a partial run voids the acceptance of a run that is not the latest full run, the loop ends as unstable on that code', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
  // A later full run of other code fails; the code goes back to the passing run's.
  const handler = path.join(repo, 'app/handler.txt');
  const kept = readFileSync(handler, 'utf8');
  writeFileSync(handler, 'an experiment\n');
  setResults(repo, BEFORE);
  const other = fullRun(repo);
  assert.equal(other.verdict, 'fail');
  completeReport(repo, other.run_id);
  writeFileSync(handler, kept);
  setResults(repo, AFTER);
  reviewRun(project, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.equal(status.accepted, false);
  assert.equal(status.acceptance.outdated, true);
  assert.ok(status.warnings.includes(`Partial run ${partial.run_id}, after the user accepted run ${accepted.run_id}, fails on the accepted code, so the acceptance no longer covers this loop. A failure of the accepted code always counts, so no run of it can be accepted again.`),
    JSON.stringify(status.warnings));
});

test('inside a loop a head run suggests loop status and states what it is, never acceptance', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  const failing = fullRun(repo);
  assert.equal(failing.verdict, 'fail');
  assert.deepEqual([failing.in_loop, failing.acceptable], [true, false]);
  assert.deepEqual(failing.failures_count, { cases: [SUCCESS] });
  assert.deepEqual(failing.suggestion.command, ['loop', 'status', CHANGE, '--repo', repo]);
  changeCode(repo, AFTER, 'Fix both notices');
  const passing = fullRun(repo);
  assert.equal(passing.verdict, 'pass');
  assert.deepEqual([passing.in_loop, passing.acceptable], [true, true]);
  assert.deepEqual(passing.suggestion.command, ['loop', 'status', CHANGE, '--repo', repo]);
  assertNoRoutes(passing);
  // A pass is not acceptance: that needs a final review of the code and the user.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', passing.run_id]);
  assert.match(status.situation.message, /A pass is not acceptance: accepting it is the user's decision, and it needs a final review recorded for its code\./);
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  assert.deepEqual(status.suggestion.command.slice(0, 2), ['loop', 'review']);
});

test('before acceptance, a partial run that fails on the code of the latest passing run ends the loop as unstable, and no run of that code can be accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  completeReport(repo, passed.run_id);
  const waiting = loopStatus(repo, CHANGE);
  assert.deepEqual([waiting.situation.code, waiting.review.run_id, waiting.review.satisfied], ['acceptable', passed.run_id, false]);
  reviewRun(project, passed.run_id);

  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  assert.deepEqual(partial.failures_count, { cases: [FAILURE] });
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assertGapShape(status.gates.head_run, { code: 'stop_unstable', owner: 'user', layer: 'code' });
  assert.ok(status.ended.message.startsWith(`${FAILURE}/c1 passed in ${passed.run_id} and failed in ${partial.run_id}, on the same code and packages.`), status.ended.message);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('unstable'));
  assert.deepEqual(status.unstable.map(({ pass, fail }) => ({ pass, fail })), [{ pass: [passed.run_id], fail: [partial.run_id] }]);

  // The loop has ended: another run of the same code, or of other code, is
  // refused, since the change is locked until a new loop or an abandon.
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_unstable');
  changeCode(repo, AFTER, 'Write the notice another way');
  assertEnded(loopStatus(repo, CHANGE), 'stop_unstable');
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_unstable');
});

test('after acceptance, a partial run that fails on the accepted code ends the loop for good; one that fails on other code does not', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
  reviewRun(project, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  // A failing partial run of other code says nothing about the accepted code.
  const handler = path.join(repo, 'app/handler.txt');
  const kept = readFileSync(handler, 'utf8');
  writeFileSync(handler, 'an experiment\n');
  setResults(repo, BEFORE);
  assert.equal(startRun(repo, CHANGE, { case: [FAILURE] }).verdict, 'fail');
  writeFileSync(handler, kept);
  setResults(repo, AFTER);
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  // One of the accepted code does.
  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.equal(status.acceptance.outdated, true);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Partial run ${partial.run_id}, after the user accepted run ${accepted.run_id}, fails on the accepted code, so the acceptance no longer covers this loop.`)), JSON.stringify(status.warnings));
  const work = workflowStatus(repo, CHANGE);
  assert.equal(work.layers.loop.phase, 'ended');
  assert.ok(codes(work.gaps).includes('change_locked'), JSON.stringify(work.gaps));
  assert.equal(headAction(work).allowed, false);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('unstable'));
  // No run of that code, or of other code, follows.
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_unstable');
  changeCode(repo, AFTER, 'Write the notice another way');
  assertEnded(loopStatus(repo, CHANGE), 'stop_unstable');
  assert.equal(refusedBeforeRun(project, { case: [FAILURE] }, 'change_locked').reason, 'stop_unstable');
});

test('after the loop\'s baseline went missing, the light tier no longer holds, and a baseline on the start code with a full-tier confirmation starts a new loop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editApp(repo, BEFORE, 'A first try');
  completeReport(repo, fullRun(repo).run_id);
  rmSync(path.join(project.runs, project.base.run_id), { recursive: true });
  assertEnded(loopStatus(repo, CHANGE), 'baseline_missing');
  // The run index still lists the baseline: its lost record counts as a
  // failure on its code, so whether the results vary cannot be read.
  const { tier } = validateEval(repo, CHANGE);
  assert.equal(tier.eligible, false);
  assert.deepEqual(tier.reasons.map((entry) => [entry.condition, entry.package, entry.runs]),
    [['lost_run', FAILURE, [project.base.run_id]], ['lost_run', SUCCESS, [project.base.run_id]]]);
  // As the end says: a baseline on the loop's start code.
  restoreStart(project);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(again.is_baseline, true);
  assert.deepEqual(again.loop, { started_at: project.loop.started_at, baseline: project.base.run_id, ended: true });
  let work = workflowStatus(repo, CHANGE);
  assert.deepEqual([work.layers.baseline.recorded.run_id, work.layers.baseline.recorded.on_start_code], [again.run_id, true]);
  const gates = Object.fromEntries(work.layers.loop.ended.new_loop.gates.map((entry) => [entry.gate, entry.holds]));
  assert.deepEqual(gates, { checks_confirmation: true, baseline_on_start_code: true, user_consent: false });
  assert.deepEqual(loopStartAction(work).blocked_by, ['tier_light_unfit']);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assertGapShape(error.gaps.find((entry) => entry.code === 'tier_light_unfit'), { owner: 'user', layer: 'confirmation' });
    return true;
  });
  // The tier is the user's: once they confirm the full tier, the new loop
  // starts on that baseline with their consent.
  confirmChecks(project, { tier: 'full', reason: 'The baseline folder was lost; the user chose the full tier.' });
  work = workflowStatus(repo, CHANGE);
  const start = loopStartAction(work);
  assert.deepEqual([start.allowed, start.by], [true, 'user'], JSON.stringify(start));
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});
