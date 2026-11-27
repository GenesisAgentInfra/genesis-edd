// Loop tests: the loop's pinned baseline, the starting code and the way back to
// it, and the step after the baseline.
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
  EXPECT, BROKEN, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord, FAILURE, SUCCESS,
  REVISED, loopPath, loopRecord, editLoop, minutesAgo, near, withoutKey, editApp, exportRevision, sameCodeAsRun, resultsOutsideCode, assertStopBudget,
  refusedBeforeRun, assertEnded, restoreStart,
} from './helpers/loop.js';

// --- Found in review: the loop's pinned baseline everywhere, new loops that
// keep the start code, and how to get back to it. ---

test('workflow checks follow the loop baseline when a later baseline attempt on the starting code did not run', (t) => {
  const project = inLoop(t);
  const { repo, root, base, tools } = project;
  // Harbor leaves no trial, so this baseline attempt does not complete.
  harborThen(t, "(await import('node:fs')).rmSync(path.join(logs, 'harbor'), { recursive: true, force: true });");
  const attempt = startRun(repo, CHANGE, { baseline: true });
  tools.harbor(true);
  assert.equal(attempt.execution_status, 'error');
  assert.match(attempt.next, /Execution did not complete/);
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
  assert.match(again.next, new RegExp(`compares every run with its own baseline ${base.run_id} while it runs`));
  assert.doesNotMatch(again.next, /later runs are compared with this baseline/);
});

test('a new loop after an end keeps the start code of the first unaccepted loop', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, base, loop } = project;
  changeCode(repo, BROKEN, 'First attempt');
  completeReport(repo, fullRun(repo).run_id);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'budget_used_up');
  changeCode(repo, AFTER, 'Second attempt');
  const started = startLoop(repo, CHANGE, { iterations: 3 });
  const next = started.loop;
  assert.deepEqual(next.start_code, loop.start_code);
  assert.equal(next.base_commit, loop.start_code.commit);
  assert.equal(next.baseline, base.run_id);
  assert.equal(next.previous.length, 1);
  assert.equal(next.previous[0].started_at, loop.started_at);
  assert.equal(loopStatus(repo, CHANGE).runs.length, 0);
  // Every base record still has to be on that code.
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

test('a commit that changes no content is not a code change: the loop takes a base record on it, and accepts a run committed after it ran', (t) => {
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

  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  commit(repo, 'Stop the success notice when a submission fails');
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
});

test('two full runs on the same content warn that a run of the same code only adds to its count, even when a commit lies between them', (t) => {
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

test('a missing loop baseline ends the loop, workflow check run-eval names no head run, and the restore hint names the loop\'s commit', (t) => {
  const { repo, base, loop } = inLoop(t);
  rmSync(base.directory, { recursive: true, force: true });
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'baseline_missing');
  assert.equal(status.next.route, 'run-eval');
  assert.match(status.warnings.join('\n'), /no longer in runs/);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'record_baseline', JSON.stringify(check.next));
  assert.match(check.next.note, /start a new loop only once the user agrees/);

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
  const text = readFileSync(writeReport(repo, CHANGE, { run: run.run_id }).file, 'utf8');
  assert.match(text, /Only gating checks decide the verdict/);
  assert.match(text, /^Only gating checks decide the verdict; a diagnostic result is shown for reference\. Each result shows its passes out of its attempts\.$/m);
  assert.match(text, /^\| Case \| Check \| Requirement \| THEN \| Role \| Before → After \| Verdict \|$/m);
  assert.match(text, /^\| --- \| --- \| --- \| --- \| --- \| --- \| --- \|$/m);
  assert.match(text, /^\| submit-failure-s1 \| c1 \| REQ-submit-failure \| 本次提交发送的成功通知数量为零 \| gating \| fail \(0\/1\) → pass \(1\/1\) \| holds \|$/m);
  assert.match(text, /^\| submit-success-s1 \| c2 \| REQ-submit-success \| 本次提交发送的失败通知数量为零 \| diagnostic \| pass \(1\/1\) → pass \(1\/1\) \| holds \|$/m);
  // The block of lines the user judges, one line per row and its pipes escaped.
  assert.ok(text.includes(`\nNo check verifies these lines; the user judges them at acceptance:

| Case | THEN | Why no check |
| --- | --- | --- |
| submit-success-s1 | 本次提交发送的失败通知数量为零 | synthetic \\| read by a person |

## Cause`), text);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const accepted = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual(accepted.checks.map((entry) => [entry.case, entry.check, entry.role]), [
    ['submit-failure-s1', 'c1', 'gating'], ['submit-success-s1', 'c1', 'gating'], ['submit-success-s1', 'c2', 'diagnostic'],
  ]);
  assert.deepEqual(accepted.manual, [{ case: SUCCESS, then: '本次提交发送的失败通知数量为零', reason: 'synthetic | read by\na person' }]);
});

test('a run during which the code changed is never accepted, even once the code is back where that run started', (t) => {
  const { repo, root } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  // Each package's run edits the application once Harbor is done with it.
  harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
  const run = startRun(repo, CHANGE);
  assert.equal(run.verdict, 'unverified', JSON.stringify(run));
  rmSync(path.join(repo, 'app/edited.txt'));
  assert.equal(sameCodeAsRun(repo, run), true);

  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(`The code changed while ${run.run_id} executed, so its results do not belong to one version of the code. Leave the code as it is during a run, and run again.`),
    JSON.stringify(status.warnings));
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

test('loop start warns when loop-start.patch cannot be written, because the starting code cannot be restored', (t) => {
  // File modes do not stop root from reading a file, so the patch would not fail.
  if (process.getuid?.() === 0) { t.skip('needs a user that file modes apply to'); return; }
  const { repo, root } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const locked = path.join(repo, 'app/locked.bin');
  writeFileSync(locked, 'unreadable\n');
  chmodSync(locked, 0o000);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const started = startLoop(repo, CHANGE);
  assert.equal(started.warnings.length, 1, JSON.stringify(started.warnings));
  assert.match(started.warnings[0], new RegExp(`^loop-start\\.patch could not be written \\(git add failed: .+\\), so the loop's starting code cannot be restored: commit ${head.slice(0, 7)} does not hold its uncommitted files\\.`));
  assert.equal(started.loop.start_code.patch, undefined);
  assert.ok(!existsSync(path.join(root, 'loop-start.patch')));
});

test('loop status names run folders without run.json, left by interrupted runs, and says they can be deleted', (t) => {
  const { repo, runs } = inLoop(t);
  const interrupted = '20260101-000000-dead';
  mkdirSync(path.join(runs, interrupted, 'submit-failure-s1', 'logs'), { recursive: true });
  writeFileSync(path.join(runs, interrupted, 'code.patch'), '');
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.includes(`Run folders without a readable run.json, left by a run that was interrupted or is still running: ${interrupted}. They are not counted or compared. Delete them once their logs are no longer needed.`),
    JSON.stringify(status.warnings));
  assert.equal(status.loop.used.iterations, 0);
});

// --- Found walking one change end to end: the step after the baseline, and a
// failing run after a passing one of the same code. ---

test('after a clean baseline the next step is loop start; once the code changed outside a loop, every check says a loop cannot start on it and how to get back', (t) => {
  const { repo, base } = withBaseline(t);
  assert.match(base.next, /^The baseline is recorded\. Start the implementation loop before changing any code/);
  const run = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(run.next.action, 'start_loop');
  assert.equal(run.next.route, 'loop-and-implement');
  assert.deepEqual(run.next.command, ['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(checkWorkflow(repo, 'loop-and-implement', CHANGE).next.action, 'start_loop');

  // The agent changes the code before starting the loop, without committing.
  setResults(repo, AFTER);
  const moved = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(moved.next.action, 'run_eval');
  assert.match(moved.next.note, new RegExp(`^The code changed after the baseline ${base.run_id}, so a loop cannot start on it while the code differs`));
  const loopCheck = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(loopCheck.status, 'blocked');
  assert.deepEqual(codes(loopCheck.gaps), ['baseline_not_at_start']);
  // Setting the edits aside happens where the loop starts.
  assert.equal(loopCheck.next.route, 'loop-and-implement');
  const { message } = loopCheck.gaps[0];
  assert.doesNotMatch(message, /git switch/);
  // The baseline ran on committed code, so it has no code.patch to name.
  assert.doesNotMatch(message, /code\.patch/);
  assert.match(message, /commit [0-9a-f]{7}\)/);
  assert.match(message, /git stash push --include-untracked/);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_not_at_start')(error);
    assert.equal(error.gaps.find((entry) => entry.code === 'baseline_not_at_start').message, message);
    return true;
  });

  // Setting the edit aside, starting the loop and bringing the edit back works.
  git(repo, ['stash', 'push', '--include-untracked', '-q', '--', 'app']);
  assert.equal(checkWorkflow(repo, 'loop-and-implement', CHANGE).status, 'ready');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, base.run_id);
  git(repo, ['stash', 'pop', '-q']);
  assert.equal(fullRun(repo).verdict, 'pass');
});

// Runs the shell commands a message gives in backticks, in order, except loop
// start, which runs through the API so the test can check its result.
function followRecipe(repo, message, { pop = true } = {}) {
  // `git apply` alone names the baseline's code, not a step.
  const commands = [...message.matchAll(/`(git [^`]+)`/g)].map((match) => match[1]).filter((command) => command !== 'git apply');
  let started = null;
  for (const command of commands) {
    if (command === 'git stash pop' && !pop) continue;
    if (command.startsWith('git apply -R') || command === 'git switch -' || command === 'git stash pop') {
      if (!started) started = startLoop(repo, CHANGE);
    }
    const result = spawnSync('sh', ['-c', command], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  return started ?? startLoop(repo, CHANGE);
}

test('a baseline that ran on uncommitted code names its code.patch, and the way back it gives restores the code, starts the loop and brings the edits back', (t) => {
  const { repo } = readyProject(t);
  setResults(repo, { ...BEFORE, note: 'uncommitted' });
  writeFileSync(path.join(repo, 'app/new.txt'), 'a new file before the baseline\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  // The edits touch a file the baseline's patch holds, and add another.
  setResults(repo, AFTER);
  writeFileSync(path.join(repo, 'app/new.txt'), 'edited after the baseline\n');
  writeFileSync(path.join(repo, 'app/later.txt'), 'added after the baseline\n');
  const { message } = checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((entry) => entry.code === 'baseline_not_at_start');
  const patch = `.genesis/edd/${CHANGE}/runs/${base.run_id}/code.patch`;
  assert.ok(message.includes(`plus \`git apply\` ${patch}`), message);
  assert.ok(message.includes(`\`git apply -R ${patch}\``), message);

  const { loop } = followRecipe(repo, message);
  assert.equal(loop.baseline, base.run_id);
  assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER);
  assert.equal(readFileSync(path.join(repo, 'app/new.txt'), 'utf8'), 'edited after the baseline\n');
  assert.equal(readFileSync(path.join(repo, 'app/later.txt'), 'utf8'), 'added after the baseline\n');
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('when the commit holds application edits made after the baseline, the way back gives no stash recipe and asks to agree it with the user', (t) => {
  const { repo } = withBaseline(t);
  const head = changeCode(repo, AFTER, 'Commit the change before starting the loop');
  const { message } = checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((entry) => entry.code === 'baseline_not_at_start');
  assert.match(message, new RegExp(`Commit ${head.slice(0, 7)} holds application files other than the baseline's, so a stash cannot set them aside\\. Tell the user`));
  assert.doesNotMatch(message, /git stash|git switch/);
});

// The stash entries as `git stash list` prints them.
const stashes = (repo) => git(repo, ['stash', 'list']).split('\n').filter(Boolean);

test('the way back stashes nothing and pops nothing when no application file is uncommitted, so an unrelated stash stays', (t) => {
  const { repo } = readyProject(t);
  writeFileSync(path.join(repo, 'app/unrelated.txt'), 'unrelated work\n');
  git(repo, ['stash', 'push', '--include-untracked', '-q', '-m', 'unrelated work', '--', 'app/unrelated.txt']);
  // The baseline runs on an uncommitted file, which is then removed again.
  writeFileSync(path.join(repo, 'app/extra.txt'), 'only at the baseline\n');
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  rmSync(path.join(repo, 'app/extra.txt'));
  const { message } = checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((entry) => entry.code === 'baseline_not_at_start');
  assert.doesNotMatch(message, /git stash/);
  assert.match(message, /git apply -R/);
  const { loop } = followRecipe(repo, message);
  assert.equal(loop.baseline, base.run_id);
  assert.equal(existsSync(path.join(repo, 'app/extra.txt')), false);
  assert.deepEqual(stashes(repo).map((entry) => entry.replace(/^stash@\{0\}: /, '')), ['On main: unrelated work']);
});

test('committing only the Spec and the evals after the baseline still gives the stash recipe, and it works', (t) => {
  const { repo } = readyProject(t, { commit: false });
  git(repo, ['add', 'app']);
  git(repo, ['commit', '-q', '-m', 'Add the application']);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  commit(repo, 'Add the Spec and the evals');
  setResults(repo, AFTER);
  const { message } = checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((entry) => entry.code === 'baseline_not_at_start');
  assert.match(message, /git stash push --include-untracked/);
  assert.doesNotMatch(message, /git apply|Tell the user/);
  assert.equal(followRecipe(repo, message).loop.baseline, base.run_id);
  assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER);
  assert.deepEqual(stashes(repo), []);
});

test('a baseline on uncommitted code, or before the first commit, that was committed afterwards gives the stash recipe without the patch', (t) => {
  for (const before of ['uncommitted', 'no-commit']) {
    const { repo } = readyProject(t, { commit: before === 'uncommitted' });
    if (before === 'uncommitted') setResults(repo, { ...BEFORE, note: 'uncommitted' });
    const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
    assert.ok(readRecord(base).run.code_snapshot.patch, before);
    commit(repo, 'Commit the code the baseline ran on');
    setResults(repo, AFTER);
    const { message } = checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps.find((entry) => entry.code === 'baseline_not_at_start');
    assert.match(message, /git stash push --include-untracked/, before);
    assert.doesNotMatch(message, /`git apply |no commit, so|Tell the user/, before);
    assert.equal(followRecipe(repo, message).loop.baseline, base.run_id, before);
    assert.deepEqual(readJSON(path.join(repo, 'app/results.json')), AFTER, before);
  }
});

test('after a partial run voids the acceptance of a run that is not the latest full run, loop status stops as unstable on that code', (t) => {
  const { repo } = inLoop(t);
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
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  setResults(repo, AFTER);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, true);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Partial run ${partial.run_id}, after the user accepted run ${accepted.run_id}, fails on the accepted code`)
    && warning.endsWith('A failure of the accepted code always counts, so no run of it can be accepted again. Tell the user.')), JSON.stringify(status.warnings));
});

test('inside a loop a head run points at loop status, not at acceptance', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  const failing = fullRun(repo);
  assert.equal(failing.verdict, 'fail');
  assert.match(failing.next, /classify the cause first\. Then run `loop status`/);
  changeCode(repo, AFTER, 'Fix both notices');
  const passing = fullRun(repo);
  assert.equal(passing.verdict, 'pass');
  assert.match(passing.next, /^Every gating check passes\. Run `loop status` next: the report and the final review come before the user is asked to accept\.$/);
  assert.doesNotMatch(passing.next, /Acceptance is met/);
});

test('before acceptance, a partial run that fails on the code of the latest passing run stops the loop as unstable, and no run of that code can be accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const passed = fullRun(repo);
  completeReport(repo, passed.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');

  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  assert.match(partial.next, /its failure always counts for the same code: no run of that code and those packages can be accepted\. Run `loop status` next\.$/);
  setResults(repo, AFTER);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.equal(status.next.owner, 'user');
  assert.equal(status.next.command, undefined);
  assert.ok(status.next.message.startsWith(`${FAILURE}/c1 passed in ${passed.run_id} and failed in ${partial.run_id}, on the same code and packages.`), status.next.message);
  completeReport(repo, passed.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: passed.run_id, by: 'Dana', ref: 'thread 1' }), refusedWith('unstable'));
  assert.deepEqual(status.unstable.map(({ pass, fail }) => ({ pass, fail })), [{ pass: [passed.run_id], fail: [partial.run_id] }]);

  // The loop has ended: another run of the same code, or of other code, is refused.
  refusedBeforeRun(project, {}, 'stop_unstable');
  changeCode(repo, AFTER, 'Write the notice another way');
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_unstable');
  refusedBeforeRun(project, {}, 'stop_unstable');
});

test('after acceptance, a partial run that fails on the accepted code ends done and stops the loop for good; one that fails on other code does not', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  resultsOutsideCode(repo);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  // A failing partial run of other code says nothing about the accepted code.
  const handler = path.join(repo, 'app/handler.txt');
  const kept = readFileSync(handler, 'utf8');
  writeFileSync(handler, 'an experiment\n');
  setResults(repo, BEFORE);
  assert.equal(startRun(repo, CHANGE, { case: [FAILURE] }).verdict, 'fail');
  writeFileSync(handler, kept);
  setResults(repo, AFTER);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  // One of the accepted code does.
  setResults(repo, BEFORE);
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.equal(partial.verdict, 'fail');
  setResults(repo, AFTER);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, true);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Partial run ${partial.run_id}, after the user accepted run ${accepted.run_id}, fails on the accepted code, so the acceptance no longer covers this loop.`)), JSON.stringify(status.warnings));
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'loop_status');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('unstable'));
  // No run of that code, or of other code, follows.
  refusedBeforeRun(project, {}, 'stop_unstable');
  changeCode(repo, AFTER, 'Write the notice another way');
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_unstable');
  refusedBeforeRun(project, { case: [FAILURE] }, 'stop_unstable');
});

test('after the loop\'s baseline went missing and a baseline is recorded again on its start code, workflow check loop-and-implement names a new loop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editApp(repo, BEFORE, 'A first try');
  completeReport(repo, fullRun(repo).run_id);
  rmSync(path.join(project.runs, project.base.run_id), { recursive: true });
  assertEnded(loopStatus(repo, CHANGE), 'baseline_missing');
  assert.ok(codes(checkWorkflow(repo, 'loop-and-implement', CHANGE).gaps).includes('loop_baseline_missing'));
  // As the end says: a baseline on the loop's start code.
  restoreStart(project);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  const check = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.equal(check.next.action, 'start_loop');
  assert.ok(check.next.note.startsWith('The loop for this Spec ended (baseline_missing), and a baseline is recorded again on its start code: start a new loop only once the user agrees.'), check.next.note);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});
