import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, codeState, digest, localPath, readJSON, writeJSON } from './project.js';
import { eddDirectory, kitDirectory, validateEval } from './eval.js';

const UNAVAILABLE = ['no_implementation', 'execution_blocked', 'incompatible_tasks'];
const RESULTS = ['pass', 'fail', 'unknown'];

// GENESIS_EDD_HARBOR holds a JSON array when Harbor is not on PATH as `harbor`.
function harborCommand() {
  const custom = process.env.GENESIS_EDD_HARBOR;
  if (!custom) return ['harbor'];
  const command = JSON.parse(custom);
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
    throw new Error('GENESIS_EDD_HARBOR must be a JSON array of command words.');
  }
  return command;
}

// Docker and Harbor as they are on this machine. Read-only.
export function runTools() {
  const gaps = [];
  const [bin, ...rest] = harborCommand();
  const probe = spawnSync(bin, [...rest, '--version'], { encoding: 'utf8', timeout: 120_000 });
  const harbor = probe.status === 0 ? probe.stdout.trim().split('\n').pop() : null;
  if (!harbor) {
    // A probe can fail for reasons other than a missing install, such as a
    // sandbox that blocks the tool's cache. Pass the tool's own words on.
    const reason = (probe.error?.message ?? probe.stderr ?? '').trim().split('\n').pop();
    gaps.push({ code: 'harbor_missing', kind: 'technical', owner: 'agent', route: 'run-eval',
      message: `Harbor could not be run as \`${[bin, ...rest].join(' ')}\`${reason ? `: ${reason}.` : '.'} Install it with \`uv tool install harbor\`, or set GENESIS_EDD_HARBOR to its command.` });
  }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  if (!docker) {
    gaps.push({ code: 'docker_unavailable', kind: 'technical', owner: 'agent', route: 'run-eval',
      message: 'Docker is not running. Start it, or ask the user to; do not record this as a failing check.' });
  }
  return { harbor, docker, gaps };
}

function blocked(message, repo, name, gaps) {
  return Object.assign(new Error(message), {
    code: 'RUN_INPUT_BLOCKED', gaps,
    resume: { stage: 'run-eval', change: name, command: ['workflow', 'check', 'run-eval', name, '--repo', repo] },
  });
}

// Identity of the code a run executes. A digest names the working tree; it is
// not a stored copy, so uncommitted code cannot be restored from a run record.
function codeSnapshot(repo) {
  const { head, changed } = codeState(repo);
  if (changed === null) {
    return { version: 'uncommitted', snapshot: { commit: null, changed_files: null, digest: null, note: 'Not a Git repository; the executed code is not pinned.' } };
  }
  const files = changed.map((file) => {
    try { return `${file}\n${digest(readFileSync(path.join(repo, file)))}`; } catch { return `${file}\ndeleted`; }
  });
  return {
    version: head && !changed.length ? head : head || changed.length ? 'uncommitted' : 'empty',
    snapshot: { commit: head, changed_files: changed, digest: digest([head ?? '', ...files].join('\n')) },
  };
}

// Run and check records are evidence of this machine, not source.
function ignoreRecords(repo) {
  const file = localPath(repo, '.genesis/edd/.gitignore');
  const wanted = '/*/runs/\n/*/checks/\n__pycache__/\n';
  if (!existsSync(file) || readFileSync(file, 'utf8') !== wanted) writeFileSync(file, wanted);
}

function readRuns(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => { try { return readJSON(path.join(directory, entry.name, 'run.json')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => `${a.started_at}${a.run_id}`.localeCompare(`${b.started_at}${b.run_id}`));
}

// What the verifier recorded for each declared check. A check with no record,
// or a verifier that never finished, is unknown: missing evidence, not a failure.
function readResults(directory, checks) {
  const recorded = new Map();
  const file = path.join(directory, 'check-results.json');
  if (existsSync(file)) {
    try {
      for (const entry of readJSON(file).results ?? []) {
        if (RESULTS.includes(entry?.result)) recorded.set(entry.id, entry);
      }
    } catch { /* an unreadable result file leaves every check unknown */ }
  }
  return checks.map((check) => ({
    id: check.id, intent: check.intent, role: check.role,
    result: recorded.get(check.id)?.result ?? 'unknown',
    evidence: recorded.get(check.id)?.evidence ?? 'No result was recorded for this check.',
  }));
}

function runCase(harbor, item, checks, target, options) {
  const logs = path.join(target, 'logs');
  mkdirSync(logs, { recursive: true });
  const [bin, ...rest] = harbor;
  const result = spawnSync(bin, [...rest, 'run', '-p', item.directory, '-a', options.agent, '-k', '1', '-n', '1',
    '-o', logs, '--job-name', 'harbor', '--quiet',
    ...(options.model ? ['-m', options.model] : []), ...(options.yes ? ['--yes'] : [])], {
    encoding: 'utf8', timeout: options.timeout * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    // GENESIS_EDD_REPO lets a package build its image from the application as it
    // is now; GENESIS_EDD_HARNESS lets it use the kit's shared environment files.
    env: { ...process.env, ...options.env, GENESIS_EDD_REPO: options.repo, GENESIS_EDD_HARNESS: options.harness,
      PYTHONPATH: [options.harness, ...(options.modules ?? []), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  writeFileSync(path.join(logs, 'harbor.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  const job = path.join(logs, 'harbor');
  const trial = existsSync(job) ? readdirSync(job, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(job, entry.name, 'result.json')))
    .map((entry) => path.join(job, entry.name))[0] : undefined;
  let execution = { status: 'completed' };
  if (!trial) {
    execution = { status: 'error', reason: result.error?.code === 'ETIMEDOUT' ? `Harbor did not finish within ${options.timeout} minutes.`
      : `Harbor produced no trial result (exit ${result.status}). See logs/harbor.log.` };
  } else {
    const outcome = readJSON(path.join(trial, 'result.json'));
    if (outcome.exception_info) {
      execution = { status: 'error', reason: `${outcome.exception_info.exception_type}: ${outcome.exception_info.exception_message}` };
    }
    const steps = path.join(trial, 'steps');
    const verifiers = existsSync(steps) ? readdirSync(steps).map((step) => path.join(steps, step, 'verifier')) : [path.join(trial, 'verifier')];
    const merged = verifiers.flatMap((directory) => {
      try { return readJSON(path.join(directory, 'check-results.json')).results ?? []; } catch { return []; }
    });
    if (merged.length) writeFileSync(path.join(target, 'check-results.json'), `${JSON.stringify({ results: merged }, null, 2)}\n`);
    const reward = verifiers.map((directory) => path.join(directory, 'reward.json')).filter(existsSync).pop();
    if (reward) copyFileSync(reward, path.join(target, 'reward.json'));
  }
  const results = readResults(target, checks);
  const count = (value) => results.filter((entry) => entry.role === 'gating' && entry.result === value).length;
  const warnings = [];
  if (existsSync(path.join(target, 'reward.json'))) {
    let reward;
    try { reward = readJSON(path.join(target, 'reward.json')).reward; } catch { /* reported below */ }
    const expected = count('pass') === results.filter((entry) => entry.role === 'gating').length ? 1 : 0;
    if (reward !== expected) {
      warnings.push(`${item.id}: the verifier wrote reward ${reward}, but its gating results give ${expected}. Check that tests/test.sh uses gate and note as checks.json declares.`);
    }
  }
  return { id: item.id, execution, results, warnings,
    summary: { id: item.id, execution, gating: { pass: count('pass'), fail: count('fail'), unknown: count('unknown') } } };
}

function expectations(file, cases) {
  if (!file) return [];
  const declared = JSON.parse(readFileSync(file, 'utf8'));
  const known = new Set(cases.flatMap((item) => item.checks.map((check) => `${item.id}\n${check.id}`)));
  if (!Array.isArray(declared) || declared.some((entry) => !known.has(`${entry?.case}\n${entry?.check}`)
    || !['pass', 'fail', 'any'].includes(entry.expected) || typeof entry.reason !== 'string' || !entry.reason.trim())) {
    throw new Error('--expect needs a JSON array of {case, check, expected (pass, fail or any), reason} naming declared checks.');
  }
  return declared.map(({ case: id, check, expected, reason }) => ({ case: id, check, expected, reason: reason.trim() }));
}

// The baseline recorded for the current Spec export, if any. Read-only.
export function recordedBaseline(repo, name, spec) {
  return readRuns(path.join(eddDirectory(repo, name), 'runs'))
    .filter((run) => run.spec_snapshot?.sha256 === spec && run.side === 'base').pop() ?? null;
}

// Proves each finished package's verifier before any real run: every fixture
// script takes the agent's place, then the verifier runs through Harbor exactly
// as it will in a run. A package is ready only while this record matches it.
export function checkEval(repo, name, options = {}) {
  const evals = validateEval(repo, name);
  const blocking = evals.gaps.filter((gap) => gap.code !== 'integration_pending');
  if (blocking.length) throw blocked(`Eval packages are not ready: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking);
  if (options.case && !evals.cases.some((item) => item.id === options.case)) throw new Error(`No package named ${options.case}.`);
  const root = eddDirectory(repo, name);
  const chosen = evals.cases.filter((item) => !options.case || item.id === options.case);
  const finished = chosen.filter((item) => item.integration.missing.every((entry) => entry === 'check'));
  const skipped = chosen.filter((item) => !finished.includes(item)).map((item) => ({ case: item.id, missing: item.integration.missing, detail: item.integration.detail }));
  if (finished.length) {
    const tools = runTools();
    if (tools.gaps.length) throw blocked(tools.gaps.map((gap) => gap.message).join(' '), repo, name, tools.gaps);
    ignoreRecords(repo);
  }
  const cases = finished.map((item) => {
    const directory = path.join(root, 'evals', item.id);
    const declared = readJSON(path.join(directory, 'tests/checks.json'));
    const target = path.join(root, 'checks', item.id);
    rmSync(target, { recursive: true, force: true });
    const fixtures = declared.fixtures.map((fixture) => {
      const outcome = runCase(harborCommand(), { id: item.id, directory }, declared.checks, path.join(target, fixture.name), {
        agent: 'genesis_fixture:FixtureAgent', yes: options.yes === true, timeout: options.timeout ?? 30,
        harness: kitDirectory(repo), repo, modules: [path.join(ROOT, 'src/harbor')],
        env: { GENESIS_EDD_FIXTURE: path.join(directory, 'tests/fixtures', `${fixture.name}.sh`) } });
      const got = Object.fromEntries(outcome.results.map((entry) => [entry.id, entry.result]));
      return { name: fixture.name, expect: fixture.expect, got, execution: outcome.execution,
        ok: outcome.execution.status === 'completed' && Object.entries(fixture.expect).every(([id, result]) => got[id] === result) };
    });
    const summary = { schema_version: '1.0', case: item.id, checked_at: new Date().toISOString(), task_digest: item.task_digest,
      passed: fixtures.every((fixture) => fixture.ok), fixtures };
    writeJSON(path.join(target, 'check.json'), summary);
    return summary;
  });
  const passed = cases.length > 0 && cases.every((item) => item.passed);
  return {
    change: name, passed, cases, skipped,
    next: !cases.length ? 'No package is finished enough to check. `eval validate` lists what each one still needs.'
      : passed ? 'Every checked verifier told its fixtures apart. Those packages are ready; record the baseline next.'
        : 'A fixture did not get the result it expects. Read checks/<case>/<fixture>/logs, then fix the verifier, the environment or the fixture; do not change an expectation to make it pass.',
  };
}

// One run of the ready packages against the code as it is now. A base run is
// taken before the change; every later head run is compared with that fixed
// base. Results are written once and never overwritten.
export function startRun(repo, name, options = {}) {
  const side = options.baseline ? 'base' : 'head';
  if (options.unavailable !== undefined && (side !== 'base' || !UNAVAILABLE.includes(options.unavailable))) {
    throw new Error(`--unavailable belongs to --baseline and must be one of ${UNAVAILABLE.join(', ')}.`);
  }
  if (options.expect && (side !== 'base' || options.unavailable)) throw new Error('--expect belongs to a baseline that actually runs.');
  const evals = validateEval(repo, name);
  const blocking = evals.gaps.filter((gap) => gap.code !== 'integration_pending');
  if (blocking.length) throw blocked(`Eval packages are not ready: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking);
  const root = eddDirectory(repo, name);
  const runs = path.join(root, 'runs');
  const spec = { id: name, sha256: evals.spec };
  const earlier = readRuns(runs).filter((run) => run.spec_snapshot?.sha256 === spec.sha256);
  const base = earlier.filter((run) => run.side === 'base').pop() ?? null;
  if (side === 'head' && !base) {
    throw blocked('No baseline is recorded for this Spec.', repo, name, [{ code: 'baseline_missing', kind: 'artifact', owner: 'agent', route: 'run-eval',
      message: 'Record the baseline before changing code: `run start --baseline`, or `--baseline --unavailable no_implementation` when nothing can run yet. A head run is never promoted to a baseline.' }]);
  }
  const cases = evals.cases.map((item) => ({ ...item, directory: path.join(root, 'evals', item.id),
    ...readJSON(path.join(root, 'evals', item.id, 'tests/checks.json')) }));
  const ready = cases.filter((item) => item.integration.state === 'ready');
  const skipped = cases.filter((item) => item.integration.state !== 'ready')
    .map((item) => ({ case: item.id, reason: 'awaiting_integration', missing: item.integration.missing, detail: item.integration.detail }));
  const declared = expectations(options.expect, cases);
  const harnessDirectory = kitDirectory(repo);
  let harness = {};
  try { harness = readJSON(path.join(harnessDirectory, 'harness.json')); } catch { /* optional */ }
  const agent = options.agent ?? harness.agent;
  const model = options.model ?? harness.model;
  const executes = !options.unavailable && ready.length > 0;
  let tools = { harbor: null };
  if (executes) {
    if (typeof agent !== 'string' || !agent) {
      throw blocked('No agent adapter is configured.', repo, name, [{ code: 'harness_missing', kind: 'artifact', owner: 'agent', route: 'write-eval',
        message: 'Name the evaluated agent for Harbor: pass --agent, or write .genesis/edd/harness/harness.json with {"agent": "module:Class"}.' }]);
    }
    tools = runTools();
    if (tools.gaps.length) throw blocked(tools.gaps.map((gap) => gap.message).join(' '), repo, name, tools.gaps);
  }
  const started = new Date();
  const runId = `${started.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(2).toString('hex')}`;
  const directory = path.join(runs, runId);
  mkdirSync(directory, { recursive: true });
  ignoreRecords(repo);
  const code = codeSnapshot(repo);
  const warnings = [...evals.warnings];
  const outcomes = executes ? ready.map((item) => runCase(harborCommand(), item, item.checks, path.join(directory, item.id),
    { agent, model, yes: options.yes === true, timeout: options.timeout ?? 30, harness: harnessDirectory, repo })) : [];
  warnings.push(...outcomes.flatMap((outcome) => outcome.warnings));
  const status = options.unavailable ? 'not_run' : !executes ? 'blocked'
    : outcomes.every((outcome) => outcome.execution.status === 'completed') ? 'completed' : 'error';
  const digests = Object.fromEntries(cases.map((item) => [item.id, item.task_digest]));
  const record = {
    schema_version: '1.0', run_id: runId, side, started_at: started.toISOString(), finished_at: new Date().toISOString(),
    execution_status: status, verdict: null,
    code_version: code.version, spec_snapshot: spec,
    is_baseline: side === 'base' && status === 'completed',
    baseline: side === 'head' && base.is_baseline ? base.run_id : null,
    baseline_unavailable_reason: null,
    code_snapshot: code.snapshot, task_digest: digests,
    environment_ref: { harbor: tools.harbor, agent: executes ? agent : null, model: executes ? model ?? null : null, attempts: 1,
      dependencies: Object.fromEntries(ready.map((item) => [item.id, item.dependencies])) },
    map_ref: evals.map ?? null,
    cases: outcomes.map((outcome) => outcome.summary), skipped, warnings,
  };
  let comparison = null;
  if (side === 'base') {
    record.baseline_unavailable_reason = options.unavailable ?? (status === 'completed' ? null : 'execution_blocked');
    record.baseline_expectations = outcomes.flatMap((outcome) => outcome.results.map((entry) => declared
      .find((item) => item.case === outcome.id && item.check === entry.id)
      ?? { case: outcome.id, check: entry.id, expected: 'any', reason: 'No expectation was declared before the baseline ran.' }));
    record.baseline_mismatch = outcomes.flatMap((outcome) => outcome.results.flatMap((entry) => {
      const expected = declared.find((item) => item.case === outcome.id && item.check === entry.id)?.expected ?? 'any';
      return expected !== 'any' && entry.result !== 'unknown' && entry.result !== expected
        ? [{ case: outcome.id, check: entry.id, expected, got: entry.result }] : [];
    }));
    if (earlier.some((run) => run.side === 'base' && run.code_snapshot?.digest !== code.snapshot.digest)) {
      warnings.push('An earlier baseline for this Spec ran on different code. A baseline must be the code before the change.');
    }
  } else {
    record.baseline_unavailable_reason = base.is_baseline ? null : base.baseline_unavailable_reason ?? 'execution_blocked';
    const results = outcomes.flatMap((outcome) => {
      const comparable = base.is_baseline && base.task_digest?.[outcome.id] === digests[outcome.id]
        && base.cases.some((item) => item.id === outcome.id);
      const before = comparable ? readResults(path.join(runs, base.run_id, outcome.id), cases.find((item) => item.id === outcome.id).checks) : null;
      return outcome.results.map((entry) => {
        const earlierResult = before?.find((item) => item.id === entry.id).result ?? null;
        const expected = base.baseline_expectations?.find((item) => item.case === outcome.id && item.check === entry.id)?.expected ?? 'any';
        const verdict = entry.result === 'fail' ? 'violated' : entry.result === 'unknown' ? 'unverified'
          : earlierResult === null ? 'head_only' : earlierResult === 'unknown' ? 'unverified'
            : expected !== 'any' && earlierResult !== expected ? 'base_mismatch' : 'holds';
        return { case: outcome.id, check: entry.id, intent: entry.intent, role: entry.role, before: earlierResult,
          ...(earlierResult === null ? { before_unavailable_reason: base.is_baseline ? 'incompatible_tasks' : record.baseline_unavailable_reason } : {}),
          after: entry.result, verdict, evidence: entry.evidence };
      });
    });
    const gating = results.filter((entry) => entry.role === 'gating');
    record.verdict = gating.some((entry) => entry.after === 'fail') ? 'fail'
      : status === 'completed' && !skipped.length && gating.length && gating.every((entry) => entry.after === 'pass') ? 'pass' : 'unverified';
    comparison = { schema_version: '1.0', run_id: runId, baseline: record.baseline, results };
    writeJSON(path.join(directory, 'compare.json'), comparison);
  }
  writeJSON(path.join(directory, 'run.json'), record);
  const tally = (key) => comparison?.results.filter((entry) => entry.verdict === key).length;
  return {
    run_id: runId, directory, side, execution_status: status, verdict: record.verdict,
    is_baseline: record.is_baseline, baseline: record.baseline, baseline_unavailable_reason: record.baseline_unavailable_reason,
    cases: record.cases, skipped, warnings,
    ...(side === 'base' ? { baseline_mismatch: record.baseline_mismatch } : {
      compare: Object.fromEntries(['holds', 'violated', 'base_mismatch', 'head_only', 'unverified'].map((key) => [key, tally(key)])) }),
    next: !['completed', 'not_run'].includes(status)
      ? 'Execution did not complete. Read cases[].execution.reason and each case\'s logs/harbor.log, fix the cause, then run the same command again.'
      : side === 'base'
        ? record.baseline_mismatch?.length
          ? 'The baseline did not behave as declared (baseline_mismatch). Before changing code, find out why: this is not the code before the change, the expectation is wrong, or the check cannot tell the two apart. Then run the baseline again.'
          : 'Change the code, then run `run start` again; later runs are compared with this baseline.'
        : record.verdict !== 'pass' ? 'Read compare.json and each case\'s logs/ before changing anything; classify the cause first.'
          : tally('base_mismatch') || tally('head_only')
            ? 'Every gating check passes. The base_mismatch and head_only checks have no usable baseline result, so they do not show that this change made the difference. Report them with the comparison; the user decides whether to accept.'
            : 'Acceptance is met. Report the per-check comparison; the user decides whether to accept.',
  };
}
