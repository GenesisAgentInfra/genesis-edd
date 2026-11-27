// Helpers the loop test files (loop.test.js and loop-*.test.js) share. They
// were the local helpers of loop.test.js before it was split by topic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ignoredArtifacts, initProject, projectRoot, readJSON } from '../../src/project.js';
import { exportSpec, newSpec, validateSpec } from '../../src/spec.js';
import { newEval, validateEval } from '../../src/eval.js';
import { checkEval, codeSnapshot, startRun } from '../../src/run.js';
import { acceptLoop, loopStatus, reportGaps, startLoop, writeReport } from '../../src/loop.js';
import { checkWorkflow } from '../../src/workflow.js';
import { reviewEval } from '../../src/confirm.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FIXTURES, LIVE_DEPENDENCY, SPECS, cli, commit, commitConfirmation, confirmChecks, connect, dropCheck, editChecks, git, harborThen, legacyWarning, readRecord,
  readyProject, reviewFixtures, setResults, toLegacy, useFakeTools, writeExpectations, writeFixtureScripts, writeSpec,
} from './edd.js';

// What the code before the change does: a failed submission still sends a
// success notice, and a successful one behaves.
export const EXPECT = { 'submit-failure-s1/c1': 'fail', 'submit-success-s1/c1': 'pass', 'submit-success-s1/c2': 'pass' };
// A change that fixes the failed submission and breaks the successful one.
export const BROKEN = { 'submit-failure-s1': { c1: 'pass' }, 'submit-success-s1': { c1: 'fail', c2: 'pass' } };
export const TEMPLATE_MARK = 'GENESIS_EDD_TEMPLATE';

export const codes = (gaps) => (gaps ?? []).map((entry) => entry.code);
export const blockedWith = (code) => (error) => {
  assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
  assert.ok(codes(error.gaps).includes(code), `expected ${code} in ${JSON.stringify(error.gaps)}`);
  return true;
};
export const refusedWith = (code) => (error) => {
  assert.ok(codes(error.gaps).includes(code), `expected ${code} in ${error.message} ${JSON.stringify(error.gaps)}`);
  return true;
};

// A ready project whose baseline ran on the code before the change.
export function withBaseline(t, options = {}) {
  const project = readyProject(t, options);
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  return { ...project, base };
}

// The same, with a loop started on that code.
export function inLoop(t, budget = {}) {
  const project = withBaseline(t);
  const started = startLoop(project.repo, CHANGE, budget);
  return { ...project, loop: started.loop };
}

// Changes the application and commits it. app/results.json is what the fake
// verifier records; app/handler.txt stands in for the code that was edited, so
// every label gives different code.
export function changeCode(repo, results, label) {
  setResults(repo, results);
  writeFileSync(path.join(repo, 'app/handler.txt'), `${label}\n`);
  return commit(repo, label);
}

export function fullRun(repo) {
  const run = startRun(repo, CHANGE);
  assert.equal(run.execution_status, 'completed', JSON.stringify(run));
  assert.equal(run.scope, 'full');
  return run;
}

// Completes a run's report as an agent would: the template line goes, every
// check under Cause gets a cause, Next gets content, and Review too unless
// review is false.
export function completeReport(repo, runId, { review = true } = {}) {
  const { file } = writeReport(repo, CHANGE, { run: runId });
  let text = readFileSync(file, 'utf8').split('\n').filter((line) => !line.includes(TEMPLATE_MARK)).join('\n')
    .replace(/^(- `[^`]+` `[^`]+` \([a-z_]+\):)[ \t]*$/gm, '$1 code logic: the handler ignores the submission result (see logs/harbor.log).')
    .replace(/^## Next[ \t]*$/m, '## Next\n\nChange the notification handler, then run every package again.');
  if (review) text = text.replace(/^## Review[ \t]*$/m, '## Review\n\nA fresh reviewer compared the whole diff with the Spec and found nothing to change.');
  writeFileSync(file, text);
  return file;
}

export const runRecord = (project, run) => readRecord(path.join(project.runs, run.run_id)).run;

export const FAILURE = 'submit-failure-s1';
export const SUCCESS = 'submit-success-s1';

// The same Spec with a revision bump: a different export once exported.
export const REVISED = SPECS.two.replace('revision: 1', 'revision: 2');

export const loopPath = (project) => path.join(project.root, 'loop.json');
export const loopRecord = (project) => readJSON(loopPath(project));
// Rewrites loop.json, e.g. to move its clock back in time.
export function editLoop(project, edit) {
  const loop = loopRecord(project);
  edit(loop);
  writeFileSync(loopPath(project), `${JSON.stringify(loop, null, 2)}\n`);
}
export const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
export const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1, `${actual} minutes, expected about ${expected}`);
export const withoutKey = (value, key) => Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));

// A stop_budget step: the loop has ended, and its command starts a new loop
// with a budget the user gives. reason, when given, is next.reason.
export function assertStopBudget(next, repo, reason = null) {
  assert.equal(next.action, 'stop_budget', JSON.stringify(next));
  if (reason) assert.equal(next.reason, reason, JSON.stringify(next));
  const { command } = next;
  assert.deepEqual(command.slice(0, 5), ['loop', 'start', CHANGE, '--repo', repo], JSON.stringify(command));
  assert.equal(command[command.indexOf('--max-iterations') + 1], '<N>', JSON.stringify(command));
  assert.equal(command[command.indexOf('--max-minutes') + 1], '<M>', JSON.stringify(command));
}

// Changes the application without committing it; a run keeps it as commit plus patch.
export function editApp(repo, results, label) {
  setResults(repo, results);
  writeFileSync(path.join(repo, 'app/handler.txt'), `${label}\n`);
}

// Puts the application back exactly as committed before the loop, the code its baseline ran on.
export function restoreStart(project) {
  setResults(project.repo, BEFORE);
  rmSync(path.join(project.repo, 'app/handler.txt'), { force: true });
  assert.equal(codeSnapshot(project.repo).snapshot.digest, loopRecord(project).start_code.digest);
}

// Changes what a package executes, which makes it a different package, then proves it again.
export function changePackage(project, id) {
  const file = path.join(project.root, 'evals', id, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  const checked = checkEval(project.repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked, null, 2));
}

// Exports the revised Spec and brings every package in line with it, as write-eval would,
// and the user confirms the checks of the new export.
export function exportRevision(project) {
  writeSpec(project.repo, REVISED);
  const exported = exportSpec(project.repo, CHANGE);
  for (const id of Object.keys(project.packages)) {
    const file = path.join(project.root, 'evals', id, 'tests/checks.json');
    const declared = readJSON(file);
    declared.spec_ref.sha256 = exported.id;
    writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  }
  assert.equal(checkEval(project.repo, CHANGE).passed, true);
  confirmChecks(project);
  return exported;
}

// Whether the code now has the content digest a run recorded.
export const sameCodeAsRun = (repo, run) => codeSnapshot(repo).snapshot.digest === readRecord(run).run.code_snapshot.digest;

// Leaves app/results.json, which the fake verifier records, out of the code,
// so the results can change while the code stays the same.
export function resultsOutsideCode(repo) {
  const exclude = path.join(repo, '.git/info/exclude');
  writeFileSync(exclude, `${existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''}app/results.json\n`);
  git(repo, ['rm', '-q', '--cached', 'app/results.json']);
}

// An unstable group without its intent, agent and model.
export const runsOf = ({ case: id, check, pass, fail }) => ({ case: id, check, pass, fail });

// A loop whose baseline ran the packages in live N times each, every other once.
export function liveLoop(t, attempts, live = [FAILURE]) {
  // The user confirmed N with the checks; the baseline reads it.
  const project = readyProject(t, { live, attempts });
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const started = startLoop(project.repo, CHANGE);
  return { ...project, base, loop: started.loop, started };
}

export const gapOf = (error, code) => error.gaps.find((entry) => entry.code === code);

export const STRENGTH_3 = 'The gating checks of packages with a live dependency each had 3 attempts with evidence, and none failed. A check that fails half the time passes all 3 with a 13% chance; one that fails one time in ten, with a 73% chance. That does not show the checks always hold.';
// The fake Harbor's attempts take a second each: 3 of FAILURE and 1 of SUCCESS
// come to about 0.1 minutes.
// What the final run takes by earlier attempts, as its message says: once a
// screen run of the loop ran every package, by the loop's own attempts.
export const FINAL_COST = (base, cost = 'about 0.1 minutes', by = 'by the attempts of this loop\'s runs') => ` It takes ${cost} (${by ?? `by the attempts of the baseline ${base}`}).`;
export const FINAL_RUN = (screen, base) => `Screen run ${screen} passed and its final review is done. Run the final run now with \`run start\`: on this code, ${FAILURE} runs 3 times and every other package once, the packages that failed before first; it stops at the first package that fails, and only a passing final run can be accepted. Leave the code and the packages as they are until it finishes.${FINAL_COST(base)}`;

// A loop whose live FAILURE runs 3 attempts in the plan, with app/results.json
// outside the code, so a test sets what each attempt records without
// changing the code; app/handler.txt stands for the code.
export function finalsLoop(t) {
  const project = liveLoop(t, 3);
  resultsOutsideCode(project.repo);
  return project;
}

// Changes the code, makes a passing screen run of it, and completes its
// report, Review included unless review is false.
export function passingScreen(project, results = AFTER, label = 'Stop the success notice when a submission fails', { review = true } = {}) {
  changeCode(project.repo, results, label);
  const screen = fullRun(project.repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass'], JSON.stringify(screen));
  completeReport(project.repo, screen.run_id, { review });
  return screen;
}

// A new project confirmed before the kit named a model: the loop starts on a
// baseline that records that nothing could run, and the packages are
// connected inside it, with harness.json naming the model then.
export function newProjectLoop(t) {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  assert.equal(confirmChecks(project).confirmation.run_plan.model, null);
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  writeFileSync(path.join(repo, '.genesis/edd/harness/harness.json'), `${JSON.stringify({ agent: AGENT, model: 'synthetic/m1' }, null, 2)}\n`);
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  return project;
}

// A head run (options as startRun takes them) refused with code before
// anything runs: no Harbor run and no run folder. Returns the refusal's gap.
export function refusedBeforeRun(project, options, code) {
  const calls = project.tools.runs().length;
  const folders = existsSync(project.runs) ? readdirSync(project.runs).length : 0;
  let refusal = null;
  assert.throws(() => startRun(project.repo, CHANGE, options), (error) => {
    assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
    refusal = (error.gaps ?? []).find((entry) => entry.code === code) ?? null;
    assert.ok(refusal, `expected ${code} in ${JSON.stringify(error.gaps)}`);
    return true;
  });
  assert.equal(project.tools.runs().length, calls, 'Harbor ran');
  assert.equal(existsSync(project.runs) ? readdirSync(project.runs).length : 0, folders, 'a run folder was written');
  return refusal;
}

// A loop that ended because a fixed input changed: next is loop_ended with
// that reason, and loop accept refuses it.
export function assertEnded(status, reason) {
  assert.equal(status.next.action, 'loop_ended', JSON.stringify(status.next));
  assert.equal(status.next.reason, reason, JSON.stringify(status.next));
  assert.equal(status.ended?.reason, reason, JSON.stringify(status.ended));
}
