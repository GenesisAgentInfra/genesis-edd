import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertOutsideRepo, initProject, projectRoot } from './project.js';
import { exportSpec, importSpec, newSpec, remapSpec, specInstructions, specStatus, validateSpec } from './spec.js';
import { newEval, rebindEval, syncEval, validateEval } from './eval.js';
import { checkEval, cleanupRun, compareRuns, listRuns, showRun, startRun } from './run.js';
import { confirmEval, reviewEval } from './confirm.js';
import {
  abandonChange, acceptLoop, budgetLoop, declineLoop, disputeLoop, endLoop, loopPhase, loopStatus, recordTests, reviewLoop, startLoop, writeReport,
} from './loop.js';
import { checkWorkflow, workflowStatus } from './workflow.js';

// The version is read from package.json, so the CLI and the plugin manifests
// that carry the same number cannot drift apart.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const help = `Genesis EDD ${VERSION} — requirements and evals for evaluation-driven development

Every command prints JSON and takes --repo PATH (default: the current folder).
Refusals print { error, code, gaps[, must_show] } and exit 1. A gap names its
layer (spec, package, kit, confirmation, baseline, loop, ledger, machine or
code), its owner (agent or user), the file or digest involved and the facts.
Results state facts and carry at most one suggestion; which command comes
next is the caller's choice. Decisions that are the user's take --by NAME and
--ref REF, which record who decided and where they said so.

Project
  init --mode new|existing [--agent codex|claude|both|none]
      Installs the OpenSpec project files, the Spec schema and the skills
      (default --agent both). A shipped skill file the project edited is kept
      and listed under conflicts; a skill's LOCAL.md is never touched. Each
      skill gets its own launcher and runtime.json, written again every time.
  The CLI refuses to work on a project that holds its own installation
  (runtime_inside_project): install it outside the project it judges.

Spec
  spec new NAME [--mode new|existing] [--map PATH] [--adopt]
      Creates a change and records its context: the code (commit, changed
      files, content digest) and, with --map, a copy of a Genesis
      business-map.json. A change-review Map is accepted as partial coverage.
      --adopt records Genesis state for an existing OpenSpec change instead;
      its requirements read as proposed.
  spec remap NAME --map PATH
      Replaces the Map of a change that has never been exported.
  spec instructions NAME | spec status NAME
      What OpenSpec asks for next, and the change with its current export.
  spec validate NAME
      Checks the draft: requirement sources and states, scenarios (every
      requirement has one, with a GIVEN or WHEN step and a THEN step, each
      written "- **GIVEN|WHEN|THEN|AND** text"; a step-like line in another
      form is an error), the Map against its copy, recomputed now, and impact.md.
      OpenSpec findings that do not affect how requirements, scenarios or
      sources are read are warnings. Exits 1 when the draft is invalid.
  spec export NAME
      Writes a content-addressed handoff of the accepted requirements and
      appends it to exports.jsonl. Proposed requirements and requirements an
      open question names are left out and listed (excluded); an open question
      that names no requirement blocks the export. Returns must_show (what the
      user sees of each requirement) and ends_loop: whether the export ends a
      loop that runs on the previous one. Exporting an unchanged draft writes
      nothing.
  spec import NAME --handoff FILE
      Takes a genesis.spec-handoff (version 2) written elsewhere, checked
      with the same rules for sources, states and scenarios, as the current
      export.
  Later commands read the current export by digest only.

Eval packages
  eval new NAME [--draft]
      Writes one Harbor task package per scenario that has none, under
      .genesis/edd/NAME/evals/, with one gating check per THEN or AND line and
      a sealed docker-compose.yaml. It never rewrites an existing package.
      --draft writes packages against a valid Spec draft when nothing is
      exported; those can be validated and proved, not confirmed or run.
  eval validate NAME
      Read-only. Structure, coverage of every THEN line across the packages of
      its scenario (a gating check, or scenario.manual), whether each package
      is sealed or declares a live dependency, shared code against the kit,
      exposure of expected results to the program, readiness and the tier.
      Exits 1 when the packages, or the Spec they are read against, are
      invalid.
  eval rebind NAME
      Binds packages to the current export when their requirement and
      scenario read the same, and lists the stale ones. Exits 1 when one is
      stale.
  eval sync NAME [--case ID]...
      Writes the shipped helper and the kit's verifier code into packages
      where they differ. This changes the packages.
  eval check NAME [--case ID]... [--timeout MINUTES] [--yes | --allow-env NAME[,NAME]]
      Proves finished packages one at a time: their fixtures through Harbor
      with the real verifier, and in the light tier a probe with Harbor's nop
      agent under which every gating check must come out unknown. A package
      that changed while it was checked keeps no proof; a package whose
      shared code differs from the kit is refused. Exits 1 unless every
      checked package passed.

Confirmation
  eval review NAME
      Read-only. Every THEN line with its checks, verdict, baseline result and
      the proof that its checks can fail; must_decide (the user's decisions);
      must_show (what the user sees before confirming, with shown, its digest);
      the reviewer's brief and answer template; and the proposed run plan
      with its tier and the reasons.
  eval confirm NAME --verdicts FILE --by NAME --ref REF [--reason TEXT]
               [--tier light|full] [--attempts N] [--agent NAME|module:Class]
               [--model MODEL] [--max-iterations N] [--max-minutes M] [--max-cost USD]
               [--start-loop] [--stop-on-stuck] [--judge-gating CASE:THEN]...
               [--accept-verdict CASE:THEN --accept-reason TEXT]...
      Records the user's confirmation of the checks and the run plan in
      confirmed.json, with the must_decide items and the digest of must_show
      at that moment. --start-loop records that the same words start a loop;
      --stop-on-stuck that a stuck loop stops; --judge-gating makes a judge
      check's line gating; --accept-verdict accepts, with the user's reason,
      a line whose checks the reviewer found weaker or stronger than it. The light tier refuses --agent and --model, and
      lines with no proof that their checks can fail. A package that can reach
      outside networks without declaring a live dependency is refused.

Runs
  run start NAME [--baseline [--unavailable REASON] [--expect FILE]] [--trial]
                 [--at-start] [--case ID]... [--attempts N] [--agent NAME|module:Class]
                 [--model MODEL] [--timeout MINUTES] [--yes | --allow-env NAME[,NAME]]
                 [--approved-by NAME --ref REF] [--all-packages]
      Runs ready packages with Harbor in local Docker and writes one record
      under runs/, listed in runs/index.jsonl before Harbor starts and after
      it ends. A run whose folder or run.json is gone counts as a failure of
      its gating checks on its code. --baseline records the code before a
      change, with the expected results of baseline-expectations.json
      (--expect); --unavailable records that nothing could run. --at-start
      runs on the pinned start code, rebuilt outside the project. --trial
      runs structurally valid packages, ready or not; a trial is never a
      baseline, a loop run, an accepted run or a proof, and its failures
      count. A model-calling run before any confirmation needs the user's cost
      approval (--approved-by, --ref). Inside a loop the plan is fixed:
      values that differ from it are refused. After a loop ended without
      acceptance, head runs and trials of the application code are refused
      until a new loop starts or the change is abandoned (change_locked). A
      pass outside a loop is not acceptance. --all-packages lets a final run
      go on after a failing package. Progress goes to stderr
      (GENESIS_EDD_PROGRESS=0 turns it off). Exits 1 when execution did not
      complete.
  run list NAME [--side base|head|trial] | run show NAME --run ID
  run compare NAME --run ID [--against ID]
      Read-only views of the runs; compare uses the latest valid baseline
      unless --against names one.
  run cleanup NAME --run ID
      Removes the Docker containers, networks and volumes of that run's
      Harbor projects only.

Loop
  loop start NAME [--by NAME --ref REF] [--max-iterations N] [--max-minutes M] [--max-cost USD]
      Fixes the Spec, the baseline, the start code (the baseline's code), the
      packages, the plan, the tier and the budget of one loop. Needs the
      user's consent (--by, --ref) unless the latest confirmation recorded
      --start-loop and no loop started since; a budget above the confirmed one
      needs it too. The working tree may already hold the change: what moved
      and the runs made before the loop are recorded.
  loop status NAME
      Read-only. The phase (live, closing, ended, done), the situation, the
      runs, the budget, regressions, stops, the gates the CLI holds, the
      obligations it cannot check, must_show when a user decision is pending,
      and at most one suggestion.
  loop review NAME --run ID --answers FILE --reviewer subagent|human|genesis|self [--by NAME]
      Records the final review of a passing run: which change explains each
      check that went from not passing to passing, whether the change
      special-cases an eval input, whether it changes anything the Spec
      does not ask for, and whether it has a side effect no check covers.
      Acceptance needs one for the accepted code.
  loop report NAME [--run ID]
      Writes a run's report (Result and Changes from the records, free Notes).
  loop accept NAME --run ID --by NAME --ref REF
      Records the user's acceptance of a passing run of the loop. Refusals
      carry must_show.
  loop decline NAME --by NAME --ref REF [--reason TEXT]
      Records that the user declined; ends the loop.
  loop end NAME --reason TEXT [--by NAME --ref REF]
      Ends the running loop.
  loop budget NAME [--max-iterations N] [--max-minutes M] [--max-cost USD] --by NAME --ref REF
      Revises the budget of a running loop, or lets a loop that stopped only
      on its budget go on.
  loop dispute NAME --check CASE:CHECK --evidence FILE
  loop dispute NAME --resolve ID --ruling accept|reject --by NAME --ref REF
      Records evidence that a check is wrong, and the user's ruling. Only a
      package change, which the ruling may agree to, ends the loop.
  loop tests NAME --command TEXT --exit-code N [--summary TEXT]
      Records a run of the project's own tests, shown at acceptance as the
      agent's record.
  change abandon NAME --by NAME --ref REF --reason TEXT
      Records that the user abandoned the change: ends a running loop and
      releases the pinned start code and the change lock.

Status
  workflow status NAME
      Read-only. The facts of every layer (spec, packages, confirmation,
      baseline, loop, ledger, machine), every gap, must_show for the decisions
      pending now, and every action the CLI would take now, each with who
      takes it, the rules it is about, the consent it needs, whether it ends
      a running loop, and the gaps that refuse it (blocked_by).
  workflow check [STAGE] NAME
      The same as workflow status; STAGE is ignored.

Records outside Git, for this machine only: runs/, checks/, loop.json,
loop-start.patch and decisions.jsonl under .genesis/edd/NAME/. Committed with
the change: the Spec folder with its handoffs and exports.jsonl, the
packages, spec-drafts/, baseline-expectations.json, review.json,
confirmed.json, reports/ and accepted.json.
Harbor 0.27.0 and Docker are separate tools that runs need on this machine.
Genesis Map is a separate tool.
`;

// The options every command of a group may take, by action.
const OPTIONS = {
  spec: {
    new: { mode: { type: 'string' }, map: { type: 'string' }, adopt: { type: 'boolean' } },
    import: { handoff: { type: 'string' } },
    remap: { map: { type: 'string' } },
    instructions: {}, status: {}, validate: {}, export: {},
  },
  eval: {
    new: { draft: { type: 'boolean' } },
    validate: {}, review: {}, rebind: {},
    sync: { case: { type: 'string', multiple: true } },
    check: { case: { type: 'string', multiple: true }, timeout: { type: 'string' }, yes: { type: 'boolean' }, 'allow-env': { type: 'string', multiple: true } },
    confirm: {
      verdicts: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' }, reason: { type: 'string' }, tier: { type: 'string' },
      attempts: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' },
      'max-cost': { type: 'string' }, 'start-loop': { type: 'boolean' }, 'stop-on-stuck': { type: 'boolean' }, 'judge-gating': { type: 'string', multiple: true }, 'accept-verdict': { type: 'string', multiple: true }, 'accept-reason': { type: 'string', multiple: true },
    },
  },
  run: {
    start: {
      baseline: { type: 'boolean' }, unavailable: { type: 'string' }, expect: { type: 'string' }, 'at-start': { type: 'boolean' }, trial: { type: 'boolean' },
      case: { type: 'string', multiple: true }, attempts: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, timeout: { type: 'string' },
      yes: { type: 'boolean' }, 'allow-env': { type: 'string', multiple: true }, 'approved-by': { type: 'string' }, ref: { type: 'string' },
      'all-packages': { type: 'boolean' },
    },
    list: { side: { type: 'string' } },
    show: { run: { type: 'string' } },
    compare: { run: { type: 'string' }, against: { type: 'string' } },
    cleanup: { run: { type: 'string' } },
  },
  loop: {
    start: { 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' }, 'max-cost': { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    status: {},
    report: { run: { type: 'string' } },
    review: { run: { type: 'string' }, answers: { type: 'string' }, reviewer: { type: 'string' }, by: { type: 'string' } },
    accept: { run: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    decline: { by: { type: 'string' }, ref: { type: 'string' }, reason: { type: 'string' } },
    end: { reason: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    budget: { 'max-iterations': { type: 'string' }, 'max-minutes': { type: 'string' }, 'max-cost': { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    dispute: { check: { type: 'string' }, evidence: { type: 'string' }, resolve: { type: 'string' }, ruling: { type: 'string' }, by: { type: 'string' }, ref: { type: 'string' } },
    tests: { command: { type: 'string' }, 'exit-code': { type: 'string' }, summary: { type: 'string' } },
  },
  change: {
    abandon: { by: { type: 'string' }, ref: { type: 'string' }, reason: { type: 'string' } },
  },
};

// The project a command works on (--repo, else the working directory),
// refused when it holds this CLI.
function projectOf(value) {
  const repo = projectRoot(value ?? '.');
  try { assertOutsideRepo(repo); } catch (error) {
    // Without --repo the project is the working directory, which may be a
    // folder above the project rather than the project itself.
    if (value === undefined && error?.code === 'RUNTIME_INSIDE_PROJECT') {
      const hint = ` No --repo was given, so the project is the working directory ${path.resolve(repo)}: pass --repo with the project's folder, or run from inside the project.`;
      error.message += hint;
      for (const gap of error.gaps ?? []) gap.message += hint;
    }
    throw error;
  }
  return repo;
}

const number = (value) => (value === undefined ? undefined : Number(value));

// The phase of the change's latest loop as it stands before an export or an
// import: null when no loop has started (loop status refuses with
// loop_missing only), undefined when its status cannot be read.
function phaseBefore(repo, name) {
  let status;
  try { status = loopStatus(repo, name); } catch (error) {
    const noLoop = Array.isArray(error?.gaps) && error.gaps.length > 0 && error.gaps.every((gap) => gap?.code === 'loop_missing');
    return noLoop ? null : undefined;
  }
  if (!status?.loop) return null;
  try { return loopPhase(status); } catch { return undefined; }
}

// Read-only status of a change; it exits 0 whatever the change lacks.
function status(argv, stage, name) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: 'string' } }, strict: true, allowPositionals: false });
  const repo = projectOf(values.repo);
  return stage ? checkWorkflow(repo, stage, name) : workflowStatus(repo, name);
}

export function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  if (argv.length === 1 && argv[0] === '--version') return { version: VERSION, openspec: '2.1.0' };
  const [command, action, name] = argv;
  if (command === 'workflow') {
    // workflow status NAME, workflow check NAME, or workflow check STAGE NAME.
    if (!['status', 'check'].includes(action) || !name || name.startsWith('-')) throw new Error('workflow takes status NAME, or check [STAGE] NAME, and the name of a change.');
    const staged = action === 'check' && argv[3] && !argv[3].startsWith('-');
    return staged ? status(argv.slice(4), name, argv[3]) : status(argv.slice(3), null, name);
  }
  // Earlier releases took a stage name as the command; it reads the status.
  if (['write-eval', 'run-eval', 'loop-and-implement'].includes(command)) {
    if (!action || action.startsWith('-')) throw new Error(`${command} NAME reads the workflow status of a change, and takes its name.`);
    return status(argv.slice(2), command, action);
  }
  if (command === 'prepare') throw new Error('prepare is planned and not implemented.');
  const init = command === 'init';
  const group = OPTIONS[command];
  if (!init && (!group || !Object.hasOwn(group, action ?? '') || !name || name.startsWith('-'))) {
    throw new Error('Unknown command; genesis-edd --help lists the commands.');
  }
  const options = { repo: { type: 'string' },
    ...(init ? { mode: { type: 'string' }, agent: { type: 'string', default: 'both' } } : group[action]) };
  const { values } = parseArgs({ args: argv.slice(init ? 1 : 3), options, strict: true, allowPositionals: false });
  const repo = projectOf(values.repo);
  if (init) return initProject(repo, values.mode, values.agent);
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(timeout > 0)) throw new Error('--timeout is a number of minutes.');

  if (command === 'spec') {
    if (action === 'new') return newSpec(repo, name, values);
    if (action === 'import') return importSpec(repo, name, { handoff: values.handoff, loopPhase: phaseBefore(repo, name) });
    if (action === 'remap') return remapSpec(repo, name, { map: values.map });
    if (action === 'instructions') return specInstructions(repo, name);
    if (action === 'status') return specStatus(repo, name);
    if (action === 'export') return exportSpec(repo, name, { loopPhase: phaseBefore(repo, name) });
    const result = validateSpec(repo, name);
    if (!result.valid) process.exitCode = 1;
    const { specs, ...summary } = result;
    return { ...summary, specs: specs.map(({ content, ...spec }) => spec) };
  }

  if (command === 'eval') {
    if (action === 'new') return newEval(repo, name, { draft: values.draft === true });
    // eval review only reads, so it exits 0; eval confirm exits 1 on a refusal.
    if (action === 'review') return reviewEval(repo, name);
    if (action === 'confirm') {
      return confirmEval(repo, name, { verdicts: values.verdicts, by: values.by, ref: values.ref, reason: values.reason, tier: values.tier, agent: values.agent,
        model: values.model, attempts: number(values.attempts), iterations: number(values['max-iterations']), minutes: number(values['max-minutes']),
        maxCost: number(values['max-cost']), startLoop: values['start-loop'] === true, stopOnStuck: values['stop-on-stuck'] === true,
        judgeGating: values['judge-gating'] ?? [], acceptVerdict: values['accept-verdict'] ?? [], acceptReason: values['accept-reason'] ?? [] });
    }
    if (action === 'rebind') {
      const result = rebindEval(repo, name);
      if (result.stale?.length) process.exitCode = 1;
      return result;
    }
    if (action === 'sync') return syncEval(repo, name, { cases: values.case });
    if (action === 'check') {
      const result = checkEval(repo, name, { case: values.case, timeout, yes: values.yes, allowEnv: values['allow-env'] });
      if (!result.passed) process.exitCode = 1;
      return result;
    }
    const result = validateEval(repo, name);
    if (!result.valid) process.exitCode = 1;
    return result;
  }

  if (command === 'run') {
    if (action === 'list') return listRuns(repo, name, { side: values.side });
    if (action === 'show') return showRun(repo, name, { run: values.run });
    if (action === 'compare') return compareRuns(repo, name, { run: values.run, against: values.against });
    if (action === 'cleanup') {
      const result = cleanupRun(repo, name, { run: values.run });
      if (result.errors?.length) process.exitCode = 1;
      return result;
    }
    const { 'at-start': atStart, 'allow-env': allowEnv, 'approved-by': approvedBy, 'all-packages': allPackages, ...rest } = values;
    const result = startRun(repo, name, { ...rest, timeout, attempts: number(values.attempts), atStart: atStart === true, trial: values.trial === true,
      approvedBy, ref: values.ref, allowEnv, allPackages: allPackages === true });
    if (!['completed', 'not_run'].includes(result.execution_status)) process.exitCode = 1;
    return result;
  }

  if (command === 'loop') {
    const budget = { maxIterations: number(values['max-iterations']), maxMinutes: number(values['max-minutes']), maxCost: number(values['max-cost']) };
    if (action === 'start') {
      return startLoop(repo, name, { iterations: budget.maxIterations, minutes: budget.maxMinutes, maxCost: budget.maxCost, by: values.by, ref: values.ref });
    }
    if (action === 'report') return writeReport(repo, name, { run: values.run });
    if (action === 'review') return reviewLoop(repo, name, { run: values.run, answers: values.answers, reviewer: values.reviewer, by: values.by });
    if (action === 'accept') return acceptLoop(repo, name, { run: values.run, by: values.by, ref: values.ref });
    if (action === 'decline') return declineLoop(repo, name, { by: values.by, ref: values.ref, reason: values.reason });
    if (action === 'end') return endLoop(repo, name, { reason: values.reason, by: values.by, ref: values.ref });
    if (action === 'budget') return budgetLoop(repo, name, { ...budget, by: values.by, ref: values.ref });
    if (action === 'dispute') {
      return disputeLoop(repo, name, { check: values.check, evidence: values.evidence, resolve: values.resolve, ruling: values.ruling, by: values.by, ref: values.ref });
    }
    if (action === 'tests') return recordTests(repo, name, { command: values.command, exitCode: number(values['exit-code']), summary: values.summary });
    return loopStatus(repo, name);
  }

  return abandonChange(repo, name, { by: values.by, ref: values.ref, reason: values.reason });
}
