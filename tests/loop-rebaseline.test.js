// Loop tests: a baseline recorded again after a package changed, and the plan,
// agent and model it takes.
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
  EXPECT, TEMPLATE_MARK, codes, blockedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, loopPath, loopRecord, editApp,
  restoreStart, changePackage, resultsOutsideCode, liveLoop, gapOf, finalsLoop, passingScreen, newProjectLoop,
  refusedBeforeRun, assertEnded, assertStopBudget,
} from './helpers/loop.js';

test('before a loop, a baseline recorded again after a package changed reads the number the user confirmed, and eval confirm then leads to loop start', (t) => {
  const project = readyProject(t, { live: [FAILURE] });
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.deepEqual(codes(error.gaps), ['baseline_packages_differ', 'checks_unconfirmed']);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.is_baseline, again.run_plan.attempts, again.run_plan.source], [true, 3, 'baseline']);
  assert.ok(again.warnings.includes(`This baseline takes 3 attempts of each package with a live dependency, agent ${AGENT} and model none from the plan the user last confirmed for this Spec export. The user's checks confirmation does not cover the packages as they are, so the baseline records them as its own.`), JSON.stringify(again.warnings));
  const confirmed = confirmChecks(project, { reason: 'The verifier of the failure case was fixed.' });
  assert.ok(confirmed.next.startsWith(`The checks are confirmed. The baseline ${again.run_id} ran these packages with this plan on this code: start the loop next with \`loop start\``), confirmed.next);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('a baseline that skipped a package waiting for eval check says to prove it and record the baseline again', (t) => {
  const project = readyProject(t, { live: [FAILURE] });
  const { repo, root } = project;
  appendFileSync(path.join(root, 'evals', SUCCESS, 'tests/test.sh'), '# a fix to the verifier\n');
  confirmChecks(project, { reason: 'The verifier of the success case was fixed.' });
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(base.skipped.map((entry) => [entry.case, entry.missing]), [[SUCCESS, ['check']]]);
  assert.equal(base.next, `This baseline skipped ${SUCCESS}, which waits for \`eval check\`, so no loop starts on it. Prove it with \`eval check\`, then record the baseline again with the same flags before \`loop start\`.`);
  assert.throws(() => startLoop(repo, CHANGE), blockedWith('baseline_packages_differ'));
});

test('loop status sends a package that no longer validates to write-eval, not to eval check, which refuses it', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  editChecks(repo, FAILURE, (declared) => { delete declared.dependencies; });
  const invalid = validateEval(repo, CHANGE).gaps.find((entry) => entry.code === 'case_invalid');
  assert.ok(invalid);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.equal(status.next.route, 'write-eval');
  assert.deepEqual(status.ended.files, [`${FAILURE}/tests/checks.json`]);
  assert.ok(status.next.message.includes(invalid.message), status.next.message);
  assert.ok(!status.next.message.includes(`Prove ${FAILURE}`), status.next.message);
  assert.throws(() => checkEval(repo, CHANGE), /case_invalid|dependencies/);
});

test('in a new project, eval confirm names --unavailable for the baseline, before it and once the plan changed after it', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  const first = confirmChecks(project);
  assert.equal(first.next, 'The checks are confirmed. Record the baseline next: `run start --baseline --unavailable no_implementation` reads N, the agent and the model from confirmed.json.');
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.is_baseline, false);
  const revised = confirmChecks(project, { model: 'synthetic/m9', reason: 'The user chose a model.' });
  assert.equal(revised.next, 'The checks are confirmed. Record the baseline next: `run start --baseline --unavailable no_implementation` reads N, the agent and the model from confirmed.json.');
  const check = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.deepEqual(check.next.command.slice(-3), ['--baseline', '--unavailable', 'no_implementation']);
});

test('on a baseline that records that nothing could run, loop start names --unavailable when it asks for the number of attempts', (t) => {
  const fresh = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  confirmChecks(fresh);
  startRun(fresh.repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  for (const id of [FAILURE, SUCCESS]) connect(fresh.repo, id);
  editChecks(fresh.repo, FAILURE, (declared) => { declared.dependencies = [LIVE_DEPENDENCY]; });
  assert.equal(checkEval(fresh.repo, CHANGE).passed, true);
  assert.throws(() => startLoop(fresh.repo, CHANGE), (error) => {
    assert.ok(gapOf(error, 'attempts_undecided').message.endsWith('then record the baseline again with `run start --baseline --unavailable no_implementation`, which reads N from confirmed.json, and run `loop start`.'), error.message);
    return true;
  });
});

test('in a new project loop, connecting the packages ends the loop as the expected step, says what follows, and a head run is refused', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  for (const id of [FAILURE, SUCCESS]) {
    editChecks(repo, id, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.origin !== 'review'); });
  }
  confirmChecks(project);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  changeCode(repo, AFTER, 'The first implementation');
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.deepEqual(status.ended.packages, [FAILURE, SUCCESS]);
  assert.ok(status.next.message.includes(`This loop started on a baseline recorded as unavailable (${base.run_id}), so this end is the expected step once the packages are connected. What follows: \`eval check\` proves the connected packages; \`eval review\` gives the reviewer's brief and questions`), status.next.message);
  assert.ok(status.next.message.includes('the user confirms the packages with `eval confirm --reason`; the baseline is recorded again on the loop\'s start code'), status.next.message);
  assert.ok(status.next.message.includes('then a new loop starts with `loop start` once the user agrees.'), status.next.message);
  refusedBeforeRun(project, {}, 'loop_ended');
  // workflow check write-eval names eval review for the packages that wait for counterexamples.
  const note = checkWorkflow(repo, 'write-eval', CHANGE).next.note;
  assert.ok(note.includes('Once each package is missing only `review`, run `eval review`'), note);
});

test('a baseline recorded again after a package changed takes the agent and the model the user confirmed, and those of harness.json once it changed', (t) => {
  const project = readyProject(t, { live: [FAILURE], model: 'synthetic/m1', confirm: false });
  const { repo, root } = project;
  confirmChecks(project, { attempts: 3, model: 'synthetic/m2' });
  assert.equal(startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) }).run_plan.model, 'synthetic/m2');
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual([again.run_plan.attempts, again.run_plan.model, again.run_plan.source], [3, 'synthetic/m2', 'baseline']);
  assert.equal(readRecord(again).run.environment_ref.model, 'synthetic/m2');
  assert.ok(again.warnings.includes(`This baseline takes 3 attempts of each package with a live dependency, agent ${AGENT} and model synthetic/m2 from the plan the user last confirmed for this Spec export. The user's checks confirmation does not cover the packages as they are, so the baseline records them as its own.`), JSON.stringify(again.warnings));
  assert.equal(confirmChecks(project, { reason: 'The verifier of the failure case was fixed.' }).confirmation.run_plan.model, 'synthetic/m2');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);

  // Once harness.json names another model, the baseline and the revision both take it.
  const other = readyProject(t, { live: [FAILURE], model: 'synthetic/m1', confirm: false });
  confirmChecks(other, { attempts: 3, model: 'synthetic/m2' });
  startRun(other.repo, CHANGE, { baseline: true, expect: writeExpectations(other.repo, EXPECT) });
  writeFileSync(path.join(other.repo, '.genesis/edd/harness/harness.json'), `${JSON.stringify({ agent: AGENT, model: 'synthetic/m3' }, null, 2)}\n`);
  assert.equal(checkEval(other.repo, CHANGE).passed, true);
  const moved = startRun(other.repo, CHANGE, { baseline: true, expect: writeExpectations(other.repo, EXPECT) });
  assert.deepEqual([moved.run_plan.attempts, moved.run_plan.model], [3, 'synthetic/m3']);
  assert.equal(confirmChecks(other, { reason: 'The kit names another model.' }).confirmation.run_plan.model, 'synthetic/m3');
  assert.equal(startLoop(other.repo, CHANGE).loop.baseline, moved.run_id);
});

test('inside a loop, a package set to draft ends the loop, and its decision goes to the user through agent-spec, as in workflow check', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  completeReport(repo, fullRun(repo).run_id);
  editChecks(repo, SUCCESS, (declared) => { declared.status = 'draft'; });
  const draft = validateEval(repo, CHANGE).gaps.find((entry) => entry.code === 'case_draft');
  assert.ok(draft);
  const status = loopStatus(repo, CHANGE);
  assertEnded(status, 'packages_changed');
  assert.ok(status.next.message.includes(draft.message), status.next.message);
  assert.ok(status.next.message.endsWith('The decision on a package set to draft is the user\'s, through agent-spec.'), status.next.message);
  const workflow = checkWorkflow(repo, 'loop-and-implement', CHANGE);
  assert.deepEqual([workflow.next.owner, workflow.next.route, workflow.next.action], ['user', 'agent-spec', 'resolve_business_decisions']);
  assert.throws(() => startRun(repo, CHANGE), (error) => error.gaps.some((entry) => entry.code === 'case_draft' && entry.owner === 'user' && entry.route === 'agent-spec'));
});

test('inside a loop, workflow check write-eval says a change to a package or the kit ends the loop', (t) => {
  const project = inLoop(t);
  const note = checkWorkflow(project.repo, 'write-eval', CHANGE).next.note;
  assert.ok(note.endsWith('into review.json; a loop runs for this Spec, and changing a package or the kit while it runs ends it (packages_changed): `eval review` and the user\'s `eval confirm`, then a new loop once they agree.'), note);
});

test('a passing full run recorded before runs had a role, with other attempts than the plan, is a screen run whose messages say what it made', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  const screen = passingScreen(project, AFTER, 'Stop the success notice when a submission fails', { review: false });
  // As an older CLI recorded it: no role, two attempts of the live package.
  const file = path.join(project.runs, screen.run_id, 'run.json');
  const { role, ...rest } = readJSON(file);
  assert.equal(role, 'screen');
  writeFileSync(file, `${JSON.stringify({ ...rest, environment_ref: { ...rest.environment_ref, attempts: 2, attempts_by_case: { ...rest.environment_ref.attempts_by_case, [FAILURE]: 2 } } }, null, 2)}\n`);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((run) => run.role), ['screen']);
  assert.equal(status.next.action, 'final_review', JSON.stringify(status.next));
  assert.ok(status.next.message.startsWith('The screen run passed: 2 attempts of each package that a final run runs 3 times.'), status.next.message);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: screen.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    assert.ok(gapOf(error, 'not_final').message.startsWith(`${screen.run_id} is a screen run: its pass rests on 2 attempts of each package that a final run runs 3 times.`), error.message);
    return true;
  });
});
