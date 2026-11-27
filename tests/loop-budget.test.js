// Loop tests: the budget clock, ends and new loops, the order of next steps,
// comparisons of the same package, acceptance across loops and impact evidence.
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
  REVISED, loopPath, loopRecord, editLoop, minutesAgo, near, withoutKey, assertStopBudget, editApp, restoreStart, changePackage, exportRevision,
  refusedBeforeRun, assertEnded,
} from './helpers/loop.js';

// --- Budget clock, ends and new loops, next-step order, same-package
// comparison, acceptance across loops and moved impact evidence. ---

const BUDGET_RULE = /--max-iterations is a whole number of 1 or more and --max-minutes a number above 0/;

const brief = ({ runs_used: runsUsed, iterations, minutes }) => ({ runs_used: runsUsed, iterations, minutes });

const IMPACT = '---\ngenesis_impact: 1\nentries:\n  - entry: notify()\n    effect: changes\n    evidence: app/notify.py:2\n---\n';
const MOVED = /impact\.md evidence no longer matches the code/;

// readyProject(t, { mode: 'existing' }) with app/notify.py and an impact.md that
// points at it, both written before the Spec is exported. readyProject exports
// right after writing the Spec, so this project is built by hand the same way.
function projectWithImpact(t) {
  const tools = useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Genesis Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  initProject(repo, 'existing', 'none');
  mkdirSync(path.join(repo, 'app'), { recursive: true });
  writeFileSync(path.join(repo, 'app/notify.py'), 'def notify(result):\n    return result\n');
  newSpec(repo, CHANGE);
  writeSpec(repo, SPECS.two);
  writeFileSync(path.join(repo, 'openspec/changes', CHANGE, 'impact.md'), IMPACT);
  const exported = exportSpec(repo, CHANGE);
  assert.deepEqual(exported.impact.map((entry) => entry.evidence), ['app/notify.py:2']);
  newEval(repo, CHANGE);
  const root = path.join(repo, '.genesis/edd', CHANGE);
  const kit = path.join(repo, '.genesis/edd/harness');
  writeFileSync(path.join(kit, 'harness.json'), `${JSON.stringify({ agent: AGENT }, null, 2)}\n`);
  writeFileSync(path.join(kit, 'PROJECT.md'), '# Eval notes for this project\n\nSynthetic project. app/results.json stands in for the application.\n');
  const packages = {};
  for (const id of readdirSync(path.join(root, 'evals')).sort()) {
    const directory = path.join(root, 'evals', id);
    const file = path.join(directory, 'tests/checks.json');
    const declared = readJSON(file);
    const ids = declared.checks.map((check) => check.id);
    declared.fixtures = [...FIXTURES.map((name) => ({ name, expect: Object.fromEntries(ids.map((check) => [check, name])) })), ...reviewFixtures(declared)];
    writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
    writeFixtureScripts(repo, id, declared.fixtures.map((fixture) => fixture.name));
    mkdirSync(path.join(directory, 'environment'), { recursive: true });
    writeFileSync(path.join(directory, 'environment/Dockerfile'), 'FROM alpine:3.20\nWORKDIR /app\n');
    writeFileSync(path.join(directory, 'tests/test.sh'), `#!/bin/sh\n. "$(dirname "$0")/genesis.sh"\n# Synthetic verifier. In these tests the fake Harbor stands in for it.\n${ids.map((check) => `gate ${check} unknown "synthetic"`).join('\n')}\nfinish\n`, { mode: 0o755 });
    writeFileSync(path.join(directory, 'Task.md'), `# ${id}\n\n## Trigger\nSynthetic.\n\n## Environment\nSynthetic.\n\n## Evidence\nSynthetic.\n\n## Choices made here\nNone.\n\n## Not covered\nEverything real.\n`);
    connect(repo, id);
    packages[id] = ids;
  }
  setResults(repo, BEFORE);
  commit(repo, 'Add the application and its evals');
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked, null, 2));
  const project = { repo, name: CHANGE, tools, packages, root, runs: path.join(root, 'runs'), spec: exported.id };
  confirmChecks(project);
  commitConfirmation(repo);
  return project;
}

// That project with its baseline recorded and a loop started on the code before the change.
function impactLoop(t) {
  const project = projectWithImpact(t);
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const { loop } = startLoop(project.repo, CHANGE);
  assert.equal(loop.spec, project.spec);
  return { ...project, base, loop };
}

// L1: loop.json.

test('loop start records the code it starts from and starts the budget clock with the loop', (t) => {
  const project = withBaseline(t);
  const { repo, base } = project;
  const head = git(repo, ['rev-parse', 'HEAD']);
  startLoop(repo, CHANGE);
  const loop = loopRecord(project);
  assert.deepEqual(loop.start_code, { commit: head, digest: readRecord(base).run.code_snapshot.digest, digest_of: 'content' });
  assert.equal(loop.start_code.digest, codeSnapshot(repo).snapshot.digest);
  assert.equal(loop.clock_started_at, loop.started_at);
  assert.equal(loop.extensions, undefined);
  assert.deepEqual(loop.previous ?? [], []);
});

// L2 and L3: the budget clock.

test('loop status counts minutes from the budget clock, or from started_at in an older loop.json without one', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo } = project;
  near(loopStatus(repo, CHANGE).loop.used.minutes, 0);

  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(30); });
  near(loopStatus(repo, CHANGE).loop.used.minutes, 30);

  // The clock counts, not the start of the loop.
  editLoop(project, (loop) => { loop.started_at = minutesAgo(120); loop.clock_started_at = minutesAgo(10); });
  let status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 10);
  assert.equal(status.next.action, 'iterate');

  // A loop.json written before the clock existed counts from started_at.
  const started = minutesAgo(90);
  editLoop(project, (loop) => { delete loop.clock_started_at; loop.started_at = started; });
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 90);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.equal(status.loop.exhausted, true);
});

test('an edited Spec that was not exported asks to repair it, and a new export ends the loop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const written = readFileSync(loopPath(project), 'utf8');

  writeSpec(repo, REVISED);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'repair_spec', JSON.stringify(status.next));
  assert.equal(status.ended, null);

  // The exported Spec put back resumes the loop.
  writeSpec(repo, SPECS.two);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');

  writeSpec(repo, REVISED);
  const exported = exportSpec(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.next.route, 'write-eval');
  assert.deepEqual([status.ended.spec, status.ended.loop_spec, status.ended.accepted], [exported.id, project.loop.spec, false]);
  assert.equal(readFileSync(loopPath(project), 'utf8'), written);
});

// L4: the order of next.action.

test('a full run that did not complete asks to repair execution, and stops on budget once the runs are used up', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'break the environment');
  const first = startRun(repo, CHANGE);
  assert.equal(first.execution_status, 'error');
  assert.equal(first.scope, 'full');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.next.action, 'repair_execution', JSON.stringify(status.next));
  assert.equal(status.next.route, 'run-eval');

  const second = startRun(repo, CHANGE);
  assert.equal(second.execution_status, 'error');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 2);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.equal(status.next.owner, 'user');
  refusedBeforeRun(project, {}, 'stop_budget');
});

test('with the budget used up, a passing run still asks for its report, its review and acceptance before the budget stops it', (t) => {
  const { repo } = inLoop(t, { iterations: 1 });
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.next.action, 'write_report');
  completeReport(repo, run.run_id, { review: false });
  assert.equal(loopStatus(repo, CHANGE).next.action, 'final_review');
  completeReport(repo, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'ask_acceptance');
  assert.equal(status.next.owner, 'user');
});

test('with the budget used up, a regression stops on budget', (t) => {
  const { repo } = inLoop(t, { iterations: 1 });
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice');
  const run = fullRun(repo);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'write_report');
  completeReport(repo, run.run_id);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions, [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.match(status.next.message, /submit-success-s1\/c1/);
});

test('with the budget used up, a stuck loop stops on budget', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  changeCode(repo, BEFORE, 'first attempt');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, BEFORE, 'second attempt');
  completeReport(repo, fullRun(repo).run_id);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.equal(status.stop.action, 'stop_stuck');
});

// L5: regressions and lost progress compare the same package only.

test('without a baseline result, a check that passed in the run before and fails now is a regression', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.execution_status, 'not_run');
  startLoop(repo, CHANGE);
  changeCode(repo, AFTER, 'first version');
  const first = fullRun(repo);
  assert.equal(first.verdict, 'pass');
  completeReport(repo, first.run_id);
  changeCode(repo, BROKEN, 'second version');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.ok(status.checks.every((entry) => entry.baseline_comparable === false), JSON.stringify(status.checks));
  assert.deepEqual(status.regressions, [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assert.equal(status.next.action, 'split_changes');
});

// L6: acceptance belongs to one loop.

test('after acceptance loop status reports done with who accepted, even with the budget used up, and warns once the code moves past the accepted run', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.equal(record.loop_started_at, loopRecord(project).started_at);

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.deepEqual(status.accepted, { run_id: run.run_id, by: 'Dana', ref: 'review thread 12', at: record.accepted.at });
  assert.equal(status.next.action, 'done', JSON.stringify(status.next));
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
  const shown = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.next.action, 'done');

  // Code that moved past the accepted run is no longer covered: with the
  // budget used up, the loop has ended, and a bigger budget goes to a new one.
  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'an edit after the acceptance\n');
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.match(status.next.message, new RegExp(`The code changed after ${run.run_id}, the run the user accepted, so the acceptance no longer covers it`));
  assert.doesNotMatch(status.next.message, /merge|pull request|Offer to commit/);
  assert.equal(status.accepted.outdated, true);
  assert.ok(status.warnings.some((warning) => /acceptance covers that run's code only/i.test(warning)), JSON.stringify(status.warnings));
  rmSync(scratch);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  // The Spec comes before acceptance: an edit without export, then a new
  // export, which ends the accepted loop too. The end is worked out, so the
  // Spec written back gives done again.
  writeSpec(repo, REVISED);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'repair_spec');
  exportSpec(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.ended.accepted, true);
  writeSpec(repo, SPECS.two);
  assert.equal(loopStatus(repo, CHANGE).next.action, 'done');

  // Once the code moved on, the budget refuses another run.
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'an edit after the acceptance');
  refusedBeforeRun(project, {}, 'stop_budget');
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status.next, repo, 'budget_used_up');
  assert.equal(status.accepted.run_id, run.run_id);
  assert.equal(status.accepted.outdated, true);
});

test('a loop for a newly exported Spec can accept its own passing run, and the record keeps the earlier Spec\'s acceptance under earlier', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  editApp(repo, AFTER, 'first Spec');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  acceptLoop(repo, CHANGE, { run: first.run_id, by: 'Dana', ref: 'thread 1' });
  const earlier = readJSON(file);

  // Once the user accepted the loop, the baseline of the new export goes on
  // the accepted code, and the loop for it starts there.
  const firstLoop = loopRecord(project);
  const exported = exportRevision(project);
  let status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.ended.accepted, true);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' }) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  startLoop(repo, CHANGE);
  const loop = loopRecord(project);
  assert.equal(loop.spec, exported.id);
  assert.equal(loop.baseline, base.run_id);
  assert.deepEqual(loop.follows, { loop_started_at: firstLoop.started_at, run_id: first.run_id, spec: firstLoop.spec });
  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.loop.follows, loop.follows);
  assert.equal(status.accepted, null);
  assert.equal(status.next.action, 'iterate');

  editApp(repo, AFTER, 'second Spec');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  acceptLoop(repo, CHANGE, { run: second.run_id, by: 'Lee', ref: 'thread 2' });
  const record = readJSON(file);
  assert.equal(record.run_id, second.run_id);
  assert.equal(record.spec.sha256, exported.id);
  assert.equal(record.loop_started_at, loop.started_at);
  assert.deepEqual(record.earlier, [withoutKey(earlier, 'earlier')]);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'done');
  assert.equal(status.accepted.run_id, second.run_id);
});

test('an accepted.json without loop_started_at belongs to a loop when its Spec matches and its run is one of that loop\'s runs', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  const save = (record) => writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  editApp(repo, AFTER, 'the fix');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const legacy = withoutKey(readJSON(file), 'loop_started_at');

  save(legacy);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.accepted, { run_id: run.run_id, by: 'Dana', ref: 'thread 1', at: legacy.accepted.at });
  assert.equal(status.next.action, 'done');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('already_accepted'));

  // Another Spec, or a run this loop never made, is not this loop's acceptance.
  save({ ...legacy, spec: { ...legacy.spec, sha256: `sha256:${'0'.repeat(64)}` } });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted, null);
  assert.equal(status.next.action, 'ask_acceptance');
  save({ ...legacy, run_id: '20990101-000000-0000' });
  assert.equal(loopStatus(repo, CHANGE).accepted, null);

  // Once the code moved past it with the budget used up, the loop has ended;
  // in a new loop the run it names belongs to the loop before.
  save(legacy);
  restoreStart(project);
  assertStopBudget(loopStatus(repo, CHANGE).next, repo, 'budget_used_up');
  startLoop(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.accepted, null);
  assert.equal(status.next.action, 'iterate');
  editApp(repo, AFTER, 'the fix again');
  const again = fullRun(repo);
  completeReport(repo, again.run_id);
  acceptLoop(repo, CHANGE, { run: again.run_id, by: 'Lee', ref: 'thread 3' });
  const record = readJSON(file);
  assert.equal(record.run_id, again.run_id);
  assert.deepEqual(record.earlier, [legacy]);
});

// L7: code in the loop moves impact.md evidence.

test('code in the loop that moves a file impact.md evidence points to keeps the exported Spec: loop status, run start and workflow check go on, and run start and workflow check warn', (t) => {
  const project = impactLoop(t);
  const { repo, loop } = project;
  renameSync(path.join(repo, 'app/notify.py'), path.join(repo, 'app/notifier.py'));
  setResults(repo, AFTER);
  commit(repo, 'Move the notifier and stop the success notice on failure');
  // The working tree no longer holds the evidence the export recorded.
  const strict = validateSpec(repo, CHANGE);
  assert.ok(strict.gaps.some((entry) => entry.code === 'impact_invalid' && entry.working_tree), JSON.stringify(strict.gaps));

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate', JSON.stringify(status.next));

  const checked = cli(['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(checked.json.status, 'ready');
  assert.deepEqual(checked.json.gaps, []);
  assert.equal(checked.json.next.action, 'loop_status');
  assert.match(checked.json.warnings.join('\n'), MOVED);

  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  assert.match(run.warnings.join('\n'), MOVED);
  const record = runRecord(project, run);
  assert.equal(record.spec_snapshot.sha256, loop.spec);
  assert.equal(record.baseline, loop.baseline);

  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.next.action, 'write_report', JSON.stringify(status.next));
});

test('code in the loop that deletes a file impact.md evidence points to keeps the loop on the same exported Spec', (t) => {
  const project = impactLoop(t);
  const { repo, loop } = project;
  rmSync(path.join(repo, 'app/notify.py'));
  setResults(repo, AFTER);

  assert.equal(loopStatus(repo, CHANGE).next.action, 'iterate');
  const checked = cli(['workflow', 'check', 'loop-and-implement', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(checked.json.next.action, 'loop_status');
  assert.match(checked.json.warnings.join('\n'), MOVED);

  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  assert.match(run.warnings.join('\n'), MOVED);
  assert.equal(runRecord(project, run).spec_snapshot.sha256, loop.spec);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.next.action, 'ask_acceptance', JSON.stringify(status.next));
});

test('loop status warns that impact.md evidence no longer matches the code once code in the loop deleted the file it points to', (t) => {
  const project = impactLoop(t);
  const { repo } = project;
  rmSync(path.join(repo, 'app/notify.py'));
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.next.action, 'iterate');
  assert.ok(status.warnings.some((warning) => MOVED.test(warning)), JSON.stringify(status.warnings));
});

test('once the budget is used up and only the final review is left, run start names that step, and loop start may begin a new loop', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id, { review: false });
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.loop.exhausted, status.stop], ['final_review', true, null]);
  const refusal = refusedBeforeRun(project, {}, 'stop_budget');
  assert.ok(refusal.message.endsWith('Finish the step `loop status` names: the report, the final review or the user\'s acceptance. If the user wants more runs instead, a bigger budget goes to a new loop once they agree: `loop start --max-iterations N --max-minutes M` starts one now that no head run is left in this one.'), refusal.message);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'loop_status');
  // Doing what the refusal says, with the user's bigger budget.
  const next = startLoop(repo, CHANGE, { iterations: 3 });
  assert.deepEqual([next.loop.budget.iterations, next.loop.previous.length], [3, 1]);
});
