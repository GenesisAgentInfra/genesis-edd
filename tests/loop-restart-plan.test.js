// Loop tests: the end of a loop when its plan or packages change, revisions, and the model and agent
// every named run start carries.
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
  EXPECT, TEMPLATE_MARK, codes, blockedWith, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, FAILURE, SUCCESS, loopPath,
  loopRecord, editApp, restoreStart, resultsOutsideCode, liveLoop, gapOf, finalsLoop,
  refusedBeforeRun, assertEnded, assertStopBudget,
} from './helpers/loop.js';

const HARNESS = (model) => `${JSON.stringify({ agent: AGENT, model }, null, 2)}\n`;

test('loop accept gives not_final only for a screen run that passed: a failing run is refused as not passing alone', (t) => {
  const project = finalsLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'A first try that changes nothing');
  const failing = fullRun(repo);
  assert.deepEqual([failing.role, failing.verdict], ['screen', 'fail']);
  completeReport(repo, failing.run_id);
  assert.throws(() => acceptLoop(repo, CHANGE, { run: failing.run_id, by: 'Dana', ref: 'thread 1' }), (error) => {
    assert.ok(codes(error.gaps).includes('not_passing'), error.message);
    assert.ok(!codes(error.gaps).includes('not_final'), error.message);
    return true;
  });
});

test('in a new project, the first iterate of a loop says to write the entry point, and that connecting the packages ends the loop', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  confirmChecks(project, { attempts: 3 });
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  startLoop(repo, CHANGE);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.route], ['iterate', undefined], JSON.stringify(status.next));
  assert.ok(status.next.message.startsWith('No package is connected yet, so `run start` has nothing to run. Write the code\'s entry point. Connecting the packages in write-eval changes them, which ends this loop (packages_changed); the user then confirms them, and a new loop follows with their go-ahead.'), status.next.message);
  assert.deepEqual(status.next.pending_packages, [FAILURE, SUCCESS]);
});

test('after the user accepted the loop, workflow check write-eval says a package changed since only warns', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const before = checkWorkflow(repo, 'write-eval', CHANGE).next.note;
  assert.ok(before.endsWith('a loop runs for this Spec, and changing a package or the kit while it runs ends it (packages_changed): `eval review` and the user\'s `eval confirm`, then a new loop once they agree.'), before);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const note = checkWorkflow(repo, 'write-eval', CHANGE).next.note;
  assert.ok(note.endsWith('the user accepted the loop for this Spec, so `loop status` only warns about a package changed since: tell the user what changed and why.'), note);
});

test('outside a loop, the steps after a package changed since the confirmation name eval confirm --reason, as a revision needs', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  appendFileSync(path.join(root, 'evals', FAILURE, 'tests/test.sh'), '# a fix to the verifier\n');
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true);
  assert.ok(checked.next.endsWith('so they confirm the revision before the baseline (`eval review`, `eval confirm --reason`).'), checked.next);
  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.next.action, 'confirm_checks');
  assert.ok(workflow.next.note.includes('as a revision') && workflow.next.note.endsWith('record their words with `eval confirm --reason`.'), workflow.next.note);
  const again = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.ok(again.next.includes('Have the user confirm the checks first (`eval review`, `eval confirm --reason`)'), again.next);
  const review = reviewEval(repo, CHANGE);
  assert.ok(review.next.includes('run `eval confirm` with --by and --ref, --reason, since this Spec export was confirmed before, and the plan they agreed.'), review.next);
  assert.equal(confirmChecks(project, { reason: 'The verifier of the failure case was fixed.' }).confirmation.confirmed.kind, 'revision');
});

test('while the loop\'s baseline is missing from runs/, the loop has ended and says how to restore it, and restoring it lifts the end', (t) => {
  const project = readyProject(t, { model: 'synthetic/m1' });
  const { repo, root } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  startLoop(repo, CHANGE);
  const folder = path.join(root, 'runs', base.run_id);
  const away = path.join(root, 'away');
  renameSync(folder, away);
  const missing = loopStatus(repo, CHANGE);
  assertEnded(missing, 'baseline_missing');
  assert.equal(missing.next.route, 'run-eval');
  assert.deepEqual([missing.ended.baseline, missing.ended.start_code], [base.run_id, loopRecord(project).start_code]);
  assert.ok(missing.next.message.startsWith(`The loop for this Spec compares every run with ${base.run_id}, which is no longer in runs/, so the loop has ended (baseline_missing). Restore that run folder to go on with it`), missing.next.message);
  setResults(repo, AFTER);
  refusedBeforeRun(project, {}, 'loop_ended');
  renameSync(away, folder);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.ended, null);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));
});

test('in a new project, eval review asks for N while no package declares its dependencies, and eval confirm without --attempts warns', (t) => {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {}, check: false });
  const { repo } = project;
  const ask = 'No package declares its dependencies yet, since the loop connects them. If a scenario may call a model, ask the user for N now and';
  const review = reviewEval(repo, CHANGE);
  assert.equal(review.run_plan.attempts_needed, false);
  assert.ok(review.next.endsWith(`${ask} pass --attempts N: declaring a live dependency later changes the package, which ends a running loop and needs the user's number before a new one.`), review.next);
  const confirmed = confirmChecks(project);
  assert.ok(confirmed.warnings.includes(`This confirmation fixes no number of attempts. ${ask} confirm again with --attempts N and --reason before the baseline: declaring a live dependency later changes the package, which ends a running loop and needs the user's number before a new one.`), JSON.stringify(confirmed.warnings));
  // Once N is fixed, neither asks.
  assert.ok(!confirmChecks(project, { attempts: 3, reason: 'The user chose 3 attempts.' }).warnings.some((warning) => warning.includes(ask)));
  assert.ok(!reviewEval(repo, CHANGE).next.includes(ask));
});

test('a baseline given plan flags before the user confirmed is named with its plan by eval review and workflow check', (t) => {
  const project = readyProject(t, { live: [FAILURE], confirm: false });
  const { repo } = project;
  const flagAgent = 'flag_agent:FlagAgent';
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT), attempts: 3, agent: flagAgent, model: 'synthetic/flag-model' });
  const item = reviewEval(repo, CHANGE).must_decide.find((entry) => entry.code === 'baseline_plan_recorded');
  assert.deepEqual([item?.baseline, item?.keys, item?.flags], [base.run_id, ['attempts', 'agent', 'model'], undefined], JSON.stringify(item));
  const text = `The baseline ${base.run_id} ran with 3 attempts, agent ${flagAgent}, model synthetic/flag-model, a plan of its own: without plan flags, \`eval confirm\` records no fixed number of attempts, agent ${AGENT}, model none. \`loop start\` takes that baseline only once the user confirms the plan it ran; otherwise record the baseline again after the confirmation, which reads the plan from it.`;
  assert.equal(item.message, `${text} The user decides which one runs.`);
  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.next.action, 'confirm_checks');
  assert.ok(workflow.next.note.includes(text), workflow.next.note);
  // Confirmed with those flags, the loop starts on that baseline.
  confirmChecks(project, { attempts: 3, agent: flagAgent, model: 'synthetic/flag-model' });
  assert.ok(!reviewEval(repo, CHANGE).must_decide.some((entry) => entry.code === 'baseline_plan_recorded'));
  assert.equal(startLoop(repo, CHANGE).loop.baseline, base.run_id);
});
