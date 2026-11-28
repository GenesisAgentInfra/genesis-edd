// Run tests: the run plan, the user's number of attempts, and each attempt's
// record.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../src/project.js';
import { validateEval } from '../src/eval.js';
import { checkEval, codeSnapshot, readCounts, runTools, sameCode, savePatch, startRun } from '../src/run.js';
import { loopStatus } from '../src/loop.js';
import { workflowStatus } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FAKE_HARBOR_VERSION, LIVE_DEPENDENCY, cli, commit, confirmChecks, connect, dropCheck, editChecks, git, harborThen, readRecord,
  readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import {
  FAILURE, SUCCESS, runIds, find, valueOf, refused, loopFile, actionOf, assertGapShape, startLoop,
} from './helpers/run.js';

// --- The run plan: the user's number of attempts, and each attempt's record ---

// The -k of the latest Harbor call for each package, by package id.
const attemptsGiven = (tools, count) => Object.fromEntries(tools.runs().slice(-count)
  .map((call) => [path.basename(valueOf(call.argv, '-p')), valueOf(call.argv, '-k')]));
const BASELINE_PLAN = { pass_rule: 'all', agent: AGENT, model: null, source: 'baseline' };

test('a baseline is refused before anything runs while a package declares a live dependency and no confirmation gives the number of attempts, whatever --attempts says', (t) => {
  // Without the user's confirmation of the checks, which would hold the number.
  const { repo, tools, runs } = readyProject(t, { live: [SUCCESS], confirm: false });
  const calls = tools.runs().length;
  for (const options of [{}, { attempts: 3 }]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, ...options }), (error) => {
      refused('attempts_undecided')(error);
      const entry = assertGapShape(error.gaps[0], { kind: 'business', owner: 'user', layer: 'confirmation' });
      assert.deepEqual(entry.live, [SUCCESS]);
      assert.ok(entry.message.startsWith(`${SUCCESS} declares a live dependency, so its results can differ from one attempt to the next. How many attempts`), entry.message);
      // A run's own --attempts never settles the user's number.
      assert.ok(entry.message.includes('only the number a checks confirmation records (`eval confirm --attempts N`) settles it, not a run\'s own --attempts'), entry.message);
      assert.doesNotMatch(entry.message, /write-eval/);
      return true;
    }, JSON.stringify(options));
  }
  for (const args of [[], ['--attempts', '3']]) {
    const refusal = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline', ...args]);
    assert.equal(refusal.status, 1);
    assert.deepEqual(refusal.json.gaps.map((gap) => gap.code), ['attempts_undecided']);
  }
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), []);
});

test('the baseline runs the confirmed N attempts of each package with a live dependency and one of every other, and later full runs follow it', (t) => {
  const { repo, tools, confirmation } = readyProject(t, { live: [FAILURE] });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  const plan = { attempts: 3, ...BASELINE_PLAN, source: 'confirmation', confirmation: confirmation.confirmation.id, tier: 'full' };
  assert.deepEqual(base.run_plan, plan);
  assert.deepEqual(base.attempts, { [FAILURE]: 3, [SUCCESS]: 1 });
  const recorded = readRecord(base).run.environment_ref;
  assert.deepEqual([recorded.attempts, recorded.attempts_by_case, recorded.run_plan], [3, { [FAILURE]: 3, [SUCCESS]: 1 }, plan]);
  assert.deepEqual(base.warnings.filter((warning) => /live dependency/.test(warning)), []);

  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  assert.deepEqual(readRecord(head).run.environment_ref.run_plan, plan);
  assert.deepEqual(head.run_plan, plan);
  assert.deepEqual(head.warnings.filter((warning) => warning.startsWith('The settings of this run differ')), []);

  // A partial run makes one attempt of each package it runs, and does not warn about it.
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.deepEqual(attemptsGiven(tools, 1), { [FAILURE]: '1' });
  const environment = readRecord(partial).run.environment_ref;
  assert.deepEqual([environment.attempts, environment.attempts_by_case], [1, { [FAILURE]: 1 }]);
  assert.deepEqual(partial.warnings.filter((warning) => warning.startsWith('The settings of this run differ')), []);
});

test('without a live dependency or a model a baseline needs no --attempts, and one given anyway runs every package once with a warning', (t) => {
  const { repo, tools } = readyProject(t, { confirm: false });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.deepEqual(base.run_plan, { attempts: null, ...BASELINE_PLAN });
  assert.deepEqual(base.baseline_unstable, []);
  assert.equal(readRecord(base).run.environment_ref.attempts, 1);

  const five = startRun(repo, CHANGE, { baseline: true, attempts: 5 });
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.deepEqual(five.run_plan, { attempts: 5, ...BASELINE_PLAN });
  assert.ok(five.warnings.includes('No package declares a live dependency, so every package runs once. The baseline keeps --attempts 5 for a package that declares one later.'), JSON.stringify(five.warnings));
});

test('with a model in the kit and no package declaring a live dependency, a baseline waits for the user\'s number of attempts, then runs every package once', (t) => {
  const project = readyProject(t, { model: 'synthetic/model-1', confirm: false });
  const { repo, tools } = project;
  for (const options of [{}, { attempts: 2 }]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, ...options }), (error) => {
      refused('attempts_undecided')(error);
      const { message, model, undeclared } = error.gaps[0];
      assert.deepEqual([model, undeclared], ['synthetic/model-1', [FAILURE, SUCCESS]]);
      assert.ok(message.startsWith(`The evaluated agent runs with model synthetic/model-1, but ${FAILURE}, ${SUCCESS} declare no live dependency. How many attempts`), message);
      assert.ok(message.endsWith(`A scenario of ${FAILURE}, ${SUCCESS} that calls the model is a live dependency of that package.`), message);
      // The facts only: no skill to go to.
      assert.doesNotMatch(message, /write-eval/);
      return true;
    }, JSON.stringify(options));
  }
  const { confirmation } = confirmChecks(project, { attempts: 2 });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.deepEqual(base.run_plan, { attempts: 2, pass_rule: 'all', agent: AGENT, model: 'synthetic/model-1', source: 'confirmation', confirmation: confirmation.id, tier: 'full' });
  // A head run says the packages declare no live dependency, so they ran once.
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.ok(head.warnings.includes(`${FAILURE}, ${SUCCESS} declare no live dependency although the agent runs with model synthetic/model-1, so they ran once.`), JSON.stringify(head.warnings));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
});

test('an unavailable baseline waits for the user\'s number of attempts too while a package declares a live dependency, and keeps the plan with no attempts made', (t) => {
  const project = readyProject(t, { mode: 'new', results: {}, live: [FAILURE], confirm: false });
  const { repo, tools } = project;
  const calls = tools.calls().length;
  for (const options of [{}, { attempts: 3 }]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation', ...options }), refused('attempts_undecided'), JSON.stringify(options));
  }
  const { confirmation } = confirmChecks(project, { attempts: 3 });
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(base.execution_status, 'not_run');
  assert.deepEqual(base.run_plan, { attempts: 3, ...BASELINE_PLAN, source: 'confirmation', confirmation: confirmation.id, tier: 'full' });
  assert.deepEqual(base.attempts, {});
  const environment = readRecord(base).run.environment_ref;
  assert.deepEqual([environment.attempts, environment.attempts_by_case, environment.run_plan.attempts], [3, {}, 3]);
  // Nothing ran, and the confirmation ran nothing either.
  assert.equal(tools.calls().length, calls);
});

test('a baseline runs the plan the user confirmed with the checks, and is refused before anything runs with other attempts, agent or model', (t) => {
  const { repo, tools, runs, confirmation } = readyProject(t, { live: [FAILURE] });
  const { id } = confirmation.confirmation;
  const calls = tools.runs().length;
  for (const [options, differs] of [[{ attempts: 2 }, '2 attempts'], [{ model: 'synthetic/other' }, 'model synthetic/other'], [{ agent: 'other_agent:OtherAgent' }, 'agent other_agent:OtherAgent']]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, ...options }), (error) => {
      refused('run_plan_differs')(error);
      const entry = assertGapShape(error.gaps[0], { kind: 'artifact', owner: 'agent', layer: 'confirmation' });
      assert.deepEqual([entry.confirmed, entry.given], [{ attempts: 3, agent: AGENT, model: null }, [differs]]);
      assert.equal(entry.message, `The user confirmed 3 attempts, agent ${AGENT}, model none for this Spec export (confirmed.json), and this baseline would use ${differs}. Another plan is the user's decision, recorded with \`eval confirm\`.`);
      return true;
    }, JSON.stringify(options));
  }
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), []);
  // The same values are no difference.
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3, agent: AGENT });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  assert.deepEqual(base.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'confirmation', confirmation: id, tier: 'full' });
  const record = readRecord(base).run;
  assert.deepEqual(record.checks_confirmation, { id, at: confirmation.confirmation.confirmed.at });
  assert.ok(!base.warnings.some((warning) => warning.includes('confirm')), JSON.stringify(base.warnings));
  // A loop can start on it: the confirmation covers it.
  assert.deepEqual([base.confirmation_current, base.loop_baseline], [true, { usable: true, reasons: [] }]);
  assert.equal(base.suggestion, null);
  // Without flags too.
  assert.deepEqual(startRun(repo, CHANGE, { baseline: true }).run_plan, base.run_plan);
});

test('a baseline without the user\'s confirmation runs with a warning, and every run records the confirmation of the packages it ran, or null', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.is_baseline, true);
  assert.ok(base.warnings.includes('The user has not confirmed the checks of this Spec export. Only the user confirms them; a loop runs only on checks the user confirmed.'), JSON.stringify(base.warnings));
  // As far as the record goes a loop could start on it, but no confirmation covers it yet.
  assert.deepEqual([base.confirmation_current, base.loop_baseline], [false, { usable: true, reasons: [] }]);
  assert.equal(readRecord(base).run.checks_confirmation, null);
  const { confirmation } = confirmChecks(project);
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.deepEqual(readRecord(head).run.checks_confirmation, { id: confirmation.id, at: confirmation.confirmed.at });
  // A package changed since the confirmation: no confirmation covers the run.
  const file = path.join(project.root, 'evals', FAILURE, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  checkEval(repo, CHANGE);
  assert.equal(readRecord(startRun(repo, CHANGE)).run.checks_confirmation, null);
  // The baseline warns which packages changed.
  const again = startRun(repo, CHANGE, { baseline: true });
  assert.ok(again.warnings.some((warning) => warning.startsWith(`${FAILURE} changed since the user confirmed the checks`) && warning.includes(`${FAILURE}/environment/Dockerfile`)), JSON.stringify(again.warnings));
  assert.equal(again.confirmation_current, false);
});

test('each attempt is recorded in attempts.json with its trial, status, results and times, and check-results.json keeps its fields', (t) => {
  const { repo } = readyProject(t, { live: [FAILURE], results: { ...BEFORE, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } } });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  const recorded = readJSON(path.join(base.directory, FAILURE, 'attempts.json'));
  assert.deepEqual([recorded.schema_version, recorded.case, recorded.planned], ['1.0', FAILURE, 3]);
  assert.deepEqual(recorded.attempts.map(({ attempt, trial, status, results, reward }) => [attempt, trial, status, results, reward]), [
    [1, 'logs/harbor/trial-1', 'completed', { c1: 'pass' }, 1],
    [2, 'logs/harbor/trial-2', 'completed', { c1: 'fail' }, 0],
    [3, 'logs/harbor/trial-3', 'completed', { c1: 'pass' }, 1],
  ]);
  for (const entry of recorded.attempts) {
    assert.equal(new Date(entry.started_at).toISOString(), entry.started_at);
    assert.ok(entry.started_at < entry.finished_at, JSON.stringify(entry));
    assert.equal(entry.usage, undefined);
  }
  assert.ok(recorded.attempts[0].finished_at < recorded.attempts[1].started_at);
  const [result] = readJSON(path.join(base.directory, FAILURE, 'check-results.json')).results;
  assert.deepEqual(Object.keys(result), ['id', 'result', 'evidence', 'flaky']);
  assert.deepEqual([result.result, result.flaky], ['fail', true]);
  // A package with no live dependency made its one attempt.
  assert.deepEqual(readJSON(path.join(base.directory, SUCCESS, 'attempts.json')).attempts.map((entry) => entry.results), [{ c1: 'pass', c2: 'pass' }]);
});

test('an attempt Harbor left no trial for is missing, one that raised is an error with its reason, and usage is kept as reported', (t) => {
  const { repo } = readyProject(t, { live: [FAILURE], attempts: 2 });
  startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  setResults(repo, { ...AFTER, [FAILURE]: [{ c1: 'pass', $usage: { n_input_tokens: 120, cost_usd: 0.01 } }, 'error'] });
  const missing = startRun(repo, CHANGE);
  let attempts = readJSON(path.join(missing.directory, FAILURE, 'attempts.json')).attempts;
  assert.deepEqual(attempts[0].usage, { n_input_tokens: 120, cost_usd: 0.01 });
  assert.deepEqual(attempts[1], { attempt: 2, trial: null, status: 'missing', reason: 'Harbor left no trial result for this attempt.',
    results: { c1: 'unknown' }, reward: null, started_at: null, finished_at: null });
  assert.equal(readJSON(path.join(missing.directory, SUCCESS, 'attempts.json')).attempts[0].usage, undefined);

  setResults(repo, { ...AFTER, [FAILURE]: [{ c1: 'pass' }, 'exception'] });
  const raised = startRun(repo, CHANGE);
  attempts = readJSON(path.join(raised.directory, FAILURE, 'attempts.json')).attempts;
  assert.deepEqual(attempts.map((entry) => [entry.status, entry.trial]), [['completed', 'logs/harbor/trial-1'], ['error', 'logs/harbor/trial-2']]);
  assert.match(attempts[1].reason, /^RuntimeError: the application failed in submit-failure-s1$/);
  assert.equal(attempts[0].usage, undefined);
});

test('each case and the run total their attempts\' minutes and the usage the adapter reported, and a model run says which packages reported none', (t) => {
  const usage = { cost_usd: 0.05, n_input_tokens: 100 };
  const results = { [FAILURE]: { c1: 'fail', $seconds: 30, $usage: usage }, [SUCCESS]: { c1: 'pass', c2: 'pass', $seconds: 6 } };
  const { repo } = readyProject(t, { live: [FAILURE], model: 'synthetic/model-m', results });
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.deepEqual(base.attempts, { [FAILURE]: 3, [SUCCESS]: 1 });
  const { run } = readRecord(base);
  const byCase = Object.fromEntries(run.cases.map((item) => [item.id, item.usage]));
  assert.deepEqual(byCase[FAILURE], { minutes: 1.5, attempts: 3, reported: 3, cost_usd: 0.15, n_input_tokens: 300, n_cache_tokens: null, n_output_tokens: null });
  // An adapter that reported nothing leaves cost and tokens unknown, not 0.
  assert.deepEqual(byCase[SUCCESS], { minutes: 0.1, attempts: 1, reported: 0, cost_usd: null, n_input_tokens: null, n_cache_tokens: null, n_output_tokens: null });
  const { minutes, ...totals } = run.usage;
  assert.ok(Number.isFinite(minutes) && minutes >= 0, JSON.stringify(run.usage));
  assert.deepEqual(totals, { attempt_minutes: 1.6, attempts: 4, reported: 3, cost_usd: 0.15, n_input_tokens: 300, n_cache_tokens: null, n_output_tokens: null });
  assert.deepEqual(Object.keys(run.usage), ['minutes', 'attempt_minutes', 'attempts', 'reported', 'cost_usd', 'n_input_tokens', 'n_cache_tokens', 'n_output_tokens']);
  assert.deepEqual(base.usage, run.usage);
  assert.ok(base.warnings.includes(`The adapter reported no cost or tokens for ${SUCCESS}; the estimates count their time only.`), JSON.stringify(base.warnings));
});

test('eval check records in check.json what its fixtures took', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  editChecks(repo, FAILURE, (declared) => { for (const fixture of declared.fixtures) fixture.$seconds = 30; });
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true);
  // Four fixtures of one attempt each, 30 seconds apiece; no fixture reports usage.
  const recorded = readJSON(path.join(root, 'checks', FAILURE, 'check.json'));
  assert.deepEqual(recorded.usage, { minutes: 2, attempts: 4, reported: 0, cost_usd: null, n_input_tokens: null, n_cache_tokens: null, n_output_tokens: null });
  assert.equal(recorded.fixtures.length, 4);
  assert.ok(recorded.fixtures.every((fixture) => fixture.attempts === undefined), JSON.stringify(recorded.fixtures));
  assert.deepEqual(checked.cases.find((item) => item.case === FAILURE).usage, recorded.usage);
  assert.equal(readJSON(path.join(root, 'checks', SUCCESS, 'check.json')).usage.attempts, 5);
});

test('attempts are numbered in the order their trials started, not by trial name', (t) => {
  const { repo } = readyProject(t, { live: [FAILURE], attempts: 2 });
  setResults(repo, { ...BEFORE, [FAILURE]: { c1: ['pass', 'fail'] } });
  harborThen(t, `const trials = path.join(logs, 'harbor');
  const first = JSON.parse(readFileSync(path.join(trials, 'trial-1', 'result.json'), 'utf8'));
  if (first.task_name === '${FAILURE}') {
    const second = JSON.parse(readFileSync(path.join(trials, 'trial-2', 'result.json'), 'utf8'));
    first.started_at = new Date(Date.parse(second.finished_at) + 1000).toISOString();
    first.finished_at = new Date(Date.parse(second.finished_at) + 2000).toISOString();
    writeFileSync(path.join(trials, 'trial-1', 'result.json'), JSON.stringify(first));
  }`);
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  const attempts = readJSON(path.join(base.directory, FAILURE, 'attempts.json')).attempts;
  assert.deepEqual(attempts.map(({ attempt, trial, results }) => [attempt, trial, results.c1]), [[1, 'logs/harbor/trial-2', 'fail'], [2, 'logs/harbor/trial-1', 'pass']]);
});

test('compare.json carries the counts of both sides, and a check with no baseline result has none before', (t) => {
  const { repo, root } = readyProject(t, { live: [FAILURE] });
  startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  // A changed package has no baseline result to compare with.
  appendFileSync(path.join(root, 'evals', SUCCESS, 'environment/Dockerfile'), 'RUN true\n');
  checkEval(repo, CHANGE);
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  const { compare } = readRecord(head);
  const failure = find(compare, FAILURE, 'c1');
  assert.deepEqual([failure.before, failure.before_counts, failure.after, failure.after_counts],
    ['fail', { pass: 0, fail: 3, unknown: 0 }, 'pass', { pass: 3, fail: 0, unknown: 0 }]);
  const success = find(compare, SUCCESS, 'c1');
  assert.deepEqual([success.verdict, success.before_counts, success.after_counts], ['head_only', null, { pass: 1, fail: 0, unknown: 0 }]);
});

test('a baseline recorded before run plans keeps running every package its number of times, with one warning, and its counts are read from the evidence', (t) => {
  const { repo, runs, tools } = readyProject(t, { live: [FAILURE, SUCCESS], attempts: 2 });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  // Rewrite it as an earlier release wrote it: no run plan and no attempts.json.
  const file = path.join(runs, base.run_id, 'run.json');
  const record = readJSON(file);
  delete record.environment_ref.run_plan;
  delete record.environment_ref.attempts_by_case;
  delete record.baseline_unstable;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  for (const id of [FAILURE, SUCCESS]) rmSync(path.join(runs, base.run_id, id, 'attempts.json'));
  // A package that declares no live dependency now still runs as the baseline did.
  const declared = readJSON(path.join(runs, '..', 'evals', SUCCESS, 'tests/checks.json'));
  declared.dependencies = [];
  writeFileSync(path.join(runs, '..', 'evals', SUCCESS, 'tests/checks.json'), `${JSON.stringify(declared, null, 2)}\n`);
  checkEval(repo, CHANGE);

  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '2', [SUCCESS]: '2' });
  assert.deepEqual(head.run_plan, { attempts: 2, pass_rule: 'all', agent: AGENT, model: null, source: 'legacy', uniform: true });
  assert.deepEqual(head.warnings.filter((warning) => warning.includes('before runs followed a run plan')), [
    `The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs 2 times, as it did there.`]);
  assert.deepEqual(find(readRecord(head).compare, FAILURE, 'c1').before_counts, { pass: 0, fail: 2, unknown: 0 });
});

test('a baseline check that passed in some attempts and failed in others is baseline_unstable, not a mismatch, and its expectation does not flip', (t) => {
  const { repo, confirmation } = readyProject(t, { live: [FAILURE], results: { ...BEFORE, [FAILURE]: { c1: ['pass', 'fail', 'pass'] } } });
  const expected = { [`${FAILURE}/c1`]: 'pass', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' };
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3, expect: writeExpectations(repo, expected) });
  assert.equal(base.is_baseline, true);
  assert.deepEqual(base.baseline_unstable, [{ case: FAILURE, check: 'c1', expected: 'pass', counts: { pass: 2, fail: 1, unknown: 0 } }]);
  assert.deepEqual(base.baseline_mismatch, []);
  assert.deepEqual(readRecord(base).run.baseline_unstable, base.baseline_unstable);
  assert.ok(base.warnings.includes(`Checks that passed in some attempts and failed in others at the baseline (baseline_unstable): ${FAILURE}/c1 2 of 3 passed. Their result before the change is not settled, so a later pass shows nothing about this change.`), JSON.stringify(base.warnings));
  // An unstable check does not keep a loop from starting.
  assert.deepEqual(base.loop_baseline, { usable: true, reasons: [] });
  assert.equal(actionOf(workflowStatus(repo, CHANGE), 'loop', 'start').allowed, true);

  const flipped = startRun(repo, CHANGE, { baseline: true, attempts: 3, expect: writeExpectations(repo, { ...expected, [`${FAILURE}/c1`]: 'fail' }) });
  assert.ok(flipped.warnings.includes(`The expected result of ${FAILURE}/c1 changed from pass to fail since the baseline ${base.run_id}, where it was unstable.`), JSON.stringify(flipped.warnings));
  const started = startLoop(repo, CHANGE);
  assert.ok(started.warnings.includes(`The baseline ${flipped.run_id} has checks whose attempts disagreed (baseline_unstable): ${FAILURE}/c1. Their comparison with the baseline shows nothing about the change.`), JSON.stringify(started.warnings));
  assert.deepEqual(started.run_plan, { attempts: 3, ...BASELINE_PLAN, source: 'confirmation', confirmation: confirmation.confirmation.id, tier: 'full' });
});

test('inside a loop --attempts, --agent and --model that differ from the plan are refused before anything runs, and values equal to the plan are taken', (t) => {
  const { repo, root, runs, tools } = readyProject(t, { live: [FAILURE] });
  startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  const before = runIds(runs);
  const calls = tools.runs().length;
  // A base record on the start code reads the plan of the user's
  // confirmation, and another one is refused.
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, model: 'synthetic/other' }), refused('run_plan_differs'));
  setResults(repo, AFTER);
  for (const value of ['5', '1']) {
    const attempts = cli(['run', 'start', CHANGE, '--repo', repo, '--attempts', value]);
    assert.equal(attempts.status, 1);
    assert.deepEqual(attempts.json.gaps.map((gap) => gap.code), ['run_plan_fixed']);
    const entry = assertGapShape(attempts.json.gaps[0], { kind: 'artifact', owner: 'agent', layer: 'loop' });
    assert.deepEqual(entry.differs, [{ key: 'attempts', given: Number(value), plan: 3 }]);
    assert.deepEqual(entry.plan, { attempts: 3, agent: AGENT, model: null, tier: 'full' });
    assert.ok(entry.message.startsWith(`A loop runs for this Spec export, and its run plan is fixed by its checks confirmation: 3 attempts, agent ${AGENT}, model none. This run gives attempts ${value}.`), entry.message);
  }
  for (const options of [{ attempts: 2, case: [FAILURE] }, { model: 'synthetic/other' }, { model: 'synthetic/other', attempts: 2 }, { agent: 'other_agent:OtherAgent' }]) {
    assert.throws(() => startRun(repo, CHANGE, options), refused('run_plan_fixed'), JSON.stringify(options));
  }
  assert.deepEqual(runIds(runs), before);
  assert.equal(tools.runs().length, calls);
  // The plan's own values are taken. A partial run makes one attempt of each
  // package unless --attempts says, and has no role.
  const partial = startRun(repo, CHANGE, { case: [FAILURE], agent: AGENT });
  assert.deepEqual([partial.execution_status, partial.role, readRecord(partial).run.role], ['completed', null, null]);
  assert.deepEqual(attemptsGiven(tools, 1), { [FAILURE]: '1' });
  assert.deepEqual(partial.attempts, { [FAILURE]: 1 });
  const planned = startRun(repo, CHANGE, { case: [FAILURE], attempts: 3 });
  assert.equal(planned.execution_status, 'completed', JSON.stringify(planned));
  assert.deepEqual(attemptsGiven(tools, 1), { [FAILURE]: '3' });
  assert.equal(tools.runs().length, calls + 2);
  assert.equal(runIds(runs).length, before.length + 2);
  // A model written into harness.json changes the kit, which ends the loop,
  // and the change is locked until the user decides.
  const harness = path.join(root, '..', 'harness', 'harness.json');
  writeFileSync(harness, `${JSON.stringify({ agent: AGENT, model: 'synthetic/kit-model' })}\n`);
  checkEval(repo, CHANGE);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended?.reason], ['ended', 'packages_changed'], JSON.stringify(status.ended));
  assert.ok(status.ended.files.includes('kit/harness.json'), JSON.stringify(status.ended));
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('change_locked', 'loop_ended')(error);
    assert.equal(error.gaps[0].reason, 'packages_changed');
    return true;
  });
});

test('inside a loop a head run without flags uses the model of the loop\'s checks confirmation, even when harness.json names none', (t) => {
  const project = readyProject(t, { live: [FAILURE], confirm: false });
  const { repo, tools } = project;
  // The user confirms the plan, and the baseline runs it.
  confirmChecks(project, { attempts: 2, model: 'synthetic/model-m' });
  startRun(repo, CHANGE, { baseline: true, model: 'synthetic/model-m', attempts: 2 });
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.ok(tools.runs().slice(-2).every((call) => valueOf(call.argv, '-m') === 'synthetic/model-m'));
  assert.equal(readRecord(head).run.environment_ref.model, 'synthetic/model-m');
  assert.deepEqual(head.warnings.filter((warning) => warning.startsWith('The settings of this run differ')), []);
});

test('outside a loop --attempts overrides the plan for the packages with a live dependency and warns', (t) => {
  const { repo, tools } = readyProject(t, { live: [FAILURE] });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  setResults(repo, AFTER);
  const head = startRun(repo, CHANGE, { attempts: 2 });
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '2', [SUCCESS]: '1' });
  assert.deepEqual(head.warnings.filter((warning) => warning.startsWith('The settings of this run differ')), [
    `The settings of this run differ from those of the baseline ${base.run_id}: attempts 2 here, 3 in the baseline. A different result may come from that, not from the change.`]);
});

test('after an unavailable baseline the user confirmed with model none, a head run with another model is refused, and a confirmation of another model ends the loop', (t) => {
  // The light tier names no model, so this change is confirmed in the full tier.
  const project = readyProject(t, { mode: 'new', results: {}, tier: 'full' });
  const { repo, runs, tools } = project;
  assert.equal(project.confirmation.confirmation.run_plan.model, null);
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([base.run_plan.source, base.run_plan.model], ['confirmation', null]);
  const first = startLoop(repo, CHANGE).loop;
  setResults(repo, AFTER);
  const before = runIds(runs);
  const calls = tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE, { model: 'synthetic/model-m' }), refused('run_plan_fixed'));
  assert.deepEqual(runIds(runs), before);
  assert.equal(tools.runs().length, calls);
  // Without the flag the run uses no model, as the user confirmed.
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.equal(readRecord(head).run.environment_ref.model, null);
  assert.equal(loopStatus(repo, CHANGE).loop.run_plan.model, null);
  // The user confirms another model: the loop has ended.
  const revised = confirmChecks(project, { model: 'synthetic/model-m', attempts: 1, reason: 'The user chose model-m.', tier: 'full' });
  assert.equal(revised.confirmation.run_plan.model, 'synthetic/model-m');
  assert.deepEqual(revised.loop, { started_at: first.started_at, phase: 'ended', ended: true, reason: 'confirmation_changed' });
  // A new loop needs a baseline of this plan, recorded the same way, and the user's consent.
  assert.deepEqual(revised.new_loop_needs, { baseline: true, user_consent: true });
  assert.deepEqual([revised.baseline.kept, revised.baseline.unavailable, revised.baseline.on], [false, 'no_implementation', 'start_code']);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended.reason, status.ended.plan], ['ended', 'confirmation_changed', ['model']]);
  assert.ok(status.ended.new_loop.consents.includes('new_loop'), JSON.stringify(status.ended.new_loop));
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('change_locked', 'loop_ended')(error);
    assert.equal(error.gaps[0].reason, 'confirmation_changed');
    return true;
  });
  // A new loop needs a baseline of that plan on the start code.
  assert.throws(() => startLoop(repo, CHANGE), (error) => error.gaps.some((gap) => gap.code === 'baseline_plan_differs'));
  setResults(repo, {});
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.deepEqual([again.run_plan.source, again.run_plan.model], ['confirmation', 'synthetic/model-m']);
  const loop = startLoop(repo, CHANGE).loop;
  assert.equal(loop.baseline, again.run_id);
  assert.deepEqual(loop.start_code, first.start_code);
  setResults(repo, AFTER);
  const next = startRun(repo, CHANGE);
  assert.equal(next.verdict, 'pass');
  assert.equal(readRecord(next).run.environment_ref.model, 'synthetic/model-m');
});

test('inside a loop a head run takes the model or agent the user confirmed over the one harness.json names, a flag for another one is refused, and one for the same is taken', (t) => {
  const project = readyProject(t, { live: [FAILURE], model: 'synthetic/kit-model', confirm: false });
  const { repo, tools } = project;
  confirmChecks(project, { attempts: 2, model: 'synthetic/flag-model' });
  startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  // No flag is needed: the run takes the confirmed model.
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.ok(tools.runs().slice(-2).every((call) => valueOf(call.argv, '-m') === 'synthetic/flag-model'));
  assert.throws(() => startRun(repo, CHANGE, { model: 'synthetic/third-model' }), (error) => {
    refused('run_plan_fixed')(error);
    assert.deepEqual(error.gaps[0].differs, [{ key: 'model', given: 'synthetic/third-model', plan: 'synthetic/flag-model' }]);
    return true;
  });
  // Nor is the model harness.json names the plan's.
  assert.throws(() => startRun(repo, CHANGE, { model: 'synthetic/kit-model', case: [FAILURE] }), refused('run_plan_fixed'));
  const same = startRun(repo, CHANGE, { model: 'synthetic/flag-model', case: [FAILURE] });
  assert.equal(same.execution_status, 'completed', JSON.stringify(same));
  assert.equal(valueOf(tools.runs().at(-1).argv, '-m'), 'synthetic/flag-model');

  const other = readyProject(t, { live: [FAILURE], confirm: false });
  confirmChecks(other, { attempts: 2, agent: 'other_agent:OtherAgent' });
  startRun(other.repo, CHANGE, { baseline: true });
  startLoop(other.repo, CHANGE);
  setResults(other.repo, AFTER);
  assert.equal(startRun(other.repo, CHANGE).verdict, 'pass');
  assert.ok(other.tools.runs().slice(-2).every((call) => valueOf(call.argv, '-a') === 'other_agent:OtherAgent'));
  // The agent of harness.json is not the plan's.
  assert.throws(() => startRun(other.repo, CHANGE, { agent: AGENT }), refused('run_plan_fixed'));
  assert.equal(startRun(other.repo, CHANGE, { agent: 'other_agent:OtherAgent', case: [FAILURE] }).execution_status, 'completed');
});

test('a loop does not start on a baseline that fixed no number of attempts once a package declares a live dependency', (t) => {
  const project = readyProject(t, { mode: 'new', results: {} });
  const { repo, root } = project;
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const file = path.join(root, 'evals', FAILURE, 'tests/checks.json');
  const declared = readJSON(file);
  declared.dependencies = [LIVE_DEPENDENCY];
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  checkEval(repo, CHANGE);
  // The changed package needs the user's confirmation first, with the number of attempts.
  const unconfirmed = workflowStatus(repo, CHANGE);
  assert.equal(unconfirmed.layers.confirmation.current, false);
  assert.deepEqual(unconfirmed.layers.confirmation.changed_since, [FAILURE]);
  const confirmAction = actionOf(unconfirmed, 'eval', 'confirm');
  assert.deepEqual([confirmAction.by, confirmAction.needed], ['user', true], JSON.stringify(confirmAction));
  assert.throws(() => confirmChecks(project, { reason: `${FAILURE} calls the model.` }), (error) => error.gaps.some((gap) => gap.code === 'attempts_undecided'));
  confirmChecks(project, { reason: `${FAILURE} calls the model.`, attempts: 3 });
  // That baseline fixed no number of attempts: a loop on it is refused, and
  // recording it again the same way is allowed.
  const recorded = workflowStatus(repo, CHANGE);
  assert.ok(actionOf(recorded, 'loop', 'start').blocked_by.includes('attempts_undecided'), JSON.stringify(actionOf(recorded, 'loop', 'start')));
  assert.equal(actionOf(recorded, 'run', 'start', '--baseline', '--unavailable').allowed, true);
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED');
    assert.deepEqual(error.gaps.map((gap) => gap.code), ['attempts_undecided']);
    const entry = assertGapShape(error.gaps[0]);
    assert.equal(entry.message, `${FAILURE} declares a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so a loop on that baseline could not run it the user's number of times. That number is the user's decision; they confirmed 3 attempts in confirmed.json, which a baseline recorded now reads.`);
    return true;
  });
  const rerecorded = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(rerecorded.run_plan.attempts, 3);
  assert.equal(actionOf(workflowStatus(repo, CHANGE), 'loop', 'start').allowed, true);
  assert.equal(startLoop(repo, CHANGE).loop.baseline, rerecorded.run_id);
});

// Declares a live dependency in FAILURE and proves it again.
function declareLive(repo, root) {
  const file = path.join(root, 'evals', FAILURE, 'tests/checks.json');
  const declared = readJSON(file);
  declared.dependencies = [LIVE_DEPENDENCY];
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  checkEval(repo, CHANGE);
}

test('a package that declares a live dependency after a baseline that fixed no number of attempts ends a loop, and warns outside one', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  declareLive(repo, root);
  setResults(repo, AFTER);
  // The package changed, so the loop has ended, and the change is locked.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.phase, status.ended.reason, status.ended.packages], ['ended', 'packages_changed', [FAILURE]]);
  assert.throws(() => startRun(repo, CHANGE), (error) => {
    refused('change_locked', 'loop_ended')(error);
    assert.equal(error.gaps[0].reason, 'packages_changed');
    return true;
  });
  // The user's confirmation of it needs their number of attempts.
  assert.throws(() => confirmChecks(project, { reason: `${FAILURE} calls the model.` }), (error) => error.gaps.some((gap) => gap.code === 'attempts_undecided'));

  // Outside a loop the package runs once, with a warning.
  const free = readyProject(t);
  const base = startRun(free.repo, CHANGE, { baseline: true });
  declareLive(free.repo, free.root);
  setResults(free.repo, AFTER);
  const outside = startRun(free.repo, CHANGE);
  assert.equal(outside.execution_status, 'completed');
  assert.ok(outside.warnings.includes(`${FAILURE} declares a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so it ran once.`), JSON.stringify(outside.warnings));
  assert.deepEqual(outside.attempts, { [FAILURE]: 1, [SUCCESS]: 1 });
});
