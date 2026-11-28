import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { codeState, digest, genesisReview, gitStatus, ignoredArtifacts, isGenerated, readJSON, requireProject, uncommittedArtifacts } from './project.js';
import { appendDecision, readDecisions } from './records.js';
import { exportFacts } from './spec.js';
import {
  casesDigests, checksConfirmation, confirmationById, confirmationMatch, confirmationOf, confirmedDigests, digestsAt, eddDirectory, entryDigests, evalFilesChanged, evalSnapshot,
  isLive, legacyPackages, matchFiles, networkUndeclared, packagesBetween, samePackage, validateEval,
} from './eval.js';
// loop.js and run.js import each other; see the note in run.js.
import {
  acceptanceHolds, acceptedIn, activeLoop, attemptsFor, budgetLimits, budgetText, budgetUsed, codeIdentity, codeSnapshot, commitCode, confirmedPlan, connectedCase, declare,
  estimateRuns, failuresOf, finalsNeeded, ignoreRecords, isInterrupted, isLost, isTrial, judgeKey, ledgerState, ledgerText, lineProofs, liveCase, loopAccepted, loopStartCode, loopTrials, ofLoop, pinnedBase,
  pinnedStart, planOf, proofKey, readRuns, recordedBaseline, recordedLoop, sameCode, sameCodeResults, shownCost, shownMinutes, startCode, undecidedLive, unfinishedRuns,
  unfinishedWarning, unstableChecks, usableRun, usageOfRuns,
} from './run.js';

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (commit) => (commit ? commit.slice(0, 7) : 'none');
// Files named in a message: the first ten, then how many more.
const named = (files) => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));
const joined = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join(''));
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// A refusal or an open point: what is wrong (code, message), the layer it is
// in (spec, package, kit, confirmation, baseline, loop, ledger, machine or
// code) and whose work or decision it is (owner). Facts ride along.
const gap = (code, layer, message, owner = 'agent', kind = 'artifact', facts = {}) => ({ code, kind, owner, layer, message, ...facts });

// Who can record a final review: a reviewer in a context of its own, a
// person, a Genesis review, or the agent that changed the code itself.
export const REVIEWERS = ['subagent', 'human', 'genesis', 'self'];

// A run passes only on gating checks. When the user judges every THEN line
// of the change, no run can pass and no loop has anything to make pass.
const allManual = (evals) => {
  const lines = evals.coverage?.lines;
  return Boolean(lines?.total) && lines.manual === lines.total;
};
const NO_GATING = 'No package of this change has a gating check: every THEN line is in scenario.manual, for the user to judge. A run passes only on gating checks, so no run of this change can pass and no loop on it can be accepted.';
// What an acceptance in the light tier rests on.
const LIGHT_STRENGTH = 'Light tier: the packages ran with the network sealed, no model was called, and each check ran once. That shows only that code whose result is fixed holds in these scenarios.';
// A loop allows one failed final run; the second one stops it.
const FAILED_FINALS_STOP = 2;

function blocked(message, gaps) {
  return Object.assign(new Error(message), { code: 'LOOP_INPUT_BLOCKED', gaps });
}

// What the history of the change adds to the strength of a pass: every final
// run of the change, over all its loops, and how many failed, and the
// attempts on the accepted code that left a gating check unknown.
const historyText = ({ finals = null, unknown = null } = {}) => [
  ...(finals?.total ? [`This change made ${plural(finals.total, 'final run')} over its loops, and ${finals.failed} of them failed${finals.unverified ? `; ${finals.unverified} left evidence missing` : ''}.`] : []),
  ...(unknown?.unknown ? [`On the accepted code, ${unknown.unknown} of ${plural(unknown.attempts, 'attempt')} left a gating check unknown.`] : []),
].join(' ');

// How strongly a passing run rests on its attempts, from a fixed formula: k is
// the fewest attempts with evidence among the gating checks of packages with
// a live dependency, and a check that fails with chance p passes all k with
// chance (1 - p)^k, shown for p = 1/2 and p = 1/10. Packages without a live
// dependency ran once and are left out, except under a plan written before
// run plans, where every package ran the plan's number. No model is asked.
// In the light tier the sentence is fixed: what it ran under, and what that
// shows. history, when given, is { finals, unknown } of the change: its final
// runs over every loop and the unknown attempts on the run's code, which the
// sentence then counts too.
// The strength statement with the lines whose weaker or stronger checks the
// user accepted when confirming them, each named.
export function withAcceptedVerdicts(strength, accepted) {
  const lines = Array.isArray(accepted) ? accepted.filter((entry) => entry && entry.package && entry.then) : [];
  if (!strength || !lines.length) return strength;
  const weaker = lines.filter((entry) => entry.verdict === 'weaker');
  const stronger = lines.filter((entry) => entry.verdict === 'stronger');
  const named = (list) => list.map((entry) => `"${entry.then}" (${entry.package})`).join(', ');
  const parts = [
    ...(weaker.length ? [`the checks of ${named(weaker)} ask less than the line says, so a pass there does not show the whole line holds`] : []),
    ...(stronger.length ? [`the checks of ${named(stronger)} ask more than the line says, so a failure there may not mean the line fails`] : []),
  ];
  return { ...strength, sentence: `${strength.sentence} The user accepted, when confirming the checks: ${parts.join('; ')}.`, accepted_verdicts: lines };
}

export function strengthOf(run, compare, tier = 'full', history = null) {
  const core = (() => {
    if (tier === 'light') return { attempts: null, pass_all_chance: null, single_sample: false, sentence: LIGHT_STRENGTH };
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
  })();
  if (!history) return core;
  const extra = historyText(history);
  return { ...core, finals_of_change: history.finals ? { total: history.finals.total, failed: history.finals.failed, unverified: history.finals.unverified } : null,
    unknown_attempts: history.unknown ? { attempts: history.unknown.attempts, unknown: history.unknown.unknown } : null,
    sentence: extra ? `${core.sentence} ${extra}` : core.sentence };
}

// The codes of the gap an ended loop is refused with: loop_ended when a fixed
// input changed or a decision was recorded, and the stop otherwise. A loop
// that ended stays so: run start refuses its head runs, and loop accept
// refuses it.
export const END_ACTIONS = ['loop_ended', 'stop_budget', 'stop_stuck', 'stop_unstable', 'stop_incomplete', 'stop_no_gating'];
// Where a loop stands that would lead to another head run. A stop that holds
// ends the loop in its place.
const HEAD_RUN_SITUATIONS = ['open', 'code_moved', 'run_not_settled', 'final_run_due', 'execution_incomplete', 'regression', 'screen_burned', 'eval_blocked', 'final_failed'];

// The layer and the owner of each end. A missing baseline is the agent's to
// record again, and a package edit the agent's to undo or to bring to the
// user; every other end needs the user: a new loop, a new budget or a new
// confirmation is theirs.
const END_OWNERS = {
  spec_exported: ['spec', 'user'], baseline_missing: ['baseline', 'agent'], confirmation_changed: ['confirmation', 'user'], packages_changed: ['package', 'agent'],
  tier_changed: ['confirmation', 'user'], stop_unstable: ['code', 'user'], stop_incomplete: ['loop', 'user'], stop_no_gating: ['package', 'user'],
  stop_stuck: ['code', 'user'], stop_budget: ['loop', 'user'], loop_end: ['loop', 'user'], loop_decline: ['loop', 'user'], change_abandon: ['loop', 'user'],
  loop_record_missing: ['ledger', 'user'],
};

// Where a loop stands, from its loop status: done (the user's acceptance
// covers it), ended (a fixed input changed, a stop holds, or an end was
// recorded), closing (the budget is used up, and only the final review and the
// acceptance of a passing run are left: no head run), or live.
export function loopPhase(status) {
  if (status.phase) return status.phase;
  if (status.situation?.code === 'accepted') return 'done';
  if (status.ended) return 'ended';
  if (status.stop || status.loop?.exhausted) return 'closing';
  return 'live';
}

// The gap of an end, as loop accept and run start refuse with it.
function endedGap(ended) {
  const [layer, owner] = END_OWNERS[ended.reason] ?? ['loop', 'user'];
  const { message, kind: endKind, ...facts } = ended;
  return { code: ended.reason.startsWith('stop_') ? ended.reason : 'loop_ended', kind: 'business', owner, layer, ...facts, end: endKind ?? null,
    message: `${message} A loop that ended takes no head run and no acceptance.` };
}

// The gap loop accept refuses an ended loop with, or null.
export function endGap(status) {
  if (loopPhase(status) === 'done') return null;
  if (status.ended) return endedGap(status.ended);
  return null;
}

// The gap run start refuses a head run of a loop with: endGap's, or, once the
// budget is used up, stop_budget. Once the user accepted the loop, head runs
// go on as before. Null otherwise.
export function headRunGap(status) {
  if (loopPhase(status) === 'done') return null;
  const end = endGap(status);
  if (end) return end;
  if (!status.loop.exhausted) return null;
  const { used, budget } = status.loop;
  return gap('stop_budget', 'loop', `The budget of this loop is used up (${budgetText(budget, used)}), so no head run or trial is made in it. A passing run of it can still be reviewed and accepted.`, 'user', 'business', {
    reason: 'budget_used_up', budget, used, consents: [{ decision: 'budget', by: 'user', command: ['loop', 'budget', status.change] }, { decision: 'new_loop', by: 'user', command: ['loop', 'start', status.change] }] });
}

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
const START_PATCH = 'loop-start.patch';

// loop.json is replaced when a new loop starts; it keeps the loops before it
// under previous.
function saveLoop(repo, name, loop) {
  const file = loopFile(repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(loop, null, 2)}\n`);
}

const readLoop = (repo, name) => (existsSync(loopFile(repo, name)) ? readJSON(loopFile(repo, name)) : null);

// The loop of loop.json, or null when it is missing or cannot be read.
const readLoopSafe = (repo, name) => {
  try {
    const loop = readLoop(repo, name);
    return isRecord(loop) ? loop : null;
  } catch { return null; }
};

// The budget of a loop: the flags given, and otherwise the fallback, such as
// the budget the user confirmed with the checks. A budget counts full runs
// and run minutes, the Docker time of the runs; --max-minutes gives run
// minutes. A confirmed budget recorded before run minutes counts the minutes
// since the loop started instead, and its flags keep that measure. A cost cap
// counts the cost the adapter reports.
function budgetOptions(options, fallback = { iterations: 5, minutes: null, run_minutes: 60 }) {
  const iterations = options.iterations ?? fallback.iterations;
  const clock = typeof fallback.minutes === 'number';
  const minutes = options.minutes ?? (clock ? fallback.minutes : fallback.run_minutes);
  const cost = options.maxCost ?? fallback.max_cost_usd;
  if (!Number.isInteger(iterations) || iterations < 1 || !(minutes > 0)) throw new Error('--max-iterations is a whole number of 1 or more and --max-minutes a number above 0.');
  if (cost !== undefined && cost !== null && !(cost > 0)) throw new Error('--max-cost is an amount in US dollars above 0.');
  return { iterations, ...(clock ? { minutes } : { minutes: null, run_minutes: minutes }), ...(typeof cost === 'number' ? { max_cost_usd: cost } : {}) };
}

// The minutes a budget allows, in its own measure.
const minutesOf = (budget) => (typeof budget.run_minutes === 'number' ? budget.run_minutes : budget.minutes);
// The cost cap of a budget, or no cap.
const capOf = (budget) => (typeof budget?.max_cost_usd === 'number' ? budget.max_cost_usd : Infinity);
// Whether a budget allows more than another, in any of its limits.
const exceeds = (budget, than) => budget.iterations > than.iterations || minutesOf(budget) > minutesOf(than) || capOf(budget) > capOf(than);

const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));

// The head runs of one loop that carry results: its Spec, from its start,
// made while it was the loop of loop.json (ofLoop), with a run record that
// can be read. Full runs count toward the budget and can be accepted;
// partial ones are a quick look.
const loopRuns = (all, loop) => all.filter((run) => ofLoop(run, loop) && usableRun(run));
const fullRuns = (runs) => runs.filter((run) => (run.scope ?? 'full') === 'full');
const byStart = (a, b) => `${a.started_at}${a.run_id}`.localeCompare(`${b.started_at}${b.run_id}`);

// Everything the budget of a loop counts: its head runs, the trials made
// while it ran (loopTrials), and its runs that the run index holds but whose
// record is lost or that were interrupted. A lost run spends what its index
// entry recorded.
function loopSpend(all, loop) {
  const seen = new Set();
  return [...all.filter((run) => ofLoop(run, loop)), ...loopTrials(all, loop),
    ...all.filter((run) => (isLost(run) || isInterrupted(run)) && (run.side === 'head' || isTrial(run)) && run.loop?.started_at === loop.started_at)]
    .filter((run) => !seen.has(run.run_id) && seen.add(run.run_id)).sort(byStart);
}

// What runs took and used, a lost run by the minutes its index entry kept.
const spendUsage = (runsDirectory, runs) => usageOfRuns(runsDirectory, runs.map((run) => (isLost(run) && !isRecord(run.usage)
  ? { ...run, usage: { minutes: typeof run.minutes === 'number' ? run.minutes : null, attempts: 0, reported: 0 } } : run)));

// The start code of a loop as data: its commit and, when the commit does not
// hold all of it, the patch beside loop.json that holds the rest.
const startFacts = (name, start) => (start ? { commit: start.commit ?? null, digest: start.digest ?? null,
  patch: start.patch ? `.genesis/edd/${name}/${start.patch}` : null, uncommitted_files: start.uncommitted_files ?? [] } : null);
const startText = (name, start) => {
  const facts = startFacts(name, start);
  if (!facts) return 'unknown';
  return `${facts.commit ? `commit ${short(facts.commit)}` : 'no commit'}${facts.patch ? ` plus ${facts.patch}` : ''}`;
};

// Whether the Map the Spec was written against is the Map of a change review,
// which covers only what that review analyzed.
const partialMap = (map) => Boolean(map) && (map.mode === 'change' || map.coverage_scope === 'partial' || map.partial === true || map.coverage?.partial === true);
const LIMITED_SCOPE = 'The Spec was written against the Map of a Genesis change review, so a Genesis review from it covers only the flows that review analyzed, not the whole project.';

// What a Genesis review from the Spec's Map covers: the whole project
// (project), only the flows a Genesis change review analyzed (change_review,
// scope_limited), or unknown. offered is what genesisReview returns, or null
// when no Genesis review can start from the Map. Null when the Spec has no Map.
function mapScope(map, offered) {
  if (!map && !offered) return null;
  if (offered?.scope_limited === true || partialMap(map)) {
    return { scope: 'change_review', scope_limited: true, scope_note: (offered?.scope_limited === true && offered.scope_note) || LIMITED_SCOPE };
  }
  return { scope: offered?.scope ?? (map?.mode === 'map' ? 'project' : 'unknown'), scope_limited: false, ...(offered?.scope_note ? { scope_note: offered.scope_note } : {}) };
}

const commitExists = (repo, commit) => spawnSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`], { encoding: 'utf8' }).status === 0;

// The run index: a loop does not start, and is not accepted, while the
// ledger of this change cannot show every run it holds. { gap, note }: note
// states what else the ledger shows, such as lost or altered runs.
function ledgerCheck(repo, name) {
  const state = ledgerState(path.join(eddDirectory(repo, name), 'runs'));
  const note = state ? ledgerText(state) : null;
  if (!state?.index_missing) return { gap: null, note };
  return { note, gap: gap('ledger_index_missing', 'ledger', `The run index .genesis/edd/${name}/runs/index.jsonl is missing, so a run whose folder was removed could not be counted. How to go on is the user's decision.`,
    'user', 'business', { path: `.genesis/edd/${name}/runs/index.jsonl`, unindexed: state.unindexed ?? [], altered: state.altered ?? [] }) };
}

// The user's acceptance of the loop running for this Spec, while it still
// covers the loop (loop status says done), or null. Read-only.
export function loopAcceptance(repo, name, spec) {
  const loop = readLoopSafe(repo, name);
  if (!loop || loop.spec !== spec || !existsSync(acceptedFile(repo, name))) return null;
  let record = null;
  try { record = readJSON(acceptedFile(repo, name)); } catch { return null; }
  if (!acceptedIn(record, loop, fullRuns(loopRuns(readRuns(path.join(eddDirectory(repo, name), 'runs')), loop)))) return null;
  return loopPhase(loopStatus(repo, name)) === 'done' ? record : null;
}

// Why a loop does not start on a baseline that did not behave as declared.
export const mismatchMessage = (base) => `The baseline ${base.run_id} did not behave as declared: ${base.baseline_mismatch
  .map((entry) => `${entry.case}/${entry.check} was expected to ${entry.expected} and got ${entry.got}`).join('; ')}. A loop does not start on it: either the expectation in baseline-expectations.json is wrong, or the code it ran on is not the code before the change. What that code does, when it is unclear, is the user's to say.`;

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
    if (ran.has(id)) return !item ? [`${id} is gone`] : !samePackage(digestsAt(base, id), { task: item.task_digest ?? null, run: item.run_digest ?? null }) ? [`${id} changed since`] : [];
    return item.integration?.state === 'ready' || unchecked.includes(id) ? [`${id} did not run in it`] : [];
  });
  const prove = unchecked.length ? ` A run skips ${unchecked.join(', ')} until \`eval check\` proves ${unchecked.length === 1 ? 'its verifier for it' : 'their verifiers for them'} as ${unchecked.length === 1 ? 'it is' : 'they are'}.` : '';
  return parts.length ? gap('baseline_packages_differ', 'baseline', `The baseline ${base.run_id} ran other eval packages than the ones now: ${parts.join('; ')}. Every run of a loop is compared with its baseline, so it must have run these packages.${prove}`,
    'agent', 'artifact', { run: base.run_id, unchecked }) : null;
}

// A finished package that waits only for `eval check`: a run skips it until
// its verifier is proved for it as it is. An invalid one, which eval check
// refuses, waits for its package to be fixed instead.
export const waitsForCheck = (item) => !item.errors?.length && item.integration?.state !== 'ready' && Array.isArray(item.integration?.missing)
  && item.integration.missing.length > 0 && item.integration.missing.every((entry) => entry === 'check');

// A loop does not start on a baseline that fixed no number of attempts while
// a package declares a live dependency: it could not run that package the
// user's number of times. The confirmation fixes the number and the baseline
// reads it. confirmation is the one that covers the packages as they are, or
// null.
const startUndecided = (base, ids, confirmation) => {
  const n = confirmation?.run_plan?.attempts;
  return gap('attempts_undecided', 'confirmation',
    `${declare(ids)} a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so a loop on that baseline could not run ${ids.length === 1 ? 'it' : 'them'} the user's number of times. That number is the user's decision${Number.isInteger(n)
      ? `; they confirmed ${plural(n, 'attempt')} in confirmed.json, which a baseline recorded now reads` : ', and no checks confirmation records it yet'}.`,
    'user', 'business', { run: base.run_id, cases: ids, confirmed_attempts: Number.isInteger(n) ? n : null });
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
// a confirmation, or null.
export function baselinePlanDiffers(evals, base, confirmation, { undecided = false } = {}) {
  if (!base || !confirmation) return null;
  const diffs = planDiffs(evals, base, confirmation, undecided);
  return diffs.length ? gap('baseline_plan_differs', 'baseline', `The baseline ${base.run_id} ${base.is_baseline ? 'ran' : 'records that nothing could run, and a loop on it runs'} with ${diffs.map((entry) => entry.text).join(', ')} but the user confirmed ${confirmedPlan(confirmation.run_plan ?? {})} (${confirmation.confirmed?.at ?? 'no date'}). A baseline reads the confirmed plan from confirmed.json.`,
    'agent', 'artifact', { run: base.run_id, differs: diffs.map((entry) => entry.key), confirmation: confirmation.id ?? null }) : null;
}

// What the user's checks confirmation says about a loop that would start on
// base: { gaps, warnings, confirmation }. A loop starts only on the packages
// the user confirmed for this Spec export, and on a baseline that ran the plan
// they confirmed. confirmation is the confirmation that covers the packages as
// they are, or null. A baseline recorded as unavailable ran no plan, but every
// head run of a loop on it takes the plan it keeps.
function confirmationGaps(repo, name, evals, base, undecided) {
  const state = checksConfirmation(repo, name, evals.spec);
  if (state.gap) return { gaps: [state.gap], warnings: [], confirmation: null, latest: null };
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
      warnings.push(`The baseline ${base.run_id} ran with other expected results than the user confirmed: ${differ.map((entry) => `${entry.case}/${entry.check} ${entry.expected ?? 'any'} there, ${confirmed.get(key(entry)) ?? 'any'} confirmed`).join(', ')}.`);
    }
  }
  return { gaps, warnings, confirmation, latest: state.latest };
}

// Until a loop of this change is accepted or the user abandons the change,
// every new loop keeps the start code of the change's first unaccepted loop,
// pin (pinnedStart), and starts only on a base record of that code: that
// loop's own baseline, or a newer one that ran there, one that records that
// nothing could run included. The gap that says it ran elsewhere, or null.
function offStart(repo, name, base, pin) {
  if (base.run_id === pin.loop.baseline || sameCode(base.code_snapshot, pin.start, repo) === true) return null;
  return gap('baseline_not_at_start', 'baseline', `Until a loop of this change is accepted or the user abandons the change, every new loop keeps the start code of the change's first unaccepted loop (${startText(name, pin.start)}). The baseline ${base.run_id} ran on other code, so a new loop needs a base record of the start code, which can be rebuilt outside the project (--at-start).`,
    'agent', 'artifact', { run: base.run_id, start_code: startFacts(name, pin.start) });
}

// Whether the code a base record ran on can be rebuilt, as a loop pins it for
// its start code: a content digest to compare with, its commit in this
// repository, and the files that commit does not hold in the record's
// code.patch. The gap that says what is missing, or null.
function baselineCodeGap(repo, name, base) {
  const snapshot = base.code_snapshot ?? {};
  const facts = { run: base.run_id, commit: snapshot.commit ?? null };
  if (!codeIdentity(snapshot, repo)) {
    return gap('start_code_unknown', 'baseline', `The baseline ${base.run_id} records its code without a content digest, so a loop cannot pin its start code to it.`, 'agent', 'artifact', facts);
  }
  if (snapshot.commit && !commitExists(repo, snapshot.commit)) {
    return gap('start_code_unrecoverable', 'baseline', `Commit ${snapshot.commit} of the baseline ${base.run_id} is not in this repository, so the code the baseline ran on cannot be rebuilt.`, 'agent', 'artifact', facts);
  }
  const patch = snapshot.patch ? `.genesis/edd/${name}/runs/${base.run_id}/${snapshot.patch}` : null;
  if (patch && !existsSync(path.join(eddDirectory(repo, name), 'runs', base.run_id, snapshot.patch))) {
    return gap('start_code_unrecoverable', 'baseline', `${patch} is gone, and it holds the files ${snapshot.commit ? `commit ${short(snapshot.commit)}` : 'the empty project'} does not, so the code the baseline ${base.run_id} ran on cannot be rebuilt.`, 'agent', 'artifact', { ...facts, path: patch });
  }
  if (!patch && snapshot.changed_files?.length && sameCode(commitCode(repo, snapshot.commit ?? null), snapshot, repo) !== true) {
    return gap('start_code_unrecoverable', 'baseline', `The baseline ${base.run_id} ran on files its commit does not hold, and no code.patch of them was written, so the code it ran on cannot be rebuilt.`, 'agent', 'artifact', { ...facts, files: snapshot.changed_files });
  }
  return null;
}

// Whether the pinned start code of the change can still be rebuilt: its commit
// is in the repository, and the patch beside loop.json, or the baseline's own
// code.patch of the same code, holds the files that commit does not.
function pinnedCodeGap(repo, name, pin, base) {
  const start = pin.start;
  if (start.commit && !commitExists(repo, start.commit)) {
    return gap('start_code_unrecoverable', 'baseline', `Commit ${start.commit} of the pinned start code is not in this repository, so that code cannot be rebuilt.`, 'agent', 'artifact', { start_code: startFacts(name, start) });
  }
  if (start.patch && !existsSync(path.join(eddDirectory(repo, name), start.patch)) && !baselinePatchOf(repo, name, base, start)) {
    return gap('start_code_unrecoverable', 'baseline', `.genesis/edd/${name}/${start.patch} is gone, and it holds the files of the pinned start code that commit ${short(start.commit)} does not; no baseline of that code keeps them either.`,
      'agent', 'artifact', { start_code: startFacts(name, start), path: `.genesis/edd/${name}/${start.patch}` });
  }
  return null;
}

// The code.patch of a base record of the start code, as a file path, or null.
const baselinePatchOf = (repo, name, base, start) => {
  if (!base?.code_snapshot?.patch || sameCode(base.code_snapshot, start, repo) !== true) return null;
  const file = path.join(eddDirectory(repo, name), 'runs', base.run_id, base.code_snapshot.patch);
  return existsSync(file) ? file : null;
};

// The gating checks of a comparison, as `<case>\n<check>`.
const gatingKeys = (compare) => new Set(compare.filter((entry) => entry.role === 'gating').map((entry) => `${entry.case}\n${entry.check}`));

// What the loop needs before it may change code. Read-only. While a loop runs
// for the Spec, its baseline is the one it pinned; latest asks for the
// baseline a new loop would pin instead, as loop start does. pin is the start
// code a new loop keeps (pinnedStart), or null. A loop starts on the code its
// baseline ran on, whatever the working directory holds now: the start code
// is the baseline's, and it must be possible to rebuild it.
export function loopInputs(repo, name, { latest = false } = {}) {
  const evals = validateEval(repo, name);
  // Packages still waiting for a connection are expected in a project with no
  // implementation yet: building that connection is part of the loop.
  const gaps = evals.gaps.filter((entry) => entry.code !== 'integration_pending');
  let loop = !latest && evals.spec ? activeLoop(repo, name, evals.spec) : null;
  const pinnedRun = (entry) => {
    const run = pinnedBase(repo, name, entry).run;
    return run && !isLost(run) ? run : null;
  };
  // A loop whose baseline is gone has ended (baseline_missing). Once a
  // baseline of this Spec export is recorded again on its start code, what
  // is asked is what a new loop needs, as \`loop start\` asks it.
  if (loop && !pinnedRun(loop)) {
    const again = recordedBaseline(repo, name, evals.spec);
    const start = loopStartCode(repo, name, loop);
    if (again && start?.digest && sameCode(again.code_snapshot, start, repo) === true) loop = null;
  }
  const code = codeState(repo);
  const warnings = [];
  let confirmation = null;
  let latestConfirmation = null;
  let pin = null;
  let base = null;
  if (loop) {
    base = pinnedRun(loop);
    if (!base) {
      gaps.push(gap('loop_baseline_missing', 'baseline', `The loop for this Spec export compares every run with ${loop.baseline}, which runs/ no longer holds, so the loop has ended (baseline_missing).`,
        'agent', 'artifact', { baseline: loop.baseline, start_code: startFacts(name, loopStartCode(repo, name, loop)) }));
    }
  } else if (evals.spec) {
    pin = pinnedStart(repo, name);
    let undecidedIds = [];
    base = recordedBaseline(repo, name, evals.spec);
    if (base && isLost(base)) base = null;
    if (!base) gaps.push(gap('baseline_missing', 'baseline', 'No baseline of this Spec export is recorded.', 'agent'));
    // A baseline that contradicts what was declared before it ran is no
    // reference for a loop: every comparison would rest on it.
    else if (base.baseline_mismatch?.length) gaps.push(gap('baseline_mismatch', 'baseline', mismatchMessage(base), 'agent', 'artifact', { run: base.run_id, mismatch: base.baseline_mismatch }));
    else {
      const differ = baselinePackagesDiffer(base, evals.cases);
      if (differ) gaps.push(differ);
      // A package that declares a live dependency after a baseline that fixed
      // no number of attempts cannot run in a loop on it: the number is the user's.
      undecidedIds = undecidedLive(base, evals.cases.filter((item) => item.integration?.state === 'ready'));
      if (undecidedIds.length) gaps.push(startUndecided(base, undecidedIds, checksConfirmation(repo, name, evals.spec).current));
      // Until a loop of this change is accepted, a new loop keeps the start
      // code of the first unaccepted one; otherwise its start code is the
      // code its baseline ran on. Either must be possible to rebuild.
      const elsewhere = pin ? offStart(repo, name, base, pin) : null;
      if (elsewhere) gaps.push(elsewhere);
      const unrecoverable = pin ? pinnedCodeGap(repo, name, pin, base) : baselineCodeGap(repo, name, base);
      if (unrecoverable) gaps.push(unrecoverable);
    }
    // A loop starts only on the user's confirmation of the packages as they are.
    const confirmed = confirmationGaps(repo, name, evals, base, undecidedIds.length > 0);
    gaps.push(...confirmed.gaps);
    warnings.push(...confirmed.warnings);
    confirmation = confirmed.confirmation;
    latestConfirmation = confirmed.latest;
    // A light-tier confirmation stands for a new loop only while the change
    // qualifies for the light tier, which this machine's runs can show it no
    // longer does, and, in an existing project, only on a baseline that ran:
    // a line the change fixes is proved by its failure there.
    if (confirmation?.run_plan?.tier === 'light') {
      if (!evals.tier?.eligible) {
        gaps.push(gap('tier_light_unfit', 'confirmation', `The user confirmed the light tier, but the change no longer qualifies for it: ${(evals.tier?.reasons ?? []).map((entry) => entry.message).join(' ')} The light tier holds only for results that do not vary; the tier a new loop runs in is the user's confirmation.`,
          'user', 'business', { reasons: evals.tier?.reasons ?? [] }));
      }
      if (base && !base.is_baseline && requireProject(repo).mode === 'existing') {
        gaps.push(gap('light_baseline_required', 'baseline', `The baseline ${base.run_id} records that nothing could run, but the user confirmed the light tier, where a line the change fixes is proved by its real failure before the change. In an existing project a light-tier loop starts only on a baseline that ran.`,
          'agent', 'artifact', { run: base.run_id }));
      }
    }
  }
  // A loop starts only on packages that name the line each check verifies.
  const legacy = legacyPackages(evals);
  if (!loop && legacy.length) {
    const one = legacy.length === 1;
    gaps.push(gap('then_unbound', 'package', `${legacy.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0, whose checks do not name the THEN lines they verify, so a loop does not start on ${one ? 'it' : 'them'}. A baseline that ran on the old packages compares nothing with upgraded ones.`,
      'agent', 'artifact', { cases: legacy }));
  }
  // Nor on a change no run can pass.
  if (!loop && allManual(evals)) gaps.push(gap('gating_missing', 'package', `${NO_GATING} A loop does not start on it.`, 'user', 'business'));
  if (code.changed === null) {
    gaps.push(gap('git_missing', 'machine', 'Every run records its code as a commit plus a patch, which needs Git, and this project is not a Git repository.', 'user', 'technical'));
  }
  return { evals, base, code, gaps, warnings, confirmation, latest_confirmation: latestConfirmation, pin, loop };
}

// Minutes kept to a tenth and money to a millionth, as run records keep them.
const tenths = (value) => Math.round(value * 10) / 10;
const money = (value) => Number(value.toFixed(6));
const sumKnown = (values, round) => {
  const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return known.length ? round(known.reduce((total, value) => total + value, 0)) : null;
};

// The head runs and trials of a Spec export made outside every loop of chain,
// before until when given: how many, what they took and cost, and which
// failed. A run whose record is lost counts as failed. Read-only.
function outsideRuns(repo, name, spec, all, chain, until = null) {
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const inLoop = (run) => chain.some((entry) => run.loop?.started_at === entry.started_at || ofLoop(run, entry));
  const runs = all.filter((run) => (run.side === 'head' || isTrial(run)) && run.spec_snapshot?.sha256 === spec && !run.loop?.started_at && !inLoop(run)
    && (until === null || run.started_at < until));
  const usage = spendUsage(runsDirectory, runs);
  const failed = runs.filter((run) => run.verdict === 'fail' || isLost(run));
  return { runs: runs.length, head_runs: runs.filter((run) => run.side === 'head').map((run) => run.run_id), trials: runs.filter(isTrial).map((run) => run.run_id),
    minutes: usage.minutes, cost_usd: usage.cost_usd, failures: failed.length, failed_runs: failed.map((run) => run.run_id),
    passed: runs.filter((run) => run.verdict === 'pass').map((run) => run.run_id), lost: runs.filter(isLost).map((run) => run.run_id) };
}

// What the earlier loops of this change used: each loop of chain (loop
// entries, oldest first), with the full head runs of its Spec export from its
// start until the next loop started, the trials made in it, its runs whose
// record is lost, and whether the user accepted it; and the head runs and
// trials of spec made outside every loop. minutes are those its budget
// counted: from its budget clock until the next loop started, or until the
// user's acceptance of it; run_minutes what its runs took, and cost_usd what
// they cost. Read-only.
function earlierLoops(repo, name, chain, spec, all = null) {
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const runs = all ?? readRuns(runsDirectory);
  let record = null;
  try { record = chain.length && existsSync(acceptedFile(repo, name)) ? readJSON(acceptedFile(repo, name)) : null; } catch { /* loop status says why */ }
  const records = record ? [...(Array.isArray(record.earlier) ? record.earlier : []), without(record, 'earlier')] : [];
  const now = new Date().toISOString();
  const loops = chain.map((entry, index) => {
    const until = chain[index + 1]?.started_at ?? null;
    const before = (run) => until === null || run.started_at < until;
    const heads = loopRuns(runs, entry).filter(before);
    const full = fullRuns(heads);
    const spent = loopSpend(runs, entry).filter(before);
    const usage = spendUsage(runsDirectory, spent);
    const acceptance = records.find((item) => acceptedIn(item, entry, full)) ?? null;
    const stops = [until ?? now, acceptance?.accepted?.at].map((at) => Date.parse(at)).filter(Number.isFinite);
    const clock = Date.parse(entry.clock_started_at ?? entry.started_at);
    const minutes = Number.isFinite(clock) && stops.length ? Math.max(0, Math.round((Math.min(...stops) - clock) / 60_000)) : null;
    return { started_at: entry.started_at, spec: entry.spec, accepted: Boolean(acceptance), iterations: full.length,
      minutes, run_minutes: usage.minutes, cost_usd: usage.cost_usd, budget: entry.budget ?? null,
      trials: loopTrials(runs, entry).filter(before).map((run) => run.run_id), lost: spent.filter(isLost).map((run) => run.run_id),
      ended: entry.closed?.kind ?? null };
  });
  const outside = spec ? outsideRuns(repo, name, spec, runs, chain) : null;
  return { loops, outside,
    total: { loops: loops.length, iterations: loops.reduce((total, entry) => total + entry.iterations, 0),
      minutes: sumKnown(loops.map((entry) => entry.minutes), tenths),
      run_minutes: sumKnown([...loops.map((entry) => entry.run_minutes), outside?.minutes ?? null], tenths),
      cost_usd: sumKnown([...loops.map((entry) => entry.cost_usd), outside?.cost_usd ?? null], money),
      outside_runs: outside?.runs ?? 0, trials: loops.reduce((total, entry) => total + entry.trials.length, 0) + (outside?.trials.length ?? 0) } };
}

// Decisions of the change that belong to a loop: those that name its start.
const decisionsOf = (decisions, type, loop) => decisions.filter((entry) => entry.type === type && entry.loop_started_at === loop.started_at);
const decisionFacts = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !['type', 'loop_started_at'].includes(key)));

// The records of a loop: those loop.json keeps, and those decisions.jsonl
// keeps for it, which stay when loop.json is replaced. reviews, disputes
// (each with the user's ruling, or null), the project's own test results
// recorded since the loop started, and the revisions of its budget.
function loopRecords(loop, decisions) {
  const byId = (kept, logged) => {
    const found = new Map();
    for (const entry of [...logged, ...kept]) if (entry?.id) found.set(entry.id, { ...(found.get(entry.id) ?? {}), ...entry });
    return [...found.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  };
  const reviews = byId(Array.isArray(loop.reviews) ? loop.reviews : [], decisionsOf(decisions, 'loop_review', loop).map(decisionFacts));
  const rulings = decisionsOf(decisions, 'dispute_ruling', loop);
  const disputes = byId(Array.isArray(loop.disputes) ? loop.disputes : [], decisionsOf(decisions, 'loop_dispute', loop).map(decisionFacts)).map((entry) => {
    const ruled = rulings.find((item) => item.id === entry.id);
    return { ...entry, ruling: entry.ruling ?? (ruled ? { ruling: ruled.ruling, by: ruled.by ?? null, ref: ruled.ref ?? null, at: ruled.at } : null) };
  });
  const seen = new Set();
  const since = Date.parse(loop.started_at);
  const tests = [...(Array.isArray(loop.tests) ? loop.tests : []), ...decisions.filter((entry) => entry.type === 'loop_tests' && Date.parse(entry.at) >= since).map(decisionFacts)]
    .filter((entry) => {
      const key = `${entry.at}\n${entry.command}`;
      return !seen.has(key) && seen.add(key);
    }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const revisions = Array.isArray(loop.budget_revisions) ? loop.budget_revisions : decisionsOf(decisions, 'loop_budget', loop).map(decisionFacts);
  return { reviews, disputes, tests, revisions };
}

// The end of a loop that was recorded: by `loop end`, `loop decline` or
// `change abandon` while it ran. { reason, at, by, ref, text }, or null.
function recordedEnd(loop, decisions) {
  if (isRecord(loop.closed)) {
    return { reason: loop.closed.kind, at: loop.closed.at ?? null, by: loop.closed.by ?? null, ref: loop.closed.ref ?? null, text: loop.closed.reason ?? null,
      ended_by: loop.closed.ended_by ?? (loop.closed.by ? 'user' : 'agent') };
  }
  const entry = decisions.find((item) => ['loop_end', 'loop_decline', 'change_abandon'].includes(item.type) && item.ends_loop === loop.started_at);
  return entry ? { reason: entry.type, at: entry.at, by: entry.by ?? null, ref: entry.ref ?? null, text: entry.reason ?? null, ended_by: entry.ended_by ?? (entry.by ? 'user' : 'agent') } : null;
}

// The final runs of the change over all its loops and Spec exports, and how
// many failed (a lost one counts as failed) or left evidence missing.
function finalsOfChange(repo, all) {
  const finals = all.filter((run) => run.side === 'head' && run.role === 'final');
  return { total: finals.length, failed: finals.filter((run) => run.verdict === 'fail' || isLost(run)).length,
    unverified: finals.filter((run) => run.verdict === 'unverified').length,
    runs: finals.map((run) => ({ run_id: run.run_id, loop_started_at: run.loop?.started_at ?? null, spec: run.spec_snapshot?.sha256 ?? null, verdict: run.verdict,
      ...(isLost(run) ? { lost: true } : {}), code_digest: codeIdentity(run.code_snapshot, repo) })) };
}

// The attempts of every run of the change on one code, and those that left a
// gating check unknown or did not complete. gating is a Set of
// `<case>\n<check>`. A run recorded before attempts.json existed counts as
// one attempt of each package. { attempts, unknown, runs }.
function unknownAttempts(repo, runsDirectory, all, code, gating) {
  const found = { attempts: 0, unknown: 0, runs: [] };
  if (!code) return found;
  const runs = new Set();
  for (const run of all) {
    if (isLost(run) || codeIdentity(run.code_snapshot, repo) !== code) continue;
    for (const item of run.cases ?? []) {
      const checks = [...gating].filter((key) => key.startsWith(`${item.id}\n`)).map((key) => key.slice(item.id.length + 1));
      const folder = path.join(runsDirectory, run.run_id, item.id);
      let list = null;
      try { list = readJSON(path.join(folder, 'attempts.json')).attempts; } catch { /* an older record */ }
      if (Array.isArray(list)) {
        for (const attempt of list) {
          found.attempts += 1;
          const results = isRecord(attempt?.results) ? attempt.results : {};
          if (attempt?.status !== 'completed' || checks.some((check) => (results[check] ?? 'unknown') === 'unknown')) {
            found.unknown += 1;
            runs.add(run.run_id);
          }
        }
        continue;
      }
      let recorded = null;
      try { recorded = readJSON(path.join(folder, 'check-results.json')).results; } catch { continue; }
      if (!Array.isArray(recorded)) continue;
      found.attempts += 1;
      if (checks.some((check) => (recorded.find((entry) => entry?.id === check)?.result ?? 'unknown') === 'unknown')) {
        found.unknown += 1;
        runs.add(run.run_id);
      }
    }
  }
  return { ...found, runs: [...runs] };
}

// The budget each run of a loop fell under: the original one, or the latest
// revision made before the run started. [{ run_id, side, scope, revision
// (0 for the original), budget }].
function budgetsByRun(loop, spent, revisions) {
  const original = loop.budget_original ?? revisions[0]?.from ?? loop.budget ?? null;
  return spent.map((run) => {
    const revision = revisions.filter((entry) => Date.parse(entry.at) <= Date.parse(run.started_at)).at(-1) ?? null;
    return { run_id: run.run_id, side: run.side, scope: run.scope ?? 'full', revision: revision ? revisions.indexOf(revision) + 1 : 0, budget: revision ? revision.to : original };
  });
}

// The checks of a run that went from not passing to passing against the
// baseline: the final review says which change explains each.
const flipsOf = (compare) => compare.filter((entry) => entry.role === 'gating' && entry.after === 'pass' && entry.before !== 'pass')
  .map((entry) => ({ case: entry.case, check: entry.check, then: entry.then ?? null, before: entry.before ?? null }));

// The reviews that let a run be accepted: recorded after the run they
// reviewed finished, of a run of this loop, on the code of run. runs is the
// loop's full runs.
function reviewsFor(reviews, run, runs, repo) {
  const code = codeIdentity(run?.code_snapshot, repo);
  if (!code) return [];
  return reviews.filter((review) => {
    const reviewed = runs.find((entry) => entry.run_id === review.run_id);
    const finished = Date.parse(reviewed?.finished_at ?? review.run_finished_at);
    return reviewed && review.code_digest === code && Number.isFinite(finished) && Date.parse(review.at) > finished;
  });
}

// A review as loop status and acceptance show it: who did it, of which run
// and code, what it found, and the reviewer's notes.
const reviewSummary = (review) => ({ id: review.id, at: review.at, run_id: review.run_id, code_digest: review.code_digest, reviewer: review.reviewer, by: review.by ?? null,
  findings: review.findings ?? null, notes: review.answers?.notes ?? null, answers_digest: review.answers_digest ?? null, ...(review.map_partial ? { map_partial: true } : {}),
  ...(review.map_scope ? { map_scope: review.map_scope } : review.map_partial ? { map_scope: { scope: 'change_review', scope_limited: true, scope_note: LIMITED_SCOPE } } : {}) });

// The questions a final review answers besides the flips, each found or not
// with its detail.
const REVIEW_FINDINGS = ['special_cases', 'outside_spec', 'side_effects'];

// The findings of reviews that need the user's eyes: an eval input the change
// special-cases, a change the Spec does not ask for, or a side effect no
// check covers.
const reviewFindings = (reviews) => reviews.flatMap((review) => REVIEW_FINDINGS
  .filter((field) => review.answers?.[field]?.found === true)
  .map((field) => ({ review: review.id, reviewer: review.reviewer, finding: field, detail: review.answers[field].detail ?? null })));

// A dispute as loop status and acceptance show it, without the evidence's
// content, which loop.json and decisions.jsonl keep.
const disputeSummary = (entry) => ({ id: entry.id, at: entry.at, case: entry.case, check: entry.check, evidence: entry.evidence ? { file: entry.evidence.file, digest: entry.evidence.digest, bytes: entry.evidence.bytes } : null,
  ruling: entry.ruling ?? null });

// Fixes the reference points of one loop: the Spec, the baseline and the code
// it ran on, the packages and the run plan the user confirmed, and the budget
// the user agreed to. Starting a loop is the user's decision: by and ref say
// who agreed and where, unless the latest checks confirmation of this Spec
// export recorded that agreement (start_loop) and no loop started after it.
// The start code is the code the baseline ran on, rebuilt from its commit and
// its patch, so the working directory may already hold the change: a loop
// can judge code written before it, and records that the code had moved and
// what ran outside a loop before it. Nothing has to be committed.
export function startLoop(repo, name, options = {}) {
  // Flags that are not a budget are refused before anything is read.
  budgetOptions(options);
  const by = nonempty(options.by) ? options.by.trim() : null;
  const ref = nonempty(options.ref) ? options.ref.trim() : null;
  if ((by === null) !== (ref === null)) throw new Error('--by and --ref go together: who agreed to the loop, and where they said so.');
  const { evals, base, gaps, warnings: inputWarnings, confirmation, pin } = loopInputs(repo, name, { latest: true });
  const ledger = ledgerCheck(repo, name);
  if (ledger.gap) gaps.push(ledger.gap);
  const root = eddDirectory(repo, name);
  const runsDirectory = path.join(root, 'runs');
  const warnings = [...inputWarnings, ...(ledger.note && !ledger.gap ? [ledger.note] : [])];
  // The budget is the one the user confirmed with the checks, unless the
  // flags give another.
  const flagged = options.iterations !== undefined || options.minutes !== undefined || options.maxCost !== undefined;
  const confirmedBudget = confirmation?.run_plan?.budget ?? null;
  const budget = budgetOptions(options, confirmedBudget ?? undefined);
  const { iterations } = budget;
  const minutes = minutesOf(budget);
  const unit = typeof budget.run_minutes === 'number' ? 'run minutes' : 'minutes';
  // Earlier attempts estimate each run: those of the baseline, else those of
  // the last eval check, else the baseline's whole run, which ran the plan.
  // In a loop that needs a final run, every run but the last is taken as a
  // screen run, with one attempt of each package, and the last as the final
  // run. A budget the estimate shows may not hold the runs is a warning: the
  // budget stops the loop whatever the estimate said.
  const finals = base ? finalsNeeded(planOf(base), evals.cases) : false;
  const estimate = base ? estimateRuns(repo, name, { base, plan: planOf(base), cases: evals.cases }) : null;
  const need = !estimate?.basis ? null : finals ? (iterations - 1) * estimate.screen.minutes + estimate.final.minutes : iterations * estimate.full.minutes;
  // The cost the runs would report, when every estimate knows one.
  const costs = !estimate?.basis ? [] : finals ? [estimate.screen.cost_usd, estimate.final.cost_usd] : [estimate.full.cost_usd];
  const costNeed = costs.length && costs.every((value) => typeof value === 'number')
    ? (finals ? (iterations - 1) * estimate.screen.cost_usd + estimate.final.cost_usd : iterations * estimate.full.cost_usd) : null;
  const overCost = typeof budget.max_cost_usd === 'number' && costNeed !== null && costNeed > budget.max_cost_usd;
  const fit = { needed_minutes: need === null ? null : tenths(need), minutes, unit, cost_needed: costNeed === null ? null : money(costNeed), cost_cap: budget.max_cost_usd ?? null,
    fits: !(need !== null && need > minutes) && !overCost, basis: estimate?.basis ?? null };
  if (!fit.fits) {
    const screens = iterations - 1;
    const runs = finals
      ? `${screens ? `${screens} screen run${screens === 1 ? '' : 's'} of about ${shownMinutes(estimate.screen.minutes)} minutes each and ` : ''}a final run of about ${shownMinutes(estimate.final.minutes)} minutes need${screens ? '' : 's'}`
      : `${iterations} run${iterations === 1 ? '' : 's'} of about ${shownMinutes(estimate.full.minutes)} minutes ${iterations === 1 ? 'needs' : 'each need'}`;
    warnings.push(`budget_unfit: the budget is ${budgetLimits(budget)}, but ${runs} about ${Math.ceil(need ?? 0)} ${unit}${costNeed === null ? '' : ` and ${shownCost(costNeed)}`} (${basisText(estimate, base)}). The budget stops the loop when it is used up.`);
  }
  // One loop at a time for a Spec export: a new one starts once it ended or
  // stopped, once no head run is left in it (its budget is used up and only
  // its final review or acceptance is left), or after the user accepted it.
  // Without a readable loop.json, the loop its head runs name
  // (recordedLoop) stands in for it, as one that ended.
  let current = null;
  try { current = readLoop(repo, name); } catch { /* read from runs/ below */ }
  current ??= recordedLoop(repo, name);
  let currentStatus = null;
  if (current && !current.recovered_from) {
    try { currentStatus = loopStatus(repo, name); } catch { /* read as ended */ }
  }
  if (current && !current.recovered_from && evals.spec && current.spec === evals.spec && currentStatus && loopPhase(currentStatus) === 'live') {
    gaps.push(gap('loop_running', 'loop', `A loop for this Spec export started at ${current.started_at} and has not ended. One loop runs at a time for an export.`, 'agent', 'artifact', { loop_started_at: current.started_at }));
  }
  // The user's agreement to this loop: by and ref, or the latest checks
  // confirmation of the export when it recorded it and no loop started since.
  const chain = current ? [...(current.previous ?? []), without(current, 'previous')] : [];
  const decisions = readDecisions(root).entries;
  const confirmedAt = Date.parse(confirmation?.confirmed?.at);
  const startedSince = Number.isFinite(confirmedAt) && (chain.some((entry) => Date.parse(entry.started_at) > confirmedAt)
    || decisions.some((entry) => entry.type === 'loop_start' && Date.parse(entry.at) > confirmedAt));
  const viaConfirmation = confirmation?.start_loop === true && !startedSince;
  if (!by && !viaConfirmation) {
    gaps.push(gap('loop_consent_missing', 'loop', `Starting a loop is the user's decision. --by and --ref record who agreed and where they said so${confirmation?.start_loop === true
      ? `; the checks confirmation ${confirmation.id} recorded that agreement, but a loop started after it` : ''}.`,
    'user', 'business', { confirmation: confirmation?.id ?? null, start_loop: confirmation?.start_loop === true, loop_started_since: startedSince }));
  }
  // A budget above the one the user confirmed is theirs to agree to.
  const over = Boolean(flagged && confirmedBudget && exceeds(budget, confirmedBudget));
  if (over && !by) {
    gaps.push(gap('budget_over_confirmed', 'loop', `This budget, ${budgetLimits(budget)}, is more than the user confirmed with the checks (${budgetLimits(confirmedBudget)}). A bigger budget is the user's decision: --by and --ref record who agreed and where.`,
      'user', 'business', { budget, confirmed_budget: confirmedBudget }));
  }
  if (gaps.length) throw blocked(`The loop cannot start: ${gaps.map((entry) => entry.message).join(' ')}`, gaps);
  ignoreRecords(repo);
  // The start code: the pinned one until a loop of this change is accepted,
  // otherwise the code the baseline ran on, its commit plus a copy of its
  // code.patch beside loop.json.
  let start;
  if (pin) {
    start = pin.start;
    if (start.patch && !existsSync(path.join(root, start.patch))) copyFileSync(baselinePatchOf(repo, name, base, start), path.join(root, start.patch));
  } else {
    const snapshot = base.code_snapshot;
    const file = path.join(root, START_PATCH);
    rmSync(file, { force: true });
    let patch = null;
    if (snapshot.patch) {
      copyFileSync(path.join(runsDirectory, base.run_id, snapshot.patch), file);
      patch = START_PATCH;
    }
    start = startCode(snapshot.commit ?? null, snapshot, repo, patch);
  }
  // The working directory may hold edits made before the loop: they become
  // part of the loop's diff, and the user hears of them.
  const nowSnapshot = codeSnapshot(repo).snapshot;
  const moved = sameCode(base.code_snapshot, nowSnapshot, repo) !== true;
  const movedFiles = moved ? changedFiles(repo, base.code_snapshot, nowSnapshot) : [];
  const all = readRuns(runsDirectory);
  const now = new Date().toISOString();
  const preLoop = outsideRuns(repo, name, evals.spec, all, chain, now);
  if (moved) {
    warnings.push(`The working directory differs from the code the baseline ${base.run_id} ran on${movedFiles.length ? ` in ${named(movedFiles)}` : ''}: the loop starts on the baseline's code, so those edits are part of its change.`);
  }
  if (preLoop.runs) {
    warnings.push(`Before this loop, ${plural(preLoop.runs, 'run')} of this Spec export ran outside a loop (${joined([...preLoop.head_runs, ...preLoop.trials])}${preLoop.failures ? `; ${preLoop.failures} failed` : ''}). They are not part of the loop.`);
  }
  if (finals && iterations < 2) {
    warnings.push(`A budget of ${iterations} full run leaves no room for a final run: in this loop the first full run is a screen run, and only a passing final run after it can be accepted.`);
  }
  if (base.baseline_unstable?.length) {
    warnings.push(`The baseline ${base.run_id} has checks whose attempts disagreed (baseline_unstable): ${base.baseline_unstable.map((entry) => `${entry.case}/${entry.check}`).join(', ')}. Their comparison with the baseline shows nothing about the change.`);
  }
  const plan = planOf(base);
  if (plan.uniform && base.is_baseline) {
    warnings.push(`The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs ${plan.attempts === 1 ? 'once' : `${plan.attempts} times`}, as it did there.`);
  }
  // What the earlier loops of this change used; this loop's budget is its own.
  const earlier = earlierLoops(repo, name, chain, evals.spec, all);
  if (earlier.loops.length || earlier.outside?.runs) {
    const { total } = earlier;
    warnings.push(`Earlier loops of this change (${total.loops}) used ${plural(total.iterations, 'full run')}; with the runs outside a loop, ${total.run_minutes === null ? 'an unknown number of' : shownMinutes(total.run_minutes)} run minutes${total.cost_usd === null ? '' : ` and ${shownCost(total.cost_usd)} in model calls as the adapter reported them`}. This loop's budget is its own (${budgetLimits(budget)}).`);
  }
  if (current?.recovered_from) {
    warnings.push(`loop.json is missing or cannot be read. The loop that started at ${current.started_at} is known from its runs only (${current.recovered_from.join(', ')}): its budget and the loops before it are lost.`);
  }
  // A loop after an accepted one records the loop it follows.
  let follows = null;
  if (current && loopAccepted(repo, name, current)) {
    let record = null;
    try { record = readJSON(acceptedFile(repo, name)); } catch { /* loopAccepted read it */ }
    follows = { loop_started_at: current.started_at, run_id: record?.run_id ?? null, spec: current.spec };
  }
  // The user abandoned the change after the loop before, which released the
  // start code it pinned.
  const abandon = decisions.filter((entry) => entry.type === 'change_abandon').at(-1) ?? null;
  const afterAbandon = abandon && (!current || Date.parse(abandon.at) >= Date.parse(current.started_at)) ? { at: abandon.at, by: abandon.by ?? null, ref: abandon.ref ?? null } : null;
  const consent = by ? { by, ref, at: now }
    : { via: 'confirmation', confirmation: confirmation.id, by: confirmation.confirmed?.by ?? null, ref: confirmation.confirmed?.ref ?? null, at: confirmation.confirmed?.at ?? null };
  const loop = {
    schema_version: '1.1', change: name, started_at: now,
    spec: evals.spec, baseline: base.run_id, baseline_available: base.is_baseline === true,
    base_commit: start.commit ?? null,
    // The code before the change. Until a loop of this change is accepted or
    // the user abandons the change, every base record and every new loop
    // keeps this code.
    start_code: start,
    start_from: pin ? 'pinned' : 'baseline',
    // Whether the working directory held other code than the start code when
    // the loop started, and which files differed.
    worktree_moved: moved, moved_files: movedFiles,
    // The head runs and trials of this Spec export made outside a loop before it.
    pre_loop: preLoop,
    budget, budget_original: budget, budget_revisions: [],
    // The confirmation of the checks this loop compares with, its tier, and
    // where its budget came from. A confirmation without a tier is of the
    // full tier.
    checks_confirmation: confirmation ? { id: confirmation.id, at: confirmation.confirmed?.at ?? null } : null,
    tier: confirmation?.run_plan?.tier ?? 'full',
    // Whether the user asked, with the plan, to stop when the loop is stuck.
    stop_on_stuck: confirmation?.stop_on_stuck === true || confirmation?.run_plan?.stop_on_stuck === true,
    budget_source: flagged ? 'loop_start' : 'confirmation',
    ...(flagged && confirmedBudget ? { confirmed_budget: confirmedBudget } : {}),
    ...(over ? { budget_consent: { by, ref, at: now } } : {}),
    // Who agreed to this loop, and where.
    consent,
    // The minutes of a clock budget count from here.
    clock_started_at: now,
    // The packages this loop runs; a change to one ends it. run_digest leaves
    // the fixtures out, so a fixture added since ends nothing.
    task_digest: Object.fromEntries(evals.cases.map((item) => [item.id, item.task_digest])),
    run_digest: casesDigests(evals.cases).run_digest,
    reviews: [], disputes: [], tests: [],
    ...(follows ? { follows } : {}),
    ...(afterAbandon ? { after_abandon: afterAbandon } : {}),
    ...(current ? { previous: [...(current.previous ?? []), without(current, 'previous')] } : {}),
  };
  saveLoop(repo, name, loop);
  appendDecision(root, { type: 'loop_start', loop_started_at: now, spec: evals.spec, baseline: base.run_id, start_code: start.digest ?? null,
    ...(by ? { by, ref } : { via: 'confirmation', confirmation: confirmation.id }), budget, ...(over ? { budget_over_confirmed: true } : {}), worktree_moved: moved });
  return { loop, run_plan: plan, tier: loop.tier, start_code: startFacts(name, start), worktree_moved: moved, moved_files: movedFiles, pre_loop: preLoop,
    earlier_loops: earlier, consent, budget_fit: fit, warnings,
    suggestion: { command: ['run', 'start', name, '--repo', repo], why: 'The loop has no run yet; its first full run is compared with the baseline.' } };
}

const compareOf = (runs, run) => {
  try { return readJSON(path.join(runs, run.run_id, 'compare.json')).results; } catch { return []; }
};

// The lines no check verified in a run, which the user judges: [{ case, then,
// reason }]. A comparison written before they were recorded lists none.
const manualOf = (runs, run) => {
  try { return readJSON(path.join(runs, run.run_id, 'compare.json')).manual ?? []; } catch { return []; }
};

// Whether the CLI wrote the report of a run: reports/<run>.md, with Result and
// Changes taken from the records. Every other section is the agent's free
// notes, and nothing waits for them.
const reportState = (repo, name, run) => (existsSync(reportFile(repo, name, run.run_id)) ? 'written' : 'missing');

// What a report lacks that the CLI writes, for an older caller: nothing once
// the report is there. Its other sections are free notes.
export function reportGaps(repo, name, run) {
  return reportState(repo, name, run) === 'written' ? [] : [`no report at reports/${run.run_id}.md`];
}

// Whether the accepted change is in Git: the application code, and this
// change's own files, such as its Spec folder, eval packages, reports and
// acceptance record. { committed, code_commit, uncommitted, needs_user }:
// code_commit only when the commit holds all of the accepted code;
// uncommitted names every file still to commit, the accepted code's files
// that Git does not hold yet and the change's own. Committing, merging and
// opening a pull request are the user's to decide.
function commitFacts(repo, name, snapshot, codeMatches) {
  const codeFiles = codeMatches && Array.isArray(snapshot?.changed_files) ? snapshot.changed_files : [];
  const code = codeMatches && Array.isArray(snapshot?.changed_files) && !snapshot.changed_files.length ? snapshot.commit : null;
  const uncommitted = [...new Set([...codeFiles, ...(uncommittedArtifacts(repo, name) ?? [])])].sort();
  const committed = Boolean(code) && !uncommitted.length;
  return { committed, code_commit: code, uncommitted, needs_user: [committed
    ? { decision: 'merge or pull request', why: `The accepted change is committed in ${short(code)}; the user decides whether to merge it or open a pull request.` }
    : { decision: 'commit, merge or pull request', why: 'The user decides whether and how the accepted change goes into Git.' }] };
}

// The status of a change whose acceptance of the current Spec export is
// committed while its loop.json and run records are not on this machine, as
// in a fresh clone: read from accepted.json alone, or null. It is read-only:
// nothing that needs loop.json can be done here. code_matches says whether
// the code now is the accepted code.
function acceptedElsewhere(repo, name) {
  let record = null;
  try { record = existsSync(acceptedFile(repo, name)) ? readJSON(acceptedFile(repo, name)) : null; } catch { return null; }
  if (!isRecord(record) || !nonempty(record.spec?.sha256) || !nonempty(record.run_id)) return null;
  let spec = null;
  try { spec = validateEval(repo, name).spec; } catch { return null; }
  if (!spec || record.spec.sha256 !== spec) return null;
  const now = codeSnapshot(repo).snapshot;
  const codeMatches = nonempty(record.code_digest) && codeIdentity(now, repo) === record.code_digest;
  const { by = null, ref = null, at = null } = isRecord(record.accepted) ? record.accepted : {};
  const start = isRecord(record.start_code) ? record.start_code : null;
  const notHeld = Array.isArray(start?.uncommitted_files) ? start.uncommitted_files : [];
  // Whether the accepted change is in Git can be told only while the code is
  // the accepted code.
  const situation = { code: 'accepted', local_records: false, run_id: record.run_id, by, ref, at, commit: record.commit ?? null, code_matches: codeMatches,
    ...(codeMatches ? commitFacts(repo, name, now, true) : {}),
    message: `${by ?? 'The user'} accepted run ${record.run_id} (${ref ?? 'no reference'}). accepted.json records it; the run records and loop.json are on another machine.` };
  const warnings = [
    `This machine has no loop.json and no run records of this change: they stay on the machine where the loop ran, and accepted.json is the record of the acceptance. Re-proving the change here needs a baseline on its start commit${start?.commit ? ` ${short(start.commit)}` : ''}, for example in a worktree${notHeld.length ? `; the start code also held ${named(notHeld)}, uncommitted then, which loop-start.patch keeps on that machine` : ''}. A baseline on code that holds the change would describe the change, not the code before it.`,
    ...(codeMatches ? [] : ['The code differs from the accepted code (code_digest), so the acceptance says nothing about the code now.']),
  ];
  return {
    change: name, phase: 'done',
    loop: { started_at: record.loop_started_at ?? null, spec: record.spec.sha256, baseline: record.baseline ?? null, start_code: start, tier: record.tier ?? null,
      run_plan: record.run_plan ?? null, budget: record.budget ?? null, budget_original: record.budget_original ?? null, budget_revisions: record.budget_revisions ?? [],
      used: record.used ?? null, exhausted: null, local_records: false },
    confirmation: null, runs: [], final: null, partial_runs: 0, checks: [], regressions: [], lost_progress: [], stuck: false, changed_packages: [], unstable: [],
    accepted: true, acceptance: { run_id: record.run_id, by, ref, at, local_records: false, code_matches: codeMatches },
    situation, ended: null, stop: null, declined: null, abandoned: null, strength: null,
    review: null, reviews: Array.isArray(record.reviews) ? record.reviews : [], map_scope: record.map_scope ?? null, disputes: Array.isArray(record.disputes) ? record.disputes : [], tests: [],
    final_runs_of_change: record.final_runs_of_change ?? null,
    gates: { head_run: null, accept: [] },
    obligations: codeMatches && !situation.committed ? [{ kind: 'consent', decision: 'commit, merge or pull request', by: 'user' }] : [],
    must_show: null, warnings, suggestion: null,
  };
}

// The refusal of a command that needs loop.json, on a machine that has only
// the committed acceptance (acceptedElsewhere).
const localRecordsMissing = (status, what) => blocked(`${what}: no loop.json.`, [gap('loop_missing', 'loop', `This machine has no loop.json and no run records of this change. accepted.json records that ${status.acceptance?.by ?? 'the user'} accepted run ${status.acceptance?.run_id ?? 'unknown'}.`, 'user', 'business')]);

// Where the loop stands, worked out from the run records. Read-only. The loop
// is the latest of the change, whatever Spec export it ran for: the one in
// loop.json, or, when loop.json is missing or cannot be read, the one its head
// runs name, which counts as ended. With neither, a committed acceptance of
// the current export is read alone (acceptedElsewhere). ended says why the
// loop ended: a fixed input that changed (worked out on every call, so
// putting that input back makes it null again), a stop that holds, which no
// code change lifts, or an end that was recorded. accepted says whether the
// user's acceptance covers the loop. The result holds facts, the gates the CLI enforces, the
// obligations it cannot verify (the final review, what the user must be
// shown, the user's consent) and at most one suggestion.
export function loopStatus(repo, name) {
  const root = eddDirectory(repo, name);
  let loop = null;
  let unreadable = false;
  try { loop = readLoop(repo, name); } catch { unreadable = true; }
  if (loop && !isRecord(loop)) {
    loop = null;
    unreadable = true;
  }
  const recovered = !loop;
  if (!loop) loop = recordedLoop(repo, name);
  if (!loop) {
    const elsewhere = unreadable ? null : acceptedElsewhere(repo, name);
    if (elsewhere) return elsewhere;
    throw blocked('No loop has started for this change.', [gap('loop_missing', 'loop', `No loop has started for this change${unreadable ? ', and loop.json cannot be read' : ''}. Starting one is the user's decision.`, 'user', 'business')]);
  }
  const evals = validateEval(repo, name);
  // The current export of the change, also while the Spec files differ from
  // it. Only an export makes a new one: an edit of the Spec files does not.
  const exported = evals.spec ?? exportFacts(repo, name).id ?? null;
  const runsDirectory = path.join(root, 'runs');
  const all = readRuns(runsDirectory);
  // A loop known from its runs only keeps the checks confirmation and the
  // tier its runs recorded, which loop.json held for it.
  if (recovered) {
    const named = all.filter((run) => (loop.recovered_from ?? []).includes(run.run_id)).sort(byStart);
    const ranUnder = named.find((run) => isRecord(run.checks_confirmation) && nonempty(run.checks_confirmation.id))?.checks_confirmation ?? null;
    const ranTier = named.find((run) => ['light', 'full'].includes(run.tier))?.tier ?? null;
    loop = { ...loop, ...(ranUnder ? { checks_confirmation: ranUnder } : {}), ...(ranTier ? { tier: ranTier } : {}) };
  }
  const decisions = readDecisions(root).entries;
  const records = loopRecords(loop, decisions);
  const baseRecord = all.find((run) => run.run_id === loop.baseline) ?? null;
  const base = baseRecord && baseRecord.side === 'base' && !isLost(baseRecord) ? baseRecord : null;
  const ours = loopRuns(all, loop);
  const runs = fullRuns(ours);
  const latest = runs.at(-1) ?? null;
  // What the budget counts: head runs, trials made in the loop, and runs
  // whose record is lost or that were interrupted.
  const spent = loopSpend(all, loop);
  const trials = loopTrials(all, loop);
  const lostRuns = spent.filter(isLost);
  const interrupted = spent.filter(isInterrupted);
  const warnings = [...evals.warnings];
  if (!base) warnings.push(`The loop's baseline ${loop.baseline} is no longer in runs/, so the loop has ended (baseline_missing).`);
  if (recovered) {
    warnings.push(`loop.json is missing or cannot be read. The loop that started at ${loop.started_at} is known from its runs only (${(loop.recovered_from ?? []).join(', ')}), so it counts as ended; its budget and the loops before it are not known.`);
  }
  const unfinished = unfinishedRuns(runsDirectory);
  if (unfinished.length) warnings.push(unfinishedWarning(unfinished));
  if (lostRuns.length) {
    warnings.push(`${joined(lostRuns.map((run) => run.run_id))} of this loop ${lostRuns.length === 1 ? 'is' : 'are'} in runs/index.jsonl, but ${lostRuns.length === 1 ? 'its run record is' : 'their run records are'} gone or cannot be read: each counts as a failure of its code and packages, and toward the budget.`);
  }
  if (latest?.code_changed_during_run) warnings.push(`The code changed while ${latest.run_id} executed, so its results do not belong to one version of the code.`);
  const changedDuring = (run) => (run.eval_snapshot?.changed_during_run ?? []).join(', ') || 'the packages it ran';
  if (latest?.packages_changed_during_run) warnings.push(`The eval packages changed while ${latest.run_id} executed (${changedDuring(latest)}), so its results do not belong to one version of them.`);

  // Each check through the loop: the baseline, then every full run.
  const results = runs.map((run) => new Map(compareOf(runsDirectory, run).map((entry) => [`${entry.case}\n${entry.check}`, entry])));
  const keys = evals.cases.flatMap((item) => {
    let declared = [];
    try { declared = readJSON(path.join(root, 'evals', item.id, 'tests/checks.json')).checks ?? []; } catch { /* reported by validation */ }
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
  // The packages as they are now, by both digests (samePackage).
  const nowDigests = casesDigests(evals.cases);
  const ranAtBase = (id) => base?.is_baseline === true && (base.cases ?? []).some((item) => item.id === id);
  // holder keeps the digests of the run or the packages compared, by package.
  const comparable = (id, holder) => ranAtBase(id) && samePackage(digestsAt(base, id), digestsAt(holder, id));
  const checks = keys.map((key) => {
    const id = `${key.case}\n${key.check}`;
    return { ...key, baseline: baseResults.get(id) ?? null, baseline_comparable: comparable(key.case, nowDigests),
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
  // agent and model counts, from every loop and from base runs and trials
  // too, and a failure among them is never cancelled by a pass. A gating
  // check that passed and failed on the code of one of this loop's runs, with
  // the loop's packages, in a run of this loop among others, stops the loop
  // for good.
  const pool = sameCodeResults(repo, runsDirectory, loop.spec, all);
  const nowCode = codeIdentity(now, repo);
  const role = (wanted) => new Set(keys.filter((key) => key.role === wanted).map((key) => `${key.case}\n${key.check}`));
  const gating = role('gating');
  const varied = (checksOf) => (nowCode ? unstableChecks(pool, { code: nowCode, digests: nowDigests, checks: checksOf }) : []);
  const unstableAll = varied(gating);
  const ourIds = new Set(ours.map((run) => run.run_id));
  const loopCodes = [...new Set(ours.filter((run) => settled(run) && ['completed', 'error'].includes(run.execution_status)).map(identityOf).filter(Boolean))];
  // The packages the loop started on; a loop.json without them, those now.
  const loopDigests = loop.task_digest ? { task_digest: loop.task_digest, run_digest: loop.run_digest ?? {} } : nowDigests;
  const unstable = loopCodes.flatMap((code) => unstableChecks(pool, { code, digests: loopDigests, checks: gating })
    .filter((group) => [...group.pass, ...group.fail].some((id) => ourIds.has(id))));
  const listed = (groups) => groups.map((group) => `${group.case}/${group.check}`).join(', ');
  const order = new Map(all.map((run, index) => [run.run_id, index]));
  const ranIn = (groups) => [...new Set(groups.flatMap((group) => [...group.pass, ...group.fail]))].sort((a, b) => order.get(a) - order.get(b)).join(', ');
  const baseOnly = unstableAll.filter((group) => !group.head);
  if (baseOnly.length) warnings.push(`On the code before the change, ${listed(baseOnly)} passed and failed (${ranIn(baseOnly)}). Its result can vary.`);
  const diagnostic = varied(role('diagnostic'));
  if (diagnostic.length) warnings.push(`Diagnostic ${listed(diagnostic)} passed and failed on the code as it is now (${ranIn(diagnostic)}). It does not decide the verdict.`);
  // A changed package is another key: its earlier failures do not count
  // against it, but the user hears of them.
  const oldFailures = new Map();
  for (const entry of pool) {
    const id = `${entry.case}\n${entry.check}`;
    if (entry.result !== 'fail' || !nowCode || entry.code !== nowCode || !gating.has(id) || (entry.task_digest === null && entry.run_digest === null)
      || samePackage(entryDigests(entry), digestsAt(nowDigests, entry.case))) continue;
    oldFailures.set(id, [...new Set([...(oldFailures.get(id) ?? []), entry.run_id])]);
  }
  for (const [id, ran] of oldFailures) {
    warnings.push(`On the code as it is now, ${id.replace('\n', '/')} failed with an earlier version of its package (${ran.join(', ')}), and the package changed since. A changed package starts a new count; the user hears of the failure before they accept.`);
  }

  let acceptedRecord = null;
  try { acceptedRecord = existsSync(acceptedFile(repo, name)) ? readJSON(acceptedFile(repo, name)) : null; } catch {
    warnings.push('accepted.json cannot be read. It records the user\'s acceptance.');
  }
  if (!acceptedIn(acceptedRecord, loop, runs)) acceptedRecord = null;
  // The loop is done only while the acceptance covers it: the code is still
  // the accepted run's, no full run after the acceptance fails, even when a
  // later one passes again, and no run of the accepted code and packages
  // fails after the accepted run started, full or partial.
  const cover = acceptanceHolds(acceptedRecord, loop, runs, now, repo, pool, (run) => gatingKeys(compareOf(runsDirectory, run)));
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
    warnings.push(`${failed} failed on the code of the accepted run ${acceptedRecord.run_id} in ${[...new Set(cover.earlier.map((entry) => entry.run_id))].join(', ')}, which started before it. A failure of the same code now always counts, so this acceptance would be refused today. It stays recorded.`);
  }

  // The fixed inputs of the loop: its Spec export, its baseline, the run plan
  // and the packages of the user's checks confirmation it started on, and the
  // project kit. A change to one ends the loop; the CLI says what changed. A
  // re-export ends it, done or not; the others only while the user's
  // acceptance does not cover it. Each is read from the current export, so
  // Spec files that differ from it change none of them.
  const snapshot = evalSnapshot(repo, name);
  const confirmed = checksConfirmation(repo, name, loop.spec, snapshot);
  if (confirmed.gap) warnings.push(confirmed.gap.message);
  const loopEntry = !confirmed.gap && loop.checks_confirmation ? confirmationById(confirmed.entries, loop.checks_confirmation.id) : null;
  const newer = confirmed.latest && confirmed.latest.id !== loop.checks_confirmation?.id ? confirmed.latest : null;
  const plan = base ? planOf(base) : null;
  // The tier of the loop, fixed with its plan: that of its checks
  // confirmation, else the one loop.json recorded. A confirmation without a
  // tier is of the full tier.
  const tier = loopEntry?.run_plan?.tier ?? loop.tier ?? 'full';
  const light = tier === 'light';
  // Whether the user asked, with the plan, to stop when the loop is stuck.
  const stopOnStuck = loopEntry?.stop_on_stuck === true || loopEntry?.run_plan?.stop_on_stuck === true || loop.stop_on_stuck === true;
  // The head runs and trials of this loop whose adapter reported model use in
  // the light tier: none of them passes, and the first one ends the loop.
  const tripped = [...ours, ...trials.filter(usableRun)].filter((run) => run.tier_changed).sort(byStart);
  // The packages that differ from the loop's confirmation, by file; for a loop
  // that kept none, from the packages it started on.
  const loopMatch = loopEntry ? confirmationMatch(loopEntry, snapshot, loop.spec) : null;
  const changedIds = loopMatch ? loopMatch.packages.map((entry) => entry.id) : packagesBetween(loopDigests, snapshot);
  const startNow = loopStartCode(repo, name, loop);
  let inputEnd = null;
  if (exported && exported !== loop.spec) {
    const done = loopAccepted(repo, name, loop);
    inputEnd = { reason: 'spec_exported', at: null, spec: exported, loop_spec: loop.spec, accepted: done,
      message: `The Spec was exported again (${exported.slice(7, 19)}), so this loop, started on ${String(loop.spec).slice(7, 19)}, has ended${done ? '; the user had accepted it' : ''}.` };
  } else if (exported && !holds) {
    // Another tier is another run plan.
    const newerTier = newer ? newer.run_plan?.tier ?? 'full' : tier;
    const planKeys = [...(newer && base ? planDiffs(evals, base, newer).map((entry) => entry.key) : []), ...(newerTier !== tier ? ['tier'] : [])];
    const newerPackages = newer ? packagesBetween(confirmedDigests(newer), loopDigests) : [];
    if (!base) {
      inputEnd = { reason: 'baseline_missing', at: null, baseline: loop.baseline,
        message: `The loop's baseline ${loop.baseline} is no longer in runs/, so this loop has ended.` };
    } else if (newer && (planKeys.length || newerPackages.length)) {
      const others = planKeys.filter((key) => key !== 'tier');
      const parts = [...(others.length ? [`it confirms ${confirmedPlan(newer.run_plan ?? {})} where the loop runs ${confirmedPlan(plan)}`] : []),
        ...(newerTier !== tier ? [`it confirms the ${newerTier} tier where the loop runs the ${tier} tier`] : []),
        ...(newerPackages.length ? [`it covers other packages than the loop runs: ${newerPackages.join(', ')}`] : [])];
      inputEnd = { reason: 'confirmation_changed', at: newer.confirmed?.at ?? null, confirmation: newer.id, loop_confirmation: loop.checks_confirmation?.id ?? null,
        plan: planKeys, packages: newerPackages, ...(newerTier !== tier ? { tier: newerTier, loop_tier: tier } : {}),
        message: `The user's newest checks confirmation (${newer.confirmed?.at ?? 'no date'}) differs from this loop's: ${parts.join('; ')}. So this loop has ended.` };
    } else if (loopMatch ? !loopMatch.matches : changedIds.length) {
      const files = loopMatch ? matchFiles(loopMatch) : [];
      // In a new project, connecting the packages is the change that ends the
      // first loop: a package that changed was not connected when the user
      // confirmed the checks this loop runs, and its baseline records that
      // nothing could run.
      const connecting = !base.is_baseline && (loopEntry ? changedIds.some((id) => loopEntry.packages?.[id]?.ready === false) : true);
      inputEnd = { reason: 'packages_changed', at: null, packages: changedIds, files, connecting,
        message: `The eval packages or the project kit differ from the checks the user confirmed for this loop: ${files.length ? named(files) : changedIds.join(', ')}. A loop's packages and kit are fixed, so this loop has ended${connecting ? '; it started on a baseline recorded as unavailable, and connecting the packages ends it as expected' : ''}.` };
    } else if (tripped.length) {
      const cases = [...new Set(tripped.flatMap((run) => run.tier_changed.cases ?? []))].sort();
      const heads = tripped.filter((run) => !isTrial(run));
      const which = joined(tripped.map((run) => `${isTrial(run) ? 'trial' : 'run'} ${run.run_id}`));
      inputEnd = { reason: 'tier_changed', at: tripped[0].finished_at ?? tripped[0].started_at ?? null, cause: 'model_use', runs: tripped.map((run) => run.run_id),
        trials: tripped.filter(isTrial).map((run) => run.run_id), cases,
        message: `${which[0].toUpperCase()}${which.slice(1)} of this light-tier loop reported model use (tokens or cost) for ${cases.join(', ')}. The light tier holds only for code that calls no model, so this loop has ended${heads.length ? `, and ${heads.length === 1 ? 'that run' : 'those runs'} cannot pass` : ''}.` };
    }
  }
  // An end recorded with `loop end`, `loop decline` or `change abandon`.
  const closing = recordedEnd(loop, decisions);
  const declined = decisionsOf(decisions, 'loop_decline', loop).at(-1) ?? null;
  const abandoned = decisions.filter((entry) => entry.type === 'change_abandon' && Date.parse(entry.at) >= Date.parse(loop.started_at)).at(-1) ?? null;

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
  // stop_unstable reports. Each names the run where the check last passed and
  // the files changed between that run and the latest.
  const compared = (run) => settled(run) && run.execution_status === 'completed';
  const brief = ({ case: id, check, intent }) => ({ case: id, check, intent });
  const fails = (entry) => entry.role === 'gating' && entry.runs.at(-1) === 'fail';
  const passedWhenAccepted = (entry) => (acceptedRecord?.checks ?? []).some((item) => item.case === entry.case && item.check === entry.check && item.after === 'pass')
    && (!acceptedRun || samePackage(digestsAt(acceptedRun, entry.case), digestsAt(latest, entry.case)));
  const sameAsLatest = (run) => Boolean(run && latest && identityOf(run) && identityOf(run) === identityOf(latest));
  const change = (entry) => {
    if (!latest || !compared(latest) || !fails(entry)) return null;
    if (failedAfter && passedWhenAccepted(entry) && !sameAsLatest(acceptedRun)) return { kind: 'regression', passed_in: acceptedRun, accepted: true };
    const baseline = comparable(entry.case, latest) && ['pass', 'fail'].includes(entry.baseline)
      && !sameAsLatest(base) ? entry.baseline : null;
    // An interrupted run, or one whose evidence could not tell, in between
    // does not hide what the check did before it.
    const index = entry.runs.slice(0, -1).findLastIndex((result, at) => compared(runs[at]) && (result === 'pass' || result === 'fail'));
    const before = index >= 0 && samePackage(digestsAt(runs[index], entry.case), digestsAt(latest, entry.case)) && !sameAsLatest(runs[index])
      ? entry.runs[index] : null;
    if (baseline === 'pass') return { kind: 'regression', passed_in: base };
    if (baseline === null && before === 'pass') return { kind: 'regression', passed_in: runs[index] };
    return baseline === 'fail' && before === 'pass' ? { kind: 'lost', passed_in: runs[index] } : null;
  };
  const filesBetween = new Map();
  const filesOf = (from) => {
    if (!from?.code_snapshot || !latest) return [];
    if (!filesBetween.has(from.run_id)) filesBetween.set(from.run_id, changedFiles(repo, from.code_snapshot, latest.code_snapshot));
    return filesBetween.get(from.run_id);
  };
  const changes = checks.map((entry) => ({ entry, found: change(entry) })).filter((item) => item.found);
  const detail = ({ entry, found }) => ({ ...brief(entry), failing_run: latest.run_id, last_passed: found.passed_in?.run_id ?? (found.accepted ? acceptedRecord?.run_id ?? null : null),
    ...(found.accepted ? { accepted_run: true } : {}), files_changed: filesOf(found.passed_in) });
  const regressions = changes.filter((item) => item.found.kind === 'regression').map(detail);
  const lost = changes.filter((item) => item.found.kind === 'lost').map(detail);
  if (lost.length) warnings.push(`Passed in an earlier run and fails again: ${lost.map((entry) => `${entry.case}/${entry.check} (passed in ${entry.last_passed})`).join(', ')}.`);
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
  const pair = skipped ? `${latest.run_id} and ${previous.run_id} (${skipped === 1 ? 'the run between them is' : `the ${skipped} runs between them are`} not compared)` : 'the last two runs';
  const adds = 'A run of the same code only adds to its count: it never cancels a failure, and it tries nothing new.';
  // A final run repeats the code of its screen run by design.
  if (repeated && latest.role !== 'final' && !packagesBetween(latest, previous).length) warnings.push(skipped ? `${latest.run_id} used the same code as ${previous.run_id}. ${adds}` : `The last two runs used the same code. ${adds}`);
  if (stuck && !stopOnStuck) warnings.push(`stuck: the same gating checks failed in ${pair} on different code: ${failing(runs.length - 1, both).join(', ')}.`);

  // What the loop's runs took and used so far count toward the budget: full
  // runs, run minutes and reported cost, of its head runs, its trials and its
  // lost or interrupted runs. Minutes of a clock budget stop at the user's
  // acceptance while it covers the loop. A loop known only from its runs has
  // no budget left to count.
  const budget = loop.budget ?? null;
  const usage = spendUsage(runsDirectory, spent);
  const { clock, used, exhausted: usedUp } = budgetUsed(loop, fullRuns(spent), holds ? acceptedRecord.accepted?.at : undefined, usage);
  const exhausted = Boolean(budget) && usedUp;
  // The packages whose digest differs from those the loop started on. A
  // change ends the loop, so while it goes on this is empty.
  const changedPackages = evals.cases.filter((item) => !samePackage(digestsAt(loopDigests, item.id), digestsAt(nowDigests, item.id))).map((item) => item.id);

  // Screen first, then a final run. In a loop whose plan runs a package more
  // than once, every full run of an iteration is a screen run, with one
  // attempt of each package; once one passes, the next full run on its code
  // and packages is the final run, and only a passing final run can be
  // accepted. Without such a package, every full run follows the plan and its
  // role is null. Whether a final run is needed rests on the loop's plan and
  // its packages, which are fixed: a package counts once it is connected,
  // whatever its git-ignored `eval check` record says (finalsNeeded).
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
  // they were, or once a gating check failed in an attempt that completed.
  const counted = (run) => roleOf(run) === 'final' && settled(run) && (run.execution_status === 'completed' || failedInRun(run).length > 0);
  const gatingFailuresOf = (run) => failuresOf(pool, run, gatingKeys(compareOf(runsDirectory, run)), repo);
  // The screen run whose final run is due: the latest that passed, on the
  // code and packages as they are now, and whose code never failed a gating
  // check with those packages, agent and model. Neither its report nor a
  // final review is waited for: the review is needed for the acceptance.
  const candidate = needed ? runs.findLast((run) => roleOf(run) === 'screen' && settled(run) && run.execution_status === 'completed' && run.verdict === 'pass'
    && nowCode !== null && identityOf(run) === nowCode && !packagesBetween(run, nowDigests).length
    && !gatingFailuresOf(run).length) ?? null : null;
  const finalsOf = candidate ? runs.filter((run) => run !== candidate && counted(run) && (run.final_of === candidate.run_id
    || (identityOf(run) === identityOf(candidate) && !packagesBetween(run, candidate).length))) : [];
  const incomplete = finalsOf.filter((run) => run.verdict === 'unverified');
  const pending = Boolean(candidate) && !finalsOf.some((run) => ['pass', 'fail'].includes(run.verdict)) && incomplete.length < 2;
  // The final runs of this loop that failed. Only a run recorded as a final
  // run counts: before runs had a role, every full run of a loop followed the
  // plan, so a failing one was an ordinary iteration, not a final run after a
  // passing screen run.
  const failedFinals = needed ? runs.filter((run) => run.role === 'final' && counted(run) && run.verdict === 'fail') : [];
  const final = { needed, attempts: plan?.attempts ?? null, live: (needed ? planned : readyCases.filter(liveCase)).map((item) => item.id),
    candidate: candidate?.run_id ?? null, pending, finals: finalsOf.map((run) => ({ run_id: run.run_id, verdict: run.verdict })),
    failed: failedFinals.map((run) => run.run_id), incomplete: incomplete.map((run) => run.run_id), stops_at_failed: FAILED_FINALS_STOP };
  // The gating checks of a run that failed, with how many attempts passed.
  const failedChecks = (run) => compareOf(runsDirectory, run).filter((entry) => entry.role === 'gating' && entry.after === 'fail').map((entry) => {
    const counts = entry.after_counts ?? { pass: 0, fail: 1, unknown: 0 };
    return { case: entry.case, check: entry.check, passed: counts.pass, attempts: counts.pass + counts.fail + counts.unknown };
  });
  const unknownIn = (list) => [...new Set(list.flatMap((run) => compareOf(runsDirectory, run).filter((entry) => entry.role === 'gating' && entry.after === 'unknown')
    .map((entry) => `${entry.case}/${entry.check}`)))];
  const others = connected.filter((item) => !planned.includes(item));
  const finalPlan = { packages: planned.map((item) => item.id), attempts: plan?.attempts ?? 1, others_once: others.map((item) => item.id) };
  const finalPlanText = planned.length === 1 ? `${planned[0].id} runs ${plan?.attempts ?? 1} times${others.length ? ' and every other package once' : ''}`
    : `${planned.map((item) => item.id).join(', ')} run ${plan?.attempts ?? 1} times each${others.length ? ' and every other package once' : ''}`;
  // What the next runs take by earlier attempts, the loop's own full runs
  // first, and what the budget has left. A partial run is a quick look, so its
  // attempts never lower the estimate.
  const estimate = { ...estimateRuns(repo, name, { base, plan, cases: evals.cases, runs }),
    remaining: !budget ? null : { runs: Math.max(0, budget.iterations - used.iterations),
      // In the budget's own measure: run minutes, or the clock for a budget
      // recorded before run minutes.
      minutes: typeof budget.run_minutes === 'number' ? Math.max(0, tenths(budget.run_minutes - used.run_minutes))
        : typeof budget.minutes === 'number' ? Math.max(0, budget.minutes - used.minutes) : null,
      ...(typeof budget.max_cost_usd === 'number' ? { cost_usd: Math.max(0, money(budget.max_cost_usd - (used.cost_usd ?? 0))) } : {}) } };
  const latestFailedFinal = Boolean(latest && needed && latest.role === 'final' && counted(latest) && latest.verdict === 'fail');
  // The final runs that counted on a run's code and packages, other than it.
  const finalsOnCodeOf = (run) => runs.filter((other) => other !== run && counted(other) && identityOf(other) !== null
    && identityOf(other) === identityOf(run) && !packagesBetween(other, run).length);
  // A passing screen run whose code and packages already passed a final run:
  // that final run is the one to accept.
  const passedFinalOf = needed && latest?.verdict === 'pass' && roleOf(latest) === 'screen' && settled(latest) && !gatingFailuresOf(latest).length
    ? finalsOnCodeOf(latest).findLast((run) => run.verdict === 'pass') ?? null : null;
  // A gating check that failed on the code and packages of a final run that
  // passed. A failed final run has passing attempts too; it is no such run.
  const passedFinal = (id) => roleOf(byId.get(id)) === 'final' && byId.get(id).verdict === 'pass';
  const contradicted = needed ? unstable.filter((group) => group.pass.some(passedFinal)) : [];
  // An earlier release could accept a screen run of a loop that needs a final
  // run. The user's acceptance is not withdrawn for it, but they hear of it.
  if (holds && needed && acceptedRun && roleOf(acceptedRun) === 'screen') {
    warnings.push(`The accepted run ${acceptedRecord.run_id} is a screen run: its pass rests on ${screenBasis(acceptedRun, planned.map((item) => item.id), plan.attempts)}, and this loop needs a passing final run (not_final), so this acceptance would be refused today. It stays recorded.`);
  }
  if (keeps === false) warnings.push(`The code changed after the accepted run ${acceptedRecord.run_id}. The acceptance covers that run's code only.`);
  if (failedAfter) {
    const partial = (failedAfter.scope ?? 'full') === 'partial';
    const since = Date.parse(failedAfter.started_at) > Date.parse(acceptedRecord.accepted?.at) ? 'after the user accepted run' : 'which started after the accepted run';
    warnings.push(`${partial ? 'Partial run' : 'Run'} ${failedAfter.run_id}, ${since} ${acceptedRecord.run_id}, fails${partial ? ' on the accepted code' : ''}, so the acceptance no longer covers this loop.${cover.failedSame.includes(failedAfter.run_id)
      ? ' A failure of the accepted code always counts, so no run of it can be accepted again.' : ''}`);
  }
  // A passing run says nothing about code that changed after it.
  const moved = latest?.verdict === 'pass' && sameCode(latest.code_snapshot, now, repo) === false;
  // What eval check and run start refuse while it lasts, such as a package
  // whose tests/checks.json no longer validates.
  const blocking = evals.spec ? evals.gaps.filter((entry) => entry.code !== 'integration_pending') : [];
  // The packages a run would skip until `eval check` proves them as they are.
  const unchecked = blocking.length ? [] : evals.cases.filter(waitsForCheck).map((item) => item.id);
  // The user's acceptance stays when a package changes after it, but they hear of it.
  const afterAcceptance = holds && acceptedRun ? packagesBetween(acceptedRun, nowDigests) : [];
  if (afterAcceptance.length) warnings.push(`The eval packages changed after the accepted run ${acceptedRecord.run_id}: ${afterAcceptance.join(', ')}. The acceptance stays as it was given.${light ? ' It was given in the light tier: the packages ran with the network sealed, and each check ran once.' : ''}`);
  // A run after the acceptance that reported model use does not withdraw it,
  // but the user hears of it.
  const trippedLater = holds && acceptedRun ? tripped.filter((run) => run.started_at > acceptedRun.started_at).map((run) => run.run_id) : [];
  if (trippedLater.length) warnings.push(`${trippedLater.join(', ')}, after the accepted run ${acceptedRecord.run_id}, reported model use in this light-tier loop. The acceptance stays as it was given, but it rests on code that calls no model.`);
  // Rule V: a confirmation recorded before it still stands for this loop.
  const reachable = networkUndeclared(evals.cases.filter(connectedCase));
  if (reachable.length) warnings.push(`${reachable.map((item) => item.id).join(', ')} can reach outside networks but ${reachable.length === 1 ? 'declares' : 'declare'} no live dependency (network_undeclared). This loop goes on with the checks the user confirmed, but the next \`eval confirm\` refuses ${reachable.length === 1 ? 'it' : 'them'}.`);
  // A cost cap counts only the cost an adapter reports.
  if (typeof budget?.max_cost_usd === 'number' && usage.attempts > usage.reported) {
    warnings.push(`The adapter reported no cost for ${usage.attempts - usage.reported} of the ${usage.attempts} attempts of this loop, so its cost cap of ${shownCost(budget.max_cost_usd)} cannot be enforced for them.`);
  }
  // The packages changed since the user's newest checks confirmation of this
  // loop's Spec export.
  const unconfirmed = loop.checks_confirmation && confirmed.match && !confirmed.match.matches
    ? confirmed.match.packages.map((entry) => ({ id: entry.id, files: matchFiles({ packages: [entry], kit: confirmed.match.kit }) })) : [];
  // The lines whose only counterexamples a self-review wrote, in a confirmation.
  const selfReviewOf = (entry) => (entry?.lines ?? []).filter((line) => line.counterexamples?.length && line.counterexamples.every((item) => item.origin === 'self-review'))
    .map((line) => ({ package: line.package, then: line.then }));

  const command = (...words) => [...words, name, '--repo', repo];
  const pendingPackages = evals.cases.filter((item) => item.integration?.state !== 'ready').map((item) => item.id);
  // When the loop's runs last spent anything: the moment a stop came about.
  const lastAt = spent.at(-1)?.finished_at ?? spent.at(-1)?.started_at ?? null;

  // The stops, from the loop's own runs. Each holds for good: run start
  // refuses the head runs of a stopped loop, so its runs no longer change.
  // A stop on budget lifts once the user revises the budget (loop budget).
  const unstableStop = needed ? failedFinals.length >= FAILED_FINALS_STOP || contradicted.length > 0 : unstable.length > 0;
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
  // the budget only.
  const minutesFit = estimate.final.minutes === null || estimate.remaining?.minutes === null || estimate.remaining === null || estimate.final.minutes <= estimate.remaining.minutes;
  const costFits = estimate.remaining?.cost_usd === undefined || estimate.final.cost_usd === null || estimate.final.cost_usd <= estimate.remaining.cost_usd;
  const fits = minutesFit && costFits;
  const lastScreen = needed ? runs.findLast((run) => roleOf(run) === 'screen') ?? null : null;
  const dueScreen = lastScreen && settled(lastScreen) && lastScreen.execution_status === 'completed' && lastScreen.verdict === 'pass'
    && !gatingFailuresOf(lastScreen).length && !finalsOnCodeOf(lastScreen).some((run) => ['pass', 'fail'].includes(run.verdict))
    && finalsOnCodeOf(lastScreen).filter((run) => run.verdict === 'unverified').length < 2 ? lastScreen : null;
  const finalUnfit = needed && Boolean(budget) && Boolean(dueScreen) && !exhausted && !fits;
  const stuckStop = stopOnStuck && stuck && !regressions.length;
  const lightNote = light ? ' In the light tier this means the result of the code is not fixed.' : '';
  const stopUnstable = () => ({ reason: 'stop_unstable', at: lastAt,
    checks: unstable.map((group) => ({ case: group.case, check: group.check, pass: group.pass, fail: group.fail })),
    failed_finals: failedFinals.map((run) => ({ run_id: run.run_id, failed: failedChecks(run) })), contradicted: contradicted.map((group) => ({ case: group.case, check: group.check, pass: group.pass, fail: group.fail })),
    message: !needed ? `${unstable.map((group) => `${group.case}/${group.check} passed in ${group.pass.join(', ')} and failed in ${group.fail.join(', ')}`).join('; ')}, on the same code and packages. A failure of the same code always counts, so no run of this code can be accepted.${lightNote}`
      : contradicted.length ? `${contradicted.map((group) => `Final run ${group.pass.filter(passedFinal).at(-1)} passed, but ${group.case}/${group.check} failed on the same code in ${group.fail.join(', ')}`).join('; ')}. Checks that fail some of the time on code that passed its screen run are not settled by running again.${lightNote}`
        : `${failedFinals.length === 2 ? 'Two' : failedFinals.length} final runs of this loop failed: ${joined(failedFinals.map((run) => `${run.run_id} (${failedChecks(run).map((entry) => `${entry.case}/${entry.check} passed ${entry.passed} of ${entry.attempts}`).join(', ')})`))}. A loop allows one failed final run.${lightNote}` });
  // Two final runs of one code and its packages left evidence missing: no
  // third one is made.
  const stopIncomplete = (list) => {
    const screens = [...new Set(list.map((run) => run.final_of).filter(Boolean))];
    return { reason: 'stop_incomplete', at: lastAt, runs: list.map((run) => run.run_id), screen_runs: screens, unknown: unknownIn(list),
      message: `Two final runs of the code of screen run ${joined(screens.length ? screens : [candidate?.run_id ?? latest.run_id])}, ${joined(list.map((run) => run.run_id))}, found no failure but left ${unknownIn(list).join(', ') || 'some gating checks'} unknown, so no further final run of this code and these packages is made.` };
  };
  const budgetStop = (budgetReason, facts = {}, detail = '') => ({ reason: 'stop_budget', at: lastAt, budget_reason: budgetReason, budget, used, ...facts,
    message: budgetReason === 'final_run_does_not_fit' ? detail : `The budget of this loop is used up (${budgetText(budget, used)}).${detail ? ` ${detail}` : ''}` });
  const leftText = [...(minutesFit ? [] : [`the ${shownMinutes(estimate.remaining?.minutes ?? 0)} ${typeof budget?.run_minutes === 'number' ? 'run minutes' : 'minutes'}`]),
    ...(costFits ? [] : [`the ${shownCost(estimate.remaining?.cost_usd ?? 0)} of the cost cap`])].join(' and ');
  const finalUnfitStop = () => budgetStop('final_run_does_not_fit', { screen_run: dueScreen.run_id, final_plan: finalPlan, estimate: { minutes: estimate.final.minutes, cost_usd: estimate.final.cost_usd, basis: estimate.basis } },
    `Screen run ${dueScreen.run_id} passed, but the final run (${finalPlanText}) takes about ${shownMinutes(estimate.final.minutes)} minutes${estimate.final.cost_usd === null ? '' : ` and ${shownCost(estimate.final.cost_usd)}`} (${basisText(estimate, base)}), more than ${leftText} left of the budget.`);
  const stuckStopOf = () => ({ reason: 'stop_stuck', at: lastAt, runs: [latest.run_id, previous.run_id], failing: failing(runs.length - 1, both),
    message: `The same gating checks failed in ${pair} on different code: ${failing(runs.length - 1, both).join(', ')}. The user's run plan asks to stop when that happens.` });
  const noGatingStop = () => ({ reason: 'stop_no_gating', at: null, message: NO_GATING });
  const stopNext = unstableStop ? stopUnstable() : incompleteGroup ? stopIncomplete(incompleteGroup) : finalUnfit ? finalUnfitStop()
    : allManual(evals) ? noGatingStop() : stuckStop ? stuckStopOf() : null;

  // Where the loop stands, as facts. A stop that holds replaces every
  // situation that would lead to another head run, and ends the loop.
  let situation = null;
  let stopped = null;
  // The run a user may accept now, and the strength of its pass.
  let accepting = null;
  const ifBudget = (facts, detail) => {
    if (exhausted) stopped = budgetStop('budget_used_up', { situation: facts }, detail);
    else situation = facts;
  };
  if (closing) {
    situation = { code: 'ended' };
  } else if (inputEnd?.reason === 'spec_exported') {
    situation = { code: 'ended' };
  } else if (holds) {
    situation = { code: 'accepted', run_id: acceptedRecord.run_id, by: acceptedRecord.accepted?.by ?? null, ref: acceptedRecord.accepted?.ref ?? null, at: acceptedRecord.accepted?.at ?? null,
      ...commitFacts(repo, name, now, keeps === true), message: `${acceptedRecord.accepted?.by ?? 'The user'} accepted run ${acceptedRecord.run_id} (${acceptedRecord.accepted?.ref ?? 'no reference'}).` };
  } else if (recovered) {
    situation = { code: 'ended' };
  } else if (inputEnd) {
    situation = { code: 'ended' };
  } else if (latest && latest.execution_status !== 'completed' && !counted(latest)) {
    // A failure in an attempt that completed counts, whatever else errored.
    const burnedHere = failedInRun(latest);
    ifBudget({ code: 'execution_incomplete', run_id: latest.run_id, failed_checks: burnedHere,
      message: `${latest.run_id} did not complete: cases[].execution.reason and each logs/harbor.log say why. A build or timeout fault is no result of the code; a fix to an adapter or the environment changes a package or the kit, which ends this loop.${burnedHere.length
        ? ` ${burnedHere.join(', ')} failed in an attempt that completed, which is a result of the code: no run of this code with these packages can be accepted.` : ''}` },
    `The last run, ${latest.run_id}, did not complete.`);
  } else if (latest?.code_changed_during_run || latest?.packages_changed_during_run) {
    // Its results belong to no one version of the code or the packages: no
    // regression, lost progress or stuck loop is measured with them, now or
    // once a later run follows. Nor can it be accepted, and it adds nothing to
    // the results of the same code.
    ifBudget({ code: 'run_not_settled', run_id: latest.run_id, code_changed: Boolean(latest.code_changed_during_run), packages_changed: Boolean(latest.packages_changed_during_run),
      ...(latest.packages_changed_during_run ? { packages: latest.eval_snapshot?.changed_during_run ?? [] } : {}),
      message: [...(latest.code_changed_during_run ? [`The code changed while ${latest.run_id} executed, so its results do not belong to one version of the code.`] : []),
        ...(latest.packages_changed_during_run ? [`The eval packages changed while ${latest.run_id} executed (${changedDuring(latest)}), so its results do not belong to one version of them.`] : [])].join(' ') },
    `${latest.run_id} ran while the code or the packages changed.`);
  } else if (stopNext && ['stop_unstable', 'stop_incomplete'].includes(stopNext.reason)) {
    stopped = stopNext;
  } else if (blocking.length && !exhausted) {
    // Every run and every `eval check` is refused until they are repaired. A
    // package edit has ended the loop above; what reaches here is outside the
    // packages, such as .dockerignore.
    situation = { code: 'eval_blocked', gaps: blocking.map((entry) => ({ code: entry.code, layer: entry.layer ?? null, owner: entry.owner, message: entry.message })), pending_packages: pendingPackages,
      message: `${blocking.map((entry) => entry.message).join(' ')} \`eval check\` and \`run start\` refuse while this lasts.` };
  } else if (moved) {
    ifBudget({ code: 'code_moved', run_id: latest.run_id, accepted_run: acceptedRecord?.run_id === latest.run_id, unchecked,
      message: `The code changed after ${latest.run_id}${acceptedRecord?.run_id === latest.run_id ? ', the run the user accepted, so the acceptance no longer covers it' : ''}; that run says nothing about the code now.` },
    `The code changed after ${latest.run_id}.`);
  } else if (needed && latest?.verdict === 'pass' && roleOf(latest) === 'screen' && gatingFailuresOf(latest).length) {
    // A screen run that passed on code that already failed has no final run
    // that could be accepted.
    const burned = gatingFailuresOf(latest);
    ifBudget({ code: 'screen_burned', run_id: latest.run_id, failures: burned.map((entry) => ({ case: entry.case, check: entry.check, run_id: entry.run_id })),
      message: `Screen run ${latest.run_id} passed, but its code failed ${[...new Set(burned.map((entry) => `${entry.case}/${entry.check}`))].join(', ')} in ${[...new Set(burned.map((entry) => entry.run_id))].join(', ')}. A pass never cancels a failure of the same code, so no final run of it can be accepted.` },
    `Screen run ${latest.run_id} passed on code that failed before.`);
  } else if (needed && pending && !passedFinalOf) {
    // The final run of the candidate is due, as `run start` makes it whenever
    // one is pending on the code as it is now, once it fits what is left of
    // the budget.
    const facts = { code: 'final_run_due', candidate: candidate.run_id, final_plan: finalPlan, unchecked, incomplete: incomplete.map((run) => run.run_id),
      ...(incomplete.length ? { unknown: unknownIn([incomplete.at(-1)]) } : {}),
      estimate: { minutes: estimate.final.minutes, cost_usd: estimate.final.cost_usd, basis: estimate.basis, lower_bound: estimate.basis === 'eval_check' },
      message: `Screen run ${candidate.run_id} passed on the code as it is now, so its final run is due: ${finalPlanText}. It stops at the first package that fails, and only a passing final run can be accepted.${incomplete.length
        ? ` Final run ${incomplete.at(-1).run_id} found no failure but left ${unknownIn([incomplete.at(-1)]).join(', ') || 'some gating checks'} unknown; a second such final run stops the loop.` : ''}` };
    if (exhausted) stopped = budgetStop('budget_used_up', { situation: facts, screen_run: candidate.run_id }, `Screen run ${candidate.run_id} passed; its final run needs more budget: ${finalPlanText}.`);
    else if (finalUnfit) stopped = stopNext;
    else situation = facts;
  } else if (passedFinalOf || (latest?.verdict === 'pass' && (!needed || roleOf(latest) === 'final'))) {
    // The run to accept: the latest, or the passing final run of the code a
    // later screen run ran again.
    accepting = passedFinalOf ?? latest;
    situation = { code: 'acceptable', run_id: accepting.run_id, role: roleOf(accepting), screen_run: accepting.final_of ?? null,
      ...(passedFinalOf ? { repeated_by: latest.run_id } : {}),
      message: `Run ${accepting.run_id} passed${needed ? ' as a final run' : ''}. A pass is not acceptance: accepting it is the user's decision, and it needs a final review recorded for its code.` };
  } else if (stopNext?.reason === 'stop_no_gating') {
    // Nothing is open, and nothing can pass: another run tries nothing.
    stopped = stopNext;
  } else if (exhausted) {
    stopped = budgetStop('budget_used_up', { regressions, stuck }, [regressions.length ? `A check that passed now fails: ${regressions.map((entry) => `${entry.case}/${entry.check}`).join(', ')}.` : '',
      stuck ? `The same gating checks failed in ${pair} on different code.` : ''].filter(Boolean).join(' '));
  } else if (latestFailedFinal) {
    // One failed final run: that code can never be accepted.
    situation = { code: 'final_failed', run_id: latest.run_id, final_of: latest.final_of ?? null, failed: failedChecks(latest), errored: latest.execution_status !== 'completed',
      message: `Final run ${latest.run_id}${latest.final_of ? ` of the code of screen run ${latest.final_of}` : ''} failed. A failure of the same code always counts, so this code can never be accepted, and one more failed final run of this loop stops it (stop_unstable).` };
  } else if (regressions.length) {
    situation = { code: 'regression', regressions,
      message: `A check that passed now fails: ${regressions.map((entry) => `${entry.case}/${entry.check}, last passed in ${entry.last_passed ?? 'an earlier run'}${entry.files_changed.length ? `; files changed since: ${named(entry.files_changed)}` : ''}`).join('. ')}.` };
  } else if (stopNext?.reason === 'stop_stuck') {
    stopped = stopNext;
  } else {
    const open = latest ? failing(runs.length - 1) : checks.filter((entry) => entry.role === 'gating' && entry.baseline !== 'pass').map((entry) => `${entry.case}/${entry.check}=${entry.baseline ?? 'no baseline'}`);
    // A new loop counts only its own runs. When the code as it is now passed
    // a full run of an earlier loop of this Spec export, with these packages,
    // agent and model and no failure of that code, as after a stop with only
    // the final run left, nothing in it needs changing: it is run again.
    const fixedPlan = loopEntry?.run_plan ?? plan ?? {};
    const samePlanAs = (run) => ((fixedPlan.agent ?? null) === null || (run.environment_ref?.agent ?? null) === fixedPlan.agent)
      && (run.environment_ref?.model ?? null) === (fixedPlan.model ?? null);
    const passedBefore = !latest && readyCases.length && nowCode ? all.filter((run) => run.side === 'head' && usableRun(run) && (run.scope ?? 'full') === 'full'
      && run.spec_snapshot?.sha256 === loop.spec && run.started_at < loop.started_at && run.verdict === 'pass' && settled(run) && run.execution_status === 'completed'
      && identityOf(run) === nowCode && !packagesBetween(run, nowDigests).length && !gatingFailuresOf(run).length
      && samePlanAs(run)).at(-1) ?? null : null;
    const none = !readyCases.length && !unchecked.length;
    situation = { code: 'open', open, unchecked, pending_packages: pendingPackages, ...(passedBefore ? { passed_before: passedBefore.run_id } : {}), ...(none ? { no_package_connected: true } : {}),
      message: `${none ? 'No package is connected yet, so a run has nothing to run; connecting the packages changes them, which ends this loop. ' : ''}${passedBefore
        ? `The code as it is now passed run ${passedBefore.run_id} outside this loop, with these packages, and no run of it failed; this loop counts only its own runs. ` : ''}Open: ${open.join(', ') || 'none recorded'}.${unchecked.length
        ? ` A run skips ${unchecked.join(', ')} until \`eval check\` proves ${unchecked.length === 1 ? 'it' : 'them'} as ${unchecked.length === 1 ? 'it is' : 'they are'}.` : ''}` };
  }
  // A stop that holds replaces every situation that leads to another head run.
  if (!stopped && stopNext && situation && HEAD_RUN_SITUATIONS.includes(situation.code)) stopped = stopNext;
  if (stopped) situation = { code: 'ended' };
  // The Spec files differ from the current export, or it no longer validates.
  // That is no export: a loop that ended stays ended, and one the user's
  // acceptance covers stays done. A loop that goes on makes no head run and
  // no acceptance until the cause is known.
  if (!evals.spec && !['ended', 'accepted'].includes(situation.code)) {
    const edited = evals.gaps.some((entry) => entry.code === 'handoff_missing');
    const owner = evals.gaps.some((entry) => entry.owner === 'agent') || edited ? 'agent' : 'user';
    accepting = null;
    situation = { code: 'spec_invalid', owner, layer: 'spec', spec_edited: edited, gaps: evals.gaps.map((entry) => ({ code: entry.code, owner: entry.owner, message: entry.message })),
      message: edited ? `The Spec files differ from the export this loop started from (${String(loop.spec).slice(7, 19)}). A loop never changes the Spec; a changed requirement is the user's decision, with a new export and a new loop.`
        : `The Spec this loop started from no longer validates: ${evals.gaps.map((entry) => entry.message).join(' ')}` };
  }

  // Why the loop ended, or null. A recorded end comes first, then a fixed
  // input that changed, a lost loop.json, and a stop.
  const ended = closing ? { kind: 'recorded', ...closing,
    message: closing.reason === 'loop_end' ? `The loop was ended by ${closing.by ?? 'the agent'}${closing.ref ? ` (${closing.ref})` : ''}: ${(closing.text ?? 'no reason given').replace(/[.!?]$/, '')}.`
      : closing.reason === 'loop_decline' ? `${closing.by ?? 'The user'} declined to accept this loop${closing.ref ? ` (${closing.ref})` : ''}${closing.text ? `: ${closing.text}` : ''}.`
        : `${closing.by ?? 'The user'} abandoned this change${closing.ref ? ` (${closing.ref})` : ''}${closing.text ? `: ${closing.text}` : ''}, which ended this loop.` }
    : inputEnd && (inputEnd.reason === 'spec_exported' || situation.code === 'ended') && !(holds && inputEnd.reason !== 'spec_exported') ? { kind: 'input_changed', ...inputEnd }
      : recovered && !holds ? { kind: 'record_missing', reason: 'loop_record_missing', at: null, recovered_from: loop.recovered_from ?? [],
        message: `loop.json is missing or cannot be read, so the loop that started at ${loop.started_at} is known from its runs only and counts as ended.` }
        : stopped ? { kind: 'stop', ...stopped } : null;
  // What a new loop would need, and what changed in the code since the loop
  // started.
  if (ended) {
    const startPin = pinnedStart(repo, name)?.start ?? null;
    const exportNow = exported ?? loop.spec;
    const confirmationNow = exportNow === loop.spec ? confirmed : checksConfirmation(repo, name, exportNow);
    const recordedNow = exportNow ? recordedBaseline(repo, name, exportNow) : null;
    ended.code_files = base?.code_snapshot ? changedFiles(repo, base.code_snapshot, now) : [];
    ended.start_code = startFacts(name, startPin ?? (ended.accepted ? null : startNow));
    ended.new_loop = {
      gates: [
        { gate: 'checks_confirmation', holds: Boolean(confirmationNow.current), confirmation: confirmationNow.latest?.id ?? null,
          ...(confirmationNow.current ? {} : { packages: (confirmationNow.match?.packages ?? []).map((entry) => entry.id) }) },
        { gate: 'baseline_on_start_code', holds: Boolean(recordedNow && !isLost(recordedNow) && (!startPin || sameCode(recordedNow.code_snapshot, startPin, repo) === true)),
          baseline: recordedNow?.run_id ?? null, start_code: startFacts(name, startPin) },
        { gate: 'user_consent', holds: false, recorded_by: [command('loop', 'start').concat(['--by', '<user>', '--ref', '<where they said so>']), ['eval', 'confirm', name, '--start-loop']] },
      ],
      consents: ['new_loop', ...(ended.reason === 'stop_budget' ? ['budget'] : []), ...(['packages_changed', 'confirmation_changed', 'tier_changed', 'spec_exported'].includes(ended.reason) ? ['checks_confirmation'] : [])],
    };
  }
  const phase = situation.code === 'accepted' ? 'done' : ended ? 'ended' : (stopNext || exhausted) ? 'closing' : 'live';
  const accepted = situation.code === 'accepted' || (ended?.reason === 'spec_exported' && ended.accepted === true);

  // The final review: the run to accept needs one, recorded after the run it
  // reviewed finished, of the same code. A passing screen run can be
  // reviewed before its final run.
  const reviewTarget = accepting ?? candidate ?? (latest?.verdict === 'pass' && settled(latest) ? latest : null);
  const valid = accepting ? reviewsFor(records.reviews, accepting, runs, repo) : [];
  // What a Genesis review from the Spec's Map covers.
  const scopeOfMap = mapScope(evals.map, genesisReview(repo, name, evals.map, loop.base_commit));
  let review = null;
  if (reviewTarget && phase !== 'done' && phase !== 'ended') {
    const start = loop.start_code ?? {};
    const atStart = start.uncommitted_files ?? [];
    const untracked = (gitStatus(repo) ?? []).some((entry) => entry.code === '??' && !isGenerated(entry.file));
    const offered = genesisReview(repo, name, evals.map, loop.base_commit, { untracked, uncommittedAtStart: atStart });
    const compare = compareOf(runsDirectory, reviewTarget);
    review = { run_id: reviewTarget.run_id, code_digest: identityOf(reviewTarget), needed_for: accepting ? 'acceptance' : 'acceptance of a final run of this code',
      recorded: reviewsFor(records.reviews, reviewTarget, runs, repo).map(reviewSummary), satisfied: accepting ? valid.length > 0 : null,
      flips: flipsOf(compare), questions: ['flips: which change explains each', 'special_cases: whether the change special-cases an eval input', 'outside_spec: whether it changes anything the Spec does not ask for',
        'side_effects: whether it has a side effect no check covers'],
      reviewers: REVIEWERS,
      ...(offered ? { genesis_review: { ...offered, optional: true, ...scopeOfMap, ...(scopeOfMap?.scope_limited ? { map_partial: true } : {}) } } : {}),
      eval_literals: evalLiterals(repo, name, base?.code_snapshot ?? (loop.base_commit ? commitCode(repo, loop.base_commit) : null), now),
      ...(atStart.length ? { uncommitted_at_start: atStart, start_patch: start.patch ? `.genesis/edd/${name}/${start.patch}` : null } : {}),
      ...(loop.worktree_moved ? { worktree_moved_at_start: loop.moved_files ?? [] } : {}) };
  }

  // What acceptance would rest on, and what the user must be shown first.
  let strength = null;
  let lostProof = null;
  const history = { finals: finalsOfChange(repo, all), unknown: accepting ? unknownAttempts(repo, runsDirectory, all, identityOf(accepting), gating) : null };
  const openDisputes = records.disputes.filter((entry) => !entry.ruling);
  const testsOf = (code) => records.tests.filter((entry) => entry.code_digest && entry.code_digest === code);
  const usageFacts = { runs: usage.runs, minutes: usage.minutes, cost_usd: usage.cost_usd,
    tokens: usage.n_input_tokens === null && usage.n_output_tokens === null ? null : (usage.n_input_tokens ?? 0) + (usage.n_output_tokens ?? 0),
    trials: trials.map((run) => run.run_id), lost: lostRuns.map((run) => run.run_id), interrupted: interrupted.map((run) => run.run_id) };
  const budgetFacts = { original: loop.budget_original ?? records.revisions[0]?.from ?? budget, revisions: records.revisions, current: budget, used };
  const must = {};
  const add = (key, entries) => { if (entries?.length) must[key] = entries; };
  if (accepting) {
    strength = withAcceptedVerdicts(strengthOf(accepting, compareOf(runsDirectory, accepting), tier, history), loopEntry?.accepted_verdicts);
    lostProof = runProofs(repo, name, evals, loop, accepting, tier, loopEntry?.judge_gating ?? []);
    if (lostProof.unproven.length) warnings.push(`\`loop accept\` refuses ${accepting.run_id} as it stands (line_unproven): ${lostProof.text}`);
    const manual = manualOf(runsDirectory, accepting);
    const acceptingCompare = compareOf(runsDirectory, accepting);
    const fixed = flipKeys(acceptingCompare);
    add('checks', acceptingCompare.map((entry) => {
      const { case: id, check, then, role: kind, before, after, before_counts: beforeCounts, after_counts: afterCounts, verdict } = entry;
      return { case: id, check, then: then ?? null, role: kind, before, after, before_counts: beforeCounts ?? null, after_counts: afterCounts ?? null, verdict, label: verdictLabel(entry, fixed) };
    }));
    add('strength', [{ sentence: strength.sentence, tier, attempts: strength.attempts, pass_all_chance: strength.pass_all_chance, finals_of_change: strength.finals_of_change ?? null, unknown_attempts: strength.unknown_attempts ?? null }]);
    add('manual', manual.map((entry) => ({ ...entry, final_attempts: needed ? plan?.attempts ?? 1 : 1 })));
    add('self_review_lines', selfReviewOf(confirmed.latest));
    // The judged lines the loop's checks confirmation made gating, which the
    // acceptance holds like any gating line, with their proofs.
    add('judge_gating', lostProof.lines.filter((line) => line.judge_gating));
    // The lines whose weaker or stronger checks the user accepted.
    add('accepted_verdicts', loopEntry?.accepted_verdicts ?? []);
    add('reviews', valid.map(reviewSummary));
    add('map_scope', scopeOfMap?.scope_limited ? [{ ...scopeOfMap, genesis_reviews: valid.filter((entry) => entry.reviewer === 'genesis').map((entry) => entry.id) }] : []);
    add('review_findings', reviewFindings(valid));
    add('self_review', valid.filter((entry) => entry.reviewer === 'self').map(reviewSummary));
    add('eval_literals', review?.eval_literals ?? []);
    add('project_tests', testsOf(identityOf(accepting)).map((entry) => ({ ...entry, recorded_by: 'agent' })));
    add('disputes', records.disputes.map(disputeSummary));
    add('usage', [usageFacts]);
    if (records.revisions.length || (budget && exhausted)) add('budget', [budgetFacts]);
    add('pre_loop', loop.pre_loop?.runs ? [loop.pre_loop] : []);
    add('worktree_moved', loop.worktree_moved ? [{ files: loop.moved_files ?? [] }] : []);
    add('lost_runs', lostRuns.map((run) => ({ run_id: run.run_id, side: run.side, minutes: run.minutes ?? null })));
    add('old_package_failures', [...oldFailures].map(([id, ran]) => ({ case: id.split('\n')[0], check: id.split('\n')[1], runs: ran })));
    add('baseline_varied', baseOnly.map((group) => ({ case: group.case, check: group.check, pass: group.pass, fail: group.fail })));
    add('final_runs_of_change', history.finals.total ? [{ total: history.finals.total, failed: history.finals.failed, unverified: history.finals.unverified }] : []);
    add('unknown_attempts', history.unknown?.unknown ? [history.unknown] : []);
  } else if (phase === 'ended') {
    add('end', [without(ended, 'message')]);
    add('usage', [usageFacts]);
    add('budget', [budgetFacts]);
    add('disputes', records.disputes.map(disputeSummary));
    add('lost_runs', lostRuns.map((run) => ({ run_id: run.run_id, side: run.side, minutes: run.minutes ?? null })));
  } else if (openDisputes.length) {
    add('disputes', openDisputes.map(disputeSummary));
  }
  const must_show = Object.keys(must).length ? must : null;

  // The obligations the CLI cannot verify: a final review it sees only as a
  // record, what the user must be shown, and the user's consent.
  const obligations = [
    ...(accepting ? [
      { kind: 'review', run_id: accepting.run_id, code_digest: identityOf(accepting), recorded: valid.length > 0, checked_by_cli: 'that a review of this code was recorded after the run it reviewed' },
      { kind: 'disclosure', before: 'acceptance', items: Object.keys(must) },
      { kind: 'consent', decision: 'acceptance', by: 'user', run_id: accepting.run_id },
    ] : []),
    ...(situation.code === 'final_run_due' ? [{ kind: 'review', run_id: candidate.run_id, code_digest: identityOf(candidate), recorded: reviewsFor(records.reviews, candidate, runs, repo).length > 0,
      checked_by_cli: 'needed before acceptance; a review of this code covers its final run' }] : []),
    ...(phase === 'ended' ? [{ kind: 'consent', decision: ended.reason === 'stop_budget' ? 'budget or new loop' : 'new loop', by: 'user' },
      { kind: 'disclosure', before: 'a new loop', items: Object.keys(must) }] : []),
    ...(phase === 'closing' && exhausted ? [{ kind: 'consent', decision: 'budget', by: 'user', budget, used }] : []),
    ...(openDisputes.length ? [{ kind: 'consent', decision: 'dispute ruling', by: 'user', disputes: openDisputes.map((entry) => entry.id) }] : []),
    ...(phase === 'done' && !situation.committed ? [{ kind: 'consent', decision: 'commit, merge or pull request', by: 'user' }] : []),
    ...(loop.worktree_moved && phase !== 'done' ? [{ kind: 'disclosure', item: 'worktree_moved', files: loop.moved_files ?? [] }] : []),
  ];

  // At most one suggestion; the agent decides the path.
  const runCommand = unchecked.length ? command('eval', 'check') : command('run', 'start');
  const suggestion = (() => {
    if (phase === 'ended' || phase === 'done' || situation.code === 'spec_invalid') return null;
    if (accepting) {
      return valid.length
        ? { command: [...command('loop', 'accept'), '--run', accepting.run_id, '--by', '<user>', '--ref', '<where they said so>'], why: 'A review of this code is recorded; acceptance is the user\'s decision.' }
        : { command: [...command('loop', 'review'), '--run', accepting.run_id, '--answers', '<file>', '--reviewer', '<subagent|human|genesis|self>'], why: 'Acceptance needs a final review recorded for this code.' };
    }
    if (exhausted) return null;
    // With no package connected, a run has nothing to run: run start refuses it.
    if (situation.no_package_connected) return null;
    if (situation.code === 'final_run_due') return { command: runCommand, why: `The final run of screen run ${candidate.run_id} is due.` };
    if (['open', 'code_moved', 'run_not_settled', 'final_failed', 'screen_burned', 'execution_incomplete'].includes(situation.code)) return { command: runCommand, why: unchecked.length ? `A run skips ${unchecked.join(', ')} until it is proved.` : 'A full run compares the code as it is now with the baseline.' };
    return null;
  })();

  const status = {
    change: name, phase,
    loop: { started_at: loop.started_at, spec: loop.spec ?? null, base_commit: loop.base_commit ?? null, baseline: loop.baseline, baseline_available: loop.baseline_available ?? null,
      start_code: startFacts(name, startNow), start_from: loop.start_from ?? null, worktree_moved: loop.worktree_moved ?? null, moved_files: loop.moved_files ?? [],
      pre_loop: loop.pre_loop ?? null, consent: loop.consent ?? null,
      run_plan: plan, tier, stop_on_stuck: stopOnStuck, budget, budget_original: budgetFacts.original, budget_revisions: records.revisions,
      clock_started_at: clock, used, exhausted, checks_confirmation: loop.checks_confirmation ?? null, budget_source: loop.budget_source ?? null, follows: loop.follows ?? null,
      ...(recovered ? { recovered_from: loop.recovered_from ?? [] } : {}),
      // A screen run, the final run and a full run by earlier attempts, and
      // what the loop's runs took and used so far.
      estimate, usage, trials: usageFacts.trials, lost_runs: usageFacts.lost, interrupted_runs: usageFacts.interrupted },
    // The newest checks confirmation of the loop's Spec export, whether it
    // covers the packages as they are, and the packages changed since it.
    confirmation: confirmed.latest ? { id: confirmed.latest.id, at: confirmed.latest.confirmed?.at ?? null, by: confirmed.latest.confirmed?.by ?? null,
      kind: confirmed.latest.confirmed?.kind ?? null, current: confirmed.match.matches, unconfirmed } : null,
    runs: runs.map((run) => ({ run_id: run.run_id, role: roleOf(run), commit: run.code_snapshot?.commit ?? null, patch: run.code_snapshot?.patch ?? null, execution_status: run.execution_status,
      verdict: run.verdict, report: reportState(repo, name, run) })),
    // Screen and final runs: whether this loop needs a final run, the screen
    // run whose final run is due, and the final runs that count.
    final,
    partial_runs: ours.length - runs.length, checks, regressions, lost_progress: lost, stuck, changed_packages: changedPackages,
    // The gating checks that passed and failed on the code of one of this
    // loop's runs, with its packages.
    unstable: unstable.map((group) => ({ case: group.case, check: group.check, intent: keys.find((key) => key.case === group.case && key.check === group.check)?.intent ?? null,
      agent: group.agent, model: group.model, pass: group.pass, fail: group.fail })),
    accepted,
    acceptance: acceptedRecord ? { run_id: acceptedRecord.run_id, by: acceptedRecord.accepted?.by ?? null, ref: acceptedRecord.accepted?.ref ?? null, at: acceptedRecord.accepted?.at ?? null,
      holds, ...(holds ? {} : { outdated: true }) } : null,
    // Where the loop stands, why it ended, and the stop that holds.
    situation: situation.code === 'ended' ? { code: 'ended', reason: ended?.reason ?? null } : situation,
    ended, stop: stopNext ? { code: stopNext.reason, ...without(stopNext, 'reason') } : null,
    declined: declined ? decisionFacts(declined) : null, abandoned: abandoned ? decisionFacts(abandoned) : null,
    strength, ...(accepting ? { proofs: { unproven: lostProof.unproven.map((row) => ({ case: row.case, then: row.then, ...(row.status === 'manual' ? { judge_gating: true } : {}) })) } } : {}),
    review, reviews: records.reviews.map(reviewSummary), map_scope: scopeOfMap, disputes: records.disputes.map(disputeSummary), tests: records.tests,
    final_runs_of_change: history.finals, ...(history.unknown ? { unknown_attempts: history.unknown } : {}),
    gates: null, obligations, must_show, warnings, suggestion,
  };
  // The gates the CLI holds now: for a head run or a trial in this loop, and
  // for an acceptance.
  status.gates = {
    head_run: headRunGap(status),
    accept: [
      ...(endGap(status) ? [endGap(status)] : []),
      ...(situation.code === 'spec_invalid' ? [gap('spec_changed', 'spec', situation.message, situation.owner)] : []),
      ...(phase !== 'done' && !accepting && !endGap(status) ? [gap('nothing_to_accept', 'loop', 'No run of this loop can be accepted now: only a passing run of the loop\'s plan on the code as it is now can be.', 'agent')] : []),
      ...(accepting && !valid.length ? [reviewMissing(accepting)] : []),
      ...(lostProof?.unproven.length ? [gap('line_unproven', 'package', lostProof.text, 'agent', 'artifact', { cases: [...new Set(lostProof.unproven.map((row) => row.case))],
        ...(lostProof.judged.length ? { judged: lostProof.judged } : {}) })] : []),
    ],
  };
  return status;
}

// The gap of an acceptance that no recorded final review covers.
const reviewMissing = (run) => gap('review_missing', 'loop', `No final review is recorded for the code of ${run.run_id} after the run it reviewed finished. Acceptance needs one: a final review records who reviewed, which change explains each check that went from not passing to passing, whether the change special-cases an eval input, whether it changes anything the Spec does not ask for, and whether it has a side effect no check covers.`,
  'agent', 'artifact', { run: run.run_id });

// Application files whose content differs between the code of two runs. Each
// run's code is its commit plus the digests of the files that commit does not
// hold, so a file is compared by its content in each, wherever it lives.
export function changedFiles(repo, before, after) {
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

// The numbers and longer literals of a package's input: a number of two or
// more digits; text in quotes; and a word of six or more characters that
// holds a digit, @, : or /, such as an id, a date, an address or a path. The
// template comment eval new writes is left out.
function literalsOf(text) {
  const plain = text.replace(/<!--[\s\S]*?-->/g, ' ');
  const found = new Set();
  for (const match of plain.matchAll(/(?<![\w.])\d+(?:[.,]\d+)*(?!\w)/g)) if (match[0].replace(/\D/g, '').length >= 2) found.add(match[0]);
  for (const match of plain.matchAll(/"([^"\n]{2,200})"|`([^`\n]{2,200})`|“([^”\n]{2,200})”|‘([^’\n]{2,200})’|「([^」\n]{2,200})」|『([^』\n]{2,200})』/g)) {
    const value = match.slice(1).find((part) => part !== undefined)?.trim() ?? '';
    // ASCII text needs four characters to say something; two do in Chinese.
    if (value.length >= 4 || (value.length >= 2 && /[^\x00-\x7f]/.test(value))) found.add(value);
  }
  for (const match of plain.matchAll(/[A-Za-z0-9][\w.@:/+-]{4,}[A-Za-z0-9]/g)) if (/\d/.test(match[0]) || /[@:/]/.test(match[0])) found.add(match[0]);
  return [...found];
}

// The literals of every package's instruction.md, one per step of a
// multi-step package too: Map of literal to the ids of the packages.
function instructionLiterals(repo, name) {
  const root = path.join(eddDirectory(repo, name), 'evals');
  const found = new Map();
  let ids = [];
  try { ids = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return found; }
  for (const id of ids) {
    const files = [path.join(root, id, 'instruction.md')];
    try { files.push(...readdirSync(path.join(root, id, 'steps')).sort().map((step) => path.join(root, id, 'steps', step, 'instruction.md'))); } catch { /* one step */ }
    for (const file of files) {
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const literal of literalsOf(text)) found.set(literal, new Set([...(found.get(literal) ?? []), id]));
    }
  }
  return found;
}

// The lines the change added to application files: those of each file that
// differs between before and the code on disk and that its commit in before
// did not hold, by their text. A file that before held uncommitted is read
// from that commit, so edits made before the loop may count as added too.
// Binary files and files over 1 MB are left out. [{ file, line, text }].
function addedLines(repo, before, now) {
  const added = [];
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  for (const file of changedFiles(repo, before, now)) {
    let after;
    try { after = readFileSync(path.join(repo, file)); } catch { continue; }
    if (after.length > 1024 * 1024 || after.includes(0)) continue;
    const shown = before?.commit ? git(['cat-file', '--filters', `${before.commit}:${file}`]) : null;
    const old = shown?.status === 0 && !shown.stdout.includes(0) ? shown.stdout.toString('utf8') : '';
    const counts = new Map();
    for (const line of old.split('\n')) counts.set(line.trimEnd(), (counts.get(line.trimEnd()) ?? 0) + 1);
    after.toString('utf8').split('\n').forEach((line, index) => {
      const text = line.trimEnd();
      const left = counts.get(text) ?? 0;
      if (left) counts.set(text, left - 1);
      else if (text.trim()) added.push({ file, line: index + 1, text });
    });
  }
  return added;
}

// Paths of test files: a tests, __tests__ or spec folder, test_*.py,
// *_test.py or *_test.go, and *.test.js or *.spec.ts and the like.
const TEST_PATHS = [/(^|\/)(tests?|__tests__|spec)\//, /(^|\/)test_[^/]*\.py$/, /_test\.(py|go)$/, /\.(test|spec)\.[cm]?[jt]sx?$/];
const isTestPath = (file) => TEST_PATHS.some((pattern) => pattern.test(file));

// The literals of the packages' instruction.md that appear in lines the
// change added since before, the code the loop started on: a hint for the
// final review that the change may special-case an eval input, never a
// verdict. A line of a test file is marked test, and a literal found only in
// test files only_tests; lines outside tests come first, and so do literals
// found outside tests. [{ literal, packages, only_tests?, lines: [{ file,
// line, test? }] }], at most 50, each with its first five lines.
function evalLiterals(repo, name, before, now) {
  const literals = instructionLiterals(repo, name);
  if (!literals.size || !before) return [];
  const added = addedLines(repo, before, now);
  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [];
  for (const [literal, ids] of literals) {
    const number = /^\d[\d.,]*$/.test(literal) ? new RegExp(`(?<![\\w.])${escaped(literal)}(?!\\w)`) : null;
    const matched = added.filter((entry) => (number ? number.test(entry.text) : entry.text.includes(literal)))
      .map(({ file, line }) => ({ file, line, ...(isTestPath(file) ? { test: true } : {}) }));
    if (!matched.length) continue;
    const onlyTests = matched.every((entry) => entry.test);
    const lines = [...matched.filter((entry) => !entry.test), ...matched.filter((entry) => entry.test)].slice(0, 5);
    found.push({ literal, packages: [...ids].sort(), ...(onlyTests ? { only_tests: true } : {}), lines });
  }
  return [...found.filter((entry) => !entry.only_tests), ...found.filter((entry) => entry.only_tests)].slice(0, 50);
}

// The eval package and project kit files that differ between two runs, for a
// report: each file of a package or of the kit whose digest differs, and a
// package on one side only. A run recorded before it listed its files names
// each package whose task digest differs instead. { files, same_run }:
// same_run holds the files of packages whose run digest is the same in both
// runs, such as a fixture or a proof, so both runs executed the same package.
function evalChanges(name, before, after) {
  if (!before || !after) return { files: [], same_run: [] };
  const folder = (id) => `.genesis/edd/${name}/evals/${id}/`;
  if (before.eval_snapshot && after.eval_snapshot) {
    const changed = evalFilesChanged(before.eval_snapshot, after.eval_snapshot);
    const sameRun = (id) => nonempty(before.run_digest?.[id]) && before.run_digest[id] === after.run_digest?.[id];
    const listed = (entries) => entries.flatMap(([id, files]) => (typeof files === 'string' ? [`\`${folder(id)}\` (${files})`]
      : files.map((file) => `\`${folder(id)}${file}\``)));
    const entries = Object.entries(changed.packages);
    return { files: [...listed(entries.filter(([id]) => !sameRun(id))), ...changed.kit.map((file) => `\`.genesis/edd/harness/${file}\``)].sort(),
      same_run: listed(entries.filter(([id]) => sameRun(id))).sort() };
  }
  return { files: changedBetween(before.task_digest, after.task_digest)
    .map((id) => `\`${folder(id)}\` (it or the kit changed; this run record lists no files)`), same_run: [] };
}

// Text in a cell of a Markdown table: one line, with its pipes escaped.
const cell = (text) => String(text).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

// One side of a check in the Result table: its result with its passes out of
// its attempts, or a dash when there is no result.
const resultCell = (result, counts) => (result === null || result === undefined ? '—'
  : counts ? `${result} (${counts.pass}/${counts.pass + counts.fail + counts.unknown})` : result);

// The checks of a comparison that went from not passing to passing (flipsOf),
// as `case\ncheck`.
const flipKeys = (compare) => new Set(flipsOf(compare).map((entry) => `${entry.case}\n${entry.check}`));

// A check's verdict as a report or must_show labels it: a holds that went
// from not passing to passing is fixed, one that passed before is kept.
const verdictLabel = (entry, fixed) => (entry.verdict !== 'holds' ? entry.verdict
  : fixed.has(`${entry.case}\n${entry.check}`) ? 'holds (fixed)' : entry.before === 'pass' ? 'holds (kept)' : entry.verdict);

// Writes the report of a full run: Result and Changes, taken from the
// records, and a Notes section that is the agent's to fill or leave. It
// never overwrites a report. The final review is recorded with `loop review`,
// not in the report.
export function writeReport(repo, name, options = {}) {
  const status = loopStatus(repo, name);
  if (status.situation?.local_records === false) throw localRecordsMissing(status, 'No report can be written');
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const id = options.run ?? status.runs.at(-1)?.run_id;
  const index = status.runs.findIndex((run) => run.run_id === id);
  if (index < 0) throw new Error(`${id ?? 'No run'} is not a full run of this loop. Reports cover full runs only.`);
  const file = reportFile(repo, name, id);
  if (existsSync(file)) return { file, created: false, written: ['Result', 'Changes'] };
  const run = readJSON(path.join(runsDirectory, id, 'run.json'));
  const compare = compareOf(runsDirectory, run);
  const fixed = flipKeys(compare);
  const manual = manualOf(runsDirectory, run);
  // A final run is compared with its screen run, whose code it ran again.
  const all = readRuns(runsDirectory);
  const screen = run.role === 'final' && run.final_of ? all.find((entry) => entry.run_id === run.final_of && usableRun(entry)) ?? null : null;
  const before = screen ?? (index ? readJSON(path.join(runsDirectory, status.runs[index - 1].run_id, 'run.json'))
    : all.find((entry) => entry.run_id === status.loop.baseline && usableRun(entry)) ?? null);
  const files = changedFiles(repo, before?.code_snapshot, run.code_snapshot);
  const evalFiles = evalChanges(name, before, run);
  const from = screen ? `screen run ${screen.run_id}` : index ? `run ${status.runs[index - 1].run_id}` : `the baseline ${status.loop.baseline}`;
  const baseline = run.baseline ?? `unavailable (${run.baseline_unavailable_reason})`;
  const codeChanges = screen && !files.length ? `Same code as screen run ${screen.run_id}: no file changed.`
    : `Files changed since ${from}:\n${files.length ? files.map((item) => `- \`${item}\``).join('\n') : '- none'}`;
  const of = status.loop.budget ? ` of ${status.loop.budget.iterations}` : '';
  const text = `# ${name}: run ${id}${screen ? ` (final run of ${screen.run_id})` : ''}

Code \`${short(run.code_snapshot?.commit)}\`${run.code_snapshot?.patch ? ' + code.patch' : ''} · verdict \`${run.verdict}\` · baseline \`${baseline}\` · run ${index + 1}${of} · tier \`${status.loop.tier}\`

## Result

Only gating checks decide the verdict; a diagnostic result is shown for reference. Each result shows its passes out of its attempts.

| Case | Check | Requirement | THEN | Role | Before → After | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
${compare.map((entry) => `| ${entry.case} | ${entry.check} | ${entry.intent} | ${entry.then ? cell(entry.then) : '—'} | ${entry.role ?? '—'} | ${resultCell(entry.before, entry.before_counts)} → ${resultCell(entry.after, entry.after_counts)} | ${verdictLabel(entry, fixed)} |`).join('\n')}
${stoppedText(run)}${manual.length ? `
No check verifies these lines; the user judges them at acceptance:

| Case | THEN | Why no check |
| --- | --- | --- |
${manual.map((entry) => `| ${entry.case} | ${cell(entry.then)} | ${cell(entry.reason)} |`).join('\n')}
` : ''}
## Changes

Eval package and project kit files changed since ${from}:
${evalFiles.files.length ? evalFiles.files.map((item) => `- ${item}`).join('\n') : '- none'}
${evalFiles.same_run.length ? `
Fixtures added or changed (what a run executes is unchanged):
${evalFiles.same_run.map((item) => `- ${item}`).join('\n')}
` : ''}
${codeChanges}

## Notes

<!-- Free notes: the cause of an open check, what was tried, anything the user should read. The CLI wrote Result and Changes; the final review is recorded with \`loop review\`. -->
`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { flag: 'wx' });
  return { file, created: true, written: ['Result', 'Changes'] };
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

// What proves, for each line a program checks of a run's packages, that its
// checks can fail, as an acceptance of the run needs it: in the light tier
// its real failure at the loop's baseline, which ran the package of the run,
// or a reviewer's counterexample that the last eval check of the package as
// it is proved; in the full tier such a counterexample, which made the
// package ready. A line of scenario.manual whose judge check the loop's
// checks confirmation made gating (judgeGating, `case:then` entries) is held
// too, in either tier, by either proof: no package readiness rule holds a
// judge check, so nothing else shows that it can fail. { lines: [{ package,
// then, checks, proof, judge_gating }], unproven: [row], judged: [{ case,
// then, checks }], text }, judged being the held judged lines with no proof,
// text saying what is missing when a line has no proof.
function runProofs(repo, name, evals, loop, run, tier, judgeGating = []) {
  const found = readRuns(path.join(eddDirectory(repo, name), 'runs')).find((item) => item.run_id === loop.baseline) ?? null;
  const base = found && !isLost(found) ? found : null;
  const proofs = lineProofs(repo, name, evals, { base, head: { task_digest: run.task_digest ?? {}, run_digest: run.run_digest ?? {} } });
  const light = tier === 'light';
  const gatingJudges = Array.isArray(judgeGating) ? judgeGating.map(String) : [];
  const held = (row) => row.status === 'manual' && Array.isArray(row.judges) && row.judges.length > 0 && gatingJudges.includes(judgeKey(row.case, row.then));
  const judgeChecks = (row) => row.judges.map((entry) => entry.check);
  const rows = (evals.then_lines ?? []).filter((row) => (row.status === 'gating' || held(row)) && Object.hasOwn(run.task_digest ?? {}, row.case));
  const proofOf = (row) => proofs.get(proofKey(row.case, row.then));
  const unproven = rows.filter((row) => (light || held(row) ? !proofOf(row)?.sources.length : !proofOf(row)?.sources.includes('counterexample')));
  const missingOf = (row) => (proofOf(row)?.missing ?? ['no proof could be read']).join('; ');
  const lacking = unproven.filter((row) => !held(row));
  const judged = unproven.filter(held);
  const parts = [
    ...(!lacking.length ? [] : [light
      ? `in the light tier every line a program checks needs a proof that its checks can fail, and these lines have none now: ${lacking.map((row) => `${row.case} "${row.then}" (${missingOf(row)})`).join('; ')}. A line this change fixes is proved by its failure, with evidence, at the loop's baseline ${loop.baseline}, which ran the package of ${run.run_id}; any other line by a reviewer's counterexample that \`eval check\` proved for the package as it is.`
      : `every line a program checks needs a reviewer's counterexample that \`eval check\` proved for the package as it is, and these lines have none now: ${lacking.map((row) => `${row.case} "${row.then}"`).join('; ')}.`]),
    ...(!judged.length ? [] : [`a line whose judge check the loop's checks confirmation made gating needs a proof that the check can fail, in either tier, and these judged lines have none now: ${judged.map((row) => `${row.case} "${row.then}" (judged by ${judgeChecks(row).join(', ')}) (${missingOf(row)})`).join('; ')}. Such a line is proved by its judge checks failing, with evidence, at the loop's baseline ${loop.baseline}, which ran the package of ${run.run_id}, or by a reviewer's counterexample that names the line in its then, expects fail for its judge checks and that \`eval check\` proved for the package as it is.`]),
  ];
  const text = parts.map((part, index) => (index ? `${part[0].toUpperCase()}${part.slice(1)}` : part)).join(' ');
  return { unproven, text, judged: judged.map((row) => ({ case: row.case, then: row.then, checks: judgeChecks(row) })), lines: rows.map((row) => {
    const proof = proofOf(row);
    return { package: row.case, then: row.then, checks: held(row) ? judgeChecks(row) : (row.gating ?? []).map((entry) => entry.check),
      // A line of scenario.manual whose judge check the user made gating.
      ...(held(row) ? { judge_gating: true } : {}),
      proof: { sources: proof?.sources ?? [], baseline: proof?.baseline ?? null, counterexamples: proof?.counterexamples ?? [] } };
  }) };
}

// The loop of loop.json with its status, for a command that records something
// in it. A loop known only from its runs takes no record: loop.json is gone,
// and the loop counts as ended.
function recordableLoop(repo, name, what) {
  const loop = readLoopSafe(repo, name);
  if (!loop) {
    const known = recordedLoop(repo, name);
    const elsewhere = known ? null : acceptedElsewhere(repo, name);
    if (elsewhere) throw localRecordsMissing(elsewhere, what);
    throw blocked(`${what}: no loop.json.`, [gap('loop_missing', 'loop', known
      ? `loop.json is missing or cannot be read, so the loop that started at ${known.started_at} is known from its runs only and counts as ended.`
      : 'No loop has started for this change.', 'user', 'business')]);
  }
  return { loop, status: loopStatus(repo, name) };
}

// A file named by an option, read whole: { bytes, shown }, shown being its
// path relative to the project when it is inside it.
function readGiven(repo, file, flag) {
  const absolute = path.resolve(file);
  let bytes;
  try { bytes = readFileSync(absolute); } catch (error) { throw new Error(`${flag} ${file} cannot be read: ${error.message}`); }
  const relative = path.relative(repo, absolute);
  return { bytes, shown: relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : absolute };
}

// Why the answers of a final review do not cover what it must answer: every
// check of the reviewed run that went from not passing to passing (flips)
// with the change that explains it, whether the change special-cases an eval
// input, whether it changes anything the Spec does not ask for, and whether
// it has a side effect no check covers. A finding needs its detail. [] when
// they do.
function answersProblems(answers, flips) {
  if (!isRecord(answers)) return ['the file holds no JSON object'];
  const problems = [];
  const given = Array.isArray(answers.flips) ? answers.flips : null;
  if (!given) problems.push('flips is not a list of { case, check, explained_by }');
  const key = (entry) => `${entry?.case}\n${entry?.check}`;
  const answered = new Map((given ?? []).filter(isRecord).map((entry) => [key(entry), entry]));
  const missing = flips.filter((flip) => !nonempty(answered.get(key(flip))?.explained_by));
  if (missing.length) problems.push(`no explained_by for ${missing.map((flip) => `${flip.case}/${flip.check}`).join(', ')}, which went from not passing to passing against the baseline`);
  for (const field of REVIEW_FINDINGS) {
    const value = answers[field];
    if (!isRecord(value) || typeof value.found !== 'boolean') problems.push(`${field}.found is not true or false`);
    else if (value.found && !nonempty(value.detail)) problems.push(`${field}.detail is empty although ${field}.found is true`);
    else if (value.detail !== undefined && value.detail !== null && typeof value.detail !== 'string') problems.push(`${field}.detail is not text`);
  }
  if (answers.notes !== undefined && answers.notes !== null && typeof answers.notes !== 'string') problems.push('notes is not text');
  return problems;
}

// Records a final review of a passing run of the running loop: who reviewed
// (reviewer: subagent, human, genesis or self, and by), the run and the
// content digest of its code, and the answers, copied with their digest.
// Every check of the run that went from not passing to passing against the
// baseline must be answered. The review covers acceptance of a run of the
// same code, the final run of a reviewed screen run included. A self review
// is shown to the user and written into the acceptance.
export function reviewLoop(repo, name, options = {}) {
  if (!REVIEWERS.includes(options.reviewer)) throw new Error(`--reviewer is one of ${REVIEWERS.join(', ')}: who did the final review.`);
  if (!nonempty(options.run)) throw new Error('--run names the passing run of this loop that was reviewed.');
  if (!nonempty(options.answers)) throw new Error('--answers names the JSON file with the review\'s answers.');
  const { bytes, shown } = readGiven(repo, options.answers, '--answers');
  let answers;
  try { answers = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`--answers ${options.answers} is not JSON: ${error.message}`); }
  const { loop, status } = recordableLoop(repo, name, 'The final review cannot be recorded');
  const root = eddDirectory(repo, name);
  const runsDirectory = path.join(root, 'runs');
  const gaps = [];
  const phase = loopPhase(status);
  if (phase === 'ended') gaps.push(endGap(status));
  if (phase === 'done') gaps.push(gap('already_accepted', 'loop', `The user accepted run ${status.acceptance?.run_id ?? 'unknown'} of this loop already.`, 'user', 'business'));
  const listed = status.runs.find((entry) => entry.run_id === options.run);
  let run = null;
  if (!listed) gaps.push(gap('run_unknown', 'loop', `${options.run} is not a full run of this loop.`, 'agent', 'artifact', { run: options.run }));
  else {
    try { run = readJSON(path.join(runsDirectory, listed.run_id, 'run.json')); } catch { /* below */ }
    if (!run) gaps.push(gap('run_unreadable', 'ledger', `The run record of ${listed.run_id} cannot be read.`, 'agent', 'artifact', { run: listed.run_id }));
  }
  if (run && (run.verdict !== 'pass' || run.execution_status !== 'completed' || run.code_changed_during_run || run.packages_changed_during_run)) {
    gaps.push(gap('not_passing', 'loop', `${run.run_id} has verdict ${run.verdict}${run.execution_status !== 'completed' ? ` and did not complete` : ''}${run.code_changed_during_run || run.packages_changed_during_run ? ', and its code or packages changed while it ran' : ''}; a final review is of a passing run.`, 'agent', 'artifact', { run: run.run_id }));
  }
  const code = run ? codeIdentity(run.code_snapshot, repo) : null;
  if (run && !code) gaps.push(gap('code_unknown', 'code', `The code of ${run.run_id} has no content digest, so a review cannot be bound to it.`, 'agent', 'artifact', { run: run.run_id }));
  const flips = run ? flipsOf(compareOf(runsDirectory, run)) : [];
  const problems = run ? answersProblems(answers, flips) : [];
  if (problems.length) gaps.push(gap('review_answers_incomplete', 'loop', `The answers in ${shown} are incomplete: ${problems.join('; ')}.`, 'agent', 'artifact', { path: shown, flips, problems }));
  if (gaps.length) throw blocked(`The final review cannot be recorded: ${gaps.map((entry) => entry.message).join(' ')}`, gaps);
  const at = new Date().toISOString();
  const warnings = [];
  const key = (entry) => `${entry.case}\n${entry.check}`;
  const needed = new Set(flips.map(key));
  const extra = answers.flips.filter((entry) => isRecord(entry) && !needed.has(key(entry))).map((entry) => `${entry.case}/${entry.check}`);
  if (extra.length) warnings.push(`The answers also explain ${extra.join(', ')}, which did not go from not passing to passing in ${run.run_id}; they are kept as given.`);
  const records = loopRecords(loop, readDecisions(root).entries);
  const evals = validateEval(repo, name);
  const scopeOfMap = mapScope(evals.map, genesisReview(repo, name, evals.map, loop.base_commit));
  const review = {
    id: `review-${records.reviews.length + 1}`, at, run_id: run.run_id, role: listed.role ?? null, run_finished_at: run.finished_at ?? null,
    code_digest: code, commit: run.code_snapshot?.commit ?? null, reviewer: options.reviewer, by: nonempty(options.by) ? options.by.trim() : null,
    answers_file: shown, answers_digest: digest(bytes),
    answers: { flips: answers.flips.filter(isRecord).map((entry) => ({ case: entry.case, check: entry.check, explained_by: typeof entry.explained_by === 'string' ? entry.explained_by.trim() : entry.explained_by ?? null })),
      ...Object.fromEntries(REVIEW_FINDINGS.map((field) => [field, { found: answers[field].found, detail: nonempty(answers[field].detail) ? answers[field].detail.trim() : null }])),
      notes: nonempty(answers.notes) ? answers.notes.trim() : null },
    flips, findings: Object.fromEntries(REVIEW_FINDINGS.map((field) => [field, answers[field].found])),
    // A Genesis review covers what the Spec's Map covers.
    ...(options.reviewer === 'genesis' && scopeOfMap ? { map_scope: scopeOfMap, ...(scopeOfMap.scope_limited ? { map_partial: true } : {}) } : {}),
  };
  loop.reviews = [...(Array.isArray(loop.reviews) ? loop.reviews : []), review];
  saveLoop(repo, name, loop);
  appendDecision(root, { type: 'loop_review', loop_started_at: loop.started_at, ...review });
  if (options.reviewer === 'self') warnings.push('This is a self review: the agent that changed the code reviewed it. The acceptance records that, and the user is shown it.');
  if (review.map_scope?.scope_limited) warnings.push(review.map_scope.scope_note);
  const findings = reviewFindings([review]);
  // The runs of this loop the review covers: those of the same code.
  const covers = status.runs.filter((entry) => {
    try { return codeIdentity(readJSON(path.join(runsDirectory, entry.run_id, 'run.json')).code_snapshot, repo) === code; } catch { return false; }
  }).map((entry) => entry.run_id);
  return { review: reviewSummary(review), loop_started_at: loop.started_at, code_digest: code, covers, findings,
    ...(findings.length || review.reviewer === 'self' ? { must_show: { ...(findings.length ? { review_findings: findings } : {}), ...(review.reviewer === 'self' ? { self_review: [reviewSummary(review)] } : {}) } } : {}),
    warnings, suggestion: null };
}

// Revises the budget of the running loop, or lets a loop that ended only
// because its budget ran out go on: the user's decision, by and ref saying
// who decided and where. The revision is kept in loop.json with the budget
// before it, and as a loop_budget decision; the acceptance records the
// original budget, every revision and the budget each run fell under.
export function budgetLoop(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who agreed to the budget and where they said so. A budget is the user\'s decision.');
  const values = { iterations: options.maxIterations ?? options.iterations, minutes: options.maxMinutes ?? options.minutes, maxCost: options.maxCost };
  if (values.iterations === undefined && values.minutes === undefined && values.maxCost === undefined) throw new Error('Give at least one of --max-iterations, --max-minutes and --max-cost.');
  const { loop, status } = recordableLoop(repo, name, 'The budget cannot be revised');
  const phase = loopPhase(status);
  const budgetEnd = status.ended?.reason === 'stop_budget';
  const gaps = [];
  if (phase === 'done') gaps.push(gap('already_accepted', 'loop', `The user accepted run ${status.acceptance?.run_id ?? 'unknown'} of this loop already.`, 'user', 'business'));
  else if (phase === 'ended' && !budgetEnd) {
    gaps.push({ ...endGap(status), message: `${status.ended.message} Only a loop that ended because its budget ran out goes on with a revised budget.` });
  }
  if (!isRecord(loop.budget)) gaps.push(gap('budget_unknown', 'loop', 'loop.json records no budget for this loop, so there is nothing to revise.', 'user', 'business'));
  if (gaps.length) throw blocked(`The budget cannot be revised: ${gaps.map((entry) => entry.message).join(' ')}`, gaps);
  const revised = budgetOptions(values, loop.budget);
  const at = new Date().toISOString();
  const revision = { at, by: options.by.trim(), ref: options.ref.trim(), from: loop.budget, to: revised, used: status.loop.used, after_runs: status.runs.length, resumed: budgetEnd };
  loop.budget_original ??= loop.budget;
  loop.budget_revisions = [...(Array.isArray(loop.budget_revisions) ? loop.budget_revisions : []), revision];
  loop.budget = revised;
  saveLoop(repo, name, loop);
  appendDecision(eddDirectory(repo, name), { type: 'loop_budget', loop_started_at: loop.started_at, ...revision });
  const after = loopStatus(repo, name);
  const warnings = [];
  if (after.loop.exhausted) warnings.push(`The revised budget, ${budgetLimits(revised)}, is still used up (${budgetText(revised, after.loop.used)}).`);
  if (after.phase === 'ended') warnings.push(`The loop stays ended: ${after.ended.message}`);
  return { budget: revised, revision, budget_original: loop.budget_original, revisions: loop.budget_revisions, used: after.loop.used, exhausted: after.loop.exhausted,
    phase: after.phase, resumed: budgetEnd && after.phase !== 'ended', ended: after.ended, warnings, suggestion: null };
}

// Ends the running loop with a reason: the agent's or the user's call, the
// user's when by and ref are given. The start code stays pinned. The end is
// kept in loop.json and as a loop_end decision.
export function endLoop(repo, name, options = {}) {
  if (!nonempty(options.reason)) throw new Error('--reason says why the loop ends.');
  const by = nonempty(options.by) ? options.by.trim() : null;
  const ref = nonempty(options.ref) ? options.ref.trim() : null;
  if ((by === null) !== (ref === null)) throw new Error('--by and --ref go together: who ended the loop, and where they said so.');
  const { loop, status } = recordableLoop(repo, name, 'The loop cannot be ended');
  const phase = loopPhase(status);
  if (phase === 'done') throw blocked('The loop cannot be ended.', [gap('already_accepted', 'loop', `The user accepted run ${status.acceptance?.run_id ?? 'unknown'} of this loop; it is finished.`, 'user', 'business')]);
  if (phase === 'ended') throw blocked('The loop has ended already.', [{ ...endGap(status), code: 'loop_not_running' }]);
  const at = new Date().toISOString();
  const endedBy = by ? 'user' : 'agent';
  loop.closed = { kind: 'loop_end', reason: options.reason.trim(), by, ref, at, ended_by: endedBy };
  saveLoop(repo, name, loop);
  appendDecision(eddDirectory(repo, name), { type: 'loop_end', loop_started_at: loop.started_at, ends_loop: loop.started_at, reason: options.reason.trim(), ...(by ? { by, ref } : {}), ended_by: endedBy });
  const after = loopStatus(repo, name);
  return { loop_ended: { reason: 'loop_end', at, text: options.reason.trim(), by, ref, ended_by: endedBy, files: after.ended?.code_files ?? [] },
    start_code: after.ended?.start_code ?? null, new_loop: after.ended?.new_loop ?? null, must_show: after.must_show, warnings: [], suggestion: null };
}

// Records the user's refusal to accept the loop, and ends it when it still
// runs. by and ref say who declined and where; reason is optional. A loop
// the user accepted is not declined: the acceptance stands.
export function declineLoop(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who declined and where they said so. Declining is the user\'s decision.');
  const { loop, status } = recordableLoop(repo, name, 'The decline cannot be recorded');
  const phase = loopPhase(status);
  if (phase === 'done') throw blocked('The loop is accepted.', [gap('already_accepted', 'loop', `The user accepted run ${status.acceptance?.run_id ?? 'unknown'} of this loop; a decline does not withdraw an acceptance.`, 'user', 'business')]);
  const alreadyEnded = phase === 'ended';
  const at = new Date().toISOString();
  const entry = { at, by: options.by.trim(), ref: options.ref.trim(), reason: nonempty(options.reason) ? options.reason.trim() : null,
    run: status.situation?.run_id ?? null };
  loop.declined = entry;
  if (!alreadyEnded) loop.closed = { kind: 'loop_decline', ...entry, ended_by: 'user' };
  saveLoop(repo, name, loop);
  appendDecision(eddDirectory(repo, name), { type: 'loop_decline', loop_started_at: loop.started_at, ends_loop: alreadyEnded ? null : loop.started_at, ...entry });
  const after = loopStatus(repo, name);
  return { declined: entry, loop_ended: alreadyEnded ? { reason: status.ended.reason, at: status.ended.at ?? null, already: true } : { reason: 'loop_decline', at, files: after.ended?.code_files ?? [] },
    start_code: after.ended?.start_code ?? null, new_loop: after.ended?.new_loop ?? null, must_show: after.must_show, warnings: [], suggestion: null };
}

// Records that the user abandons this change as it is: by, ref and reason. It
// ends a loop that still runs, and releases the start code the change's
// loops pinned, so the next baseline is recorded on any code. The decision
// is kept as change_abandon; run start reads it to release the pin.
export function abandonChange(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who abandoned the change and where they said so. Abandoning is the user\'s decision.');
  if (!nonempty(options.reason)) throw new Error('--reason says why the change is abandoned.');
  const root = eddDirectory(repo, name);
  if (!existsSync(root)) throw new Error(`No change named ${name} in this project.`);
  const loop = readLoopSafe(repo, name);
  let status = null;
  if (loop) {
    try { status = loopStatus(repo, name); } catch { /* read as ended */ }
  }
  const phase = status ? loopPhase(status) : null;
  const ends = Boolean(loop && phase && !['ended', 'done'].includes(phase));
  const pin = pinnedStart(repo, name);
  const at = new Date().toISOString();
  const entry = { at, by: options.by.trim(), ref: options.ref.trim(), reason: options.reason.trim() };
  if (loop) {
    loop.abandoned = entry;
    if (ends) loop.closed = { kind: 'change_abandon', ...entry, ended_by: 'user' };
    saveLoop(repo, name, loop);
  }
  const known = loop ?? recordedLoop(repo, name);
  appendDecision(root, { type: 'change_abandon', ...entry, loop_started_at: known?.started_at ?? null, ends_loop: ends ? loop.started_at : null,
    released_start_code: pin?.start?.digest ?? null });
  // The application files the ended loop changed since its start code.
  let files = [];
  if (ends) {
    try { files = loopStatus(repo, name).ended?.code_files ?? []; } catch { /* nothing to add */ }
  }
  return { abandoned: entry, loop_ended: ends ? { reason: 'change_abandon', at, files } : null,
    released_start_code: startFacts(name, pin?.start ?? null), loop_phase_before: phase, warnings: [], suggestion: null };
}

// Records the agent's dispute of a check of the running loop: the check, as
// CASE:CHECK, and the file that holds the evidence, whose content and digest
// are copied into the record. With resolve, records the user's ruling on a
// dispute instead (ruling accept or reject, by, ref). A ruling of accept
// records that the user agrees the package must change; it ends nothing by
// itself, and a change to the package ends the loop as any change does.
export function disputeLoop(repo, name, options = {}) {
  if (options.resolve !== undefined) return ruleDispute(repo, name, options);
  if (!nonempty(options.check) || !options.check.includes(':')) throw new Error('--check names the disputed check as CASE:CHECK.');
  if (!nonempty(options.evidence)) throw new Error('--evidence names the file that holds the evidence.');
  const [caseId, ...rest] = options.check.trim().split(':');
  const checkId = rest.join(':');
  const { bytes, shown } = readGiven(repo, options.evidence, '--evidence');
  if (bytes.length > 1024 * 1024) throw new Error(`--evidence ${options.evidence} holds ${bytes.length} bytes; a dispute keeps at most 1 MB of evidence. Give the part that shows it.`);
  const { loop, status } = recordableLoop(repo, name, 'The dispute cannot be recorded');
  const phase = loopPhase(status);
  const gaps = [];
  if (phase === 'ended') gaps.push(endGap(status));
  if (phase === 'done') gaps.push(gap('already_accepted', 'loop', `The user accepted run ${status.acceptance?.run_id ?? 'unknown'} of this loop already.`, 'user', 'business'));
  const known = status.checks.find((entry) => entry.case === caseId && entry.check === checkId);
  if (!known) gaps.push(gap('check_unknown', 'package', `${caseId}/${checkId} is no check of this loop's packages.`, 'agent', 'artifact', { case: caseId, check: checkId }));
  if (gaps.length) throw blocked(`The dispute cannot be recorded: ${gaps.map((entry) => entry.message).join(' ')}`, gaps);
  const root = eddDirectory(repo, name);
  const records = loopRecords(loop, readDecisions(root).entries);
  const binary = bytes.includes(0);
  const dispute = { id: `dispute-${records.disputes.length + 1}`, at: new Date().toISOString(), case: caseId, check: checkId, role: known.role ?? null, then: known.then ?? null,
    evidence: { file: shown, digest: digest(bytes), bytes: bytes.length, encoding: binary ? 'base64' : 'utf8', content: binary ? bytes.toString('base64') : bytes.toString('utf8') },
    latest_run: status.runs.at(-1)?.run_id ?? null, ruling: null };
  loop.disputes = [...(Array.isArray(loop.disputes) ? loop.disputes : []), dispute];
  saveLoop(repo, name, loop);
  appendDecision(root, { type: 'loop_dispute', loop_started_at: loop.started_at, ...dispute });
  return { dispute: disputeSummary(dispute), loop_ended: false, needs_user: [{ decision: 'dispute ruling', why: 'Only the user rules whether a check of the confirmed packages is wrong.' }],
    must_show: { disputes: [disputeSummary(dispute)] }, warnings: [], suggestion: null };
}

function ruleDispute(repo, name, options) {
  if (!nonempty(options.resolve)) throw new Error('--resolve names the dispute to rule on, such as dispute-1.');
  if (!['accept', 'reject'].includes(options.ruling)) throw new Error('--ruling is accept or reject.');
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who ruled and where they said so. A ruling is the user\'s decision.');
  const loop = readLoopSafe(repo, name);
  if (!loop) throw blocked('The ruling cannot be recorded: no loop.json.', [gap('loop_missing', 'loop', 'loop.json is missing or cannot be read.', 'user', 'business')]);
  const root = eddDirectory(repo, name);
  const records = loopRecords(loop, readDecisions(root).entries);
  const id = options.resolve.trim();
  const dispute = records.disputes.find((entry) => entry.id === id);
  if (!dispute) throw blocked('The ruling cannot be recorded.', [gap('dispute_unknown', 'loop', `${id} is no dispute of this loop.`, 'agent', 'artifact', { disputes: records.disputes.map((entry) => entry.id) })]);
  if (dispute.ruling) throw blocked('The ruling cannot be recorded.', [gap('dispute_ruled', 'loop', `${id} was ruled already: ${dispute.ruling.ruling}, by ${dispute.ruling.by ?? 'unknown'}.`, 'user', 'business', { ruling: dispute.ruling })]);
  const ruling = { ruling: options.ruling, by: options.by.trim(), ref: options.ref.trim(), at: new Date().toISOString() };
  const kept = Array.isArray(loop.disputes) ? loop.disputes : [];
  loop.disputes = kept.some((entry) => entry.id === id) ? kept.map((entry) => (entry.id === id ? { ...entry, ruling } : entry)) : [...kept, { ...dispute, ruling }];
  saveLoop(repo, name, loop);
  appendDecision(root, { type: 'dispute_ruling', loop_started_at: loop.started_at, id, case: dispute.case, check: dispute.check, ...ruling });
  return { dispute: disputeSummary({ ...dispute, ruling }), ruling, package_change_agreed: options.ruling === 'accept', loop_ended: false,
    ...(options.ruling === 'accept' ? { note: `The user agrees that ${dispute.case}/${dispute.check} must change. The loop goes on until the package changes; a change to it ends the loop.` } : {}),
    warnings: [], suggestion: null };
}

// Records the result of the project's own tests: the command, its exit code,
// an optional summary, and the content digest of the code it ran on. It is
// the agent's record; the acceptance shows it as such.
export function recordTests(repo, name, options = {}) {
  if (!nonempty(options.command)) throw new Error('--command names the test command that ran.');
  const exitCode = typeof options.exitCode === 'string' && options.exitCode.trim() !== '' ? Number(options.exitCode) : options.exitCode;
  if (!Number.isInteger(exitCode)) throw new Error('--exit-code is the whole number the test command exited with.');
  if (options.summary !== undefined && options.summary !== null && typeof options.summary !== 'string') throw new Error('--summary is text.');
  const root = eddDirectory(repo, name);
  if (!existsSync(root)) throw new Error(`No change named ${name} in this project.`);
  const snapshot = codeSnapshot(repo).snapshot;
  const entry = { at: new Date().toISOString(), command: options.command.trim(), exit_code: exitCode, summary: nonempty(options.summary) ? options.summary.trim() : null,
    code_digest: codeIdentity(snapshot, repo), commit: snapshot.commit ?? null, uncommitted_files: snapshot.changed_files ?? null, recorded_by: 'agent' };
  const loop = readLoopSafe(repo, name);
  if (loop) {
    loop.tests = [...(Array.isArray(loop.tests) ? loop.tests : []), entry];
    saveLoop(repo, name, loop);
  }
  appendDecision(root, { type: 'loop_tests', loop_started_at: loop?.started_at ?? null, ...entry });
  const warnings = entry.code_digest ? [] : ['The code has no content digest here (no Git), so this result cannot be matched to a run.'];
  return { tests: entry, loop_started_at: loop?.started_at ?? null, passed: exitCode === 0, warnings, suggestion: null };
}

// Records the user's acceptance of one passing run, and only of the code and
// the eval packages that ran. A pass outside a loop is not acceptance: it ran
// without a loop's budget, final review and final run.
export function acceptLoop(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who accepted and where they said so. Acceptance is the user\'s decision.');
  const status = loopStatus(repo, name);
  // An acceptance read from accepted.json alone has no loop here to accept.
  if (status.situation?.local_records === false) throw localRecordsMissing(status, 'Cannot record acceptance');
  const loop = readLoopSafe(repo, name) ?? recordedLoop(repo, name);
  const root = eddDirectory(repo, name);
  const runsDirectory = path.join(root, 'runs');
  const all = readRuns(runsDirectory);
  const gaps = [];
  const ledger = ledgerCheck(repo, name);
  if (ledger.gap) gaps.push(ledger.gap);
  const listed = status.runs.find((entry) => entry.run_id === options.run);
  if (!listed) {
    const other = all.find((entry) => entry.run_id === options.run) ?? null;
    if (other && isTrial(other)) gaps.push(gap('trial_not_acceptable', 'loop', `${other.run_id} is a trial: a trial is never accepted.`, 'agent', 'artifact', { run: other.run_id }));
    else if (other && other.side === 'head' && !other.loop?.started_at && !ofLoop(other, loop)) {
      gaps.push(gap('outside_loop', 'loop', `${other.run_id} ran outside a loop. A pass outside a loop is not acceptance: it ran without a loop's budget, a recorded final review and a final run.`, 'agent', 'artifact', { run: other.run_id }));
    } else gaps.push(gap('run_unknown', 'loop', `${options.run ?? 'No run'} is not a full run of this loop.`, 'agent', 'artifact', { run: options.run ?? null }));
  }
  let run = null;
  if (listed) {
    try { run = readJSON(path.join(runsDirectory, listed.run_id, 'run.json')); } catch {
      gaps.push(gap('run_unreadable', 'ledger', `The run record of ${listed.run_id} cannot be read.`, 'agent', 'artifact', { run: listed.run_id }));
    }
  }
  if (run && (run.verdict !== 'pass' || run.execution_status !== 'completed')) gaps.push(gap('not_passing', 'loop', `${run.run_id} has verdict ${run.verdict}; only a passing run can be accepted.`, 'agent', 'artifact', { run: run.run_id }));
  // In a loop that needs a final run, a screen run's pass is a lead. A run
  // that did not pass has no pass to rest on: not_passing says enough. Nor is
  // a run accepted that made fewer attempts of a package with a live
  // dependency than the plan, whatever the packages look like now.
  const plan = run ? planOf(run) : null;
  const short = run ? Object.entries(run.environment_ref?.attempts_by_case ?? {})
    .filter(([id, made]) => made < attemptsFor({ dependencies: run.environment_ref?.dependencies?.[id] }, plan)).map(([id]) => id) : [];
  if (run && (status.final.needed ? listed.role !== 'final' : short.length > 0) && run.verdict === 'pass' && run.execution_status === 'completed') {
    gaps.push(gap('not_final', 'loop', `${run.run_id} is a screen run: its pass rests on ${screenBasis(run, status.final.needed ? status.final.live : short, plan?.attempts ?? status.final.attempts)}. Only a passing final run can be accepted${status.final.candidate ? `; the final run of screen run ${status.final.candidate} is ${status.final.pending ? 'due' : 'recorded'}` : ''}.`,
      'agent', 'artifact', { run: run.run_id, candidate: status.final.candidate }));
  }
  // A run of this loop ran the loop's plan: the agent and the model of the
  // loop's checks confirmation, else of its baseline's plan, and the attempts
  // of that plan.
  const confirmations = checksConfirmation(repo, name, loop.spec);
  const baseFound = all.find((item) => item.run_id === loop.baseline) ?? null;
  const base = baseFound && !isLost(baseFound) ? baseFound : null;
  // The checks confirmation the loop started on: its plan, and the judged
  // lines it made gating.
  const loopEntry = !confirmations.gap && loop.checks_confirmation ? confirmationById(confirmations.entries, loop.checks_confirmation.id) : null;
  if (run) {
    const fixed = loopEntry?.run_plan ?? planOf(base) ?? {};
    const ran = run.environment_ref ?? {};
    const differs = [
      ...((fixed.agent ?? null) !== null && (ran.agent ?? null) !== fixed.agent ? [`agent ${ran.agent ?? 'none'} where the loop runs ${fixed.agent}`] : []),
      ...(base && (ran.model ?? null) !== (fixed.model ?? null) ? [`model ${ran.model ?? 'none'} where the loop runs ${fixed.model ?? 'none'}`] : []),
      ...(planOf(run)?.attempts !== undefined && base && (planOf(run).attempts ?? null) !== (planOf(base)?.attempts ?? null) ? [`${planOf(run).attempts ?? 'no fixed number of'} attempts where the loop runs ${planOf(base)?.attempts ?? 'no fixed number of'}`] : []),
    ];
    if (differs.length) gaps.push(gap('loop_plan_differs', 'loop', `${run.run_id} ran another plan than this loop's: ${differs.join('; ')}. Only a run of the loop's plan can be accepted.`, 'agent', 'artifact', { run: run.run_id }));
  }
  if (run?.code_changed_during_run) gaps.push(gap('code_changed_during_run', 'code', `The code changed while ${run.run_id} executed, so no one version of the code passed.`, 'agent', 'artifact', { run: run.run_id }));
  if (run?.packages_changed_during_run) gaps.push(gap('packages_changed_during_run', 'package', `The eval packages changed while ${run.run_id} executed, so no one version of them passed.`, 'agent', 'artifact', { run: run.run_id }));
  const compare = run ? compareOf(runsDirectory, run) : [];
  // A failure of a gating check on the same code, packages, agent and model,
  // in any run before or after this one, a partial or a base run or a trial
  // included, is never cancelled by this pass.
  const failures = run && run.verdict === 'pass' ? failuresOf(sameCodeResults(repo, runsDirectory, loop.spec, all), run, gatingKeys(compare), repo) : [];
  if (failures.length) {
    const byCheck = new Map();
    for (const entry of failures) {
      const id = `${entry.case}/${entry.check}`;
      byCheck.set(id, [...new Set([...(byCheck.get(id) ?? []), entry.run_id])]);
    }
    gaps.push(gap('unstable', 'code', `${[...byCheck].map(([id, ran]) => `${id} failed in ${ran.join(', ')}`).join('; ')}, on the code and packages of ${run.run_id}. A failure of the same code always counts, and a later pass does not cancel it, so ${run.run_id} cannot be accepted. Whether the code changes until the check passes every time, or the requirement changes, is the user's decision.`,
      'user', 'business', { run: run.run_id, failures: [...byCheck].map(([id, ran]) => ({ check: id, runs: ran })) }));
  }
  // The user accepts the packages that ran too.
  const differ = run ? packagesBetween(run, evalSnapshot(repo, name)) : [];
  if (differ.length) gaps.push(gap('packages_changed', 'package', `The eval packages changed after ${run.run_id}: ${differ.join(', ')}, so it cannot be accepted. A loop's packages are fixed; this loop has ended.`, 'agent', 'artifact', { cases: differ }));
  // A loop that ended, or one a stop holds for, is not accepted.
  const end = endGap(status);
  if (end) gaps.push(end);
  else if (status.situation?.code === 'spec_invalid') gaps.push(gap('spec_changed', 'spec', status.situation.message, status.situation.owner ?? 'agent'));
  // The user accepts only packages they confirmed: those of the accepted run
  // must be in the latest checks confirmation of this Spec export.
  if (confirmations.gap) gaps.push(confirmations.gap);
  const warnings = [];
  if (run && !confirmations.gap) {
    const latest = confirmations.latest;
    const match = latest ? confirmationMatch(latest, { task_digest: run.task_digest ?? {}, run_digest: run.run_digest ?? {}, packages: run.eval_snapshot?.packages ?? {},
      kit: run.eval_snapshot?.kit ?? {} }, loop.spec) : null;
    if (!match?.matches) {
      const ids = Object.keys(run.task_digest ?? {}).sort();
      const what = match ? `${match.packages.map((entry) => entry.id).join(', ')} (${named(matchFiles(match))})` : `no checks confirmation of this Spec export covers ${ids.join(', ') || 'its packages'}`;
      gaps.push(gap('packages_unconfirmed', 'confirmation', `The eval packages of ${run.run_id} differ from the latest checks confirmation (${latest?.id ?? 'none'}): ${what}. The user accepts only packages they confirmed, and a confirmation of other packages or another plan ends this loop.`,
        'user', 'business', match ? { cases: match.packages.map((entry) => entry.id) } : {}));
    }
  }
  // Each line a program checks keeps its proof that its checks can fail, a
  // judged line the loop's checks confirmation made gating included.
  let proved = [];
  let evalsNow = null;
  if (run) {
    evalsNow = validateEval(repo, name);
    const checked = runProofs(repo, name, evalsNow, loop, run, status.loop.tier, loopEntry?.judge_gating ?? []);
    proved = checked.lines;
    if (checked.unproven.length) {
      gaps.push(gap('line_unproven', 'package', `${run.run_id} cannot be accepted: ${checked.text}`, 'agent', 'artifact', { cases: [...new Set(checked.unproven.map((row) => row.case))],
        ...(checked.judged.length ? { judged: checked.judged } : {}) }));
    }
  }
  // The judged lines this acceptance holds like any gating line.
  const judgedLines = proved.filter((line) => line.judge_gating);
  // The final review: recorded after the run it reviewed finished, of the
  // accepted run's code.
  const decisions = readDecisions(root).entries;
  const records = loopRecords(loop, decisions);
  const fullOfLoop = fullRuns(loopRuns(all, loop));
  const reviews = run ? reviewsFor(records.reviews, run, fullOfLoop, repo) : [];
  if (run && !reviews.length) gaps.push(reviewMissing(run));
  const now = codeSnapshot(repo).snapshot;
  if (run && sameCode(now, run.code_snapshot, repo) !== true) {
    gaps.push(gap('code_changed', 'code', `The code changed after ${run.run_id}, so it is not the code now.`, 'agent', 'artifact', { run: run.run_id }));
  }
  const accepted = acceptedFile(repo, name);
  // An acceptance that no longer covers the loop, because the code changed or
  // a later run failed, can be given again for a passing run of the code now.
  if (status.acceptance && !status.acceptance.outdated) gaps.push(gap('already_accepted', 'loop', `This loop was already accepted: run ${status.acceptance.run_id}, in ${path.relative(repo, accepted)}.`, 'user', 'business'));
  // An acceptance from an earlier loop of this change stays in the record.
  let earlier = [];
  if (existsSync(accepted)) {
    try {
      const previous = readJSON(accepted);
      earlier = [...(previous.earlier ?? []), without(previous, 'earlier')];
    } catch {
      gaps.push(gap('accepted_unreadable', 'ledger', `${path.relative(repo, accepted)} cannot be read, and it holds an earlier acceptance.`, 'agent', 'artifact', { path: path.relative(repo, accepted) }));
    }
  }
  if (gaps.length) {
    throw Object.assign(blocked(`Cannot record acceptance: ${gaps.map((entry) => entry.message).join(' ')}`, gaps),
      { must_show: judgedLines.length ? { ...(status.must_show ?? {}), judge_gating: judgedLines } : status.must_show });
  }
  const fullRecords = new Map(all.map((entry) => [entry.run_id, entry]));
  // The confirmation that covers the accepted packages, the one the loop
  // started on, and every revision confirmed since the loop started.
  const entries = confirmations.entries.filter((entry) => entry?.spec?.sha256 === loop.spec);
  const covering = confirmationOf(entries, loop.spec, { task_digest: run.task_digest ?? {}, run_digest: run.run_digest ?? {} });
  const atStart = loop.checks_confirmation ? entries.find((entry) => entry.id === loop.checks_confirmation.id) ?? null : null;
  const chronological = [...entries].reverse();
  const revisions = chronological.flatMap((entry, index) => (Date.parse(entry.confirmed?.at) > Date.parse(loop.started_at)
    ? [{ id: entry.id, at: entry.confirmed.at, by: entry.confirmed.by ?? null, ref: entry.confirmed.ref ?? null, reason: entry.confirmed.reason ?? null,
      packages: index ? packagesBetween(confirmedDigests(chronological[index - 1]), confirmedDigests(entry)) : Object.keys(entry.packages ?? {}).sort() }] : []));
  // What the acceptance rests on, over the whole change: its final runs and
  // their failures, and the attempts on the accepted code that left a gating
  // check unknown.
  const code = codeIdentity(run.code_snapshot, repo);
  const gating = gatingKeys(compare);
  const history = { finals: finalsOfChange(repo, all), unknown: unknownAttempts(repo, runsDirectory, all, code, gating) };
  const spent = loopSpend(all, loop);
  const review = reviews.at(-1);
  const selfReview = reviews.some((entry) => entry.reviewer === 'self');
  const tests = records.tests.filter((entry) => entry.code_digest && entry.code_digest === code).map((entry) => ({ ...entry, recorded_by: 'agent' }));
  // What a Genesis review from the Spec's Map covers, and the Genesis reviews
  // of the accepted code.
  const scopeOfMap = mapScope(evalsNow.map, genesisReview(repo, name, evalsNow.map, loop.base_commit));
  const genesisReviews = reviews.filter((entry) => entry.reviewer === 'genesis').map((entry) => entry.id);
  const chain = Array.isArray(loop.previous) ? loop.previous : [];
  const earlierUsage = earlierLoops(repo, name, [...chain, without(loop, 'previous')], loop.spec, all);
  const record = {
    schema_version: '1.3', change: name, run_id: run.run_id, loop_started_at: status.loop.started_at,
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
    // The tier the loop ran in, and how strongly the acceptance rests on its
    // runs, counting every final run of the change and the unknown attempts
    // on the accepted code.
    tier: status.loop.tier,
    strength: withAcceptedVerdicts(strengthOf(run, compare, status.loop.tier, history), loopEntry?.accepted_verdicts),
    // The lines whose weaker or stronger checks the user accepted when
    // confirming the checks, with the reviewer's note and the user's reason.
    accepted_verdicts: loopEntry?.accepted_verdicts ?? [],
    final_runs_of_change: history.finals,
    unknown_attempts: history.unknown,
    // Each line a program checks with what proves its checks can fail: its
    // failure at the baseline, a reviewer's counterexample, or both. A judged
    // line the loop's checks confirmation made gating is marked judge_gating.
    lines: proved,
    // In a loop that needs a final run: the accepted final run, its screen
    // run, and every full run of the loop with its role.
    final_run: status.final.needed ? run.run_id : null,
    screen_run: status.final.needed ? run.final_of ?? null : null,
    history: status.runs.map((entry) => ({ run_id: entry.run_id, role: entry.role, verdict: entry.verdict,
      code_digest: codeIdentity(fullRecords.get(entry.run_id)?.code_snapshot, repo) })),
    changed_packages: status.changed_packages,
    // The final review the acceptance rests on, every review of the accepted
    // code, and whether the agent that changed the code reviewed it itself.
    review: review ? reviewSummary(review) : null,
    reviews: reviews.map(reviewSummary),
    self_review: selfReview,
    review_findings: reviewFindings(reviews),
    // Whether the Spec's Map covers the whole project or only what a Genesis
    // change review analyzed, which limits what a Genesis review from it covers.
    map_scope: scopeOfMap ? { ...scopeOfMap, genesis_reviews: genesisReviews } : null,
    // The user's checks confirmation: the one covering the accepted packages,
    // the one the loop started on, the packages changed between the two, the
    // revisions confirmed during the loop, and the lines only a self-review
    // counterexample stands behind.
    checks_confirmation: covering ? { id: covering.id, at: covering.confirmed?.at ?? null, by: covering.confirmed?.by ?? null, ref: covering.confirmed?.ref ?? null,
      kind: covering.confirmed?.kind ?? null, review_origin: covering.review?.origin ?? null } : null,
    loop_confirmation: loop.checks_confirmation ?? null,
    changed_since_confirmation: atStart ? packagesBetween(confirmedDigests(atStart), run) : null,
    revisions,
    self_review_lines: (covering?.lines ?? []).filter((line) => line.counterexamples?.length && line.counterexamples.every((item) => item.origin === 'self-review'))
      .map((line) => ({ package: line.package, then: line.then })),
    // The lines no check verified, which the user judged.
    manual: manualOf(runsDirectory, run),
    // Who agreed to the loop, the code it started on and whether the working
    // directory held other code then, and the runs of this Spec export made
    // outside a loop before it.
    loop_consent: loop.consent ?? null, start_code: startFacts(name, loopStartCode(repo, name, loop)),
    worktree_moved: loop.worktree_moved ?? null, moved_files: loop.moved_files ?? [], pre_loop: loop.pre_loop ?? null,
    // The disputes of checks during the loop, with the user's rulings, and
    // the project's own test results on the accepted code, as the agent
    // recorded them.
    disputes: records.disputes.map(disputeSummary),
    project_tests: tests,
    // What was agreed and what was used stay with the acceptance: the budget
    // the loop started with, every revision, the budget each run fell under,
    // and what the loop's runs, trials and lost runs took and used.
    budget: status.loop.budget, budget_original: status.loop.budget_original, budget_revisions: status.loop.budget_revisions,
    budget_by_run: budgetsByRun(loop, spent, status.loop.budget_revisions ?? []),
    used: status.loop.used, usage: status.loop.usage,
    trials: status.loop.trials, lost_runs: status.loop.lost_runs,
    earlier_usage: { loops: earlierUsage.loops.filter((entry) => entry.started_at !== loop.started_at), outside: earlierUsage.outside },
    accepted: { by: options.by.trim(), ref: options.ref.trim(), at: new Date().toISOString() },
    ...(earlier.length ? { earlier } : {}),
  };
  writeFileSync(accepted, `${JSON.stringify(record, null, 2)}\n`);
  const { budget } = status.loop;
  const position = status.runs.findIndex((entry) => entry.run_id === run.run_id) + 1;
  const late = Math.round((Date.parse(run.started_at) - Date.parse(status.loop.clock_started_at)) / 60_000);
  // Run minutes count the runs of this loop that started before it.
  const runMinutes = typeof budget?.run_minutes === 'number'
    ? spendUsage(runsDirectory, spent.filter((entry) => entry.started_at < run.started_at)).minutes ?? 0 : null;
  const overMinutes = runMinutes !== null ? runMinutes >= budget.run_minutes : typeof budget?.minutes === 'number' && late >= budget.minutes;
  if (budget && (position > budget.iterations || overMinutes)) {
    warnings.push(`${run.run_id} was made past the budget the user agreed to (${position > budget.iterations ? `run ${position} of ${budget.iterations}`
      : runMinutes !== null ? `started after ${shownMinutes(runMinutes)} of ${shownMinutes(budget.run_minutes)} run minutes` : `started ${late} minutes into ${budget.minutes}`}). The acceptance is recorded with the budget and what was used.`);
  }
  if (selfReview) warnings.push('The final review was a self review: the agent that changed the code reviewed it. accepted.json records that.');
  if (scopeOfMap?.scope_limited) warnings.push(`${scopeOfMap.scope_note} accepted.json records that (map_scope).`);
  if (ledger.note) warnings.push(ledger.note);
  const ignored = ignoredArtifacts(repo, name).warning;
  if (ignored) warnings.push(ignored);
  // The code now is the accepted code; the change is committed when the commit
  // holds all of it and every file of the change, accepted.json included.
  const facts = commitFacts(repo, name, now, true);
  return { file: accepted, accepted: record, ...(facts.code_commit && facts.committed ? { commit: facts.code_commit } : {}), ...(facts.uncommitted.length ? { uncommitted: facts.uncommitted } : {}),
    committed: facts.committed, needs_user: facts.needs_user,
    must_show: { strength: [{ sentence: record.strength.sentence }], ...(judgedLines.length ? { judge_gating: judgedLines } : {}),
      ...(record.accepted_verdicts.length ? { accepted_verdicts: record.accepted_verdicts } : {}),
      ...(selfReview ? { self_review: reviews.filter((entry) => entry.reviewer === 'self').map(reviewSummary) } : {}),
      ...(record.map_scope?.scope_limited ? { map_scope: [record.map_scope] } : {}),
      ...(record.review_findings.length ? { review_findings: record.review_findings } : {}), ...(tests.length ? { project_tests: tests } : {}),
      ...(record.disputes.length ? { disputes: record.disputes } : {}), ...(record.worktree_moved ? { worktree_moved: [{ files: record.moved_files }] } : {}),
      ...(record.pre_loop?.runs ? { pre_loop: [record.pre_loop] } : {}), ...(record.budget_revisions?.length ? { budget: [{ original: record.budget_original, revisions: record.budget_revisions }] } : {}) },
    warnings, suggestion: null };
}

export const hasLoop = (repo, name, spec) => readLoopSafe(repo, name)?.spec === spec;
