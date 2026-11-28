import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readJSON } from '../../src/project.js';
import { checkEval, cleanupRun, runTools, startRun } from '../../src/run.js';
import { validateEval } from '../../src/eval.js';
import { acceptLoop, loopStatus, startLoop as startLoopBare } from '../../src/loop.js';
import { readDecisions } from '../../src/records.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, CONSENT, FAKE_HARBOR_VERSION, PACKAGES, REF, USER, assertGapShape, cli, commit, readRecord, readyProject, setResults,
  startLoop, writeExpectations,
} from './edd.js';
import {
  BROKEN, FAILURE, SUCCESS, assertEnded, assertFinalDue, assertStopBudget, blockedWith, changeCode, finalsLoop, fullRun, inLoop, newProjectLoop, passingScreen,
  reviewRun, withBaseline,
} from './loop.js';

test('the harness builds a ready project that a baseline and a head run compare check by check', (t) => {
  const { repo, tools, packages, check, confirmation, runs } = readyProject(t);
  assert.deepEqual(packages, PACKAGES);
  assert.equal(check.passed, true);
  assert.deepEqual(check.cases.map((item) => item.case), Object.keys(PACKAGES));
  assert.deepEqual(validateEval(repo, CHANGE).cases.map((item) => item.integration.state), ['ready', 'ready']);
  // eval check ran every fixture with the fixture agent and the application root:
  // pass, fail and unknown, and a reviewer's counterexample for each of the three lines.
  const fixtures = tools.runs().filter((call) => call.argv.includes('genesis_fixture:FixtureAgent'));
  assert.equal(fixtures.length, 9);
  assert.ok(fixtures.every((call) => call.env.GENESIS_EDD_REPO === repo && call.env.GENESIS_EDD_FIXTURE.endsWith('.sh')));
  // And the empty-run probe of each package, with Harbor's nop agent, under
  // which the fake verifier finds no evidence.
  const probes = tools.runs().filter((call) => call.argv[call.argv.indexOf('-a') + 1] === 'nop');
  assert.deepEqual(probes.map((call) => path.basename(call.argv[call.argv.indexOf('-p') + 1])), Object.keys(PACKAGES));
  assert.ok(probes.every((call) => call.env.GENESIS_EDD_REPO === repo && call.env.GENESIS_EDD_FIXTURE === undefined));
  // Sealed packages without a live dependency or a model: the user confirmed
  // the light tier the CLI proposed, as the user's decision.
  const plan = confirmation.confirmation.run_plan;
  assert.deepEqual([plan.tier, plan.tier_by, plan.attempts, plan.agent, plan.model], ['light', 'proposal', null, AGENT, null]);
  assert.deepEqual([confirmation.confirmation.confirmed.by, confirmation.confirmation.confirmed.ref], [USER, REF]);

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
  // Outside a loop a pass is no acceptance.
  assert.equal(head.in_loop, false);
  assert.equal(typeof head.not_acceptance, 'string');
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

  // Breaking the code again is a violation, and the CLI exits 0 for a business
  // failure. Progress is off in tests until the test turns it on; then it goes
  // to stderr, one line per package, and stdout stays JSON.
  setResults(repo, BEFORE);
  tools.progress(true);
  const again = cli(['run', 'start', CHANGE, '--repo', repo]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.verdict, 'fail');
  assert.equal(again.json.compare.violated, 1);
  assert.match(again.stderr, new RegExp(`^genesis-edd: run ${again.json.run_id} \\(head\\): ${FAILURE} started`, 'm'));
  tools.progress(false);
});

test('the fake tools can report Docker down, Harbor missing and Harbor errors, and the fake Docker removes only a run\'s compose objects', (t) => {
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

  // The trial of the retry ran in compose project trial-1__env; another
  // project's objects stay.
  tools.dockerObjects({ containers: [{ id: 'c-run', project: 'trial-1__env' }, { id: 'c-other', project: 'someone-else' }],
    networks: [{ id: 'n-run', project: 'trial-1__env' }], volumes: [{ id: 'v-other', project: 'someone-else' }] });
  const cleaned = cleanupRun(repo, CHANGE, { run: retry.run_id });
  assert.deepEqual([cleaned.projects, cleaned.removed, cleaned.errors], [['trial-1__env'], { containers: ['c-run'], networks: ['n-run'], volumes: [] }, []]);
  assert.deepEqual(tools.dockerObjects(), { containers: [{ id: 'c-other', project: 'someone-else' }], networks: [], volumes: [{ id: 'v-other', project: 'someone-else' }] });
  assert.ok(tools.dockerCalls().some((call) => call.argv.join(' ') === 'rm -f c-run'), JSON.stringify(tools.dockerCalls()));
  tools.docker(false);
  assert.throws(() => cleanupRun(repo, CHANGE, { run: retry.run_id }), (error) => error.gaps.some((gap) => gap.code === 'docker_unavailable'));
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

test('the empty-run probe finds every check unknown, unless app/probe.json stands for a verifier that judges without evidence', (t) => {
  const { repo } = readyProject(t, { check: false });
  writeFileSync(path.join(repo, 'app/probe.json'), `${JSON.stringify({ [FAILURE]: { c1: 'pass' } })}\n`);
  const caught = checkEval(repo, CHANGE);
  assert.equal(caught.passed, false);
  const outcome = (result, id) => result.cases.find((item) => item.case === id);
  assert.deepEqual([outcome(caught, FAILURE).passed, outcome(caught, FAILURE).probe.ok, outcome(caught, FAILURE).probe.unexpected], [false, false, [{ check: 'c1', result: 'pass' }]]);
  assert.deepEqual([outcome(caught, SUCCESS).passed, outcome(caught, SUCCESS).probe.ok], [true, true]);
  rmSync(path.join(repo, 'app/probe.json'));
  const proved = checkEval(repo, CHANGE);
  assert.equal(proved.passed, true, JSON.stringify(proved));
  assert.deepEqual(proved.cases.map((item) => [item.case, item.probe.ok]), [[FAILURE, true]]);
});

test('readyProject confirms each tier the way the CLI records it', (t) => {
  // The full tier on the user's request: a baseline may then record that
  // nothing could run, which the light tier refuses in an existing project.
  const full = readyProject(t, { tier: 'full' });
  const fullPlan = full.confirmation.confirmation.run_plan;
  assert.deepEqual([fullPlan.tier, fullPlan.tier_by], ['full', 'flag']);
  assert.equal(startRun(full.repo, CHANGE, { baseline: true, unavailable: 'no_implementation' }).execution_status, 'not_run');
  const light = readyProject(t);
  assert.throws(() => startRun(light.repo, CHANGE, { baseline: true, unavailable: 'no_implementation' }), (error) => error.gaps.some((gap) => gap.code === 'light_baseline_required'));
  // A package that is not connected cannot be proved, so such a project is
  // confirmed in the full tier.
  assert.equal(readyProject(t, { unconnected: [SUCCESS] }).confirmation.confirmation.run_plan.tier, 'full');
  // A live package makes the change of the full tier, with the number of
  // attempts the user confirmed.
  const live = readyProject(t, { live: [FAILURE] }).confirmation.confirmation.run_plan;
  assert.deepEqual([live.tier, live.attempts], ['full', 3]);
  // proof 'baseline': the line the change fixes has no counterexample, and its
  // failure at the baseline recorded before the confirmation proves its checks
  // can fail; a loop can start on that baseline.
  const proved = readyProject(t, { proof: 'baseline' });
  assert.equal(proved.base.is_baseline, true);
  const proofs = Object.fromEntries(proved.confirmation.confirmation.lines.map((line) => [`${line.package}/${line.then}`, line.proof.sources]));
  assert.deepEqual(Object.values(proofs), [['baseline_failure'], ['counterexample'], ['counterexample']]);
  assert.deepEqual([proved.confirmation.confirmation.run_plan.tier, proved.confirmation.baseline.recorded, proved.confirmation.baseline.kept], ['light', proved.base.run_id, true]);
});

test('startLoop records the user\'s consent with by and ref, and a loop does not start without it', (t) => {
  const project = withBaseline(t);
  assert.throws(() => startLoopBare(project.repo, CHANGE), (error) => {
    blockedWith('loop_consent_missing')(error);
    assertGapShape(error.gaps.find((entry) => entry.code === 'loop_consent_missing'), { owner: 'user', layer: 'loop' });
    return true;
  });
  const started = startLoop(project.repo, CHANGE);
  assert.deepEqual([started.consent.by, started.consent.ref], [USER, REF]);
  assert.deepEqual([started.loop.consent.by, started.loop.consent.ref, started.loop.tier], [USER, REF, 'light']);
  const decision = readDecisions(project.root).entries.filter((entry) => entry.type === 'loop_start');
  assert.deepEqual(decision.map((entry) => [entry.by, entry.ref, entry.loop_started_at]), [[USER, REF, started.loop.started_at]]);
  // The same words can confirm the checks and start the loop (--start-loop):
  // the loop then starts without by and ref, citing the confirmation.
  const agreed = withBaseline(t, { startLoop: true });
  const viaConfirmation = startLoop(agreed.repo, CHANGE, { by: undefined, ref: undefined });
  assert.deepEqual([viaConfirmation.consent.via, viaConfirmation.consent.confirmation, viaConfirmation.consent.by], ['confirmation', agreed.confirmation.confirmation.id, USER]);
});

test('a light loop goes from a passing run to a recorded final review and the user\'s acceptance', (t) => {
  const project = inLoop(t);
  changeCode(project.repo, AFTER, 'Stop the success notice when a submission fails');
  const run = fullRun(project.repo);
  assert.equal(run.verdict, 'pass');
  assert.deepEqual(loopStatus(project.repo, CHANGE).gates.accept.map((entry) => entry.code), ['review_missing']);
  const reviewed = reviewRun(project, run.run_id);
  assert.deepEqual([reviewed.review.reviewer, reviewed.covers], ['subagent', [run.run_id]]);
  assert.deepEqual(loopStatus(project.repo, CHANGE).gates.accept, []);
  const accepted = acceptLoop(project.repo, CHANGE, { run: run.run_id, ...CONSENT });
  assert.deepEqual([accepted.accepted.accepted.by, accepted.accepted.accepted.ref], [USER, REF]);
  assert.equal(loopStatus(project.repo, CHANGE).phase, 'done');
});

test('a full-tier loop with a live package runs its final run after a passing screen run', (t) => {
  const project = finalsLoop(t);
  assert.equal(project.loop.tier, 'full');
  const screen = passingScreen(project);
  assertFinalDue(loopStatus(project.repo, CHANGE), screen.run_id, project.repo);
  const final = fullRun(project.repo);
  assert.deepEqual([final.role, final.verdict, readRecord(final).run.final_of], ['final', 'pass', screen.run_id]);
  // The review of the screen run covers its final run: same code.
  assert.deepEqual(loopStatus(project.repo, CHANGE).gates.accept, []);
});

test('the loop helpers read an ended loop from its facts', (t) => {
  const project = inLoop(t, { iterations: 1 });
  changeCode(project.repo, BROKEN, 'Break the successful submission');
  fullRun(project.repo);
  assertStopBudget(loopStatus(project.repo, CHANGE), 'budget_used_up');
  // A new project's loop ends once its packages are connected.
  const fresh = newProjectLoop(t);
  assert.equal(fresh.loop.tier, 'full');
  assertEnded(loopStatus(fresh.repo, CHANGE), 'packages_changed');
});
