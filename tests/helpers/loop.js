// Helpers the loop test files (loop.test.js and loop-*.test.js) share. They
// were the local helpers of loop.test.js before it was split by topic.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJSON } from '../../src/project.js';
import { exportSpec } from '../../src/spec.js';
import { rebindEval } from '../../src/eval.js';
import { checkEval, codeSnapshot, startRun } from '../../src/run.js';
import { reviewLoop, writeReport } from '../../src/loop.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, SPECS, commit, confirmChecks, connect, git, readRecord, readyProject, setResults, startLoop, writeExpectations, writeSpec,
} from './edd.js';

// The consent of the user and startLoop with it (see edd.js), so a loop test
// file imports them from here with the rest.
export { APPROVAL, APPROVAL_FLAGS, CONSENT, CONSENT_FLAGS, LAYERS, REF, USER, actionOf, allowedActions, assertGapShape, assertNoRoutes, assertSuggestion, startLoop } from './edd.js';

// What the code before the change does: a failed submission still sends a
// success notice, and a successful one behaves.
export const EXPECT = { 'submit-failure-s1/c1': 'fail', 'submit-success-s1/c1': 'pass', 'submit-success-s1/c2': 'pass' };
// A change that fixes the failed submission and breaks the successful one.
export const BROKEN = { 'submit-failure-s1': { c1: 'pass' }, 'submit-success-s1': { c1: 'fail', c2: 'pass' } };
// The mark of a template file `eval new` writes (instruction.md, PROJECT.md,
// test.sh) that still waits for its content.
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

// A ready project (readyProject options) whose baseline ran on the code
// before the change, with EXPECT. A project of proof 'baseline' keeps the
// baseline it recorded before the confirmation.
export function withBaseline(t, options = {}) {
  const project = readyProject(t, options);
  const base = project.base ?? startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  return { ...project, base };
}

// The same, with a loop the user agreed to (by USER, ref REF) started on that
// code. budget holds startLoop's budget flags: iterations, minutes, maxCost.
// options go to readyProject.
export function inLoop(t, budget = {}, options = {}) {
  const project = withBaseline(t, options);
  const started = startLoop(project.repo, CHANGE, budget);
  return { ...project, loop: started.loop, started };
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

// A full head run of a loop writes its report itself (Result and Changes from
// the records); the rest is the agent's free notes. This writes the report
// when it is missing and adds a note under Notes, as an agent would, and
// returns its file. Nothing waits for the notes: a final review is recorded
// with reviewRun (`loop review`), never in the report.
export function completeReport(repo, runId, options = {}) {
  if ('review' in options) throw new Error('completeReport writes notes only. A final review is recorded with reviewRun (`loop review`); the report has no Review section any more.');
  const { note = 'Synthetic notes: the handler ignored the submission result (see logs/harbor.log). Change it, then run every package again.' } = options;
  const { file } = writeReport(repo, CHANGE, { run: runId });
  const text = readFileSync(file, 'utf8');
  if (!text.includes(note)) writeFileSync(file, text.replace(/^## Notes[ \t]*$/m, `## Notes\n\n${note}`));
  return file;
}

// The gating checks of a run that went from not passing to passing against
// its baseline: what a final review must explain. [{ case, check }].
export function flipsOf(project, runId) {
  const { compare } = readRecord(path.join(project.runs, runId));
  return (compare?.results ?? []).filter((entry) => entry.role === 'gating' && entry.after === 'pass' && entry.before !== 'pass')
    .map((entry) => ({ case: entry.case, check: entry.check }));
}

let reviews = 0;
// Records a final review of a passing run of the loop, as `loop review` does:
// the answers are written to a file of this test (tools.directory), then
// reviewLoop records them. By default the reviewer is a subagent, the change to
// app/handler.txt explains every check that went from not passing to passing
// (flipsOf), and nothing special-cases an eval input, changes what the Spec
// does not ask for, or has a side effect no check covers. Options: reviewer
// ('subagent' | 'human' | 'genesis' | 'self'), by, and any field of the
// answers to replace: flips, special_cases, outside_spec, side_effects
// ({ found, detail }), notes. Returns the reviewLoop result; throws its refusals.
export function reviewRun(project, runId, options = {}) {
  const { reviewer = 'subagent', by, ...given } = options;
  const flips = flipsOf(project, runId).map((entry) => ({ ...entry, explained_by: 'app/handler.txt: the handler now reads the submission result before it sends a notice.' }));
  const answers = { flips, special_cases: { found: false, detail: null }, outside_spec: { found: false, detail: null },
    side_effects: { found: false, detail: null }, notes: 'Synthetic final review.', ...given };
  reviews += 1;
  const file = path.join(project.tools.directory, `final-review-${reviews}.json`);
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  return reviewLoop(project.repo, CHANGE, { run: runId, answers: file, reviewer, ...(by === undefined ? {} : { by }) });
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

// A loop that ended (loop status, or any result with the same fields): phase
// ended, ended.reason and the situation say why, run start and loop accept
// refuse it with the same gap (loop_ended, or the stop's own code for a stop),
// a new loop needs the user's consent, and nothing is suggested.
export function assertEnded(status, reason) {
  assert.ok(status && typeof status === 'object' && 'phase' in status, 'assertEnded takes the loop status, not status.next');
  assert.equal(status.phase, 'ended', JSON.stringify({ situation: status.situation, ended: status.ended }));
  assert.equal(status.ended?.reason, reason, JSON.stringify(status.ended));
  assert.deepEqual(status.situation, { code: 'ended', reason }, JSON.stringify(status.situation));
  const code = reason.startsWith('stop_') ? reason : 'loop_ended';
  assert.equal(status.gates.head_run?.code, code, JSON.stringify(status.gates.head_run));
  assert.ok(status.gates.accept.some((entry) => entry.code === code), JSON.stringify(status.gates.accept));
  assert.ok(status.ended.new_loop?.consents?.includes('new_loop'), JSON.stringify(status.ended.new_loop));
  assert.equal(status.suggestion, null, JSON.stringify(status.suggestion));
}

// A loop that ended on its budget (stop_budget): assertEnded's facts, the
// budget's reason when given ('budget_used_up' or 'final_run_does_not_fit'),
// and the two decisions of the user that go on from it: a revised budget
// (`loop budget`) or a new loop.
export function assertStopBudget(status, budgetReason = null) {
  assert.ok(status && typeof status === 'object' && 'phase' in status, 'assertStopBudget takes the loop status, not status.next');
  assertEnded(status, 'stop_budget');
  if (budgetReason) assert.equal(status.ended.budget_reason, budgetReason, JSON.stringify(status.ended));
  assert.deepEqual(status.ended.new_loop.consents.filter((entry) => ['new_loop', 'budget'].includes(entry)), ['new_loop', 'budget'], JSON.stringify(status.ended.new_loop));
}

// A loop whose final run of screen run screen is due: the situation says so,
// with the plan of the final run, and the suggestion is a full run.
export function assertFinalDue(status, screen, repo) {
  assert.equal(status.phase, 'live', JSON.stringify(status.situation));
  assert.equal(status.situation.code, 'final_run_due', JSON.stringify(status.situation));
  assert.equal(status.situation.candidate, screen, JSON.stringify(status.situation));
  assert.equal(status.final.pending, true, JSON.stringify(status.final));
  if (repo) assert.deepEqual(status.suggestion?.command, ['run', 'start', CHANGE, '--repo', repo], JSON.stringify(status.suggestion));
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

// Exports the revised Spec and binds every package to it with `eval rebind`
// (their requirements and scenarios read the same), proves them again, and the
// user confirms the checks of the new export (confirmChecks with options, such
// as { tier: 'full' }). Returns the export.
export function exportRevision(project, options = {}) {
  writeSpec(project.repo, REVISED);
  const exported = exportSpec(project.repo, CHANGE);
  const rebound = rebindEval(project.repo, CHANGE);
  assert.deepEqual(rebound.stale, [], JSON.stringify(rebound));
  const checked = checkEval(project.repo, CHANGE);
  assert.equal(checked.passed, true, JSON.stringify(checked, null, 2));
  confirmChecks(project, options);
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

// A loop whose baseline ran the packages in live N times each, every other
// once: the full tier, with the N the user confirmed with the checks, which
// the baseline reads, and a loop the user agreed to.
export function liveLoop(t, attempts, live = [FAILURE]) {
  const project = readyProject(t, { live, attempts });
  const base = startRun(project.repo, CHANGE, { baseline: true, expect: writeExpectations(project.repo, EXPECT) });
  assert.equal(base.is_baseline, true, JSON.stringify(base));
  const started = startLoop(project.repo, CHANGE);
  return { ...project, base, loop: started.loop, started };
}

export const gapOf = (error, code) => error.gaps.find((entry) => entry.code === code);

// The strength sentence of a pass whose live packages had 3 attempts each.
export const STRENGTH_3 = 'The gating checks of packages with a live dependency each had 3 attempts with evidence, and none failed. A check that fails half the time passes all 3 with a 13% chance; one that fails one time in ten, with a 73% chance. That does not show the checks always hold.';

// The final run's fixed message is gone: loop status gives the facts
// (situation final_run_due, final, estimate) and a suggestion. These throw, so
// a test that still uses them fails on its own with this note.
const gone = (name) => () => { throw new Error(`${name} is gone: the final run is no longer announced with a fixed message. Assert the facts with assertFinalDue(status, screen, repo), status.final and status.loop.estimate.`); };
export const FINAL_COST = gone('FINAL_COST');
export const FINAL_RUN = gone('FINAL_RUN');

// A loop whose live FAILURE runs 3 attempts in the plan, with app/results.json
// outside the code, so a test sets what each attempt records without
// changing the code; app/handler.txt stands for the code.
export function finalsLoop(t) {
  const project = liveLoop(t, 3);
  resultsOutsideCode(project.repo);
  return project;
}

// Changes the code and makes a passing screen run of it, whose final review
// is recorded (reviewRun) unless review is false. A review is needed before
// acceptance, not before the final run.
export function passingScreen(project, results = AFTER, label = 'Stop the success notice when a submission fails', { review = true } = {}) {
  changeCode(project.repo, results, label);
  const screen = fullRun(project.repo);
  assert.deepEqual([screen.role, screen.verdict], ['screen', 'pass'], JSON.stringify(screen));
  if (review) reviewRun(project, screen.run_id);
  return screen;
}

// A new project confirmed before the kit named a model: the user confirms the
// full tier, since the light tier proves every line of a new project by a
// counterexample, which waits for its package to be connected. The loop
// starts, with the user's consent, on a baseline that records that nothing
// could run, and the packages are connected inside it, with harness.json
// naming the model then.
export function newProjectLoop(t) {
  const project = readyProject(t, { mode: 'new', unconnected: [FAILURE, SUCCESS], confirm: false, results: {} });
  const { repo } = project;
  const confirmed = confirmChecks(project, { tier: 'full' });
  assert.equal(confirmed.confirmation.run_plan.model, null);
  assert.equal(confirmed.confirmation.run_plan.tier, 'full');
  startRun(repo, CHANGE, { baseline: true, unavailable: 'no_implementation' });
  const started = startLoop(repo, CHANGE);
  writeFileSync(path.join(repo, '.genesis/edd/harness/harness.json'), `${JSON.stringify({ agent: AGENT, model: 'synthetic/m1' }, null, 2)}\n`);
  for (const id of [FAILURE, SUCCESS]) connect(repo, id);
  return { ...project, loop: started.loop, started };
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
