// Loop tests: acceptance and what it still covers, the final review, what has
// to be committed, and ignored records.
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
  AFTER, AGENT, BEFORE, CHANGE, FIXTURES, LIVE_DEPENDENCY, SPECS, cli, commit, commitConfirmation, confirmChecks, connect, dropCheck, editChecks, git, harborThen, harborWhile, legacyWarning, readRecord,
  readyProject, reviewFixtures, setResults, toLegacy, useFakeTools, writeExpectations, writeFixtureScripts, writeSpec,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord, FAILURE, SUCCESS,
  loopPath, loopRecord, editLoop, minutesAgo, near, assertStopBudget, editApp, sameCodeAsRun,
  refusedBeforeRun, assertEnded,
} from './helpers/loop.js';

// --- Acceptance that stops covering the loop, the final review, what still
// has to be committed, ignored records, comparisons across runs that could not
// tell, the baseline a loop starts on, the Genesis review and the budget. ---

test('after acceptance, code that changed is no longer done: loop status says run again, workflow check runs again, and a passing run of that code is accepted again', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'thread 1' });
  const earlier = readJSON(path.join(root, 'accepted.json'));
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  editApp(repo, AFTER, 'a tweak after the acceptance');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'run_again', JSON.stringify(status.next));
  assert.deepEqual(status.next.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.match(status.next.message, new RegExp(`The code changed after ${first.run_id}, the run the user accepted, so the acceptance no longer covers it`));
  assert.match(status.next.message, /needs their acceptance again/);
  assert.doesNotMatch(status.next.message, /merge|pull request|Offer to commit/);
  assert.equal(status.next.commit, undefined);
  assert.equal(status.accepted.outdated, true);
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(check.next.action, 'run_eval', JSON.stringify(check.next));

  const second = fullRun(repo);
  assert.equal(second.verdict, 'pass');
  completeReport(repo, second.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');
  completeReport(repo, second.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance');
  assert.match(status.next.message, new RegExp(`acceptance of run ${first.run_id} no longer covers the loop`));
  acceptLoop(repo, CHANGE, { run: second.run_id, by: 'Dana', ref: 'thread 2' });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.equal(record.run_id, second.run_id);
  assert.deepEqual(record.earlier, [earlier]);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.accepted.outdated, undefined);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'loop_done');
});

test('after acceptance, a later full run that fails lists the checks the accepted run passed under regressions and is not done', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  completeReport(repo, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });

  // The failed submission sends the success notice again, as before the change.
  changeCode(repo, BEFORE, 'one more small tweak');
  const later = fullRun(repo);
  assert.equal(later.verdict, 'fail');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Run ${later.run_id}, after the user accepted run ${accepted.run_id}, fails`)), JSON.stringify(status.warnings));
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'run_eval');
  completeReport(repo, later.run_id);
  status = loopStatus(repo, CHANGE);
  // Without the acceptance this would be lost progress; it breaks what the user accepted.
  assert.deepEqual(status.regressions, [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure' }]);
  assert.deepEqual(status.lost_progress, []);
  assert.equal(status.next.action, 'split_changes');
  assert.equal(status.accepted.outdated, true);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: later.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('not_passing'));
});

test('write_report and loop report never ask for Review, the final review follows once the rest of the report is complete, and a Review of a few characters is refused', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.doesNotMatch(status.next.message, /Review is empty/);

  const written = writeReport(repo, CHANGE);
  // Every check holds, so Cause is written already.
  assert.match(written.next, /^Fill in Changes and Next, then delete the template line\. Leave Review empty/);
  const skeleton = readFileSync(written.file, 'utf8');
  // The template line names the same sections as next.
  assert.match(skeleton.split('\n')[0], /keep Result as written; write Changes and Next, then delete this line/);
  assert.match(skeleton, /^<!-- Leave this empty until `loop status` says final_review\./m);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'write_report');
  assert.match(status.next.message, /the template line is still there; section Next is empty\. Leave Review for the final review that follows\.$/);
  assert.deepEqual(writeReport(repo, CHANGE).missing, ['the template line is still there', 'section Next is empty']);

  const file = completeReport(repo, run.run_id, { review: false });
  assert.deepEqual(writeReport(repo, CHANGE).missing, []);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'final_review');
  assert.match(status.next.message, /in at least 40 characters\.$/);

  // One word is not a review.
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^## Review[ \t]*$/m, '## Review\n\nLooks good.'));
  const short = 'section Review is too short: it needs at least 40 characters on who reviewed the whole change, what they checked and found, and how each finding was handled';
  assert.deepEqual(reportGaps(repo, CHANGE, { run_id: run.run_id, verdict: 'pass' }), [short]);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'chat' }), (error) => {
    refusedWith('report_incomplete')(error);
    assert.ok(error.message.includes(short), error.message);
    return true;
  });
  writeFileSync(file, readFileSync(file, 'utf8').replace('Looks good.', 'A fresh reviewer compared the whole diff with the Spec and found nothing to change.'));
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');
});

test('done says the commit is incomplete while the change\'s own files are not committed, names them, and names the commit once they are', (t) => {
  const { repo } = inLoop(t);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  writeFileSync(path.join(repo, 'openspec/changes', CHANGE, 'design-notes.md'), '# Notes\n');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });

  git(repo, ['add', 'app']);
  git(repo, ['commit', '-q', '-m', 'Commit only the application']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const edd = `.genesis/edd/${CHANGE}`;
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, undefined);
  assert.deepEqual(status.next.uncommitted, ['.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports/`,
    `openspec/changes/${CHANGE}/design-notes.md`]);
  assert.match(status.next.message, new RegExp(`The accepted code is committed in ${head.slice(0, 7)}, but the commit is incomplete: `));
  assert.ok(status.next.message.includes(`${edd}/accepted.json`), status.next.message);
  assert.doesNotMatch(status.next.message, /The accepted change is committed/);

  const all = commit(repo, 'Commit the evals, reports and acceptance');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.commit, all);
  assert.equal(status.next.uncommitted, undefined);
  assert.match(status.next.message, new RegExp(`The accepted change is committed in ${all.slice(0, 7)}\\. Offer to merge it or open a pull request`));

  // What Finder or an editor leaves beside the files is not part of the change.
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, '.DS_Store'), '');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, 'tests/checks.json.swp'), '');
  writeFileSync(path.join(repo, edd, 'reports', 'notes.md~'), '');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.commit, all, JSON.stringify(status.next));
  assert.equal(status.next.uncommitted, undefined);
});

test('a .gitignore that ignores .genesis/ is named in eval new, eval validate, loop status and loop accept, and keeps done from saying committed', (t) => {
  const { repo } = inLoop(t);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.genesis/\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const edd = `.genesis/edd/${CHANGE}`;
  const ignored = `Git ignores files of this change that must be committed: .genesis/edd/.gitignore, .genesis/edd/harness/, ${edd}/evals/, ${edd}/baseline-expectations.json, ${edd}/review.json, ${edd}/confirmed.json, ${edd}/reports/, ${edd}/accepted.json (rule \`.genesis/\` in .gitignore:2).`;
  const named = (warnings) => warnings.some((warning) => warning.startsWith(ignored) && warning.includes('ignore `.genesis/*` and add `!.genesis/edd/` after it, or ignore only `.genesis/out/`'));
  assert.ok(named(validateEval(repo, CHANGE).warnings), JSON.stringify(validateEval(repo, CHANGE).warnings));
  assert.ok(named(newEval(repo, CHANGE).warnings));
  assert.ok(named(cli(['eval', 'validate', CHANGE, '--repo', repo]).json.warnings));
  assert.ok(named(loopStatus(repo, CHANGE).warnings));

  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  commit(repo, 'Commit everything Git does not ignore');
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.ok(named(accepted.warnings), JSON.stringify(accepted.warnings));
  assert.equal(accepted.commit, undefined);
  // The packages were committed before the rule; only what Git does not hold is listed.
  assert.deepEqual(accepted.uncommitted, ['.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports/`]);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, undefined);
  assert.match(status.next.message, /the commit is incomplete/);

  // Ignoring Genesis's own output only is fine.
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.genesis/*\n!.genesis/edd/\n');
  assert.ok(!named(validateEval(repo, CHANGE).warnings));
  assert.deepEqual(validateEval(repo, CHANGE).warnings.filter((warning) => warning.startsWith('Git ignores')), []);
});

test('final review and acceptance are not asked for once the code changed after the passing run: loop status says run again', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');

  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'a fix from the review\n');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'run_again');
  assert.deepEqual(status.next.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.match(status.next.message, new RegExp(`^The code changed after ${run.run_id}; that run says nothing about the code now\\.`));
  assert.doesNotMatch(status.next.message, /acceptance no longer covers/);
  rmSync(scratch);
  completeReport(repo, run.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'ask_acceptance');

  writeFileSync(scratch, 'an edit before the user answered\n');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'run_again');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'chat' }), refusedWith('code_changed'));
});

test('a run that could not tell in between does not hide lost progress: each check compares with its latest pass or fail', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'fix the failure notice');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'a run whose evidence could not tell');
  const unclear = fullRun(repo);
  assert.equal(unclear.verdict, 'unverified');
  completeReport(repo, unclear.run_id);
  changeCode(repo, BEFORE, 'undo the fix by accident');
  completeReport(repo, fullRun(repo).run_id);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.checks.find((entry) => entry.case === FAILURE).runs, ['pass', 'unknown', 'fail']);
  assert.deepEqual(status.lost_progress, [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure' }]);
  assert.ok(status.warnings.some((warning) => /Passed in an earlier run and fails again: submit-failure-s1\/c1/.test(warning)), JSON.stringify(status.warnings));
});

test('without a baseline result, a run that did not complete in between does not hide a regression', (t) => {
  const { repo } = readyProject(t);
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'first version');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'an interrupted run');
  assert.equal(startRun(repo, CHANGE).execution_status, 'error');
  changeCode(repo, BROKEN, 'third version');
  completeReport(repo, fullRun(repo).run_id);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.checks.find((entry) => entry.case === SUCCESS && entry.check === 'c1').runs, ['pass', 'unknown', 'fail']);
  assert.deepEqual(status.regressions, [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assert.equal(status.next.action, 'split_changes');
});

test('workflow check run-eval gives the baseline command --expect with baseline-expectations.json once it exists', (t) => {
  const { repo, root } = readyProject(t);
  const before = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.deepEqual(before.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.match(before.next.note, new RegExp(`kept as \\.genesis/edd/${CHANGE}/baseline-expectations\\.json`));
  const file = writeExpectations(repo, EXPECT);
  assert.equal(file, path.join(root, 'baseline-expectations.json'));
  const after = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(after.next.action, 'record_baseline');
  assert.deepEqual(after.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', file]);
  // The command works as given.
  const base = cli(after.next.command);
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual(base.json.baseline_mismatch, []);
});

test('loop start refuses a baseline that did not behave as declared, and workflow check run-eval gives the baseline command until it is recorded again', (t) => {
  const { repo, root } = readyProject(t);
  const wrong = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { ...EXPECT, [`${SUCCESS}/c1`]: 'fail' }) });
  assert.deepEqual(wrong.baseline_mismatch, [{ case: SUCCESS, check: 'c1', expected: 'fail', got: 'pass' }]);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_mismatch')(error);
    const refusal = error.gaps.find((entry) => entry.code === 'baseline_mismatch');
    assert.equal(refusal.owner, 'agent');
    assert.equal(refusal.route, 'run-eval');
    assert.ok(refusal.message.startsWith(`The baseline ${wrong.run_id} did not behave as declared: ${SUCCESS}/c1 was expected to fail and got pass.`), refusal.message);
    assert.match(refusal.message, /the expectation in baseline-expectations\.json is wrong/);
    assert.match(refusal.message, /this is not the code before the change/);
    return true;
  });
  assert.ok(!existsSync(path.join(root, 'loop.json')));
  const check = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.equal(check.status, 'blocked');
  assert.deepEqual(codes(check.gaps), ['baseline_mismatch']);
  assert.equal(check.next.route, 'run-eval');
  // The stage it routes to records the baseline again, not a head run.
  const route = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(route.status, 'ready');
  assert.equal(route.next.action, 'record_baseline');
  assert.deepEqual(route.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', path.join(root, 'baseline-expectations.json')]);
  assert.ok(route.next.note.startsWith(`The baseline ${wrong.run_id} did not behave as declared: ${SUCCESS}/c1 was expected to fail and got pass.`), route.next.note);
  assert.match(route.next.note, /the expectation in baseline-expectations\.json is wrong/);
  assert.match(route.next.note, /this is not the code before the change/);
  // Without the file, the note says where to keep the expectations.
  rmSync(path.join(root, 'baseline-expectations.json'));
  const bare = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.deepEqual(bare.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.ok(bare.next.note.endsWith(`Add --expect FILE with the expected baseline result of each check, kept as .genesis/edd/${CHANGE}/baseline-expectations.json.`), bare.next.note);

  const right = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(right.baseline_mismatch, []);
  // With the baseline recorded and the code unchanged, the loop starts next.
  const next = checkWorkflow(repo, 'run-eval', CHANGE).next;
  assert.equal(next.action, 'start_loop');
  assert.equal(next.route, 'loop-and-implement');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, right.run_id);
});

test('the Genesis review includes untracked files and names the files that were already uncommitted when the loop started', (t) => {
  const { repo } = readyProject(t, { map: { snapshot_id: 'sha256:loop', analysis_status: 'complete', mode: 'map', flows: [] } });
  writeFileSync(path.join(repo, 'app/wip.txt'), 'work in progress from before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.deepEqual(loop.start_code.uncommitted_files, ['app/wip.txt']);
  // The change adds a module and leaves it untracked.
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  writeFileSync(path.join(repo, 'app/new_module.txt'), 'a new module\n');
  const run = fullRun(repo);
  completeReport(repo, run.run_id, { review: false });

  const { next } = loopStatus(repo, CHANGE);
  assert.equal(next.action, 'final_review');
  const copy = `openspec/changes/${CHANGE}/business-map.json`;
  assert.deepEqual(next.genesis_review, {
    base: loop.base_commit, entries_from: copy,
    prepare: ['map', 'prepare', '--base', loop.base_commit, '--entries-from', copy, '--include-untracked'],
    uncommitted_at_start: ['app/wip.txt'],
  });
  assert.ok(next.message.includes(`\`genesis map prepare --base ${loop.base_commit} --entries-from ${copy} --include-untracked\``), next.message);
  assert.ok(next.message.includes(`already uncommitted when the loop started, so a diff from ${loop.base_commit.slice(0, 7)} also shows their edits from before the loop: app/wip.txt. Tell the reviewer those edits are not part of this change; .genesis/edd/${CHANGE}/loop-start.patch holds them.`), next.message);
});

test('a head run past the loop budget is refused before Harbor, and loop accept of a passing run made within it records the budget and what was used', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance');
  assert.equal(status.loop.exhausted, true);
  // Only the acceptance is left: another head run, partial too, is refused.
  const refusal = refusedBeforeRun(project, {}, 'stop_budget');
  assert.equal(refusal.reason, 'budget_used_up');
  refusedBeforeRun(project, { case: [FAILURE] }, 'stop_budget');
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.ok(!accepted.warnings.some((warning) => warning.includes('was made past the budget')), JSON.stringify(accepted.warnings));
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual(record.budget, { iterations: 1, minutes: 60 });
  assert.equal(record.used.iterations, 1);
});

test('the minutes stop at an acceptance only while it covers the loop: after the code changed they count on, and once they run out run start is refused', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'thread 1' });
  const file = path.join(root, 'accepted.json');
  const record = readJSON(file);
  record.accepted.at = minutesAgo(170);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(180); });
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  near(status.loop.used.minutes, 10);

  editApp(repo, AFTER, 'a tweak after the acceptance');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted.outdated, true);
  near(status.loop.used.minutes, 180);
  assertStopBudget(status.next, repo, 'budget_used_up');
  refusedBeforeRun(project, {}, 'stop_budget');
});

test('after acceptance, a later full run that fails on the accepted code keeps the acceptance outdated and stops the loop as unstable', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  // app/results.json, which the fake verifier records, is left out of the
  // code, so the results change while the code stays the same.
  const exclude = path.join(repo, '.git/info/exclude');
  writeFileSync(exclude, `${existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''}app/results.json\n`);
  git(repo, ['rm', '-q', '--cached', 'app/results.json']);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  assert.equal(accepted.verdict, 'pass');
  completeReport(repo, accepted.run_id);
  acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 1' });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  // Once accepted, head runs go on; a failure of the accepted code counts.
  setResults(repo, BEFORE);
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  setResults(repo, AFTER);
  assert.equal(sameCodeAsRun(repo, accepted), true);
  let status = loopStatus(repo, CHANGE);
  assert.notEqual(status.next.action, 'done', JSON.stringify(status.next));
  assert.equal(status.accepted.outdated, true);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Run ${failed.run_id}, after the user accepted run ${accepted.run_id}, fails`)), JSON.stringify(status.warnings));
  assert.equal(status.stop.action, 'stop_unstable');
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'loop_status');
  refusedBeforeRun(project, {}, 'stop_unstable');

  completeReport(repo, failed.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'stop_unstable', JSON.stringify(status.next));
  assert.deepEqual(status.unstable.map(({ case: id, check, pass, fail }) => ({ case: id, check, pass, fail })),
    [{ case: 'submit-failure-s1', check: 'c1', pass: [accepted.run_id], fail: [failed.run_id] }]);
  assert.match(status.next.message, new RegExp(`The user's acceptance of run ${accepted.run_id} no longer covers the loop\\.$`));
  assert.throws(() => acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('unstable'));
  status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted.outdated, true);
  assert.equal(status.accepted.run_id, accepted.run_id);
});

test('a run during which the code changed asks to run again before its report or anything its results would show, and stops on budget once the runs are used up', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
  const first = startRun(repo, CHANGE);
  assert.equal(first.verdict, 'unverified', JSON.stringify(first));
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'run_again', JSON.stringify(status.next));
  assert.deepEqual(status.next.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.match(status.next.message, new RegExp(`^The code changed while ${first.run_id} executed`));
  // Its results show no regression to split, also once its report is written.
  completeReport(repo, first.run_id);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'run_again');

  const second = startRun(repo, CHANGE);
  assert.equal(second.verdict, 'unverified', JSON.stringify(second));
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status.next, repo);
  assert.match(status.next.message, new RegExp(`The code changed while ${second.run_id} executed`));
});

test('the final review of a loop that started before the first commit points at loop-start.patch, not at a diff', (t) => {
  const { repo } = withBaseline(t, { commit: false });
  startLoop(repo, CHANGE);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id, { review: false });
  const { next } = loopStatus(repo, CHANGE);
  assert.equal(next.action, 'final_review');
  assert.doesNotMatch(next.message, /from none|already uncommitted/);
  assert.ok(next.message.includes(`The loop started before the project's first commit, so no diff shows this change alone: .genesis/edd/${CHANGE}/loop-start.patch holds the files as they were then.`), next.message);
});

test('the final review names at most ten of the files that were already uncommitted when the loop started', (t) => {
  const { repo } = readyProject(t);
  const wip = Array.from({ length: 12 }, (_, index) => `app/wip-${String(index + 1).padStart(2, '0')}.txt`);
  for (const file of wip) writeFileSync(path.join(repo, file), 'work in progress from before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id, { review: false });
  const { next } = loopStatus(repo, CHANGE);
  assert.equal(next.action, 'final_review');
  assert.ok(next.message.includes(`also shows their edits from before the loop: ${wip.slice(0, 10).join(', ')} and 2 more. Tell the reviewer`), next.message);
});

test('done names the commit once every file of the change is in Git, also files forced past a rule that ignores them, and the warning about the rule stays', (t) => {
  const { repo } = inLoop(t);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.genesis/\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  commit(repo, 'Commit everything Git does not ignore');
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const edd = `.genesis/edd/${CHANGE}`;
  git(repo, ['add', '-f', '.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports`]);
  const head = commit(repo, 'Add the change\'s files past the rule');
  assert.equal(git(repo, ['status', '--porcelain']), '');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, head, JSON.stringify(status.next));
  assert.equal(status.next.uncommitted, undefined);
  assert.ok(status.warnings.some((warning) => warning.startsWith('Git ignores files of this change that must be committed: ')), JSON.stringify(status.warnings));
});

test('done does not name a commit while openspec/config.yaml and openspec/genesis.json are not in Git', (t) => {
  const { repo } = inLoop(t);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  git(repo, ['add', '-A']);
  git(repo, ['rm', '-q', '--cached', 'openspec/config.yaml', 'openspec/genesis.json']);
  git(repo, ['commit', '-q', '-m', 'Commit all but the OpenSpec project files']);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, undefined);
  assert.deepEqual(status.next.uncommitted, ['openspec/config.yaml', 'openspec/genesis.json']);
  const all = commit(repo, 'Commit the OpenSpec project files');
  assert.equal(loopStatus(repo, CHANGE).next.commit, all);
});

test('a .gitignore that ignores openspec/ is named with the Spec it keeps out, in eval validate, loop accept and loop status, and keeps done from naming a commit', (t) => {
  const { repo } = inLoop(t);
  writeFileSync(path.join(repo, '.gitignore'), 'openspec/\n');
  git(repo, ['rm', '-r', '-q', '--cached', 'openspec']);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  commit(repo, 'Commit everything Git does not ignore');
  assert.equal(git(repo, ['ls-files', 'openspec']), '');
  const ignored = `Git ignores files of this change that must be committed: openspec/changes/${CHANGE}/, openspec/config.yaml, openspec/genesis.json, openspec/schemas/genesis-spec/ (rule \`openspec/\` in .gitignore:1). Without them a clone has no Spec of this change, OpenSpec project files or Spec schema.`;
  const named = (warnings) => warnings.some((warning) => warning.startsWith(ignored) && warning.includes('remove `openspec/`, or add `!openspec/` to the project\'s .gitignore after it'));
  assert.ok(named(validateEval(repo, CHANGE).warnings), JSON.stringify(validateEval(repo, CHANGE).warnings));
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.ok(named(accepted.warnings), JSON.stringify(accepted.warnings));
  assert.equal(accepted.commit, undefined);
  const status = loopStatus(repo, CHANGE);
  assert.ok(named(status.warnings), JSON.stringify(status.warnings));
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, undefined);
  assert.deepEqual(status.next.uncommitted, [`.genesis/edd/${CHANGE}/accepted.json`, `openspec/changes/${CHANGE}/`, 'openspec/config.yaml', 'openspec/genesis.json', 'openspec/schemas/genesis-spec/']);
});

test('a global excludes file whose path holds a colon is read as it is: a `!` rule there keeps a file in Git, and each rule is named by its own line', (t) => {
  const tools = useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  const home = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const excludes = path.join(home, 'C:', 'ignore');
  mkdirSync(path.dirname(excludes));
  writeFileSync(excludes, '*.json\n!accepted.json\n');
  writeFileSync(tools.gitConfig, `[core]\n\texcludesFile = "${excludes}"\n`);
  const { paths, warning } = ignoredArtifacts(repo, CHANGE);
  assert.deepEqual(paths, ['openspec/genesis.json', `.genesis/edd/${CHANGE}/baseline-expectations.json`, `.genesis/edd/${CHANGE}/review.json`, `.genesis/edd/${CHANGE}/confirmed.json`]);
  assert.ok(warning.includes(`(rule \`*.json\` in ${excludes}:1)`), warning);
});

test('done names the commit while a project-wide rule such as `*.log` or `.env` keeps a file inside the change\'s folders out of Git, and does not offer that file', (t) => {
  const { repo } = inLoop(t);
  writeFileSync(path.join(repo, '.gitignore'), '*.log\n.env\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const all = commit(repo, 'Commit the change and its files');
  const edd = `.genesis/edd/${CHANGE}`;
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, 'tests/debug.log'), 'output of a local try\n');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, '.env'), 'TOKEN=synthetic-test-value\n');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, all, JSON.stringify(status.next));
  assert.equal(status.next.uncommitted, undefined);
  assert.doesNotMatch(status.next.message, /debug\.log|\.env/);
  assert.ok(!status.warnings.some((warning) => warning.startsWith('Git ignores')), JSON.stringify(status.warnings));
});

test('new files in a folder of the change that Git partly holds are offered for commit while a rule ignores that folder, and a leftover there is not', (t) => {
  const { repo } = inLoop(t);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const all = commit(repo, 'Commit the change and its files');
  assert.equal(loopStatus(repo, CHANGE).next.commit, all);
  // The rule comes after the commit, so Git still holds what it had.
  writeFileSync(path.join(repo, '.git/info/exclude'), '.genesis/*\n');
  const edd = `.genesis/edd/${CHANGE}`;
  mkdirSync(path.join(repo, edd, 'evals/new-case/tests'), { recursive: true });
  writeFileSync(path.join(repo, edd, 'evals/new-case/tests/test.sh'), 'exit 0\n');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, 'tests/extra.txt'), 'more\n');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, '.DS_Store'), '');
  writeFileSync(path.join(repo, edd, 'reports/notes.md'), 'notes\n');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, undefined, JSON.stringify(status.next));
  assert.deepEqual(status.next.uncommitted, [`${edd}/evals/new-case/`, `${edd}/evals/${FAILURE}/tests/extra.txt`, `${edd}/reports/notes.md`]);
  assert.ok(status.warnings.some((warning) => warning.startsWith('Git ignores files of this change that must be committed: ')
    && warning.includes('add `!.genesis/edd/` after `.genesis/*`')), JSON.stringify(status.warnings));
});

test('an untracked folder in the change\'s folders that holds only leftovers keeps done naming the commit, and is listed once it holds a file of the change', (t) => {
  const { repo } = inLoop(t);
  writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const all = commit(repo, 'Commit the change and its files');
  const extra = path.join(repo, `.genesis/edd/${CHANGE}/evals`, FAILURE, 'extra');
  mkdirSync(extra);
  writeFileSync(path.join(extra, '.DS_Store'), '');
  writeFileSync(path.join(extra, 'notes.md~'), '');
  writeFileSync(path.join(extra, 'try.log'), 'ignored by the project\n');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.next.commit, all, JSON.stringify(status.next));
  assert.equal(status.next.uncommitted, undefined);

  writeFileSync(path.join(extra, 'seed.txt'), 'seed\n');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.commit, undefined);
  assert.deepEqual(status.next.uncommitted, [`.genesis/edd/${CHANGE}/evals/${FAILURE}/extra/`]);
});

test('a run during which the code changed is never the earlier result a regression, lost progress or a stuck loop is measured against', (t) => {
  const project = inLoop(t, { iterations: 10 });
  const { repo, tools } = project;
  const moved = () => {
    harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
    const run = startRun(repo, CHANGE);
    tools.harbor(true);
    assert.equal(runRecord(project, run).code_changed_during_run, true);
    completeReport(repo, run.run_id);
    return run;
  };
  // A pass, a moved run that fails, then a failure: the check passed in the
  // last run that belongs to one version of the code, so progress was lost.
  changeCode(repo, AFTER, 'fix the failure notice');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, BEFORE, 'undo the fix during a run');
  moved();
  changeCode(repo, BEFORE, 'undo the fix');
  completeReport(repo, fullRun(repo).run_id);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.lost_progress, [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure' }]);
  assert.equal(status.stuck, false);

  // While a moved run is the latest, it shows no regression either.
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice during a run');
  harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
  startRun(repo, CHANGE);
  tools.harbor(true);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions, []);
  assert.deepEqual(status.lost_progress, []);
  assert.equal(status.stuck, false);

  // A failure, moved runs, one of them passing, then the same failure on
  // other code: the loop is stuck, for good, and the moved pass is no
  // progress that was lost.
  changeCode(repo, AFTER, 'fix the failure notice during a run');
  moved();
  changeCode(repo, BEFORE, 'try another way');
  completeReport(repo, fullRun(repo).run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.lost_progress, []);
  assert.equal(status.stuck, true);
  assert.equal(status.next.action, 'stop_stuck');
  assert.match(status.next.message, /failed in \S+ and \S+ \(the 2 runs between them are not compared: the code changed while they ran\) on different code/);
  changeCode(repo, AFTER, 'another change after the stop');
  assert.equal(loopStatus(repo, CHANGE).next.action, 'stop_stuck');
  refusedBeforeRun(project, {}, 'stop_stuck');
});

test('a `.genesis/*` rule with no `!.genesis/edd/` after it is told to add one, and a `.genesis/**` rule to become `.genesis/*`', (t) => {
  useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  const exclude = path.join(repo, '.git/info/exclude');
  writeFileSync(exclude, '.genesis/*\n');
  let { warning } = ignoredArtifacts(repo, CHANGE);
  assert.ok(warning.endsWith('Change the rule so these files are committed: add `!.genesis/edd/` after `.genesis/*`, or ignore only `.genesis/out/` instead.'), warning);
  for (const rule of ['.genesis/**', '/.genesis/**']) {
    writeFileSync(exclude, `${rule}\n`);
    ({ warning } = ignoredArtifacts(repo, CHANGE));
    assert.ok(warning.endsWith(`Change the rule so these files are committed: instead of \`${rule}\`, ignore \`.genesis/*\` and add \`!.genesis/edd/\` after it, or ignore only \`.genesis/out/\`.`), warning);
  }
  writeFileSync(exclude, '.genesis/*\n!.genesis/edd/\n');
  assert.equal(ignoredArtifacts(repo, CHANGE).warning, null);
});

test('code changed while one package runs and put back before the run ends gives no pass, and the run cannot be accepted', (t) => {
  const { repo, tools } = inLoop(t);
  // The code fixes the failed submission and breaks the successful one, but
  // while the successful one runs, app/results.json, which is committed code,
  // says it passes; it is put back afterwards.
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  harborWhile(t, SUCCESS, 'app/results.json', `${JSON.stringify(AFTER, null, 2)}\n`);
  const run = startRun(repo, CHANGE);
  tools.harbor(true);
  const { run: record } = readRecord(run);
  assert.equal(run.verdict, 'unverified', JSON.stringify(run));
  assert.deepEqual([record.code_changed_during_run, record.code_changed_during], [true, [SUCCESS]]);
  assert.ok(run.warnings.includes('The code changed while this run executed, so its results do not belong to one version of the code. Do not edit the code during a run; run again once it is stable.'), JSON.stringify(run.warnings));
  // The code is the run's again, yet the run is no pass of it.
  assert.ok(sameCodeAsRun(repo, run));
  assert.equal(loopStatus(repo, CHANGE).next.action, 'run_again');
  completeReport(repo, run.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('not_passing')(error);
    refusedWith('code_changed_during_run')(error);
    return true;
  });
  // Run again on stable code: the failure of that code shows.
  assert.equal(fullRun(repo).verdict, 'fail');
});

test('a package file changed while another package runs and put back before the run ends gives no pass', (t) => {
  const { repo, root, tools } = inLoop(t);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const dockerfile = path.join(root, 'evals', SUCCESS, 'environment/Dockerfile');
  const kept = readFileSync(dockerfile, 'utf8');
  harborWhile(t, FAILURE, path.relative(repo, dockerfile), `${kept}RUN true\n`);
  const run = startRun(repo, CHANGE);
  tools.harbor(true);
  assert.equal(readFileSync(dockerfile, 'utf8'), kept);
  const { run: record } = readRecord(run);
  assert.deepEqual([run.verdict, record.packages_changed_during_run, record.code_changed_during_run], ['unverified', true, false]);
  assert.deepEqual(record.eval_snapshot.changed_during_run, [SUCCESS]);
  assert.ok(run.warnings.includes(`The eval packages changed while this run executed: ${SUCCESS} (${SUCCESS}/environment/Dockerfile). Its results do not belong to one version of them. Do not edit packages or the project kit during a run; prove them again with \`eval check\` and run again.`), JSON.stringify(run.warnings));
  // The package is as the user confirmed it, so the loop goes on: the run is made again.
  assert.equal(loopStatus(repo, CHANGE).next.action, 'run_again');
  assert.equal(fullRun(repo).verdict, 'pass');
});
