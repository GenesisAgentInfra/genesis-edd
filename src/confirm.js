import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest, readJSON, requireProject } from './project.js';
import { recordedCode } from './spec.js';
import {
  changeTier, confirmationFile, confirmationId, confirmationMatch, digestsAt, eddDirectory, entryDigests, evalSnapshot, fullTierByUser, kitSettings, latestConfirmation, matchFiles,
  networkUndeclared, networkUndeclaredText, packagesBetween, proposedTier, readConfirmation, requireSpec, reviewFile, samePackage, thenKey, validateEval,
  variabilitySignals,
} from './eval.js';
import {
  CODE_KIND, JUDGE_KIND, activeLoop, attemptsUndecided, changeLock, codeIdentity, codeSnapshot, commitCode, draftBound, estimateRuns, isInterrupted, isLost, isTrial, judgeKey,
  ledgerState, ledgerText, lineProofs, pinnedStart, planNeeds, planOf, proofKey, readRuns, recordedBaseline, restoreHint, sameCode, sameCodeResults, sharedMismatches, usableRun,
} from './run.js';
import { baselinePackagesDiffer, baselinePlanDiffers, changedFiles, loopPhase, loopStatus } from './loop.js';

// What a reviewer says of one line: the checks say what it says, say less,
// say more, say something else, can never fail, or no program can tell.
const VERDICTS = ['faithful', 'weaker', 'stronger', 'different', 'vacuous', 'not_observable'];
// The verdicts a user may accept for a line a program checks, with a reason:
// a check that asks less, or more, than its line. A check of something else,
// or of nothing, is never gating.
const ACCEPTABLE = ['weaker', 'stronger'];
const ORIGINS = ['review', 'self-review'];
// The light tier runs code whose result is fixed: no model, the network
// sealed, each package once. The full tier runs the rest.
const TIERS = ['light', 'full'];
// The default budget of each tier: full runs, and run minutes, the Docker
// time of the runs, so time spent waiting for the user does not count.
const DEFAULT_BUDGET = { light: { iterations: 5, run_minutes: 30 }, full: { iterations: 5, run_minutes: 60 } };
// What a base record writes for a check no expectation was given for.
const UNDECLARED = 'No expectation was declared before the baseline ran.';
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const gap = (code, message, owner = 'agent', kind = 'artifact', layer = 'confirmation') => ({ code, kind, owner, layer, message });
// A gap of another module, without the skill and workflow pointers earlier
// releases attached.
const clean = ({ route, resume, ...rest }) => rest;
// Where the loop of loop.json stands, or null when its status cannot be read.
const phaseOf = (repo, name) => {
  try { return loopPhase(loopStatus(repo, name)); } catch { return null; }
};
const lineKey = (id, then) => `${id}\n${thenKey(then)}`;
// Files named in a message: the first ten, then how many more.
const named = (files) => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));
// Kept to four significant digits, as the strength of an acceptance is.
const fourDigits = (value) => Number(value.toPrecision(4));

function refused(message, repo, name, gaps) {
  return Object.assign(new Error(message), { code: 'CONFIRM_INPUT_BLOCKED', change: name, gaps: gaps.map(clean) });
}

// Everything eval review and eval confirm read, read once. Read-only.
function reviewState(repo, name) {
  const handoff = requireSpec(repo, name);
  const evals = validateEval(repo, name);
  const spec = evals.spec ?? handoff.id;
  const root = eddDirectory(repo, name);
  const snapshot = evalSnapshot(repo, name);
  const read = readConfirmation(repo, name);
  // A file that cannot be trusted confirms nothing.
  const entries = read.gap ? [] : read.entries;
  const latest = latestConfirmation(entries, spec);
  const match = latest ? confirmationMatch(latest, snapshot, spec) : null;
  let answers = null;
  if (existsSync(reviewFile(repo, name))) {
    try { answers = readJSON(reviewFile(repo, name)); } catch { /* eval confirm says why */ }
  }
  let expectations = [];
  const expectationsFile = path.join(root, 'baseline-expectations.json');
  let expectationsError = null;
  if (existsSync(expectationsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(expectationsFile, 'utf8'));
      if (Array.isArray(parsed)) expectations = parsed.filter(isRecord);
      else expectationsError = 'it is not a JSON array';
    } catch (error) { expectationsError = error.message; }
  }
  const loop = activeLoop(repo, name, spec);
  const runsDirectory = path.join(root, 'runs');
  // Every run the run index or a folder keeps, lost and interrupted ones
  // included; usable are those whose record is there.
  const runs = readRuns(runsDirectory);
  const usable = runs.filter(usableRun);
  const base = loop ? usable.find((run) => run.run_id === loop.baseline && run.side === 'base') ?? null : recordedBaseline(repo, name, spec);
  const kit = kitSettings(repo);
  const ready = evals.cases.filter((item) => item.integration?.state === 'ready');
  // Each package's checks.json, for its fixtures and its checks' roles.
  const declared = Object.fromEntries(evals.cases.map((item) => {
    try { return [item.id, readJSON(path.join(root, 'evals', item.id, 'tests/checks.json'))]; } catch { return [item.id, null]; }
  }));
  // The lines a confirmation covers: those of packages in checks.json 1.1,
  // checked by a program or judged by the user.
  const lines = evals.then_lines.filter((row) => ['gating', 'manual'].includes(row.status)
    && evals.cases.find((item) => item.id === row.case)?.schema_version === '1.1');
  // What proves each line a program checks can fail, with this baseline. A
  // line a judge check judges has one too, which counts once the user made
  // that check gating.
  const proofs = lineProofs(repo, name, evals, { base });
  // The judged lines the latest confirmation of this export made gating, as
  // `case:then`.
  const judgeGating = Array.isArray(latest?.judge_gating) ? latest.judge_gating.map(String) : [];
  return { repo, name, handoff, evals, spec, root, snapshot, read, entries, latest, match, answers, expectations, expectationsError, loop, runsDirectory, runs, usable, base, kit, ready,
    declared, lines, proofs, judgeGating, pool: sameCodeResults(repo, runsDirectory, spec, runs), signals: variabilitySignals(repo, name), ledger: ledgerState(runsDirectory) };
}

// A line of scenario.manual that a judge check judges, and its judge checks.
const judgedLine = (row) => row.status === 'manual' && Array.isArray(row.judges) && row.judges.length > 0;
const judgeChecksOf = (row) => (judgedLine(row) ? row.judges.map((entry) => entry.check) : []);
// Whether a judged line is gating under judgeGating (`case:then` entries):
// then it is held like any line a gating check verifies, to a faithful
// verdict and a proof that its checks can fail.
const judgeHeld = (row, judgeGating) => judgedLine(row) && judgeGating.includes(judgeKey(row.case, row.then));

// A line's proof that its checks can fail, as eval review shows it and a
// confirmation records it, or null for a line no program checks: a line the
// user judges, unless judgeGating made its judge check gating.
function proofOf(state, row, judgeGating = state.judgeGating) {
  if (row.status !== 'gating' && !judgeHeld(row, judgeGating)) return null;
  const proof = state.proofs.get(proofKey(row.case, row.then));
  return proof ? { sources: proof.sources, baseline: proof.baseline, counterexamples: proof.counterexamples, ...(proof.missing ? { missing: proof.missing } : {}) }
    : { sources: [], baseline: null, counterexamples: [], missing: ['no proof could be read'] };
}

// Whether an answer of review.json was written for a package as it is now: by
// its run_digest, which a fixture added since leaves as it was, or, in a
// review.json written before run digests, by its task_digest.
const answersPackage = (answer, state, id) => (nonempty(answer?.run_digest) ? answer.run_digest === state.snapshot.run_digest?.[id]
  : nonempty(answer?.task_digest) && answer.task_digest === state.snapshot.task_digest[id]);

// The tier of a run plan that names model: { eligible, proposed, reasons,
// signals }. eligible and reasons are changeTier's; proposed is light when the
// change qualifies, unless the user confirmed the full tier for this Spec
// export with --tier full, which stands until they say otherwise. signals are
// hints that a result could depend on a model, which decide nothing.
function tierPlan(state, model) {
  const { eligible, reasons } = changeTier(state.repo, state.evals.cases, model, { name: state.name, spec: state.spec });
  const kept = fullTierByUser(state.latest?.run_plan);
  return { eligible, proposed: proposedTier(eligible, state.latest), reasons, signals: state.signals, ...(kept ? { requested: 'full' } : {}) };
}

// The budget a confirmation of a tier records: the flags, else the previous
// confirmation's while it counts run minutes for the same tier, else the
// tier's default. A budget counts full runs and run minutes; minutes, the
// clock a budget recorded before run minutes counted, is null. A cost cap is
// kept until a flag gives another.
function budgetFor(previous, tier, options = {}) {
  const was = previous?.budget ?? null;
  const same = typeof was?.run_minutes === 'number' && (previous.tier ?? 'full') === tier;
  const cost = options.maxCost ?? was?.max_cost_usd;
  return { iterations: options.iterations ?? was?.iterations ?? DEFAULT_BUDGET[tier].iterations, minutes: null,
    run_minutes: options.minutes ?? (same ? was.run_minutes : DEFAULT_BUDGET[tier].run_minutes),
    ...(typeof cost === 'number' ? { max_cost_usd: cost } : {}) };
}

// The result a base record recorded for a check: from check-results.json of
// a record that is there, from the attempts that completed of one that never
// finished, or null.
function resultAt(state, run, id, check) {
  const folder = path.join(state.runsDirectory, run.run_id, id);
  if (isLost(run)) return null;
  try {
    const found = readJSON(path.join(folder, 'check-results.json')).results?.find((entry) => entry?.id === check)?.result ?? null;
    if (found) return found;
  } catch { /* read the attempts below */ }
  if (!isInterrupted(run)) return null;
  const seen = state.pool.filter((entry) => entry.run_id === run.run_id && entry.case === id && entry.check === check).map((entry) => entry.result);
  return seen.includes('fail') ? 'fail' : seen.includes('pass') ? 'pass' : null;
}

// Expected baseline results of baseline-expectations.json written after a
// result was seen: after any base record of this Spec export that ran,
// whichever came last. changed: a base record had declared another value for
// the check; added: a base record that ran the package declared none, and one
// is declared now. Each: { case, check, was (null when added), now, after
// (the base records it came after), results_seen: [{ run_id, result }] }.
function expectationMoves(state) {
  const bases = state.runs.filter((run) => run.side === 'base' && run.spec_snapshot?.sha256 === state.spec && run.execution_status !== 'not_run'
    && (isLost(run) || isInterrupted(run) || ['completed', 'error'].includes(run.execution_status)));
  const changed = [];
  const added = [];
  for (const entry of state.expectations) {
    if (!nonempty(entry.case) || !nonempty(entry.check) || !['pass', 'fail', 'any'].includes(entry.expected)) continue;
    const differ = [];
    const undeclared = [];
    const seen = [];
    for (const base of bases) {
      const was = (Array.isArray(base.baseline_expectations) ? base.baseline_expectations : []).find((item) => item.case === entry.case && item.check === entry.check);
      const declaredThere = Boolean(was) && (was.declared === true || (was.declared === undefined && was.reason !== UNDECLARED));
      const ranThere = (base.cases ?? []).some((item) => item.id === entry.case);
      if (declaredThere) {
        if ((was.expected ?? 'any') !== entry.expected) differ.push({ run_id: base.run_id, was: was.expected ?? 'any' });
      } else if (ranThere && entry.expected !== 'any') undeclared.push(base.run_id);
      const result = ranThere ? resultAt(state, base, entry.case, entry.check) : null;
      if (result) seen.push({ run_id: base.run_id, result });
    }
    if (differ.length) changed.push({ case: entry.case, check: entry.check, was: differ.at(-1).was, now: entry.expected, after: differ.map((item) => item.run_id), results_seen: seen });
    else if (undeclared.length) added.push({ case: entry.case, check: entry.check, was: null, now: entry.expected, after: undeclared, results_seen: seen });
  }
  return { changed, added };
}

// The settings of keys in a message, such as "5 attempts, model none".
const settingsText = (plan, keys) => keys.map((key) => (key === 'attempts' ? `${plan.attempts ?? 'no fixed number of'} attempts` : `${key} ${plan[key] ?? 'none'}`)).join(', ');

// The plan eval confirm records when no flag gives one: the number of
// attempts last confirmed for this Spec export, and the agent and the model
// planSettings gives. In the light tier, no number of attempts and no model,
// and the agent of harness.json.
function flaglessPlan(state) {
  const { agent, model } = planSettings(state);
  if (tierPlan(state, model).proposed === 'light') return { attempts: null, agent: state.kit.agent, model: null };
  return { attempts: state.latest?.run_plan?.attempts ?? null, agent, model };
}

// A baseline recorded, outside a loop, while no confirmation covered the
// packages, with another plan than plan, as when it was given plan flags:
// { baseline, keys, text }, or null. `loop start` takes it only once a
// confirmation names that plan (baseline_plan_differs), as it compares here.
function recordedDiffers(state, plan) {
  const base = state.loop ? null : state.base;
  if (!base || state.match?.matches || planOf(base).source !== 'baseline') return null;
  const confirmation = { run_plan: plan, kit: { files: state.snapshot.kit } };
  if (!baselinePlanDiffers(state.evals, base, confirmation)) return null;
  const environment = base.is_baseline ? base.environment_ref ?? {} : planOf(base);
  const ran = { attempts: planOf(base).attempts ?? null, agent: environment.agent ?? null, model: environment.model ?? null };
  const live = state.evals.cases.some((item) => item.live);
  const keys = ['attempts', 'agent', 'model'].filter((key) => (key !== 'attempts' || live) && (ran[key] ?? null) !== (plan[key] ?? null));
  return { baseline: base.run_id, keys,
    text: `The baseline ${base.run_id} ${base.is_baseline ? 'ran' : 'records that nothing could run, and a loop on it runs'} with ${settingsText(ran, keys)}, a plan of its own: without plan flags, \`eval confirm\` records ${settingsText(plan, keys)}. \`loop start\` takes that baseline only once a confirmation records the plan it ran; a baseline recorded after the confirmation reads the plan from it.` };
}

// The plan of a baseline recorded before the user confirmed the checks of
// this Spec export, as recordedDiffers gives it for eval confirm without plan
// flags, or null: the workflow status names it.
export function recordedPlan(repo, name) {
  const state = reviewState(repo, name);
  return state.loop ? null : recordedDiffers(state, flaglessPlan(state));
}

// In a new project whose packages are not connected yet, no package declares
// its dependencies, so the plan cannot show whether a scenario calls a model.
const dependenciesUnknown = (repo, state) => !state.loop && !state.ready.length && requireProject(repo).mode === 'new'
  && !planNeeds(state.evals.cases, state.ready, null).live.length;

// The packages changed since the latest confirmation of this Spec export, that
// a reviewer answers for: changed or added ones.
const revisedPackages = (state) => (state.match ? state.match.packages.filter((entry) => entry.change !== 'removed') : []);

// Whether what a package checks is as a confirmation recorded it: checks.json
// without its fixtures and its binding to a Spec export, the rest of tests/
// and the kit's verifier/ (check_digest). A confirmation recorded before it
// kept that digest says nothing.
const checksKept = (entry, state, id) => {
  const was = entry?.packages?.[id];
  return nonempty(was?.check_digest) && was.check_digest === state.snapshot.check_digest?.[id];
};

// Whether `eval rebind` bound a package to this Spec export from the export
// of a confirmation: its checks.json is bound to this export, and its rebound
// entries lead, one binding after another, from that export to this one.
// `eval rebind` binds a package only while its requirement text and every
// line of its scenario read the same; a binding edited by hand records none.
function reboundSince(state, id, from) {
  const checks = state.declared[id];
  if (!nonempty(from) || checks?.spec_ref?.sha256 !== state.spec || !Array.isArray(checks.rebound)) return false;
  let to = state.spec;
  for (const entry of [...checks.rebound].reverse()) {
    if (!isRecord(entry) || entry.to !== to || !nonempty(entry.from?.sha256)) return false;
    if (entry.from.sha256 === from) return true;
    to = entry.from.sha256;
  }
  return false;
}

// The answer a line carries over, with who gave it: its verdict, note and
// review origin. From the latest confirmation of this Spec export while its
// package is the one confirmed (samePackage), so a fixture added since keeps
// it, or while what the package checks is unchanged (checksKept), as after an
// edit to the adapter or the environment alone. While no confirmation of this
// export exists, from the newest confirmation of an earlier one for a package
// `eval rebind` bound to this export since (reboundSince), only while what it
// checks and the line's text are as that confirmation recorded them: a
// verdict never outlives a change to what it judged. The reviewer then
// answers only whether the diff of a changed package loosens a THEN line.
function carried(state, row) {
  const source = state.latest ?? state.entries[0] ?? null;
  const was = source?.packages?.[row.case];
  if (!was) return null;
  const kept = checksKept(source, state, row.case);
  if (source === state.latest) {
    if (!kept && !samePackage({ task: was.task_digest ?? null, run: was.run_digest ?? null }, digestsAt(state.snapshot, row.case))) return null;
  } else if (!kept || !reboundSince(state, row.case, source.spec?.sha256)) return null;
  const line = (source.lines ?? []).find((entry) => entry.package === row.case && nonempty(entry.then) && thenKey(entry.then) === thenKey(row.then));
  return line ? { verdict: line.verdict ?? null, note: line.note ?? null, origin: source.review?.origin ?? null } : null;
}

// The review.json eval confirm reads, as eval review proposes it. Each
// answer names its package by its run_digest, which a counterexample added
// to the package leaves as it was: the reviewer can write the counterexamples
// and answer from the same review.
function template(state) {
  const revised = revisedPackages(state);
  return {
    schema_version: '1.0', spec: state.spec,
    review: { origin: null, note: null },
    lines: state.lines.map((row) => {
      const before = carried(state, row);
      return { package: row.case, then: row.then, run_digest: state.snapshot.run_digest?.[row.case] ?? null, verdict: before?.verdict ?? null, note: before?.note ?? null };
    }),
    ...(revised.length ? { packages: revised.map((entry) => ({ package: entry.id, run_digest: state.snapshot.run_digest?.[entry.id] ?? null, loosens: null, note: null })) } : {}),
  };
}

// The result a baseline recorded for a check, or null.
function baselineResult(state, id, check) {
  const base = state.base;
  if (!base?.is_baseline || !(base.cases ?? []).some((item) => item.id === id) || !samePackage(digestsAt(base, id), digestsAt(state.snapshot, id))) return null;
  try {
    return readJSON(path.join(state.runsDirectory, base.run_id, id, 'check-results.json')).results?.find((entry) => entry?.id === check)?.result ?? null;
  } catch { return null; }
}

// The expected baseline result of a check: from baseline-expectations.json,
// or else from the baseline, or null.
function expectedResult(state, id, check) {
  const declared = state.expectations.find((entry) => entry.case === id && entry.check === check)?.expected;
  return declared ?? state.base?.baseline_expectations?.find((entry) => entry.case === id && entry.check === check)?.expected ?? null;
}

// The Spec export a confirmation was for, against this one: the lines added
// and removed since, or null when the newest confirmation is of this export.
function specDiff(state) {
  const newest = state.entries[0];
  if (!newest || newest.spec?.sha256 === state.spec) return null;
  const key = (line) => `${line.requirement}\n${line.scenario}\n${thenKey(line.then)}`;
  const was = new Map((newest.lines ?? []).map((line) => [key(line), { requirement: line.requirement, scenario: line.scenario, then: line.then }]));
  const now = new Map(state.evals.then_lines.map((row) => [key(row), { requirement: row.requirement, scenario: row.scenario, then: row.then }]));
  return { from: newest.spec?.sha256 ?? null, added: [...now].filter(([id]) => !was.has(id)).map(([, line]) => line),
    removed: [...was].filter(([id]) => !now.has(id)).map(([, line]) => line) };
}

// The checks that failed on some code with an earlier version of their
// package and passed on the same code with the package as it is now: a
// changed package starts a new count, so the user hears of them.
function oldPackageFailures(state) {
  const found = new Map();
  for (const failed of state.pool) {
    const now = digestsAt(state.snapshot, failed.case);
    if (failed.result !== 'fail' || (failed.task_digest === null && failed.run_digest === null) || samePackage(entryDigests(failed), now)) continue;
    const passed = state.pool.find((entry) => entry.result === 'pass' && entry.code === failed.code && entry.case === failed.case && entry.check === failed.check
      && samePackage(entryDigests(entry), now) && entry.agent === failed.agent && entry.model === failed.model);
    if (!passed) continue;
    const key = `${failed.case}\n${failed.check}`;
    const item = found.get(key) ?? { case: failed.case, check: failed.check, failed: [], passed: [] };
    if (!item.failed.includes(failed.run_id)) item.failed.push(failed.run_id);
    if (!item.passed.includes(passed.run_id)) item.passed.push(passed.run_id);
    found.set(key, item);
  }
  return [...found.values()].sort((a, b) => a.case.localeCompare(b.case) || a.check.localeCompare(b.check));
}

// The agent and the model a confirmation takes when no flag gives them. A
// first confirmation takes those of harness.json. A revision keeps the ones
// the user confirmed while harness.json is as it was then; once harness.json
// changed, its agent and model count again, as for a first confirmation, and
// eval review names each that differs. A changed harness.json ends a running
// loop (packages_changed).
function planSettings(state) {
  const confirmed = state.latest?.run_plan ?? null;
  const kitChanged = Boolean(confirmed) && (state.latest.kit?.files?.['harness.json'] ?? null) !== (state.snapshot.kit['harness.json'] ?? null);
  const settings = confirmed && !kitChanged ? { agent: confirmed.agent ?? null, model: confirmed.model ?? null } : { agent: state.kit.agent, model: state.kit.model };
  const changed = confirmed && kitChanged ? ['agent', 'model'].filter((key) => (confirmed[key] ?? null) !== settings[key]) : [];
  return { ...settings, changed: changed.map((key) => ({ key, confirmed: confirmed[key] ?? null, kit: settings[key] })) };
}

// The 1.0 packages eval confirm refuses, as the gap then_unbound, or null.
function unboundGap(evals) {
  const legacy = evals.cases.filter((item) => item.schema_version === '1.0').map((item) => item.id);
  if (!legacy.length) return null;
  const one = legacy.length === 1;
  return { ...gap('then_unbound', `${legacy.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0, whose checks name no THEN line, so the checks cannot be confirmed line by line; checks.json 1.1 binds each check to its line.`, 'agent', 'artifact', 'package'), cases: legacy };
}

// What eval review and eval confirm say while no package declares its
// dependencies yet.
const attemptsLater = 'No package declares its dependencies yet, since none is connected, so whether a scenario calls a model is not known. Declaring a live dependency later changes the package: a running loop ends, and the number of attempts is the user\'s decision before a new one.';

// What the CLI cannot see, and so no estimate counts.
const NOT_COUNTED = [
  'the reviewer\'s passes in eval review and in the final review, which run in your coding agent',
  'model calls, which fixtures do not make; the baseline shows their cost',
];

// The proposed run plan: its tier, which packages vary, the agent and the
// model, whether the user must fix a number of attempts and, only then, what
// 1, 3 and 5 attempts rule out, and how long the baseline, a screen run and
// the final run take: by the attempts of the recorded baseline, as `loop
// start` estimates them, with its per-run overhead (run_overhead), else by
// those of the last eval check. The estimate counts only ready packages;
// estimate_missing names the others. The budget is the one eval confirm
// records without budget flags.
function runPlan(repo, name, state) {
  const confirmed = state.latest?.run_plan ?? null;
  const settings = planSettings(state);
  const tier = tierPlan(state, settings.model);
  const light = tier.proposed === 'light';
  const model = light ? null : settings.model;
  const needs = planNeeds(state.evals.cases, state.ready, model);
  const counts = needs.needed ? [1, 3, 5] : [1];
  const estimates = counts.map((attempts) => ({ attempts, ...estimateRuns(repo, name, { base: state.base, plan: { attempts }, cases: state.evals.cases }) }));
  const missing = state.evals.cases.filter((item) => item.integration?.state !== 'ready').map((item) => item.id);
  return {
    tier, live: needs.live, undeclared: needs.undeclared, agent: light ? state.kit.agent : settings.agent, model, attempts_needed: needs.needed,
    // Without a package that varies, the number of attempts changes nothing,
    // so none is proposed.
    ...(needs.needed ? { proposal: { attempts: 5, tight: 3 },
      strength: [1, 3, 5].map((attempts) => ({ attempts, fails_half: fourDigits(0.5 ** attempts), fails_one_in_ten: fourDigits(0.9 ** attempts) })) } : {}),
    // Fixtures make no model call, so the cost of one is left to the baseline.
    estimate: estimates.map((entry) => ({ attempts: entry.attempts, baseline_minutes: entry.full.minutes, screen_minutes: entry.screen.minutes,
      final_minutes: entry.final.minutes, cost_usd: null })),
    basis: estimates[0].basis, ...(estimates[0].run_overhead ? { run_overhead: estimates[0].run_overhead } : {}), estimate_missing: missing, not_counted: NOT_COUNTED,
    budget: budgetFor(confirmed, tier.proposed),
    confirmed,
  };
}

// The checks of the packages declared with a kind of their own: code-level
// checks, which run a test command frozen in the package against the
// application code with no adapter, so they test the code directly; and
// judge checks, which run the project's own judging program and stay
// diagnostic unless the user makes their line gating at confirmation.
function kindChecks(state, kind) {
  return state.evals.cases.flatMap((item) => (Array.isArray(state.declared[item.id]?.checks) ? state.declared[item.id].checks : [])
    .filter((check) => isRecord(check) && check.kind === kind)
    .map((check) => ({ package: item.id, check: check.id, then: typeof check.then === 'string' ? check.then : null, declared_role: check.role ?? null,
      ...(check.command !== undefined ? { command: check.command } : {}), ...(check.program !== undefined ? { program: check.program } : {}),
      ...(check.timeout_sec !== undefined ? { timeout_sec: check.timeout_sec } : {}) })));
}

// The lines one check of a package checks together: a check bound to more
// than one line. Each line still needs a verdict of its own and a
// counterexample that breaks it alone.
function thenGroups(state) {
  const groups = new Map();
  for (const row of state.evals.then_lines.filter((entry) => entry.status === 'gating')) {
    for (const entry of row.gating ?? []) {
      const key = `${row.case}\n${entry.check}`;
      groups.set(key, [...(groups.get(key) ?? []), row.then]);
    }
  }
  return [...groups].filter(([, lines]) => lines.length > 1).map(([key, lines]) => {
    const [id, check] = key.split('\n');
    return { package: id, check, lines };
  });
}

// What each package depends on outside it, as tests/checks.json declares
// it: the dependency, its mode (live, frozen or simulated) and the stand-in
// that replaces it.
function dependenciesOf(state) {
  return state.evals.cases.flatMap((item) => (Array.isArray(state.declared[item.id]?.dependencies) ? state.declared[item.id].dependencies : [])
    .filter(isRecord).map((entry) => ({ package: item.id, name: entry.name ?? null, mode: entry.mode ?? null,
      stand_in: entry.stand_in ?? entry.standin ?? entry.replacement ?? null, ...(nonempty(entry.note) ? { note: entry.note.trim() } : {}) })));
}

// Packages that name an adapter of their own in a harness.json at their
// root: a run of them uses it in the plan's agent's place.
function ownAdapters(state) {
  return state.evals.cases.filter((item) => item.adapter?.from === 'package')
    .map((item) => ({ package: item.id, agent: item.adapter.agent ?? null, file: item.adapter.file ?? null }));
}

// The bindings `eval rebind` moved to this Spec export: each package whose
// scenario it found unchanged, what it was bound to, and what the finding
// rests on (the earlier export, a kept draft, or only the digest the package
// recorded of its scenario).
function reboundPackages(state) {
  return state.evals.cases.flatMap((item) => (Array.isArray(item.rebound) ? item.rebound : [])
    .filter((entry) => isRecord(entry) && entry.to === state.spec)
    .map((entry) => ({ package: item.id, from: entry.from ?? null, to: entry.to, at: entry.at ?? null, basis: entry.basis ?? null })));
}

// The technical choices a package's Task.md records that the Spec does not
// state, under its "Choices made here" heading.
function recordedChoices(state) {
  return state.evals.cases.flatMap((item) => {
    const file = path.join(state.root, 'evals', item.id, 'Task.md');
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return []; }
    const lines = text.split('\n');
    const at = lines.findIndex((line) => /^#{1,6}\s*Choices made here/i.test(line));
    if (at < 0) return [];
    const end = lines.findIndex((line, index) => index > at && /^#{1,6}\s/.test(line));
    const body = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    return body ? [{ package: item.id, file: path.relative(state.repo, file).split(path.sep).join('/'), text: body }] : [];
  });
}

// The code `spec new` recorded for this change: as the export holds it, else
// as genesis.json holds it now. Its content digest when one was kept; else
// its commit, whose content it was when the working tree was clean then; else
// the commit alone. clean says whether the working tree held no uncommitted
// application file then (null when not known). Null without either.
function specCode(repo, name, handoff = null) {
  const frozen = handoff ? recordedCode(handoff) : null;
  if (frozen && (nonempty(frozen.commit) || nonempty(frozen.digest))) {
    const clean = Array.isArray(frozen.changed_files) ? !frozen.changed_files.length : null;
    if (nonempty(frozen.digest) && (frozen.digest_of ?? 'content') === 'content') return { commit: frozen.commit, digest: frozen.digest, basis: 'content', clean };
    if (nonempty(frozen.commit) && clean) return { commit: frozen.commit, digest: commitCode(repo, frozen.commit).digest, basis: 'commit_content', clean };
    if (nonempty(frozen.commit)) return { commit: frozen.commit, digest: null, basis: 'commit', clean };
  }
  let context = null;
  try { context = readJSON(path.join(repo, 'openspec/changes', name, 'genesis.json')); } catch { return null; }
  const code = isRecord(context?.code) ? context.code : null;
  if (!code) return null;
  const content = code.digest ?? code.code_digest ?? code.snapshot?.digest ?? null;
  const commit = code.base_commit ?? code.commit ?? code.snapshot?.commit ?? null;
  const clean = Array.isArray(code.snapshot?.changed_files) ? !code.snapshot.changed_files.length : typeof code.working_tree_dirty === 'boolean' ? !code.working_tree_dirty : null;
  if (nonempty(content) && (code.digest_of ?? code.snapshot?.digest_of ?? 'content') === 'content') return { commit, digest: content, basis: 'content', clean };
  if (nonempty(commit) && code.working_tree_dirty === false) return { commit, digest: commitCode(repo, commit).digest, basis: 'commit_content', clean };
  if (nonempty(commit)) return { commit, digest: null, basis: 'commit', clean };
  return null;
}

// The base records of this Spec export whose code differs from the code
// `spec new` recorded: the application code changed before the baseline.
// files are the application files that differ from that code: the run's
// uncommitted files when it ran on the commit `spec new` recorded with a
// clean working tree; null when the records cannot name them.
function codeBeforeBaseline(state) {
  const recorded = specCode(state.repo, state.name, state.handoff);
  if (!recorded) return [];
  return state.usable.filter((run) => run.side === 'base' && run.spec_snapshot?.sha256 === state.spec).flatMap((run) => {
    const identity = codeIdentity(run.code_snapshot, state.repo);
    const commit = run.code_snapshot?.commit ?? null;
    const differs = recorded.digest && identity ? identity !== recorded.digest
      : recorded.basis === 'commit' && commit ? commit !== recorded.commit : null;
    const uncommitted = run.code_snapshot?.changed_files ?? [];
    // On the commit `spec new` recorded with a clean tree, the files that
    // differ are the run's uncommitted ones; on another commit, they are
    // compared with that commit's content.
    const sameCommit = nonempty(commit) && commit === recorded.commit;
    const files = recorded.clean !== true || !nonempty(recorded.commit) ? null
      : sameCommit && Array.isArray(run.code_snapshot?.changed_files) ? uncommitted
        : !sameCommit && run.code_snapshot ? changedFiles(state.repo, { commit: recorded.commit, file_digests: {} }, run.code_snapshot) : null;
    return differs ? [{ run_id: run.run_id, scope: run.scope ?? 'full', code: { commit, digest: identity }, uncommitted, files }] : [];
  }).map((entry) => ({ ...entry, spec_code: { commit: recorded.commit, digest: recorded.digest, basis: recorded.basis } }));
}

// What a code_changed_before_baseline message says of the files that differ
// from the code `spec new` recorded.
function movedFilesText(moved) {
  const known = moved.filter((entry) => entry.files?.length);
  if (!known.length) return 'the application code changed before the baseline';
  const same = known.length === moved.length && new Set(known.map((entry) => entry.files.join('\n'))).size === 1;
  const list = same ? named(known[0].files) : known.map((entry) => `${entry.run_id}: ${named(entry.files)}`).join('; ');
  const unnamed = moved.length - known.length;
  const text = `these application files differ from it: ${list}${unnamed ? ` (the records of ${unnamed === 1 ? 'one other base record cannot name its' : `${unnamed} other base records cannot name their`} files)` : ''}`;
  // A .dockerignore decides what goes into the image, so it is application code.
  const onlyIgnore = known.every((entry) => entry.files.length === 1 && entry.files[0] === '.dockerignore');
  return onlyIgnore ? `${text}. A .dockerignore decides what goes into the image, so it counts as application code; a package that builds from the project root needs its .genesis rule` : text;
}

// Trials of this Spec export made before its first base record, on the code
// that base records describe or the start code a loop pinned; with no base
// record yet, every trial of the export. What they showed was seen before
// any expectation was fixed by a baseline.
function trialsBeforeBaseline(state) {
  const ofExport = state.runs.filter((run) => run.spec_snapshot?.sha256 === state.spec);
  const first = ofExport.find((run) => run.side === 'base') ?? null;
  const trials = ofExport.filter((run) => isTrial(run) && (!first || String(run.started_at) < String(first.started_at)));
  if (!trials.length) return [];
  const pin = pinnedStart(state.repo, state.name);
  const codes = new Set([pin?.start?.digest ?? null, ...ofExport.filter((run) => run.side === 'base').map((run) => codeIdentity(run.code_snapshot, state.repo) ?? run.code_identity ?? null)]
    .filter(Boolean));
  return trials.filter((run) => !codes.size || codes.has(codeIdentity(run.code_snapshot, state.repo) ?? run.code_identity ?? null)).map((run) => ({
    run_id: run.run_id, started_at: run.started_at, cases: (run.cases ?? []).map((item) => item.id), code_matches: codes.size ? true : null,
    failed: [...new Set(state.pool.filter((entry) => entry.run_id === run.run_id && entry.result === 'fail').map((entry) => `${entry.case}/${entry.check}`))].sort(),
    passed: [...new Set(state.pool.filter((entry) => entry.run_id === run.run_id && entry.result === 'pass').map((entry) => `${entry.case}/${entry.check}`))].sort(),
  }));
}

// Runs of this Spec export made with the user's cost approval, before any
// checks confirmation recorded a plan.
function costApprovedRuns(state) {
  return state.runs.filter((run) => run.spec_snapshot?.sha256 === state.spec && isRecord(run.cost_approval)).map((run) => ({
    run_id: run.run_id, side: run.side, by: run.cost_approval.by ?? null, ref: run.cost_approval.ref ?? null, at: run.cost_approval.at ?? null,
    model: run.environment_ref?.model ?? null, cost_usd: run.usage?.cost_usd ?? null, minutes: run.usage?.minutes ?? null }));
}

// What writes the shipped helper and the kit's verifier code into the packages.
const syncSuggestion = (state) => ({ command: ['eval', 'sync', state.name, '--repo', state.repo], why: 'writes the shipped helper and the kit\'s verifier code into the package' });

// The gaps validateEval reported, as eval review and eval confirm pass them
// on. A package that is not runnable yet does not hold back its checks; a
// package whose shared verifier code differs also carries the command that
// writes the shared code, when validateEval gave none.
function evalGaps(state) {
  return state.evals.gaps.filter((entry) => entry.code !== 'integration_pending')
    .map((entry) => (entry.code === 'shared_code_mismatch' && entry.suggestion === undefined ? { ...clean(entry), suggestion: syncSuggestion(state) } : clean(entry)));
}

// Packages written against a Spec draft: proved, never confirmed or run.
// validateEval reports each such package itself, so only those it did not
// report are added here.
function draftGap(state) {
  const reported = new Set(state.evals.gaps.filter((entry) => entry.code === 'draft_bound').map((entry) => entry.case).filter(nonempty));
  const drafts = state.evals.cases.filter((item) => draftBound(item) && !reported.has(item.id)).map((item) => item.id);
  return drafts.length ? { ...gap('draft_bound', `${drafts.join(', ')} ${drafts.length === 1 ? 'is' : 'are'} written against a Spec draft: ${drafts.length === 1 ? 'it' : 'they'} can be written and proved, but no confirmation or run takes ${drafts.length === 1 ? 'it' : 'them'} until bound to the Spec export (\`eval rebind\`).`, 'agent', 'artifact', 'package'), cases: drafts } : null;
}

// Packages whose shared verifier code differs from the kit's. validateEval
// reports each package's mismatched files, with their digests, itself; a
// mismatch is added here only when it did not, so each is reported once. One
// that names no file counts as reported once its package is.
function sharedGaps(state) {
  const all = state.evals.cases.map((item) => item.id);
  const fileOf = (entry) => entry?.file ?? entry?.path ?? null;
  const reported = new Map();
  for (const entry of state.evals.gaps) {
    if (entry.code !== 'shared_code_mismatch' || !nonempty(entry.case)) continue;
    reported.set(entry.case, new Set([...(reported.get(entry.case) ?? []), ...(Array.isArray(entry.files) ? entry.files : [])]));
  }
  const covered = (id, entry) => reported.has(id) && (!fileOf(entry) || reported.get(id).has(fileOf(entry)));
  const mismatches = sharedMismatches(state.repo, state.name, all);
  const ids = mismatches.some((entry) => !entry.case) ? all : [...new Set(mismatches.map((entry) => entry.case))];
  return ids.flatMap((id) => {
    const own = mismatches.filter((entry) => (!entry.case || entry.case === id) && !covered(id, entry));
    if (!own.length) return [];
    const files = own.map(fileOf).filter(Boolean);
    return [{ ...gap('shared_code_mismatch', `${id}: tests/genesis.sh or tests/shared/ differs from the shipped helper or the kit's verifier/ folder${files.length ? ` (${files.join(', ')})` : ''}, so the reviewer's verdicts would rest on other verifier code than the package runs. \`eval sync\` writes the shared code into the package.`, 'agent', 'artifact', 'package'),
      case: id, ...(files.length ? { files } : {}), mismatches: own, suggestion: syncSuggestion(state) }];
  });
}

// Every THEN line of the packages with what checks it, its expected and
// actual result before the change, its proof, and the reviewer's verdict:
// from answers when they answer for the package as it is, else carried from
// the latest confirmation. origin says who judged it.
function reviewLines(state, answers) {
  const given = isRecord(answers) && Array.isArray(answers.lines) ? answers : null;
  return state.evals.then_lines.map((row) => {
    const declared = state.declared[row.case];
    const fixtures = { author: [], review: [], 'self-review': [] };
    for (const fixture of Array.isArray(declared?.fixtures) ? declared.fixtures : []) {
      if (!isRecord(fixture) || !nonempty(fixture.name)) continue;
      (fixtures[fixture.origin] ?? fixtures.author).push(fixture.name);
    }
    const answer = given?.lines.find((entry) => isRecord(entry) && entry.package === row.case && nonempty(entry.then) && thenKey(entry.then) === thenKey(row.then)
      && answersPackage(entry, state, row.case));
    const before = carried(state, row);
    return {
      requirement: row.requirement, scenario: row.scenario, package: row.case, then: row.then, status: row.status,
      checks: [...row.gating.map((entry) => ({ id: entry.check, expect: entry.expect, role: 'gating' })),
        ...row.diagnostic.map((entry) => ({ id: entry.check, expect: entry.expect, role: 'diagnostic' }))],
      diagnostic: row.diagnostic.map((entry) => entry.check), fixtures, counterexamples: row.counterexamples ?? [],
      ...(row.reason ? { reason: row.reason } : {}),
      baseline: row.status === 'gating' || judgeHeld(row, state.judgeGating)
        ? (row.status === 'gating' ? row.gating.map((entry) => entry.check) : judgeChecksOf(row)).map((check) => ({ check, expected: expectedResult(state, row.case, check),
          result: baselineResult(state, row.case, check) })) : null,
      // What proves that the line's checks can fail: its real failure at the
      // baseline, or a reviewer's counterexample eval check proved.
      proof: proofOf(state, row),
      review: answer ? { verdict: answer.verdict ?? null, note: answer.note ?? null, carried: false, origin: given.review?.origin ?? null }
        : before ? { verdict: before.verdict, note: before.note, carried: true, origin: before.origin } : null,
    };
  });
}

// The decisions that are the user's before the checks are confirmed: each
// with the facts to show and a message. lines are reviewLines'.
function mustDecideOf(state, lines) {
  const { evals, match } = state;
  const mustDecide = [];
  for (const row of evals.then_lines.filter((entry) => entry.status === 'uncovered')) {
    mustDecide.push({ code: 'then_uncovered', package: row.case, then: row.then,
      message: `No gating check verifies "${row.then}" (${row.case}) and scenario.manual does not list it for the user to judge, so the checks cannot be confirmed.` });
  }
  for (const row of evals.then_lines.filter((entry) => entry.status === 'manual')) {
    mustDecide.push({ code: 'manual_line', package: row.case, then: row.then, reason: row.reason ?? null,
      message: `No check verifies "${row.then}" (${row.case}): ${row.reason ?? 'no reason given'}. The user judges it at acceptance, from what the evaluated agent produced. They agree to that, or ask for a check.` });
  }
  // Gating checks whose expect is worded otherwise than their line, in one
  // item: the user reads whether each says the same.
  const reworded = evals.then_lines.filter((entry) => entry.status === 'gating').flatMap((row) => row.gating
    .filter((entry) => thenKey(entry.expect) !== thenKey(row.then)).map((entry) => ({ package: row.case, then: row.then, check: entry.check, expect: entry.expect })));
  if (reworded.length) {
    mustDecide.push({ code: 'expect_differs', lines: reworded,
      message: `${reworded.length === 1 ? 'The expect of this gating check is' : 'The expects of these gating checks are'} worded otherwise than ${reworded.length === 1 ? 'its line' : 'their lines'}: ${reworded.map((entry) => `${entry.package}/${entry.check} expects "${entry.expect}" for "${entry.then}"`).join('; ')}. The user reads whether each says the same, no less and no more.` });
  }
  for (const row of evals.then_lines.filter((entry) => entry.status === 'gating' && entry.counterexamples?.length
    && entry.counterexamples.every((item) => item.origin === 'self-review'))) {
    mustDecide.push({ code: 'self_review_only', package: row.case, then: row.then,
      message: `Only a self-review counterexample stands behind "${row.then}" (${row.case}): the author wrote it without a second reader. The user decides whether that is enough.` });
  }
  // A line a program checks that the reviewer found asks less, or more, than
  // it says: the agent fixes the check or moves the line to scenario.manual,
  // or the user accepts the check as it is (--accept-verdict, with a reason).
  for (const row of lines.filter((entry) => entry.status === 'gating' && ACCEPTABLE.includes(entry.review?.verdict))) {
    mustDecide.push({ code: 'verdict_acceptable', package: row.package, then: row.then, verdict: row.review.verdict, note: row.review.note ?? null,
      message: `The reviewer found that the checks of "${row.then}" (${row.package}) ask ${row.review.verdict === 'weaker' ? 'less' : 'more'} than the line says${nonempty(row.review.note) ? `: ${row.review.note.trim()}` : ''}. The check is fixed, or the line moves to scenario.manual, or the user accepts the check as it is, with a reason, and the acceptance says so for this line.` });
  }
  // The author's own verdicts on whether the checks say what a line says.
  const selfJudged = lines.filter((row) => row.review?.verdict && row.review.origin === 'self-review');
  if (selfJudged.length) {
    mustDecide.push({ code: 'self_review_verdict', lines: selfJudged.map((row) => ({ package: row.package, then: row.then, verdict: row.review.verdict, carried: row.review.carried })),
      message: `The author judged ${selfJudged.length === 1 ? 'this line' : 'these lines'} without a second reader (review.origin self-review): ${selfJudged.map((row) => `"${row.then}" (${row.package}) ${row.review.verdict}`).join('; ')}. The user decides whether that is enough.` });
  }
  for (const entry of match?.packages ?? []) {
    const files = matchFiles({ packages: [entry], kit: match.kit });
    mustDecide.push({ code: 'changed_since_confirmation', package: entry.id, files,
      message: `${entry.id} changed since the user confirmed the checks (${named(files)}). The reviewer reads the diff and says whether it loosens a THEN line; confirming it is a revision.` });
  }
  const settings = planSettings(state);
  if (settings.changed.length) {
    const text = (key) => settings.changed.map((entry) => `${entry.key} ${entry[key] ?? 'none'}`).join(' and ');
    mustDecide.push({ code: 'plan_changed_since_confirmation', changed: settings.changed,
      message: `harness.json changed since the user confirmed the checks: it names ${text('kit')} where they confirmed ${text('confirmed')}. Without ${settings.changed.map((entry) => `--${entry.key}`).join(' or ')}, \`eval confirm\` records what run_plan shows. The user decides which one runs.` });
  }
  // A baseline recorded before the confirmation with a plan of its own, as
  // with plan flags: the user decides whether the confirmation takes it.
  const recorded = recordedDiffers(state, flaglessPlan(state));
  if (recorded) {
    mustDecide.push({ code: 'baseline_plan_recorded', baseline: recorded.baseline, keys: recorded.keys,
      message: `${recorded.text} The user decides which one runs.` });
  }
  const diff = specDiff(state);
  if (diff && (diff.added.length || diff.removed.length)) {
    const text = (items) => items.map((line) => `"${line.then}"`).join(', ');
    mustDecide.push({ code: 'spec_changed_since_confirmation', added: diff.added, removed: diff.removed,
      message: `The last confirmation was for another Spec export (${String(diff.from).slice(7, 19)}). Since then${diff.added.length ? `, these lines were added: ${text(diff.added)}` : ''}${diff.added.length && diff.removed.length ? ';' : ''}${diff.removed.length ? ` these lines were removed: ${text(diff.removed)}` : ''}.` });
  }
  for (const item of oldPackageFailures(state)) {
    mustDecide.push({ code: 'failed_with_old_package', package: item.case, check: item.check, failed: item.failed, passed: item.passed,
      message: `${item.case}/${item.check} failed with an earlier version of its package (${item.failed.join(', ')}) and passed with the package as it is now on the same code (${item.passed.join(', ')}). The user decides whether the change to the package fixed the check or hid a failure.` });
  }
  // Rule V: a package that can reach outside networks declares a live
  // dependency, or no confirmation takes it.
  const reachable = networkUndeclared(evals.cases);
  if (reachable.length) {
    mustDecide.push({ code: 'network_undeclared', packages: reachable.map((item) => item.id), message: `${networkUndeclaredText(reachable)} \`eval confirm\` refuses the checks until then.` });
  }
  // An expectation set after a result was seen: the user hears what it was,
  // what the base records got, and what it is now. Every base record of this
  // export counts, and an expectation written only after one is listed too.
  const moves = expectationMoves(state);
  const seenText = (entry) => (entry.results_seen.length ? entry.results_seen.map((item) => `${item.result} in ${item.run_id}`).join(', ') : 'no readable result');
  if (moves.changed.length) {
    mustDecide.push({ code: 'expectation_changed_after_baseline', changes: moves.changed,
      message: `baseline-expectations.json changed after a base record of this Spec export ran: ${moves.changed.map((entry) => `${entry.case}/${entry.check} was expected to ${entry.was} at ${entry.after.join(', ')}, got ${seenText(entry)}, and is now expected to ${entry.now}`).join('; ')}. An expected result is fixed before any baseline, so the user decides whether the new expectation says what the change is for, or follows the result.` });
  }
  if (moves.added.length) {
    mustDecide.push({ code: 'expectation_added_after_baseline', additions: moves.added,
      message: `baseline-expectations.json declares expected results that no base record had when it ran: ${moves.added.map((entry) => `${entry.case}/${entry.check} is now expected to ${entry.now}, written after ${entry.after.join(', ')}, which got ${seenText(entry)}`).join('; ')}. The user decides whether each says what the change is for, or follows the result.` });
  }
  // The application code changed between `spec new` and a baseline.
  const moved = codeBeforeBaseline(state);
  if (moved.length) {
    mustDecide.push({ code: 'code_changed_before_baseline', records: moved,
      message: `${moved.map((entry) => entry.run_id).join(', ')} ran on other code than \`spec new\` recorded for this change (${moved[0].spec_code.commit ? `commit ${moved[0].spec_code.commit.slice(0, 7)}` : 'its code'}${moved[0].spec_code.basis === 'commit' ? ', compared by commit only' : ''}): ${movedFilesText(moved)}. The user decides whether that code is the code before the change.` });
  }
  // Trials on the start code before any base record: the agent saw how the
  // code behaves before the expectations were fixed.
  const trials = trialsBeforeBaseline(state);
  if (trials.length) {
    mustDecide.push({ code: 'trial_before_baseline', trials,
      message: `${trials.map((entry) => entry.run_id).join(', ')} ${trials.length === 1 ? 'is a trial' : 'are trials'} made before the first base record of this Spec export${trials[0].code_matches ? ', on the code the base records describe' : ''}, so ${trials.length === 1 ? 'its' : 'their'} results were seen before any expectation was fixed by a baseline${trials.some((entry) => entry.failed.length) ? `; failed: ${[...new Set(trials.flatMap((entry) => entry.failed))].join(', ')}` : ''}. The user decides whether the expected results still say what the change is for.` });
  }
  // Runs whose cost the user approved before any confirmation.
  const approved = costApprovedRuns(state);
  if (approved.length) {
    mustDecide.push({ code: 'cost_approved_runs', runs: approved,
      message: `${approved.map((entry) => `${entry.run_id} (${entry.side}, approved by ${entry.by}${entry.cost_usd !== null ? `, ${entry.cost_usd} USD reported` : ''})`).join('; ')} called a model before any checks confirmation of this Spec export, on the user's cost approval. The user sees them before confirming the plan.` });
  }
  // The run index: runs whose record is gone count as failures, and an index
  // that was removed or cut can no longer count them.
  if (state.ledger.lost.length || state.ledger.interrupted.length) {
    mustDecide.push({ code: 'ledger_runs_lost', lost: state.ledger.lost, interrupted: state.ledger.interrupted, message: ledgerText({ ...state.ledger, index_missing: false, unindexed: [], broken_lines: [], altered: [] }) });
  }
  if (state.ledger.index_missing || state.ledger.unindexed.length || state.ledger.broken_lines.length || state.ledger.altered.length) {
    mustDecide.push({ code: 'ledger_incomplete', index_missing: state.ledger.index_missing, unindexed: state.ledger.unindexed, broken_lines: state.ledger.broken_lines,
      altered: state.ledger.altered, message: `${ledgerText({ ...state.ledger, lost: [], interrupted: [] })} Failures of runs it no longer lists cannot be counted on this machine.` });
  }
  // Packages written for another Spec, or a draft, that `eval rebind` bound
  // to this export because their scenario read the same.
  const rebound = reboundPackages(state);
  if (rebound.length) {
    const why = (entry) => (entry.basis === 'recorded_digest' ? 'by the digest the package recorded of its scenario, since the earlier text could not be read'
      : entry.basis === 'kept_draft' ? 'against the kept Spec draft it was written for' : 'against the export it was written for');
    mustDecide.push({ code: 'package_rebound', packages: rebound,
      message: `\`eval rebind\` bound ${rebound.map((entry) => `${entry.package} (from ${entry.from?.draft ? 'a Spec draft' : 'another export'} ${String(entry.from?.sha256 ?? '').slice(7, 19)}, ${why(entry)})`).join('; ')} to this Spec export, because the requirement and the scenario read the same. The user decides whether the checks written then still say what the lines say now.` });
  }
  // A judge check is diagnostic unless the user makes its line gating. Made
  // gating, the line is held like any gating line: eval confirm takes only
  // the verdict faithful for it and a proof that its check can fail.
  const gatingJudges = new Set(state.judgeGating);
  for (const entry of kindChecks(state, JUDGE_KIND)) {
    const proof = entry.then === null ? null : state.proofs.get(proofKey(entry.package, entry.then)) ?? null;
    mustDecide.push({ code: 'judge_check', package: entry.package, check: entry.check, then: entry.then, gating: gatingJudges.has(judgeKey(entry.package, entry.then)),
      proof: proof ? { sources: proof.sources, baseline: proof.baseline, counterexamples: proof.counterexamples, ...(proof.missing ? { missing: proof.missing } : {}) } : null,
      message: `${entry.package}/${entry.check} judges "${entry.then ?? 'its line'}" with the project's own judging program. Its result is diagnostic and needs no proof unless the user makes the line gating at confirmation (--judge-gating ${entry.package}:THEN). Made gating, it counts in a run's verdict like any gating check, and \`eval confirm\` takes the line only with the verdict faithful, not not_observable, and with a proof that the check can fail: its failure, with evidence, at a baseline that expected fail, or a reviewer's counterexample naming the line in its then that \`eval check\` proved. ${proof?.sources.length ? `That proof holds now (${proof.sources.join(', ')}).` : `No such proof holds now${proof?.missing?.length ? ` (${proof.missing.join('; ')})` : ''}.`}` });
  }
  // A check bound to several lines: each still needs its own proof.
  for (const group of thenGroups(state)) {
    mustDecide.push({ code: 'then_group', ...group,
      message: `${group.package}/${group.check} checks ${group.lines.length} lines together: ${group.lines.map((line) => `"${line}"`).join(', ')}. Each line keeps a verdict of its own and needs a counterexample that breaks it alone; a failure of the group at a baseline proves none of them. The user decides whether these lines can only fail together.` });
  }
  // Hints that a result could depend on a model, which decide nothing.
  if (state.signals.length) {
    mustDecide.push({ code: 'variability_signals', signals: state.signals,
      message: `Hints that a scenario's result could depend on a model: ${state.signals.map((entry) => `${entry.name} (${entry.kind}, ${entry.file})`).join(', ')}. They decide no tier. The reviewer checks that each scenario replaces the model with a stand-in where it should, and the user hears that the checks then test the code around the model, not its answers.` });
  }
  return mustDecide;
}

// What the user sees before a confirmation, as data; the wording is the
// agent's. A confirmation records its digest (shown).
function mustShowOf(state, lines, mustDecide, plan) {
  const gatingJudges = new Set(Array.isArray(state.latest?.judge_gating) ? state.latest.judge_gating : []);
  return {
    lines: lines.map((row) => ({ package: row.package, requirement: row.requirement, scenario: row.scenario, then: row.then, status: row.status, checks: row.checks,
      verdict: row.review?.verdict ?? null, verdict_origin: row.review?.origin ?? null, carried: row.review?.carried ?? false, baseline: row.baseline,
      proof: row.proof ? { sources: row.proof.sources, baseline: row.proof.baseline, counterexamples: row.proof.counterexamples, ...(row.proof.missing ? { missing: row.proof.missing } : {}) } : null,
      ...(row.reason ? { reason: row.reason } : {}) })),
    must_decide: mustDecide,
    run_plan: [{ tier: { proposed: plan.tier.proposed, eligible: plan.tier.eligible, reasons: plan.tier.reasons, ...(plan.tier.requested ? { requested: plan.tier.requested } : {}) },
      agent: plan.agent, model: plan.model,
      attempts: { needed: plan.attempts_needed, live: plan.live, undeclared: plan.undeclared, ...(plan.proposal ? { proposal: plan.proposal, strength: plan.strength } : {}) },
      estimate: plan.estimate, basis: plan.basis, ...(plan.run_overhead ? { run_overhead: plan.run_overhead } : {}), estimate_missing: plan.estimate_missing, not_counted: plan.not_counted,
      budget: plan.budget, cost_cap: typeof plan.budget?.max_cost_usd === 'number' ? plan.budget.max_cost_usd : null }],
    adapters: ownAdapters(state),
    rebound: reboundPackages(state),
    dependencies: dependenciesOf(state),
    code_checks: kindChecks(state, CODE_KIND).map((entry) => ({ ...entry, tests_code_directly: true })),
    judge_checks: kindChecks(state, JUDGE_KIND).map((entry) => ({ ...entry, gating: gatingJudges.has(judgeKey(entry.package, entry.then)) })),
    then_groups: thenGroups(state),
    recorded_choices: recordedChoices(state),
    ledger: [{ lost: state.ledger.lost, interrupted: state.ledger.interrupted, index_missing: state.ledger.index_missing, unindexed: state.ledger.unindexed,
      broken_lines: state.ledger.broken_lines, altered: state.ledger.altered }],
  };
}

// Lists every THEN line of the packages with what checks it, the decisions the
// user must make, what the user must see (must_show), the reviewer's
// questions and brief, a template for the reviewer's answers, and a proposed
// run plan. Read-only.
export function reviewEval(repo, name) {
  const state = reviewState(repo, name);
  const { evals, latest, match, snapshot } = state;
  const answers = isRecord(state.answers) && Array.isArray(state.answers.lines) ? state.answers : null;
  const lines = reviewLines(state, answers);
  const mustDecide = mustDecideOf(state, lines);
  const proposed = template(state);
  const open = (row) => proposed.lines.find((entry) => entry.package === row.case && thenKey(entry.then) === thenKey(row.then))?.verdict === null;
  // A judged line the latest confirmation made gating is asked about as a
  // line its judge check verifies.
  const checkedBy = (row) => (row.status === 'gating' ? row.gating.map((entry) => entry.check) : judgeChecksOf(row));
  const questions = [
    ...state.lines.filter(open).map((row) => (row.status === 'gating' || judgeHeld(row, state.judgeGating)
      ? { package: row.case, then: row.then, ask: `${checkedBy(row).length === 1 ? 'Does' : 'Do'} ${checkedBy(row).join(', ')} of ${row.case} say what "${row.then}" says, no weaker and no stronger? Answer faithful, weaker, stronger, different, vacuous or not_observable, with a note.` }
      : { package: row.case, then: row.then, ask: `No check verifies "${row.then}" of ${row.case}: ${row.reason ?? 'no reason given'}. Answer not_observable when no program can judge it; otherwise say how one could, with the verdict a check would get.${judgedLine(row) ? ` Its judge check ${judgeChecksOf(row).join(', ')} is diagnostic; a confirmation that makes it gating (--judge-gating) takes the line only with the verdict faithful for that judge.` : ''}` })),
    ...revisedPackages(state).map((entry) => ({ package: entry.id,
      ask: `Read the diff of ${entry.id} since the checks were confirmed (${named(matchFiles({ packages: [entry], kit: match.kit })) || 'its package or the kit'}). Does it loosen a THEN line? Answer loosens true or false, with a note.` })),
  ];
  const relative = (file) => path.relative(repo, file).split(path.sep).join('/');
  const kitFiles = (folder) => {
    const prefix = `${folder}/`;
    return Object.keys(snapshot.kit).filter((file) => file.startsWith(prefix)).map((file) => `.genesis/edd/harness/${file}`).sort();
  };
  const packageFiles = (id) => Object.keys(snapshot.packages[id] ?? {}).sort().map((file) => `${relative(path.join(state.root, 'evals', id))}/${file}`);
  const ids = evals.cases.map((item) => item.id);
  const passFixtures = ids.flatMap((id) => (Array.isArray(state.declared[id]?.fixtures) ? state.declared[id].fixtures : [])
    .filter((fixture) => isRecord(fixture) && [undefined, 'author'].includes(fixture.origin) && isRecord(fixture.expect)
      && Object.values(fixture.expect).length && Object.values(fixture.expect).every((result) => result === 'pass'))
    .map((fixture) => `${relative(path.join(state.root, 'evals', id))}/tests/fixtures/${fixture.name}.sh`));
  const plan = runPlan(repo, name, state);
  const light = plan.tier.proposed === 'light';
  // The lines a reviewer writes a counterexample for: in the light tier, a
  // line with no proof that its checks can fail and no counterexample yet;
  // in the full tier, every line a program checks that has none yet. A line
  // a group check covers always needs its own. A judged line the latest
  // confirmation made gating needs one while it has no proof.
  const lacking = state.lines.filter((row) => (row.status === 'gating' && !(row.counterexamples ?? []).length
    && (!light || !state.proofs.get(proofKey(row.case, row.then))?.sources.length))
    || (judgeHeld(row, state.judgeGating) && !state.proofs.get(proofKey(row.case, row.then))?.sources.length));
  // Counterexamples written but not proved yet wait for `eval check`.
  const unproved = light ? state.lines.filter((row) => row.status === 'gating' && (row.counterexamples ?? []).length
    && !state.proofs.get(proofKey(row.case, row.then))?.sources.length) : [];
  // In a new project no package runs before it is connected, so no
  // counterexample can be proved yet: the reviewer judges the checks now, and
  // writes and proves the counterexamples once the packages are connected.
  const connected = evals.cases.some((item) => (item.integration?.missing ?? []).length
    && item.integration.missing.every((entry) => entry === 'review' || entry === 'check'));
  const later = !state.ready.length && !connected && requireProject(repo).mode === 'new';
  const COUNTEREXAMPLE = 'a fixture with origin review and a note, whose script leaves a result that breaks only that line (or, for a code-level check, a patch to the application code that breaks only that line). It expects fail for the checks bound to that line and pass or unknown for every other gating check of the package';
  const listedRows = (rows) => rows.map((row) => `"${row.then}" (${row.case})`).join(', ');
  // In the light tier the reviewer may read what the trial baseline left.
  const evidence = light && state.base?.is_baseline ? (state.base.cases ?? []).map((item) => `.genesis/edd/${name}/runs/${state.base.run_id}/${item.id}/logs/`) : [];
  const write = lacking.length
    ? `Without reading tests/test.sh, tests/shared/ or the kit's verifier/, write a counterexample for each line in reviewer_brief.lines${light ? ', the lines with no proof yet that their checks can fail (lines[].proof)' : ', every line a program checks that has none yet'}: ${COUNTEREXAMPLE}.${lacking.some((row) => judgeHeld(row, state.judgeGating)) ? ' For a line whose judge check the user made gating, the fixture names that line in its then and expects fail for that judge check.' : ''}${evidence.length ? ' You may read what the baseline left, which reviewer_brief.give lists.' : ''} \`eval check\` proves new fixtures alone. A counterexample that does not get fail shows a fault in the verifier, never in the counterexample.`
    : `No line needs a new counterexample: ${light ? 'every line a program checks has a proof that its checks can fail, or a counterexample' : 'every line a program checks has a counterexample'}.${unproved.length ? ` The counterexamples of ${listedRows(unproved)} wait for \`eval check\`.` : ''}`;
  // The lines whose verdict the review keeps from the latest confirmation,
  // since what their package checks did not change.
  const keptLines = state.lines.filter((row) => carried(state, row)?.verdict).length;
  const brief = {
    first: later
      ? `No package can run yet: in a new project the packages are connected to an entry of the program first. A reviewer who judges now judges only, from tests/checks.json, whether the expect of each check bound to a line says what the line says, no weaker and no stronger. Once a package is connected, they write for every line a program checks a counterexample without reading tests/test.sh, tests/shared/ or the kit's verifier/: ${COUNTEREXAMPLE}; connecting the package changes it, so the user confirms it again as a revision.`
      : write,
    then: later
      ? 'Then answer each question into review.json, from the review_template: a verdict and a note for every line, and for every changed package whether its diff loosens a THEN line. Set review.origin to review, or to self-review when the author reviews alone.'
      : `Then read the verifier and answer each question into review.json, from the review_template of this review: a verdict and a note for every line, and for every changed package whether its diff loosens a THEN line. The template names each package by its run_digest, which a counterexample leaves as it was; a fix to the verifier changes the package, and the template of the review before it no longer answers for it.${keptLines ? ` ${keptLines} line${keptLines === 1 ? ' keeps its' : 's keep their'} verdict from the last confirmation in the template (lines[].review.carried), since what ${keptLines === 1 ? 'its package checks' : 'their packages check'} did not change: checks.json without fixtures, the rest of tests/ and the kit's verifier/. For ${keptLines === 1 ? 'it' : 'them'}, the question left is whether the diff of a changed package loosens a THEN line.` : ''}${light ? ' For a line proved by its failure before the change, the baseline must have failed for the behavior this line changes, not for another reason.' : ''} Set review.origin to review, or to self-review when the author reviews alone.`,
    // The lines that need a counterexample.
    lines: later ? [] : lacking.map((row) => ({ package: row.case, then: row.then })),
    give: [...new Set([relative(path.join(repo, 'openspec/changes', name, 'specs')), ...ids.map((id) => `${relative(path.join(state.root, 'evals', id))}/tests/checks.json`),
      ...ids.flatMap((id) => packageFiles(id).filter((file) => file.includes('/environment/'))),
      '.genesis/edd/harness/PROJECT.md', ...kitFiles('environment'), ...passFixtures, ...evidence])],
    withhold: [...ids.flatMap((id) => [`${relative(path.join(state.root, 'evals', id))}/tests/test.sh`, `${relative(path.join(state.root, 'evals', id))}/tests/shared/`]),
      '.genesis/edd/harness/verifier/'],
  };
  const warnings = [...evals.warnings, ...(state.read.gap ? [state.read.gap.message] : []),
    ...(state.expectationsError ? [`.genesis/edd/${name}/baseline-expectations.json cannot be read (${state.expectationsError}); the expected baseline results are not shown.`] : [])];
  const unbound = unboundGap(evals);
  const reachable = networkUndeclared(evals.cases);
  // A confirmation recorded before rule V still stands for a loop; the next
  // one refuses those packages.
  const earlierRule = reachable.filter((item) => latest?.schema_version === '1.0' && latest.packages?.[item.id]);
  if (earlierRule.length) {
    warnings.push(`The checks confirmation of ${latest.confirmed?.at ?? 'unknown date'} was recorded before a package that can reach outside networks had to declare a live dependency: ${earlierRule.map((item) => item.id).join(', ')}. It still stands for a loop, but the next \`eval confirm\` refuses ${earlierRule.length === 1 ? 'that package' : 'those packages'} (network_undeclared).`);
  }
  // A plan that runs a package more than once can cost money; a cap is the
  // user's, and only the cost an adapter reports counts toward it.
  if (plan.live.length && typeof plan.budget.max_cost_usd !== 'number') {
    warnings.push(`${plan.live.join(', ')} ${plan.live.length === 1 ? 'declares' : 'declare'} a live dependency, and no cost cap is set. A cap is the user's (\`eval confirm --max-cost USD\`); it counts the cost the adapter reports, and an adapter that reports none leaves it unenforced.`);
  }
  if (plan.basis === null && !state.ready.length && requireProject(repo).mode === 'new') warnings.push('The CLI has no estimate of a run yet: in a new project nothing gives minutes until the packages are connected and `eval check` has run them.');
  if (dependenciesUnknown(repo, state) && (latest?.run_plan?.attempts ?? null) === null) warnings.push(attemptsLater);
  const drafts = draftGap(state);
  const shared = sharedGaps(state);
  const mustShow = mustShowOf(state, lines, mustDecide, plan);
  let lock = null;
  try { lock = changeLock(repo, name, { spec: state.spec }); } catch { /* reported by run start */ }
  const phase = state.loop ? phaseOf(repo, name) : null;
  return {
    change: name, spec: state.spec,
    confirmation: latest ? { id: latest.id, at: latest.confirmed?.at ?? null, by: latest.confirmed?.by ?? null, kind: latest.confirmed?.kind ?? null } : null,
    current: Boolean(match?.matches),
    lines, must_decide: mustDecide, must_show: mustShow, shown: digest(JSON.stringify(mustShow)), questions, reviewer_brief: brief, review_template: proposed, run_plan: plan,
    spec_diff: specDiff(state),
    gaps: [...evalGaps(state), ...(unbound ? [unbound] : []), ...(state.read.gap ? [clean(state.read.gap)] : []),
      ...(drafts ? [drafts] : []), ...shared],
    warnings,
    // What a confirmation of these checks is: the user's own decision, with
    // who decided and where they said so. A confirmation of an export
    // confirmed before is a revision; its reason is optional. In the light
    // tier the plan is fixed, so --agent and --model are refused there.
    // --start-loop records that the user's words also start a loop.
    confirm: { owner: 'user', needs: ['--by', '--ref', '--verdicts'], revision: Boolean(latest), reason: 'optional',
      refused_in_tier: light ? ['--agent', '--model'] : [], line_unproven_refused: light,
      flags: ['--start-loop', '--stop-on-stuck', '--judge-gating CASE:THEN', '--tier full', '--attempts N', '--max-iterations N', '--max-minutes M', '--max-cost USD'] },
    // The loop of this Spec export, when one started: a confirmation whose
    // plan, tier or packages differ from the loop's ends it.
    loop: state.loop ? { started_at: state.loop.started_at, phase, ends_if_plan_or_packages_differ: phase !== 'ended' } : null,
    ...(lock ? { change_lock: lock } : {}),
    suggestion: null,
  };
}

// Why review.json cannot be read as answers to this review, or null.
function unreadableReview(answers) {
  if (!isRecord(answers)) return 'it is not a JSON object';
  if (answers.schema_version !== '1.0') return 'schema_version must be "1.0"';
  if (!nonempty(answers.spec)) return 'spec must be the sha256 of the exported Spec';
  if (!isRecord(answers.review) || !ORIGINS.includes(answers.review.origin)) return 'review.origin must be review or self-review';
  if (!Array.isArray(answers.lines)) return 'lines must be a list';
  for (const [index, line] of answers.lines.entries()) {
    if (!isRecord(line) || !nonempty(line.package) || !nonempty(line.then) || (!nonempty(line.run_digest) && !nonempty(line.task_digest))) return `line ${index + 1} needs package, then and run_digest`;
    if (!VERDICTS.includes(line.verdict)) return `line ${index + 1} ("${line.then}") has no verdict: it must be one of ${VERDICTS.join(', ')}`;
  }
  if (answers.packages !== undefined) {
    if (!Array.isArray(answers.packages)) return 'packages must be a list';
    for (const [index, item] of answers.packages.entries()) {
      if (!isRecord(item) || !nonempty(item.package) || (!nonempty(item.run_digest) && !nonempty(item.task_digest)) || typeof item.loosens !== 'boolean') return `package answer ${index + 1} needs package, run_digest and loosens (true or false)`;
    }
  }
  return null;
}

// The decision a confirmation gives on a must_decide item: the one its flags
// give (the plan it recorded, whether a judge check's line became gating,
// whether a weaker or stronger line was accepted), else confirmed_as_shown:
// no flag decides it, so the user's confirmation itself accepts it as shown.
// The items that refuse a confirmation (then_uncovered, network_undeclared)
// never reach a written entry.
function decisionOf(item, plan, judgeGating, accepted = new Map()) {
  if (item.code === 'verdict_acceptable') return { decision: accepted.has(lineKey(item.package, item.then)) ? 'accepted' : 'not_accepted' };
  if (item.code === 'judge_check') return { decision: judgeGating.includes(judgeKey(item.package, item.then)) ? 'gating' : 'diagnostic' };
  if (item.code === 'plan_changed_since_confirmation') return { decision: { agent: plan.agent ?? null, model: plan.model ?? null } };
  if (item.code === 'baseline_plan_recorded') return { decision: { attempts: plan.attempts ?? null, agent: plan.agent ?? null, model: plan.model ?? null } };
  return { decision: 'confirmed_as_shown' };
}

// Records the user's confirmation of the checks of this Spec export, with the
// reviewer's verdict on each line and the run plan, in confirmed.json. A
// baseline runs that plan, and a loop compares with these checks. The entry
// keeps what the user was shown and decided: the must_decide items of the
// review at that moment, each with its decision (decisionOf); the run plan
// with its budget and cost cap; whether these words also start a loop
// (--start-loop) and stop it once it is stuck (--stop-on-stuck); the lines
// whose judge check became gating (--judge-gating); and the digest of the
// review's must_show (shown).
export function confirmEval(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who confirmed the checks and where they said so. Confirming the checks is the user\'s decision.');
  if (!nonempty(options.verdicts)) throw new Error('--verdicts names the reviewer\'s answers, written from the review_template of `eval review`, usually review.json.');
  if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1)) throw new Error('--attempts is a whole number of 1 or more.');
  if (options.iterations !== undefined && (!Number.isInteger(options.iterations) || options.iterations < 1)) throw new Error('--max-iterations is a whole number of 1 or more.');
  if (options.minutes !== undefined && !(options.minutes > 0)) throw new Error('--max-minutes is a number above 0.');
  if (options.maxCost !== undefined && !(options.maxCost > 0)) throw new Error('--max-cost is an amount in US dollars above 0.');
  if (options.tier !== undefined && !TIERS.includes(options.tier)) throw new Error('--tier is light or full.');
  for (const [key, flag] of [['startLoop', '--start-loop'], ['stopOnStuck', '--stop-on-stuck']]) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${flag} takes no value.`);
  }
  const judgeGiven = (options.judgeGating === undefined ? [] : [options.judgeGating].flat()).map((entry) => String(entry));
  for (const entry of judgeGiven) {
    const at = entry.indexOf(':');
    if (at <= 0 || !entry.slice(at + 1).trim()) throw new Error('--judge-gating names a line as CASE:THEN: the package and the THEN or AND line its judge check verifies.');
  }
  const judgeGating = [...new Set(judgeGiven.map((entry) => judgeKey(entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1))))].sort();
  // Lines whose weaker or stronger checks the user accepts, as CASE:THEN, with
  // one reason for all of them or one for each, in the same order.
  const acceptGiven = (options.acceptVerdict === undefined ? [] : [options.acceptVerdict].flat()).map((entry) => String(entry));
  const reasonsGiven = (options.acceptReason === undefined ? [] : [options.acceptReason].flat()).map((entry) => String(entry).trim());
  for (const entry of acceptGiven) {
    const at = entry.indexOf(':');
    if (at <= 0 || !entry.slice(at + 1).trim()) throw new Error('--accept-verdict names a line as CASE:THEN: the package and the THEN or AND line whose weaker or stronger checks the user accepts.');
  }
  if (acceptGiven.length && (!reasonsGiven.length || reasonsGiven.some((reason) => !reason))) throw new Error('--accept-verdict needs --accept-reason: in the user\'s words, why the check is good enough as it is.');
  if (!acceptGiven.length && reasonsGiven.length) throw new Error('--accept-reason goes with --accept-verdict.');
  if (reasonsGiven.length > 1 && reasonsGiven.length !== acceptGiven.length) throw new Error('Give one --accept-reason for all the lines of --accept-verdict, or one for each, in the same order.');
  const accepted = new Map(acceptGiven.map((entry, index) => {
    const at = entry.indexOf(':');
    return [lineKey(entry.slice(0, at), entry.slice(at + 1)), { package: entry.slice(0, at), then: entry.slice(at + 1).trim(), reason: reasonsGiven.length === 1 ? reasonsGiven[0] : reasonsGiven[index] }];
  }));
  const state = reviewState(repo, name);
  const { evals, spec, snapshot, latest } = state;
  const gaps = evalGaps(state);
  // A file this release cannot read, or one a newer release wrote, is never overwritten.
  if (['confirmation_unreadable', 'confirmation_newer'].includes(state.read.gap?.code)) gaps.push(clean(state.read.gap));
  const unbound = unboundGap(evals);
  if (unbound) gaps.push(unbound);
  // Shared verifier code that differs from the kit's, and packages written
  // against a Spec draft, are not confirmed: validateEval's gaps above hold
  // them, and these add only what it did not report.
  gaps.push(...sharedGaps(state));
  const drafts = draftGap(state);
  if (drafts) gaps.push(drafts);
  // A line made gating needs a judge check bound to it.
  const judges = new Set(kindChecks(state, JUDGE_KIND).map((entry) => judgeKey(entry.package, entry.then)));
  const unknownJudges = judgeGating.filter((entry) => !judges.has(entry));
  if (unknownJudges.length) {
    gaps.push({ ...gap('judge_gating_unknown', `--judge-gating names ${unknownJudges.join(', ')}, and no judge check of that package verifies that line.`, 'agent', 'artifact', 'package'), entries: unknownJudges });
  }
  // A judged line made gating by these flags is held like any gating line.
  const held = (row) => judgeHeld(row, judgeGating);
  // The reviewer's answers. eval review reads review.json; another file may
  // hold answers the user was never shown with the review.
  const file = path.resolve(repo, options.verdicts);
  const shownFile = path.relative(repo, file).split(path.sep).join('/') || file;
  const reviewPath = reviewFile(repo, name);
  const sameFile = (a, b) => {
    if (path.resolve(a) === path.resolve(b)) return true;
    try { return realpathSync(a) === realpathSync(b); } catch { return false; }
  };
  const fromReview = sameFile(file, reviewPath);
  let answers = null;
  let why = null;
  try { answers = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { why = error.code === 'ENOENT' ? 'there is no such file' : error.message; }
  why ??= unreadableReview(answers);
  if (why) {
    gaps.push(gap('review_unreadable', `${shownFile} cannot be read as a review: ${why}. It is written from \`eval review\`'s review_template.`));
  } else {
    const wanted = new Map(state.lines.map((row) => [lineKey(row.case, row.then), row]));
    const given = new Map();
    const stale = [];
    if (answers.spec !== spec) stale.push(`it answers for another Spec export (${answers.spec.slice(7, 19)})`);
    for (const line of answers.lines) {
      const key = lineKey(line.package, line.then);
      const row = wanted.get(key);
      if (!row) stale.push(`"${line.then}" (${line.package}) is no line of these packages`);
      else if (given.has(key)) stale.push(`"${line.then}" (${line.package}) is answered twice`);
      else if (!answersPackage(line, state, row.case)) stale.push(`"${line.then}" (${line.package}) was answered for another version of the package`);
      given.set(key, line);
    }
    for (const [key, row] of wanted) if (!given.has(key)) stale.push(`"${row.then}" (${row.case}) has no answer`);
    for (const entry of revisedPackages(state)) {
      const answer = (answers.packages ?? []).find((item) => item.package === entry.id);
      if (!answer) stale.push(`${entry.id} changed since the checks were confirmed, and no answer says whether its diff loosens a THEN line`);
      else if (!answersPackage(answer, state, entry.id)) stale.push(`the answer for the diff of ${entry.id} was written for another version of the package`);
    }
    if (stale.length) {
      gaps.push(gap('review_stale', `${shownFile} was written for other packages: ${stale.join('; ')}. Any edit to what a package runs changes its run_digest; a fixture added or changed, such as a counterexample, does not. The review_template of \`eval review\` answers for the packages as they are now.`));
    } else {
      // A weaker or stronger line the user accepted stands; any other line
      // --accept-verdict names is refused, with why.
      const acceptedHere = (row) => accepted.has(lineKey(row.case, row.then)) && ACCEPTABLE.includes(given.get(lineKey(row.case, row.then)).verdict);
      const misnamed = [...accepted.entries()].flatMap(([key, entry]) => {
        const row = wanted.get(key);
        if (!row || !(row.status === 'gating' || held(row))) return [`${entry.package} "${entry.then}" is not a line a gating check verifies`];
        const verdict = given.get(key)?.verdict;
        if (verdict === 'faithful') return [`${entry.package} "${entry.then}" is faithful, so there is nothing to accept`];
        if (!ACCEPTABLE.includes(verdict)) return [`${entry.package} "${entry.then}" is ${verdict}: a check of something else, or of nothing, is never gating; fix it or move the line to scenario.manual`];
        return [];
      });
      if (misnamed.length) gaps.push({ ...gap('verdict_not_acceptable', `--accept-verdict takes a line whose checks the reviewer found weaker or stronger than it: ${misnamed.join('; ')}.`, 'agent', 'artifact', 'package'), entries: misnamed });
      const unfaithful = state.lines.filter((row) => (row.status === 'gating' || held(row)) && given.get(lineKey(row.case, row.then)).verdict !== 'faithful' && !acceptedHere(row));
      if (unfaithful.length) {
        gaps.push({ ...gap('line_not_faithful', `The reviewer judged these lines not faithful: ${unfaithful.map((row) => {
          const answer = given.get(lineKey(row.case, row.then));
          return `${row.case} "${row.then}"${held(row) ? ` (judged by ${judgeChecksOf(row).join(', ')}, made gating)` : ''}: ${answer.verdict}${nonempty(answer.note) ? ` (${answer.note.trim()})` : ''}`;
        }).join('; ')}. A line a program checks is confirmed only with a faithful verdict, a line whose judge check is made gating included, or with a weaker or stronger one the user accepts (--accept-verdict CASE:THEN with --accept-reason); a line no program can judge belongs in scenario.manual.`, 'agent', 'artifact', 'package'),
        cases: [...new Set(unfaithful.map((row) => row.case))] });
      }
      // A scenario.manual line whose judge check is made gating is no longer
      // the user's to judge: it takes faithful, above.
      const disputed = state.lines.filter((row) => row.status === 'manual' && !held(row) && given.get(lineKey(row.case, row.then)).verdict !== 'not_observable');
      if (disputed.length) {
        gaps.push({ ...gap('manual_disputed', `The reviewer thinks a program can judge these scenario.manual lines: ${disputed.map((row) => `${row.case} "${row.then}": ${given.get(lineKey(row.case, row.then)).verdict}`).join('; ')}. A scenario.manual line is confirmed only with the verdict not_observable.`, 'agent', 'artifact', 'package'),
          cases: [...new Set(disputed.map((row) => row.case))] });
      }
      const loosened = (answers.packages ?? []).filter((item) => item.loosens === true && revisedPackages(state).some((entry) => entry.id === item.package));
      if (loosened.length) {
        gaps.push({ ...gap('package_loosens', `The reviewer found that the diff of ${loosened.map((item) => `${item.package}${nonempty(item.note) ? ` (${item.note.trim()})` : ''}`).join(', ')} loosens a THEN line, so its checks no longer say what the lines say.`, 'agent', 'artifact', 'package'),
          cases: loosened.map((item) => item.package) });
      }
    }
  }
  // A second confirmation of the same export is a revision; its reason is
  // recorded when given.
  const revision = Boolean(latest);
  // The run plan: the flags, then the previous confirmation of this export,
  // then the kit (planSettings says when harness.json counts again). While a
  // loop runs, a confirmation of another plan, another tier or other packages
  // ends it.
  const previous = latest?.run_plan ?? null;
  const kit = planSettings(state);
  const tierNow = tierPlan(state, options.model ?? kit.model);
  const tier = options.tier ?? tierNow.proposed;
  const light = tier === 'light';
  if (light && !tierNow.eligible) {
    gaps.push({ ...gap('tier_light_unfit', `The light tier holds only for code whose result is fixed, and this change misses it: ${tierNow.reasons.map((entry) => entry.message).join(' ')} The full tier (--tier full, or no --tier) takes it.`),
      reasons: tierNow.reasons });
  }
  // In the light tier the plan is fixed: one attempt of each package, no
  // model, and the agent of harness.json, whose imports the tier was decided
  // by. --attempts changes nothing there.
  const flags = ['agent', 'model'].filter((key) => options[key] !== undefined);
  if (light && flags.length) {
    gaps.push({ ...gap('light_plan_fixed', `In the light tier each package runs once, with no model, and the agent comes from harness.json, which is the adapter whose imports the tier rests on: ${flags.map((key) => `--${key}`).join(', ')} cannot be given. The full tier (--tier full) takes another agent or model.`), flags });
  }
  const model = light ? null : options.model ?? kit.model;
  // The full tier the user asked for with --tier full stays for every later
  // confirmation of this export until they give another --tier. Such a
  // confirmation records it as kept, with the confirmation where they asked
  // for it (tier_from).
  const keptFull = !options.tier && fullTierByUser(previous);
  const tierChoice = options.tier ? { tier_by: 'flag' }
    : keptFull ? { tier_by: 'kept', tier_from: previous.tier_by === 'flag' ? latest.id : previous.tier_from ?? latest.id } : { tier_by: 'proposal' };
  let plan = { attempts: light ? null : options.attempts ?? previous?.attempts ?? null, pass_rule: 'all', agent: light ? state.kit.agent : options.agent ?? kit.agent,
    model, tier, ...tierChoice, budget: budgetFor(previous, tier, options) };
  const needs = planNeeds(evals.cases, state.ready, model);
  if (needs.needed && plan.attempts === null) gaps.push(attemptsUndecided(needs, model));
  // Rule V: a package that can reach outside networks declares a live dependency.
  const reachable = networkUndeclared(evals.cases);
  if (reachable.length) {
    gaps.push({ ...gap('network_undeclared', networkUndeclaredText(reachable), 'agent', 'artifact', 'package'), cases: reachable.map((item) => item.id) });
  }
  // In the light tier no author fixture shows that a check can fail, so every
  // line a program checks needs its own proof before the user confirms it. A
  // judged line made gating needs one in either tier: no package readiness
  // rule holds a judge check, so nothing else shows that it can fail.
  const proofNow = (row) => proofOf(state, row, judgeGating);
  const unproven = state.lines.filter((row) => ((light && row.status === 'gating') || held(row)) && !proofNow(row).sources.length);
  if (unproven.length) {
    const fresh = requireProject(repo).mode === 'new';
    const judged = unproven.filter(held);
    const intro = light
      ? `In the light tier every line a program checks needs a proof that its checks can fail before the user confirms them${judged.length ? ', a line whose judge check is made gating included' : ''}`
      : 'A line whose judge check the user makes gating (--judge-gating) needs a proof that the check can fail before the user confirms it, in either tier';
    gaps.push({ ...gap('line_unproven', `${intro}, and these lines have none: ${unproven.map((row) => `${row.case} "${row.then}"${held(row) ? ` (judged by ${judgeChecksOf(row).join(', ')})` : ''} (${(proofNow(row).missing ?? ['no proof could be read']).join('; ')})`).join('; ')}. A line this change fixes is proved by its checks failing, with evidence, in an attempt that completed at the baseline, which ran the package as it is and expected fail, as every baseline of this Spec export did, on code where no run saw them pass. Any other line needs a reviewer's counterexample that \`eval check\` proved (reviewer_brief.lines of \`eval review\`).${judged.length ? ' For a line whose judge check is made gating, that counterexample names the line in its then and expects fail for its judge check; a judge check left diagnostic needs no proof.' : ''}${fresh && light ? ' In a new project every line needs a counterexample, which can be proved only once its package is connected; the full tier takes the change before that.' : ''}`, 'agent', 'artifact', 'package'),
      cases: [...new Set(unproven.map((row) => row.case))] });
  }
  // A package with an adapter of its own runs with it; the plan records which.
  const adapters = ownAdapters(state);
  plan = { attempts: plan.attempts ?? null, pass_rule: 'all', agent: plan.agent ?? null, model: plan.model ?? null, tier, tier_by: plan.tier_by,
    ...(plan.tier_from ? { tier_from: plan.tier_from } : {}), budget: plan.budget,
    max_cost: typeof plan.budget.max_cost_usd === 'number' ? plan.budget.max_cost_usd : null,
    // Whether a loop on this plan stops once it is stuck (--stop-on-stuck).
    stop_on_stuck: options.stopOnStuck === true,
    ...(adapters.length ? { adapters: Object.fromEntries(adapters.map((entry) => [entry.package, { agent: entry.agent, file: entry.file }])) } : {}) };
  if (gaps.length) throw refused(`The checks cannot be confirmed: ${gaps.map((entry) => entry.message).join(' ')}`, repo, name, gaps);

  const warnings = [];
  if (light && options.attempts !== undefined) warnings.push(`In the light tier every package runs once, so --attempts ${options.attempts} changes nothing and is not recorded.`);
  // A number of attempts takes effect only for a package that declares a
  // live dependency.
  if (!light && options.attempts !== undefined && !needs.live.length) {
    warnings.push(`No package declares a live dependency, so every package runs once: --attempts ${options.attempts} takes effect only for a package that declares one later.`);
  }
  if (needs.live.length && typeof plan.budget.max_cost_usd !== 'number') {
    warnings.push(`${needs.live.join(', ')} ${needs.live.length === 1 ? 'declares' : 'declare'} a live dependency, and this confirmation sets no cost cap (\`--max-cost USD\`). A cap counts the cost the adapter reports, and an adapter that reports none leaves it unenforced.`);
  }
  // The answers of another file than the review.json eval review reads may
  // not be the ones the user saw with the review: shown is the digest of the
  // review with these answers.
  const reviewShown = path.relative(repo, reviewPath).split(path.sep).join('/');
  if (!fromReview) {
    warnings.push(`--verdicts names ${shownFile}, not ${reviewShown}, which \`eval review\` reads: what the user saw with the review may not carry these answers, and shown is the digest of the review with them. confirmed.json records that as shown_source.`);
  }
  const ready = new Set(state.ready.map((item) => item.id));
  const given = new Map(answers.lines.map((line) => [lineKey(line.package, line.then), line]));
  const lines = state.lines.map((row) => {
    const answer = given.get(lineKey(row.case, row.then));
    const judgedGating = held(row);
    return { package: row.case, requirement: row.requirement, scenario: row.scenario, then: row.then, status: row.status,
      checks: judgedGating ? judgeChecksOf(row) : row.gating.map((entry) => entry.check), expect: row.gating.map((entry) => entry.expect), counterexamples: row.counterexamples ?? [],
      // A line of scenario.manual whose judge check the user made gating.
      ...(judgedGating ? { judge_gating: true } : {}),
      // What proves that the line's checks can fail, as the user saw it.
      ...(row.status === 'gating' || judgedGating ? { proof: (({ missing, ...proof }) => proof)(proofOf(state, row, judgeGating)) } : {}),
      verdict: answer.verdict, note: nonempty(answer.note) ? answer.note.trim() : null, ...(row.reason ? { reason: row.reason } : {}),
      ...(accepted.has(lineKey(row.case, row.then)) ? { accepted_by_user: { reason: accepted.get(lineKey(row.case, row.then)).reason } } : {}) };
  });
  // The weaker or stronger lines the user accepted, as the acceptance shows them.
  const acceptedVerdicts = lines.filter((line) => line.accepted_by_user).map((line) => ({ package: line.package, then: line.then, verdict: line.verdict, note: line.note,
    reason: line.accepted_by_user.reason }));
  // What the review showed at this moment, as eval review gives it with these
  // answers, and the decisions the flags gave on it.
  const shownLines = reviewLines(state, answers);
  const mustDecide = mustDecideOf(state, shownLines);
  const mustShow = mustShowOf(state, shownLines, mustDecide, runPlan(repo, name, state));
  const now = new Date().toISOString();
  const content = {
    schema_version: '1.1', change: name,
    spec: { id: name, sha256: spec },
    // task_digest covers every file of a package; run_digest leaves the
    // fixtures out, and decides whether the packages are the ones confirmed.
    // check_digest is what the package checks, which the reviewer's verdicts
    // rest on: a later review keeps them while it is unchanged.
    packages: Object.fromEntries(Object.keys(snapshot.task_digest).sort().map((id) => [id, { task_digest: snapshot.task_digest[id], run_digest: snapshot.run_digest?.[id] ?? null,
      check_digest: snapshot.check_digest?.[id] ?? null, files: snapshot.packages[id] ?? {}, ready: ready.has(id) }])),
    kit: { files: snapshot.kit },
    lines,
    review: { origin: answers.review.origin, note: nonempty(answers.review.note) ? answers.review.note.trim() : null },
    package_reviews: (answers.packages ?? []).map((item) => ({ package: item.package, ...(nonempty(item.run_digest) ? { run_digest: item.run_digest } : { task_digest: item.task_digest }),
      loosens: item.loosens, note: nonempty(item.note) ? item.note.trim() : null })),
    // What the user saw as the expected baseline result of each check.
    baseline_expectations: state.expectations.map(({ case: id, check, expected, reason }) => ({ case: id, check, expected, reason })),
    run_plan: plan,
    // What the tier rests on: whether the change qualified for the light
    // tier, the conditions it missed, and the hints the user saw.
    tier_basis: { eligible: tierNow.eligible, reasons: tierNow.reasons, signals: state.signals },
    // The decisions that were the user's at this moment, and what the flags
    // decided of them.
    must_decide: mustDecide.map((item) => ({ ...item, ...decisionOf(item, plan, judgeGating, accepted) })),
    // Whether the user's words also start a loop on these checks, and stop it
    // once it is stuck.
    start_loop: options.startLoop === true,
    stop_on_stuck: options.stopOnStuck === true,
    // The lines whose judge check the user made gating, as `case:then`.
    judge_gating: judgeGating,
    // The lines whose weaker or stronger checks the user accepted, with the
    // reviewer's note and the user's reason.
    accepted_verdicts: acceptedVerdicts,
    // The digest of what eval review showed (must_show) at this moment, with
    // the answers of the verdicts file.
    shown: digest(JSON.stringify(mustShow)),
    // Where those answers came from: review_file says whether it is the
    // review.json eval review reads, so the digest is of what the user saw.
    shown_source: { verdicts: shownFile, review_file: fromReview },
    confirmed: { by: options.by.trim(), ref: options.ref.trim(), at: now, kind: revision ? 'revision' : 'initial', ...(nonempty(options.reason) ? { reason: options.reason.trim() } : {}) },
  };
  const { schema_version: version, change, ...rest } = content;
  const entry = { schema_version: version, change, id: confirmationId(content), ...rest };
  // A file whose ids no longer match its content keeps no history: Git has it.
  const history = state.read.gap ? [] : state.read.record ? [...(Array.isArray(state.read.record.earlier) ? state.read.record.earlier : []),
    Object.fromEntries(Object.entries(state.read.record).filter(([key]) => key !== 'earlier'))] : [];
  if (state.read.gap) warnings.push(`${path.relative(repo, confirmationFile(repo, name))} was edited by hand, so its earlier confirmations are not kept in the new file; Git still holds them.`);
  const target = confirmationFile(repo, name);
  writeFileSync(target, `${JSON.stringify({ ...entry, ...(history.length ? { earlier: history } : {}) }, null, 2)}\n`);
  // Before the packages are connected, no package declares a live dependency.
  if (dependenciesUnknown(repo, state) && plan.attempts === null) warnings.push(`This confirmation fixes no number of attempts. ${attemptsLater}`);
  const selfReview = lines.filter((line) => line.counterexamples.length && line.counterexamples.every((item) => item.origin === 'self-review'));
  if (selfReview.length) warnings.push(`Only a self-review counterexample stands behind ${selfReview.map((line) => `"${line.then}" (${line.package})`).join(', ')}: the author wrote it without a second reader.`);
  if (answers.review.origin === 'self-review') warnings.push('The verdicts of this confirmation are a self-review: the author judged the lines without a second reader.');
  if (acceptedVerdicts.length) {
    warnings.push(`The user accepted checks that ask less or more than their lines: ${acceptedVerdicts.map((line) => `"${line.then}" (${line.package}) ${line.verdict}`).join('; ')}. A pass of a weaker check does not show the whole line holds; the acceptance says so for each line.`);
  }
  // A package that only waits for `eval check` changed since its last one: a
  // run skips it until it is proved again. The others wait to be connected.
  const waiting = evals.cases.filter((item) => !ready.has(item.id));
  const unchecked = waiting.filter((item) => item.integration?.missing?.length && item.integration.missing.every((entry) => entry === 'check')).map((item) => item.id);
  const unconnected = waiting.map((item) => item.id).filter((id) => !unchecked.includes(id));
  if (unchecked.length) {
    warnings.push(`${unchecked.join(', ')} changed since ${unchecked.length === 1 ? 'its' : 'their'} last \`eval check\`: a run skips a package whose verifier is not proved for it as it is.`);
  }
  if (unconnected.length) warnings.push(`${unconnected.join(', ')} ${unconnected.length === 1 ? 'is' : 'are'} not ready yet. Connecting ${unconnected.length === 1 ? 'it changes it' : 'them changes them'}, so this confirmation no longer covers ${unconnected.length === 1 ? 'it' : 'them'} then, and inside a loop that ends it.`);
  // In a loop whose live packages run more than once, the first full run is a
  // screen run, so a budget of one full run never reaches the final run.
  if ((plan.attempts ?? 1) > 1 && evals.cases.some((item) => item.live) && plan.budget.iterations < 2) {
    warnings.push(`A budget of ${plan.budget.iterations} full run leaves no room for a final run: a package with a live dependency runs ${plan.attempts} times, so each iteration's full run is a screen run, and only a passing final run after it can be accepted.`);
  }
  if (state.expectationsError) warnings.push(`.genesis/edd/${name}/baseline-expectations.json cannot be read (${state.expectationsError}), so the confirmation records no expected baseline results.`);
  const result = { file: target, confirmation: entry, warnings, must_decide: entry.must_decide, start_loop: entry.start_loop, stop_on_stuck: entry.stop_on_stuck,
    shown_source: entry.shown_source, accepted_verdicts: entry.accepted_verdicts };
  // Inside a loop, a confirmation of its own plan and packages, such as a new
  // budget, leaves it as it is; another one ends it (confirmation_changed).
  let status = null;
  if (state.loop) {
    try { status = loopStatus(repo, name); } catch { /* loop status says why */ }
  }
  let phase = null;
  try { phase = status ? loopPhase(status) : null; } catch { phase = null; }
  if (phase && phase !== 'ended') {
    return { ...result, loop: { started_at: state.loop.started_at, phase, ended: false },
      suggestion: { command: ['loop', 'status', name, '--repo', repo], why: 'the loop goes on with these checks' } };
  }
  // A baseline recorded before the confirmation is the one the loop starts on
  // while it ran these packages, as they are, with the plan the user
  // confirmed, on the code as it is now, and behaved as declared; one that
  // records that nothing could run, while it keeps that plan and those
  // packages on that code. Until a loop of this change is accepted, that code
  // is the start code of the change's first unaccepted loop, whatever the code
  // is now.
  const recorded = recordedBaseline(repo, name, spec);
  const pin = pinnedStart(repo, name);
  const codeNow = codeSnapshot(repo).snapshot;
  const where = pin ? pin.start : codeNow;
  const packagesKept = recorded && (recorded.is_baseline ? !recorded.baseline_mismatch?.length && !baselinePackagesDiffer(recorded, evals.cases)
    : !packagesBetween(recorded, snapshot).length);
  const kept = Boolean(recorded && !baselinePlanDiffers(evals, recorded, entry) && packagesKept && sameCode(recorded.code_snapshot, where, repo) === true);
  // A baseline that records that nothing could run is recorded again the same
  // way. A new project connects its packages before its first baseline.
  const unavailable = recorded && !recorded.is_baseline ? recorded.baseline_unavailable_reason ?? 'no_implementation' : null;
  const atStart = Boolean(pin) && sameCode(codeNow, pin.start, repo) !== true && !unavailable;
  const connectFirst = !recorded && !state.ready.length && requireProject(repo).mode === 'new';
  return { ...result,
    loop: status ? { started_at: state.loop.started_at, phase, ended: true, reason: status.ended?.reason ?? null } : null,
    // The baseline a loop on these checks would start on: the one recorded,
    // when it ran these packages with this plan on the start code; whether
    // the start code is pinned by an earlier loop of this change; and whether
    // it is in the working directory now.
    baseline: { recorded: recorded?.run_id ?? null, kept, ...(unavailable ? { unavailable } : {}), on: pin ? 'start_code' : 'working_directory',
      ...(pin ? { start_code: restoreHint(name, pin.loop, null), code_is_start: sameCode(codeNow, pin.start, repo) === true } : {}), at_start: atStart },
    unchecked, unconnected, ...(connectFirst ? { connect_first: true } : {}),
    // What a new loop on these checks still needs: a baseline that keeps them,
    // and the user's consent, which --start-loop recorded with these words.
    new_loop_needs: { baseline: !kept, user_consent: !entry.start_loop },
    suggestion: kept ? { command: ['loop', 'start', name, '--repo', repo], why: 'the recorded baseline keeps these checks and this plan' }
      : connectFirst ? null
        : { command: ['run', 'start', name, '--baseline', ...(atStart ? ['--at-start'] : []), ...(unavailable ? ['--unavailable', unavailable] : []), '--repo', repo],
          why: 'records a baseline of this plan, which a loop on these checks starts from' } };
}
