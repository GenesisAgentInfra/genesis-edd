import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../../src/project.js';
import { runTools, startRun } from '../../src/run.js';
import { validateEval } from '../../src/eval.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FAKE_HARBOR_VERSION, PACKAGES, cli, commit, readRecord, readyProject, setResults, writeExpectations,
} from './edd.js';

test('the harness builds a ready project that a baseline and a head run compare check by check', (t) => {
  const { repo, tools, packages, check, runs } = readyProject(t);
  assert.deepEqual(packages, PACKAGES);
  assert.equal(check.passed, true);
  assert.deepEqual(check.cases.map((item) => item.case), Object.keys(PACKAGES));
  assert.deepEqual(validateEval(repo, CHANGE).cases.map((item) => item.integration.state), ['ready', 'ready']);
  // eval check ran every fixture with the fixture agent and the application root:
  // pass, fail and unknown, and a reviewer's counterexample for each of the three lines.
  const fixtures = tools.runs().filter((call) => call.argv.includes('genesis_fixture:FixtureAgent'));
  assert.equal(fixtures.length, 9);
  assert.ok(fixtures.every((call) => call.env.GENESIS_EDD_REPO === repo && call.env.GENESIS_EDD_FIXTURE.endsWith('.sh')));

  const expect = writeExpectations(repo, { 'submit-failure-s1/c1': 'fail', 'submit-success-s1/c1': 'pass', 'submit-success-s1/c2': 'pass' });
  const base = startRun(repo, CHANGE, { baseline: true, expect });
  assert.equal(base.execution_status, 'completed', JSON.stringify(base));
  assert.equal(base.is_baseline, true);
  assert.deepEqual(base.baseline_mismatch, []);
  assert.equal(readRecord(base).run.environment_ref.harbor, FAKE_HARBOR_VERSION);
  assert.equal(readRecord(base).compare, null);
  assert.deepEqual(readJSON(path.join(base.directory, 'submit-failure-s1/check-results.json')).results.map((entry) => entry.result), ['fail']);

  setResults(repo, AFTER);
  commit(repo, 'Stop the success notice when a submission fails');
  const head = startRun(repo, CHANGE);
  assert.equal(head.execution_status, 'completed', JSON.stringify(head));
  assert.equal(head.baseline, base.run_id);
  assert.equal(head.verdict, 'pass');
  assert.ok(existsSync(path.join(runs, head.run_id, 'compare.json')));
  const { compare } = readRecord(head);
  assert.deepEqual(compare.results.map(({ case: id, check: entry, before, after, verdict }) => [id, entry, before, after, verdict]), [
    ['submit-failure-s1', 'c1', 'fail', 'pass', 'holds'],
    ['submit-success-s1', 'c1', 'pass', 'pass', 'holds'],
    ['submit-success-s1', 'c2', 'pass', 'pass', 'holds'],
  ]);
  const last = tools.runs().at(-1);
  assert.equal(last.argv[last.argv.indexOf('-a') + 1], AGENT);
  assert.equal(last.env.GENESIS_EDD_REPO, repo);

  // Breaking the code again is a violation, and the CLI exits 0 for a business failure.
  setResults(repo, BEFORE);
  const again = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.verdict, 'fail');
  assert.equal(again.json.compare.violated, 1);
});

test('the fake tools can report Docker down, Harbor missing and Harbor errors', (t) => {
  const { repo, tools } = readyProject(t, { spec: 'example', results: { 'submit-failure-s1': 'error' } });
  tools.docker(false);
  assert.deepEqual(runTools().gaps.map((gap) => gap.code), ['docker_unavailable']);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => error.gaps.some((gap) => gap.code === 'docker_unavailable'));
  tools.docker(true);
  tools.harbor(false);
  assert.deepEqual(runTools().gaps.map((gap) => gap.code), ['harbor_missing']);
  tools.harbor(true);
  const base = startRun(repo, CHANGE, { baseline: true });
  assert.equal(base.execution_status, 'error');
  assert.match(base.cases[0].execution.reason, /0 of 1 trial results \(exit 1\)/);
  setResults(repo, { 'submit-failure-s1': 'exception' });
  const retry = startRun(repo, CHANGE, { baseline: true });
  assert.equal(retry.execution_status, 'error');
  assert.match(retry.cases[0].execution.reason, /^RuntimeError: /);
});

test('the fake Harbor writes increasing trial times and an adapter\'s reported usage', (t) => {
  const { repo, runs } = readyProject(t, { spec: 'example', live: ['submit-failure-s1'],
    results: { 'submit-failure-s1': { c1: 'fail', $usage: { n_input_tokens: 10, n_output_tokens: 4, cost_usd: 0.002 } } } });
  const base = startRun(repo, CHANGE, { baseline: true, attempts: 3 });
  const trials = path.join(runs, base.run_id, 'submit-failure-s1/logs/harbor');
  const outcomes = ['trial-1', 'trial-2', 'trial-3'].map((trial) => readJSON(path.join(trials, trial, 'result.json')));
  for (const [index, outcome] of outcomes.entries()) {
    assert.ok(outcome.started_at <= outcome.finished_at, JSON.stringify(outcome));
    if (index) assert.ok(outcomes[index - 1].finished_at < outcome.started_at);
    assert.deepEqual(outcome.agent_result, { n_input_tokens: 10, n_output_tokens: 4, cost_usd: 0.002 });
  }
});
