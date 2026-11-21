import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, codeState, digest, isGenerated, localPath, readJSON, writeJSON } from './project.js';
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

// Identity of the code a run executes. The digest covers content only: the
// path, mode and Git object of every file the run sees, committed or not, so
// committing the same code keeps it. The commit and the changed files say
// where the code came from, and the patch beside a run restores it.
export function codeSnapshot(repo) {
  const { head, changed } = codeState(repo);
  if (changed === null) {
    return { version: 'uncommitted', snapshot: { commit: null, changed_files: null, digest: null, note: 'Not a Git repository; the executed code is not pinned.' } };
  }
  const files = Object.fromEntries(changed.map((file) => {
    try { return [file, digest(readFileSync(path.join(repo, file)))]; } catch { return [file, 'deleted']; }
  }));
  const content = contentDigest(repo, head, changed);
  return {
    version: head && !changed.length ? head : head || changed.length ? 'uncommitted' : 'empty',
    snapshot: { commit: head, changed_files: changed, file_digests: files, digest: content, ...(content ? { digest_of: 'content' } : {}) },
  };
}

// The commit's files with the changed paths as they are on disk, listed from a
// scratch index. --info-only hashes each file through the project's Git
// filters, as a commit of it would, without writing objects. Generated files,
// such as the evals and the Spec, are not code.
function contentDigest(repo, commit, changed) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  const git = (args, input) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, input, maxBuffer: 256 * 1024 * 1024 });
  try {
    if (git(['read-tree', ...(commit ? [commit] : ['--empty'])]).status !== 0) return null;
    // Git lists a repository inside the project with a trailing slash; the
    // index records it as a link to its commit.
    const paths = changed.map((file) => file.replace(/\/$/, ''));
    if (paths.length && git(['update-index', '--add', '--remove', '--info-only', '-z', '--stdin'], paths.join('\0')).status !== 0) return null;
    const listed = git(['ls-files', '--stage', '-z']);
    if (listed.status !== 0) return null;
    const entries = listed.stdout.split('\0').filter((entry) => entry && !isGenerated(entry.slice(entry.indexOf('\t') + 1)));
    return digest(entries.join('\0'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The content digest of a record's code, or null when it cannot be known.
// Records written before the digest left the commit out have one only when
// they had no uncommitted change: then their code is the commit's.
function codeIdentity(snapshot, repo) {
  if (!snapshot?.digest) return null;
  if (snapshot.digest_of === 'content') return snapshot.digest;
  return repo && snapshot.commit && Array.isArray(snapshot.changed_files) && !snapshot.changed_files.length
    ? contentDigest(repo, snapshot.commit, []) : null;
}

// Whether two records describe the same code: true, false, or null when one
// of them cannot tell. A refusal treats null as different; a hint says nothing.
export function sameCode(a, b, repo) {
  const first = codeIdentity(a, repo);
  const second = codeIdentity(b, repo);
  return first && second ? first === second : null;
}

// The starting code of a loop as loop.json keeps it.
export function startCode(commit, snapshot, repo, patch) {
  const identity = codeIdentity(snapshot, repo);
  return { commit, digest: identity, ...(identity ? { digest_of: 'content' } : {}), ...(patch ? { patch } : {}) };
}

// Git's diff output follows the user's configuration. A patch that has to
// apply anywhere is written with fixed options.
const PATCH_CONFIG = ['-c', 'core.quotepath=off', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false', '-c', 'color.ui=never'];

// Everything the commit does not hold, as a patch Git can apply on top of it.
// With the commit, it restores the exact code a run used, so nothing has to be
// committed for a run to be restorable. A scratch index holds the commit and
// then every changed path as it is on disk, so the patch is exactly their
// difference, whatever the real index says.
export function savePatch(repo, snapshot, file) {
  if (!snapshot.changed_files?.length) return null;
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  const git = (args, options = {}) => spawnSync('git', ['-C', repo, ...PATCH_CONFIG, ...args],
    { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024, ...options });
  try {
    if (git(['read-tree', ...(snapshot.commit ? [snapshot.commit] : ['--empty'])]).status !== 0) return null;
    const added = git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { input: snapshot.changed_files.join('\0') });
    if (added.status !== 0) return null;
    const base = snapshot.commit ?? git(['hash-object', '-t', 'tree', '/dev/null']).stdout.trim();
    const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--src-prefix=a/', '--dst-prefix=b/', base], { encoding: 'buffer' });
    if (diff.status !== 0 || !diff.stdout.length) return null;
    writeFileSync(file, diff.stdout);
    return path.basename(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Run and check records are evidence of this machine, not source.
export function ignoreRecords(repo) {
  const file = localPath(repo, '.genesis/edd/.gitignore');
  const wanted = '/*/runs/\n/*/checks/\n/*/loop.json\n/*/loop-start.patch\n__pycache__/\n';
  if (!existsSync(file) || readFileSync(file, 'utf8') !== wanted) writeFileSync(file, wanted);
}

export function readRuns(directory) {
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
    ...(recorded.get(check.id)?.flaky ? { flaky: true } : {}),
  }));
}

// Several attempts of one package are combined per check. A requirement must
// hold every time: one attempt with failing evidence is a failure, and any
// attempt without evidence leaves the check unknown.
function combine(checks, attempts) {
  return checks.map((check) => {
    const seen = attempts.map((results) => results.find((entry) => entry?.id === check.id));
    const values = seen.map((entry) => (RESULTS.includes(entry?.result) ? entry.result : 'unknown'));
    if (attempts.length === 1) return { id: check.id, result: values[0], evidence: seen[0]?.evidence ?? 'No result was recorded for this check.' };
    const count = (value) => values.filter((entry) => entry === value).length;
    const result = count('fail') ? 'fail' : count('unknown') ? 'unknown' : 'pass';
    const telling = seen[values.indexOf(result)]?.evidence ?? seen.find(Boolean)?.evidence ?? 'No result was recorded.';
    return { id: check.id, result, evidence: `${count('pass')} pass, ${count('fail')} fail, ${count('unknown')} unknown over ${attempts.length} attempts. ${telling}`,
      ...(new Set(values).size > 1 ? { flaky: true } : {}) };
  });
}

function runCase(harbor, item, checks, target, options) {
  const logs = path.join(target, 'logs');
  mkdirSync(logs, { recursive: true });
  const attempts = options.attempts ?? 1;
  const [bin, ...rest] = harbor;
  const result = spawnSync(bin, [...rest, 'run', '-p', item.directory, '-a', options.agent, '-k', String(attempts), '-n', '1',
    '-o', logs, '--job-name', 'harbor', '--quiet',
    ...(options.model ? ['-m', options.model] : []), ...(options.yes ? ['--yes'] : [])], {
    encoding: 'utf8', timeout: options.timeout * attempts * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    // GENESIS_EDD_REPO lets a package build its image from the application as it
    // is now; GENESIS_EDD_HARNESS lets it use the kit's shared environment files.
    env: { ...process.env, ...options.env, GENESIS_EDD_REPO: options.repo, GENESIS_EDD_HARNESS: options.harness,
      PYTHONPATH: [options.harness, ...(options.modules ?? []), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  writeFileSync(path.join(logs, 'harbor.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  const job = path.join(logs, 'harbor');
  const trials = existsSync(job) ? readdirSync(job, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(job, entry.name, 'result.json')))
    .map((entry) => path.join(job, entry.name)).sort() : [];
  let execution = { status: 'completed' };
  if (trials.length < attempts) {
    execution = { status: 'error', reason: result.error?.code === 'ETIMEDOUT' ? `Harbor did not finish within ${options.timeout * attempts} minutes.`
      : `Harbor produced ${trials.length} of ${attempts} trial results (exit ${result.status}). See logs/harbor.log.` };
  }
  const warnings = new Set();
  const recorded = trials.map((trial) => {
    const outcome = readJSON(path.join(trial, 'result.json'));
    if (outcome.exception_info && execution.status === 'completed') {
      execution = { status: 'error', reason: `${outcome.exception_info.exception_type}: ${outcome.exception_info.exception_message}` };
    }
    const steps = path.join(trial, 'steps');
    const verifiers = existsSync(steps) ? readdirSync(steps).map((step) => path.join(steps, step, 'verifier')) : [path.join(trial, 'verifier')];
    const results = verifiers.flatMap((directory) => {
      try { return readJSON(path.join(directory, 'check-results.json')).results ?? []; } catch { return []; }
    });
    const reward = verifiers.map((directory) => path.join(directory, 'reward.json')).filter(existsSync).pop();
    if (reward) {
      let value;
      try { value = readJSON(reward).reward; } catch { /* reported below */ }
      const gating = checks.filter((check) => check.role === 'gating');
      const expected = gating.every((check) => results.find((entry) => entry?.id === check.id)?.result === 'pass') ? 1 : 0;
      if (value !== expected) {
        warnings.add(`${item.id}: the verifier wrote reward ${value}, but its gating results give ${expected}. Check that tests/test.sh uses gate and note as checks.json declares.`);
      }
    }
    return results;
  });
  // An attempt Harbor left no trial for is an attempt without evidence.
  while (recorded.length < attempts) recorded.push([]);
  if (recorded.some((results) => results.length)) {
    const combined = combine(checks, recorded);
    writeJSON(path.join(target, 'check-results.json'), { results: combined });
    const gating = checks.filter((check) => check.role === 'gating');
    writeJSON(path.join(target, 'reward.json'), { reward: gating.every((check) => combined.find((entry) => entry.id === check.id).result === 'pass') ? 1 : 0 });
  }
  const results = readResults(target, checks);
  const count = (value) => results.filter((entry) => entry.role === 'gating' && entry.result === value).length;
  const flaky = results.filter((entry) => entry.flaky).map((entry) => entry.id);
  if (flaky.length) warnings.add(`${item.id}: ${flaky.join(', ')} gave different results across attempts.`);
  return { id: item.id, execution, results, warnings: [...warnings],
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

// The baseline recorded for the current Spec export, if any. A baseline attempt
// that could not execute does not count: record the baseline again. Read-only.
export function recordedBaseline(repo, name, spec) {
  const base = readRuns(path.join(eddDirectory(repo, name), 'runs'))
    .filter((run) => run.spec_snapshot?.sha256 === spec && run.side === 'base').pop() ?? null;
  return base && (base.is_baseline || base.execution_status === 'not_run') ? base : null;
}

// How to get back to the code a loop started from, for a message.
export function restoreHint(name, loop, pinned) {
  const start = loop.start_code ?? {};
  const head = start.commit ?? loop.base_commit;
  const commit = head ? `commit ${head}` : 'no commit';
  const patch = start.patch ? `.genesis/edd/${name}/${start.patch}`
    : pinned?.code_snapshot?.patch && sameCode(pinned.code_snapshot, start) ? `.genesis/edd/${name}/runs/${pinned.run_id}/code.patch` : null;
  return patch ? `${commit} plus \`git apply\` ${patch}` : commit;
}

// The run a loop pinned as its baseline, or the gap that says it is gone.
export function pinnedBase(repo, name, loop) {
  const run = readRuns(path.join(eddDirectory(repo, name), 'runs')).find((entry) => entry.run_id === loop.baseline && entry.side === 'base') ?? null;
  return { run, gap: run ? null : { code: 'loop_baseline_missing', kind: 'artifact', owner: 'agent', route: 'run-eval',
    message: `The loop for this Spec compares every run with ${loop.baseline}, which is no longer in runs/. Restore that run folder, or record a baseline on the loop's starting code (${restoreHint(name, loop, null)}) and run \`loop start --restart\`.` } };
}

// The implementation loop of this change, when it was started for this Spec.
// While it runs, its baseline is the one every head run is compared with.
export function activeLoop(repo, name, spec) {
  const file = path.join(eddDirectory(repo, name), 'loop.json');
  if (!spec || !existsSync(file)) return null;
  try {
    const loop = readJSON(file);
    return loop?.spec === spec ? loop : null;
  } catch { return null; }
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
  if (options.case?.length && side === 'base') throw new Error('--case belongs to a head run; a baseline runs every package.');
  const attempts = options.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('--attempts is a whole number of 1 or more.');
  const evals = validateEval(repo, name);
  const blocking = evals.gaps.filter((gap) => gap.code !== 'integration_pending');
  if (blocking.length) throw blocked(`Eval packages are not ready: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking);
  const root = eddDirectory(repo, name);
  const runs = path.join(root, 'runs');
  const spec = { id: name, sha256: evals.spec };
  const earlier = readRuns(runs).filter((run) => run.spec_snapshot?.sha256 === spec.sha256);
  const attempt = earlier.filter((run) => run.side === 'base').pop() ?? null;
  const loop = activeLoop(repo, name, spec.sha256);
  // A running loop pins its baseline: a later base run must not move the
  // reference every head run of that loop is compared with.
  const pinned = loop ? earlier.find((run) => run.run_id === loop.baseline && run.side === 'base') ?? null : null;
  const base = loop ? pinned
    : attempt && (attempt.is_baseline || attempt.execution_status === 'not_run') ? attempt : null;
  if (side === 'head' && loop && !pinned) {
    throw blocked(`The loop's baseline ${loop.baseline} is not in runs/.`, repo, name, [pinnedBase(repo, name, loop).gap]);
  }
  if (side === 'head' && !base) {
    throw blocked('No baseline is recorded for this Spec.', repo, name, [{ code: 'baseline_missing', kind: 'artifact', owner: 'agent', route: 'run-eval',
      message: `${attempt ? `The last baseline attempt, ${attempt.run_id}, did not run; fix the cause and record it again. ` : ''}Record the baseline before changing code: \`run start --baseline\`, or \`--baseline --unavailable no_implementation\` when nothing can run yet. A head run is never promoted to a baseline.` }]);
  }
  // Inside a loop the code before the change is known. Every base record,
  // one that runs or one that declares a baseline unavailable, describes that
  // code, never code the loop has already changed.
  if (side === 'base' && loop?.start_code?.digest && sameCode(codeSnapshot(repo).snapshot, loop.start_code, repo) !== true) {
    throw blocked('The code changed since the loop for this Spec started.', repo, name, [{ code: 'baseline_after_change', kind: 'artifact', owner: 'agent', route: 'run-eval',
      message: `A loop for this Spec started on ${restoreHint(name, loop, pinned)} and compares every run with ${loop.baseline}. A base record on other code would describe the change, not the code before it. To record the baseline again, keep your changes aside, restore that code, record it there, then return to your changes and run \`loop start --restart\`. Files added for the evals during the loop, such as .dockerignore, cannot join this Spec's baseline: the checks of a package that changed stay head_only.` }]);
  }
  const cases = evals.cases.map((item) => ({ ...item, directory: path.join(root, 'evals', item.id),
    ...readJSON(path.join(root, 'evals', item.id, 'tests/checks.json')) }));
  for (const id of options.case ?? []) if (!cases.some((item) => item.id === id)) throw new Error(`No package named ${id}.`);
  // A partial run is for a quick look during a change. It never passes.
  const chosen = (item) => !options.case?.length || options.case.includes(item.id);
  const ready = cases.filter((item) => item.integration.state === 'ready' && chosen(item));
  const skipped = cases.filter((item) => item.integration.state !== 'ready')
    .map((item) => ({ case: item.id, reason: 'awaiting_integration', missing: item.integration.missing, detail: item.integration.detail }))
    .concat(cases.filter((item) => item.integration.state === 'ready' && !chosen(item)).map((item) => ({ case: item.id, reason: 'not_selected' })));
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
  // Each run gets a folder of its own; two runs in the same second never share one.
  mkdirSync(runs, { recursive: true });
  let runId;
  let directory;
  for (let tries = 0; ; tries += 1) {
    runId = `${started.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(2).toString('hex')}`;
    directory = path.join(runs, runId);
    try { mkdirSync(directory); break; } catch (error) { if (error.code !== 'EEXIST' || tries > 50) throw error; }
  }
  ignoreRecords(repo);
  const code = codeSnapshot(repo);
  const patch = savePatch(repo, code.snapshot, path.join(directory, 'code.patch'));
  const warnings = [...evals.warnings];
  const outcomes = executes ? ready.map((item) => runCase(harborCommand(), item, item.checks, path.join(directory, item.id),
    { agent, model, yes: options.yes === true, timeout: options.timeout ?? 30, harness: harnessDirectory, repo, attempts })) : [];
  warnings.push(...outcomes.flatMap((outcome) => outcome.warnings));
  const status = options.unavailable ? 'not_run' : !executes ? 'blocked'
    : outcomes.every((outcome) => outcome.execution.status === 'completed') ? 'completed' : 'error';
  const digests = Object.fromEntries(cases.map((item) => [item.id, item.task_digest]));
  const record = {
    schema_version: '1.0', run_id: runId, side, scope: options.case?.length ? 'partial' : 'full',
    started_at: started.toISOString(), finished_at: new Date().toISOString(),
    execution_status: status, verdict: null,
    code_version: code.version, spec_snapshot: spec,
    is_baseline: side === 'base' && status === 'completed',
    baseline: side === 'head' && base.is_baseline ? base.run_id : null,
    // The base record a head run was compared with, also when it records an
    // unavailable baseline.
    base_run: side === 'head' ? base.run_id : null,
    baseline_unavailable_reason: null,
    code_snapshot: { ...code.snapshot, ...(patch ? { patch } : {}) }, task_digest: digests,
    environment_ref: { harbor: tools.harbor, agent: executes ? agent : null, model: executes ? model ?? null : null, attempts,
      dependencies: Object.fromEntries(ready.map((item) => [item.id, item.dependencies])) },
    map_ref: evals.map ?? null,
    cases: outcomes.map((outcome) => outcome.summary), skipped, warnings,
  };
  let comparison = null;
  if (side === 'base') {
    record.baseline_unavailable_reason = options.unavailable ?? (status === 'completed' ? null : 'execution_blocked');
    // Every declared check, including packages not connected yet: what the
    // change is expected to do is fixed before the code changes, whether or
    // not the package could run.
    record.baseline_expectations = options.unavailable ? [] : cases.flatMap((item) => item.checks.map((check) => declared
      .find((entry) => entry.case === item.id && entry.check === check.id)
      ?? { case: item.id, check: check.id, expected: 'any', reason: 'No expectation was declared before the baseline ran.' }));
    record.baseline_mismatch = outcomes.flatMap((outcome) => outcome.results.flatMap((entry) => {
      const expected = declared.find((item) => item.case === outcome.id && item.check === entry.id)?.expected ?? 'any';
      return expected !== 'any' && entry.result !== 'unknown' && entry.result !== expected
        ? [{ case: outcome.id, check: entry.id, expected, got: entry.result }] : [];
    }));
    if (earlier.some((run) => run.side === 'base' && run.is_baseline && sameCode(run.code_snapshot, code.snapshot, repo) === false)) {
      warnings.push('An earlier baseline for this Spec ran on different code. A baseline must be the code before the change.');
    }
    if (loop) warnings.push(`The loop for this Spec keeps comparing with ${loop.baseline} until \`loop start --restart\`.`);
  } else {
    record.baseline_unavailable_reason = base.is_baseline ? null : base.baseline_unavailable_reason ?? 'execution_blocked';
    const results = outcomes.flatMap((outcome) => {
      // A package that did not run in the baseline has no result to compare;
      // one that changed since has a result for a different package.
      const ranAtBase = base.is_baseline && (base.cases ?? []).some((item) => item.id === outcome.id);
      const comparable = ranAtBase && base.task_digest?.[outcome.id] === digests[outcome.id];
      const before = comparable ? readResults(path.join(runs, base.run_id, outcome.id), cases.find((item) => item.id === outcome.id).checks) : null;
      const reason = !base.is_baseline ? record.baseline_unavailable_reason : ranAtBase ? 'incompatible_tasks' : 'not_run_at_baseline';
      return outcome.results.map((entry) => {
        const earlierResult = before?.find((item) => item.id === entry.id).result ?? null;
        const expected = base.baseline_expectations?.find((item) => item.case === outcome.id && item.check === entry.id)?.expected ?? 'any';
        const verdict = entry.result === 'fail' ? 'violated' : entry.result === 'unknown' ? 'unverified'
          : earlierResult === null ? 'head_only' : earlierResult === 'unknown' ? 'unverified'
            : expected !== 'any' && earlierResult !== expected ? 'base_mismatch' : 'holds';
        return { case: outcome.id, check: entry.id, intent: entry.intent, role: entry.role, before: earlierResult,
          ...(earlierResult === null ? { before_unavailable_reason: reason } : {}),
          after: entry.result, verdict, evidence: entry.evidence, ...(entry.flaky ? { flaky: true } : {}) };
      });
    });
    const gating = results.filter((entry) => entry.role === 'gating');
    // A partial run never passes, even when it names every package.
    record.verdict = gating.some((entry) => entry.after === 'fail') ? 'fail'
      : record.scope === 'full' && status === 'completed' && !skipped.length && gating.length && gating.every((entry) => entry.after === 'pass') ? 'pass' : 'unverified';
    comparison = { schema_version: '1.0', run_id: runId, baseline: record.baseline, base_run: record.base_run, results };
    writeJSON(path.join(directory, 'compare.json'), comparison);
  }
  writeJSON(path.join(directory, 'run.json'), record);
  const tally = (key) => comparison?.results.filter((entry) => entry.verdict === key).length;
  return {
    run_id: runId, directory, side, scope: record.scope, execution_status: status, verdict: record.verdict,
    is_baseline: record.is_baseline, baseline: record.baseline, baseline_unavailable_reason: record.baseline_unavailable_reason,
    cases: record.cases, skipped, warnings,
    ...(side === 'base' ? { baseline_mismatch: record.baseline_mismatch } : {
      compare: Object.fromEntries(['holds', 'violated', 'base_mismatch', 'head_only', 'unverified'].map((key) => [key, tally(key)])) }),
    next: !['completed', 'not_run'].includes(status)
      ? 'Execution did not complete. Read cases[].execution.reason and each case\'s logs/harbor.log, fix the cause, then run the same command again.'
      : side === 'base'
        ? record.baseline_mismatch?.length
          ? 'The baseline did not behave as declared (baseline_mismatch). Before changing code, find out why: this is not the code before the change, the expectation is wrong, or the check cannot tell the two apart. Then run the baseline again.'
          : loop ? `The loop for this Spec still compares every run with ${loop.baseline}. \`loop start --restart\` starts it over with this baseline.`
            : 'Change the code, then run `run start` again; later runs are compared with this baseline.'
        : record.scope === 'partial' ? 'A partial run is a quick look and never counts as passing. Run every package before saying the change works.'
        : record.verdict !== 'pass' ? 'Read compare.json and each case\'s logs/ before changing anything; classify the cause first.'
          : tally('base_mismatch') || tally('head_only')
            ? 'Every gating check passes. The base_mismatch and head_only checks have no usable baseline result, so they do not show that this change made the difference. Report them with the comparison; the user decides whether to accept.'
            : 'Acceptance is met. Report the per-check comparison; the user decides whether to accept.',
  };
}
