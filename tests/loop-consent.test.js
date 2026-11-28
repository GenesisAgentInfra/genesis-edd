// Loop tests: the user's consent to a loop and to its budget, budget
// revisions, the estimates a budget is checked against, the host variables a
// run passes, and stuck as a warning.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { checkEval, startRun } from '../src/run.js';
import { acceptLoop, budgetLoop, endLoop, loopStatus, startLoop as startLoopBare } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import { AFTER, BEFORE, CHANGE, cli, commit, confirmChecks, harborThen, readyProject, writeExpectations } from './helpers/edd.js';
import {
  CONSENT, CONSENT_FLAGS, EXPECT, REF, USER, actionOf, assertEnded, assertGapShape, assertStopBudget, changeCode, codes, completeReport, FAILURE, SUCCESS,
  fullRun, gapOf, inLoop, loopPath, loopRecord, refusedBeforeRun, reviewRun, startLoop, withBaseline,
} from './helpers/loop.js';

const decisionsOf = (project, type) => {
  const file = path.join(project.root, 'decisions.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === type);
};

// The refusal of a loop start, with its gaps.
function refusedStart(repo, options, ...expected) {
  let gaps = null;
  assert.throws(() => startLoopBare(repo, CHANGE, options), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    gaps = error.gaps;
    for (const code of expected) assert.ok(codes(gaps).includes(code), `expected ${code} in ${JSON.stringify(gaps)}`);
    return true;
  });
  return gaps;
}

// Sets what a run record says the run took and its attempts took, in
// minutes, as if Docker had spent the difference building and starting.
function setRunUsage(project, runId, minutes, attemptMinutes) {
  const file = path.join(project.runs, runId, 'run.json');
  const record = readJSON(file);
  record.usage = { ...record.usage, minutes, attempt_minutes: attemptMinutes };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

// --- The user's consent to a loop ---

test('loop start without --by and --ref is refused as the user\'s decision, and writes nothing', (t) => {
  const project = withBaseline(t);
  const { repo } = project;
  const gaps = refusedStart(repo, {}, 'loop_consent_missing');
  assertGapShape(gapOf({ gaps }, 'loop_consent_missing'), { owner: 'user', layer: 'loop', kind: 'business', start_loop: false, loop_started_since: false });
  assert.equal(existsSync(loopPath(project)), false);
  assert.deepEqual(decisionsOf(project, 'loop_start'), []);
  // Who agreed and where go together.
  assert.throws(() => startLoopBare(repo, CHANGE, { by: USER }), /--by and --ref go together/);
  assert.throws(() => startLoopBare(repo, CHANGE, { ref: REF }), /--by and --ref go together/);
  assert.equal(existsSync(loopPath(project)), false);
  // The same through the CLI, and then with the user's words.
  const refused = cli(['loop', 'start', CHANGE, '--repo', repo]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.code, 'LOOP_INPUT_BLOCKED');
  assert.ok(codes(refused.json.gaps).includes('loop_consent_missing'), JSON.stringify(refused.json.gaps));
  const started = cli(['loop', 'start', CHANGE, '--repo', repo, ...CONSENT_FLAGS]);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual([started.json.consent.by, started.json.consent.ref], [USER, REF]);
  const [decision] = decisionsOf(project, 'loop_start');
  assert.deepEqual([decision.by, decision.ref, decision.loop_started_at], [USER, REF, started.json.loop.started_at]);
});

test('a confirmation made with --start-loop is the consent to the loop that directly follows it, and to no later one', (t) => {
  const project = withBaseline(t, { startLoop: true });
  const { repo } = project;
  const { confirmation } = project.confirmation;
  assert.equal(confirmation.start_loop, true);
  // workflow status names that consent, and asks for no --by and --ref.
  const start = actionOf(workflowStatus(repo, CHANGE), 'loop', 'start');
  assert.ok(!start.command.includes('--by'), JSON.stringify(start.command));
  assert.ok(start.needs.includes(`user consent: recorded by checks confirmation ${confirmation.id}`), JSON.stringify(start.needs));
  const started = startLoopBare(repo, CHANGE);
  assert.deepEqual(started.consent, { via: 'confirmation', confirmation: confirmation.id, by: USER, ref: REF, at: confirmation.confirmed.at });
  assert.deepEqual(loopRecord(project).consent, started.consent);
  const [decision] = decisionsOf(project, 'loop_start');
  assert.deepEqual([decision.via, decision.confirmation, decision.by], ['confirmation', confirmation.id, undefined]);
  // Once a loop started after it, that confirmation agrees to no other.
  endLoop(repo, CHANGE, { reason: 'synthetic: the agent ends the loop' });
  const gaps = refusedStart(repo, {}, 'loop_consent_missing');
  assertGapShape(gapOf({ gaps }, 'loop_consent_missing'), { owner: 'user', layer: 'loop', confirmation: confirmation.id, start_loop: true, loop_started_since: true });
  assert.ok(actionOf(workflowStatus(repo, CHANGE), 'loop', 'start').command.includes('--by'));
  // The user's own words start the next one.
  assert.deepEqual(startLoopBare(repo, CHANGE, CONSENT).consent.by, USER);
});

// --- Budgets and their revisions are the user's decisions ---

test('a budget above the confirmed one needs the user\'s consent at loop start, which is kept with the loop and as a decision', (t) => {
  // The confirmation's --start-loop agrees to the loop, not to a bigger budget.
  const project = withBaseline(t, { startLoop: true });
  const { repo } = project;
  const confirmed = project.confirmation.confirmation.run_plan.budget;
  const gaps = refusedStart(repo, { iterations: confirmed.iterations + 1 }, 'budget_over_confirmed');
  assert.deepEqual(codes(gaps), ['budget_over_confirmed']);
  assertGapShape(gaps[0], { owner: 'user', layer: 'loop', kind: 'business', confirmed_budget: confirmed });
  assert.equal(gaps[0].budget.iterations, confirmed.iterations + 1);
  assert.equal(existsSync(loopPath(project)), false);
  // A smaller budget is no bigger decision than the user made.
  const smaller = withBaseline(t, { startLoop: true });
  assert.equal(startLoopBare(smaller.repo, CHANGE, { iterations: 2 }).loop.budget.iterations, 2);
  assert.equal(loopRecord(smaller).budget_consent, undefined);
  // With the user's words the bigger budget starts, and both are kept.
  const started = startLoopBare(repo, CHANGE, { ...CONSENT, iterations: confirmed.iterations + 1 });
  assert.deepEqual(started.loop.budget_consent, { by: USER, ref: REF, at: started.loop.started_at });
  assert.deepEqual(started.loop.confirmed_budget, confirmed);
  const [decision] = decisionsOf(project, 'loop_start');
  assert.deepEqual([decision.by, decision.budget_over_confirmed, decision.budget.iterations], [USER, true, confirmed.iterations + 1]);
});

test('loop budget revises a running loop\'s budget only with the user\'s words, and every revision is kept and shown at acceptance', (t) => {
  const project = inLoop(t, { iterations: 2 });
  const { repo } = project;
  const original = project.loop.budget;
  assert.throws(() => budgetLoop(repo, CHANGE, { iterations: 4 }), /--by and --ref name who agreed to the budget/);
  assert.throws(() => budgetLoop(repo, CHANGE, { by: 'Dana', ref: 'thread 3' }), /Give at least one of --max-iterations/);
  assert.deepEqual(loopRecord(project).budget_revisions, []);
  changeCode(repo, BEFORE, 'first attempt');
  const first = fullRun(repo);
  const revised = budgetLoop(repo, CHANGE, { by: 'Dana', ref: 'thread 3', iterations: 4 });
  assert.deepEqual(revised.budget, { ...original, iterations: 4 });
  assert.deepEqual([revised.phase, revised.resumed, revised.exhausted], ['live', false, false]);
  const { revision } = revised;
  assert.deepEqual([revision.by, revision.ref, revision.from, revision.to, revision.after_runs, revision.resumed], ['Dana', 'thread 3', original, { ...original, iterations: 4 }, 1, false]);
  assert.equal(revision.used.iterations, 1);
  // loop.json keeps the original and the revision, and so does the decisions record.
  const loop = loopRecord(project);
  assert.deepEqual([loop.budget, loop.budget_original, loop.budget_revisions], [revised.budget, original, [revision]]);
  const [decision] = decisionsOf(project, 'loop_budget');
  assert.deepEqual([decision.loop_started_at, decision.by, decision.ref, decision.to], [loop.started_at, 'Dana', 'thread 3', revised.budget]);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.loop.budget, status.loop.budget_original, status.loop.budget_revisions], [revised.budget, original, [revision]]);
  // The acceptance shows the budget the loop started with, each revision and
  // the budget each run fell under.
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  assert.deepEqual(loopStatus(repo, CHANGE).must_show.budget, [{ original, revisions: [revision], current: revised.budget, used: loopStatus(repo, CHANGE).loop.used }]);
  const { accepted } = acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 4' });
  assert.deepEqual([accepted.budget, accepted.budget_original, accepted.budget_revisions], [revised.budget, original, [revision]]);
  assert.deepEqual(accepted.budget_by_run.map((entry) => [entry.run_id, entry.revision, entry.budget]), [[first.run_id, 0, original], [run.run_id, 1, revised.budget]]);
});

// --- A loop that ended only on its budget goes on with loop budget ---

test('a loop that ended only because its budget ran out goes on once the user revises the budget', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  fullRun(repo);
  let status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.ok(actionOf(workflowStatus(repo, CHANGE), 'loop', 'budget'), 'workflow status lists loop budget for a loop that ended on its budget');
  refusedBeforeRun(project, {}, 'change_locked');
  // A revision that leaves the budget used up keeps the loop ended.
  const short = budgetLoop(repo, CHANGE, { by: 'Dana', ref: 'thread 5', minutes: 45 });
  assert.deepEqual([short.phase, short.resumed, short.exhausted], ['ended', false, true]);
  assert.ok(short.warnings.some((warning) => warning.startsWith('The revised budget,')), JSON.stringify(short.warnings));
  const revised = budgetLoop(repo, CHANGE, { by: 'Dana', ref: 'thread 6', iterations: 3 });
  assert.deepEqual([revised.phase, revised.resumed, revised.exhausted, revised.ended], ['live', true, false, null]);
  assert.equal(revised.revision.resumed, true);
  assert.deepEqual(loopRecord(project).budget_revisions.map((entry) => entry.ref), ['thread 5', 'thread 6']);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended, status.loop.started_at], ['live', null, project.loop.started_at]);
  // The same loop takes head runs again, within the new budget.
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  assert.equal(run.verdict, 'pass');
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.loop.used.iterations, status.situation.code], [2, 'acceptable']);
});

test('loop budget does not reopen a loop that ended for another reason or that the user accepted', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  endLoop(repo, CHANGE, { reason: 'synthetic: the agent ends the loop', by: 'Dana', ref: 'thread 7' });
  assert.throws(() => budgetLoop(repo, CHANGE, { by: 'Dana', ref: 'thread 8', iterations: 9 }), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED', error.message);
    const entry = assertGapShape(gapOf(error, 'loop_ended'), { owner: 'user', layer: 'loop' });
    assert.ok(entry.message.endsWith('Only a loop that ended because its budget ran out goes on with a revised budget.'), entry.message);
    return true;
  });
  assert.deepEqual(loopRecord(project).budget_revisions, []);
  assert.deepEqual(decisionsOf(project, 'loop_budget'), []);

  const accepted = inLoop(t);
  changeCode(accepted.repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(accepted.repo);
  reviewRun(accepted, run.run_id);
  acceptLoop(accepted.repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 9' });
  assert.throws(() => budgetLoop(accepted.repo, CHANGE, { by: 'Dana', ref: 'thread 10', iterations: 9 }), (error) => {
    assertGapShape(gapOf(error, 'already_accepted'), { owner: 'user', layer: 'loop' });
    return true;
  });
});

test('a run refused after a loop ended on its budget names the budget revision among what lets it go on', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  fullRun(repo);
  assertStopBudget(loopStatus(repo, CHANGE), 'budget_used_up');
  const refusal = refusedBeforeRun(project, {}, 'change_locked');
  assert.equal(refusal.reason, 'stop_budget');
  assert.ok(refusal.unlocks.some((entry) => entry.includes('loop budget')), JSON.stringify(refusal.unlocks));
});

test('once the code moves past the run the user accepted and the loop ends, the change is locked and the gap names the outdated acceptance', (t) => {
  const project = inLoop(t, { iterations: 1 });
  const { repo } = project;
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(repo);
  reviewRun(project, run.run_id);
  acceptLoop(repo, CHANGE, { run: run.run_id, by: 'Dana', ref: 'thread 11' });
  // The code moves on with the budget used up: the loop ends on its budget.
  changeCode(repo, { ...AFTER, [SUCCESS]: 'error' }, 'an edit after the acceptance');
  const status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'budget_used_up');
  assert.equal(status.acceptance.outdated, true);
  // The acceptance no longer covers this code, so the change is locked as
  // after any end the user did not accept; the refusal names the accepted
  // run as outdated, gives the loop's own end beside the lock, and never
  // says the user did not accept.
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    const codes = error.gaps.map((gap) => gap.code);
    assert.deepEqual(codes, ['change_locked', 'stop_budget'], JSON.stringify(error.gaps));
    const lock = error.gaps[0];
    assert.deepEqual([lock.acceptance?.run_id, lock.acceptance?.outdated], [run.run_id, true], JSON.stringify(lock));
    assert.doesNotMatch(lock.message, /without the user's acceptance/);
    assert.equal(error.gaps[1].budget_reason, 'budget_used_up');
    return true;
  });
});

// --- The estimates a budget is checked against include each run's overhead ---

test('loop start checks the budget against estimates that add the baseline\'s overhead beyond its attempts to each run', (t) => {
  const project = withBaseline(t);
  const { repo, base } = project;
  // Its attempts took a second each, and the run 10 minutes more than they did.
  const usage = readJSON(path.join(project.runs, base.run_id, 'run.json')).usage;
  setRunUsage(project, base.run_id, 10 + usage.attempt_minutes, usage.attempt_minutes);
  const started = startLoop(repo, CHANGE);
  assert.deepEqual(started.loop.budget, { iterations: 5, minutes: null, run_minutes: 30 });
  assert.deepEqual([started.budget_fit.needed_minutes, started.budget_fit.fits, started.budget_fit.basis], [50, false, 'baseline_attempts'], JSON.stringify(started.budget_fit));
  assert.ok(started.warnings.some((warning) => warning.startsWith('budget_unfit: the budget is 5 full runs and 30 run minutes, but 5 runs of about 10 minutes each need about 50 run minutes')), JSON.stringify(started.warnings));
  const { estimate } = loopStatus(repo, CHANGE).loop;
  assert.deepEqual(estimate.run_overhead, { minutes: 10, baseline: base.run_id });
  assert.deepEqual([estimate.screen.minutes, estimate.full.minutes], [10, 10]);
  // Without the overhead the same attempts fit easily.
  assert.ok(Object.values(estimate.per_attempt).every((entry) => entry.minutes < 0.1), JSON.stringify(estimate.per_attempt));
});

test('the final run that cannot fit what is left of the budget, its overhead included, ends the loop on its budget, and loop budget lets it go on', (t) => {
  const project = readyProject(t, { live: [FAILURE], attempts: 3 });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  setRunUsage(project, base.run_id, 10 + base.usage.attempt_minutes, base.usage.attempt_minutes);
  startLoop(repo, CHANGE, { minutes: 8 });
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  const screen = fullRun(repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass']);
  let status = loopStatus(repo, CHANGE);
  assertStopBudget(status, 'final_run_does_not_fit');
  assert.equal(status.ended.screen_run, screen.run_id);
  // A final run of 3 and 1 attempts of a second each takes 10 minutes with the overhead.
  assert.ok(status.ended.estimate.minutes >= 10 && status.ended.estimate.minutes < 10.2, JSON.stringify(status.ended.estimate));
  assert.match(status.ended.message, new RegExp(`^Screen run ${screen.run_id} passed, but the final run \\(${FAILURE} runs 3 times and every other package once\\) takes about 10(\\.1)? minutes`));
  // The user gives the run minutes the final run needs: it is due again.
  const revised = budgetLoop(repo, CHANGE, { by: 'Dana', ref: 'thread 12', minutes: 30 });
  assert.equal(revised.resumed, true);
  status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.situation.code, status.situation.candidate], ['live', 'final_run_due', screen.run_id]);
  const final = fullRun(repo);
  assert.deepEqual([final.role, final.verdict], ['final', 'pass']);
});

// --- Host variables a run passes ---

const HOST = { API_TOKEN: 'synthetic-token', REGION: 'synthetic-region' };

// A loop whose FAILURE package asks the host for API_TOKEN and REGION (with a
// default) in task.toml, and a Harbor that records, for each package it runs,
// which of the two it was given.
function hostVariablesLoop(t) {
  const project = readyProject(t, { check: false, confirm: false });
  const { repo } = project;
  const file = path.join(project.root, 'evals', FAILURE, 'task.toml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n[environment.env]\nAPI_TOKEN = "\${API_TOKEN}"\nREGION = "\${REGION:-eu-west}"\n`);
  commit(repo, 'Ask the host for two variables');
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked, null, 2));
  confirmChecks(project);
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  assert.deepEqual(base.host_env, { mode: 'none', names: [], declared: ['API_TOKEN', 'REGION'], withheld: ['API_TOKEN', 'REGION'] });
  startLoop(repo, CHANGE);
  const saved = Object.fromEntries(Object.keys(HOST).map((key) => [key, process.env[key]]));
  Object.assign(process.env, HOST);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  harborThen(t, `appendFileSync(path.join(logs, '..', '..', 'host-env.json'), JSON.stringify({ case: path.basename(path.dirname(logs)), yes: argv.includes('--yes'),
    API_TOKEN: process.env.API_TOKEN ?? null, REGION: process.env.REGION ?? null }) + '\\n');`);
  return project;
}

const passedTo = (project, run, id) => readFileSync(path.join(project.runs, run.run_id, 'host-env.json'), 'utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line)).find((entry) => entry.case === id);

test('--allow-env and --yes pass the host variables the user agreed to, and the run records which', (t) => {
  const project = hostVariablesLoop(t);
  const { repo } = project;
  changeCode(repo, BEFORE, 'first attempt');
  // Neither flag passes none.
  const none = startRun(repo, CHANGE);
  assert.deepEqual(none.host_env, { mode: 'none', names: [], declared: ['API_TOKEN', 'REGION'], withheld: ['API_TOKEN', 'REGION'] });
  assert.deepEqual(passedTo(project, none, FAILURE), { case: FAILURE, yes: false, API_TOKEN: null, REGION: null });
  // --allow-env names the ones passed; the others stay out of Harbor's environment.
  const listed = startRun(repo, CHANGE, { allowEnv: 'API_TOKEN' });
  assert.deepEqual(listed.host_env, { mode: 'listed', names: ['API_TOKEN'], declared: ['API_TOKEN', 'REGION'], withheld: ['REGION'] });
  assert.deepEqual(readJSON(path.join(listed.directory, 'run.json')).host_env, listed.host_env);
  assert.deepEqual(passedTo(project, listed, FAILURE), { case: FAILURE, yes: true, API_TOKEN: HOST.API_TOKEN, REGION: null });
  // --yes passes every declared one, and names them.
  const all = cli(['run', 'start', CHANGE, '--repo', repo, '--yes']);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(all.json.host_env, { mode: 'all', names: ['API_TOKEN', 'REGION'], declared: ['API_TOKEN', 'REGION'], withheld: [] });
  assert.deepEqual(passedTo(project, all.json, FAILURE), { case: FAILURE, yes: true, API_TOKEN: HOST.API_TOKEN, REGION: HOST.REGION });
  // The two flags say different things: one of them, before anything runs.
  const calls = project.tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE, { allowEnv: 'API_TOKEN', yes: true }), /give one of them/);
  assert.throws(() => startRun(repo, CHANGE, { allowEnv: 'API-TOKEN' }), /--allow-env names host variables/);
  assert.equal(project.tools.runs().length, calls);
});

// --- Stuck is a warning ---

// Two full runs of the loop on different code that fail the same checks.
function stuckRuns(repo) {
  changeCode(repo, BEFORE, 'first attempt');
  completeReport(repo, fullRun(repo).run_id);
  changeCode(repo, BEFORE, 'second attempt');
  completeReport(repo, fullRun(repo).run_id);
}

test('the same failure on different code is a warning: the loop goes on and takes another run', (t) => {
  const project = inLoop(t);
  const { repo } = project;
  stuckRuns(repo);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assert.deepEqual([status.phase, status.ended, status.stop, status.situation.code], ['live', null, null, 'open'], JSON.stringify(status.situation));
  assert.ok(status.warnings.includes(`stuck: the same gating checks failed in the last two runs on different code: ${FAILURE}/c1=fail.`), JSON.stringify(status.warnings));
  assert.equal(status.gates.head_run, null);
  changeCode(repo, AFTER, 'Stop the success notice when a submission fails');
  assert.equal(fullRun(repo).verdict, 'pass');
});

test('a stuck loop stops only when the user asked for that with the plan', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const { confirmation } = confirmChecks(project, { stopOnStuck: true });
  assert.equal(confirmation.stop_on_stuck, true);
  startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, EXPECT) });
  const { loop } = startLoop(repo, CHANGE);
  assert.equal(loop.stop_on_stuck, true);
  stuckRuns(repo);
  const status = loopStatus(repo, CHANGE);
  assert.equal(status.stuck, true);
  assertEnded(status, 'stop_stuck');
  assert.equal(status.stop.code, 'stop_stuck');
  assert.deepEqual(status.ended.failing, [`${FAILURE}/c1=fail`]);
  assert.ok(status.ended.message.endsWith('The user\'s run plan asks to stop when that happens.'), status.ended.message);
  assert.ok(!status.warnings.some((warning) => warning.startsWith('stuck: ')), JSON.stringify(status.warnings));
  assertGapShape(refusedBeforeRun(project, {}, 'change_locked'), { reason: 'stop_stuck' });
});
