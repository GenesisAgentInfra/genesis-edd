// Loop tests: acceptance and what it still covers, the final review, what has
// to be committed, and ignored records.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, ignoredArtifacts, projectRoot, readJSON } from '../src/project.js';
import { newEval, validateEval } from '../src/eval.js';
import { startRun } from '../src/run.js';
import { acceptLoop, loopStatus, reportGaps, writeReport } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, BEFORE, CHANGE, cli, commit, commitConfirmation, confirmChecks, git, harborThen, harborWhile, readRecord, readyProject, setResults, useFakeTools, writeExpectations,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord, FAILURE, SUCCESS,
  editLoop, minutesAgo, near, assertStopBudget, editApp, sameCodeAsRun, refusedBeforeRun, assertEnded, reviewRun, gapOf, startLoop,
  actionOf, assertGapShape, assertSuggestion,
} from './helpers/loop.js';

// --- Acceptance that stops covering the loop, the final review, what still
// has to be committed, ignored records, comparisons across runs that could not
// tell, the baseline a loop starts on, the Genesis review and the budget. ---

// The full head run of a workflow status: run start with neither --baseline
// nor --trial.
const headRunAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && !entry.command.includes('--baseline') && !entry.command.includes('--trial'));
// The baseline that runs: run start --baseline without --at-start or --unavailable.
const baselineAction = (status) => status.actions.find((entry) => entry.command[0] === 'run' && entry.command[1] === 'start'
  && entry.command.includes('--baseline') && !entry.command.includes('--at-start') && !entry.command.includes('--unavailable'));
const EXPECTATIONS = `.genesis/edd/${CHANGE}/baseline-expectations.json`;
// A check of a regression or lost progress, without the runs and files it names.
const brief = ({ case: id, check, intent }) => ({ case: id, check, intent });
// The user's acceptance of a passing run, after a final review of its code.
function reviewAndAccept(project, run, ref = 'thread 1') {
  reviewRun(project, run.run_id);
  return acceptLoop(project.repo, CHANGE, { run: run.run_id, by: 'Dana', ref });
}

test('after acceptance, code that changed is no longer done: loop status suggests a run, the acceptance is outdated, and a passing run of that code needs a final review and the user\'s acceptance again', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  reviewAndAccept(project, first);
  const earlier = readJSON(path.join(root, 'accepted.json'));
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  editApp(repo, AFTER, 'a tweak after the acceptance');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'live');
  assert.deepEqual([status.situation.code, status.situation.run_id, status.situation.accepted_run], ['code_moved', first.run_id, true], JSON.stringify(status.situation));
  assert.match(status.situation.message, new RegExp(`The code changed after ${first.run_id}, the run the user accepted, so the acceptance no longer covers it`));
  // Nothing accepted covers the code now, so nothing is offered for commit.
  assert.equal(status.situation.needs_user, undefined);
  assert.equal(status.situation.committed, undefined);
  assert.equal(status.accepted, false);
  assert.equal(status.acceptance.outdated, true);
  assert.ok(status.warnings.includes(`The code changed after the accepted run ${first.run_id}. The acceptance covers that run's code only.`), JSON.stringify(status.warnings));
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo]);
  let check = workflowStatus(repo, CHANGE);
  assert.deepEqual(check.suggestion.command, ['run', 'start', CHANGE, '--repo', repo]);
  assert.deepEqual([headRunAction(check).allowed, headRunAction(check).in_loop], [true, true]);

  const second = fullRun(repo);
  assert.equal(second.verdict, 'pass');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id], ['acceptable', second.run_id]);
  // The review of the accepted code does not cover the code now.
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  assertSuggestion(status, ['loop', 'review', CHANGE, '--repo', repo, '--run', second.run_id]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: second.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('review_missing'));
  reviewRun(project, second.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assertSuggestion(status, ['loop', 'accept', CHANGE, '--repo', repo, '--run', second.run_id]);
  assert.equal(status.acceptance.outdated, true);
  assert.ok(status.warnings.includes(`The code changed after the accepted run ${first.run_id}. The acceptance covers that run's code only.`), JSON.stringify(status.warnings));
  acceptLoop(repo, CHANGE, { run: second.run_id, by: 'Dana', ref: 'thread 2' });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.equal(record.run_id, second.run_id);
  assert.deepEqual(record.earlier, [earlier]);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.run_id], ['done', 'accepted', second.run_id]);
  assert.equal(status.acceptance.outdated, undefined);
  assert.equal(status.suggestion, null);
  check = workflowStatus(repo, CHANGE);
  assert.equal(check.layers.loop.phase, 'done');
  // Head runs go on after an acceptance, as comparisons outside the loop.
  assert.equal(headRunAction(check).in_loop, false);
});

test('after acceptance, a later full run that fails lists the checks the accepted run passed under regressions, and that run cannot be accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const accepted = fullRun(repo);
  reviewAndAccept(project, accepted);

  // The failed submission sends the success notice again, as before the change.
  changeCode(repo, BEFORE, 'one more small tweak');
  const later = fullRun(repo);
  assert.equal(later.verdict, 'fail');
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Run ${later.run_id}, after the user accepted run ${accepted.run_id}, fails`)), JSON.stringify(status.warnings));
  // Without the acceptance this would be lost progress; it breaks what the user accepted.
  assert.deepEqual(status.regressions.map(brief), [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure' }]);
  const [regression] = status.regressions;
  assert.deepEqual([regression.failing_run, regression.last_passed, regression.accepted_run], [later.run_id, accepted.run_id, true]);
  assert.ok(regression.files_changed.includes('app/handler.txt'), JSON.stringify(regression.files_changed));
  assert.deepEqual(status.lost_progress, []);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'regression']);
  assert.deepEqual(status.situation.regressions, status.regressions);
  assert.equal(status.acceptance.outdated, true);
  assert.equal(status.accepted, false);
  assert.equal(headRunAction(workflowStatus(repo, CHANGE)).allowed, true);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: later.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('not_passing'));
});

test('a head run writes its report itself and the report gates nothing: acceptance waits for a final review recorded with loop review, and answers that leave something out are refused', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const file = path.join(root, 'reports', `${run.run_id}.md`);
  const report = readFileSync(file, 'utf8');
  for (const section of ['Result', 'Changes', 'Notes']) assert.match(report, new RegExp(`^## ${section}$`, 'm'));
  assert.doesNotMatch(report, /^## Review/m);
  assert.match(report, /· tier `light`$/m);
  // Asking for it again keeps the report as it is.
  assert.deepEqual(writeReport(repo, CHANGE, { run: run.run_id }), { file, created: false, written: ['Result', 'Changes'] });
  assert.deepEqual(reportGaps(repo, CHANGE, { run_id: run.run_id }), []);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.runs.find((entry) => entry.run_id === run.run_id).report, 'written');

  // A review written into the report is no final review.
  writeFileSync(file, `${report}\n## Review\n\nA fresh reviewer compared the whole diff with the Spec and found nothing to change.\n`);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable');
  assert.deepEqual(codes(status.gates.accept), ['review_missing']);
  assertGapShape(status.gates.accept[0], { code: 'review_missing', owner: 'agent', layer: 'loop', run: run.run_id });
  assert.deepEqual([status.review.run_id, status.review.satisfied, status.review.recorded], [run.run_id, false, []]);
  assert.deepEqual(status.review.flips.map(({ case: id, check }) => ({ case: id, check })), [{ case: FAILURE, check: 'c1' }]);
  assert.deepEqual(status.obligations.find((entry) => entry.kind === 'review'), { kind: 'review', run_id: run.run_id, code_digest: status.review.code_digest, recorded: false,
    checked_by_cli: 'that a review of this code was recorded after the run it reviewed' });
  assertSuggestion(status, ['loop', 'review', CHANGE, '--repo', repo, '--run', run.run_id]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'chat' }), (error) => {
    assertGapShape(gapOf(error, 'review_missing'), { owner: 'agent', layer: 'loop' });
    return true;
  });

  // A flip left unexplained, or a finding without its detail, is no review.
  assert.throws(() => reviewRun(project, run.run_id, { flips: [] }), (error) => {
    const incomplete = assertGapShape(gapOf(error, 'review_answers_incomplete'), { owner: 'agent', layer: 'loop' });
    assert.match(incomplete.message, new RegExp(`no explained_by for ${FAILURE}/c1, which went from not passing to passing against the baseline`));
    return true;
  });
  assert.throws(() => reviewRun(project, run.run_id, { side_effects: { found: true, detail: null } }), (error) => {
    assert.match(gapOf(error, 'review_answers_incomplete').message, /side_effects\.detail is empty although side_effects\.found is true/);
    return true;
  });
  assert.deepEqual(loopStatus(repo, CHANGE).review.recorded, []);
  const reviewed = reviewRun(project, run.run_id);
  assert.deepEqual([reviewed.review.reviewer, reviewed.covers, reviewed.findings], ['subagent', [run.run_id], []]);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.gates.accept, []);
  assert.equal(status.review.satisfied, true);
  assertSuggestion(status, ['loop', 'accept', CHANGE, '--repo', repo, '--run', run.run_id]);
});

test('once accepted, the commit facts name the change\'s own files while they are not committed, and the commit once they are', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  writeFileSync(path.join(repo, 'openspec/changes', CHANGE, 'design-notes.md'), '# Notes\n');
  const run = fullRun(repo);
  reviewAndAccept(project, run);

  git(repo, ['add', 'app']);
  git(repo, ['commit', '-q', '-m', 'Commit only the application']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const edd = `.genesis/edd/${CHANGE}`;
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  // The accepted code is committed; the change's own files are not.
  assert.deepEqual([status.situation.committed, status.situation.code_commit], [false, head]);
  assert.deepEqual(status.situation.uncommitted, ['.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports/`,
    `openspec/changes/${CHANGE}/design-notes.md`]);
  // Decisions and run records stay on this machine, so they are never offered.
  assert.ok(existsSync(path.join(repo, edd, 'decisions.jsonl')));
  assert.deepEqual(status.situation.needs_user.map((entry) => entry.decision), ['commit, merge or pull request']);
  assert.deepEqual(status.obligations.filter((entry) => entry.kind === 'consent').map((entry) => entry.decision), ['commit, merge or pull request']);

  const all = commit(repo, 'Commit the evals, reports and acceptance');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.committed, status.situation.code_commit, status.situation.uncommitted], [true, all, []]);
  assert.deepEqual(status.situation.needs_user, [{ decision: 'merge or pull request',
    why: `The accepted change is committed in ${all.slice(0, 7)}; the user decides whether to merge it or open a pull request.` }]);
  assert.deepEqual(status.obligations, []);

  // What Finder or an editor leaves beside the files is not part of the change.
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, '.DS_Store'), '');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, 'tests/checks.json.swp'), '');
  writeFileSync(path.join(repo, edd, 'reports', 'notes.md~'), '');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.committed, status.situation.code_commit, status.situation.uncommitted], [true, all, []], JSON.stringify(status.situation));
});

test('a .gitignore that ignores .genesis/ is named in eval new, eval validate, loop status and loop accept, and keeps the accepted change from counting as committed', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.genesis/\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const edd = `.genesis/edd/${CHANGE}`;
  const ignored = `Git ignores files of this change that must be committed: .genesis/edd/.gitignore, .genesis/edd/harness/, ${edd}/evals/, ${edd}/spec-drafts/, ${edd}/baseline-expectations.json, ${edd}/review.json, ${edd}/confirmed.json, ${edd}/reports/, ${edd}/accepted.json (rule \`.genesis/\` in .gitignore:2).`;
  const named = (warnings) => warnings.some((warning) => warning.startsWith(ignored) && warning.includes('ignore `.genesis/*` and add `!.genesis/edd/` after it, or ignore only `.genesis/out/`'));
  assert.ok(named(validateEval(repo, CHANGE).warnings), JSON.stringify(validateEval(repo, CHANGE).warnings));
  assert.ok(named(newEval(repo, CHANGE).warnings));
  assert.ok(named(cli(['eval', 'validate', CHANGE, '--repo', repo]).json.warnings));
  assert.ok(named(loopStatus(repo, CHANGE).warnings));

  const run = fullRun(repo);
  commit(repo, 'Commit everything Git does not ignore');
  reviewRun(project, run.run_id);
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.ok(named(accepted.warnings), JSON.stringify(accepted.warnings));
  assert.equal(accepted.commit, undefined);
  assert.equal(accepted.committed, false);
  // The packages were committed before the rule; only what Git does not hold is listed.
  assert.deepEqual(accepted.uncommitted, ['.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports/`]);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.uncommitted], [false, accepted.uncommitted]);
  assert.deepEqual(status.situation.needs_user.map((entry) => entry.decision), ['commit, merge or pull request']);

  // Ignoring Genesis's own output only is fine.
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.genesis/*\n!.genesis/edd/\n');
  assert.ok(!named(validateEval(repo, CHANGE).warnings));
  assert.deepEqual(validateEval(repo, CHANGE).warnings.filter((warning) => warning.startsWith('Git ignores')), []);
});

test('once the code changed after the passing run, neither a final review nor acceptance is suggested: loop status suggests a run, and acceptance is refused', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assertSuggestion(loopStatus(repo, CHANGE), ['loop', 'review', CHANGE, '--repo', repo, '--run', run.run_id]);

  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'a fix from the review\n');
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id, status.situation.accepted_run], ['code_moved', run.run_id, false]);
  assert.equal(status.situation.message, `The code changed after ${run.run_id}; that run says nothing about the code now.`);
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo]);
  assert.deepEqual(codes(status.gates.accept), ['nothing_to_accept']);
  rmSync(scratch);
  reviewRun(project, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.gates.accept], ['acceptable', []]);

  writeFileSync(scratch, 'an edit before the user answered\n');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'code_moved');
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'chat' }), (error) => {
    assertGapShape(gapOf(error, 'code_changed'), { owner: 'agent', layer: 'code', run: run.run_id });
    return true;
  });
});

test('a run that could not tell in between does not hide lost progress: each check compares with its latest pass or fail', (t) => {
  const { repo } = inLoop(t);
  changeCode(repo, AFTER, 'fix the failure notice');
  const passed = fullRun(repo);
  changeCode(repo, { ...AFTER, [FAILURE]: { c1: 'unknown' } }, 'a run whose evidence could not tell');
  const unclear = fullRun(repo);
  assert.equal(unclear.verdict, 'unverified');
  changeCode(repo, BEFORE, 'undo the fix by accident');
  const failed = fullRun(repo);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.checks.find((entry) => entry.case === FAILURE).runs, ['pass', 'unknown', 'fail']);
  assert.deepEqual(status.lost_progress.map(brief), [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure' }]);
  assert.deepEqual([status.lost_progress[0].failing_run, status.lost_progress[0].last_passed], [failed.run_id, passed.run_id]);
  assert.ok(status.warnings.includes(`Passed in an earlier run and fails again: ${FAILURE}/c1 (passed in ${passed.run_id}).`), JSON.stringify(status.warnings));
  assert.deepEqual(status.regressions, []);
});

test('without a baseline result, a run that did not complete in between does not hide a regression', (t) => {
  // A baseline that records nothing could run is of the full tier.
  const { repo } = readyProject(t, { tier: 'full' });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'first version');
  const first = fullRun(repo);
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'an interrupted run');
  assert.equal(startRun(repo, CHANGE).execution_status, 'error');
  changeCode(repo, BROKEN, 'third version');
  const third = fullRun(repo);

  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.checks.find((entry) => entry.case === SUCCESS && entry.check === 'c1').runs, ['pass', 'unknown', 'fail']);
  assert.deepEqual(status.regressions.map(brief), [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assert.deepEqual([status.regressions[0].failing_run, status.regressions[0].last_passed], [third.run_id, first.run_id]);
  assert.equal(status.situation.code, 'regression');
});

test('workflow status offers the baseline with --expect and baseline-expectations.json once that file exists', (t) => {
  const { repo, root } = readyProject(t);
  let status = workflowStatus(repo, CHANGE);
  let base = baselineAction(status);
  assert.deepEqual(base.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.deepEqual([base.allowed, base.needed], [true, true]);
  assert.ok(base.satisfies.includes('expectations_before_results'), JSON.stringify(base));
  assert.equal(status.layers.baseline.expectations_file, false);
  assert.deepEqual(codes(status.layers.baseline.gaps), ['baseline_missing']);
  const file = writeExpectations(repo, EXPECT);
  assert.equal(file, path.join(root, 'baseline-expectations.json'));
  status = workflowStatus(repo, CHANGE);
  base = baselineAction(status);
  assert.deepEqual(base.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', EXPECTATIONS]);
  assert.equal(status.layers.baseline.expectations_file, true);
  assert.deepEqual(status.suggestion.command, base.command);
  // From the project folder, the command works as given.
  const ran = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), ...base.command], { cwd: repo, encoding: 'utf8', env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout).baseline_mismatch, []);
});

test('the baseline command workflow status offers works from any working directory', (t) => {
  const { repo, tools } = readyProject(t);
  writeExpectations(repo, EXPECT);
  const { command } = baselineAction(workflowStatus(repo, CHANGE));
  const ran = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), ...command], { cwd: tools.directory, encoding: 'utf8', env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout).baseline_mismatch, []);
});

test('loop start refuses a baseline that did not behave as declared, and workflow status offers the baseline until it is recorded again', (t) => {
  const { repo, root } = readyProject(t);
  const wrong = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { ...EXPECT, [`${SUCCESS}/c1`]: 'fail' }) });
  assert.deepEqual(wrong.baseline_mismatch, [{ case: SUCCESS, check: 'c1', expected: 'fail', got: 'pass' }]);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    blockedWith('baseline_mismatch')(error);
    const refusal = assertGapShape(gapOf(error, 'baseline_mismatch'), { owner: 'agent', layer: 'baseline' });
    assert.ok(refusal.message.startsWith(`The baseline ${wrong.run_id} did not behave as declared: ${SUCCESS}/c1 was expected to fail and got pass.`), refusal.message);
    assert.match(refusal.message, /the expectation in baseline-expectations\.json is wrong/);
    assert.match(refusal.message, /the code it ran on is not the code before the change/);
    return true;
  });
  assert.ok(!existsSync(path.join(root, 'loop.json')));
  let status = workflowStatus(repo, CHANGE);
  const mismatch = status.layers.baseline.gaps.find((entry) => entry.code === 'baseline_mismatch');
  assertGapShape(mismatch, { owner: 'agent', layer: 'baseline', run: wrong.run_id, mismatch: wrong.baseline_mismatch });
  assert.ok(codes(status.gaps).includes('baseline_mismatch'));
  assert.deepEqual(status.layers.baseline.recorded.mismatch, wrong.baseline_mismatch);
  const start = actionOf(status, 'loop', 'start');
  assert.equal(start.allowed, false);
  assert.ok(start.blocked_by.includes('baseline_mismatch'), JSON.stringify(start));
  // The baseline is offered again, not a head run.
  const base = baselineAction(status);
  assert.deepEqual([base.allowed, base.needed], [true, true]);
  assert.deepEqual(base.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--expect', EXPECTATIONS]);
  assert.deepEqual(status.suggestion.command, base.command);

  const right = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(right.baseline_mismatch, []);
  // With the baseline recorded and the code unchanged, the loop can start on
  // the user's consent.
  status = workflowStatus(repo, CHANGE);
  assert.deepEqual(status.layers.baseline.gaps, []);
  const ready = actionOf(status, 'loop', 'start');
  assert.deepEqual([ready.allowed, ready.by], [true, 'user'], JSON.stringify(ready));
  assert.ok(ready.needs.includes('user consent: starting a loop, recorded with --by and --ref'), JSON.stringify(ready.needs));
  assert.equal(startLoop(repo, CHANGE).loop.baseline, right.run_id);
});

test('the final review offers a Genesis review that includes untracked files, and names the files that were already uncommitted when the loop started', (t) => {
  const project = readyProject(t, { map: { snapshot_id: 'sha256:loop', analysis_status: 'complete', mode: 'map', flows: [] } });
  const { repo } = project;
  writeFileSync(path.join(repo, 'app/wip.txt'), 'work in progress from before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.deepEqual(loop.start_code.uncommitted_files, ['app/wip.txt']);
  // The change adds a module and leaves it untracked.
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  writeFileSync(path.join(repo, 'app/new_module.txt'), 'a new module\n');
  const run = fullRun(repo);

  const { review, situation } = loopStatus(repo, CHANGE);
  assert.equal(situation.code, 'acceptable');
  assert.equal(review.run_id, run.run_id);
  const copy = `openspec/changes/${CHANGE}/business-map.json`;
  assert.deepEqual(review.genesis_review, {
    base: loop.base_commit, entries_from: copy,
    prepare: ['map', 'prepare', '--base', loop.base_commit, '--entries-from', copy, '--include-untracked'],
    scope: 'project', scope_limited: false, uncommitted_at_start: ['app/wip.txt'], optional: true,
  });
  // A diff from the loop's commit also shows the edits made before the loop;
  // loop-start.patch holds them.
  assert.deepEqual([review.uncommitted_at_start, review.start_patch], [['app/wip.txt'], `.genesis/edd/${CHANGE}/loop-start.patch`]);
  assert.ok(existsSync(path.join(repo, review.start_patch)));
});

test('a head run past the loop budget is refused before Harbor, and loop accept of a passing run made within it records the budget and what was used', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  const status = loopStatus(repo, CHANGE);
  // Only the final review and the acceptance are left.
  assert.deepEqual([status.phase, status.situation.code, status.loop.exhausted], ['closing', 'acceptable', true]);
  assertGapShape(status.gates.head_run, { code: 'stop_budget', owner: 'user', layer: 'loop', reason: 'budget_used_up' });
  // Another head run, partial too, is refused.
  const refusal = refusedBeforeRun(project, {}, 'stop_budget');
  assert.equal(refusal.reason, 'budget_used_up');
  refusedBeforeRun(project, { case: [FAILURE] }, 'stop_budget');
  reviewRun(project, run.run_id);
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.ok(!accepted.warnings.some((warning) => warning.includes('was made past the budget')), JSON.stringify(accepted.warnings));
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.deepEqual([record.budget.iterations, record.budget_original.iterations, record.budget_revisions], [1, 1, []]);
  assert.equal(record.used.iterations, 1);
  assert.equal(typeof record.used.run_minutes, 'number');
  assert.deepEqual(record.budget_by_run.map((entry) => entry.run_id), [run.run_id]);
});

test('run minutes leave out the time the user takes; a budget recorded before run minutes stops its clock at an acceptance only while it covers the loop', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const first = fullRun(repo);
  // Three hours of waiting are no run minutes.
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(180); });
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.exhausted, false);
  assert.ok(status.loop.used.run_minutes < 1, JSON.stringify(status.loop.used));
  assert.equal(status.situation.code, 'acceptable');

  reviewAndAccept(project, first);
  const file = path.join(root, 'accepted.json');
  const record = readJSON(file);
  record.accepted.at = minutesAgo(170);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  // A budget of 60 minutes on the clock, as loop.json kept it before run minutes.
  editLoop(project, (loop) => { loop.budget = { iterations: 5, minutes: 60 }; });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  near(status.loop.used.minutes, 10);

  editApp(repo, AFTER, 'a tweak after the acceptance');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.acceptance.outdated, true);
  near(status.loop.used.minutes, 180);
  assertStopBudget(status, 'budget_used_up');
  // The loop ended without an acceptance that covers it, so the change is
  // locked: a head run waits for the user's new loop or new budget.
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_budget');
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
  reviewAndAccept(project, accepted);
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  // Once accepted, head runs go on; a failure of the accepted code counts.
  setResults(repo, BEFORE);
  const failed = fullRun(repo);
  assert.equal(failed.verdict, 'fail');
  setResults(repo, AFTER);
  assert.equal(sameCodeAsRun(repo, accepted), true);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'stop_unstable');
  assert.equal(status.accepted, false);
  assert.equal(status.acceptance.outdated, true);
  assert.equal(status.acceptance.run_id, accepted.run_id);
  assert.ok(status.warnings.some((warning) => warning.startsWith(`Run ${failed.run_id}, after the user accepted run ${accepted.run_id}, fails`)
    && warning.includes('A failure of the accepted code always counts, so no run of it can be accepted again.')), JSON.stringify(status.warnings));
  assert.deepEqual(status.unstable.map(({ case: id, check, pass, fail }) => ({ case: id, check, pass, fail })),
    [{ case: FAILURE, check: 'c1', pass: [accepted.run_id], fail: [failed.run_id] }]);
  assert.deepEqual(status.ended.checks, [{ case: FAILURE, check: 'c1', pass: [accepted.run_id], fail: [failed.run_id] }]);
  const check = workflowStatus(repo, CHANGE);
  assert.ok(headRunAction(check).blocked_by.includes('change_locked'), JSON.stringify(headRunAction(check)));
  assert.equal(check.layers.loop.change_lock.reason, 'stop_unstable');
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_unstable');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: accepted.run_id, by: 'Dana', ref: 'thread 2' }), (error) => {
    refusedWith('unstable')(error);
    refusedWith('stop_unstable')(error);
    return true;
  });
});

test('a run during which the code changed is followed by a suggested run, also once its report is written, and the loop stops on budget once the runs are used up', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  changeCode(repo, BROKEN, 'Fix the failure notice and break the success notice');
  harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
  const first = startRun(repo, CHANGE);
  assert.equal(first.verdict, 'unverified', JSON.stringify(first));
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.run_id, status.situation.code_changed, status.situation.packages_changed], ['run_not_settled', first.run_id, true, false]);
  assert.match(status.situation.message, new RegExp(`^The code changed while ${first.run_id} executed`));
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo]);
  // Its results show no regression, also once a note is added to its report.
  assert.deepEqual(status.regressions, []);
  completeReport(repo, first.run_id);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.regressions], ['run_not_settled', []]);

  const second = startRun(repo, CHANGE);
  assert.equal(second.verdict, 'unverified', JSON.stringify(second));
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.ended.situation.code, 'run_not_settled');
  assert.match(status.ended.situation.message, new RegExp(`The code changed while ${second.run_id} executed`));
});

test('the final review of a loop that started before the first commit names loop-start.patch, which holds the start code, and offers no Genesis review', (t) => {
  const { repo } = withBaseline(t, { commit: false });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.base_commit, null);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  const { review, situation } = loopStatus(repo, CHANGE);
  assert.equal(situation.code, 'acceptable');
  assert.equal(review.run_id, run.run_id);
  assert.equal(review.genesis_review, undefined);
  assert.equal(review.start_patch, `.genesis/edd/${CHANGE}/loop-start.patch`);
  assert.ok(existsSync(path.join(repo, review.start_patch)));
  assert.ok(review.uncommitted_at_start.includes('app/results.json'), JSON.stringify(review.uncommitted_at_start));
});

test('the final review names every file that was already uncommitted when the loop started', (t) => {
  const { repo } = readyProject(t);
  const wip = Array.from({ length: 12 }, (_, index) => `app/wip-${String(index + 1).padStart(2, '0')}.txt`);
  for (const file of wip) writeFileSync(path.join(repo, file), 'work in progress from before the change\n');
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  fullRun(repo);
  const { review, situation } = loopStatus(repo, CHANGE);
  assert.equal(situation.code, 'acceptable');
  assert.deepEqual(review.uncommitted_at_start, wip);
  assert.equal(review.start_patch, `.genesis/edd/${CHANGE}/loop-start.patch`);
});

test('the accepted change counts as committed once every file of it is in Git, also files forced past a rule that ignores them, and the warning about the rule stays', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.genesis/\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  commit(repo, 'Commit everything Git does not ignore');
  reviewAndAccept(project, run);
  const edd = `.genesis/edd/${CHANGE}`;
  git(repo, ['add', '-f', '.genesis/edd/.gitignore', `${edd}/accepted.json`, `${edd}/baseline-expectations.json`, `${edd}/reports`]);
  const head = commit(repo, 'Add the change\'s files past the rule');
  assert.equal(git(repo, ['status', '--porcelain']), '');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.code_commit, status.situation.uncommitted], [true, head, []], JSON.stringify(status.situation));
  assert.deepEqual(status.situation.needs_user.map((entry) => entry.decision), ['merge or pull request']);
  assert.ok(status.warnings.some((warning) => warning.startsWith('Git ignores files of this change that must be committed: ')), JSON.stringify(status.warnings));
});

test('the accepted change does not count as committed while openspec/config.yaml and openspec/genesis.json are not in Git', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewAndAccept(project, run);
  git(repo, ['add', '-A']);
  git(repo, ['rm', '-q', '--cached', 'openspec/config.yaml', 'openspec/genesis.json']);
  git(repo, ['commit', '-q', '-m', 'Commit all but the OpenSpec project files']);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.uncommitted], [false, ['openspec/config.yaml', 'openspec/genesis.json']], JSON.stringify(status.situation));
  const all = commit(repo, 'Commit the OpenSpec project files');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.committed, status.situation.code_commit], [true, all]);
});

test('a .gitignore that ignores openspec/ is named with the Spec it keeps out, in eval validate, loop accept and loop status, and keeps the accepted change from counting as committed', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  writeFileSync(path.join(repo, '.gitignore'), 'openspec/\n');
  git(repo, ['rm', '-r', '-q', '--cached', 'openspec']);
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  commit(repo, 'Commit everything Git does not ignore');
  assert.equal(git(repo, ['ls-files', 'openspec']), '');
  const ignored = `Git ignores files of this change that must be committed: openspec/changes/${CHANGE}/, openspec/config.yaml, openspec/genesis.json, openspec/schemas/genesis-spec/ (rule \`openspec/\` in .gitignore:1). Without them a clone has no Spec of this change, OpenSpec project files or Spec schema.`;
  const named = (warnings) => warnings.some((warning) => warning.startsWith(ignored) && warning.includes('remove `openspec/`, or add `!openspec/` to the project\'s .gitignore after it'));
  assert.ok(named(validateEval(repo, CHANGE).warnings), JSON.stringify(validateEval(repo, CHANGE).warnings));
  reviewRun(project, run.run_id);
  const accepted = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  assert.ok(named(accepted.warnings), JSON.stringify(accepted.warnings));
  assert.deepEqual([accepted.commit, accepted.committed], [undefined, false]);
  const status = loopStatus(repo, CHANGE);
  assert.ok(named(status.warnings), JSON.stringify(status.warnings));
  assert.equal(status.phase, 'done');
  assert.equal(status.situation.committed, false);
  assert.deepEqual(status.situation.uncommitted, [`.genesis/edd/${CHANGE}/accepted.json`, `openspec/changes/${CHANGE}/`, 'openspec/config.yaml', 'openspec/genesis.json', 'openspec/schemas/genesis-spec/']);
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

test('the accepted change counts as committed while a project-wide rule such as `*.log` or `.env` keeps a file inside the change\'s folders out of Git, and that file is not offered', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  writeFileSync(path.join(repo, '.gitignore'), '*.log\n.env\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewAndAccept(project, run);
  const all = commit(repo, 'Commit the change and its files');
  const edd = `.genesis/edd/${CHANGE}`;
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, 'tests/debug.log'), 'output of a local try\n');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, '.env'), 'TOKEN=synthetic-test-value\n');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.code_commit, status.situation.uncommitted], [true, all, []], JSON.stringify(status.situation));
  assert.doesNotMatch(JSON.stringify(status.situation), /debug\.log|\.env/);
  assert.ok(!status.warnings.some((warning) => warning.startsWith('Git ignores')), JSON.stringify(status.warnings));
});

test('new files in a folder of the change that Git partly holds are offered for commit while a rule ignores that folder, and a leftover there is not', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewAndAccept(project, run);
  const all = commit(repo, 'Commit the change and its files');
  assert.equal(loopStatus(repo, CHANGE).situation.code_commit, all);
  // The rule comes after the commit, so Git still holds what it had.
  writeFileSync(path.join(repo, '.git/info/exclude'), '.genesis/*\n');
  const edd = `.genesis/edd/${CHANGE}`;
  mkdirSync(path.join(repo, edd, 'evals/new-case/tests'), { recursive: true });
  writeFileSync(path.join(repo, edd, 'evals/new-case/tests/test.sh'), 'exit 0\n');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, 'tests/extra.txt'), 'more\n');
  writeFileSync(path.join(repo, edd, 'evals', FAILURE, '.DS_Store'), '');
  writeFileSync(path.join(repo, edd, 'reports/notes.md'), 'notes\n');
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.equal(status.situation.committed, false, JSON.stringify(status.situation));
  assert.deepEqual(status.situation.uncommitted, [`${edd}/evals/new-case/`, `${edd}/evals/${FAILURE}/tests/extra.txt`, `${edd}/reports/notes.md`]);
  assert.ok(status.warnings.some((warning) => warning.startsWith('Git ignores files of this change that must be committed: ')
    && warning.includes('add `!.genesis/edd/` after `.genesis/*`')), JSON.stringify(status.warnings));
});

test('an untracked folder in the change\'s folders that holds only leftovers keeps the accepted change committed, and is listed once it holds a file of the change', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  editApp(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewAndAccept(project, run);
  const all = commit(repo, 'Commit the change and its files');
  const extra = path.join(repo, `.genesis/edd/${CHANGE}/evals`, FAILURE, 'extra');
  mkdirSync(extra);
  writeFileSync(path.join(extra, '.DS_Store'), '');
  writeFileSync(path.join(extra, 'notes.md~'), '');
  writeFileSync(path.join(extra, 'try.log'), 'ignored by the project\n');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.deepEqual([status.situation.committed, status.situation.code_commit, status.situation.uncommitted], [true, all, []], JSON.stringify(status.situation));

  writeFileSync(path.join(extra, 'seed.txt'), 'seed\n');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.committed, false);
  assert.deepEqual(status.situation.uncommitted, [`.genesis/edd/${CHANGE}/evals/${FAILURE}/extra/`]);
});

// A loop whose checks confirmation asks to stop when the loop is stuck
// (eval confirm --stop-on-stuck), with its baseline and the user's consent.
function stopOnStuckLoop(t, budget = {}) {
  const project = readyProject(t, { confirm: false });
  const confirmed = confirmChecks(project, { stopOnStuck: true });
  commitConfirmation(project.repo);
  assert.equal(confirmed.confirmation.stop_on_stuck, true, JSON.stringify(confirmed.confirmation));
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const started = startLoop(project.repo, CHANGE, budget);
  return { ...project, base, loop: started.loop };
}

test('a run during which the code changed is never the earlier result a regression, lost progress or a stuck loop is measured against', (t) => {
  const project = stopOnStuckLoop(t, { iterations: 10 });
  const { repo, tools } = project;
  const moved = () => {
    harborThen(t, "appendFileSync(path.join(repo, 'app/edited.txt'), 'edited during the run\\n');");
    const run = startRun(repo, CHANGE);
    tools.harbor(true);
    assert.equal(runRecord(project, run).code_changed_during_run, true);
    return run;
  };
  // A pass, a moved run that fails, then a failure: the check passed in the
  // last run that belongs to one version of the code, so progress was lost.
  changeCode(repo, AFTER, 'fix the failure notice');
  fullRun(repo);
  changeCode(repo, BEFORE, 'undo the fix during a run');
  moved();
  changeCode(repo, BEFORE, 'undo the fix');
  fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.lost_progress.map(brief), [{ case: FAILURE, check: 'c1', intent: 'REQ-submit-failure' }]);
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
  // other code: the loop is stuck, and with the user's stop-on-stuck it
  // stops for good; the moved pass is no progress that was lost.
  changeCode(repo, AFTER, 'fix the failure notice during a run');
  moved();
  changeCode(repo, BEFORE, 'try another way');
  fullRun(repo);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.lost_progress, []);
  assert.equal(status.stuck, true);
  assertEnded(status, 'stop_stuck');
  assert.match(status.ended.message, /failed in \S+ and \S+ \(the 2 runs between them are not compared\) on different code/);
  changeCode(repo, AFTER, 'another change after the stop');
  assertEnded(loopStatus(repo, CHANGE), 'stop_stuck');
  assert.equal(refusedBeforeRun(project, {}, 'change_locked').reason, 'stop_stuck');
});

test('a stuck loop without the user\'s stop-on-stuck only warns, and goes on', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, BROKEN, 'break the success notice');
  fullRun(repo);
  changeCode(repo, BROKEN, 'break it another way');
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assert.equal(status.loop.stop_on_stuck, false);
  assert.deepEqual([status.phase, status.ended, status.stop], ['live', null, null]);
  assert.ok(status.warnings.includes(`stuck: the same gating checks failed in the last two runs on different code: ${SUCCESS}/c1=fail.`), JSON.stringify(status.warnings));
  assert.equal(status.gates.head_run, null);
  // The check passed at the baseline, so the facts name a regression.
  assert.equal(status.situation.code, 'regression');
  assert.equal(headRunAction(workflowStatus(repo, CHANGE)).allowed, true);
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
  assert.ok(run.warnings.includes('The code changed while this run executed, so its results do not belong to one version of the code: it neither passes nor counts as a baseline.'), JSON.stringify(run.warnings));
  // The code is the run's again, yet the run is no pass of it.
  assert.ok(sameCodeAsRun(repo, run));
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.situation.code, status.situation.code_changed], ['run_not_settled', true]);
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo]);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    refusedWith('not_passing')(error);
    assertGapShape(gapOf(error, 'code_changed_during_run'), { owner: 'agent', layer: 'code', run: run.run_id });
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
  assert.ok(run.warnings.includes(`The eval packages changed while this run executed: ${SUCCESS} (${SUCCESS}/environment/Dockerfile). Its results do not belong to one version of them: it neither passes nor counts as a baseline.`), JSON.stringify(run.warnings));
  // The package is as the user confirmed it, so the loop goes on: the run is made again.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.packages_changed, status.situation.packages], ['live', 'run_not_settled', true, [SUCCESS]]);
  assertSuggestion(status, ['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(fullRun(repo).verdict, 'pass');
});

