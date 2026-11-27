import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJSON, requireProject } from './project.js';
import {
  confirmationFile, confirmationId, confirmationMatch, eddDirectory, evalSnapshot, kitSettings, latestConfirmation, matchFiles, readConfirmation,
  requireSpec, reviewFile, thenKey, validateEval,
} from './eval.js';
import {
  activeLoop, attemptsUndecided, codeSnapshot, estimateRuns, pinnedStart, planNeeds, planOf, readRuns, recordedBaseline, restoreHint, sameCode, sameCodeResults,
} from './run.js';
import { baselinePackagesDiffer, baselinePlanDiffers, loopPhase, loopStatus } from './loop.js';

// What a reviewer says of one line: the checks say what it says, say less,
// say more, say something else, can never fail, or no program can tell.
const VERDICTS = ['faithful', 'weaker', 'stronger', 'different', 'vacuous', 'not_observable'];
const ORIGINS = ['review', 'self-review'];
const DEFAULT_BUDGET = { iterations: 5, minutes: 60 };
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const gap = (code, message, owner = 'agent', kind = 'artifact', route = 'run-eval') => ({ code, kind, owner, route, message });
// Whether the loop of loop.json has ended or stopped, for a message.
const loopEnded = (repo, name) => {
  try { return loopPhase(loopStatus(repo, name)) === 'ended'; } catch { return false; }
};
const lineKey = (id, then) => `${id}\n${thenKey(then)}`;
// Files named in a message: the first ten, then how many more.
const named = (files) => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));
// Kept to four significant digits, as the strength of an acceptance is.
const fourDigits = (value) => Number(value.toPrecision(4));

function refused(message, repo, name, gaps) {
  return Object.assign(new Error(message), {
    code: 'CONFIRM_INPUT_BLOCKED', gaps,
    resume: { stage: 'run-eval', change: name, command: ['workflow', 'check', 'run-eval', name, '--repo', repo] },
  });
}

// Everything eval review and eval confirm read, read once. Read-only.
function reviewState(repo, name) {
  const handoff = requireSpec(repo, name, 'run-eval');
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
  const runs = readRuns(runsDirectory);
  const base = loop ? runs.find((run) => run.run_id === loop.baseline && run.side === 'base') ?? null : recordedBaseline(repo, name, spec);
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
  return { repo, evals, spec, root, snapshot, read, entries, latest, match, answers, expectations, expectationsError, loop, runsDirectory, runs, base, kit, ready,
    declared, lines, pool: sameCodeResults(repo, runsDirectory, spec, runs) };
}

// The settings of keys in a message, such as "5 attempts, model none".
const settingsText = (plan, keys) => keys.map((key) => (key === 'attempts' ? `${plan.attempts ?? 'no fixed number of'} attempts` : `${key} ${plan[key] ?? 'none'}`)).join(', ');

// The plan eval confirm records when no flag gives one: the number of
// attempts last confirmed for this Spec export, and the agent and the model
// planSettings gives.
function flaglessPlan(state) {
  const { agent, model } = planSettings(state);
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
    text: `The baseline ${base.run_id} ${base.is_baseline ? 'ran' : 'records that nothing could run, and a loop on it runs'} with ${settingsText(ran, keys)}, a plan of its own: without plan flags, \`eval confirm\` records ${settingsText(plan, keys)}. \`loop start\` takes that baseline only once the user confirms the plan it ran; otherwise record the baseline again after the confirmation, which reads the plan from it.` };
}

// The plan of a baseline recorded before the user confirmed the checks of
// this Spec export, as recordedDiffers gives it for eval confirm without plan
// flags, or null: workflow check names it with confirm_checks.
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

// The answer a line carries over from the latest confirmation of this Spec
// export: its verdict and note, while its package is as it was confirmed.
function carried(state, row) {
  const latest = state.latest;
  if (!latest || latest.packages?.[row.case]?.task_digest !== state.snapshot.task_digest[row.case]) return null;
  const line = (latest.lines ?? []).find((entry) => entry.package === row.case && thenKey(entry.then) === thenKey(row.then));
  return line ? { verdict: line.verdict ?? null, note: line.note ?? null } : null;
}

// The review.json eval confirm reads, as eval review proposes it.
function template(state) {
  const revised = revisedPackages(state);
  return {
    schema_version: '1.0', spec: state.spec,
    review: { origin: null, note: null },
    lines: state.lines.map((row) => {
      const before = carried(state, row);
      return { package: row.case, then: row.then, task_digest: state.snapshot.task_digest[row.case] ?? null, verdict: before?.verdict ?? null, note: before?.note ?? null };
    }),
    ...(revised.length ? { packages: revised.map((entry) => ({ package: entry.id, task_digest: state.snapshot.task_digest[entry.id] ?? null, loosens: null, note: null })) } : {}),
  };
}

// The result a baseline recorded for a check, or null.
function baselineResult(state, id, check) {
  const base = state.base;
  if (!base?.is_baseline || !(base.cases ?? []).some((item) => item.id === id) || base.task_digest?.[id] !== state.snapshot.task_digest[id]) return null;
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
    const now = state.snapshot.task_digest[failed.case];
    if (failed.result !== 'fail' || failed.task_digest === null || failed.task_digest === now) continue;
    const passed = state.pool.find((entry) => entry.result === 'pass' && entry.code === failed.code && entry.case === failed.case && entry.check === failed.check
      && entry.task_digest === now && entry.agent === failed.agent && entry.model === failed.model);
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
  return { ...gap('then_unbound', `${legacy.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0, whose checks name no THEN line, so the checks cannot be confirmed line by line. Upgrade ${one ? 'it' : 'them'} to 1.1 with write-eval, prove ${one ? 'it' : 'them'} with \`eval check\`, then review again.`, 'agent', 'artifact', 'write-eval'), cases: legacy };
}

// What to ask while no package declares its dependencies yet: how names how
// the user's N is recorded.
const attemptsLater = (how) => `No package declares its dependencies yet, since the loop connects them. If a scenario may call a model, ask the user for N now and ${how}: declaring a live dependency later changes the package, which ends a running loop and needs the user's number before a new one.`;

// What the CLI cannot see, and so no estimate counts.
const NOT_COUNTED = [
  'the reviewer\'s passes in eval review and in the final review, which run in your coding agent',
  'model calls, which fixtures do not make; the baseline shows their cost',
];

// The proposed run plan: which packages vary, the agent and the model, whether
// the user must fix a number of attempts, what 1, 3 and 5 attempts rule out,
// and how long the baseline, a screen run and the final run take with each,
// by the attempts of the last eval check. The estimate counts only ready
// packages; estimate_missing names the others.
function runPlan(repo, name, state) {
  const confirmed = state.latest?.run_plan ?? null;
  const { agent, model } = planSettings(state);
  const needs = planNeeds(state.evals.cases, state.ready, model);
  const estimates = [1, 3, 5].map((attempts) => ({ attempts, ...estimateRuns(repo, name, { plan: { attempts }, cases: state.evals.cases }) }));
  const missing = state.evals.cases.filter((item) => item.integration?.state !== 'ready').map((item) => item.id);
  return {
    live: needs.live, undeclared: needs.undeclared, agent, model, attempts_needed: needs.needed,
    proposal: { attempts: 5, tight: 3 },
    strength: [1, 3, 5].map((attempts) => ({ attempts, fails_half: fourDigits(0.5 ** attempts), fails_one_in_ten: fourDigits(0.9 ** attempts) })),
    // Fixtures make no model call, so the cost of one is left to the baseline.
    estimate: estimates.map((entry) => ({ attempts: entry.attempts, baseline_minutes: entry.full.minutes, screen_minutes: entry.screen.minutes,
      final_minutes: entry.final.minutes, cost_usd: null })),
    basis: estimates[0].basis, estimate_missing: missing, not_counted: NOT_COUNTED,
    budget: confirmed?.budget ?? DEFAULT_BUDGET,
    confirmed,
  };
}

// Lists every THEN line of the packages with what checks it, the decisions the
// user must make, the reviewer's questions and brief, a template for the
// reviewer's answers, and a proposed run plan. Read-only.
export function reviewEval(repo, name) {
  const state = reviewState(repo, name);
  const { evals, latest, match, snapshot } = state;
  const answers = isRecord(state.answers) && Array.isArray(state.answers.lines) ? state.answers : null;
  const lines = state.evals.then_lines.map((row) => {
    const declared = state.declared[row.case];
    const fixtures = { author: [], review: [], 'self-review': [] };
    for (const fixture of Array.isArray(declared?.fixtures) ? declared.fixtures : []) {
      if (!isRecord(fixture) || !nonempty(fixture.name)) continue;
      (fixtures[fixture.origin] ?? fixtures.author).push(fixture.name);
    }
    const answer = answers?.lines.find((entry) => isRecord(entry) && entry.package === row.case && nonempty(entry.then) && thenKey(entry.then) === thenKey(row.then)
      && entry.task_digest === snapshot.task_digest[row.case]);
    const before = carried(state, row);
    return {
      requirement: row.requirement, scenario: row.scenario, package: row.case, then: row.then, status: row.status,
      checks: [...row.gating.map((entry) => ({ id: entry.check, expect: entry.expect, role: 'gating' })),
        ...row.diagnostic.map((entry) => ({ id: entry.check, expect: entry.expect, role: 'diagnostic' }))],
      diagnostic: row.diagnostic.map((entry) => entry.check), fixtures, counterexamples: row.counterexamples ?? [],
      ...(row.reason ? { reason: row.reason } : {}),
      baseline: row.status === 'gating' ? row.gating.map((entry) => ({ check: entry.check, expected: expectedResult(state, row.case, entry.check),
        result: baselineResult(state, row.case, entry.check) })) : null,
      review: answer ? { verdict: answer.verdict ?? null, note: answer.note ?? null, carried: false }
        : before ? { ...before, carried: true } : null,
    };
  });
  const mustDecide = [];
  for (const row of evals.then_lines.filter((entry) => entry.status === 'uncovered')) {
    mustDecide.push({ code: 'then_uncovered', package: row.case, then: row.then,
      message: `No gating check verifies "${row.then}" (${row.case}). It needs a check in write-eval, or a place in scenario.manual for the user to judge, before the checks can be confirmed.` });
  }
  for (const row of evals.then_lines.filter((entry) => entry.status === 'manual')) {
    mustDecide.push({ code: 'manual_line', package: row.case, then: row.then,
      message: `No check verifies "${row.then}" (${row.case}): ${row.reason ?? 'no reason given'}. The user judges it at acceptance, from what the evaluated agent produced. They agree to that, or ask for a check.` });
  }
  for (const row of evals.then_lines.filter((entry) => entry.status === 'gating')) {
    for (const check of row.gating.filter((entry) => thenKey(entry.expect) !== thenKey(row.then))) {
      mustDecide.push({ code: 'expect_differs', package: row.case, then: row.then,
        message: `${row.case}/${check.check} expects "${check.expect}" for the line "${row.then}". The user reads whether it says the same, no less and no more.` });
    }
  }
  for (const row of evals.then_lines.filter((entry) => entry.status === 'gating' && entry.counterexamples?.length
    && entry.counterexamples.every((item) => item.origin === 'self-review'))) {
    mustDecide.push({ code: 'self_review_only', package: row.case, then: row.then,
      message: `Only a self-review counterexample stands behind "${row.then}" (${row.case}): the author wrote it without a second reader. The user decides whether that is enough.` });
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
      message: `harness.json changed since the user confirmed the checks: it names ${text('kit')} where they confirmed ${text('confirmed')}. run_plan shows what \`eval confirm\` records unless ${settings.changed.map((entry) => `--${entry.key}`).join(' or ')} says otherwise, and the baseline runs it. The user decides which one runs.` });
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
    mustDecide.push({ code: 'failed_with_old_package', package: item.case, check: item.check,
      message: `${item.case}/${item.check} failed with an earlier version of its package (${item.failed.join(', ')}) and passed with the package as it is now on the same code (${item.passed.join(', ')}). A changed package starts a new count, so the user decides whether the change fixed the check or hid a failure.` });
  }
  const proposed = template(state);
  const open = (row) => proposed.lines.find((entry) => entry.package === row.case && thenKey(entry.then) === thenKey(row.then))?.verdict === null;
  const questions = [
    ...state.lines.filter(open).map((row) => (row.status === 'gating'
      ? { package: row.case, then: row.then, ask: `${row.gating.length === 1 ? 'Does' : 'Do'} ${row.gating.map((entry) => entry.check).join(', ')} of ${row.case} say what "${row.then}" says, no weaker and no stronger? Answer faithful, weaker, stronger, different, vacuous or not_observable, with a note.` }
      : { package: row.case, then: row.then, ask: `No check verifies "${row.then}" of ${row.case}: ${row.reason ?? 'no reason given'}. Answer not_observable when no program can judge it; otherwise say how one could, with the verdict a check would get.` })),
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
  // Counterexamples still to write change their packages' task_digest, so the
  // answers go into the template of a review taken after them.
  const unwritten = evals.cases.some((item) => item.integration?.missing?.includes('review'));
  // In a new project no package runs before the loop connects it, so no
  // counterexample can be proved yet: the reviewer judges the checks now, and
  // writes and proves the counterexamples once the packages are connected.
  // Once one is connected, missing only its counterexamples or its `eval
  // check`, the review goes as in an existing project.
  const connected = evals.cases.some((item) => (item.integration?.missing ?? []).length
    && item.integration.missing.every((entry) => entry === 'review' || entry === 'check'));
  const later = !state.ready.length && !connected && requireProject(repo).mode === 'new';
  const COUNTEREXAMPLE = 'a fixture with origin review and a note, whose script leaves a result that breaks only that line. It expects fail for the checks bound to that line and pass or unknown for every other gating check of the package';
  const brief = {
    first: later
      ? `No package can run yet: in a new project the packages are connected inside the loop. Judge now, for every line, whether the expect of each check bound to it says what the line says, no weaker and no stronger, from tests/checks.json. Once the loop connects a package, write for every line a program checks a counterexample without reading tests/test.sh, tests/shared/ or the kit's verifier/: ${COUNTEREXAMPLE}. Run \`eval check\`; the package changes, so the user confirms it then as a revision.`
      : `Without reading tests/test.sh, tests/shared/ or the kit's verifier/, write for every line a program checks a counterexample: ${COUNTEREXAMPLE}. Run \`eval check\`. A counterexample that does not get fail shows a fault in the verifier: fix the verifier, never the counterexample.`,
    then: later
      ? 'Then answer each question into review.json, from the review_template: a verdict and a note for every line, and for every changed package whether its diff loosens a THEN line. Set review.origin to review, or to self-review when the author reviews alone.'
      : `Then ${unwritten ? 'run `eval review` again: the counterexamples change each package\'s task_digest, so the answers go into the review_template of that new review. Read' : 'read'} the verifier and answer each question into review.json, from ${unwritten ? 'that' : 'the'} review_template: a verdict and a note for every line, and for every changed package whether its diff loosens a THEN line. Set review.origin to review, or to self-review when the author reviews alone.`,
    give: [...new Set([relative(path.join(repo, 'openspec/changes', name, 'specs')), ...ids.map((id) => `${relative(path.join(state.root, 'evals', id))}/tests/checks.json`),
      ...ids.flatMap((id) => packageFiles(id).filter((file) => file.includes('/environment/'))),
      '.genesis/edd/harness/PROJECT.md', ...kitFiles('environment'), ...passFixtures])],
    withhold: [...ids.flatMap((id) => [`${relative(path.join(state.root, 'evals', id))}/tests/test.sh`, `${relative(path.join(state.root, 'evals', id))}/tests/shared/`]),
      '.genesis/edd/harness/verifier/'],
  };
  const warnings = [...evals.warnings, ...(state.read.gap ? [state.read.gap.message] : []),
    ...(state.expectationsError ? [`.genesis/edd/${name}/baseline-expectations.json cannot be read (${state.expectationsError}); the expected baseline results are not shown.`] : [])];
  const unbound = unboundGap(evals);
  const answer = later
    ? 'Give the reviewer reviewer_brief and nothing else. No package can run yet in this new project, so they judge each check against its line now, from checks.json, and answer into review.json from review_template. They write the counterexamples and prove them with `eval check` once the loop connects the packages; the user confirms them then as a revision.'
    : unwritten
      ? 'Give the reviewer reviewer_brief and nothing else. First they write the counterexamples, without tests/test.sh, and prove them with `eval check`. Then run `eval review` again, since the counterexamples change each package\'s task_digest, and they answer its questions, with the verifier, into review.json from the review_template of that new review.'
      : 'Give the reviewer reviewer_brief and nothing else, and have them answer its questions, with the verifier, into review.json from review_template.';
  const plan = runPlan(repo, name, state);
  // What the estimate rests on, and what it leaves out. In a new project no
  // package runs before the loop connects it, so nothing gives minutes yet.
  const left = plan.estimate_missing;
  const one = left.length === 1;
  const estimated = plan.basis === null && !state.ready.length && requireProject(repo).mode === 'new'
    ? ' The CLI has no estimate yet: in a new project the packages are connected inside the loop, and `loop status` gives loop.estimate once their `eval check` has run. Give the user your own estimate of a run, and say that the CLI has none yet.'
    : plan.basis === null ? ' run_plan.estimate has minutes once `eval check` has run the packages\' fixtures.'
      : `${left.length ? ` run_plan.estimate leaves out ${left.join(', ')}, which ${one ? 'is' : 'are'} not ready (run_plan.estimate_missing): finish ${one ? 'it' : 'them'}, prove ${one ? 'it' : 'them'} with \`eval check\`, and run \`eval review\` again before you show the user the cost.` : ''} The estimate counts Docker time from eval check; add the reviewer's passes and the model calls, which the CLI cannot see.`;
  // Before the packages are connected, none declares a live dependency yet.
  const askAttempts = dependenciesUnknown(repo, state) && (latest?.run_plan?.attempts ?? null) === null ? ` ${attemptsLater('pass --attempts N')}` : '';
  return {
    change: name, spec: state.spec,
    confirmation: latest ? { id: latest.id, at: latest.confirmed?.at ?? null, by: latest.confirmed?.by ?? null, kind: latest.confirmed?.kind ?? null } : null,
    current: Boolean(match?.matches),
    lines, must_decide: mustDecide, questions, reviewer_brief: brief, review_template: proposed, run_plan: plan,
    spec_diff: diff, gaps: [...evals.gaps.filter((entry) => entry.code !== 'integration_pending'), ...(unbound ? [unbound] : []), ...(state.read.gap ? [state.read.gap] : [])], warnings,
    next: `${answer} Show the user lines, must_decide and run_plan; after their own words, run \`eval confirm\` with --by and --ref${latest ? ', --reason, since this Spec export was confirmed before,' : ''} and the plan they agreed.${estimated}${askAttempts}${!state.loop ? ''
      : loopEnded(repo, name) ? ' The loop for this Spec export has ended: a new loop, once the user agrees, starts on the checks they confirm and on a baseline of that plan on the loop\'s start code.'
        : ' While a loop runs for this Spec export, a confirmation whose run plan or packages differ from the loop\'s ends it (confirmation_changed); a new loop then needs the user\'s go-ahead.'}`,
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
    if (!isRecord(line) || !nonempty(line.package) || !nonempty(line.then) || !nonempty(line.task_digest)) return `line ${index + 1} needs package, then and task_digest`;
    if (!VERDICTS.includes(line.verdict)) return `line ${index + 1} ("${line.then}") has no verdict: it must be one of ${VERDICTS.join(', ')}`;
  }
  if (answers.packages !== undefined) {
    if (!Array.isArray(answers.packages)) return 'packages must be a list';
    for (const [index, item] of answers.packages.entries()) {
      if (!isRecord(item) || !nonempty(item.package) || !nonempty(item.task_digest) || typeof item.loosens !== 'boolean') return `package answer ${index + 1} needs package, task_digest and loosens (true or false)`;
    }
  }
  return null;
}

// Records the user's confirmation of the checks of this Spec export, with the
// reviewer's verdict on each line and the run plan, in confirmed.json. A
// baseline runs that plan, and a loop compares with these checks.
export function confirmEval(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who confirmed the checks and where they said so. Confirming the checks is the user\'s decision.');
  if (!nonempty(options.verdicts)) throw new Error('--verdicts names the reviewer\'s answers, written from the review_template of `eval review`, usually review.json.');
  if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1)) throw new Error('--attempts is a whole number of 1 or more.');
  if (options.iterations !== undefined && (!Number.isInteger(options.iterations) || options.iterations < 1)) throw new Error('--max-iterations is a whole number of 1 or more.');
  if (options.minutes !== undefined && !(options.minutes > 0)) throw new Error('--max-minutes is a number above 0.');
  const state = reviewState(repo, name);
  const { evals, spec, snapshot, latest } = state;
  const gaps = [...evals.gaps.filter((entry) => entry.code !== 'integration_pending')];
  if (state.read.gap?.code === 'confirmation_unreadable') gaps.push(state.read.gap);
  const unbound = unboundGap(evals);
  if (unbound) gaps.push(unbound);
  // The reviewer's answers.
  const file = path.resolve(repo, options.verdicts);
  const shown = path.relative(repo, file).split(path.sep).join('/') || file;
  let answers = null;
  let why = null;
  try { answers = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { why = error.code === 'ENOENT' ? 'there is no such file' : error.message; }
  why ??= unreadableReview(answers);
  if (why) {
    gaps.push(gap('review_unreadable', `${shown} cannot be read as a review: ${why}. Write it from \`eval review\`'s review_template.`));
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
      else if (line.task_digest !== snapshot.task_digest[row.case]) stale.push(`"${line.then}" (${line.package}) was answered for another version of the package`);
      given.set(key, line);
    }
    for (const [key, row] of wanted) if (!given.has(key)) stale.push(`"${row.then}" (${row.case}) has no answer`);
    for (const entry of revisedPackages(state)) {
      const answer = (answers.packages ?? []).find((item) => item.package === entry.id);
      if (!answer) stale.push(`${entry.id} changed since the checks were confirmed, and no answer says whether its diff loosens a THEN line`);
      else if (answer.task_digest !== snapshot.task_digest[entry.id]) stale.push(`the answer for the diff of ${entry.id} was written for another version of the package`);
    }
    if (stale.length) {
      gaps.push(gap('review_stale', `${shown} was written for other packages: ${stale.join('; ')}. Any edit to a package, a new counterexample included, changes its task_digest. Run \`eval review\` again and write review.json from its review_template, with the reviewer's answers for the packages as they are now.`));
    } else {
      const unfaithful = state.lines.filter((row) => row.status === 'gating' && given.get(lineKey(row.case, row.then)).verdict !== 'faithful');
      if (unfaithful.length) {
        gaps.push({ ...gap('line_not_faithful', `The reviewer judged these lines not faithful: ${unfaithful.map((row) => {
          const answer = given.get(lineKey(row.case, row.then));
          return `${row.case} "${row.then}": ${answer.verdict}${nonempty(answer.note) ? ` (${answer.note.trim()})` : ''}`;
        }).join('; ')}. Fix the check in write-eval and prove it with \`eval check\`, or list the line in scenario.manual when no program can judge it; then review again.`, 'agent', 'artifact', 'write-eval'),
        cases: [...new Set(unfaithful.map((row) => row.case))] });
      }
      const disputed = state.lines.filter((row) => row.status === 'manual' && given.get(lineKey(row.case, row.then)).verdict !== 'not_observable');
      if (disputed.length) {
        gaps.push({ ...gap('manual_disputed', `The reviewer thinks a program can judge these scenario.manual lines: ${disputed.map((row) => `${row.case} "${row.then}": ${given.get(lineKey(row.case, row.then)).verdict}`).join('; ')}. Write a gating check for each in write-eval, or have the reviewer say not_observable; then review again.`, 'agent', 'artifact', 'write-eval'),
          cases: [...new Set(disputed.map((row) => row.case))] });
      }
      const loosened = (answers.packages ?? []).filter((item) => item.loosens === true && revisedPackages(state).some((entry) => entry.id === item.package));
      if (loosened.length) {
        gaps.push({ ...gap('package_loosens', `The reviewer found that the diff of ${loosened.map((item) => `${item.package}${nonempty(item.note) ? ` (${item.note.trim()})` : ''}`).join(', ')} loosens a THEN line. Fix the package in write-eval so its checks say what the lines say, prove it with \`eval check\`, then review again.`, 'agent', 'artifact', 'write-eval'),
          cases: loosened.map((item) => item.package) });
      }
    }
  }
  // A second confirmation of the same export is a revision, with its reason.
  const revision = Boolean(latest);
  if (revision && !nonempty(options.reason)) {
    gaps.push(gap('reason_missing', `This Spec export was confirmed before (${latest.confirmed?.at}, by ${latest.confirmed?.by}). A new confirmation is a revision: pass --reason with why the packages or the run plan changed.`, 'user', 'business'));
  }
  // The run plan: the flags, then the previous confirmation of this export,
  // then the kit (planSettings says when harness.json counts again). While a
  // loop runs, a confirmation of another plan or other packages ends it.
  const previous = latest?.run_plan ?? null;
  const kit = planSettings(state);
  const model = options.model ?? kit.model;
  let plan = { attempts: options.attempts ?? previous?.attempts ?? null, pass_rule: 'all', agent: options.agent ?? kit.agent,
    model, budget: { iterations: options.iterations ?? previous?.budget?.iterations ?? DEFAULT_BUDGET.iterations, minutes: options.minutes ?? previous?.budget?.minutes ?? DEFAULT_BUDGET.minutes } };
  const needs = planNeeds(evals.cases, state.ready, model);
  if (needs.needed && plan.attempts === null) gaps.push(attemptsUndecided(needs, model));
  plan = { attempts: plan.attempts ?? null, pass_rule: 'all', agent: plan.agent ?? null, model: plan.model ?? null, budget: plan.budget ?? DEFAULT_BUDGET };
  if (gaps.length) throw refused(`The checks cannot be confirmed: ${gaps.map((entry) => entry.message).join(' ')}`, repo, name, gaps);

  const warnings = [];
  const ready = new Set(state.ready.map((item) => item.id));
  const given = new Map(answers.lines.map((line) => [lineKey(line.package, line.then), line]));
  const lines = state.lines.map((row) => {
    const answer = given.get(lineKey(row.case, row.then));
    return { package: row.case, requirement: row.requirement, scenario: row.scenario, then: row.then, status: row.status,
      checks: row.gating.map((entry) => entry.check), expect: row.gating.map((entry) => entry.expect), counterexamples: row.counterexamples ?? [],
      verdict: answer.verdict, note: nonempty(answer.note) ? answer.note.trim() : null, ...(row.reason ? { reason: row.reason } : {}) };
  });
  const now = new Date().toISOString();
  const content = {
    schema_version: '1.0', change: name,
    spec: { id: name, sha256: spec },
    packages: Object.fromEntries(Object.keys(snapshot.task_digest).sort().map((id) => [id, { task_digest: snapshot.task_digest[id], files: snapshot.packages[id] ?? {}, ready: ready.has(id) }])),
    kit: { files: snapshot.kit },
    lines,
    review: { origin: answers.review.origin, note: nonempty(answers.review.note) ? answers.review.note.trim() : null },
    package_reviews: (answers.packages ?? []).map((item) => ({ package: item.package, task_digest: item.task_digest, loosens: item.loosens, note: nonempty(item.note) ? item.note.trim() : null })),
    // What the user saw as the expected baseline result of each check.
    baseline_expectations: state.expectations.map(({ case: id, check, expected, reason }) => ({ case: id, check, expected, reason })),
    run_plan: plan,
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
  if (dependenciesUnknown(repo, state) && plan.attempts === null) {
    warnings.push(`This confirmation fixes no number of attempts. ${attemptsLater('confirm again with --attempts N and --reason before the baseline')}`);
  }
  const selfReview = lines.filter((line) => line.counterexamples.length && line.counterexamples.every((item) => item.origin === 'self-review'));
  if (selfReview.length) warnings.push(`Only a self-review counterexample stands behind ${selfReview.map((line) => `"${line.then}" (${line.package})`).join(', ')}: the author wrote it without a second reader. Say so to the user.`);
  // A package that only waits for `eval check` changed since its last one: a
  // run skips it until it is proved again. The others wait to be connected.
  const waiting = evals.cases.filter((item) => !ready.has(item.id));
  const unchecked = waiting.filter((item) => item.integration?.missing?.length && item.integration.missing.every((entry) => entry === 'check')).map((item) => item.id);
  const unconnected = waiting.map((item) => item.id).filter((id) => !unchecked.includes(id));
  if (unchecked.length) {
    warnings.push(`${unchecked.join(', ')} changed since ${unchecked.length === 1 ? 'its' : 'their'} last \`eval check\`. Run it before the next run: a run skips a package whose verifier is not proved for it as it is.`);
  }
  if (unconnected.length) warnings.push(`${unconnected.join(', ')} ${unconnected.length === 1 ? 'is' : 'are'} not ready yet: ${unconnected.length === 1 ? 'its' : 'their'} counterexamples are proved once ${unconnected.length === 1 ? 'it is' : 'they are'} connected, and connecting ${unconnected.length === 1 ? 'it changes it' : 'them changes them'}: the user confirms ${unconnected.length === 1 ? 'it' : 'them'} again, and inside a loop that ends it.`);
  // In a loop whose live packages run more than once, the first full run is a
  // screen run, so a budget of one full run never reaches the final run.
  if ((plan.attempts ?? 1) > 1 && evals.cases.some((item) => item.live) && plan.budget.iterations < 2) {
    warnings.push(`A budget of ${plan.budget.iterations} full run leaves no room for a final run: a package with a live dependency runs ${plan.attempts} times, so each iteration's full run is a screen run, and only a passing final run after it can be accepted. A loop needs at least 2 full runs; tell the user.`);
  }
  if (state.expectationsError) warnings.push(`.genesis/edd/${name}/baseline-expectations.json cannot be read (${state.expectationsError}), so the confirmation records no expected baseline results.`);
  // Inside a loop, a confirmation of its own plan and packages, such as a new
  // budget, leaves it as it is; another one ends it (confirmation_changed).
  let status = null;
  if (state.loop) {
    try { status = loopStatus(repo, name); } catch { /* loop status says why */ }
  }
  const phase = status ? loopPhase(status) : null;
  if (phase && phase !== 'ended') {
    return { file: target, confirmation: entry, warnings, next: `The checks are confirmed. \`loop status\` says what comes next (now ${status.next.action}).` };
  }
  const endedText = status ? `The loop for this Spec has ended (${status.ended?.reason ?? status.next.action}). ` : '';
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
  const sameDigests = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((id) => a[id] === b[id]);
  const packagesKept = recorded && (recorded.is_baseline ? !recorded.baseline_mismatch?.length && !baselinePackagesDiffer(recorded, evals.cases)
    : sameDigests(recorded.task_digest, snapshot.task_digest));
  const kept = recorded && !baselinePlanDiffers(evals, recorded, entry) && packagesKept && sameCode(recorded.code_snapshot, where, repo) === true;
  // A new loop after one that ended needs the user's go-ahead.
  const agree = state.loop || pin ? ', once the user agrees' : '';
  // A package that waits only for `eval check` comes first: a baseline skips it.
  const prove = unchecked.length ? `Prove ${unchecked.join(', ')} with \`eval check\` first: a run skips a package whose verifier is not proved for it as it is. Then r` : 'R';
  // A baseline that records that nothing could run is recorded again the same
  // way, and one of a new project where nothing can run yet records that.
  const declared = recorded && !recorded.is_baseline ? ` --unavailable ${recorded.baseline_unavailable_reason ?? 'no_implementation'}`
    : !recorded && !state.ready.length && requireProject(repo).mode === 'new' ? ' --unavailable no_implementation' : '';
  const restore = !pin ? '' : ` Until a loop of this change is accepted, a new loop keeps the start code of the change's first unaccepted loop, ${restoreHint(name, pin.loop, null)}. ${sameCode(codeNow, pin.start, repo) === true
    ? `The code is that now: record the baseline here, then run \`loop start\`${agree}.`
    : `Set your changes aside, restore that code, record the baseline there, bring your changes back, then run \`loop start\`${agree}.`}`;
  return { file: target, confirmation: entry, warnings,
    next: `${endedText}${kept ? `The checks are confirmed. ${recorded.is_baseline ? `The baseline ${recorded.run_id} ran these packages with this plan on ${pin ? 'the start code of the change\'s first unaccepted loop' : 'this code'}` : `That no baseline could run is recorded already (${recorded.run_id}), with this plan`}: ${pin
      ? `bring back any changes you set aside and start the loop next with \`loop start\`${agree}, which keeps that start code and takes the budget the user confirmed.`
      : `start the loop next with \`loop start\`${agree}, which takes the budget the user confirmed.`}`
      : `The checks are confirmed. ${prove}ecord the baseline next: \`run start --baseline${declared}\` reads N, the agent and the model from confirmed.json.${restore}`}` };
}
