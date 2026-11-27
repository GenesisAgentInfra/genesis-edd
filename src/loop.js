import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { codeState, digest, genesisReview, gitStatus, ignoredArtifacts, isGenerated, readJSON, uncommittedArtifacts } from './project.js';
import {
  checksConfirmation, confirmationById, confirmationMatch, confirmationOf, eddDirectory, evalFilesChanged, evalSnapshot, isLive, legacyPackages, matchFiles, validateEval,
} from './eval.js';
// loop.js and run.js import each other; see the note in run.js.
import {
  acceptanceHolds, acceptedIn, activeLoop, attemptsFor, budgetUsed, codeIdentity, codeSnapshot, commitCode, confirmedPlan, connectedCase, declare, estimateRuns, failuresOf, finalsNeeded,
  ignoreRecords, liveCase, loopAccepted, loopStartCode, ofLoop, pinnedBase, pinnedStart, planOf, readRuns, recordedBaseline, recordedLoop, recoveredText, restoreHint, sameCode,
  sameCodeResults, savePatch, shownCost, shownMinutes, startCode, undecidedLive, unfinishedRuns, unfinishedWarning, unstableChecks, usageOfRuns,
} from './run.js';

const TEMPLATE_MARK = 'GENESIS_EDD_TEMPLATE';
const SECTIONS = ['Result', 'Cause', 'Changes', 'Next'];
// The fewest characters a Review can say who reviewed, what they checked and
// what they found in.
const REVIEW_MINIMUM = 40;
const isReviewGap = (entry) => entry.startsWith('section Review ');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const short = (commit) => (commit ? commit.slice(0, 7) : 'none');
// Files named in a message: the first ten, then how many more.
const named = (files) => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));
const gap = (code, route, message, owner = 'agent', kind = 'artifact') => ({ code, kind, owner, route, message });

// A run passes only on gating checks. When the user judges every THEN line
// of the change, no run can pass and no loop has anything to make pass.
const allManual = (evals) => {
  const lines = evals.coverage?.lines;
  return Boolean(lines?.total) && lines.manual === lines.total;
};
const NO_GATING = 'No package of this change has a gating check: every THEN line is in scenario.manual, for the user to judge. A run passes only on gating checks, so no run of this change can pass and no loop on it can be accepted.';
const NO_GATING_REPAIR = 'A line a program can judge needs a gating check, written with write-eval; otherwise the user judges the change without a loop.';
// What a new loop does after one that stopped with only its final run left:
// its own runs decide, so the code that passed is screened and reviewed again.
const SCREEN_AGAIN = ' A new loop counts only its own runs, so it screens and reviews this code again before its final run: a screen run of the code as it is, with no change, then its report and the final review.';

function blocked(message, repo, name, gaps) {
  return Object.assign(new Error(message), {
    code: 'LOOP_INPUT_BLOCKED', gaps,
    resume: { stage: 'loop-and-implement', change: name, command: ['workflow', 'check', 'loop-and-implement', name, '--repo', repo] },
  });
}

// How strongly a passing run rests on its attempts, from a fixed formula: k is
// the fewest attempts with evidence among the gating checks of packages with
// a live dependency, and a check that fails with chance p passes all k with
// chance (1 - p)^k, shown for p = 1/2 and p = 1/10. Packages without a live
// dependency ran once and are left out, except under a plan written before
// run plans, where every package ran the plan's number. No model is asked.
export function strengthOf(run, compare) {
  const environment = run?.environment_ref ?? {};
  const plan = planOf(run);
  const uniform = Boolean(plan?.uniform) && (plan.attempts ?? 1) > 1;
  const subject = uniform ? 'The gating checks' : 'The gating checks of packages with a live dependency';
  const considered = (compare ?? []).filter((entry) => entry.role === 'gating' && (uniform || isLive(environment.dependencies?.[entry.case])));
  if (!considered.length) {
    return { attempts: null, pass_all_chance: null, single_sample: false,
      sentence: 'No package declares a live dependency, so each check ran once. That stands for later runs only while those packages give the same result every time.' };
  }
  const k = Math.min(...considered.map((entry) => (entry.after_counts ? entry.after_counts.pass + entry.after_counts.fail
    : environment.attempts_by_case?.[entry.case] ?? environment.attempts ?? 1)));
  const percent = (value) => (value < 0.01 ? 'less than 1%' : `${Math.round(value * 100)}%`);
  // "an 81% chance", "a 73% chance".
  const chance = (value) => `${/^(8\d?|11|18)%/.test(percent(value)) ? 'an' : 'a'} ${percent(value)} chance`;
  const half = 0.5 ** k;
  const tenth = 0.9 ** k;
  const sentence = k === 1
    ? `${subject} each had 1 attempt with evidence: a single sample. A check that fails half the time passes it with ${chance(half)}; one that fails one time in ten, with ${chance(tenth)}. That does not show the checks always hold.`
    : `${subject} each had ${k} attempts with evidence, and none failed. A check that fails half the time passes all ${k} with ${chance(half)}; one that fails one time in ten, with ${chance(tenth)}. That does not show the checks always hold.`;
  // Kept to four significant digits, so a record shows 0.729, not 0.7290000000000001.
  const kept = (value) => Number(value.toPrecision(4));
  return { attempts: k, pass_all_chance: { fails_half: kept(half), fails_one_in_ten: kept(tenth) }, single_sample: k === 1, sentence };
}

// The steps that end a loop: a fixed input of it changed (loop_ended), or a
// stop. A loop that ended stays so: run start refuses its head runs, and loop
// accept refuses it.
export const END_ACTIONS = ['loop_ended', 'stop_budget', 'stop_stuck', 'stop_unstable', 'stop_incomplete', 'stop_no_gating'];
// The steps that lead to another head run. A stop that holds replaces them.
const HEAD_RUN_STEPS = ['iterate', 'run_again', 'final_run', 'repair_execution', 'split_changes'];

// Where a loop stands, from its loop status: done (the user accepted it),
// ended (a fixed input changed, or a stop), closing (a stop holds or the
// budget is used up, and only the report, the final review or the acceptance
// is left: no head run), or live.
export function loopPhase(status) {
  if (status.next.action === 'done') return 'done';
  if (status.ended || END_ACTIONS.includes(status.next.action)) return 'ended';
  if (status.stop || status.loop.exhausted) return 'closing';
  return 'live';
}

// The gap loop accept refuses an ended loop with, or one a stop holds for:
// the end or the stop, with its message. Null otherwise.
export function endGap(status) {
  if (status.next.action === 'done') return null;
  if (status.ended || END_ACTIONS.includes(status.next.action)) {
    return { code: status.ended ? 'loop_ended' : status.next.action, kind: 'business', owner: 'user', route: status.next.route ?? 'loop-and-implement',
      reason: status.next.reason ?? null, message: status.next.message };
  }
  if (status.stop) {
    return { code: status.stop.action, kind: 'business', owner: 'user', route: status.stop.route ?? 'loop-and-implement', reason: status.stop.reason ?? null, message: status.stop.message };
  }
  return null;
}

// The gap run start refuses a head run of a loop with: endGap's, or, once the
// budget is used up, stop_budget. Once the user accepted the loop, head runs
// go on as before. Null otherwise.
export function headRunGap(status) {
  if (status.next.action === 'done') return null;
  const end = endGap(status);
  if (end) return end;
  if (!status.loop.exhausted) return null;
  const { used, budget } = status.loop;
  return { code: 'stop_budget', kind: 'business', owner: 'user', route: 'loop-and-implement', reason: 'budget_used_up',
    message: `The budget of this loop is used up (${used.iterations} of ${budget.iterations} runs, ${used.minutes} of ${budget.minutes} minutes), so \`run start\` refuses another head run: ${status.next.message} Finish the step \`loop status\` names: the report, the final review or the user's acceptance. If the user wants more runs instead, a bigger budget goes to a new loop once they agree: \`loop start --max-iterations N --max-minutes M\` starts one now that no head run is left in this one.` };
}

// What a baseline recorded again keeps from the one before it: the same
// --expect file, and no plan flag, since the baseline reads the plan the user
// confirmed. One that records that nothing could run has no --expect file.
const sameFlags = (base) => `${base?.is_baseline === false ? '' : 'the same --expect file and '}no --attempts, --agent or --model; the baseline reads the plan from confirmed.json`;

// Where an estimate of estimateRuns comes from, for a message.
const basisText = (estimate, base) => {
  if (estimate.basis === 'loop_attempts') return 'by the attempts of this loop\'s runs';
  if (estimate.basis === 'baseline_run') return `by the whole run of the baseline ${base.run_id}, ${shownMinutes(estimate.baseline_minutes)} minutes`;
  const checked = Object.entries(estimate.per_attempt ?? {}).filter(([, entry]) => entry.basis === 'eval_check').map(([id]) => id);
  if (estimate.basis === 'eval_check' && checked.length < Object.keys(estimate.per_attempt ?? {}).length) {
    return `by the attempts of the baseline ${base.run_id} and, for ${checked.join(', ')}, of the last eval check`;
  }
  return estimate.basis === 'eval_check' ? 'by the attempts of the last eval check' : `by the attempts of the baseline ${base.run_id}`;
};

// What the pass of a screen run rests on: one attempt of each package, as a
// screen run makes, or, for a run recorded before runs had a role, the
// attempts it made of each package, ids, that a final run runs attempts times.
const screenBasis = (run, ids, attempts) => {
  const made = [...new Set(ids.map((id) => run.environment_ref?.attempts_by_case?.[id] ?? run.environment_ref?.attempts ?? 1))].sort((a, b) => a - b);
  return run.role === 'screen' || made.every((count) => count === 1) ? 'one attempt of each package'
    : `${made.join(' or ')} attempts of each package that a final run runs ${attempts} times`;
};

const loopFile = (repo, name) => path.join(eddDirectory(repo, name), 'loop.json');
const reportFile = (repo, name, runId) => path.join(eddDirectory(repo, name), 'reports', `${runId}.md`);
const acceptedFile = (repo, name) => path.join(eddDirectory(repo, name), 'accepted.json');

// loop.json is replaced when a new loop starts; it keeps the loops before it
// under previous.
function saveLoop(repo, name, loop) {
  const file = loopFile(repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(loop, null, 2)}\n`);
}

// The budget of a loop: the flags given, and otherwise the fallback, such as
// the budget the user confirmed with the checks.
function budgetOptions(options, fallback = { iterations: 5, minutes: 60 }) {
  const iterations = options.iterations ?? fallback.iterations;
  const minutes = options.minutes ?? fallback.minutes;
  if (!Number.isInteger(iterations) || iterations < 1 || !(minutes > 0)) throw new Error('--max-iterations is a whole number of 1 or more and --max-minutes a number above 0.');
  return { iterations, minutes };
}

const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));

// The head runs of one loop: its Spec, from its start, made while it was the
// loop of loop.json (ofLoop). Full runs count toward the budget and can be
// accepted; partial ones are a quick look.
const loopRuns = (all, loop) => all.filter((run) => ofLoop(run, loop));
const fullRuns = (runs) => runs.filter((run) => (run.scope ?? 'full') === 'full');

// The user's acceptance of the loop running for this Spec, while it still
// covers the loop (loop status says done), or null. Read-only.
export function loopAcceptance(repo, name, spec) {
  const loop = readLoop(repo, name);
  if (!loop || loop.spec !== spec || !existsSync(acceptedFile(repo, name))) return null;
  let record = null;
  try { record = readJSON(acceptedFile(repo, name)); } catch { return null; }
  if (!acceptedIn(record, loop, fullRuns(loopRuns(readRuns(path.join(eddDirectory(repo, name), 'runs')), loop)))) return null;
  return loopStatus(repo, name).next.action === 'done' ? record : null;
}

// Why a loop does not start on a baseline that did not behave as declared,
// and the two ways out. workflow check run-eval says the same.
export const mismatchMessage = (base) => `The baseline ${base.run_id} did not behave as declared: ${base.baseline_mismatch
  .map((entry) => `${entry.case}/${entry.check} was expected to ${entry.expected} and got ${entry.got}`).join('; ')}. A loop does not start on it. Either the expectation in baseline-expectations.json is wrong: fix it and record the baseline again with it. Or this is not the code before the change: restore that code and record the baseline again. Ask the user when it is unclear what the code before the change does.`;

// The code a baseline ran on, for a message: its commit, and its code.patch
// only when the commit does not hold all of it.
const baselineCode = (name, base) => {
  const commit = base.code_snapshot?.commit ? `commit ${short(base.code_snapshot.commit)}` : 'no commit';
  return base.code_snapshot?.patch ? `${commit} plus \`git apply\` .genesis/edd/${name}/runs/${base.run_id}/code.patch` : commit;
};

// A new loop starts on the code its baseline ran on, or every comparison
// misleads. The gap that says the code is elsewhere and how to get back to
// it, or null. Every application file is set aside, the files the baseline's
// code.patch holds with them, so the commit plus that patch is the baseline's
// code again; .genesis/ and openspec/ stay, since the loop needs them. A base
// record that nothing could run says so of the code it was recorded on, so a
// loop starts on that code too: once the code is known to have changed, it is
// recorded again.
function notAtBaseline(repo, name, base, snapshot) {
  if (!base || !snapshot || sameCode(base.code_snapshot, snapshot, repo) === true) return null;
  // Nothing is compared with a record that nothing could run, so only code
  // known to differ from it is refused.
  if (!base.is_baseline) {
    if (sameCode(base.code_snapshot, snapshot, repo) !== false) return null;
    return gap('baseline_not_at_start', 'run-eval', `The baseline ${base.run_id} records that nothing could run on other code than the code now. A loop starts on the code its baseline was recorded on: record the baseline again on the code the loop starts from, with \`run start --baseline --unavailable ${base.baseline_unavailable_reason ?? 'no_implementation'}\`.`);
  }
  const patch = base.code_snapshot?.patch ? `.genesis/edd/${name}/runs/${base.run_id}/code.patch` : null;
  // Which way back works depends on what the current commit holds of the
  // application, not on its id: committing only the Spec or the evals moves
  // the commit, and so does committing the baseline's own uncommitted code.
  const head = snapshot.commit ? commitCode(repo, snapshot.commit) : null;
  const holdsBaseline = head && sameCode(base.code_snapshot, head, repo) === true;
  const holdsCommit = head && patch && base.code_snapshot.commit && sameCode(commitCode(repo, base.code_snapshot.commit), head, repo) === true;
  // Only uncommitted application files can be stashed; with none, nothing is
  // set aside or popped.
  const stash = snapshot.changed_files?.length > 0;
  const start = '`loop start` with the budget the user agreed';
  const way = !head
    ? `The project has no commit, so Git cannot set your edits aside: copy the files you changed out of the project, put back the files as the baseline ran on them${patch ? ` (${patch} holds them)` : ''}, run ${start}, then copy your edits back.`
    : holdsBaseline || holdsCommit
      ? `From the project root, ${[
        ...(stash ? ["set every edit aside with `git stash push --include-untracked -- . ':(exclude).genesis' ':(exclude)openspec'`"] : []),
        ...(holdsBaseline ? [] : [`put back the files the commit does not hold with \`git apply ${patch}\``]),
        `run ${start}`,
        ...(holdsBaseline ? [] : [`undo that with \`git apply -R ${patch}\``]),
        ...(stash ? ['then bring your edits back with `git stash pop`; staged changes come back unstaged'] : []),
      ].join(', ')}.`
      // A checkout of an older commit would also take away eval files
      // committed since, so there is no one safe recipe.
      : `Commit ${short(snapshot.commit)} holds application files other than the baseline's, so a stash cannot set them aside. Tell the user, and agree with them how to put the application files back to the baseline's while keeping .genesis/ and openspec/ as they are, before \`loop start\`.`;
  return gap('baseline_not_at_start', 'loop-and-implement', `The code changed after the baseline ${base.run_id}, so a loop cannot start until the code is the baseline's again (${baselineCode(name, base)}). If the change only served the evals, such as .dockerignore, record the baseline again instead, with ${sameFlags(base)}. Otherwise: ${way} Runs made before \`loop start\` are not part of the loop.`);
}

// Every run of a loop is compared with its baseline, so the baseline must have
// run the packages as they are now. The gap that names each package it did
// not run that way, or null. Only a baseline that ran is checked: an
// unavailable one has no result to compare with.
export function baselinePackagesDiffer(base, cases) {
  if (!base?.is_baseline) return null;
  const now = new Map(cases.map((item) => [item.id, item]));
  const ran = new Set((base.cases ?? []).map((item) => item.id));
  // A finished package that waits only for `eval check` is skipped by a
  // baseline, so it counts as one that did not run in it.
  const unchecked = cases.filter(waitsForCheck).map((item) => item.id).filter((id) => !ran.has(id));
  const parts = [...new Set([...ran, ...now.keys()])].sort().flatMap((id) => {
    const item = now.get(id);
    if (ran.has(id)) return !item ? [`${id} is gone`] : base.task_digest?.[id] !== item.task_digest ? [`${id} changed since`] : [];
    return item.integration?.state === 'ready' || unchecked.includes(id) ? [`${id} did not run in it`] : [];
  });
  const prove = unchecked.length ? ` Prove ${unchecked.join(', ')} with \`eval check\` first: a run skips a package whose verifier is not proved for it as it is.` : '';
  return parts.length ? gap('baseline_packages_differ', 'run-eval', `The baseline ${base.run_id} ran other eval packages than the ones now: ${parts.join('; ')}. Every run of a loop is compared with its baseline, so it must have run these packages.${prove} Record the baseline again on the code before the change, with ${sameFlags(base)}, then run \`loop start\` again.`) : null;
}

// A finished package that waits only for `eval check`: a run skips it until
// its verifier is proved for it as it is. An invalid one, which eval check
// refuses, waits for write-eval instead.
export const waitsForCheck = (item) => !item.errors?.length && item.integration?.state !== 'ready' && Array.isArray(item.integration?.missing)
  && item.integration.missing.length > 0 && item.integration.missing.every((entry) => entry === 'check');

// A loop does not start on a baseline that fixed no number of attempts while
// a package declares a live dependency: it could not run that package the
// user's number of times. The confirmation fixes the number and the baseline
// reads it. confirmation is the one that covers the packages as they are, or
// null. A baseline that records that nothing could run is recorded again the
// same way.
const startUndecided = (base, ids, confirmation) => {
  const n = confirmation?.run_plan?.attempts;
  const record = `run start --baseline${base.is_baseline ? '' : ` --unavailable ${base.baseline_unavailable_reason ?? 'no_implementation'}`}`;
  const expect = base.is_baseline ? ' and the same --expect file' : '';
  return gap('attempts_undecided', 'run-eval',
    `${declare(ids)} a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so a loop on that baseline could not run ${ids.length === 1 ? 'it' : 'them'} the user's number of times. That number is the user's decision. ${Number.isInteger(n)
      ? `The user confirmed ${n} attempt${n === 1 ? '' : 's'} in confirmed.json: record the baseline again with \`${record}\`${expect}, which reads that number, then run \`loop start\`.`
      : `With their agreement on N, record it with \`eval confirm --attempts N\` (with --reason when this Spec export was confirmed before), then record the baseline again with \`${record}\`${expect}, which reads N from confirmed.json, and run \`loop start\`.`}`,
    'user', 'business');
};

// The packages whose task digest differs between a record and now: ids in
// order. Both are { case: digest }.
const changedBetween = (recorded, now) => [...new Set([...Object.keys(recorded ?? {}), ...Object.keys(now ?? {})])]
  .filter((id) => recorded?.[id] !== now?.[id]).sort();

// How a base record's run plan differs from a confirmation's: [{ key, text }]
// for the number of attempts where a package declares a live dependency, the
// model, and the agent when the confirmation names one. A baseline that ran is
// compared by what it ran with; one that records that nothing could run, by
// its plan, which every head run of a loop on it takes.
function planDiffs(evals, base, confirmation, undecided = false) {
  const plan = confirmation.run_plan ?? {};
  const kept = planOf(base);
  const ran = base.is_baseline ? base.environment_ref ?? {} : { agent: kept.agent ?? null, model: kept.model ?? null };
  const attempts = kept.attempts ?? null;
  // The number of attempts matters only where a package declares a live dependency.
  const live = evals.cases.some((item) => item.live);
  return [
    // A baseline that fixed no number is reported as attempts_undecided instead.
    ...(live && !(undecided && attempts === null) && attempts !== (plan.attempts ?? null) ? [{ key: 'attempts', text: `${attempts ?? 'no fixed number of'} attempts` }] : []),
    ...((plan.agent ?? null) !== null && (ran.agent ?? null) !== plan.agent ? [{ key: 'agent', text: `agent ${ran.agent ?? 'none'}` }] : []),
    ...((ran.model ?? null) !== (plan.model ?? null) ? [{ key: 'model', text: `model ${ran.model ?? 'none'}` }] : []),
  ];
}

// The gap baseline_plan_differs when a base record has another run plan than
// a confirmation, or null. workflow check run-eval asks for the same baseline
// again.
export function baselinePlanDiffers(evals, base, confirmation, { undecided = false } = {}) {
  if (!base || !confirmation) return null;
  const diffs = planDiffs(evals, base, confirmation, undecided).map((entry) => entry.text);
  const declared = base.is_baseline ? '' : ` --unavailable ${base.baseline_unavailable_reason ?? 'no_implementation'}`;
  return diffs.length ? gap('baseline_plan_differs', 'run-eval', `The baseline ${base.run_id} ${base.is_baseline ? 'ran' : 'records that nothing could run, and a loop on it runs'} with ${diffs.join(', ')} but the user confirmed ${confirmedPlan(confirmation.run_plan ?? {})} (${confirmation.confirmed?.at ?? 'no date'}). Record the baseline again on the code before the change, without --attempts, --agent and --model: \`run start --baseline${declared}\` reads the confirmed plan from confirmed.json, or the user confirms another plan.`) : null;
}

// What the user's checks confirmation says about a loop that would start on
// base: { gaps, warnings, confirmation }. A loop starts only on the packages
// the user confirmed for this Spec export, and on a baseline that ran the plan
// they confirmed. confirmation is the confirmation that covers the packages as
// they are, or null. A baseline recorded as unavailable ran no plan, but every
// head run of a loop on it takes the plan it keeps.
function confirmationGaps(repo, name, evals, base, undecided) {
  const state = checksConfirmation(repo, name, evals.spec);
  if (state.gap) return { gaps: [state.gap], warnings: [], confirmation: null };
  const gaps = state.unconfirmed ? [state.unconfirmed] : [];
  const warnings = [];
  const confirmation = state.current;
  const differs = confirmation ? baselinePlanDiffers(evals, base, confirmation, { undecided }) : null;
  if (differs) gaps.push(differs);
  if (confirmation && base?.is_baseline) {
    // The expected baseline results the user saw with the checks, against
    // those the baseline ran with. A check left out of either expects any.
    const key = (entry) => `${entry.case}\n${entry.check}`;
    const confirmed = new Map((confirmation.baseline_expectations ?? []).map((entry) => [key(entry), entry.expected]));
    const differ = confirmed.size ? (base.baseline_expectations ?? []).filter((entry) => (confirmed.get(key(entry)) ?? 'any') !== (entry.expected ?? 'any')) : [];
    if (differ.length) {
      warnings.push(`The baseline ${base.run_id} ran with other expected results than the user confirmed: ${differ.map((entry) => `${entry.case}/${entry.check} ${entry.expected ?? 'any'} there, ${confirmed.get(key(entry)) ?? 'any'} confirmed`).join(', ')}. Tell the user, or record the baseline again with the baseline-expectations.json they confirmed.`);
    }
  }
  return { gaps, warnings, confirmation };
}

// Until a loop of this change is accepted, every new loop keeps the start code
// of the change's first unaccepted loop, pin (pinnedStart), and starts only on
// a base record of that code: that loop's own baseline, or a newer one that
// ran there, one that records that nothing could run included. The gap that
// says it ran elsewhere, or null.
function offStart(repo, name, base, pin) {
  if (base.run_id === pin.loop.baseline || sameCode(base.code_snapshot, pin.start, repo) === true) return null;
  const before = readRuns(path.join(eddDirectory(repo, name), 'runs')).find((run) => run.run_id === pin.loop.baseline) ?? null;
  return gap('baseline_not_at_start', 'run-eval', `Until a loop of this change is accepted, every new loop keeps the start code of the change's first unaccepted loop, ${restoreHint(name, { start_code: pin.start }, before)}. The baseline ${base.run_id} ran on other code. Set your changes aside, restore that code, record the baseline there, bring your changes back, then run \`loop start\` again.`);
}

// The gating checks of a comparison, as `<case>\n<check>`.
const gatingKeys = (compare) => new Set(compare.filter((entry) => entry.role === 'gating').map((entry) => `${entry.case}\n${entry.check}`));

// What the loop needs before it may change code. Read-only. While a loop runs
// for the Spec, its baseline is the one it pinned; latest asks for the
// baseline a new loop would pin instead, as loop start does. pin is the start
// code a new loop keeps (pinnedStart), or null.
export function loopInputs(repo, name, { latest = false } = {}) {
  const evals = validateEval(repo, name);
  // Packages still waiting for a connection are expected in a project with no
  // implementation yet: building that connection is part of the loop.
  const gaps = evals.gaps.filter((entry) => entry.code !== 'integration_pending');
  let loop = !latest && evals.spec ? activeLoop(repo, name, evals.spec) : null;
  // A loop whose baseline is gone has ended (baseline_missing). Once a
  // baseline of this Spec export is recorded again on its start code, what
  // is asked is what a new loop needs, as \`loop start\` asks it.
  if (loop && pinnedBase(repo, name, loop).gap) {
    const again = recordedBaseline(repo, name, evals.spec);
    const start = loopStartCode(repo, name, loop);
    if (again && start?.digest && sameCode(again.code_snapshot, start, repo) === true) loop = null;
  }
  const code = codeState(repo);
  const warnings = [];
  let confirmation = null;
  let pin = null;
  let base = null;
  if (loop) {
    const pinned = pinnedBase(repo, name, loop);
    base = pinned.run;
    if (pinned.gap) gaps.push(pinned.gap);
  } else if (evals.spec) {
    pin = pinnedStart(repo, name);
    let undecidedIds = [];
    base = recordedBaseline(repo, name, evals.spec);
    if (!base) gaps.push(gap('baseline_missing', 'run-eval', 'Record the baseline first: `run start --baseline --expect FILE`, or `--baseline --unavailable no_implementation` when nothing can run yet.'));
    // A baseline that contradicts what was declared before it ran is no
    // reference for a loop: every comparison would rest on it.
    else if (base.baseline_mismatch?.length) gaps.push(gap('baseline_mismatch', 'run-eval', mismatchMessage(base)));
    else {
      const differ = baselinePackagesDiffer(base, evals.cases);
      if (differ) gaps.push(differ);
      // A package that declares a live dependency after a baseline that fixed
      // no number of attempts cannot run in a loop on it: the number is the user's.
      undecidedIds = undecidedLive(base, evals.cases.filter((item) => item.integration?.state === 'ready'));
      if (undecidedIds.length) gaps.push(startUndecided(base, undecidedIds, checksConfirmation(repo, name, evals.spec).current));
      // A new loop starts on the code its baseline was recorded on, or, until
      // a loop of this change is accepted, on the start code of the first
      // unaccepted one, whatever the code is now.
      if (code.changed !== null) {
        const moved = pin ? offStart(repo, name, base, pin) : notAtBaseline(repo, name, base, codeSnapshot(repo).snapshot);
        if (moved) gaps.push(moved);
      }
    }
    // A loop starts only on the user's confirmation of the packages as they are.
    const confirmed = confirmationGaps(repo, name, evals, base, undecidedIds.length > 0);
    gaps.push(...confirmed.gaps);
    warnings.push(...confirmed.warnings);
    confirmation = confirmed.confirmation;
  }
  // A loop starts only on packages that name the line each check verifies.
  const legacy = legacyPackages(evals);
  if (!loop && legacy.length) {
    const one = legacy.length === 1;
    gaps.push({ ...gap('then_unbound', 'write-eval', `${legacy.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0, whose checks do not name the THEN lines they verify, so a loop does not start on ${one ? 'it' : 'them'}. Upgrade ${one ? 'it' : 'each'} to 1.1 with write-eval: set schema_version to "1.1", give every gating check the line it verifies as then, and list a line no program can judge in scenario.manual. Then run \`eval check\`. A baseline that ran on the old packages compares nothing with the new ones, so record it again before \`loop start\`.`), cases: legacy });
  }
  // Nor on a change no run can pass.
  if (!loop && allManual(evals)) gaps.push(gap('gating_missing', 'write-eval', `${NO_GATING} A loop does not start on it. Tell the user. ${NO_GATING_REPAIR}`, 'user', 'business'));
  if (code.changed === null) {
    gaps.push(gap('git_missing', 'loop-and-implement', 'Every run records its code as a commit plus a patch, which needs Git. Initialize Git in the project, or ask the user to.', 'user', 'technical'));
  }
  return { evals, base, code, gaps, warnings, confirmation, pin, loop };
}

const readLoop = (repo, name) => (existsSync(loopFile(repo, name)) ? readJSON(loopFile(repo, name)) : null);

// Minutes kept to a tenth and money to a millionth, as run records keep them.
const tenths = (value) => Math.round(value * 10) / 10;
const money = (value) => Number(value.toFixed(6));
const sumKnown = (values, round) => {
  const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return known.length ? round(known.reduce((total, value) => total + value, 0)) : null;
};

// What the earlier loops of this change used: current, the loop in loop.json,
// and the loops it keeps under previous, each with the full head runs of its
// Spec export from its start until the next loop started, and whether the
// user accepted it. minutes are those its budget counted: from its budget
// clock until the next loop started, or until the user's acceptance of it;
// run_minutes what its head runs took, and cost_usd what they cost.
// Read-only.
function earlierLoops(repo, name, current) {
  const chain = current ? [...(current.previous ?? []), without(current, 'previous')] : [];
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const all = chain.length ? readRuns(runsDirectory) : [];
  let record = null;
  try { record = chain.length && existsSync(acceptedFile(repo, name)) ? readJSON(acceptedFile(repo, name)) : null; } catch { /* loop status says why */ }
  const records = record ? [...(Array.isArray(record.earlier) ? record.earlier : []), without(record, 'earlier')] : [];
  const now = new Date().toISOString();
  const loops = chain.map((entry, index) => {
    const until = chain[index + 1]?.started_at ?? null;
    const heads = loopRuns(all, entry).filter((run) => until === null || run.started_at < until);
    const full = fullRuns(heads);
    const usage = usageOfRuns(runsDirectory, heads);
    const acceptance = records.find((item) => acceptedIn(item, entry, full)) ?? null;
    const stops = [until ?? now, acceptance?.accepted?.at].map((at) => Date.parse(at)).filter(Number.isFinite);
    const clock = Date.parse(entry.clock_started_at ?? entry.started_at);
    const minutes = Number.isFinite(clock) && stops.length ? Math.max(0, Math.round((Math.min(...stops) - clock) / 60_000)) : null;
    return { started_at: entry.started_at, spec: entry.spec, accepted: Boolean(acceptance), iterations: full.length,
      minutes, run_minutes: usage.minutes, cost_usd: usage.cost_usd, budget: entry.budget ?? null };
  });
  return { loops, total: { loops: loops.length, iterations: loops.reduce((total, entry) => total + entry.iterations, 0),
    minutes: sumKnown(loops.map((entry) => entry.minutes), tenths), run_minutes: sumKnown(loops.map((entry) => entry.run_minutes), tenths),
    cost_usd: sumKnown(loops.map((entry) => entry.cost_usd), money) } };
}

// Fixes the reference points of one loop: the Spec, the baseline and the code
// it ran on, the packages and the run plan the user confirmed, and the budget
// the user agreed to. A loop after one that ended or stopped needs the user's
// go-ahead, which the skills ask for: the CLI cannot tell that a person agreed.
// Nothing has to be committed: every run keeps its code as commit plus patch.
export function startLoop(repo, name, options = {}) {
  // Flags that are not a budget are refused before anything is read.
  budgetOptions(options);
  const { evals, base, code, gaps, warnings: inputWarnings, confirmation, pin } = loopInputs(repo, name, { latest: true });
  // The budget is the one the user confirmed with the checks, unless the
  // flags give another.
  const flagged = options.iterations !== undefined || options.minutes !== undefined;
  const confirmedBudget = confirmation?.run_plan?.budget ?? null;
  const { iterations, minutes } = budgetOptions(options, confirmedBudget ?? undefined);
  // Earlier attempts estimate each run: those of the baseline, else those of
  // the last eval check, else the baseline's whole run, which ran the plan.
  // In a loop that needs a final run, every run but the last is taken as a
  // screen run, with one attempt of each package, and the last as the final
  // run. A confirmed budget that the estimate shows cannot hold the runs goes
  // back to the user. A loop on a baseline that recorded that nothing could
  // run needs a final run as loop status says, by the plan it keeps.
  const finals = finalsNeeded(planOf(base), evals.cases);
  const estimate = base ? estimateRuns(repo, name, { base, plan: planOf(base), cases: evals.cases }) : null;
  const need = !estimate?.basis ? null : finals ? (iterations - 1) * estimate.screen.minutes + estimate.final.minutes : iterations * estimate.full.minutes;
  if (!flagged && need !== null && need > minutes) {
    const screens = iterations - 1;
    gaps.push(gap('budget_unfit', 'loop-and-implement', `The confirmed budget is ${iterations} full runs and ${minutes} minutes, but ${finals
      ? `${screens ? `${screens} screen run${screens === 1 ? '' : 's'} of about ${shownMinutes(estimate.screen.minutes)} minutes each and ` : ''}a final run of about ${shownMinutes(estimate.final.minutes)} minutes need${screens ? '' : 's'}`
      : `${iterations} run${iterations === 1 ? '' : 's'} of about ${shownMinutes(estimate.full.minutes)} minutes ${iterations === 1 ? 'needs' : 'each need'}`} about ${Math.ceil(need)} minutes (${basisText(estimate, base)}). Ask the user for a budget that fits, or fewer runs, and pass it: \`loop start --max-iterations N --max-minutes M\`.`, 'user', 'business'));
  }
  // One loop at a time for a Spec export: a new one starts once it ended or
  // stopped, or once no head run is left in it (its budget is used up and only
  // its report, final review or acceptance is left), and none after the user
  // accepted it. Without a readable loop.json, the loop its head runs name
  // (recordedLoop) stands in for it, as one that ended.
  let current = null;
  try { current = readLoop(repo, name); } catch { /* read from runs/ below */ }
  current ??= recordedLoop(repo, name);
  if (current && !current.recovered_from && evals.spec && current.spec === evals.spec) {
    const status = loopStatus(repo, name);
    const phase = loopPhase(status);
    if (phase === 'done') {
      gaps.push(gap('loop_accepted', 'loop-and-implement', `The user accepted run ${status.accepted?.run_id ?? 'unknown'} of the loop for this Spec export. A new loop for this change follows a new Spec export.`));
    } else if (phase === 'live') {
      gaps.push(gap('loop_running', 'loop-and-implement', `A loop for this Spec started at ${current.started_at} and has not ended: continue it with \`loop status\`. A new loop starts only after it ended or stopped, and only with the user's go-ahead.`));
    }
  }
  if (gaps.length) throw blocked(`The loop cannot start: ${gaps.map((entry) => entry.message).join(' ')}`, repo, name, gaps);
  ignoreRecords(repo);
  const warnings = [...inputWarnings];
  if (flagged && confirmedBudget && (iterations > confirmedBudget.iterations || minutes > confirmedBudget.minutes)) {
    warnings.push(`This budget, ${iterations} full runs and ${minutes} minutes, is more than the user confirmed with the checks: ${confirmedBudget.iterations} full runs and ${confirmedBudget.minutes} minutes in confirmed.json. Go on only if the user agreed to it, and say so in the next report.`);
  }
  // The first full run is always a screen run, so one run never reaches a final run.
  if (finals && iterations < 2) {
    warnings.push(`A budget of ${iterations} full run leaves no room for a final run: in this loop the first full run is a screen run, and only a passing final run after it can be accepted, so it needs at least 2 full runs. Tell the user before the first run.`);
  }
  if (base.baseline_unstable?.length) {
    warnings.push(`The baseline ${base.run_id} has checks whose attempts disagreed (baseline_unstable): ${base.baseline_unstable.map((entry) => `${entry.case}/${entry.check}`).join(', ')}. Their comparison with the baseline shows nothing about the change; tell the user.`);
  }
  const plan = planOf(base);
  if (plan.uniform && base.is_baseline) {
    warnings.push(`The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs ${plan.attempts === 1 ? 'once' : `${plan.attempts} times`}, as it did there. A new baseline asks for the number of attempts of each package that declares a live dependency.`);
  }
  // What the earlier loops of this change used; this loop's budget is its own.
  const earlier = earlierLoops(repo, name, current);
  if (earlier.loops.length) {
    const { total } = earlier;
    warnings.push(`Earlier loops of this change (${total.loops}) used ${total.iterations} full run${total.iterations === 1 ? '' : 's'}, ${total.minutes === null ? 'an unknown number of' : shownMinutes(total.minutes)} minutes of their budget${total.loops === 1 ? '' : 's'}, counted as a budget counts them, from each loop's start until the next one started or the user accepted it${total.run_minutes === null ? '' : ` (their runs took ${shownMinutes(total.run_minutes)} minutes)`}${total.cost_usd === null ? '' : `, and ${shownCost(total.cost_usd)} in model calls as the adapter reported them`}. This loop's budget is the one loop start was given (${iterations} runs, ${minutes} minutes); tell the user what the earlier loops used.`);
  }
  if (current?.recovered_from) {
    warnings.push(`loop.json is missing or cannot be read. The loop that started at ${current.started_at} is known from its head runs only (${current.recovered_from.join(', ')}): this loop keeps its start code, but its budget and the loops before it are lost. Tell the user.`);
  }
  let start = pin?.start ?? null;
  if (!start) {
    // The starting code is kept as its commit plus a patch of what the commit
    // does not hold, so it can be restored to record a baseline on it.
    const snapshot = codeSnapshot(repo).snapshot;
    const file = path.join(eddDirectory(repo, name), 'loop-start.patch');
    rmSync(file, { force: true });
    const { patch, error } = savePatch(repo, snapshot, file);
    if (error) {
      warnings.push(`loop-start.patch could not be written (${error}), so the loop's starting code cannot be restored: ${code.head ? `commit ${short(code.head)}` : 'no commit'} does not hold its uncommitted files. Keep a copy of them before changing them.`);
    }
    start = startCode(code.head, snapshot, repo, patch);
  }
  // A loop after an accepted one records the loop it follows: its start code
  // is the code as it is, not the start code of the accepted loop.
  let follows = null;
  if (current && loopAccepted(repo, name, current)) {
    let record = null;
    try { record = readJSON(acceptedFile(repo, name)); } catch { /* loopAccepted read it */ }
    follows = { loop_started_at: current.started_at, run_id: record?.run_id ?? null, spec: current.spec };
  }
  const now = new Date().toISOString();
  const loop = {
    schema_version: '1.0', change: name, started_at: now,
    spec: evals.spec, baseline: base.run_id, baseline_available: base.is_baseline === true,
    base_commit: start.commit,
    // The code before the change. Until a loop of this change is accepted,
    // every base record and every new loop keeps this code.
    start_code: start,
    budget: { iterations, minutes },
    // The confirmation of the checks this loop compares with, and where its
    // budget came from.
    checks_confirmation: confirmation ? { id: confirmation.id, at: confirmation.confirmed?.at ?? null } : null,
    budget_source: flagged ? 'loop_start' : 'confirmation',
    ...(flagged && confirmedBudget ? { confirmed_budget: confirmedBudget } : {}),
    // The minutes of the budget count from here.
    clock_started_at: now,
    // The packages this loop runs; a change to one ends it.
    task_digest: Object.fromEntries(evals.cases.map((item) => [item.id, item.task_digest])),
    ...(follows ? { follows } : {}),
    ...(current ? { previous: [...(current.previous ?? []), without(current, 'previous')] } : {}),
  };
  saveLoop(repo, name, loop);
  return { loop, run_plan: plan, earlier_loops: earlier, warnings, next: { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo] } };
}

const compareOf = (runs, run) => {
  try { return readJSON(path.join(runs, run.run_id, 'compare.json')).results; } catch { return []; }
};

// The lines no check verified in a run, which the user judges: [{ case, then,
// reason }]. A comparison written before they were recorded lists none.
const manualOf = (runs, run) => {
  try { return readJSON(path.join(runs, run.run_id, 'compare.json')).manual ?? []; } catch { return []; }
};

// The lines the user judges, for a message: "line" (case), ….
const manualText = (manual) => manual.map((entry) => `"${entry.then}" (${entry.case})`).join(', ');

// A report is written once per full run. It is complete when the template mark
// is gone and every section has content; a passing run also needs its review,
// which is written at the final review and says more than a word.
export function reportGaps(repo, name, run) {
  const file = reportFile(repo, name, run.run_id);
  if (!existsSync(file)) return [`no report at reports/${run.run_id}.md`];
  const text = readFileSync(file, 'utf8');
  const missing = [];
  if (text.includes(TEMPLATE_MARK)) missing.push('the template line is still there');
  for (const section of [...SECTIONS, ...(run.verdict === 'pass' ? ['Review'] : [])]) {
    const match = text.match(new RegExp(`^## ${section}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    const content = match ? match[1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';
    if (!content) missing.push(`section ${section} is empty`);
    else if (section === 'Cause' && /^- `[^`]+` `[^`]+` \([a-z_]+\):\s*$/m.test(match[1])) missing.push('a check in Cause has no cause yet');
    else if (section === 'Review' && content.replace(/\s+/g, ' ').length < REVIEW_MINIMUM) {
      missing.push(`section Review is too short: it needs at least ${REVIEW_MINIMUM} characters on who reviewed the whole change, what they checked and found, and how each finding was handled`);
    }
  }
  return missing;
}

// Whether the accepted change is in Git: the application code, and this
// change's own files, such as its Spec folder, eval packages, reports and
// acceptance record. Returns the step after acceptance as { commit, uncommitted,
// message }; commit only when everything is committed.
function commitStep(repo, name, snapshot, codeMatches) {
  const code = codeMatches && Array.isArray(snapshot?.changed_files) && !snapshot.changed_files.length ? snapshot.commit : null;
  const uncommitted = uncommittedArtifacts(repo, name) ?? [];
  if (code && !uncommitted.length) {
    return { commit: code, message: `The accepted change is committed in ${short(code)}. Offer to merge it or open a pull request; do neither without the user.` };
  }
  if (code) {
    return { uncommitted, message: `The accepted code is committed in ${short(code)}, but the commit is incomplete: ${named(uncommitted)} ${uncommitted.length === 1 ? 'is' : 'are'} not committed. Offer to commit ${uncommitted.length === 1 ? 'it' : 'them'}, then to merge or open a pull request; do none of them without the user.` };
  }
  return { ...(uncommitted.length ? { uncommitted } : {}),
    message: `Offer to commit the change${uncommitted.length ? `, with ${named(uncommitted)}` : ''}, merge it or open a pull request; do none of them without the user.` };
}

// Where the loop stands, worked out from the run records. Read-only. ended
// says which fixed input of the loop changed, if one did: it is worked out on
// every call, so putting that input back as it was makes it null again. stop
// is the stop that holds, from the loop's own runs, which no code change lifts.
export function loopStatus(repo, name) {
  const loop = readLoop(repo, name);
  if (!loop) {
    throw blocked('No loop has started for this change.', repo, name, [gap('loop_missing', 'loop-and-implement', 'Start one with `loop start` once the user has agreed to the budget.')]);
  }
  const evals = validateEval(repo, name);
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const all = readRuns(runsDirectory);
  const base = all.find((run) => run.run_id === loop.baseline) ?? null;
  const ours = loopRuns(all, loop);
  const runs = fullRuns(ours);
  const latest = runs.at(-1) ?? null;
  const warnings = [...evals.warnings];
  if (!base) warnings.push(`The loop's baseline ${loop.baseline} is no longer in runs/, so the loop has ended (baseline_missing).`);
  const unfinished = unfinishedRuns(runsDirectory);
  if (unfinished.length) warnings.push(unfinishedWarning(unfinished));
  if (latest?.code_changed_during_run) warnings.push(`The code changed while ${latest.run_id} executed, so its results do not belong to one version of the code. Leave the code as it is during a run, and run again.`);
  const changedDuring = (run) => (run.eval_snapshot?.changed_during_run ?? []).join(', ') || 'the packages it ran';
  if (latest?.packages_changed_during_run) warnings.push(`The eval packages changed while ${latest.run_id} executed (${changedDuring(latest)}), so its results do not belong to one version of them. Leave the packages and the project kit as they are during a run, and run again.`);

  // Each check through the loop: the baseline, then every full run.
  const results = runs.map((run) => new Map(compareOf(runsDirectory, run).map((entry) => [`${entry.case}\n${entry.check}`, entry])));
  const keys = evals.cases.flatMap((item) => {
    let declared = [];
    try { declared = readJSON(path.join(eddDirectory(repo, name), 'evals', item.id, 'tests/checks.json')).checks ?? []; } catch { /* reported by validation */ }
    return declared.map((check) => ({ case: item.id, check: check.id, intent: check.intent,
      ...(typeof check.then === 'string' ? { then: check.then } : {}), role: check.role }));
  });
  const baseResults = new Map();
  if (base?.is_baseline) {
    for (const item of base.cases ?? []) {
      try {
        for (const entry of readJSON(path.join(runsDirectory, base.run_id, item.id, 'check-results.json')).results ?? []) baseResults.set(`${item.id}\n${entry.id}`, entry.result);
      } catch { /* no evidence */ }
    }
  }
  // A baseline result says something about a run only for a package that ran
  // in the baseline exactly as it ran then. A fixed verifier or kit makes it a
  // different package.
  const current = new Map(evals.cases.map((item) => [item.id, item.task_digest]));
  const ranAtBase = (id) => base?.is_baseline === true && (base.cases ?? []).some((item) => item.id === id);
  const comparable = (id, digestOf) => ranAtBase(id) && base.task_digest?.[id] !== undefined && base.task_digest[id] === digestOf;
  const checks = keys.map((key) => {
    const id = `${key.case}\n${key.check}`;
    return { ...key, baseline: baseResults.get(id) ?? null, baseline_comparable: comparable(key.case, current.get(key.case)),
      runs: results.map((map) => map.get(id)?.after ?? null),
      verdict: results.at(-1)?.get(id)?.verdict ?? null, evidence: results.at(-1)?.get(id)?.evidence ?? null };
  });
  // The gating checks a full run did not pass, of the packages in ids when given.
  const failing = (index, ids = null) => checks.filter((entry) => entry.role === 'gating' && (!ids || ids.has(entry.case)) && entry.runs[index] !== 'pass')
    .map((entry) => `${entry.case}/${entry.check}=${entry.runs[index] ?? 'missing'}`).sort();
  const now = codeSnapshot(repo).snapshot;
  // A run during which the code or a package changed has results of no one
  // version of them.
  const settled = (run) => !run.code_changed_during_run && !run.packages_changed_during_run;
  const identities = new Map();
  const identityOf = (run) => {
    if (!identities.has(run.run_id)) identities.set(run.run_id, codeIdentity(run.code_snapshot, repo));
    return identities.get(run.run_id);
  };

  // Runs add up. Every result of this Spec export on the same code, package,
  // agent and model counts, from every loop and from base runs too, and a
  // failure among them is never cancelled by a pass. A gating check that
  // passed and failed on the code of one of this loop's runs, with the loop's
  // packages, in a run of this loop among others, stops the loop for good.
  const pool = sameCodeResults(repo, runsDirectory, loop.spec, all);
  const nowCode = codeIdentity(now, repo);
  const role = (wanted) => new Set(keys.filter((key) => key.role === wanted).map((key) => `${key.case}\n${key.check}`));
  const gating = role('gating');
  const digestsNow = Object.fromEntries(current);
  const varied = (checksOf) => (nowCode ? unstableChecks(pool, { code: nowCode, digests: digestsNow, checks: checksOf }) : []);
  const unstableAll = varied(gating);
  const ourIds = new Set(ours.map((run) => run.run_id));
  const loopCodes = [...new Set(ours.filter((run) => settled(run) && ['completed', 'error'].includes(run.execution_status)).map(identityOf).filter(Boolean))];
  const unstable = loopCodes.flatMap((code) => unstableChecks(pool, { code, digests: loop.task_digest ?? digestsNow, checks: gating })
    .filter((group) => [...group.pass, ...group.fail].some((id) => ourIds.has(id))));
  const listed = (groups) => groups.map((group) => `${group.case}/${group.check}`).join(', ');
  const order = new Map(all.map((run, index) => [run.run_id, index]));
  const ranIn = (groups) => [...new Set(groups.flatMap((group) => [...group.pass, ...group.fail]))].sort((a, b) => order.get(a) - order.get(b)).join(', ');
  const baseOnly = unstableAll.filter((group) => !group.head);
  if (baseOnly.length) warnings.push(`On the code before the change, ${listed(baseOnly)} passed and failed (${ranIn(baseOnly)}). Its result can vary; say so in the report.`);
  const diagnostic = varied(role('diagnostic'));
  if (diagnostic.length) warnings.push(`Diagnostic ${listed(diagnostic)} passed and failed on the code as it is now (${ranIn(diagnostic)}). It does not decide the verdict; say so in the report.`);
  // A changed package is another key: its earlier failures do not count
  // against it, but the user hears of them.
  const oldFailures = new Map();
  for (const entry of pool) {
    const id = `${entry.case}\n${entry.check}`;
    if (entry.result !== 'fail' || !nowCode || entry.code !== nowCode || !gating.has(id) || entry.task_digest === null || entry.task_digest === digestsNow[entry.case]) continue;
    oldFailures.set(id, [...new Set([...(oldFailures.get(id) ?? []), entry.run_id])]);
  }
  for (const [id, ran] of oldFailures) {
    warnings.push(`On the code as it is now, ${id.replace('\n', '/')} failed with an earlier version of its package (${ran.join(', ')}), and the package changed since. A changed package starts a new count: say in the report why it changed, and tell the user before they accept.`);
  }

  let accepted = null;
  try { accepted = existsSync(acceptedFile(repo, name)) ? readJSON(acceptedFile(repo, name)) : null; } catch {
    warnings.push('accepted.json cannot be read. Restore it; it records the user\'s acceptance.');
  }
  if (!acceptedIn(accepted, loop, runs)) accepted = null;
  // The loop is done only while the acceptance covers it: the code is still
  // the accepted run's, no full run after the acceptance fails, even when a
  // later one passes again, and no run of the accepted code and packages
  // fails after the accepted run started, full or partial.
  const cover = acceptanceHolds(accepted, loop, runs, now, repo, pool, (run) => gatingKeys(compareOf(runsDirectory, run)));
  const acceptedRun = cover?.run ?? null;
  const failedAfter = cover?.failed ?? null;
  const keeps = cover?.keeps ?? null;
  const holds = cover?.holds === true;
  // Failures of the accepted code in runs that started before the accepted
  // run are counted now, but an acceptance the user gave is not withdrawn for
  // them: one an earlier release recorded, or one of a run still running when
  // the user accepted.
  if (holds && cover.earlier.length) {
    const failed = [...new Set(cover.earlier.map((entry) => `${entry.case}/${entry.check}`))].join(', ');
    warnings.push(`${failed} failed on the code of the accepted run ${accepted.run_id} in ${[...new Set(cover.earlier.map((entry) => entry.run_id))].join(', ')}, which started before it. A failure of the same code now always counts, so this acceptance would be refused today. It stays recorded; tell the user.`);
  }

  // The fixed inputs of the loop: its Spec export, its baseline, the run plan
  // and the packages of the user's checks confirmation it started on, and the
  // project kit. A change to one ends the loop; the CLI does not script the
  // recovery, it says what changed. A re-export ends it, done or not; the
  // others only while the user's acceptance does not cover it.
  const snapshot = evalSnapshot(repo, name);
  const confirmed = checksConfirmation(repo, name, loop.spec, snapshot);
  if (confirmed.gap) warnings.push(confirmed.gap.message);
  const loopEntry = !confirmed.gap && loop.checks_confirmation ? confirmationById(confirmed.entries, loop.checks_confirmation.id) : null;
  const newer = confirmed.latest && confirmed.latest.id !== loop.checks_confirmation?.id ? confirmed.latest : null;
  const digestsOf = (entry) => Object.fromEntries(Object.entries(entry?.packages ?? {}).map(([id, item]) => [id, item?.task_digest]));
  const plan = base ? planOf(base) : null;
  // The packages that differ from the loop's confirmation, by file; for a loop
  // that kept none, from the packages it started on.
  const loopMatch = loopEntry ? confirmationMatch(loopEntry, snapshot, loop.spec) : null;
  const changedIds = loopMatch ? loopMatch.packages.map((entry) => entry.id) : changedBetween(loop.task_digest, snapshot.task_digest);
  let ended = null;
  if (evals.spec && evals.spec !== loop.spec) {
    const done = loopAccepted(repo, name, loop);
    ended = { reason: 'spec_exported', spec: evals.spec, loop_spec: loop.spec, accepted: done, start_code: done ? null : loopStartCode(repo, name, loop) };
  } else if (evals.spec && !holds) {
    const planKeys = newer && base ? planDiffs(evals, base, newer).map((entry) => entry.key) : [];
    const newerPackages = newer ? changedBetween(digestsOf(newer), loop.task_digest) : [];
    if (!base) ended = { reason: 'baseline_missing', baseline: loop.baseline, start_code: loop.start_code ?? null };
    else if (newer && (planKeys.length || newerPackages.length)) {
      ended = { reason: 'confirmation_changed', confirmation: newer.id, at: newer.confirmed?.at ?? null, loop_confirmation: loop.checks_confirmation?.id ?? null,
        plan: planKeys, packages: newerPackages };
    } else if (loopMatch ? !loopMatch.matches : changedIds.length) {
      ended = { reason: 'packages_changed', packages: changedIds, files: loopMatch ? matchFiles(loopMatch) : [] };
    }
  }

  // A regression breaks what worked before the change: a gating check that
  // passed in the baseline, or, when there is no baseline result, in the
  // latest earlier full run with a pass or fail result for it, fails now. A
  // check that only passed during the loop and fails again is lost progress:
  // worth a look, not a reason to unwind. After an acceptance, a gating check
  // the accepted run passed and a later run of other code fails is a
  // regression too. Each compares only results of the same package. A run
  // during which the code or a package changed is compared neither as the
  // latest run nor as an earlier one, here and for stuck. Nor is one that did
  // not complete: a fail graded after the agent or the harness errored is no
  // result of the code. Two runs of the same code are never a regression or
  // lost progress: a check that passed and failed there varies, which
  // stop_unstable reports.
  const compared = (run) => settled(run) && run.execution_status === 'completed';
  const brief = ({ case: id, check, intent }) => ({ case: id, check, intent });
  const fails = (entry) => entry.role === 'gating' && entry.runs.at(-1) === 'fail';
  const passedWhenAccepted = (entry) => (accepted?.checks ?? []).some((item) => item.case === entry.case && item.check === entry.check && item.after === 'pass')
    && (!acceptedRun || acceptedRun.task_digest?.[entry.case] === latest.task_digest?.[entry.case]);
  const sameAsLatest = (run) => Boolean(run && latest && identityOf(run) && identityOf(run) === identityOf(latest));
  const change = (entry) => {
    if (!latest || !compared(latest) || !fails(entry)) return null;
    if (failedAfter && passedWhenAccepted(entry) && !sameAsLatest(acceptedRun)) return 'regression';
    const baseline = comparable(entry.case, latest.task_digest?.[entry.case]) && ['pass', 'fail'].includes(entry.baseline)
      && !sameAsLatest(base) ? entry.baseline : null;
    // An interrupted run, or one whose evidence could not tell, in between
    // does not hide what the check did before it.
    const index = entry.runs.slice(0, -1).findLastIndex((result, at) => compared(runs[at]) && (result === 'pass' || result === 'fail'));
    const before = index >= 0 && runs[index].task_digest?.[entry.case] === latest.task_digest?.[entry.case] && !sameAsLatest(runs[index])
      ? entry.runs[index] : null;
    if (baseline === 'pass' || (baseline === null && before === 'pass')) return 'regression';
    return baseline === 'fail' && before === 'pass' ? 'lost' : null;
  };
  const regressions = checks.filter((entry) => change(entry) === 'regression').map(brief);
  const lost = checks.filter((entry) => change(entry) === 'lost').map(brief);
  if (lost.length) warnings.push(`Passed in an earlier run and fails again: ${lost.map((entry) => `${entry.case}/${entry.check}`).join(', ')}. Compare the code of the two runs.`);
  const prior = runs.slice(0, -1).findLastIndex(compared);
  const previous = latest && compared(latest) && prior >= 0 ? runs[prior] : null;
  const repeated = previous ? sameCode(latest.code_snapshot, previous.code_snapshot, repo) : null;
  // Stuck compares the two runs, screen or final, over the packages both ran:
  // a final run that stopped at a failing package skipped the rest.
  const packagesOf = (run) => new Set((run.cases ?? []).map((item) => item.id));
  const both = previous ? new Set([...packagesOf(latest)].filter((id) => packagesOf(previous).has(id))) : null;
  const stuck = Boolean(previous && repeated !== true && latest.verdict !== 'pass'
    && failing(runs.length - 1, both).length && failing(runs.length - 1, both).join() === failing(prior, both).join());
  // Runs during which the code or a package changed, and runs that did not
  // complete, are skipped, so when one lies between the two runs compared,
  // both are named.
  const skipped = previous ? runs.length - 2 - prior : 0;
  const between = (() => {
    const inBetween = runs.slice(prior + 1, -1);
    const one = skipped === 1;
    const changedCode = inBetween.some((run) => run.code_changed_during_run);
    const changedPackages = inBetween.some((run) => run.packages_changed_during_run);
    const what = changedPackages ? changedCode ? 'the code or the eval packages' : 'the eval packages' : 'the code';
    const reasons = [...(changedCode || changedPackages ? [`${what} changed while ${one ? 'it' : 'they'} ran`] : []),
      ...(inBetween.some((run) => settled(run) && run.execution_status !== 'completed') ? [`${one ? 'it' : changedCode || changedPackages ? 'some' : 'they'} did not complete`] : [])];
    return ` (${one ? 'the run between them is' : `the ${skipped} runs between them are`} not compared: ${reasons.join(', or ')})`;
  })();
  const pair = skipped ? `${latest.run_id} and ${previous.run_id}${between}` : 'the last two runs';
  const adds = 'A run of the same code only adds to its count: it never cancels a failure, and it tries nothing new.';
  // A final run repeats the code of its screen run by design.
  if (repeated && latest.role !== 'final' && !changedBetween(latest.task_digest, previous.task_digest).length) warnings.push(skipped ? `${latest.run_id} used the same code as ${previous.run_id}${between}. ${adds}` : `The last two runs used the same code. ${adds}`);

  // Minutes count from the start of the loop. They stop at the user's
  // acceptance while it covers the loop: a finished loop spends no more
  // budget. Once it no longer does, the minutes since count too.
  const { clock, used, exhausted } = budgetUsed(loop, runs, holds ? accepted.accepted?.at : undefined);
  // The packages whose digest differs from those the loop started on. A
  // change ends the loop, so while it goes on this is empty.
  const changedPackages = evals.cases.filter((item) => loop.task_digest[item.id] !== item.task_digest).map((item) => item.id);
  const reports = Object.fromEntries(runs.map((run) => [run.run_id, reportGaps(repo, name, run)]));
  // What a report still lacks before anything else: all of it but Review,
  // which the final review writes; a final run's report has Review filled in.
  const reportOpen = (run) => reports[run.run_id].filter((entry) => run.role === 'final' || !isReviewGap(entry));

  // Screen first, then a final run. In a loop whose plan runs a package more
  // than once, every full run of an iteration is a screen run, with one
  // attempt of each package; once one passes and its report and the final
  // review are done, the next full run on its code and packages is the final
  // run, and only a passing final run can be accepted. Without such a
  // package, every full run follows the plan and its role is null.
  // Whether a final run is needed rests on the loop's plan and its packages,
  // which are fixed: a package counts once it is connected, whatever its
  // git-ignored \`eval check\` record says (finalsNeeded).
  const needed = finalsNeeded(plan, evals.cases);
  const readyCases = evals.cases.filter((item) => item.integration?.state === 'ready');
  const connected = evals.cases.filter(connectedCase);
  // The packages a final run runs the plan's number of times.
  const planned = connected.filter((item) => plan?.uniform || liveCase(item));
  const byId = new Map(all.map((run) => [run.run_id, run]));
  // A recorded role stands, null too: a run outside a loop or in a loop that
  // needs no final run is neither. A full head run recorded before runs had a
  // role is a final run when it passed and ran each of those packages the
  // plan's number of times, as every full run did then; otherwise a screen
  // run: a failing one was an ordinary iteration, not a final run after a
  // passing screen run.
  const roleOf = (run) => {
    if (!run || run.side !== 'head' || (run.scope ?? 'full') !== 'full') return null;
    if (run.role !== undefined) return run.role;
    if (!needed) return null;
    const made = (id) => run.environment_ref?.attempts_by_case?.[id] ?? run.environment_ref?.attempts ?? 1;
    return run.verdict === 'pass' && planned.every((item) => (run.cases ?? []).some((entry) => entry.id === item.id) && made(item.id) === attemptsFor(item, plan)) ? 'final' : 'screen';
  };
  // The gating checks a run failed in an attempt that completed, on code and
  // packages that stayed as they were, as `case/check`: a result of the
  // code, also when another attempt of the run errored.
  const failedInRun = (run) => {
    if (run.verdict !== 'fail' || !settled(run)) return [];
    const ofRun = gatingKeys(compareOf(runsDirectory, run));
    return [...new Set(pool.filter((entry) => entry.run_id === run.run_id && entry.result === 'fail' && ofRun.has(`${entry.case}\n${entry.check}`))
      .map((entry) => `${entry.case}/${entry.check}`))].sort();
  };
  // A final run counts once it completed on code and packages that stayed as
  // they were, or once a gating check failed in an attempt that completed;
  // one with an execution error and no such failure goes to repair_execution.
  const counted = (run) => roleOf(run) === 'final' && settled(run) && (run.execution_status === 'completed' || failedInRun(run).length > 0);
  const gatingFailuresOf = (run) => failuresOf(pool, run, gatingKeys(compareOf(runsDirectory, run)), repo);
  // The screen run whose final run is due: the latest that passed, with its
  // report complete, on the code and packages as they are now, and whose code
  // never failed a gating check with those packages, agent and model.
  const candidate = needed ? runs.findLast((run) => roleOf(run) === 'screen' && settled(run) && run.execution_status === 'completed' && run.verdict === 'pass'
    && !reports[run.run_id].length && nowCode !== null && identityOf(run) === nowCode && !changedBetween(run.task_digest, digestsNow).length
    && !gatingFailuresOf(run).length) ?? null : null;
  const finalsOf = candidate ? runs.filter((run) => run !== candidate && counted(run) && (run.final_of === candidate.run_id
    || (identityOf(run) === identityOf(candidate) && !changedBetween(run.task_digest, candidate.task_digest).length))) : [];
  const incomplete = finalsOf.filter((run) => run.verdict === 'unverified');
  const pending = Boolean(candidate) && !finalsOf.some((run) => ['pass', 'fail'].includes(run.verdict)) && incomplete.length < 2;
  // The final runs of this loop that failed. Only a run recorded as a final
  // run counts: before runs had a role, every full run of a loop followed the
  // plan, so a failing one was an ordinary iteration, not a final run after a
  // passing screen run.
  const failedFinals = needed ? runs.filter((run) => run.role === 'final' && counted(run) && run.verdict === 'fail') : [];
  const final = { needed, attempts: plan?.attempts ?? null, live: (needed ? planned : readyCases.filter(liveCase)).map((item) => item.id),
    candidate: candidate?.run_id ?? null, pending, finals: finalsOf.map((run) => ({ run_id: run.run_id, verdict: run.verdict })),
    failed: failedFinals.map((run) => run.run_id), incomplete: incomplete.map((run) => run.run_id) };
  // The gating checks of a run that failed, with how many attempts passed.
  const failedText = (run) => compareOf(runsDirectory, run).filter((entry) => entry.role === 'gating' && entry.after === 'fail').map((entry) => {
    const counts = entry.after_counts ?? { pass: 0, fail: 1, unknown: 0 };
    const total = counts.pass + counts.fail + counts.unknown;
    return `${entry.case}/${entry.check} passed ${counts.pass} of ${total} attempt${total === 1 ? '' : 's'}`;
  }).join(', ');
  const unknownIn = (list) => [...new Set(list.flatMap((run) => compareOf(runsDirectory, run).filter((entry) => entry.role === 'gating' && entry.after === 'unknown')
    .map((entry) => `${entry.case}/${entry.check}`)))].join(', ') || 'some gating checks';
  const others = connected.filter((item) => !planned.includes(item));
  const finalPlan = planned.length === 1 ? `${planned[0].id} runs ${plan?.attempts ?? 1} times${others.length ? ' and every other package once' : ''}`
    : `${planned.map((item) => item.id).join(', ')} run ${plan?.attempts ?? 1} times each${others.length ? ' and every other package once' : ''}`;
  // What the next runs take by earlier attempts, the loop's own full runs
  // first, and what the budget has left. A partial run is a quick look, so its
  // attempts never lower the estimate.
  const estimate = { ...estimateRuns(repo, name, { base, plan, cases: evals.cases, runs }),
    remaining: { runs: Math.max(0, loop.budget.iterations - used.iterations), minutes: Math.max(0, loop.budget.minutes - used.minutes) } };
  // The final run's time and cost, and what they rest on. Fixtures make no
  // model call, so a figure from eval check is a lower bound.
  const fromFixtures = estimate.basis === 'eval_check';
  const finalCost = estimate.final.minutes === null ? ''
    : ` It takes about ${shownMinutes(estimate.final.minutes)} minutes${estimate.final.cost_usd === null ? '' : `, and about ${shownCost(estimate.final.cost_usd)} in model calls`}${fromFixtures ? ', or more' : ''} (${basisText(estimate, base)}${fromFixtures ? ', whose fixtures make no model call' : ''}).`;
  // What the loop's head runs, full and partial, took and used so far.
  const usage = usageOfRuns(runsDirectory, ours);
  const tokens = usage.n_input_tokens === null && usage.n_output_tokens === null ? null : (usage.n_input_tokens ?? 0) + (usage.n_output_tokens ?? 0);
  const reported = [...(usage.cost_usd === null ? [] : [shownCost(usage.cost_usd)]), ...(tokens === null ? [] : [`${tokens} tokens`])];
  const usageText = ` The loop used ${usage.minutes === null ? 'an unknown number of' : shownMinutes(usage.minutes)} minutes${reported.length
    ? `, ${reported.join(' and ')} as the adapter reported them` : ''} over ${usage.runs} run${usage.runs === 1 ? '' : 's'}.`;
  const joined = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join(''));
  const latestFailedFinal = Boolean(latest && needed && latest.role === 'final' && counted(latest) && latest.verdict === 'fail');
  // The final runs that counted on a run's code and packages, other than it.
  const finalsOnCodeOf = (run) => runs.filter((other) => other !== run && counted(other) && identityOf(other) !== null
    && identityOf(other) === identityOf(run) && !changedBetween(other.task_digest, run.task_digest).length);
  // A passing screen run whose code and packages already passed a final run:
  // that final run is the one to accept, and no final review is due.
  const passedFinalOf = needed && latest?.verdict === 'pass' && roleOf(latest) === 'screen' && settled(latest) && !gatingFailuresOf(latest).length
    ? finalsOnCodeOf(latest).findLast((run) => run.verdict === 'pass') ?? null : null;
  // A passing screen run whose code cannot reach a final run, which needs no Review.
  const noReview = needed && latest?.verdict === 'pass' && roleOf(latest) === 'screen' && (gatingFailuresOf(latest).length > 0 || Boolean(passedFinalOf));
  // A gating check that failed on the code and packages of a final run that
  // passed. A failed final run has passing attempts too; it is no such run.
  const passedFinal = (id) => roleOf(byId.get(id)) === 'final' && byId.get(id).verdict === 'pass';
  const contradicted = needed ? unstable.filter((group) => group.pass.some(passedFinal)) : [];
  // An earlier release could accept a screen run of a loop that needs a final
  // run. The user's acceptance is not withdrawn for it, but they hear of it.
  if (holds && needed && acceptedRun && roleOf(acceptedRun) === 'screen') {
    warnings.push(`The accepted run ${accepted.run_id} is a screen run: its pass rests on ${screenBasis(acceptedRun, planned.map((item) => item.id), plan.attempts)}, and this loop needs a passing final run, which \`loop accept\` asks for now (not_final). So this acceptance would be refused today. It stays recorded; tell the user.`);
  }
  if (keeps === false) warnings.push(`The code changed after the accepted run ${accepted.run_id}. The acceptance covers that run's code only.`);
  if (failedAfter) {
    const partial = (failedAfter.scope ?? 'full') === 'partial';
    const since = Date.parse(failedAfter.started_at) > Date.parse(accepted.accepted?.at) ? 'after the user accepted run' : 'which started after the accepted run';
    warnings.push(`${partial ? 'Partial run' : 'Run'} ${failedAfter.run_id}, ${since} ${accepted.run_id}, fails${partial ? ' on the accepted code' : ''}, so the acceptance no longer covers this loop. ${cover.failedSame.includes(failedAfter.run_id)
      ? 'A failure of the accepted code always counts, so no run of it can be accepted again. Tell the user.'
      : failedAfter === latest
        ? 'Fix the cause, run again, and ask the user to accept a passing run again.'
        : partial ? 'Tell the user about that failure, run every package again, and ask them to accept a passing full run.'
          : 'Tell the user about that failure, and ask them to accept a passing run again.'}`);
  }
  // A passing run says nothing about code that changed after it.
  const moved = latest?.verdict === 'pass' && sameCode(latest.code_snapshot, now, repo) === false;
  // What eval check and run start refuse while it lasts, such as a package
  // whose tests/checks.json no longer validates.
  const blocking = evals.spec ? evals.gaps.filter((entry) => entry.code !== 'integration_pending') : [];
  // The packages a run would skip until `eval check` proves them as they are.
  const unchecked = blocking.length ? [] : evals.cases.filter(waitsForCheck).map((item) => item.id);
  // The user's acceptance stays when a package changes after it, but they hear of it.
  const afterAcceptance = holds && acceptedRun ? changedBetween(acceptedRun.task_digest, digestsNow) : [];
  if (afterAcceptance.length) warnings.push(`The eval packages changed after the accepted run ${accepted.run_id}: ${afterAcceptance.join(', ')}. The acceptance stays as it was given; tell the user what changed and why.`);
  const reaccept = accepted && !holds ? ` The user's acceptance of run ${accepted.run_id} no longer covers the loop, so a passing run needs their acceptance again.` : '';
  // The packages changed since the user's newest checks confirmation of this
  // loop's Spec export.
  const unconfirmed = loop.checks_confirmation && confirmed.match && !confirmed.match.matches
    ? confirmed.match.packages.map((entry) => ({ id: entry.id, files: matchFiles({ packages: [entry], kit: confirmed.match.kit }) })) : [];
  // The lines whose only counterexamples a self-review wrote, in a confirmation.
  const selfReviewOf = (entry) => (entry?.lines ?? []).filter((line) => line.counterexamples?.length && line.counterexamples.every((item) => item.origin === 'self-review'))
    .map((line) => ({ package: line.package, then: line.then }));

  const command = (...words) => [...words, name, '--repo', repo];
  const runStart = command('run', 'start');
  const pendingPackages = evals.cases.filter((item) => item.integration?.state !== 'ready').map((item) => item.id);
  const ends = 'This loop has ended: `run start` refuses its head runs.';
  // A stop on budget ends the loop; a bigger budget goes to a new one. detail
  // says why; stopText names what to report.
  const stopBudget = (detail, { reason = 'budget_used_up', stopText = 'Stop and report what still fails.', shown = null, after = '' } = {}) => ({ action: 'stop_budget', owner: 'user', reason,
    command: [...command('loop', 'start'), '--max-iterations', '<N>', '--max-minutes', '<M>'], ...(shown ? { estimate: shown } : {}),
    message: `${reason === 'final_run_does_not_fit' ? detail : `The budget is used up (${used.iterations} of ${loop.budget.iterations} runs, ${used.minutes} of ${loop.budget.minutes} minutes).${detail ? ` ${detail}` : ''}`} ${stopText} ${ends} A bigger budget goes to a new loop, once the user agrees: \`loop start --max-iterations N --max-minutes M\`.${after}` });

  // The stops, from the loop's own runs. Each holds for good: run start
  // refuses the head runs of a stopped loop, so its runs no longer change.
  const unstableStop = needed ? failedFinals.length >= 2 || contradicted.length > 0 : unstable.length > 0;
  // Two counted final runs of one code that left evidence missing.
  const incompleteGroup = needed ? (() => {
    const groups = new Map();
    for (const run of runs.filter((entry) => counted(entry) && entry.verdict === 'unverified')) {
      const key = identityOf(run) ?? run.final_of;
      groups.set(key, [...(groups.get(key) ?? []), run]);
    }
    return [...groups.values()].find((list) => list.length >= 2) ?? null;
  })() : null;
  // A final run whose estimate from the loop's own runs does not fit what is
  // left of the budget: the latest screen run passed, its code never failed,
  // and no final run of its code passed or failed. It rests on the runs and
  // the clock only, not on the report or the final review, which may still
  // follow: neither a code change nor an emptied report lifts it.
  const fits = estimate.final.minutes === null || estimate.final.minutes <= estimate.remaining.minutes;
  const lastScreen = needed ? runs.findLast((run) => roleOf(run) === 'screen') ?? null : null;
  const dueScreen = lastScreen && settled(lastScreen) && lastScreen.execution_status === 'completed' && lastScreen.verdict === 'pass'
    && !gatingFailuresOf(lastScreen).length && !finalsOnCodeOf(lastScreen).some((run) => ['pass', 'fail'].includes(run.verdict))
    && finalsOnCodeOf(lastScreen).filter((run) => run.verdict === 'unverified').length < 2 ? lastScreen : null;
  const finalUnfit = needed && Boolean(dueScreen) && !exhausted && !fits;
  const stuckStop = stuck && !regressions.length;
  const unstableNext = () => {
    const tail = `Stop and tell the user what the runs showed. This loop has ended: a code change does not lift this stop, and \`run start\` refuses its head runs. The user decides: find and fix what makes the result vary, or change the requirement through agent-spec. A new loop needs their go-ahead; it keeps the start code, and the failures of the same code still count.${exhausted ? ` The budget is used up too (${used.iterations} of ${loop.budget.iterations} runs, ${used.minutes} of ${loop.budget.minutes} minutes).` : ''}${accepted && !holds ? ` The user's acceptance of run ${accepted.run_id} no longer covers the loop.` : ''}`;
    const settles = 'Checks that fail some of the time on code that passed its screen run are not settled by running again.';
    return { action: 'stop_unstable', owner: 'user',
      message: !needed ? `${unstable.map((group) => `${group.case}/${group.check} passed in ${group.pass.join(', ')} and failed in ${group.fail.join(', ')}`).join('; ')}, on the same code and packages. A failure of the same code always counts: running it again only adds to the count, and no run of this code can be accepted. ${tail}`
        : contradicted.length ? `${contradicted.map((group) => `Final run ${group.pass.filter(passedFinal).at(-1)} passed, but ${group.case}/${group.check} failed on the same code in ${group.fail.join(', ')}`).join('; ')}. ${settles} ${tail}`
          : `${failedFinals.length === 2 ? 'Two' : failedFinals.length} final runs of this loop failed: ${joined(failedFinals.map((run) => `${run.run_id} (${failedText(run)})`))}. ${settles} ${tail}` };
  };
  // Two final runs of one code and its packages left evidence missing: no
  // third one is made, so the user decides. The screen run named is the one
  // they ran the code of.
  const stopIncomplete = (list) => {
    const screens = [...new Set(list.map((run) => run.final_of).filter(Boolean))];
    return { action: 'stop_incomplete', owner: 'user',
      message: `Two final runs of the code of screen run ${joined(screens.length ? screens : [candidate?.run_id ?? latest.run_id])}, ${joined(list.map((run) => run.run_id))}, found no failure but left ${unknownIn(list)} unknown, so no further final run of this code and these packages is made. Stop and tell the user what kept the evidence from being read. This loop has ended. The user decides how to go on; a new loop, once they agree, screens and reviews the code again before its final run, and a fix to a package or the kit needs \`eval check\`, \`eval review\` and their \`eval confirm\` first.` };
  };
  const finalUnfitNext = () => stopBudget(`Screen run ${dueScreen.run_id} passed${reports[dueScreen.run_id].length ? '' : ' and its final review is done'}, but the final run (${finalPlan}) takes about ${shownMinutes(estimate.final.minutes)} minutes${estimate.final.cost_usd === null ? '' : ` and ${shownCost(estimate.final.cost_usd)}`} (${basisText(estimate, base)}), more than the ${shownMinutes(estimate.remaining.minutes)} minutes left of the budget.`,
    { reason: 'final_run_does_not_fit', stopText: `Stop and tell the user that only the final run is left, and what it takes${reports[dueScreen.run_id].length ? '; write the report and do the final review first, as `loop status` asks' : ''}.`,
      shown: { minutes: estimate.final.minutes, cost_usd: estimate.final.cost_usd, basis: estimate.basis }, after: SCREEN_AGAIN });
  const stuckNext = () => ({ action: 'stop_stuck', owner: 'user', message: `The same gating checks failed in ${pair} on different code: ${failing(runs.length - 1, both).join(', ')}. Stop, report what was tried, and ask the user how to proceed. ${ends} A code change does not lift this stop.` });
  const noGatingNext = () => ({ action: 'stop_no_gating', owner: 'user', route: 'write-eval', message: `${NO_GATING} Stop and tell the user. ${NO_GATING_REPAIR}` });
  const stopNext = unstableStop ? unstableNext() : incompleteGroup ? stopIncomplete(incompleteGroup) : finalUnfit ? finalUnfitNext()
    : allManual(evals) ? noGatingNext() : stuckStop ? stuckNext() : null;

  // A loop whose fixed input changed: the reason and what changed. Every full
  // run gets a report, so one the latest run still lacks is asked for first.
  const endedNext = () => {
    const facts = without(ended, 'reason');
    const open = latest && reportOpen(latest).length ? latest : null;
    const at = { action: 'loop_ended', owner: 'user', reason: ended.reason, ...facts,
      ...(open ? { command: [...command('loop', 'report'), '--run', open.run_id] } : {}) };
    const report = open ? ` Before anything else, write the report for ${open.run_id} with \`loop report --run ${open.run_id}\` (${reportOpen(open).join('; ')}): every full run gets one, and it holds what this loop found.` : '';
    const ending = (message) => ({ ...at, message: `${message}${report}` });
    if (ended.reason === 'spec_exported') {
      return { ...ending(`The Spec was exported again (${evals.spec.slice(7, 19)}), so this loop, started on ${loop.spec.slice(7, 19)}, has ended${ended.accepted
        ? `; the user accepted it${accepted ? ` (run ${accepted.run_id})` : ''}: a loop for the new export may start from the accepted code`
        : `: a new loop keeps its start code, ${restoreHint(name, loop, base)}, until a loop of this change is accepted`}. Bring the packages in line with write-eval; the user confirms the checks of the new export. Expected results never change inside a loop. \`workflow check run-eval\` names the next step; a new loop needs the user's go-ahead.`), route: 'write-eval' };
    }
    if (ended.reason === 'baseline_missing') return { ...ending(pinnedBase(repo, name, loop).gap.message), route: 'run-eval' };
    if (ended.reason === 'confirmation_changed') {
      const parts = [...(ended.plan.length ? [`it confirms ${confirmedPlan(newer.run_plan ?? {})} where the loop runs ${confirmedPlan(plan)}`] : []),
        ...(ended.packages.length ? [`it covers other packages than the loop runs: ${ended.packages.join(', ')}`] : [])];
      return { ...ending(`The user's newest checks confirmation (${ended.at ?? 'no date'}) differs from this loop's: ${parts.join('; ')}. So this loop has ended: \`run start\` and \`loop accept\` refuse it. A new loop, once the user agrees, needs a baseline of that plan on the start code (${restoreHint(name, loop, base)}).`), route: 'run-eval' };
    }
    // The packages or the kit changed. In a new project, connecting the
    // packages is the change that ends the first loop: a package that changed
    // was not connected when the user confirmed the checks this loop runs, and
    // its baseline records that nothing could run.
    const what = ended.files.length ? named(ended.files) : ended.packages.join(', ');
    const unavailable = base && !base.is_baseline;
    const connecting = unavailable && (loopEntry ? ended.packages.some((id) => loopEntry.packages?.[id]?.ready === false) : true);
    const record = unavailable ? `\`run start --baseline --unavailable ${base.baseline_unavailable_reason ?? 'no_implementation'}\`` : '`run start --baseline` and the same --expect file';
    const follows = ` What follows: \`eval check\` proves the ${connecting ? 'connected' : 'changed'} packages; \`eval review\` gives the reviewer's brief and questions, and the reviewer writes the ${connecting ? 'counterexamples and answers' : 'answers, and any counterexample a line lacks,'} into review.json; the user confirms the packages with \`eval confirm --reason\`; the baseline is recorded again on the loop's start code (${restoreHint(name, loop, base)}) with ${record}; then a new loop starts with \`loop start\` once the user agrees.`;
    const after = connecting
      ? ` This loop started on a baseline recorded as unavailable (${base.run_id}), so this end is the expected step once the packages are connected.${follows}`
      : ` A new loop, once the user agrees, needs a baseline of those packages on the loop's start code.${follows}`;
    return { ...ending(`The eval packages or the project kit differ from the checks the user confirmed for this loop: ${what}. A loop's packages and kit are fixed, so this loop has ended: \`run start\` and \`loop accept\` refuse it. Going on needs the user's \`eval confirm\` of the packages as they are. You may fix the packages in write-eval and run \`eval check\` and \`eval review\`.${after}${blocking.length ? ` ${blocking.map((entry) => entry.message).join(' ')}` : ''}${blocking.some((entry) => entry.owner === 'user') ? ' The decision on a package set to draft is the user\'s, through agent-spec.' : ''}`), route: 'write-eval' };
  };

  let next;
  if (!evals.spec) {
    // The Spec no longer matches the export this loop started from. That is
    // not a new export: nothing ends until the cause is known.
    const edited = evals.gaps.some((entry) => entry.code === 'handoff_missing');
    const owner = evals.gaps.some((entry) => entry.owner === 'agent') || edited ? 'agent' : 'user';
    next = { action: 'repair_spec', owner, route: 'agent-spec',
      message: `${edited ? `The Spec files differ from the export this loop started from (${loop.spec.slice(7, 19)}).`
        : `The Spec this loop started from no longer validates: ${evals.gaps.map((entry) => entry.message).join(' ')}`} A loop never changes the Spec: restore what changed. If a requirement itself has to change, that is the user's decision through agent-spec, then a new export and a new loop.` };
  } else if (ended?.reason === 'spec_exported') {
    next = endedNext();
  } else if (holds) {
    const step = commitStep(repo, name, now, keeps === true);
    next = { action: 'done', ...(step.commit ? { commit: step.commit } : {}), ...(step.uncommitted ? { uncommitted: step.uncommitted } : {}),
      message: `${accepted.accepted?.by ?? 'The user'} accepted run ${accepted.run_id} (${accepted.accepted?.ref ?? 'no reference'}). The loop is finished. ${step.message}` };
  } else if (ended) {
    next = endedNext();
  } else if (latest && latest.execution_status !== 'completed' && !counted(latest)) {
    // A failure in an attempt that completed counts, whatever else errored.
    const burnedHere = failedInRun(latest);
    next = exhausted ? stopBudget(`The last run, ${latest.run_id}, did not complete.`)
      : { action: 'repair_execution', route: 'run-eval', message: `${latest.run_id} did not complete. Read cases[].execution.reason and each logs/harbor.log. A build or timeout fault is rerun. A fix to an adapter or the environment changes a package or the kit, which ends this loop (packages_changed). Neither is a result of the code.${burnedHere.length
        ? ` But ${burnedHere.join(', ')} failed in an attempt that completed, which is a result of the code and counts: no run of this code with these packages can be accepted. Fix the cause, then change the code before the next run.` : ''}` };
  } else if (latest?.code_changed_during_run || latest?.packages_changed_during_run) {
    // Its results belong to no one version of the code or the packages: they
    // need no report, and no regression, lost progress or stuck loop is
    // measured with them, now or once a later run follows. Nor can it be
    // accepted, and it adds nothing to the results of the same code. A
    // package still changed afterwards has ended the loop above.
    const detail = [
      ...(latest.code_changed_during_run ? [`The code changed while ${latest.run_id} executed, so its results do not belong to one version of the code.`] : []),
      ...(latest.packages_changed_during_run ? [`The eval packages changed while ${latest.run_id} executed (${changedDuring(latest)}), so its results do not belong to one version of them.`] : []),
    ].join(' ');
    const how = !latest.packages_changed_during_run ? 'Leave the code as it is during a run, and run every package again with `run start`.'
      : `Leave the ${latest.code_changed_during_run ? 'code, the packages' : 'packages'} and the project kit as they are during a run, and run every package again with \`run start\`.`;
    next = exhausted ? stopBudget(`${detail} Another run needs more budget.`)
      : { action: 'run_again', command: runStart, message: `${detail} ${how}${reaccept}` };
  } else if (latest && reportOpen(latest).length) {
    // Review is written at the final review, never with the rest of the
    // report; the report of a final run has it already.
    next = { action: 'write_report', command: command('loop', 'report'),
      message: `Write the report for ${latest.run_id} before anything else: ${reportOpen(latest).join('; ')}.${latest.verdict !== 'pass' || latest.role === 'final' ? ''
        : noReview ? ' Leave Review empty: no final review follows for this code.' : ' Leave Review for the final review that follows.'}` };
  } else if (stopNext && ['stop_unstable', 'stop_incomplete'].includes(stopNext.action)) {
    next = stopNext;
  } else if (blocking.length && !exhausted) {
    // Every run and every `eval check` is refused until they are repaired. A
    // package edit has ended the loop above; what reaches here is outside the
    // packages, such as .dockerignore.
    next = { action: 'iterate', message: `${blocking.map((entry) => entry.message).join(' ')} \`eval check\` and \`run start\` refuse until then. Repair what they name, then run again.${reaccept}`,
      pending_packages: pendingPackages };
  } else if (moved) {
    // A package not proved yet as it is comes first: a run would skip it.
    const code = `The code changed after ${latest.run_id}${accepted?.run_id === latest.run_id ? ', the run the user accepted, so the acceptance no longer covers it' : ''}; that run says nothing about the code now.`;
    next = exhausted ? stopBudget(`${code} Another run needs more budget.`)
      : { action: 'run_again', command: unchecked.length ? command('eval', 'check') : runStart,
        message: `${code} ${unchecked.length ? `Prove ${unchecked.join(', ')} with \`eval check\`, then run` : 'Run'} every package again with \`run start\`, and ask the user to accept only a passing run of the current code.${reaccept}` };
  } else if (needed && latest?.verdict === 'pass' && roleOf(latest) === 'screen' && gatingFailuresOf(latest).length) {
    // A screen run that passed on code that already failed has no final run
    // that could be accepted.
    const burned = gatingFailuresOf(latest);
    const ids = [...new Set(burned.map((entry) => entry.run_id))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const why = `Screen run ${latest.run_id} passed, but its code failed ${[...new Set(burned.map((entry) => `${entry.case}/${entry.check}`))].join(', ')} in ${ids.join(', ')}. A pass never cancels a failure of the same code, so no final run of it can be accepted.`;
    next = exhausted ? stopBudget(`${why} Another screen run needs more budget.`)
      : { action: 'iterate', message: `${why} Change the code and screen it again.`, pending_packages: pendingPackages };
  } else if (passedFinalOf && reports[passedFinalOf.run_id].length) {
    // The final run of this code passed; its report comes before acceptance.
    next = { action: 'write_report', command: [...command('loop', 'report'), '--run', passedFinalOf.run_id],
      message: `Final run ${passedFinalOf.run_id} passed on the code and packages of ${latest.run_id}, so it is the run to accept. Write its report first: ${reports[passedFinalOf.run_id].join('; ')}.` };
  } else if (latest?.verdict === 'pass' && reports[latest.run_id].length && latest.role !== 'final' && !passedFinalOf) {
    // A Genesis review of the change starts from the Map the Spec was written
    // against, so the change lands on that Map's flows on every clone.
    // A loop started before its start code listed them names none.
    const start = loop.start_code ?? {};
    const atStart = start.uncommitted_files ?? [];
    const untracked = (gitStatus(repo) ?? []).some((entry) => entry.code === '??' && !isGenerated(entry.file));
    const review = genesisReview(repo, name, evals.map, loop.base_commit, { untracked, uncommittedAtStart: atStart });
    const patch = start.patch ? `.genesis/edd/${name}/${start.patch}` : null;
    // Without a starting commit there is no diff from it: every file was
    // uncommitted, and loop-start.patch holds them as they were.
    const before = !atStart.length ? ''
      : !loop.base_commit ? ` The loop started before the project's first commit, so no diff shows this change alone${patch ? `: ${patch} holds the files as they were then. Give it to the reviewer to compare with.` : `. Tell the reviewer which files were there before the loop: ${named(atStart)}.`}`
        : ` These files were already uncommitted when the loop started, so a diff from ${short(loop.base_commit)} also shows their edits from before the loop: ${named(atStart)}. Tell the reviewer those edits are not part of this change${patch ? `; ${patch} holds them` : ''}.`;
    // The gating checks that went from fail to pass: the reviewer says which
    // change explains each.
    const flips = compareOf(runsDirectory, latest).filter((entry) => entry.role === 'gating' && entry.before === 'fail' && entry.after === 'pass')
      .map((entry) => ({ case: entry.case, check: entry.check, then: entry.then ?? null }));
    const screen = needed && roleOf(latest) === 'screen';
    next = { action: 'final_review', ...(review ? { genesis_review: review } : {}), flips,
      message: `${screen ? `The screen run passed: ${screenBasis(latest, planned.map((item) => item.id), plan.attempts)}.` : 'Every gating check passes.'}${review ? ` If Genesis is installed, first review the change with its skill, and run every \`map prepare\` of that review as \`genesis ${review.prepare.join(' ')}\`: it starts from the Map the Spec was written against, so the change lands on the same flows on every clone. Give the reviewer the result.` : ''}${before} ${screen ? 'Before the final run, have' : 'Have'} the whole change reviewed in a fresh context against the Spec. The reviewer answers two things: for each gating check that went from fail to pass (next.flips), which change explains it; and whether each check is still faithful to its THEN line. Then write the Review section of this run's report: who reviewed, what they checked and found, and how each finding was handled, in at least ${REVIEW_MINIMUM} characters.` };
  } else if (needed && pending) {
    // The final review of the candidate is done: its final run is next, as
    // `run start` makes it whenever one is pending on the code as it is now,
    // once the estimate fits what is left of the budget.
    next = exhausted ? stopBudget(`Screen run ${candidate.run_id} passed and its final review is done; the final run needs more budget: ${finalPlan}.${finalCost}`,
      { stopText: 'Stop and tell the user that only the final run is left, and what it takes.', after: SCREEN_AGAIN })
      : finalUnfit ? stopNext
        : { action: 'final_run', owner: 'agent', command: unchecked.length ? command('eval', 'check') : runStart,
          message: `${unchecked.length ? `Prove ${unchecked.join(', ')} with \`eval check\` first: ${unchecked.length === 1 ? 'its record is' : 'their records are'} gone or stale, and a run skips a package whose verifier is not proved for it as it is. ` : ''}${incomplete.length
            ? `Final run ${incomplete.at(-1).run_id} found no failure but missing evidence (unknown): ${unknownIn([incomplete.at(-1)])}. Read its logs. If nothing in the packages or the project kit needs changing, such as a fault of the machine or of Docker, fix that and run the final run again on the same code with \`run start\`; a second incomplete final run goes to the user.${finalCost}`
            : `Screen run ${candidate.run_id} passed and its final review is done. Run the final run now with \`run start\`: on this code, ${finalPlan}, the packages that failed before first; it stops at the first package that fails, and only a passing final run can be accepted. Leave the code and the packages as they are until it finishes.${finalCost}`}` };
  } else if (passedFinalOf || (latest?.verdict === 'pass' && (!needed || roleOf(latest) === 'final'))) {
    // The run to accept: the latest, or the passing final run of the code a
    // later screen run ran again.
    const accepting = passedFinalOf ?? latest;
    const strength = strengthOf(accepting, compareOf(runsDirectory, accepting));
    // Lines no check verifies are the user's to judge, from what the agent produced.
    const manual = manualOf(runsDirectory, accepting);
    const one = manual.length === 1;
    const judge = !manual.length ? ''
      : needed ? ` No check verifies ${manualText(manual)}: show the user what the evaluated agent produced for ${one ? 'it' : 'each'} in each attempt of the final run, ${plan.attempts} for a package with a live dependency (<case>/attempts.json lists each trial's logs), and record acceptance only when they say ${one ? 'it holds' : 'each one holds'}.`
        : ` No check verifies ${manualText(manual)}: show the user what the evaluated agent produced for ${one ? 'it, from that case\'s logs/' : 'each, from each case\'s logs/'}, and record acceptance only when they say ${one ? 'it holds' : 'each one holds'}.`;
    const selfReview = selfReviewOf(confirmed.latest);
    next = { action: 'ask_acceptance', owner: 'user', command: [...command('loop', 'accept'), '--run', accepting.run_id, '--by', '<user>', '--ref', '<where they said so>'],
      strength, ...(manual.length ? { manual } : {}), ...(selfReview.length ? { self_review: selfReview } : {}),
      message: `${needed ? `Show the user the per-check comparison of final run ${accepting.run_id}, its report${accepting.final_of ? ` and the report of screen run ${accepting.final_of} with its Review` : ''}, and this: ${strength.sentence}${passedFinalOf ? ` Screen run ${latest.run_id} ran the same code again and adds nothing to accept.` : ''}${usageText}`
        : `Show the user the per-check comparison, the report and this: ${strength.sentence}${usageText} Record acceptance only with their own words; a pass is not acceptance.`}${judge}${selfReview.length
        ? ` Only a self-review counterexample stands behind: ${selfReview.map((entry) => `"${entry.then}" (${entry.package})`).join(', ')}; say so.` : ''}${needed ? ' Record acceptance only with their own words; a pass is not acceptance.' : ''}${reaccept}` };
  } else if (stopNext?.action === 'stop_no_gating') {
    // Nothing is open, and nothing can pass: another run tries nothing.
    next = stopNext;
  } else if (exhausted) {
    next = stopBudget([regressions.length ? `A check that passed now fails: ${regressions.map((entry) => `${entry.case}/${entry.check}`).join(', ')}.` : '',
      stuck ? `The same gating checks failed in ${pair} on different code.` : ''].filter(Boolean).join(' '));
  } else if (latestFailedFinal) {
    // One failed final run: that code can never be accepted, so change it.
    // An attempt of it that errored is fixed too, or the next run errors again.
    const errored = latest.execution_status !== 'completed'
      ? ' Another attempt of it did not complete: read cases[].execution.reason and each logs/harbor.log, and fix that cause too; a fix to an adapter or the environment changes a package or the kit, which ends this loop.' : '';
    next = { action: 'iterate', message: `Final run ${latest.run_id}${latest.final_of ? ` of the code of screen run ${latest.final_of}` : ''} failed: ${failedText(latest)}. A failure of the same code always counts, so this code can never be accepted, and one more failed final run of this loop stops it (stop_unstable).${errored} Read the failing attempts' logs (<case>/attempts.json names each trial), find what makes the result vary, change the code, and screen it again.`,
      pending_packages: pendingPackages };
  } else if (regressions.length) {
    next = { action: 'split_changes', message: `A check that passed now fails: ${regressions.map((entry) => `${entry.case}/${entry.check}`).join(', ')}. Restore the code of the last run where it passed (its commit, then \`git apply\` its code.patch) and reapply the changes one at a time to find the one that breaks it.` };
  } else if (stopNext?.action === 'stop_stuck') {
    next = stopNext;
  } else {
    const open = latest ? failing(runs.length - 1) : checks.filter((entry) => entry.role === 'gating' && entry.baseline !== 'pass').map((entry) => `${entry.case}/${entry.check}=${entry.baseline ?? 'no baseline'}`);
    // A package that waits only for `eval check` would be skipped by the run.
    const prove = unchecked.length ? ` Prove ${unchecked.join(', ')} with \`eval check\` before the run: a run skips a package whose verifier is not proved for it as it is.` : '';
    // While no package is connected, as at the start of a loop in a new
    // project, a run has nothing to run.
    const none = !readyCases.length
      ? 'No package is connected yet, so `run start` has nothing to run. Write the code\'s entry point. Connecting the packages in write-eval changes them, which ends this loop (packages_changed); the user then confirms them, and a new loop follows with their go-ahead. ' : '';
    // A new loop counts only its own runs. When the code as it is now passed
    // a full run of an earlier loop of this Spec export, with these packages,
    // agent and model and no failure of that code, as after a stop with only
    // the final run left, nothing in it needs changing: it is run again.
    const fixedPlan = loopEntry?.run_plan ?? plan ?? {};
    const samePlanAs = (run) => ((fixedPlan.agent ?? null) === null || (run.environment_ref?.agent ?? null) === fixedPlan.agent)
      && (run.environment_ref?.model ?? null) === (fixedPlan.model ?? null);
    const passedBefore = !latest && readyCases.length && nowCode ? all.filter((run) => run.side === 'head' && (run.scope ?? 'full') === 'full'
      && run.spec_snapshot?.sha256 === loop.spec && run.started_at < loop.started_at && run.verdict === 'pass' && settled(run) && run.execution_status === 'completed'
      && identityOf(run) === nowCode && !changedBetween(run.task_digest, digestsNow).length && !gatingFailuresOf(run).length
      && samePlanAs(run)).at(-1) ?? null : null;
    next = passedBefore
      ? { action: 'iterate', command: runStart, passed_before: passedBefore.run_id,
        message: `The code as it is now passed run ${passedBefore.run_id}${passedBefore.role ? ` (a ${passedBefore.role} run)` : ''} in an earlier loop of this change, with these packages, and no run of it failed. This loop counts only its own runs, so run it again with \`run start\`, without changing it${needed ? ': a screen run, whose report and final review come before the final run' : ': its report and the final review come before the user is asked to accept'}.${prove}`,
        pending_packages: pendingPackages }
      : { action: 'iterate', message: `${none || 'Classify, then change the right layer and run again; nothing has to be committed. '}Open: ${open.join(', ') || 'none recorded'}.${prove}`,
        pending_packages: pendingPackages };
  }
  // A stop that holds replaces every step that leads to another head run.
  if (stopNext && HEAD_RUN_STEPS.includes(next.action)) next = stopNext;
  return {
    change: name,
    loop: { started_at: loop.started_at, base_commit: loop.base_commit, baseline: loop.baseline,
      baseline_available: loop.baseline_available, run_plan: plan, budget: loop.budget, clock_started_at: clock,
      used, exhausted, checks_confirmation: loop.checks_confirmation ?? null, budget_source: loop.budget_source ?? null, follows: loop.follows ?? null,
      // A screen run, the final run and a full run by earlier attempts, and
      // what the loop's head runs took and used so far.
      estimate, usage },
    // The newest checks confirmation of the loop's Spec export, whether it
    // covers the packages as they are, and the packages changed since it.
    confirmation: confirmed.latest ? { id: confirmed.latest.id, at: confirmed.latest.confirmed?.at ?? null, by: confirmed.latest.confirmed?.by ?? null,
      kind: confirmed.latest.confirmed?.kind ?? null, current: confirmed.match.matches, unconfirmed } : null,
    runs: runs.map((run) => ({ run_id: run.run_id, role: roleOf(run), commit: run.code_snapshot?.commit ?? null, patch: run.code_snapshot?.patch ?? null, execution_status: run.execution_status,
      verdict: run.verdict, report: reports[run.run_id].length ? 'incomplete' : 'complete' })),
    // Screen and final runs: whether this loop needs a final run, the screen
    // run whose final run is due, and the final runs that count.
    final,
    partial_runs: ours.length - runs.length, checks, regressions, lost_progress: lost, stuck, changed_packages: changedPackages,
    // The gating checks that passed and failed on the code of one of this
    // loop's runs, with its packages.
    unstable: unstable.map((group) => ({ case: group.case, check: group.check, intent: keys.find((key) => key.case === group.case && key.check === group.check)?.intent ?? null,
      agent: group.agent, model: group.model, pass: group.pass, fail: group.fail })),
    accepted: accepted ? { run_id: accepted.run_id, by: accepted.accepted?.by ?? null, ref: accepted.accepted?.ref ?? null, at: accepted.accepted?.at ?? null,
      ...(holds ? {} : { outdated: true }) } : null,
    // The fixed input that changed, which ended the loop, and the stop that
    // holds, or null.
    ended, stop: stopNext ? { action: stopNext.action, ...(stopNext.reason ? { reason: stopNext.reason } : {}), route: stopNext.route ?? 'loop-and-implement', message: stopNext.message } : null,
    warnings, next,
  };
}

// Application files whose content differs between the code of two runs. Each
// run's code is its commit plus the digests of the files that commit does not
// hold, so a file is compared by its content in each, wherever it lives.
function changedFiles(repo, before, after) {
  if (!before || !after) return [];
  const git = (args, encoding = 'utf8') => spawnSync('git', ['-C', repo, ...args], { encoding, maxBuffer: 256 * 1024 * 1024 });
  const names = (args) => (git(args).stdout ?? '').split('\0').filter(Boolean);
  const candidates = new Set([...Object.keys(before.file_digests ?? {}), ...Object.keys(after.file_digests ?? {})]);
  if (before.commit !== after.commit) {
    const listed = before.commit && after.commit ? names(['diff', '--no-renames', '--no-ext-diff', '--name-only', '-z', before.commit, after.commit])
      : [before.commit, after.commit].filter(Boolean).flatMap((commit) => names(['ls-tree', '-r', '--name-only', '-z', commit]));
    for (const file of listed) candidates.add(file);
  }
  // A committed file is read as it would be checked out, so line-ending and
  // other filters do not count as changes; a submodule is its commit.
  const content = (snapshot, file) => {
    if (snapshot.file_digests && file in snapshot.file_digests) return snapshot.file_digests[file];
    if (!snapshot.commit) return 'deleted';
    const entry = (git(['--literal-pathspecs', 'ls-tree', '-z', snapshot.commit, '--', file]).stdout ?? '').split('\0')[0];
    if (!entry) return 'deleted';
    const [mode, , object] = entry.split(/\s/);
    if (mode === '160000') return `submodule ${object}`;
    const shown = git(['cat-file', '--filters', `${snapshot.commit}:${file}`], 'buffer');
    return shown.status === 0 ? digest(shown.stdout) : 'deleted';
  };
  return [...candidates].filter((file) => file && !isGenerated(file) && content(before, file) !== content(after, file)).sort();
}

// The eval package and project kit files that differ between two runs, for a
// report: each file of a package or of the kit whose digest differs, and a
// package on one side only. A run recorded before it listed its files names
// each package whose task digest differs instead.
function evalChanges(name, before, after) {
  if (!before || !after) return [];
  const folder = (id) => `.genesis/edd/${name}/evals/${id}/`;
  if (before.eval_snapshot && after.eval_snapshot) {
    const changed = evalFilesChanged(before.eval_snapshot, after.eval_snapshot);
    return [...Object.entries(changed.packages).flatMap(([id, files]) => (typeof files === 'string' ? [`\`${folder(id)}\` (${files})`]
      : files.map((file) => `\`${folder(id)}${file}\``))), ...changed.kit.map((file) => `\`.genesis/edd/harness/${file}\``)].sort();
  }
  return changedBetween(before.task_digest, after.task_digest)
    .map((id) => `\`${folder(id)}\` (it or the kit changed; this run record lists no files)`);
}

// Text in a cell of a Markdown table: one line, with its pipes escaped.
const cell = (text) => String(text).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

// One side of a check in the Result table: its result with its passes out of
// its attempts, or a dash when there is no result.
const resultCell = (result, counts) => (result === null || result === undefined ? '—'
  : counts ? `${result} (${counts.pass}/${counts.pass + counts.fail + counts.unknown})` : result);

// Writes the report skeleton of a full run, with Result taken from the records.
// It never overwrites a report.
export function writeReport(repo, name, options = {}) {
  const status = loopStatus(repo, name);
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const id = options.run ?? status.runs.at(-1)?.run_id;
  const index = status.runs.findIndex((run) => run.run_id === id);
  if (index < 0) throw new Error(`${id ?? 'No run'} is not a full run of this loop. Reports cover full runs only.`);
  const file = reportFile(repo, name, id);
  // Review is asked for at the final review, not while the report is written;
  // the report of a final run has it filled in.
  if (existsSync(file)) {
    const recorded = readJSON(path.join(runsDirectory, id, 'run.json'));
    return { file, created: false, missing: reportGaps(repo, name, recorded).filter((entry) => recorded.role === 'final' || !isReviewGap(entry)) };
  }
  const run = readJSON(path.join(runsDirectory, id, 'run.json'));
  const compare = compareOf(runsDirectory, run);
  const manual = manualOf(runsDirectory, run);
  // A final run is compared with its screen run, whose code it ran again.
  const screen = run.role === 'final' && run.final_of ? readRuns(runsDirectory).find((entry) => entry.run_id === run.final_of) ?? null : null;
  const before = screen ?? (index ? readJSON(path.join(runsDirectory, status.runs[index - 1].run_id, 'run.json'))
    : readRuns(runsDirectory).find((entry) => entry.run_id === status.loop.baseline));
  const files = changedFiles(repo, before?.code_snapshot, run.code_snapshot);
  const evalFiles = evalChanges(name, before, run);
  const from = screen ? `screen run ${screen.run_id}` : index ? `run ${status.runs[index - 1].run_id}` : `the baseline ${status.loop.baseline}`;
  const baseline = run.baseline ?? `unavailable (${run.baseline_unavailable_reason})`;
  const open = compare.filter((entry) => entry.verdict !== 'holds');
  const codeChanges = screen && !files.length ? `Same code as screen run ${screen.run_id}: no file changed.`
    : `Files changed since ${from}:\n${files.length ? files.map((item) => `- \`${item}\``).join('\n') : '- none'}`;
  // The sections the skeleton leaves open: Cause while a check has no cause,
  // Changes unless a final run repeats its screen run's code, and Next.
  const sections = [...(open.length ? ['Cause'] : []), ...(screen && !files.length ? [] : ['Changes']), 'Next'];
  const fill = sections.length > 1 ? `${sections.slice(0, -1).join(', ')} and ${sections.at(-1)}` : sections.join('');
  const review = screen ? `The final review of screen run ${screen.run_id} covers this code; see reports/${screen.run_id}.md.`
    : '<!-- Leave this empty until `loop status` says final_review. Then: who reviewed the whole change in a fresh context, what they checked (special cases for eval inputs, changes beyond the Spec, side effects no check covers), what they found, and how each finding was handled. -->';
  const text = `<!-- ${TEMPLATE_MARK}: keep Result as written; write ${fill}, then delete this line. -->
# ${name}: run ${id}${screen ? ` (final run of ${screen.run_id})` : ''}

Code \`${short(run.code_snapshot?.commit)}\`${run.code_snapshot?.patch ? ' + code.patch' : ''} · verdict \`${run.verdict}\` · baseline \`${baseline}\` · run ${index + 1} of ${status.loop.budget.iterations}

## Result

Only gating checks decide the verdict; a diagnostic result is shown for reference. Each result shows its passes out of its attempts.

| Case | Check | Requirement | THEN | Role | Before → After | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
${compare.map((entry) => `| ${entry.case} | ${entry.check} | ${entry.intent} | ${entry.then ? cell(entry.then) : '—'} | ${entry.role ?? '—'} | ${resultCell(entry.before, entry.before_counts)} → ${resultCell(entry.after, entry.after_counts)} | ${entry.verdict} |`).join('\n')}
${stoppedText(run)}${manual.length ? `
No check verifies these lines; the user judges them at acceptance:

| Case | THEN | Why no check |
| --- | --- | --- |
${manual.map((entry) => `| ${entry.case} | ${cell(entry.then)} | ${cell(entry.reason)} |`).join('\n')}
` : ''}
## Cause

<!-- For each check below, name the cause: requirement unclear, package or environment, code logic, or needs the user. Cite the log you read. -->
${open.length ? open.map((entry) => `- \`${entry.case}\` \`${entry.check}\` (${entry.verdict}):`).join('\n') : '- Every check holds.'}

## Changes

<!-- Say what each change does and why. For a change to an eval package or the kit, say which fault in it the change fixes and what evidence showed it. -->
Eval package and project kit files changed since ${from}:
${evalFiles.length ? evalFiles.map((item) => `- ${item}`).join('\n') : '- none'}

${codeChanges}

## Next

<!-- The next step: which layer to change, stop, or hand to the user. -->
${run.verdict === 'pass' ? `
## Review

${review}
` : ''}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { flag: 'wx' });
  return { file, created: true,
    next: `Fill in ${fill}, then delete the template line.${run.verdict === 'pass' ? screen ? ' Review is filled in: the final review of the screen run covers this code.' : ' Leave Review empty: it is written at the final review, when `loop status` asks for it.' : ''}` };
}

// The packages a final run did not run because it stopped at a failing one,
// as a line under Result, or nothing.
function stoppedText(run) {
  const stopped = (run.skipped ?? []).filter((entry) => entry.reason === 'final_stopped');
  if (!stopped.length) return '';
  const after = [...new Set(stopped.map((entry) => entry.after))].join(', ');
  return `
Not run: ${stopped.map((entry) => entry.case).join(', ')} (the final run stopped after ${after} failed).
`;
}

// Records the user's acceptance of one passing run, and only of the code and
// the eval packages that ran.
export function acceptLoop(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who accepted and where they said so. Acceptance is the user\'s decision.');
  const status = loopStatus(repo, name);
  const loop = readLoop(repo, name);
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const listed = status.runs.find((entry) => entry.run_id === options.run);
  const gaps = [];
  if (!listed) gaps.push(gap('run_unknown', 'loop-and-implement', `${options.run ?? 'No run'} is not a full run of this loop.`));
  const run = listed ? readJSON(path.join(runsDirectory, listed.run_id, 'run.json')) : null;
  if (run && (run.verdict !== 'pass' || run.execution_status !== 'completed')) gaps.push(gap('not_passing', 'loop-and-implement', `${run.run_id} has verdict ${run.verdict}; only a passing run can be accepted.`));
  // In a loop that needs a final run, a screen run's pass is a lead. A run
  // that did not pass has no pass to rest on: not_passing says enough. Nor is
  // a run accepted that made fewer attempts of a package with a live
  // dependency than the plan, whatever the packages look like now.
  const plan = run ? planOf(run) : null;
  const short = run ? Object.entries(run.environment_ref?.attempts_by_case ?? {})
    .filter(([id, made]) => made < attemptsFor({ dependencies: run.environment_ref?.dependencies?.[id] }, plan)).map(([id]) => id) : [];
  if (run && (status.final.needed ? listed.role !== 'final' : short.length > 0) && run.verdict === 'pass' && run.execution_status === 'completed') {
    gaps.push(gap('not_final', 'loop-and-implement', `${run.run_id} is a screen run: its pass rests on ${screenBasis(run, status.final.needed ? status.final.live : short, plan?.attempts ?? status.final.attempts)}. Run the final run, which \`loop status\` names as final_run, and accept that one.`));
  }
  // A run of this loop ran the loop's plan: the agent and the model of the
  // loop's checks confirmation, else of its baseline's plan, and the attempts
  // of that plan.
  if (run && loop) {
    const confirmations = checksConfirmation(repo, name, loop.spec);
    const entry = !confirmations.gap && loop.checks_confirmation ? confirmationById(confirmations.entries, loop.checks_confirmation.id) : null;
    const base = readRuns(runsDirectory).find((item) => item.run_id === loop.baseline) ?? null;
    const fixed = entry?.run_plan ?? planOf(base) ?? {};
    const ran = run.environment_ref ?? {};
    const differs = [
      ...((fixed.agent ?? null) !== null && (ran.agent ?? null) !== fixed.agent ? [`agent ${ran.agent ?? 'none'} where the loop runs ${fixed.agent}`] : []),
      ...(base && (ran.model ?? null) !== (fixed.model ?? null) ? [`model ${ran.model ?? 'none'} where the loop runs ${fixed.model ?? 'none'}`] : []),
      ...(planOf(run)?.attempts !== undefined && base && (planOf(run).attempts ?? null) !== (planOf(base)?.attempts ?? null) ? [`${planOf(run).attempts ?? 'no fixed number of'} attempts where the loop runs ${planOf(base)?.attempts ?? 'no fixed number of'}`] : []),
    ];
    if (differs.length) gaps.push(gap('loop_plan_differs', 'run-eval', `${run.run_id} ran another plan than this loop's: ${differs.join('; ')}. Only a run of the loop's plan can be accepted.`));
  }
  if (run?.code_changed_during_run) gaps.push(gap('code_changed_during_run', 'run-eval', `The code changed while ${run.run_id} executed, so no one version of the code passed. Run again without editing the code during the run, and accept that run.`));
  if (run?.packages_changed_during_run) gaps.push(gap('packages_changed_during_run', 'run-eval', `The eval packages changed while ${run.run_id} executed, so no one version of them passed. Prove them again with \`eval check\`, run again without editing them during the run, and accept that run.`));
  const compare = run ? compareOf(runsDirectory, run) : [];
  // A failure of a gating check on the same code, packages, agent and model,
  // in any run before or after this one, a partial or a base run included,
  // is never cancelled by this pass.
  const failures = run && run.verdict === 'pass' && loop ? failuresOf(sameCodeResults(repo, runsDirectory, loop.spec), run, gatingKeys(compare), repo) : [];
  if (failures.length) {
    const byCheck = new Map();
    for (const entry of failures) {
      const id = `${entry.case}/${entry.check}`;
      byCheck.set(id, [...new Set([...(byCheck.get(id) ?? []), entry.run_id])]);
    }
    gaps.push(gap('unstable', 'loop-and-implement', `${[...byCheck].map(([id, ran]) => `${id} failed in ${ran.join(', ')}`).join('; ')}, on the code and packages of ${run.run_id}. A failure of the same code always counts, and a later pass does not cancel it, so ${run.run_id} cannot be accepted. Tell the user which runs passed and failed; they decide whether the code is changed until the check passes every time, or the requirement is changed through agent-spec.`, 'user', 'business'));
  }
  // The user accepts the packages that ran too.
  const differ = run ? changedBetween(run.task_digest, evalSnapshot(repo, name).task_digest) : [];
  if (differ.length) gaps.push(gap('packages_changed', 'run-eval', `The eval packages changed after ${run.run_id}: ${differ.join(', ')}, so it cannot be accepted. A loop's packages are fixed; this loop has ended, and going on needs the user's \`eval confirm\` and a new loop.`));
  // A loop that ended, or one a stop holds for, is not accepted.
  const end = endGap(status);
  if (end) gaps.push(end);
  else if (status.next.action === 'repair_spec') gaps.push(gap('spec_changed', status.next.route, status.next.message, status.next.owner ?? 'agent'));
  // The user accepts only packages they confirmed: those of the accepted run
  // must be in the latest checks confirmation of this Spec export.
  const confirmation = checksConfirmation(repo, name, loop.spec);
  if (confirmation.gap) gaps.push(confirmation.gap);
  const warnings = [];
  if (run && !confirmation.gap) {
    const latest = confirmation.latest;
    const match = latest ? confirmationMatch(latest, { task_digest: run.task_digest ?? {}, packages: run.eval_snapshot?.packages ?? {}, kit: run.eval_snapshot?.kit ?? {} }, loop.spec) : null;
    if (!match?.matches) {
      const ids = Object.keys(run.task_digest ?? {}).sort();
      const what = match ? `${match.packages.map((entry) => entry.id).join(', ')} (${named(matchFiles(match))})` : `no checks confirmation of this Spec export covers ${ids.join(', ') || 'its packages'}`;
      gaps.push({ ...gap('packages_unconfirmed', 'loop-and-implement', `The eval packages of ${run.run_id} differ from the latest checks confirmation (${latest?.id ?? 'none'}): ${what}. The user accepts only packages they confirmed: they confirm these with \`eval review\` and \`eval confirm\`, which ends this loop when the packages or the plan differ from its own.`, 'user', 'business'),
        ...(match ? { cases: match.packages.map((entry) => entry.id) } : {}) });
    }
  }
  const now = codeSnapshot(repo).snapshot;
  if (run) {
    const missing = reportGaps(repo, name, run);
    if (missing.length) gaps.push(gap('report_incomplete', 'loop-and-implement', `The report for ${run.run_id} is incomplete: ${missing.join('; ')}.`));
    if (sameCode(now, run.code_snapshot, repo) !== true) {
      gaps.push(gap('code_changed', 'run-eval', `The code changed after ${run.run_id}. Run again and accept that run.`));
    }
  }
  const accepted = acceptedFile(repo, name);
  // An acceptance that no longer covers the loop, because the code changed or
  // a later run failed, can be given again for a passing run of the code now.
  if (status.accepted && !status.accepted.outdated) gaps.push(gap('already_accepted', 'loop-and-implement', `This loop was already accepted: run ${status.accepted.run_id}, in ${path.relative(repo, accepted)}.`));
  // An acceptance from an earlier loop of this change stays in the record.
  let earlier = [];
  if (existsSync(accepted)) {
    try {
      const previous = readJSON(accepted);
      earlier = [...(previous.earlier ?? []), without(previous, 'earlier')];
    } catch {
      gaps.push(gap('accepted_unreadable', 'loop-and-implement', `${path.relative(repo, accepted)} cannot be read. Restore it before recording a new acceptance; it holds an earlier one.`));
    }
  }
  if (gaps.length) throw blocked(`Cannot record acceptance: ${gaps.map((entry) => entry.message).join(' ')}`, repo, name, gaps);
  const fullRecords = new Map(readRuns(runsDirectory).map((entry) => [entry.run_id, entry]));
  // The confirmation that covers the accepted packages, the one the loop
  // started on, and every revision confirmed since the loop started.
  const entries = confirmation.entries.filter((entry) => entry?.spec?.sha256 === loop.spec);
  const covering = confirmationOf(entries, loop.spec, run.task_digest ?? {});
  const atStart = loop.checks_confirmation ? entries.find((entry) => entry.id === loop.checks_confirmation.id) ?? null : null;
  const digestsOf = (entry) => Object.fromEntries(Object.entries(entry?.packages ?? {}).map(([id, item]) => [id, item?.task_digest]));
  const chronological = [...entries].reverse();
  const revisions = chronological.flatMap((entry, index) => (Date.parse(entry.confirmed?.at) > Date.parse(loop.started_at)
    ? [{ id: entry.id, at: entry.confirmed.at, by: entry.confirmed.by ?? null, ref: entry.confirmed.ref ?? null, reason: entry.confirmed.reason ?? null,
      packages: index ? changedBetween(digestsOf(chronological[index - 1]), digestsOf(entry)) : Object.keys(entry.packages ?? {}).sort() }] : []));
  const record = {
    schema_version: '1.1', change: name, run_id: run.run_id, loop_started_at: status.loop.started_at,
    spec: run.spec_snapshot, baseline: run.baseline,
    baseline_unavailable_reason: run.baseline_unavailable_reason, commit: run.code_snapshot.commit,
    uncommitted_files: run.code_snapshot.changed_files ?? [], code_digest: run.code_snapshot.digest,
    ...(run.code_snapshot.digest_of ? { code_digest_of: run.code_snapshot.digest_of } : {}),
    checks: compare.map(({ case: id, check, intent, role, before, after, before_counts: beforeCounts, after_counts: afterCounts, verdict }) => ({
      case: id, check, intent, role, before, after, before_counts: beforeCounts ?? null, after_counts: afterCounts ?? null, verdict })),
    // The run plan of the accepted run, with the agent and the model it ran
    // with, and the attempts it made of each package.
    run_plan: { ...planOf(run), agent: run.environment_ref?.agent ?? planOf(run)?.agent ?? null, model: run.environment_ref?.model ?? null,
      attempts_by_case: run.environment_ref?.attempts_by_case ?? null },
    strength: strengthOf(run, compare),
    // In a loop that needs a final run: the accepted final run, its screen
    // run, and every full run of the loop with its role.
    final_run: status.final.needed ? run.run_id : null,
    screen_run: status.final.needed ? run.final_of ?? null : null,
    history: status.runs.map((entry) => ({ run_id: entry.run_id, role: entry.role, verdict: entry.verdict,
      code_digest: codeIdentity(fullRecords.get(entry.run_id)?.code_snapshot, repo) })),
    changed_packages: status.changed_packages,
    // The user's checks confirmation: the one covering the accepted packages,
    // the one the loop started on, the packages changed between the two, the
    // revisions confirmed during the loop, and the lines only a self-review
    // counterexample stands behind.
    checks_confirmation: covering ? { id: covering.id, at: covering.confirmed?.at ?? null, by: covering.confirmed?.by ?? null, ref: covering.confirmed?.ref ?? null,
      kind: covering.confirmed?.kind ?? null, review_origin: covering.review?.origin ?? null } : null,
    loop_confirmation: loop.checks_confirmation ?? null,
    changed_since_confirmation: atStart ? changedBetween(digestsOf(atStart), run.task_digest) : null,
    revisions,
    self_review_lines: (covering?.lines ?? []).filter((line) => line.counterexamples?.length && line.counterexamples.every((item) => item.origin === 'self-review'))
      .map((line) => ({ package: line.package, then: line.then })),
    // The lines no check verified, which the user judged.
    manual: manualOf(runsDirectory, run),
    // What was agreed and what was used stay with the acceptance, with what
    // the loop's head runs took and used.
    budget: status.loop.budget, used: status.loop.used,
    usage: status.loop.usage,
    accepted: { by: options.by.trim(), ref: options.ref.trim(), at: new Date().toISOString() },
    ...(earlier.length ? { earlier } : {}),
  };
  writeFileSync(accepted, `${JSON.stringify(record, null, 2)}\n`);
  const { budget } = status.loop;
  const position = status.runs.findIndex((entry) => entry.run_id === run.run_id) + 1;
  const late = Math.round((Date.parse(run.started_at) - Date.parse(status.loop.clock_started_at)) / 60_000);
  if (position > budget.iterations || late >= budget.minutes) {
    warnings.push(`${run.run_id} was made past the budget the user agreed to (${position > budget.iterations ? `run ${position} of ${budget.iterations}` : `started ${late} minutes into ${budget.minutes}`}). The acceptance is recorded with the budget and what was used; tell the user.`);
  }
  const ignored = ignoredArtifacts(repo, name).warning;
  if (ignored) warnings.push(ignored);
  // The code now is the accepted code; the change is committed when the commit
  // holds all of it and every file of the change, accepted.json included.
  const step = commitStep(repo, name, now, true);
  return { file: accepted, accepted: record, ...(step.commit ? { commit: step.commit } : {}), ...(step.uncommitted ? { uncommitted: step.uncommitted } : {}),
    warnings, next: `Acceptance is recorded. ${step.message}` };
}

export const hasLoop = (repo, name, spec) => readLoop(repo, name)?.spec === spec;
