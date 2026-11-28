// Loop tests: the budget and what it counts, ends and new loops, where a loop
// stands, comparisons of the same package, acceptance across loops and impact
// evidence.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initProject, projectRoot, readJSON } from '../src/project.js';
import { exportSpec, newSpec, validateSpec } from '../src/spec.js';
import { newEval } from '../src/eval.js';
import { checkEval, codeSnapshot, startRun } from '../src/run.js';
import { acceptLoop, loopStatus } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FIXTURES, SPECS, cli, commit, commitConfirmation, confirmChecks, connect, git, readRecord,
  readyProject, reviewFixtures, setResults, useFakeTools, writeExpectations, writeFixtureScripts, writeSpec,
} from './helpers/edd.js';
import {
  EXPECT, BROKEN, CONSENT, REF, USER, actionOf, assertGapShape, codes, refusedWith, withBaseline, inLoop, changeCode, fullRun, completeReport, runRecord, FAILURE, SUCCESS,
  REVISED, loopPath, loopRecord, editLoop, minutesAgo, near, withoutKey, assertStopBudget, editApp, restoreStart, exportRevision, reviewRun, startLoop,
  refusedBeforeRun, assertEnded,
} from './helpers/loop.js';

// --- The budget, ends and new loops, where a loop stands, same-package
// comparison, acceptance across loops and moved impact evidence. ---

const IMPACT = '---\ngenesis_impact: 1\nentries:\n  - entry: notify()\n    effect: changes\n    evidence: app/notify.py:2\n---\n';

// Sets the run minutes a run record says the run took, as if Docker had
// taken that long: the budget counts these, not the time between runs.
function setRunMinutes(project, run, minutes) {
  const file = path.join(project.runs, run.run_id, 'run.json');
  const record = readJSON(file);
  record.usage = { ...record.usage, minutes };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

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

// That project with its baseline recorded and a loop the user agreed to,
// started on the code before the change.
function impactLoop(t) {
  const project = projectWithImpact(t);
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const { loop } = startLoop(project.repo, CHANGE);
  assert.equal(loop.spec, project.spec);
  return { ...project, base, loop };
}

// loop.json.

test('loop start records the code it starts from, the user\'s consent and the budget, and starts the clock with the loop', (t) => {
  const project = withBaseline(t);
  const { repo, base } = project;
  const head = git(repo, ['rev-parse', 'HEAD']);
  const started = startLoop(repo, CHANGE);
  const loop = loopRecord(project);
  assert.deepEqual(loop.start_code, { commit: head, digest: readRecord(base).run.code_snapshot.digest, digest_of: 'content' });
  assert.equal(loop.start_code.digest, codeSnapshot(repo).snapshot.digest);
  assert.equal(loop.clock_started_at, loop.started_at);
  assert.equal(loop.extensions, undefined);
  assert.deepEqual(loop.previous ?? [], []);
  // Who agreed to the loop, and where, is kept with it.
  assert.deepEqual(loop.consent, { by: USER, ref: REF, at: loop.started_at });
  assert.deepEqual(started.consent, loop.consent);
  // The budget is the one the user confirmed, kept as the original with no revision yet.
  assert.deepEqual(loop.budget, project.confirmation.confirmation.run_plan.budget);
  assert.deepEqual([loop.budget_original, loop.budget_revisions, loop.budget_source], [loop.budget, [], 'confirmation']);
  const decisions = readFileSync(path.join(project.root, 'decisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const recorded = decisions.filter((entry) => entry.type === 'loop_start');
  assert.equal(recorded.length, 1, JSON.stringify(decisions));
  assert.deepEqual([recorded[0].loop_started_at, recorded[0].by, recorded[0].ref, recorded[0].baseline], [loop.started_at, USER, REF, base.run_id]);
});

// The budget counts run minutes: the time between runs does not count.

test('the budget counts the minutes runs take, not the time between them, and an older loop.json with a clock budget counts from started_at', (t) => {
  const project = inLoop(t, { minutes: 60 });
  const { repo } = project;
  assert.deepEqual(project.loop.budget, { iterations: 5, minutes: null, run_minutes: 60 });
  let status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 0);
  assert.equal(status.loop.used.run_minutes, 0);

  // Hours waiting for the user spend nothing.
  editLoop(project, (loop) => { loop.clock_started_at = minutesAgo(90); });
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 90);
  assert.deepEqual([status.phase, status.loop.exhausted, status.situation.code], ['live', false, 'open']);

  // A run that took 61 minutes of Docker time uses up 60 run minutes.
  changeCode(repo, BEFORE, 'first attempt');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'fail');
  setRunMinutes(project, run, 61);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.run_minutes, 61);
  assert.equal(status.loop.used.iterations, 1);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.loop.exhausted, true);
  setRunMinutes(project, run, 1);

  // A loop.json written before run minutes, with a clock budget and no
  // clock of its own, counts the minutes since it started.
  editLoop(project, (loop) => { delete loop.clock_started_at; loop.budget = { iterations: 5, minutes: 60 }; });
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 0);
  assert.equal(status.loop.exhausted, false);
  editLoop(project, (loop) => { loop.started_at = minutesAgo(90); });
  status = loopStatus(repo, CHANGE);
  near(status.loop.used.minutes, 90);
  assertStopBudget(status, 'budget_used_up');
});

test('an edited Spec that was not exported is reported as a Spec that differs, and a new export ends the loop', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  const written = readFileSync(loopPath(project), 'utf8');

  writeSpec(repo, REVISED);
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'spec_invalid', JSON.stringify(status.situation));
  assert.equal(status.situation.spec_edited, true);
  assert.equal(status.situation.layer, 'spec');
  assert.equal(status.ended, null);
  assert.equal(status.suggestion, null);
  assert.ok(status.gates.accept.some((entry) => entry.code === 'spec_changed'), JSON.stringify(status.gates.accept));

  // The exported Spec put back lets the loop go on.
  writeSpec(repo, SPECS.two);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'open']);

  writeSpec(repo, REVISED);
  const exported = exportSpec(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assertGapShape(status.gates.head_run, { code: 'loop_ended', layer: 'spec', owner: 'user' });
  assert.deepEqual([status.ended.spec, status.ended.loop_spec, status.ended.accepted], [exported.id, project.loop.spec, false]);
  assert.ok(status.ended.new_loop.consents.includes('checks_confirmation'), JSON.stringify(status.ended.new_loop));
  assert.equal(readFileSync(loopPath(project), 'utf8'), written);
});

// Where a loop stands.

test('a full run that did not complete is reported as incomplete, and the loop ends on its budget once the runs are used up', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'break the environment');
  const first = startRun(repo, CHANGE);
  assert.equal(first.execution_status, 'error');
  assert.equal(first.scope, 'full');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.situation.code, 'execution_incomplete', JSON.stringify(status.situation));
  assert.equal(status.situation.run_id, first.run_id);
  assert.deepEqual(status.suggestion?.command, ['run', 'start', CHANGE, '--repo', repo]);

  const second = startRun(repo, CHANGE);
  assert.equal(second.execution_status, 'error');
  status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 2);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.ended.situation.code, 'execution_incomplete');
  assert.equal(status.gates.head_run.owner, 'user');
  // The loop ended without acceptance, so the change is locked until the
  // user decides; the lock names the end.
  const refusal = refusedBeforeRun(project, {}, 'change_locked');
  assertGapShape(refusal, { code: 'change_locked', owner: 'user', layer: 'loop', reason: 'stop_budget' });
});

test('with the budget used up, a passing run can still be reviewed and accepted, but takes no more head runs', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.deepEqual([status.phase, status.loop.exhausted, status.situation.code, status.ended], ['closing', true, 'acceptable', null]);
  // The report is written with the run; acceptance waits for a final review.
  assert.equal(status.runs[0].report, 'written');
  assert.ok(status.gates.accept.some((entry) => entry.code === 'review_missing'), JSON.stringify(status.gates.accept));
  assert.deepEqual(status.suggestion.command.slice(0, 2), ['loop', 'review']);
  // No further head run is made in it.
  const refusal = refusedBeforeRun(project, {}, 'stop_budget');
  assertGapShape(refusal, { code: 'stop_budget', owner: 'user', layer: 'loop', reason: 'budget_used_up' });
  assert.deepEqual(refusal.consents.map((entry) => entry.decision), ['budget', 'new_loop']);

  reviewRun(project, run.run_id);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.situation.code, 'acceptable');
  assert.deepEqual(status.gates.accept, []);
  assert.ok(status.obligations.some((entry) => entry.kind === 'consent' && entry.decision === 'acceptance' && entry.by === 'user'), JSON.stringify(status.obligations));
  assert.deepEqual(status.suggestion.command.slice(0, 2), ['loop', 'accept']);
  assert.ok(status.must_show.budget, JSON.stringify(Object.keys(status.must_show)));
});

test('with the budget used up, a regression ends the loop on its budget and names the check', (t) => {
  const { repo } = inLoop(t, { iterations: 1 });
  changeCode(repo, BROKEN, 'fix the failure notice and break the success notice');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.regressions.map(({ case: id, check, intent }) => ({ case: id, check, intent })), [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success' }]);
  assertStopBudget(status, 'budget_used_up');
  assert.deepEqual(status.ended.regressions.map((entry) => `${entry.case}/${entry.check}`), [`${SUCCESS}/c1`]);
  assert.match(status.ended.message, /submit-success-s1\/c1/);
});

test('with the budget used up, a stuck loop ends on its budget, and stuck stays a warning', (t) => {
  const { repo } = inLoop(t, { iterations: 2 });
  changeCode(repo, BEFORE, 'first attempt');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, BEFORE, 'second attempt');
  completeReport(repo, fullRun(repo).run_id);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.ended.stuck, true);
  // Without the user asking for it in the plan, stuck stops nothing.
  assert.equal(status.stop, null);
  assert.ok(status.warnings.some((warning) => warning.startsWith('stuck: ')), JSON.stringify(status.warnings));
});

// Regressions and lost progress compare the same package only.

test('without a baseline result, a check that passed in the run before and fails now is a regression', (t) => {
  const project = readyProject(t, { tier: 'full' });
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
  assert.deepEqual(status.regressions.map(({ case: id, check, intent, last_passed: passed }) => ({ case: id, check, intent, passed })),
    [{ case: SUCCESS, check: 'c1', intent: 'REQ-submit-success', passed: first.run_id }]);
  assert.equal(status.situation.code, 'regression', JSON.stringify(status.situation));
  assert.equal(status.phase, 'live');
});

// Acceptance belongs to one loop.

test('after acceptance loop status reports done with who accepted, even with the budget used up, and the acceptance stops covering code that moved past the accepted run', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'review thread 12' });
  const record = readJSON(path.join(root, 'accepted.json'));
  assert.equal(record.loop_started_at, loopRecord(project).started_at);

  let status = loopStatus(repo, CHANGE);
  assert.equal(status.loop.used.iterations, 1);
  assert.equal(status.accepted, true);
  assert.deepEqual(status.acceptance, { run_id: run.run_id, by: 'Dana', ref: 'review thread 12', at: record.accepted.at, holds: true });
  assert.deepEqual([status.phase, status.situation.code], ['done', 'accepted'], JSON.stringify(status.situation));
  assert.equal(status.suggestion, null);
  assert.ok(!status.warnings.some((warning) => /covers that run's code only/.test(warning)), JSON.stringify(status.warnings));
  const shown = cli(['loop', 'status', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.phase, 'done');

  // Code that moved past the accepted run is no longer covered: with the
  // budget used up, the loop has ended on it.
  const scratch = path.join(repo, 'app/scratch.txt');
  writeFileSync(scratch, 'an edit after the acceptance\n');
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.ended.situation.code, 'code_moved');
  assert.equal(status.ended.situation.accepted_run, true);
  assert.match(status.ended.situation.message, new RegExp(`The code changed after ${run.run_id}, the run the user accepted, so the acceptance no longer covers it`));
  assert.doesNotMatch(status.ended.message, /merge|pull request|Offer to commit/);
  assert.equal(status.acceptance.outdated, true);
  assert.ok(status.warnings.some((warning) => /acceptance covers that run's code only/i.test(warning)), JSON.stringify(status.warnings));
  rmSync(scratch);
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  // An edit of the Spec files is not an export, so the accepted loop stays
  // done. A new export ends the accepted loop. The end is worked out from the
  // current export: the Spec written back is not exported, so the loop stays
  // ended until the loop's own Spec is exported again, which gives done again.
  writeSpec(repo, REVISED);
  assert.deepEqual([loopStatus(repo, CHANGE).phase, loopStatus(repo, CHANGE).situation.code], ['done', 'accepted']);
  exportSpec(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assertEnded(status, 'spec_exported');
  assert.equal(status.ended.accepted, true);
  assert.equal(status.accepted, true);
  writeSpec(repo, SPECS.two);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.reason, status.accepted], ['ended', 'ended', 'spec_exported', true], JSON.stringify(status.situation));
  assert.equal(exportSpec(repo, CHANGE).id, project.loop.spec);
  assert.equal(loopStatus(repo, CHANGE).phase, 'done');

  // Once the code moved on, no further head run is made in the loop.
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'an edit after the acceptance');
  const calls = project.tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
    // Which of the two refuses is asserted on its own in loop-consent.test.js.
    assert.ok(codes(error.gaps).some((code) => ['stop_budget', 'change_locked'].includes(code)), JSON.stringify(error.gaps));
    return true;
  });
  assert.equal(project.tools.runs().length, calls);
  status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.acceptance.run_id, run.run_id);
  assert.equal(status.acceptance.outdated, true);
});

test('a loop for a newly exported Spec can accept its own passing run, and the record keeps the earlier Spec\'s acceptance under earlier', (t) => {
  const project = inLoop(t);
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  editApp(repo, AFTER, 'first Spec');
  const first = fullRun(repo);
  completeReport(repo, first.run_id);
  reviewRun(project, first.run_id);
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
  assert.equal(status.accepted, false);
  assert.equal(status.acceptance, null);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'open']);

  editApp(repo, AFTER, 'second Spec');
  const second = fullRun(repo);
  completeReport(repo, second.run_id);
  reviewRun(project, second.run_id);
  acceptLoop(repo, CHANGE, { run: second.run_id, by: 'Lee', ref: 'thread 2' });
  const record = readJSON(file);
  assert.equal(record.run_id, second.run_id);
  assert.equal(record.spec.sha256, exported.id);
  assert.equal(record.loop_started_at, loop.started_at);
  assert.deepEqual(record.earlier, [withoutKey(earlier, 'earlier')]);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.phase, 'done');
  assert.equal(status.acceptance.run_id, second.run_id);
});

test('an accepted.json without loop_started_at belongs to a loop when its Spec matches and its run is one of that loop\'s runs', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo, root } = project;
  const file = path.join(root, 'accepted.json');
  const save = (record) => writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  editApp(repo, AFTER, 'the fix');
  const run = fullRun(repo);
  completeReport(repo, run.run_id);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 1' });
  const legacy = withoutKey(readJSON(file), 'loop_started_at');

  save(legacy);
  let status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.acceptance, { run_id: run.run_id, by: 'Dana', ref: 'thread 1', at: legacy.accepted.at, holds: true });
  assert.equal(status.phase, 'done');
  assert.throws(() => acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 2' }), refusedWith('already_accepted'));

  // Another Spec, or a run this loop never made, is not this loop's acceptance.
  save({ ...legacy, spec: { ...legacy.spec, sha256: `sha256:${'0'.repeat(64)}` } });
  status = loopStatus(repo, CHANGE);
  assert.equal(status.acceptance, null);
  assert.equal(status.situation.code, 'acceptable');
  save({ ...legacy, run_id: '20990101-000000-0000' });
  assert.equal(loopStatus(repo, CHANGE).acceptance, null);

  // Once the code moved past it with the budget used up, the loop has ended;
  // in a new loop the run it names belongs to the loop before.
  save(legacy);
  restoreStart(project);
  assertStopBudget(loopStatus(repo, CHANGE), 'budget_used_up');
  startLoop(repo, CHANGE);
  status = loopStatus(repo, CHANGE);
  assert.equal(status.acceptance, null);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'open']);
  editApp(repo, AFTER, 'the fix again');
  const again = fullRun(repo);
  completeReport(repo, again.run_id);
  reviewRun(project, again.run_id);
  acceptLoop(repo, CHANGE, { run: again.run_id, by: 'Lee', ref: 'thread 3' });
  const record = readJSON(file);
  assert.equal(record.run_id, again.run_id);
  assert.deepEqual(record.earlier, [legacy]);
});

// Code in the loop moves impact.md evidence. Later stages check the export by
// its digest, so the loop goes on with the Spec as exported.

test('code in the loop that moves a file impact.md evidence points to keeps the exported Spec: loop status, run start and workflow status go on', (t) => {
  const project = impactLoop(t);
  const { repo, loop } = project;
  renameSync(path.join(repo, 'app/notify.py'), path.join(repo, 'app/notifier.py'));
  setResults(repo, AFTER);
  commit(repo, 'Move the notifier and stop the success notice on failure');
  // The working tree no longer holds the evidence the export recorded: the
  // draft's validation warns, and nothing refuses.
  const strict = validateSpec(repo, CHANGE);
  assert.ok(strict.warnings.some((warning) => warning.startsWith('impact.md: entries[0] evidence does not point to a file in the project: app/notify.py:2')), JSON.stringify(strict.warnings));
  assert.ok(!strict.gaps.some((entry) => entry.code === 'impact_invalid'), JSON.stringify(strict.gaps));

  let status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code], ['live', 'open'], JSON.stringify(status.situation));

  const checked = cli(['workflow', 'status', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.deepEqual(checked.json.layers.spec.gaps, []);
  assert.equal(checked.json.layers.spec.export_holds, true);
  assert.equal(checked.json.layers.loop.phase, 'live');
  const headRun = checked.json.actions.find((entry) => entry.command.join(' ') === ['run', 'start', CHANGE, '--repo', repo].join(' '));
  assert.deepEqual([headRun?.allowed, headRun?.in_loop, headRun?.blocked_by], [true, true, []], JSON.stringify(headRun));

  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  const record = runRecord(project, run);
  assert.equal(record.spec_snapshot.sha256, loop.spec);
  assert.equal(record.baseline, loop.baseline);

  status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
});

test('code in the loop that deletes a file impact.md evidence points to keeps the loop on the same exported Spec', (t) => {
  const project = impactLoop(t);
  const { repo, loop } = project;
  rmSync(path.join(repo, 'app/notify.py'));
  setResults(repo, AFTER);

  assert.equal(loopStatus(repo, CHANGE).situation.code, 'open');
  const checked = cli(['workflow', 'status', CHANGE, '--repo', repo]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.deepEqual(checked.json.layers.spec.gaps, []);
  assert.equal(checked.json.layers.loop.phase, 'live');

  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  assert.equal(runRecord(project, run).spec_snapshot.sha256, loop.spec);
  completeReport(repo, run.run_id);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual(status.runs.map((entry) => entry.run_id), [run.run_id]);
  assert.equal(status.situation.code, 'acceptable', JSON.stringify(status.situation));
});

test('once the budget is used up and only the review and acceptance are left, run start says so, and the user may revise the budget or start a new loop', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  fullRun(repo);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.loop.exhausted, status.stop, status.situation.code], ['closing', true, null, 'acceptable']);
  const refusal = refusedBeforeRun(project, {}, 'stop_budget');
  assert.ok(refusal.message.endsWith('A passing run of it can still be reviewed and accepted.'), refusal.message);
  assert.deepEqual(refusal.consents, [{ decision: 'budget', by: 'user', command: ['loop', 'budget', CHANGE] }, { decision: 'new_loop', by: 'user', command: ['loop', 'start', CHANGE] }]);
  // workflow status lists both decisions of the user, with the review.
  const workflow = workflowStatus(repo, CHANGE);
  assert.ok(actionOf(workflow, 'loop', 'review')?.allowed, JSON.stringify(workflow.actions.map((entry) => entry.command)));
  const budget = actionOf(workflow, 'loop', 'budget');
  assert.deepEqual([budget?.by, budget?.needed], ['user', true]);
  assert.ok(codes([{ code: actionOf(workflow, 'run', 'start')?.blocked_by[0] }]).includes('stop_budget'), JSON.stringify(actionOf(workflow, 'run', 'start')));
  // A new loop with the user's bigger budget can start now that no head run is left in this one.
  const next = startLoop(repo, CHANGE, { iterations: 3 });
  assert.deepEqual([next.loop.budget.iterations, next.loop.previous.length], [3, 1]);
  assert.equal(next.loop.consent.by, CONSENT.by);
});
