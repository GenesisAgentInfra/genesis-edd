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
import { loopStatus, startLoop } from '../src/loop.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FAKE_HARBOR_VERSION, LIVE_DEPENDENCY, cli, commit, confirmChecks, connect, dropCheck, editChecks, git, harborThen, readRecord,
  readyProject, setResults, writeExpectations,
} from './helpers/edd.js';
import {
  FAILURE, SUCCESS, runIds, find, valueOf, refused, loopFile,
} from './helpers/run.js';

// --- The run plan: the user's number of attempts, and each attempt's record ---

// The -k of the latest Harbor call for each package, by package id.
const attemptsGiven = (tools, count) => Object.fromEntries(tools.runs().slice(-count)
  .map((call) => [path.basename(valueOf(call.argv, '-p')), valueOf(call.argv, '-k')]));
const BASELINE_PLAN = { pass_rule: 'all', agent: AGENT, model: null, source: 'baseline' };

test('a baseline is refused before anything runs while a package declares a live dependency and no --attempts is given', (t) => {
  // Without the user's confirmation of the checks, which would hold the number.
  const { repo, tools, runs } = readyProject(t, { live: [SUCCESS], confirm: false });
  const calls = tools.runs().length;
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    refused('attempts_undecided')(error);
    const [entry] = error.gaps;
    assert.deepEqual([entry.kind, entry.owner, entry.route], ['business', 'user', 'run-eval']);
    assert.ok(entry.message.startsWith(`${SUCCESS} declares a live dependency, so its results can differ from one attempt to the next. How many attempts`), entry.message);
    assert.match(entry.message, /pass --attempts N\. Propose 5, or 3 when the budget is tight/);
    assert.doesNotMatch(entry.message, /write-eval/);
    return true;
  });
  const refusal = cli(['run', 'start', CHANGE, '--repo', repo, '--baseline']);
  assert.equal(refusal.status, 1);
  assert.deepEqual(refusal.json.gaps.map((gap) => gap.code), ['attempts_undecided']);
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), []);
});

test('the baseline runs N attempts of each package with a live dependency and one of every other, and later full runs follow it', (t) => {
  const { repo, tools } = readyProject(t, { live: [FAILURE], confirm: false });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  const plan = { attempts: 3, ...BASELINE_PLAN };
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

test('with a model in the kit and no package declaring a live dependency, the baseline needs --attempts and points at write-eval', (t) => {
  const { repo, tools } = readyProject(t, { model: 'synthetic/model-1', confirm: false });
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    refused('attempts_undecided')(error);
    const { message } = error.gaps[0];
    assert.ok(message.startsWith(`The evaluated agent runs with model synthetic/model-1, but ${FAILURE}, ${SUCCESS} declare no live dependency. How many attempts`), message);
    assert.ok(message.endsWith(`If a scenario of ${FAILURE}, ${SUCCESS} calls the model, declare it in that package's tests/checks.json dependencies with mode live in write-eval and prove it again with eval check before the baseline.`), message);
    return true;
  });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 2 });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '1', [SUCCESS]: '1' });
  assert.ok(base.warnings.includes(`${FAILURE}, ${SUCCESS} declare no live dependency although the agent runs with model synthetic/model-1, so they run once. If a scenario calls the model, declare that in write-eval.`), JSON.stringify(base.warnings));
  assert.deepEqual(base.run_plan, { attempts: 2, pass_rule: 'all', agent: AGENT, model: 'synthetic/model-1', source: 'baseline' });
});

test('an unavailable baseline needs --attempts too while a package declares a live dependency, and keeps the plan with no attempts made', (t) => {
  const { repo, tools } = readyProject(t, { mode: 'new', results: {}, live: [FAILURE], confirm: false });
  const calls = tools.calls().length;
  assert.throws(() => startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' }), refused('attempts_undecided'));
  const base = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation', attempts: 3 });
  assert.equal(base.execution_status, 'not_run');
  assert.deepEqual(base.run_plan, { attempts: 3, ...BASELINE_PLAN });
  assert.deepEqual(base.attempts, {});
  const environment = readRecord(base).run.environment_ref;
  assert.deepEqual([environment.attempts, environment.attempts_by_case, environment.run_plan.attempts], [3, {}, 3]);
  assert.equal(tools.calls().length, calls);
});

test('a baseline runs the plan the user confirmed with the checks, and is refused before anything runs with other attempts, agent or model', (t) => {
  const { repo, tools, runs, confirmation } = readyProject(t, { live: [FAILURE] });
  const { id } = confirmation.confirmation;
  const calls = tools.runs().length;
  for (const [options, differs] of [[{ attempts: 2 }, '2 attempts'], [{ model: 'synthetic/other' }, 'model synthetic/other'], [{ agent: 'other_agent:OtherAgent' }, 'agent other_agent:OtherAgent']]) {
    assert.throws(() => startRun(repo, CHANGE, { baseline: true, ...options }), (error) => {
      refused('run_plan_differs')(error);
      const [entry] = error.gaps;
      assert.deepEqual([entry.kind, entry.owner, entry.route], ['artifact', 'agent', 'run-eval']);
      assert.equal(entry.message, `The user confirmed 3 attempts, agent ${AGENT}, model none for this Spec export (confirmed.json). This baseline would use ${differs}. Run without --attempts, --agent and --model to use the confirmed plan; to change it, show the user and record a new \`eval confirm --reason <why>\` with the new flags first.`);
      return true;
    }, JSON.stringify(options));
  }
  assert.equal(tools.runs().length, calls);
  assert.deepEqual(runIds(runs), []);
  // The same values are no difference.
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3, agent: AGENT });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  assert.deepEqual(attemptsGiven(tools, 2), { [FAILURE]: '3', [SUCCESS]: '1' });
  assert.deepEqual(base.run_plan, { attempts: 3, pass_rule: 'all', agent: AGENT, model: null, source: 'confirmation', confirmation: id });
  const record = readRecord(base).run;
  assert.deepEqual(record.checks_confirmation, { id, at: confirmation.confirmation.confirmed.at });
  assert.ok(!base.warnings.some((warning) => warning.includes('confirm')), JSON.stringify(base.warnings));
  assert.match(base.next, /^The baseline is recorded\. Start the implementation loop before changing any code: `loop start` \(loop-and-implement\) takes the budget the user confirmed in confirmed\.json/);
  // Without flags too.
  assert.deepEqual(startRun(repo, CHANGE, { baseline: true }).run_plan, base.run_plan);
});

test('a baseline without the user\'s confirmation runs with a warning, and every run records the confirmation of the packages it ran, or null', (t) => {
  const project = readyProject(t, { confirm: false });
  const { repo } = project;
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.is_baseline, true);
  assert.ok(base.warnings.includes('The user has not confirmed the checks of this Spec export. Run `eval review`, have a reviewer answer it in review.json, show the user the review and the run plan, and record their confirmation with `eval confirm` before `loop start`.'), JSON.stringify(base.warnings));
  assert.match(base.next, /^The baseline is recorded\. Have the user confirm the checks first \(`eval review`, `eval confirm`\): `loop start` refuses checks_unconfirmed\./);
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
  assert.ok(again.warnings.some((warning) => warning.startsWith(`${FAILURE} changed since the user confirmed the checks (${FAILURE}/environment/Dockerfile).`)), JSON.stringify(again.warnings));
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
    `The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs 2 times, as it did there. A new baseline asks for the number of attempts of each package that declares a live dependency.`]);
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
  assert.ok(base.warnings.includes(`Checks that passed in some attempts and failed in others at the baseline (baseline_unstable): ${FAILURE}/c1 2 of 3 passed. Their result before the change is not settled, so a later pass shows nothing about this change. Read their logs/ for what differed between the attempts, and tell the user. Do not change an expectation to fit one outcome.`), JSON.stringify(base.warnings));
  assert.ok(base.next.endsWith(' Some checks passed in some attempts and failed in others (baseline_unstable): tell the user before the loop starts, and leave their expectations as they are.'), base.next);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');

  const flipped = startRun(repo, CHANGE, { baseline: true, attempts: 3, expect: writeExpectations(repo, { ...expected, [`${FAILURE}/c1`]: 'fail' }) });
  assert.ok(flipped.warnings.includes(`The expected result of ${FAILURE}/c1 changed from pass to fail since the baseline ${base.run_id}, where it was unstable. An expectation follows what the change does, not one outcome of an unstable check.`), JSON.stringify(flipped.warnings));
  const started = startLoop(repo, CHANGE);
  assert.ok(started.warnings.includes(`The baseline ${flipped.run_id} has checks whose attempts disagreed (baseline_unstable): ${FAILURE}/c1. Their comparison with the baseline shows nothing about the change; tell the user.`), JSON.stringify(started.warnings));
  assert.deepEqual(started.run_plan, { attempts: 3, ...BASELINE_PLAN, source: 'confirmation', confirmation: confirmation.confirmation.id });
});

// The refusal of a plan flag inside a loop.
const RUN_PLAN_FIXED = 'A loop runs for this Spec export, and its run plan is fixed: run start reads the number of attempts, the agent and the model from the loop\'s checks confirmation in confirmed.json, and a baseline reads them from the latest confirmation. Run without --attempts, --agent and --model. To change the plan, the user confirms another one with `eval confirm`, which ends this loop.';

test('inside a loop --attempts, --agent and --model are refused before anything runs, equal values and base records included', (t) => {
  const { repo, root, runs, tools } = readyProject(t, { live: [FAILURE] });
  startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  const before = runIds(runs);
  const calls = tools.runs().length;
  // The plan's number and one are refused too.
  for (const value of ['5', '3', '1']) {
    const attempts = cli(['run', 'start', CHANGE, '--repo', repo, '--attempts', value]);
    assert.equal(attempts.status, 1);
    assert.deepEqual(attempts.json.gaps.map((gap) => gap.code), ['run_plan_fixed']);
    const [entry] = attempts.json.gaps;
    assert.deepEqual([entry.kind, entry.owner, entry.route], ['artifact', 'agent', 'run-eval']);
    assert.equal(entry.message, RUN_PLAN_FIXED);
  }
  for (const options of [{ attempts: 3, case: [FAILURE] }, { model: 'synthetic/other' }, { model: 'synthetic/other', attempts: 2 }, { agent: AGENT },
    { agent: 'other_agent:OtherAgent' }, { baseline: true, model: 'synthetic/other' }]) {
    assert.throws(() => startRun(repo, CHANGE, options), refused('run_plan_fixed'), JSON.stringify(options));
  }
  assert.deepEqual(runIds(runs), before);
  assert.equal(tools.runs().length, calls);
  // A partial run makes one attempt of each package and has no role.
  const partial = startRun(repo, CHANGE, { case: [FAILURE] });
  assert.deepEqual([partial.execution_status, partial.role, readRecord(partial).run.role], ['completed', null, null]);
  assert.deepEqual(attemptsGiven(tools, 1), { [FAILURE]: '1' });
  assert.deepEqual(partial.attempts, { [FAILURE]: 1 });
  assert.equal(tools.runs().length, calls + 1);
  assert.equal(runIds(runs).length, before.length + 1);
  // A model written into harness.json changes the kit, which ends the loop.
  const harness = path.join(root, '..', 'harness', 'harness.json');
  writeFileSync(harness, `${JSON.stringify({ agent: AGENT, model: 'synthetic/kit-model' })}\n`);
  checkEval(repo, CHANGE);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason], ['loop_ended', 'packages_changed']);
  assert.ok(status.ended.files.includes('kit/harness.json'), JSON.stringify(status.ended));
  assert.throws(() => startRun(repo, CHANGE), refused('loop_ended'));
});

test('inside a loop a head run without flags uses the model of the loop\'s checks confirmation, even when harness.json names none', (t) => {
  const project = readyProject(t, { live: [FAILURE], confirm: false });
  const { repo, tools } = project;
  startRun(repo, CHANGE, { baseline: true, model: 'synthetic/model-m', attempts: 2 });
  // The user confirms the plan the baseline ran.
  confirmChecks(project, { attempts: 2, model: 'synthetic/model-m' });
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
    `The settings of this run differ from those of the baseline ${base.run_id}: attempts 2 here, 3 in the baseline. A different result may come from that, not from the change. Run with the baseline's settings to compare like with like.`]);
});

test('after an unavailable baseline the user confirmed with model none, a head run with another model is refused, and a confirmation of another model ends the loop', (t) => {
  const project = readyProject(t, { mode: 'new', results: {} });
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
  const revised = confirmChecks(project, { model: 'synthetic/model-m', attempts: 1, reason: 'The user chose model-m.' });
  assert.equal(revised.confirmation.run_plan.model, 'synthetic/model-m');
  assert.ok(revised.next.startsWith('The loop for this Spec has ended (confirmation_changed). The checks are confirmed. Record the baseline next: `run start --baseline --unavailable no_implementation` reads N, the agent and the model from confirmed.json.'), revised.next);
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason, status.ended.plan], ['loop_ended', 'confirmation_changed', ['model']]);
  assert.throws(() => startRun(repo, CHANGE), refused('loop_ended'));
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

test('inside a loop a head run takes the model or agent the user confirmed over the one harness.json names, and a flag for it is refused', (t) => {
  const project = readyProject(t, { live: [FAILURE], model: 'synthetic/kit-model', confirm: false });
  const { repo, tools } = project;
  startRun(repo, CHANGE, { baseline: true, model: 'synthetic/flag-model', attempts: 2 });
  confirmChecks(project, { attempts: 2, model: 'synthetic/flag-model' });
  startLoop(repo, CHANGE);
  setResults(repo, AFTER);
  // No flag is needed: the run takes the confirmed model.
  const head = startRun(repo, CHANGE);
  assert.equal(head.verdict, 'pass');
  assert.ok(tools.runs().slice(-2).every((call) => valueOf(call.argv, '-m') === 'synthetic/flag-model'));
  for (const model of ['synthetic/flag-model', 'synthetic/third-model']) {
    assert.throws(() => startRun(repo, CHANGE, { model }), (error) => {
      refused('run_plan_fixed')(error);
      assert.doesNotMatch(error.gaps[0].message, /pass --model/);
      return true;
    });
  }

  const other = readyProject(t, { live: [FAILURE], confirm: false });
  startRun(other.repo, CHANGE, { baseline: true, agent: 'other_agent:OtherAgent', attempts: 2 });
  confirmChecks(other, { attempts: 2, agent: 'other_agent:OtherAgent' });
  startLoop(other.repo, CHANGE);
  setResults(other.repo, AFTER);
  assert.equal(startRun(other.repo, CHANGE).verdict, 'pass');
  assert.ok(other.tools.runs().slice(-2).every((call) => valueOf(call.argv, '-a') === 'other_agent:OtherAgent'));
  assert.throws(() => startRun(other.repo, CHANGE, { agent: 'other_agent:OtherAgent' }), refused('run_plan_fixed'));
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
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'confirm_checks');
  confirmChecks(project, { reason: `${FAILURE} calls the model.`, attempts: 3 });
  // Then workflow check gives the baseline command again, the way it was recorded.
  const recorded = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(recorded.next.action, 'record_baseline', JSON.stringify(recorded.next));
  // The confirmation holds the number, so the command passes none.
  assert.deepEqual(recorded.next.command, ['run', 'start', CHANGE, '--repo', repo, '--baseline', '--unavailable', 'no_implementation']);
  assert.ok(recorded.next.note.startsWith(`The baseline ${base.run_id} fixed no number of attempts, so no loop can run ${FAILURE} on it: record it again. The baseline reads the number of attempts, the agent and the model the user confirmed from confirmed.json: pass none of them.`), recorded.next.note);
  assert.equal(checkWorkflow(repo, 'loop-and-implement', CHANGE).next.action, 'resolve_business_decisions');
  assert.throws(() => startLoop(repo, CHANGE), (error) => {
    assert.equal(error.code, 'LOOP_INPUT_BLOCKED');
    assert.deepEqual(error.gaps.map((gap) => gap.code), ['attempts_undecided']);
    const [entry] = error.gaps;
    assert.deepEqual([entry.kind, entry.owner, entry.route], ['business', 'user', 'run-eval']);
    assert.equal(entry.message, `${FAILURE} declares a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so a loop on that baseline could not run it the user's number of times. That number is the user's decision. The user confirmed 3 attempts in confirmed.json: record the baseline again with \`run start --baseline --unavailable no_implementation\`, which reads that number, then run \`loop start\`.`);
    return true;
  });
  const again = startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  assert.equal(again.run_plan.attempts, 3);
  assert.equal(checkWorkflow(repo, 'run-eval', CHANGE).next.action, 'start_loop');
  assert.equal(startLoop(repo, CHANGE).loop.baseline, again.run_id);
});

test('a package that declares a live dependency after a baseline that fixed no number of attempts ends a loop, and warns outside one', (t) => {
  const project = readyProject(t);
  const { repo, root } = project;
  const base = startRun(repo, CHANGE, { baseline: true });
  startLoop(repo, CHANGE);
  const file = path.join(root, 'evals', FAILURE, 'tests/checks.json');
  const declared = readJSON(file);
  declared.dependencies = [LIVE_DEPENDENCY];
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  checkEval(repo, CHANGE);
  setResults(repo, AFTER);
  // The package changed, so the loop has ended.
  const status = loopStatus(repo, CHANGE);
  assert.deepEqual([status.next.action, status.next.reason, status.ended.packages], ['loop_ended', 'packages_changed', [FAILURE]]);
  assert.throws(() => startRun(repo, CHANGE), refused('loop_ended'));
  // The user's confirmation of it needs their number of attempts.
  assert.throws(() => confirmChecks(project, { reason: `${FAILURE} calls the model.` }), (error) => error.gaps.some((gap) => gap.code === 'attempts_undecided'));
  // Outside a loop the package runs once, with a warning.
  rmSync(loopFile(root));
  const outside = startRun(repo, CHANGE);
  assert.equal(outside.execution_status, 'completed');
  assert.ok(outside.warnings.includes(`${FAILURE} declares a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so it ran once.`), JSON.stringify(outside.warnings));
});
