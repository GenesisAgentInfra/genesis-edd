import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { changeDirectory, readJSON, requireProject } from './project.js';
import { exportFacts, frozenSpec, validateSpec } from './spec.js';
import {
  checksConfirmation, eddDirectory, kitDirectory, kitSettings, legacyPackages, manualLines, unnamedMessage, unnamedPackages, unpackagedScenarios, validateEval,
} from './eval.js';
import { reviewEval } from './confirm.js';
import {
  acceptedHolding, changeLock, codeIdentity, codeSnapshot, isLost, isTrial, latestValidBaseline, ledgerState, ledgerText, liveCase, pinnedStart, planNeeds, readRuns,
  restoreHint, runTools, sameCode, sameCodeResults, undecidedLive, usableRun,
} from './run.js';
import { baselinePackagesDiffer, baselinePlanDiffers, loopInputs, loopStatus } from './loop.js';
import { readDecisions } from './records.js';

// The rules an action keeps or establishes, by name. Each command enforces
// its own; these names only say which one an action is about.
const RULES = {
  frozen_spec: 'later stages read one exported Spec, checked by digest',
  shared_code_matches_kit: 'every package runs the shipped helper and the kit\'s verifier code',
  checks_proved: 'every gating check comes out unknown when nothing is done, and can fail',
  expectations_before_results: 'expected baseline results are written before a baseline shows any',
  user_confirms_checks: 'only the user confirms the checks and the run plan',
  attempts_from_user: 'the number of attempts comes from the user\'s confirmation',
  network_sealed_or_live: 'a package that can reach outside networks declares a live dependency',
  baseline_on_start_code: 'a loop compares with a baseline on its start code, run with the confirmed plan',
  packages_fixed_in_loop: 'the confirmed packages and kit do not change while a loop runs',
  failures_count_on_same_code: 'a failure on the same code and packages always counts',
  final_run_when_results_vary: 'only a passing final run is accepted when results can vary',
  budget_stops_loop: 'a loop stops once its budget is used up',
  user_accepts: 'only the user accepts, declines or abandons',
  review_before_acceptance: 'an accepted run\'s code has a recorded final review',
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const codes = (gaps) => [...new Set((gaps ?? []).map((gap) => gap?.code).filter(Boolean))];
// A gap of another module without the pointers earlier releases attached.
const clean = (gap) => {
  if (!isRecord(gap)) return gap;
  const { route, resume, ...rest } = gap;
  return rest;
};
// A refusal another module threw, as gaps of the layer it came from.
const thrown = (error, layer) => (Array.isArray(error?.gaps) && error.gaps.length ? error.gaps.map(clean)
  : [{ code: error?.code ? String(error.code).toLowerCase() : 'unreadable', kind: 'technical', owner: 'agent', layer, message: error?.message ?? String(error) }]);
const nonEmpty = (entries) => Array.isArray(entries) ? entries.length > 0 : isRecord(entries) ? Object.keys(entries).length > 0 : Boolean(entries);

// What the project, the change and its records say now, layer by layer, and
// every action the CLI would take now: who takes it, the rules it is about,
// the consent it needs, whether it ends a running loop, and the gaps that
// make the CLI refuse it. Read-only: nothing is written, and no stage or
// order is assumed. Each command still checks its own gates when it runs;
// blocked_by lists the gaps visible from here.
export function workflowStatus(repo, name) {
  const directory = changeDirectory(repo, name);
  const cmd = (...words) => [...words.slice(0, 2), name, '--repo', repo, ...words.slice(2)];
  const actions = [];
  const action = (command, { by = 'agent', satisfies = [], needs = [], effect = null, blocked_by: blockedBy = [], ...facts } = {}) => {
    actions.push({ command, by, satisfies, needs, effect, blocked_by: [...new Set(blockedBy)], allowed: blockedBy.length === 0, ...facts });
  };

  // The project itself.
  let project = null;
  const machineGaps = [];
  try { project = requireProject(repo); } catch (error) {
    if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
    machineGaps.push({ code: 'project_uninitialized', kind: 'technical', owner: 'agent', layer: 'machine', message: error.message, path: 'openspec/' });
  }
  if (!project) {
    action(['init', '--repo', repo, '--mode', '<new|existing>'], { satisfies: [], needs: ['the project mode: new or existing'] });
    return { schema: 'genesis-edd.workflow-status/1', change: name,
      layers: { spec: null, packages: null, confirmation: null, baseline: null, loop: null, ledger: null, machine: { project: null, gaps: machineGaps } },
      gaps: machineGaps, must_show: {}, actions, suggestion: { command: actions[0].command, why: 'Genesis EDD is not initialized in this project.' } };
  }

  // Spec: the change folder, its current export by digest, and, when the
  // draft is not that export, the draft as `spec export` would read it.
  const folder = `openspec/changes/${name}/`;
  const exists = existsSync(directory);
  const hasOpenspec = exists && existsSync(path.join(directory, '.openspec.yaml'));
  const hasRecord = exists && existsSync(path.join(directory, 'genesis.json'));
  let context = null;
  if (hasRecord) {
    try { context = readJSON(path.join(directory, 'genesis.json')); } catch { /* spec validate names it */ }
  }
  const current = exists ? exportFacts(repo, name) : { id: null, file: null, source: null, at: null, drift: null, requirements: null, excluded: [], gaps: [], warnings: [] };
  const frozen = exists ? frozenSpec(repo, name) : { gaps: [], handoff: undefined };
  const handoff = frozen.handoff ?? null;
  const exportedBefore = exists && (existsSync(path.join(directory, 'exports.jsonl'))
    || (existsSync(path.join(directory, 'handoffs')) && readdirSync(path.join(directory, 'handoffs')).some((file) => file.endsWith('.json'))));
  let draft = null;
  const specGaps = [];
  if (!exists) {
    specGaps.push({ code: 'change_missing', kind: 'artifact', owner: 'agent', layer: 'spec', message: `${folder} does not exist.`, path: folder });
  } else if (!handoff) {
    specGaps.push(...frozen.gaps.map(clean));
    if (hasOpenspec && hasRecord) {
      try {
        const validation = validateSpec(repo, name);
        draft = { valid: validation.valid, ready_for_export: validation.ready_for_eval_design, errors: validation.errors ?? [], blockers: validation.blockers ?? [],
          excluded: validation.excluded ?? [], map_differs: validation.map_differs ?? [], gaps: (validation.gaps ?? []).map(clean), warnings: validation.warnings ?? [] };
        specGaps.push(...draft.gaps);
      } catch (error) {
        if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
        specGaps.push(...thrown(error, 'spec'));
      }
    }
  }
  const mapFacts = handoff?.handoff?.context?.map ?? context?.map ?? null;
  const spec = {
    change_folder: exists ? folder : null, openspec_change: hasOpenspec, genesis_record: hasRecord,
    adopted: Boolean(context?.adopted ?? handoff?.handoff?.context?.adopted),
    export: current.id ? { id: current.id, file: current.file ? path.relative(repo, current.file).split(path.sep).join('/') : null, source: current.source, at: current.at } : null,
    export_holds: Boolean(handoff), drift: current.drift ?? null,
    requirements: handoff ? handoff.handoff.requirements.map((requirement) => requirement.id) : null,
    excluded: handoff ? handoff.handoff.excluded ?? [] : draft?.excluded ?? [],
    map: isRecord(mapFacts) && mapFacts.status === 'available'
      ? { freshness: mapFacts.freshness ?? null, mode: mapFacts.mode ?? null, analysis_status: mapFacts.analysis_status ?? null, coverage_scope: mapFacts.coverage_scope ?? null }
      : null,
    draft, warnings: current.warnings ?? [], gaps: specGaps,
  };

  // The change's records and the project kit under .genesis/ are read only
  // inside the project. Through a symbolic link nothing there is read: that
  // is a gap, and the layers those records make stay empty.
  let records = null;
  try {
    records = eddDirectory(repo, name);
    kitDirectory(repo);
  } catch (error) {
    if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
    records = null;
    machineGaps.push({ code: 'records_unreadable', kind: 'technical', owner: 'user', layer: 'machine', path: '.genesis/',
      message: `${error?.message ?? String(error)}. The eval packages, the kit and the run, loop and confirmation records of this change are not read through it, so those layers are empty.` });
  }

  // Machine: Docker and Harbor, Git, and the project's mode.
  const tools = runTools();
  machineGaps.push(...tools.gaps.map(clean));
  const code = codeSnapshot(repo).snapshot;
  if (code.changed_files === null) machineGaps.push({ code: 'git_missing', kind: 'technical', owner: 'user', layer: 'machine', message: 'This project is not a Git repository, so no run can pin its code.' });
  const machine = { project: { mode: project.mode }, harbor: tools.harbor ?? null, docker: tools.docker, git: code.changed_files !== null, gaps: machineGaps };
  const toolCodes = codes(tools.gaps);

  // Loop: the latest loop of the change, whatever export it ran for.
  let status = null;
  const loopGaps = [];
  if (records) {
    try { status = loopStatus(repo, name); } catch (error) {
      if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
      // No loop has started: that is a fact, not a gap.
      const noLoop = Array.isArray(error?.gaps) && error.gaps.length > 0 && error.gaps.every((gap) => gap?.code === 'loop_missing');
      if (!noLoop) loopGaps.push(...thrown(error, 'loop'));
    }
  }
  const phase = status?.phase ?? null;
  const running = phase === 'live' || phase === 'closing';
  const ofExport = Boolean(status && handoff && status.loop?.spec === handoff.id);
  let lock = null;
  if (records) {
    try { lock = changeLock(repo, name, { spec: handoff?.id ?? null }); } catch { /* run start reports it */ }
  }
  if (lock) loopGaps.push(clean(lock));
  if (status?.gates?.head_run && running) loopGaps.push(clean(status.gates.head_run));
  const loop = status ? {
    phase, situation: status.situation ?? null, of_current_export: ofExport, started_at: status.loop?.started_at ?? null, spec: status.loop?.spec ?? null,
    baseline: status.loop?.baseline ?? null, start_code: status.loop?.start_code ?? null, worktree_moved: status.loop?.worktree_moved ?? null,
    moved_files: status.loop?.moved_files ?? [], pre_loop: status.loop?.pre_loop ?? null, consent: status.loop?.consent ?? null, tier: status.loop?.tier ?? null,
    run_plan: status.loop?.run_plan ?? null, budget: status.loop?.budget ?? null, budget_original: status.loop?.budget_original ?? null,
    budget_revisions: status.loop?.budget_revisions ?? [], used: status.loop?.used ?? null, exhausted: status.loop?.exhausted ?? null,
    final: status.final ?? null, ended: status.ended ?? null, stop: status.stop ?? null, accepted: status.accepted ?? false, acceptance: status.acceptance ?? null,
    declined: status.declined ?? null, abandoned: status.abandoned ?? null, review: status.review ?? null, map_scope: status.map_scope ?? null, disputes: status.disputes ?? [], tests: status.tests ?? [],
    gates: status.gates ?? null, obligations: status.obligations ?? [], warnings: status.warnings ?? [], change_lock: lock, gaps: loopGaps,
  } : { phase: null, change_lock: lock, gaps: loopGaps };

  // Packages: what validateEval reads against the export, or the draft.
  let evals = null;
  const packageGaps = [];
  if (exists && records) {
    try { evals = validateEval(repo, name); } catch (error) {
      if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
      packageGaps.push(...thrown(error, 'package'));
    }
  }
  const cases = evals?.cases ?? [];
  const caseGaps = (code) => (evals?.gaps ?? []).filter((gap) => gap.code === code).map((gap) => gap.case).filter(Boolean);
  if (evals) packageGaps.push(...evals.gaps.filter((gap) => gap.layer !== 'spec' || gap.case).map(clean));
  const unnamed = exists && evals ? unnamedPackages(repo, name) : [];
  const unpackaged = handoff && evals ? unpackagedScenarios(repo, name, handoff.handoff) : [];
  const checkable = cases.filter((item) => !item.errors?.length && item.integration?.state !== 'ready' && Array.isArray(item.integration?.missing)
    && item.integration.missing.includes('check') && item.integration.missing.every((entry) => ['check', 'review'].includes(entry))).map((item) => item.id);
  const ready = cases.filter((item) => item.integration?.state === 'ready' && !item.draft_bound && !item.errors?.length);
  const editingEndsLoop = running && ofExport;
  const packages = evals ? {
    read_against: evals.spec ? 'export' : evals.draft ? 'draft' : null, spec: evals.spec, draft: evals.draft ?? null,
    valid: evals.valid, business_ready: evals.business_ready, ready_for_run: evals.ready_for_run,
    cases: cases.map((item) => ({ id: item.id, status: item.status ?? null, integration: item.integration ? { state: item.integration.state, missing: item.integration.missing ?? [] } : null,
      live: Boolean(item.live), sealed: item.sealed?.value ?? null, draft_bound: item.draft_bound === true, adapter: item.adapter ?? null, errors: item.errors?.length ?? 0,
      ...(item.steps?.length ? { steps: item.steps } : {}) })),
    coverage: evals.coverage ?? null, tier: evals.tier ? { eligible: evals.tier.eligible, readiness: evals.tier.readiness, reasons: evals.tier.reasons ?? [] } : null,
    unpackaged_scenarios: unpackaged, unnamed_folders: unnamed, ...(unnamed.length ? { unnamed_note: unnamedMessage(unnamed).problem } : {}),
    waiting_for_check: checkable, stale: caseGaps('case_stale'), draft_bound: caseGaps('draft_bound'), shared_code_mismatch: caseGaps('shared_code_mismatch'),
    then_conflict: [...new Set(caseGaps('then_conflict'))], expected_results_exposed: [...new Set(caseGaps('expected_results_exposed'))],
    legacy: legacyPackages(evals), manual_lines: manualLines(evals).map((row) => ({ case: row.case, then: row.then })),
    // Editing a package or the kit while a loop of this export runs ends it.
    editing_ends_loop: editingEndsLoop,
    warnings: evals.warnings ?? [], gaps: packageGaps,
  } : { gaps: packageGaps };

  // Confirmation: the user's checks confirmation of this export, and what
  // eval review would show before the next one.
  const confirmations = handoff && records ? checksConfirmation(repo, name, handoff.id) : null;
  const latest = confirmations?.latest ?? null;
  const confirmationGaps = [];
  if (confirmations?.gap) confirmationGaps.push(clean(confirmations.gap));
  if (handoff && cases.length && confirmations?.unconfirmed) confirmationGaps.push(clean(confirmations.unconfirmed));
  let review = null;
  if (handoff && cases.length) {
    try { review = reviewEval(repo, name); } catch (error) {
      if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
      confirmationGaps.push(...thrown(error, 'confirmation'));
    }
  }
  const confirmation = handoff ? {
    latest: latest ? { id: latest.id, at: latest.confirmed?.at ?? null, by: latest.confirmed?.by ?? null, kind: latest.confirmed?.kind ?? null,
      tier: latest.run_plan?.tier ?? 'full', attempts: latest.run_plan?.attempts ?? null, agent: latest.run_plan?.agent ?? null, model: latest.run_plan?.model ?? null,
      budget: latest.run_plan?.budget ?? null, start_loop: latest.start_loop === true, stop_on_stuck: latest.stop_on_stuck === true, judge_gating: latest.judge_gating ?? [] } : null,
    current: Boolean(confirmations?.current),
    changed_since: confirmations?.match && !confirmations.match.matches ? confirmations.match.packages.map((entry) => entry.id) : [],
    review: review ? { must_decide: review.must_decide.map((item) => item.code), shown: review.shown, confirm: review.confirm, run_plan_tier: review.run_plan?.tier ?? null,
      gaps: codes(review.gaps) } : null,
    gaps: confirmationGaps,
  } : null;

  // Baseline: the latest base record of this export, how it stands against
  // the packages, the plan and the code, and the start code a new loop keeps.
  const runsDirectory = records ? path.join(records, 'runs') : null;
  const runs = records ? readRuns(runsDirectory) : [];
  const pin = handoff && records ? pinnedStart(repo, name) : null;
  const baselineGaps = [];
  let baseline = null;
  if (handoff && records) {
    const { base, later } = latestValidBaseline(runs.filter(usableRun), handoff.id);
    const differ = base?.is_baseline && !base.baseline_mismatch?.length ? baselinePackagesDiffer(base, cases) : null;
    const planDiffers = base && latest && !base.baseline_mismatch?.length && evals ? baselinePlanDiffers(evals, base, latest, { undecided: undecidedLive(base, cases.filter((item) => item.integration?.state === 'ready')).length > 0 }) : null;
    if (!base) baselineGaps.push({ code: 'baseline_missing', kind: 'artifact', owner: 'agent', layer: 'baseline', message: 'No baseline of this Spec export is recorded.' });
    if (base?.baseline_mismatch?.length) baselineGaps.push({ code: 'baseline_mismatch', kind: 'artifact', owner: 'agent', layer: 'baseline', run: base.run_id, mismatch: base.baseline_mismatch,
      message: `The baseline ${base.run_id} did not behave as declared.` });
    if (differ) baselineGaps.push(clean(differ));
    if (planDiffers) baselineGaps.push(clean(planDiffers));
    const onCode = base ? sameCode(base.code_snapshot, code, repo) : null;
    const onPin = base && pin ? sameCode(base.code_snapshot, pin.start, repo) : null;
    baseline = {
      recorded: base ? { run_id: base.run_id, started_at: base.started_at ?? null, is_baseline: Boolean(base.is_baseline), unavailable_reason: base.baseline_unavailable_reason ?? null,
        code: { commit: base.code_snapshot?.commit ?? null, digest: codeIdentity(base.code_snapshot, repo) }, on_code_now: onCode, on_start_code: onPin,
        packages_differ: Boolean(differ), plan_differs: Boolean(planDiffers), mismatch: base.baseline_mismatch ?? [] } : null,
      later_attempts: later.map((run) => run.run_id),
      start_code: pin ? { loop_started_at: pin.loop?.started_at ?? null, commit: pin.start?.commit ?? null, digest: pin.start?.digest ?? null, restore: restoreHint(name, pin.loop, null),
        code_is_start: sameCode(code, pin.start, repo) === true } : null,
      code_now: { commit: code.commit ?? null, digest: code.digest ?? null, uncommitted: code.changed_files?.length ?? null },
      expectations_file: existsSync(path.join(records, 'baseline-expectations.json')),
      gaps: baselineGaps,
    };
  }

  // Ledger: every run the run index or a folder keeps, and the failures on
  // the code as it is now, which always count.
  const ledgerRead = records ? ledgerState(runsDirectory) : null;
  const ledgerGaps = ledgerRead?.index_missing ? [{ code: 'ledger_index_missing', kind: 'business', owner: 'user', layer: 'ledger', message: ledgerText(ledgerRead) }] : [];
  const nowCode = codeIdentity(code, repo);
  const failuresNow = new Map();
  if (handoff && records && nowCode) {
    for (const entry of sameCodeResults(repo, runsDirectory, handoff.id, runs).filter((item) => item.code === nowCode && item.result === 'fail')) {
      const key = `${entry.case}\n${entry.check}`;
      const held = failuresNow.get(key) ?? { case: entry.case, check: entry.check, failures: 0, runs: new Set() };
      held.failures += 1;
      held.runs.add(entry.run_id);
      failuresNow.set(key, held);
    }
  }
  const sides = (side) => runs.filter((run) => (side === 'trial' ? isTrial(run) : run.side === side)).length;
  const ledger = !ledgerRead ? { gaps: ledgerGaps } : {
    runs: { base: sides('base'), head: sides('head'), trial: sides('trial'), lost: runs.filter(isLost).map((run) => run.run_id),
      interrupted: runs.filter((run) => !usableRun(run) && !isLost(run)).map((run) => run.run_id) },
    index_exists: ledgerRead.index_exists, index_missing: ledgerRead.index_missing, unindexed: ledgerRead.unindexed, altered: ledgerRead.altered,
    broken_lines: ledgerRead.broken_lines, text: ledgerText(ledgerRead),
    failures_on_code_now: [...failuresNow.values()].map((entry) => ({ case: entry.case, check: entry.check, failures: entry.failures, runs: [...entry.runs].sort() })),
    gaps: ledgerGaps,
  };

  // The actions, each with the gaps that refuse it now.
  const specCodes = codes(specGaps);
  const exportBlocked = handoff ? [] : specCodes.filter((entry) => entry !== 'handoff_missing');
  const endsLoop = running && !status?.accepted;
  if (!exists) {
    action(cmd('spec', 'new'), { satisfies: [], needs: [] });
    action([...cmd('spec', 'import'), '--handoff', '<file>'], { satisfies: ['frozen_spec'] });
  } else {
    if (hasOpenspec && !hasRecord) action([...cmd('spec', 'new'), '--adopt'], { satisfies: [], note: 'records Genesis state for an existing OpenSpec change; its requirements stay proposed until the user confirms them in the Spec' });
    if (hasRecord && !exportedBefore) action([...cmd('spec', 'remap'), '--map', '<business-map.json>'], { satisfies: [] });
    if (hasOpenspec && hasRecord && !handoff) {
      action(cmd('spec', 'export'), { satisfies: ['frozen_spec'], effect: endsLoop ? 'ends_loop' : null,
        blocked_by: draft ? codes(draft.gaps) : exportBlocked });
    }
    action([...cmd('spec', 'import'), '--handoff', '<file>'], { satisfies: ['frozen_spec'], effect: endsLoop && handoff ? 'ends_loop' : null });
  }
  if (exists && evals) {
    if (handoff && unpackaged.length) {
      action(cmd('eval', 'new'), { satisfies: [], effect: editingEndsLoop ? 'ends_loop' : null, scenarios: unpackaged.length });
    }
    if (!handoff && draft?.valid) action([...cmd('eval', 'new'), '--draft'], { satisfies: [], note: 'packages bound to a draft can be validated and proved, not confirmed, baselined or run' });
    if (handoff && (packages.stale.length || packages.draft_bound.length)) {
      action(cmd('eval', 'rebind'), { satisfies: ['frozen_spec'], effect: editingEndsLoop ? 'ends_loop' : null, cases: [...new Set([...packages.stale, ...packages.draft_bound])] });
    }
    if (packages.shared_code_mismatch.length) {
      action(cmd('eval', 'sync'), { satisfies: ['shared_code_matches_kit'], effect: editingEndsLoop ? 'ends_loop' : null, cases: packages.shared_code_mismatch });
    }
    if (checkable.length) {
      action(cmd('eval', 'check'), { satisfies: ['checks_proved'], blocked_by: [...toolCodes, ...(handoff || evals.draft ? [] : exportBlocked)], cases: checkable });
    }
  }
  if (handoff && cases.length) {
    action(cmd('eval', 'review'), { satisfies: [], note: 'read-only: the lines, must_decide and must_show a confirmation is made on' });
    const confirmBlocked = codes(review?.gaps ?? packageGaps.filter((gap) => gap.code !== 'integration_pending'));
    action([...cmd('eval', 'confirm'), '--verdicts', '<review.json>', '--by', '<user>', '--ref', '<where they said so>'], {
      by: 'user', satisfies: ['user_confirms_checks', 'attempts_from_user', 'network_sealed_or_live', 'checks_proved'],
      needs: ['user consent: the checks, their verdicts and the run plan, as must_show lists them',
        ...(running && ofExport && confirmation?.current ? ['a confirmation with another plan or tier ends the running loop'] : [])],
      flags: review?.confirm?.flags ?? ['--start-loop', '--stop-on-stuck', '--judge-gating CASE:THEN'],
      effect: running && ofExport && !confirmation?.current ? 'ends_loop' : null, blocked_by: confirmBlocked, needed: !confirmation?.current });
  }

  // Runs. A model-calling run before any confirmation of the export needs
  // the user's cost approval.
  const kitModel = records ? kitSettings(repo).model ?? null : null;
  const modelCalling = ready.some(liveCase) || Boolean(kitModel);
  const costNeeds = modelCalling && !latest ? ['user cost approval: --approved-by NAME --ref REF'] : [];
  const runGaps = codes((evals?.gaps ?? []).filter((gap) => gap.code !== 'integration_pending'));
  const noReady = evals && !ready.length ? ['no_runnable_case'] : [];
  const needs = evals ? planNeeds(cases, ready, latest?.run_plan?.model ?? kitModel) : { needed: false };
  const undecided = needs.needed && (latest?.run_plan?.attempts ?? null) === null ? ['attempts_undecided'] : [];
  if (handoff && evals && !running) {
    const offCode = Boolean(pin) && sameCode(code, pin.start, repo) !== true;
    const lightExisting = evals.tier?.readiness === 'light' && project.mode === 'existing';
    // A baseline is wanted while none stands for the packages, the plan and
    // the start code as they are now.
    const needed = baselineGaps.length > 0 || (Boolean(pin) && baseline?.recorded?.on_start_code === false);
    // Code the user accepted for this export holds the change: a base record
    // on it would describe the change, not the code before it. `run start`
    // refuses it the same way, outside --at-start.
    const holdsAccepted = Boolean(acceptedHolding(repo, name, handoff.id));
    action([...cmd('run', 'start'), '--baseline', ...(baseline?.expectations_file ? ['--expect', `.genesis/edd/${name}/baseline-expectations.json`] : [])], {
      satisfies: ['baseline_on_start_code', 'expectations_before_results'], needs: costNeeds,
      blocked_by: [...runGaps, ...noReady, ...toolCodes, ...undecided, ...(offCode ? ['baseline_after_change'] : []), ...(holdsAccepted ? ['code_holds_accepted_change'] : [])], needed });
    if (pin && offCode) {
      action([...cmd('run', 'start'), '--baseline', '--at-start'], { satisfies: ['baseline_on_start_code', 'expectations_before_results'], needs: costNeeds,
        blocked_by: [...runGaps, ...noReady, ...toolCodes, ...undecided], needed });
    }
    if (!ready.length || project.mode === 'new') {
      action([...cmd('run', 'start'), '--baseline', '--unavailable', 'no_implementation'], { satisfies: ['baseline_on_start_code'],
        blocked_by: [...runGaps, ...(lightExisting ? ['light_baseline_required'] : []), ...(offCode ? ['baseline_after_change'] : []), ...(holdsAccepted ? ['code_holds_accepted_change'] : [])], needed });
    }
  }
  if (handoff && evals) {
    const trialGaps = codes((evals.gaps ?? []).filter((gap) => !gap.case && !['integration_pending', 'scenario_uncovered', 'requirement_uncovered', 'then_uncovered', 'case_draft', 'cases_missing'].includes(gap.code)));
    const fit = cases.filter((item) => !item.errors?.length && !item.draft_bound);
    action([...cmd('run', 'start'), '--trial'], { satisfies: ['failures_count_on_same_code'], needs: costNeeds,
      blocked_by: [...trialGaps, ...(fit.length ? [] : ['no_trial_case']), ...toolCodes, ...(lock ? ['change_locked'] : []),
        ...(running && ofExport && status.gates?.head_run ? [status.gates.head_run.code] : [])],
      ...(running && ofExport ? { spends: 'loop_budget' } : {}), never: ['baseline', 'loop run', 'accepted run', 'proof'] });
    if (pin && lock) action([...cmd('run', 'start'), '--trial', '--at-start'], { satisfies: ['failures_count_on_same_code'], needs: costNeeds, blocked_by: [...trialGaps, ...toolCodes] });
    const inLoop = running && ofExport;
    const headBlocked = inLoop
      ? [...(status.gates?.head_run ? [status.gates.head_run.code] : []), ...runGaps, ...noReady, ...toolCodes]
      : [...(lock ? ['change_locked'] : []), ...(baseline?.recorded ? [] : ['baseline_missing']), ...runGaps, ...noReady, ...toolCodes];
    action(cmd('run', 'start'), { satisfies: inLoop ? ['failures_count_on_same_code', 'budget_stops_loop', 'final_run_when_results_vary'] : ['failures_count_on_same_code'],
      needs: inLoop ? [] : costNeeds, blocked_by: headBlocked, in_loop: inLoop, needed: inLoop,
      ...(inLoop ? { spends: 'loop_budget', role: status.situation?.code === 'final_run_due' ? 'final' : null } : { acceptance: false, note: 'a pass outside a loop is a comparison, not acceptance' }) });
  }

  // The loop: starting one, and what a running one allows.
  if (handoff && evals && !(running && ofExport)) {
    let inputs = null;
    try { inputs = loopInputs(repo, name, { latest: true }); } catch (error) {
      if (error?.code === 'RUNTIME_INSIDE_PROJECT') throw error;
    }
    const startGaps = [...codes(inputs?.gaps ?? []), ...(ledgerRead?.index_missing ? ['ledger_index_missing'] : [])];
    // The user's consent comes with --by and --ref, or from the latest
    // confirmation when it covers the packages as they are, recorded
    // --start-loop, and no loop started since.
    const covering = confirmations?.current ?? null;
    const confirmedAt = Date.parse(covering?.confirmed?.at);
    let startedSince = false;
    if (Number.isFinite(confirmedAt)) {
      const chain = status?.loop?.started_at ? [status.loop.started_at] : [];
      const decisions = readDecisions(records).entries;
      startedSince = chain.some((at) => Date.parse(at) > confirmedAt) || decisions.some((entry) => entry.type === 'loop_start' && Date.parse(entry.at) > confirmedAt);
    }
    const viaConfirmation = covering?.start_loop === true && !startedSince;
    action([...cmd('loop', 'start'), ...(viaConfirmation ? [] : ['--by', '<user>', '--ref', '<where they said so>'])], {
      by: 'user', satisfies: ['baseline_on_start_code', 'packages_fixed_in_loop', 'budget_stops_loop'],
      needs: [viaConfirmation ? `user consent: recorded by checks confirmation ${covering.id}` : 'user consent: starting a loop, recorded with --by and --ref',
        'user consent with --by and --ref for a budget above the confirmed one'],
      blocked_by: startGaps, start_code: pin ? 'pinned' : 'baseline', needed: !(ofExport && phase === 'done') });
  }
  if (status) {
    const loopCmd = (...words) => cmd('loop', ...words);
    if (running) {
      if (status.review?.run_id) {
        action([...loopCmd('review'), '--run', status.review.run_id, '--answers', '<file>', '--reviewer', '<subagent|human|genesis|self>'], {
          satisfies: ['review_before_acceptance'], needs: status.review.flips?.length ? ['an explanation for every check that went from not passing to passing'] : [] });
      }
      const candidate = (status.obligations ?? []).find((entry) => entry.kind === 'consent' && entry.decision === 'acceptance');
      if (candidate) {
        action([...loopCmd('accept'), '--run', candidate.run_id, '--by', '<user>', '--ref', '<where they said so>'], { by: 'user',
          satisfies: ['user_accepts', 'review_before_acceptance', 'final_run_when_results_vary'], needs: ['user consent: acceptance, after must_show'],
          blocked_by: codes(status.gates?.accept ?? []) });
      }
      action([...loopCmd('end'), '--reason', '<text>'], { satisfies: [], effect: 'ends_loop', needed: false });
      action([...loopCmd('decline'), '--by', '<user>', '--ref', '<where they said so>'], { by: 'user', satisfies: ['user_accepts'], needs: ['user consent: declining this loop'], effect: 'ends_loop', needed: false });
      action([...loopCmd('budget'), '--max-iterations', '<n>', '--by', '<user>', '--ref', '<where they said so>'], { by: 'user', satisfies: ['budget_stops_loop'], needs: ['user consent: a new budget'],
        needed: Boolean(status.loop?.exhausted) });
      action([...loopCmd('dispute'), '--check', '<case:check>', '--evidence', '<file>'], { satisfies: [], needs: ['the user rules on it'], needed: false });
      for (const dispute of (status.disputes ?? []).filter((entry) => !entry.ruling)) {
        action([...loopCmd('dispute'), '--resolve', dispute.id, '--ruling', '<accept|reject>', '--by', '<user>', '--ref', '<where they said so>'], { by: 'user',
          satisfies: ['packages_fixed_in_loop'], needs: ['user consent: the ruling'], note: 'an accepted dispute agrees to a package change; the change itself ends the loop' });
      }
      const unreported = (status.runs ?? []).filter((run) => run.report === 'missing').at(-1);
      if (unreported) action([...loopCmd('report'), '--run', unreported.run_id], { satisfies: [] });
    } else if (phase === 'ended' && status.ended?.reason === 'stop_budget') {
      action([...loopCmd('budget'), '--max-iterations', '<n>', '--by', '<user>', '--ref', '<where they said so>'], { by: 'user', satisfies: ['budget_stops_loop'],
        needs: ['user consent: a new budget, which lets this loop go on'] });
    }
    action([...loopCmd('tests'), '--command', '<text>', '--exit-code', '<n>'], { satisfies: [], note: 'records the project\'s own test run as the agent\'s record', needed: false });
  }
  if (exists && (running || lock || pin)) {
    action([...cmd('change', 'abandon'), '--by', '<user>', '--ref', '<where they said so>', '--reason', '<text>'], { by: 'user', satisfies: ['user_accepts'],
      needs: ['user consent: abandoning this change; the pinned start code is released'], effect: running ? 'ends_loop' : null, needed: false });
  }

  // What the user must see before a decision that is pending now: the review
  // before a confirmation, the loop's before an acceptance or a new loop,
  // and the lock.
  const mustShow = {};
  const merge = (source, prefix) => {
    for (const [key, entries] of Object.entries(source ?? {})) {
      if (!nonEmpty(entries)) continue;
      const target = key in mustShow ? `${prefix}_${key}` : key;
      mustShow[target] = Array.isArray(entries) ? entries : [entries];
    }
  };
  if (review && !confirmation?.current) merge(review.must_show, 'confirmation');
  if (status?.must_show) merge(status.must_show, 'loop');
  if (lock) mustShow.change_lock = [{ reason: lock.reason, loop: lock.loop, ended_at: lock.ended_at, unlocks: lock.unlocks }];
  if (spec.excluded.length && !handoff) mustShow.excluded_requirements = spec.excluded;

  // At most one suggestion, always an action allowed now; which path to take
  // is the agent's. A running loop's own suggestion comes first. When the
  // action it names is refused now, or is not one listed here, it is not
  // passed on and nothing takes its place: blocked_by and the gaps say what
  // the loop's next step waits on. Otherwise the first action allowed and
  // wanted now, the agent's before the user's. A pending checks confirmation
  // is suggested as the review the user decides on.
  const sameCommand = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((word, index) => word === b[index]);
  const fromLoop = running && Array.isArray(status?.suggestion?.command) ? status.suggestion : null;
  const loopAllowed = fromLoop ? actions.some((entry) => entry.allowed && sameCommand(entry.command, fromLoop.command)) : false;
  const loopSuggestion = loopAllowed ? fromLoop : null;
  const optional = ['review', 'import', 'remap', 'tests', 'dispute', 'end', 'report', 'adopt'];
  const wanted = actions.filter((entry) => entry.allowed && entry.needed !== false && entry.command[0] !== 'change' && !optional.includes(entry.command[1])
    && !entry.command.includes('--unavailable') && !entry.command.includes('--trial') && !entry.command.includes('--adopt'));
  const preferred = fromLoop ? null : wanted.find((entry) => entry.by === 'agent') ?? wanted.find((entry) => entry.by === 'user') ?? null;
  const suggestion = loopSuggestion ?? (!preferred ? null
    : preferred.command[0] === 'eval' && preferred.command[1] === 'confirm'
      ? { command: cmd('eval', 'review'), why: 'The user\'s confirmation of the checks is pending; eval review gives what they decide on (must_show).' }
      : { command: preferred.command, why: `${preferred.by === 'user' ? 'The user\'s decision, allowed now' : 'Allowed now'}${preferred.satisfies.length ? `; about ${preferred.satisfies.join(', ')}` : ''}.` });

  const layers = { spec, packages, confirmation, baseline, loop, ledger, machine };
  const seen = new Set();
  const gaps = [...specGaps, ...packageGaps, ...confirmationGaps, ...baselineGaps, ...loopGaps, ...ledgerGaps, ...machineGaps].map(clean).filter((gap) => {
    const key = `${gap?.code}\n${gap?.case ?? ''}\n${gap?.message ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { schema: 'genesis-edd.workflow-status/1', change: name, layers, gaps, must_show: mustShow, actions, rules: RULES, suggestion };
}

// The earlier stage-by-stage check, kept as a name for workflowStatus: the
// stage is no longer read.
export function checkWorkflow(repo, stage, name) {
  return { ...workflowStatus(repo, name), ...(stage ? { stage_ignored: stage } : {}) };
}
