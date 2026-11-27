import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, codeState, digest, isGenerated, localPath, readJSON, writeJSON } from './project.js';
import { checksConfirmation, confirmationById, confirmationOf, eddDirectory, evalFilesChanged, evalSnapshot, isLive, kitDirectory, thenKey, validateEval } from './eval.js';
// run.js and loop.js import each other: a head run inside a loop asks
// loopStatus whether the loop goes on and whether a full run is a screen run
// or the final run. The cycle is safe because neither module uses the other's
// exports while it loads; keep the top level of both free of such calls.
import { headRunGap, loopPhase, loopStatus } from './loop.js';

// Where the loop of loop.json stands (loopPhase), or null when its status
// cannot be read. For the wording of a message only.
const phaseOf = (repo, name) => {
  try { return loopPhase(loopStatus(repo, name)); } catch { return null; }
};

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
      message: `Harbor could not be run as \`${[bin, ...rest].join(' ')}\`${reason ? `: ${reason}.` : '.'} Install it with \`uv tool install harbor==0.27.0\`, or set GENESIS_EDD_HARBOR to its command.` });
  }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  if (!docker) {
    gaps.push({ code: 'docker_unavailable', kind: 'technical', owner: 'agent', route: 'run-eval',
      message: 'Docker is not running. Start it, or ask the user to; do not record this as a failing check.' });
  }
  return { harbor, docker, gaps };
}

// A refusal resumes at the stage of the command refused: run-eval, or
// write-eval for `eval check`, which proves the packages before any run.
function blocked(message, repo, name, gaps, stage = 'run-eval') {
  return Object.assign(new Error(message), {
    code: 'RUN_INPUT_BLOCKED', gaps,
    resume: { stage, change: name, command: ['workflow', 'check', stage, name, '--repo', repo] },
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

// The application code a commit holds, as a snapshot sameCode can compare.
export const commitCode = (repo, commit) => {
  const content = commit ? contentDigest(repo, commit, []) : null;
  return { commit, changed_files: [], digest: content, ...(content ? { digest_of: 'content' } : {}) };
};

// The content digest of a record's code, or null when it cannot be known.
// Records written before the digest left the commit out have one only when
// they had no uncommitted change: then their code is the commit's. A commit
// never changes, so its digest is worked out once per process.
const commitDigests = new Map();
export function codeIdentity(snapshot, repo) {
  if (!snapshot?.digest) return null;
  if (snapshot.digest_of === 'content') return snapshot.digest;
  if (!repo || !snapshot.commit || !Array.isArray(snapshot.changed_files) || snapshot.changed_files.length) return null;
  const key = `${path.resolve(repo)}\n${snapshot.commit}`;
  if (!commitDigests.has(key)) commitDigests.set(key, contentDigest(repo, snapshot.commit, []));
  return commitDigests.get(key);
}

// Whether two records describe the same code: true, false, or null when one
// of them cannot tell. A refusal treats null as different; a hint says nothing.
export function sameCode(a, b, repo) {
  const first = codeIdentity(a, repo);
  const second = codeIdentity(b, repo);
  return first && second ? first === second : null;
}

// The starting code of a loop as loop.json keeps it, with the application
// files its commit does not hold.
export function startCode(commit, snapshot, repo, patch) {
  const identity = codeIdentity(snapshot, repo);
  return { commit, digest: identity, ...(identity ? { digest_of: 'content' } : {}), ...(patch ? { patch } : {}),
    ...(snapshot?.changed_files?.length ? { uncommitted_files: snapshot.changed_files } : {}) };
}

// An acceptance belongs to the loop it was given in: the same Spec, and the
// same start. Records written before loops were named are matched by run.
export const acceptedIn = (record, loop, runs) => record?.spec?.sha256 === loop.spec
  && (record.loop_started_at ? record.loop_started_at === loop.started_at : runs.some((run) => run.run_id === record.run_id));

// The code an acceptance covers, as accepted.json keeps it, for when the
// accepted run's folder is gone. Records written before the digest named its
// kind compare by their commit when nothing was uncommitted.
export const acceptedSnapshot = (record) => ({ commit: record.commit ?? null, changed_files: record.uncommitted_files ?? null,
  digest: record.code_digest ?? null, ...(record.code_digest_of ? { digest_of: record.code_digest_of } : {}) });

// Every result a verifier recorded for one Spec export, one entry per run,
// package, attempt and check: base and head runs, full and partial, of every
// loop and outside one. Results of the same code, package, agent and model
// are counted together. A run is left out when its code or its packages
// changed while it ran, when it did not execute, or when its code cannot be
// known. Within a run, a pass and a fail count only from an attempt that
// completed: Harbor still grades a trial the agent did not finish, after a
// rate limit or a timeout, and such a failure is no result of the code.
// unknown never counts. A run recorded before attempts.json existed gives
// one combined result per package and check, from a package that completed.
// runs defaults to every record in runsDirectory.
// Each entry: { run, run_id, started_at, side, scope, code, case,
// task_digest, agent, model, attempt (null for a combined result), check,
// result }.
export function sameCodeResults(repo, runsDirectory, spec, runs = readRuns(runsDirectory)) {
  return runs.flatMap((run) => {
    if (run.spec_snapshot?.sha256 !== spec || run.code_changed_during_run === true || run.packages_changed_during_run === true
      || !['completed', 'error'].includes(run.execution_status)) return [];
    const code = codeIdentity(run.code_snapshot, repo);
    if (!code) return [];
    const agent = run.environment_ref?.agent ?? null;
    const model = run.environment_ref?.model ?? null;
    return (run.cases ?? []).flatMap((item) => {
      const folder = path.join(runsDirectory, run.run_id, item.id);
      const entry = (attempt, check, result) => ({ run, run_id: run.run_id, started_at: run.started_at, side: run.side, scope: run.scope ?? 'full', code,
        case: item.id, task_digest: run.task_digest?.[item.id] ?? null, agent, model, attempt, check, result });
      const counted = (result) => result === 'fail' || result === 'pass';
      if (existsSync(path.join(folder, 'attempts.json'))) {
        let attempts;
        try { attempts = readJSON(path.join(folder, 'attempts.json')).attempts; } catch { return []; }
        return (Array.isArray(attempts) ? attempts : []).filter((attempt) => attempt?.status === 'completed')
          .flatMap((attempt) => Object.entries(attempt.results ?? {}).filter(([, result]) => counted(result))
            .map(([check, result]) => entry(attempt.attempt ?? null, check, result)));
      }
      if (item.execution?.status !== 'completed') return [];
      let recorded;
      try { recorded = readJSON(path.join(folder, 'check-results.json')).results ?? []; } catch { return []; }
      return (Array.isArray(recorded) ? recorded : []).filter((result) => counted(result?.result)).map((result) => entry(null, result.id, result.result));
    });
  });
}

const checkKey = (id, check) => `${id}\n${check}`;

// The gating checks of a head run as its compare.json lists them, as
// `<case>\n<check>`: none when it has no comparison.
export function gatingOfRun(runsDirectory, run) {
  let results = [];
  try { results = readJSON(path.join(runsDirectory, run.run_id, 'compare.json')).results ?? []; } catch { /* no comparison */ }
  return new Set((Array.isArray(results) ? results : []).filter((entry) => entry?.role === 'gating').map((entry) => checkKey(entry.case, entry.check)));
}

// The checks that passed in one run and failed in another on the same code,
// package, agent and model. code is a content digest, digests the task digest
// of each package, checks a Set of `<case>\n<check>`. Each group: { case,
// check, agent, model, pass: [run_id], fail: [run_id], head: whether a head
// run is among them }, sorted by case, then check.
export function unstableChecks(results, { code, digests, checks }) {
  const groups = new Map();
  for (const entry of results) {
    if (entry.code !== code || entry.task_digest === null || entry.task_digest !== digests[entry.case] || !checks.has(checkKey(entry.case, entry.check))) continue;
    const key = JSON.stringify([entry.case, entry.check, entry.agent, entry.model]);
    if (!groups.has(key)) groups.set(key, { case: entry.case, check: entry.check, agent: entry.agent, model: entry.model, pass: [], fail: [], head: false });
    const group = groups.get(key);
    if (!group[entry.result].includes(entry.run_id)) group[entry.result].push(entry.run_id);
    if (entry.side === 'head') group.head = true;
  }
  return [...groups.values()].filter((group) => group.pass.length && group.fail.length)
    .sort((a, b) => a.case.localeCompare(b.case) || a.check.localeCompare(b.check));
}

// The failures, in runs other than run, of the checks named in checks (a Set
// of `<case>\n<check>`) on run's code, packages, agent and model.
export function failuresOf(results, run, checks, repo) {
  const code = codeIdentity(run?.code_snapshot, repo);
  if (!code) return [];
  const agent = run.environment_ref?.agent ?? null;
  const model = run.environment_ref?.model ?? null;
  return results.filter((entry) => entry.result === 'fail' && entry.run_id !== run.run_id && entry.code === code
    && entry.task_digest !== null && entry.task_digest === run.task_digest?.[entry.case]
    && entry.agent === agent && entry.model === model && checks.has(checkKey(entry.case, entry.check)));
}

// Whether the user's acceptance still covers its loop: the code now is the
// accepted run's, no full run of the loop after the acceptance fails in an
// attempt that completed, and no
// run of the accepted code and packages fails a gating check the user
// accepted after the accepted run started, whether that run was full or
// partial: a failure of the same code always counts. fullRuns are the loop's
// full head runs in order; results the pool of sameCodeResults. Returns null
// when the record belongs to no acceptance of this loop, otherwise { holds,
// run (the accepted run, or null when its folder is gone), keeps (sameCode of
// its code and now), failed (the latest of those failing runs, or null),
// failedSame (the ids of the runs of the accepted code that failed after it),
// earlier (the failures of the accepted code from before it) }. gatingOf
// gives the gating checks of a later run as `<case>\n<check>`, from its
// compare.json: a check made gating, or added, after the acceptance counts
// there too.
export function acceptanceHolds(record, loop, fullRuns, now, repo, results = [], gatingOf = null) {
  if (!record || !acceptedIn(record, loop, fullRuns)) return null;
  const run = fullRuns.find((entry) => entry.run_id === record.run_id) ?? null;
  const accepted = run?.code_snapshot ?? acceptedSnapshot(record);
  // Any full run counts once the user accepted.
  const at = Date.parse(record.accepted?.at);
  const later = (entry) => (Number.isFinite(at) ? Date.parse(entry.started_at) > at : Boolean(run));
  const after = fullRuns.filter((entry, index) => (!run || index > fullRuns.indexOf(run)) && later(entry));
  // A run of the accepted code counts from the start of the accepted run, so
  // one still running when the user accepted counts too. Without the run
  // folder, only the code can be compared.
  const code = codeIdentity(accepted, repo);
  const gating = new Set((record.checks ?? []).filter((entry) => entry.role === 'gating').map((entry) => checkKey(entry.case, entry.check)));
  const same = code ? results.filter((entry) => entry.result === 'fail' && entry.code === code && gating.has(checkKey(entry.case, entry.check))
    && (!run || (entry.task_digest !== null && entry.task_digest === run.task_digest?.[entry.case]
      && entry.agent === (run.environment_ref?.agent ?? null) && entry.model === (run.environment_ref?.model ?? null)))) : [];
  const failedSame = same.filter((entry) => (run ? entry.started_at > run.started_at : later(entry)));
  const earlier = same.filter((entry) => !failedSame.includes(entry));
  // A later run fails only through a failure of an attempt that completed: a
  // fail graded after the agent or the harness errored is no result of the
  // code. A run whose code cannot be known has no entry in results, so its
  // verdict counts when it completed.
  const failedValidly = (entry) => {
    if (entry.verdict !== 'fail') return false;
    if (!codeIdentity(entry.code_snapshot, repo)) return entry.execution_status === 'completed';
    const own = gatingOf?.(entry);
    const keys = own?.size ? own : gating;
    return results.some((item) => item.run_id === entry.run_id && item.result === 'fail' && (!keys.size || keys.has(checkKey(item.case, item.check))));
  };
  const failed = [...after.filter(failedValidly), ...failedSame.map((entry) => entry.run)]
    .sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1) ?? null;
  const keeps = sameCode(accepted, now, repo);
  return { holds: keeps !== false && !failed, run, keeps, failed, failedSame: [...new Set(failedSame.map((entry) => entry.run_id))], earlier };
}

// What a loop has spent of its budget: its full head runs so far, and the
// minutes since its clock started. The caller passes acceptedAt only while
// that acceptance covers the loop: a finished loop spends no more minutes.
export function budgetUsed(loop, fullRuns, acceptedAt) {
  const clock = loop.clock_started_at ?? loop.started_at;
  const stopped = Date.parse(acceptedAt);
  const used = { iterations: fullRuns.length,
    minutes: Math.max(0, Math.round(((Number.isFinite(stopped) ? stopped : Date.now()) - Date.parse(clock)) / 60_000)) };
  return { clock, used, exhausted: used.iterations >= loop.budget.iterations || used.minutes >= loop.budget.minutes };
}

// Git's diff output follows the user's configuration. A patch that has to
// apply anywhere is written with fixed options.
const PATCH_CONFIG = ['-c', 'core.quotepath=off', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false', '-c', 'color.ui=never'];

// Everything the commit does not hold, as a patch Git can apply on top of it.
// With the commit, it restores the exact code a run used, so nothing has to be
// committed for a run to be restorable. A scratch index holds the commit and
// then every changed path as it is on disk, so the patch is exactly their
// difference, whatever the real index says. The objects Git writes for them go
// to a scratch object directory that reads the project's own as an alternate,
// so nothing is written into .git, which may be read-only. The alternate is
// named in the scratch directory's info/alternates file, not in
// GIT_ALTERNATE_OBJECT_DIRECTORIES: Git splits that variable at each ':', also
// one inside a path, and a value the user set stays as it is.
// Returns { patch, error }: patch is the file name, or null when the commit
// holds all of the code; error says why a patch that was needed is missing.
export function savePatch(repo, snapshot, file) {
  if (!snapshot.changed_files?.length) return { patch: null, error: null };
  const failed = (step, result) => {
    const why = result.error?.code === 'ENOBUFS' ? 'the patch is larger than 256 MB'
      : (result.error?.message ?? String(result.stderr ?? '')).trim().split('\n').pop() || `exit ${result.status}`;
    return { patch: null, error: `git ${step} failed: ${why}` };
  };
  const objects = spawnSync('git', ['-C', repo, 'rev-parse', '--git-path', 'objects'], { encoding: 'utf8' });
  if (objects.status !== 0) return failed('rev-parse', objects);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_OBJECT_DIRECTORY: path.join(scratch, 'objects') };
  const git = (args, options = {}) => spawnSync('git', ['-C', repo, ...PATCH_CONFIG, ...args],
    { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024, ...options });
  try {
    mkdirSync(path.join(scratch, 'objects/info'), { recursive: true });
    writeFileSync(path.join(scratch, 'objects/info/alternates'), `${path.resolve(repo, objects.stdout.trim())}\n`);
    const read = git(['read-tree', ...(snapshot.commit ? [snapshot.commit] : ['--empty'])]);
    if (read.status !== 0) return failed('read-tree', read);
    const added = git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { input: snapshot.changed_files.join('\0') });
    if (added.status !== 0) return failed('add', added);
    const base = snapshot.commit ?? git(['hash-object', '-t', 'tree', '/dev/null']).stdout.trim();
    const diff = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--src-prefix=a/', '--dst-prefix=b/', base], { encoding: 'buffer' });
    if (diff.status !== 0) return failed('diff', diff);
    // Changed paths whose content is the commit's, such as a staged edit
    // undone on disk, need no patch.
    if (!diff.stdout.length) return { patch: null, error: null };
    writeFileSync(file, diff.stdout);
    return { patch: path.basename(file), error: null };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Run and check records are evidence of this machine, not source. Lines the
// user added to the file stay; only the missing ones are added.
export function ignoreRecords(repo) {
  const file = localPath(repo, '.genesis/edd/.gitignore');
  const wanted = ['/*/runs/', '/*/checks/', '/*/loop.json', '/*/loop-start.patch', '__pycache__/'];
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new Set(text.split('\n').map((line) => line.trim()));
  const missing = wanted.filter((line) => !present.has(line));
  if (missing.length) writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

export function readRuns(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => { try { return readJSON(path.join(directory, entry.name, 'run.json')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => `${a.started_at}${a.run_id}`.localeCompare(`${b.started_at}${b.run_id}`));
}

// Run folders with no readable run.json. A run writes it last, so these are
// runs that were interrupted, or one still running. readRuns leaves them out.
export function unfinishedRuns(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .filter((entry) => { try { readJSON(path.join(directory, entry.name, 'run.json')); return false; } catch { return true; } })
    .map((entry) => entry.name).sort();
}

export const unfinishedWarning = (names) => `Run folders without a readable run.json, left by a run that was interrupted or is still running: ${names.join(', ')}. They are not counted or compared. Delete them once their logs are no longer needed.`;

// No package can run. A head run is refused with this gap, as workflow check
// run-eval reports it.
// Inside a loop (inLoop) it names no unavailable baseline: the loop has its
// baseline already.
export const noRunnableCase = (inLoop = false) => ({ code: 'no_runnable_case', kind: 'artifact', owner: 'agent', route: 'write-eval',
  message: `No package is ready to run. \`eval validate\` lists what each one still needs. A connected package missing only \`review\` needs a reviewer's counterexamples first: run \`eval review\`, have the reviewer write them, and prove them with \`eval check\`, which proves a finished package${inLoop ? '.' : '; a project without an implementation records an unavailable baseline instead.'}` });

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
  // then is the THEN or AND line a check of checks.json 1.1 verifies.
  return checks.map((check) => ({
    id: check.id, intent: check.intent, ...(typeof check.then === 'string' ? { then: check.then } : {}), role: check.role,
    result: recorded.get(check.id)?.result ?? 'unknown',
    evidence: recorded.get(check.id)?.evidence ?? 'No result was recorded for this check.',
    ...(recorded.get(check.id)?.flaky ? { flaky: true } : {}),
  }));
}

// Several attempts of one package are combined per check. A requirement must
// hold every time: one attempt with failing evidence is a failure, and any
// attempt without evidence, such as one that did not complete, leaves the
// check unknown.
function combine(checks, attempts) {
  return checks.map((check) => {
    const seen = attempts.map((results) => results.find((entry) => entry?.id === check.id));
    const values = seen.map((entry) => (RESULTS.includes(entry?.result) ? entry.result : 'unknown'));
    if (attempts.length === 1) return { id: check.id, result: values[0], evidence: seen[0]?.evidence ?? 'No result was recorded for this check.' };
    const count = (value) => values.filter((entry) => entry === value).length;
    const result = count('fail') ? 'fail' : count('unknown') ? 'unknown' : 'pass';
    const telling = seen[values.indexOf(result)]?.evidence ?? seen.find(Boolean)?.evidence ?? 'No result was recorded.';
    // Flaky means it passed in some attempts and failed in others; an attempt
    // without evidence is missing evidence, not another result.
    return { id: check.id, result, evidence: `${count('pass')} pass, ${count('fail')} fail, ${count('unknown')} unknown over ${attempts.length} attempts. ${telling}`,
      ...(count('pass') && count('fail') ? { flaky: true } : {}) };
  });
}

// The evidence combine writes for several attempts begins with their counts.
const COMBINED = /^(\d+) pass, (\d+) fail, (\d+) unknown over (\d+) attempts\./;

// How often each check passed, failed and had no evidence in one package of a
// run: { [check]: { pass, fail, unknown } }. Read from <case>/attempts.json,
// where an attempt that did not complete counts as unknown, also when it was
// recorded with what its verifier graded; for a run recorded before it
// existed, from the counts in the combined evidence, or else the one result
// counted once per attempt.
export function readCounts(directory, checks, attempts = 1) {
  const zero = () => ({ pass: 0, fail: 0, unknown: 0 });
  const file = path.join(directory, 'attempts.json');
  if (existsSync(file)) {
    let recorded = null;
    try { recorded = readJSON(file).attempts; } catch { /* read as the combined result below */ }
    if (Array.isArray(recorded)) {
      return Object.fromEntries(checks.map((check) => {
        const counts = zero();
        for (const attempt of recorded) {
          const result = attempt?.status === 'completed' ? attempt.results?.[check.id] : 'unknown';
          counts[RESULTS.includes(result) ? result : 'unknown'] += 1;
        }
        return [check.id, counts];
      }));
    }
  }
  return Object.fromEntries(readResults(directory, checks).map((entry) => {
    const match = entry.evidence?.match(COMBINED);
    return [entry.id, match ? { pass: Number(match[1]), fail: Number(match[2]), unknown: Number(match[3]) } : { ...zero(), [entry.result]: attempts }];
  }));
}

// The run plan a record follows: the number of attempts each package with a
// live dependency runs, the rule that combines them, and the agent and model,
// fixed by the baseline. A record written before run plans ran every package
// the same number of times.
export function planOf(record) {
  if (!record) return null;
  const environment = record.environment_ref ?? {};
  return environment.run_plan ?? { attempts: environment.attempts ?? 1, pass_rule: 'all', agent: environment.agent ?? null,
    model: environment.model ?? null, source: 'legacy', uniform: true };
}

// Whether a package declares a live dependency: eval validate's summary says
// so as live, and a package read with its checks.json has its dependencies.
export const liveCase = (item) => item.live === true || isLive(item.dependencies);

// Which packages need the user's number of attempts before a baseline: every
// package that declares a live dependency and, while the evaluated agent runs
// with a model, every ready package that declares none.
export function planNeeds(cases, ready, model) {
  const live = cases.filter(liveCase).map((item) => item.id);
  const undeclared = model ? ready.filter((item) => !liveCase(item)).map((item) => item.id) : [];
  return { live, undeclared, needed: live.length > 0 || undeclared.length > 0 };
}

// The attempts_undecided gap of a baseline, or of a checks confirmation, that
// planNeeds says needs the user's number of attempts.
export const attemptsUndecided = (needs, model) => ({ code: 'attempts_undecided', kind: 'business', owner: 'user', route: 'run-eval',
  message: [
    ...(needs.live.length ? [`${declare(needs.live)} a live dependency, so ${needs.live.length === 1 ? 'its' : 'their'} results can differ from one attempt to the next.`] : []),
    ...(needs.undeclared.length ? [`The evaluated agent runs with model ${model}, but ${declare(needs.undeclared)} no live dependency.`] : []),
    'How many attempts each package with a live dependency runs, at the baseline and in the final run of a loop, is the user\'s decision, made before the baseline: pass --attempts N. Propose 5, or 3 when the budget is tight, with what a run costs and what N rules out; 1 is allowed, and an acceptance then says it rests on one attempt. Packages without a live dependency run once.',
    ...(needs.undeclared.length ? [`If a scenario of ${needs.undeclared.join(', ')} calls the model, declare it in that package's tests/checks.json dependencies with mode live in write-eval and prove it again with eval check before the baseline.`] : []),
  ].join(' ') });

// The ready packages that declare a live dependency while the base record's
// plan fixed no number of attempts. A loop on that base refuses every head run
// of them (attempts_undecided). A plan written before run plans runs every
// package its number of times, so it needs none.
export function undecidedLive(base, ready) {
  const plan = planOf(base);
  return plan && !plan.uniform && (plan.attempts ?? null) === null ? ready.filter(liveCase).map((item) => item.id) : [];
}

// The attempts one package makes in a run: the plan's number for a package
// with a live dependency, or for every package of a plan written before run
// plans, and one otherwise. A partial run makes one unless --attempts says,
// and a screen run always makes one.
export function attemptsFor(item, plan, { partial = false, attempts, role = null } = {}) {
  if (role === 'screen' || (partial && attempts === undefined)) return 1;
  const n = attempts ?? plan?.attempts ?? 1;
  return plan?.uniform || liveCase(item) ? n : 1;
}

// Whether a loop on this run plan needs a final run: only when the plan runs a
// package more than once, that is, when it fixes more than one attempt and a
// ready package declares a live dependency, or when a plan written before run
// plans runs every package more than once. Then every full run of an
// iteration is a screen run, with one attempt of each package, and only a
// final run, which follows the plan, can be accepted.
// A package counts as connected when it is ready, or waits only for
// `eval check`: that record lives in checks/, which Git ignores, and is no
// part of the package, so a missing or stale one never decides this.
export const finalsNeeded = (plan, cases) => (plan?.attempts ?? 1) > 1
  && (Boolean(plan.uniform) || cases.some((item) => connectedCase(item) && liveCase(item)));

// Whether a package is connected: ready, or ready but for its `eval check`
// record. A loop's packages and kit are fixed, so within a loop this is too.
export const connectedCase = (item) => item.integration?.state === 'ready'
  || (Array.isArray(item.integration?.missing) && item.integration.missing.length > 0 && item.integration.missing.every((entry) => entry === 'check'));

// What an adapter may report it used, by Harbor's names for them.
const USAGE_KEYS = ['cost_usd', 'n_input_tokens', 'n_cache_tokens', 'n_output_tokens'];
// Minutes kept to a tenth, and money to a millionth, so a record shows 1.5
// and 0.15, not 1.4999999999999998 and 0.15000000000000002.
const tenths = (value) => Math.round(value * 10) / 10;
const money = (value) => Number(value.toFixed(6));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const minutesBetween = (start, end) => {
  const span = Date.parse(end) - Date.parse(start);
  return Number.isFinite(span) && span >= 0 ? span / 60_000 : null;
};
const sumOf = (values, round = (value) => value) => {
  const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return known.length ? round(known.reduce((total, value) => total + value, 0)) : null;
};
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

// What attempts took and used: the minutes between each one's start and end,
// how many attempts there were and how many the adapter reported usage for,
// and the sums of what it reported. A sum is over the attempts that reported
// it, and null when none did: unknown, never 0. minutes is null when no
// attempt has both of its times.
export function usageOf(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const reporting = list.filter((attempt) => isObject(attempt?.usage) && USAGE_KEYS.some((key) => typeof attempt.usage[key] === 'number'));
  return {
    minutes: sumOf(list.map((attempt) => minutesBetween(attempt?.started_at, attempt?.finished_at)), tenths),
    attempts: list.length, reported: reporting.length,
    ...Object.fromEntries(USAGE_KEYS.map((key) => [key, sumOf(reporting.map((attempt) => attempt.usage[key]), key === 'cost_usd' ? money : undefined)])),
  };
}

const readAttempts = (file) => {
  try {
    const { attempts } = readJSON(file);
    return Array.isArray(attempts) ? attempts : null;
  } catch { return null; }
};

// What a run took and used: its run.json usage. A run recorded before runs
// kept one has its wall time, and the sums of the attempts.json files it has;
// a package without one counts its attempts with unknown time and usage.
export function runUsage(runsDirectory, run) {
  if (isObject(run?.usage)) return run.usage;
  const wall = minutesBetween(run?.started_at, run?.finished_at);
  const found = (run?.cases ?? []).map((item) => ({ item, attempts: readAttempts(path.join(runsDirectory, run.run_id, item.id, 'attempts.json')) }));
  const summed = usageOf(found.flatMap((entry) => entry.attempts ?? []));
  const unread = found.filter((entry) => !entry.attempts)
    .reduce((total, { item }) => total + (run.environment_ref?.attempts_by_case?.[item.id] ?? run.environment_ref?.attempts ?? 1), 0);
  return { minutes: wall === null ? null : tenths(wall), attempt_minutes: summed.minutes, attempts: summed.attempts + unread, reported: summed.reported,
    ...Object.fromEntries(USAGE_KEYS.map((key) => [key, summed[key]])) };
}

// Usage of several runs together: how many runs, their minutes, and the sums
// of their attempts and of what the adapter reported. A sum leaves out the
// runs that do not know it, and is null when none does.
export function usageOfRuns(runsDirectory, runs) {
  const usages = runs.map((run) => runUsage(runsDirectory, run));
  return { runs: runs.length, minutes: sumOf(usages.map((usage) => usage.minutes), tenths), attempts: sumOf(usages.map((usage) => usage.attempts)) ?? 0,
    reported: sumOf(usages.map((usage) => usage.reported)) ?? 0,
    ...Object.fromEntries(USAGE_KEYS.map((key) => [key, sumOf(usages.map((usage) => usage[key]), key === 'cost_usd' ? money : undefined)])) };
}

// Minutes and money for a message: "1.5", "$0.15".
export const shownMinutes = (value) => String(tenths(value));
export const shownCost = (value) => `$${value >= 0.01 || value === 0 ? value.toFixed(2) : String(Number(value.toPrecision(2)))}`;

// How long one attempt of each ready package takes, and what it costs, from
// earlier attempts: those of the baseline when it ran the package, else those
// of the package's last eval check, whose fixtures stand in for the evaluated
// agent and make no model call. From them, what a screen run (one attempt of
// each package) and a final or full run (the plan's attempts) take. Without
// attempt times for every ready package, the baseline's whole run is scaled
// as loop start did before attempts were timed. basis says which:
// baseline_attempts, eval_check (for at least one package; per_attempt names
// each package's), baseline_run, or null when there is nothing to go by.
// runs, a loop's head runs, come first when given: once every ready package
// has completed attempts in them, the estimate rests on those alone
// (loop_attempts). Read-only.
export function estimateRuns(repo, name, { base = null, plan = null, cases = [], runs = null } = {}) {
  const root = eddDirectory(repo, name);
  const ready = cases.filter((item) => item.integration?.state === 'ready');
  // The mean minutes and cost of the attempts that completed with their times.
  const perAttempt = (attempts) => {
    const completed = attempts.filter((attempt) => attempt?.status === 'completed');
    const timed = completed.map((attempt) => minutesBetween(attempt.started_at, attempt.finished_at)).filter((value) => value !== null);
    const costs = completed.map((attempt) => attempt.usage?.cost_usd).filter((value) => typeof value === 'number');
    return timed.length ? { minutes: mean(timed), cost_usd: costs.length ? mean(costs) : null } : null;
  };
  const checked = (id) => {
    let fixtures = [];
    try { fixtures = readJSON(path.join(root, 'checks', id, 'check.json')).fixtures ?? []; } catch { return []; }
    return (Array.isArray(fixtures) ? fixtures : []).flatMap((fixture) => (typeof fixture?.name === 'string'
      ? readAttempts(path.join(root, 'checks', id, fixture.name, 'attempts.json')) ?? [] : []));
  };
  const figures = Object.fromEntries(ready.map((item) => {
    const atBase = base?.is_baseline && (base.cases ?? []).some((entry) => entry.id === item.id)
      ? perAttempt(readAttempts(path.join(root, 'runs', base.run_id, item.id, 'attempts.json')) ?? []) : null;
    if (atBase) return [item.id, { ...atBase, basis: 'baseline_attempts' }];
    const atCheck = perAttempt(checked(item.id));
    return [item.id, atCheck ? { ...atCheck, basis: 'eval_check' } : null];
  }));
  // A run of count(item) attempts of each ready package. Its cost leaves out
  // the packages whose adapter reported none.
  const run = (count) => ({ minutes: tenths(ready.reduce((total, item) => total + figures[item.id].minutes * count(item), 0)),
    cost_usd: sumOf(ready.map((item) => (figures[item.id].cost_usd === null ? null : figures[item.id].cost_usd * count(item))), money) });
  const once = () => 1;
  const planned = (item) => attemptsFor(item, plan);
  // The loop's own attempts, when every ready package has some.
  const inLoop = runs ? Object.fromEntries(ready.map((item) => [item.id, perAttempt(runs.flatMap((entry) => (entry.cases ?? []).some((ran) => ran.id === item.id)
    ? readAttempts(path.join(root, 'runs', entry.run_id, item.id, 'attempts.json')) ?? [] : []))])) : null;
  if (inLoop && ready.length && ready.every((item) => inLoop[item.id])) {
    for (const item of ready) figures[item.id] = { ...inLoop[item.id], basis: 'loop_attempts' };
  }
  if (ready.length && ready.every((item) => figures[item.id])) {
    const basis = ready.every((item) => figures[item.id].basis === 'loop_attempts') ? 'loop_attempts'
      : ready.every((item) => figures[item.id].basis === 'baseline_attempts') ? 'baseline_attempts' : 'eval_check';
    const final = run(planned);
    return { basis,
      per_attempt: Object.fromEntries(ready.map((item) => {
        const { minutes, cost_usd: cost, basis: from } = figures[item.id];
        return [item.id, { minutes: tenths(minutes), cost_usd: cost === null ? null : money(cost), basis: from }];
      })),
      screen: run(once), final, full: final };
  }
  const took = base?.is_baseline ? minutesBetween(base.started_at, base.finished_at) : null;
  if (took) {
    // A screen run makes one attempt of each ready package: its share of the
    // baseline's attempts.
    const byCase = Object.values(base.environment_ref?.attempts_by_case ?? {});
    const made = byCase.length ? byCase.reduce((total, value) => total + value, 0) : (base.cases?.length ?? 0) * (base.environment_ref?.attempts ?? 1);
    const share = made > 0 ? ready.length / made : 1;
    const cost = runUsage(path.join(root, 'runs'), base).cost_usd;
    const whole = { minutes: tenths(took), cost_usd: cost };
    return { basis: 'baseline_run', baseline_minutes: tenths(took),
      screen: { minutes: tenths(took * share), cost_usd: cost === null ? null : money(cost * share) }, final: whole, full: whole };
  }
  const none = { minutes: null, cost_usd: null };
  return { basis: null, screen: none, final: none, full: none };
}

const times = (n) => `${n} attempt${n === 1 ? '' : 's'}`;
// A confirmed run plan, for a message: its attempts, agent and model.
export const confirmedPlan = (plan) => `${plan.attempts === null || plan.attempts === undefined ? 'no fixed number of attempts' : times(plan.attempts)}, agent ${plan.agent ?? 'from harness.json'}, model ${plan.model ?? 'none'}`;
// Package ids as the subject of a message: "a declares", "a, b declare".
export const declare = (ids) => `${ids.join(', ')} ${ids.length === 1 ? 'declares' : 'declare'}`;
const they = (ids) => (ids.length === 1 ? 'it' : 'they');

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
  // Each trial's result.json is read once. Attempts follow the order the
  // trials started in, or their names when a trial does not say.
  const trials = existsSync(job) ? readdirSync(job, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(job, entry.name, 'result.json')))
    .map((entry) => {
      const directory = path.join(job, entry.name);
      try { return { name: entry.name, directory, outcome: readJSON(path.join(directory, 'result.json')) }; } catch (error) {
        return { name: entry.name, directory, outcome: null, error };
      }
    }) : [];
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const started = (trial) => Date.parse(trial.outcome?.started_at);
  trials.sort(trials.every((trial) => Number.isFinite(started(trial))) ? (a, b) => started(a) - started(b) || byName(a, b) : byName);
  let execution = { status: 'completed' };
  // Stopped at the timeout, Harbor may still write a result for the trial it
  // was in, recording only that it was cancelled. The timeout is the cause.
  if (result.error?.code === 'ETIMEDOUT') {
    execution = { status: 'error', reason: `Harbor did not finish within ${options.timeout * attempts} minutes and was stopped. Raise --timeout, or find what hangs in logs/.` };
  } else if (trials.length < attempts) {
    execution = { status: 'error', reason: `Harbor produced ${trials.length} of ${attempts} trial results (exit ${result.status}). See logs/harbor.log.` };
  }
  const warnings = new Set();
  const unknown = () => Object.fromEntries(checks.map((check) => [check.id, 'unknown']));
  const recorded = [];
  const entries = trials.map((trial, index) => {
    const entry = { attempt: index + 1, trial: `logs/harbor/${trial.name}`, status: 'completed' };
    const { outcome } = trial;
    if (!outcome) {
      // A result Harbor did not finish writing is an attempt without evidence.
      const reason = `logs/harbor/${trial.name}/result.json cannot be read (${trial.error.message}). Harbor may have stopped while writing it; see logs/harbor.log.`;
      if (execution.status === 'completed') execution = { status: 'error', reason };
      recorded.push([]);
      return { ...entry, status: 'error', reason, results: unknown(), reward: null, started_at: null, finished_at: null };
    }
    if (outcome.exception_info) {
      entry.status = 'error';
      entry.reason = `${outcome.exception_info.exception_type}: ${outcome.exception_info.exception_message}`;
      if (execution.status === 'completed') execution = { status: 'error', reason: entry.reason };
    }
    const steps = path.join(trial.directory, 'steps');
    const verifiers = existsSync(steps) ? readdirSync(steps).map((step) => path.join(steps, step, 'verifier')) : [path.join(trial.directory, 'verifier')];
    const results = verifiers.flatMap((directory) => {
      try { return readJSON(path.join(directory, 'check-results.json')).results ?? []; } catch { return []; }
    });
    // Harbor still grades a trial whose agent or harness raised, as after a
    // rate limit. What its verifier recorded, pass or fail, is no result of
    // the code: every check of that attempt is unknown.
    const completed = entry.status === 'completed';
    recorded.push(completed ? results : results.map((found) => ({ ...found, result: 'unknown',
      evidence: `Attempt ${entry.attempt} did not complete (${entry.reason}), so what its verifier recorded${RESULTS.includes(found?.result) ? ` (${found.result})` : ''} is no result of the code. ${found?.evidence ?? ''}`.trim() })));
    const rewardFile = verifiers.map((directory) => path.join(directory, 'reward.json')).filter(existsSync).pop();
    let reward = null;
    if (rewardFile) {
      let value;
      try { value = readJSON(rewardFile).reward; } catch { /* reported below */ }
      reward = typeof value === 'number' ? value : null;
      const gating = checks.filter((check) => check.role === 'gating');
      const expected = gating.every((check) => results.find((found) => found?.id === check.id)?.result === 'pass') ? 1 : 0;
      if (value !== expected) {
        warnings.add(`${item.id}: the verifier wrote reward ${value}, but its gating results give ${expected}. Check that tests/test.sh uses gate and note as checks.json declares.`);
      }
    }
    // What the adapter reported it used, when it reported anything.
    const usage = Object.fromEntries(['n_input_tokens', 'n_cache_tokens', 'n_output_tokens', 'cost_usd']
      .filter((key) => outcome.agent_result?.[key] !== null && outcome.agent_result?.[key] !== undefined).map((key) => [key, outcome.agent_result[key]]));
    const graded = Object.fromEntries(checks.map((check) => {
      const value = results.find((found) => found?.id === check.id)?.result;
      return [check.id, RESULTS.includes(value) ? value : 'unknown'];
    }));
    // An attempt that did not complete keeps what its verifier recorded as
    // graded, for its logs; its results are unknown.
    return { ...entry, results: completed ? graded : unknown(), ...(!completed && results.length ? { graded } : {}),
      reward, started_at: outcome.started_at ?? null, finished_at: outcome.finished_at ?? null,
      ...(Object.keys(usage).length ? { usage } : {}) };
  });
  // An attempt Harbor left no trial for is an attempt without evidence.
  while (recorded.length < attempts) {
    recorded.push([]);
    entries.push({ attempt: entries.length + 1, trial: null, status: 'missing', reason: 'Harbor left no trial result for this attempt.',
      results: unknown(), reward: null, started_at: null, finished_at: null });
  }
  writeJSON(path.join(target, 'attempts.json'), { schema_version: '1.0', case: item.id, planned: attempts, attempts: entries });
  if (recorded.some((results) => results.length)) {
    const combined = combine(checks, recorded);
    writeJSON(path.join(target, 'check-results.json'), { results: combined });
    const gating = checks.filter((check) => check.role === 'gating');
    writeJSON(path.join(target, 'reward.json'), { reward: gating.every((check) => combined.find((entry) => entry.id === check.id).result === 'pass') ? 1 : 0 });
  }
  const results = readResults(target, checks);
  const count = (value) => results.filter((entry) => entry.role === 'gating' && entry.result === value).length;
  const flaky = results.filter((entry) => entry.flaky).map((entry) => entry.id);
  if (flaky.length) warnings.add(`${item.id}: ${flaky.join(', ')} passed in some attempts and failed in others.`);
  // Its minutes are those of its attempts.
  const usage = usageOf(entries);
  return { id: item.id, execution, results, counts: readCounts(target, checks, attempts), attempts: entries, warnings: [...warnings], usage,
    summary: { id: item.id, execution, gating: { pass: count('pass'), fail: count('fail'), unknown: count('unknown') }, usage } };
}

// Whether a package's gating checks failed in an attempt that completed: a
// failure of the code, not of an agent or harness that stopped.
const failedValidly = (outcome, checks) => {
  const gating = checks.filter((check) => check.role === 'gating').map((check) => check.id);
  return (outcome.attempts ?? []).some((attempt) => attempt.status === 'completed' && gating.some((id) => attempt.results?.[id] === 'fail'));
};

// When each file was last written, by its size, modification time and inode,
// or null for a file that is not there: a file written and put back keeps its
// content, not this.
const stampsOf = (directory, files) => Object.fromEntries(files.map((file) => {
  let stat = null;
  try { stat = statSync(path.join(directory, file), { bigint: true, throwIfNoEntry: false }) ?? null; } catch { /* unreadable: null */ }
  return [file, stat ? `${stat.size}:${stat.mtimeNs}:${stat.ino}` : null];
}));
const restamped = (before, directory) => {
  const after = stampsOf(directory, Object.keys(before));
  return Object.keys(before).filter((file) => before[file] !== after[file]);
};

// What a run executes, as it was at the run's start: the application code
// (snapshot), each eval package and the kit (evalStart). The function it
// returns reads them again, by content and by when each file was last
// written, and says what differs since the start: { code: true or false,
// packages: { id: [file] }, kit: [file] }. A package added or removed is
// named by a NUL and 'added' or 'removed'.
function watchRun(repo, name, snapshot, evalStart) {
  const root = eddDirectory(repo, name);
  const kit = kitDirectory(repo);
  const listed = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const tracked = listed.status === 0 ? listed.stdout.split('\0') : [];
  const codeFiles = [...new Set([...tracked, ...(snapshot.changed_files ?? [])])].filter((file) => file && !isGenerated(file));
  const code = stampsOf(repo, codeFiles);
  const packages = Object.fromEntries(Object.entries(evalStart.packages).map(([id, files]) => [id, stampsOf(path.join(root, 'evals', id), Object.keys(files))]));
  const kitFiles = stampsOf(kit, Object.keys(evalStart.kit));
  return () => {
    const now = evalSnapshot(repo, name);
    const changed = evalFilesChanged(evalStart, now);
    const byPackage = {};
    for (const id of new Set([...Object.keys(packages), ...Object.keys(changed.packages)])) {
      const content = changed.packages[id];
      const files = [...new Set([...(typeof content === 'string' ? [`\0${content}`] : content ?? []),
        ...(packages[id] && typeof content !== 'string' ? restamped(packages[id], path.join(root, 'evals', id)) : [])])].sort();
      if (files.length) byPackage[id] = files;
    }
    return {
      code: restamped(code, repo).length > 0 || sameCode(snapshot, codeSnapshot(repo).snapshot, repo) === false,
      packages: byPackage,
      kit: [...new Set([...changed.kit, ...restamped(kitFiles, kit)])].sort(),
    };
  };
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
    message: `The loop for this Spec compares every run with ${loop.baseline}, which is no longer in runs/, so the loop has ended (baseline_missing). Restore that run folder to go on with it, or record a baseline on the loop's start code (${restoreHint(name, loop, null)}) and, once the user agrees, start a new loop with \`loop start\`.` } };
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

// Whether a head run is one of a loop's: of its Spec export, from its start,
// and made while it was the loop of loop.json. Every head run records the
// loop it was made in (loop, null outside a loop), so a run made while
// loop.json was away is no run of any loop. A run recorded before runs named
// their loop is placed by its Spec and start time.
export const ofLoop = (run, loop) => run.side === 'head' && run.spec_snapshot?.sha256 === loop.spec && run.started_at >= loop.started_at
  && (run.loop === undefined || run.loop?.started_at === loop.started_at);

// Whether the user accepted a run of this loop: accepted.json belongs to it.
// Read-only.
export function loopAccepted(repo, name, loop) {
  const file = path.join(eddDirectory(repo, name), 'accepted.json');
  if (!loop || !existsSync(file)) return false;
  let record;
  try { record = readJSON(file); } catch { return false; }
  const runs = readRuns(path.join(eddDirectory(repo, name), 'runs')).filter((run) => ofLoop(run, loop) && (run.scope ?? 'full') === 'full');
  return acceptedIn(record, loop, runs);
}

// The loop the latest head run of this change was made in, as that run
// recorded it, for when loop.json is missing or cannot be read: runs/ keeps
// what every base record and new loop must hold to, the loop's start code and
// baseline. Its budget and the loops before it were only in loop.json. Null
// when no head run names a loop.
export function recordedLoop(repo, name) {
  const named = readRuns(path.join(eddDirectory(repo, name), 'runs')).filter((run) => run.side === 'head' && run.loop?.started_at && run.loop.start_code);
  const latest = named.sort((a, b) => a.loop.started_at.localeCompare(b.loop.started_at) || a.started_at.localeCompare(b.started_at)).at(-1);
  if (!latest) return null;
  const runs = named.filter((run) => run.loop.started_at === latest.loop.started_at).map((run) => run.run_id);
  return { change: name, started_at: latest.loop.started_at, spec: latest.spec_snapshot?.sha256 ?? null, baseline: latest.loop.baseline ?? latest.base_run ?? null,
    base_commit: latest.loop.start_code.commit ?? null, start_code: latest.loop.start_code, recovered_from: runs };
}

// What a message adds when the loop it names is known from its head runs
// only, as recordedLoop reads it: nothing otherwise.
export const recoveredText = (loop) => (loop?.recovered_from
  ? ` loop.json is missing or cannot be read, so this comes from the head runs of the loop that started at ${loop.started_at} (${loop.recovered_from.join(', ')}). Restore loop.json if you can: it alone keeps that loop's budget and the loops before it, and it is not in Git.` : '');

// The loop record a loop.json holds, or, when it is missing or cannot be
// read, the loop the head runs in runs/ name (recordedLoop). Null without
// either.
export function loopRecordOf(repo, name) {
  const file = path.join(eddDirectory(repo, name), 'loop.json');
  if (existsSync(file)) {
    try {
      const loop = readJSON(file);
      if (loop && typeof loop === 'object') return loop;
    } catch { /* read from runs/ below */ }
  }
  return recordedLoop(repo, name);
}

// The starting code a loop keeps, as loop.json records it. A loop.json
// written before it recorded one started where its baseline ran, when one
// ran; otherwise null.
export function loopStartCode(repo, name, loop) {
  if (!loop) return null;
  if (loop.start_code) return loop.start_code;
  const pinned = readRuns(path.join(eddDirectory(repo, name), 'runs')).find((run) => run.run_id === loop.baseline) ?? null;
  return pinned?.is_baseline ? startCode(loop.base_commit ?? null, pinned.code_snapshot, repo) : null;
}

// The start code every base record and every new loop of this change keeps:
// the start code of the loop in loop.json, whatever Spec export it ran for,
// until the user accepted that loop. A new loop copies it, so loop.json holds
// the start code of the change's first loop not yet accepted. Without a
// readable loop.json, the loop its head runs name keeps the pin. { loop,
// start }, or null once that loop is accepted or when no loop kept a start
// code.
export function pinnedStart(repo, name) {
  const loop = loopRecordOf(repo, name);
  if (!loop || loopAccepted(repo, name, loop)) return null;
  const start = loopStartCode(repo, name, loop);
  return start?.digest ? { loop, start } : null;
}

// Proves each finished package's verifier before any real run: every fixture
// script takes the agent's place, then the verifier runs through Harbor exactly
// as it will in a run. A package is ready only while this record matches it.
export function checkEval(repo, name, options = {}) {
  const evals = validateEval(repo, name);
  const blocking = evals.gaps.filter((gap) => gap.code !== 'integration_pending');
  if (blocking.length) throw blocked(`Eval packages are not ready: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking, 'write-eval');
  if (options.case && !evals.cases.some((item) => item.id === options.case)) throw new Error(`No package named ${options.case}.`);
  const root = eddDirectory(repo, name);
  const chosen = evals.cases.filter((item) => !options.case || item.id === options.case);
  // A package whose record still matches it is proved already. Naming it with
  // --case proves it again.
  const current = options.case ? [] : chosen.filter((item) => !item.integration.missing.length).map((item) => item.id);
  const finished = chosen.filter((item) => !current.includes(item.id) && item.integration.missing.every((entry) => entry === 'check'));
  const skipped = chosen.filter((item) => !finished.includes(item) && !current.includes(item.id))
    .map((item) => ({ case: item.id, missing: item.integration.missing, detail: item.integration.detail }));
  if (finished.length) {
    const tools = runTools();
    if (tools.gaps.length) throw blocked(tools.gaps.map((gap) => gap.message).join(' '), repo, name, tools.gaps, 'write-eval');
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
        ok: outcome.execution.status === 'completed' && Object.entries(fixture.expect).every(([id, result]) => got[id] === result), attempts: outcome.attempts };
    });
    // What the fixtures took together, from their attempts.
    const usage = usageOf(fixtures.flatMap((fixture) => fixture.attempts));
    const summary = { schema_version: '1.0', case: item.id, checked_at: new Date().toISOString(), task_digest: item.task_digest,
      passed: fixtures.every((fixture) => fixture.ok), fixtures: fixtures.map(({ attempts, ...fixture }) => fixture), usage };
    writeJSON(path.join(target, 'check.json'), summary);
    return summary;
  });
  const passed = (cases.length > 0 || current.length > 0) && cases.every((item) => item.passed);
  // Packages that wait only for the reviewer's counterexamples.
  const unreviewed = skipped.filter((item) => item.missing.length && item.missing.every((entry) => entry === 'review')).map((item) => item.case);
  const loop = evals.spec ? activeLoop(repo, name, evals.spec) : null;
  // Once the user confirmed the checks as they are, that step is done.
  const confirmations = evals.spec && !loop ? checksConfirmation(repo, name, evals.spec) : null;
  const confirmed = confirmations?.current ?? null;
  return {
    change: name, passed, cases, already_proved: current, skipped,
    next: !cases.length && current.length ? `Every finished package is proved already: ${current.join(', ')}. Name one with --case to prove it again.`
      : !cases.length ? `No package is finished enough to check. \`eval validate\` lists what each one still needs.${unreviewed.length
        ? ` ${unreviewed.join(', ')} ${unreviewed.length === 1 ? 'waits' : 'wait'} only for the reviewer's counterexamples: run \`eval review\` and give its reviewer_brief to a reviewer.` : ''}`
      : passed ? `Every checked verifier told its fixtures apart, so those packages are ready. ${loop
        ? '`loop status` says what comes next. A package changed during a loop ends it (packages_changed): `eval review`, the user\'s `eval confirm`, then a new loop once they agree.'
        : confirmed ? '`workflow check run-eval` says what comes next.' : confirmations?.latest
          ? '`workflow check run-eval` says what comes next: a package changed since the user confirmed the checks, so they confirm the revision before the baseline (`eval review`, `eval confirm --reason`).'
          : '`workflow check run-eval` says what comes next: the user confirms the checks before the baseline (`eval review`, `eval confirm`).'}`
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
  if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1)) throw new Error('--attempts is a whole number of 1 or more.');
  const evals = validateEval(repo, name);
  const blocking = evals.gaps.filter((gap) => gap.code !== 'integration_pending');
  if (blocking.length) throw blocked(`Eval packages are not ready: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking);
  const root = eddDirectory(repo, name);
  const runs = path.join(root, 'runs');
  const spec = { id: name, sha256: evals.spec };
  const earlier = readRuns(runs).filter((run) => run.spec_snapshot?.sha256 === spec.sha256);
  const attempt = earlier.filter((run) => run.side === 'base').pop() ?? null;
  const loop = activeLoop(repo, name, spec.sha256);
  // The run plan of a loop is fixed: run start reads it from the loop's checks
  // confirmation, and a baseline from the latest one. Plan flags are refused
  // before anything runs, equal values, partial runs and base records too.
  if (loop && ['attempts', 'agent', 'model'].some((key) => options[key] !== undefined)) {
    const phase = phaseOf(repo, name);
    const message = phase === 'ended'
      ? 'The loop for this Spec export has ended, and its run plan stays fixed until a new loop starts: a baseline reads the number of attempts, the agent and the model from the latest checks confirmation in confirmed.json, and the new loop runs that plan. Run without --attempts, --agent and --model. To change the plan, the user confirms another one with `eval confirm`.'
      : `${phase === 'done' ? 'The user accepted the loop for this Spec export, and its run plan stays fixed' : 'A loop runs for this Spec export, and its run plan is fixed'}: run start reads the number of attempts, the agent and the model from the loop's checks confirmation in confirmed.json, and a baseline reads them from the latest confirmation. Run without --attempts, --agent and --model. To change the plan, the user confirms another one with \`eval confirm\`${phase === 'done' ? '' : ', which ends this loop'}.`;
    throw blocked('The run plan of this loop is fixed.', repo, name, [{ code: 'run_plan_fixed', kind: 'artifact', owner: 'agent', route: 'run-eval', message }]);
  }
  // A head run of a loop that ended, that a stop holds for, or whose budget is
  // used up is refused before any folder, Docker or Harbor. Once the user
  // accepted the loop, head runs go on. The same status says whether a full
  // run is a screen run or the final run.
  const loopNow = side === 'head' && loop ? loopStatus(repo, name) : null;
  const refusal = loopNow ? headRunGap(loopNow) : null;
  if (refusal) throw blocked(refusal.message, repo, name, [refusal]);
  // A running loop pins its baseline: a later base run must not move the
  // reference every head run of that loop is compared with.
  const pinned = loop ? earlier.find((run) => run.run_id === loop.baseline && run.side === 'base') ?? null : null;
  const base = loop ? pinned
    : attempt && (attempt.is_baseline || attempt.execution_status === 'not_run') ? attempt : null;
  if (side === 'head' && !base) {
    // A completed attempt on code or packages that changed during it did run;
    // only that change keeps it from being a baseline.
    const why = !attempt ? ''
      : attempt.code_changed_during_run && attempt.execution_status === 'completed' ? `The last baseline attempt, ${attempt.run_id}, ran while the code changed, so it is not a baseline; record it again without editing the code during the run. `
        : attempt.packages_changed_during_run && attempt.execution_status === 'completed' ? `The last baseline attempt, ${attempt.run_id}, ran while the eval packages changed, so it is not a baseline; record it again without editing them during the run. `
          : `The last baseline attempt, ${attempt.run_id}, did not run; fix the cause and record it again. `;
    throw blocked('No baseline is recorded for this Spec.', repo, name, [{ code: 'baseline_missing', kind: 'artifact', owner: 'agent', route: 'run-eval',
      message: `${why}Record the baseline before changing code: \`run start --baseline\`, or \`--baseline --unavailable no_implementation\` when nothing can run yet. A head run is never promoted to a baseline.` }]);
  }
  // Until a loop of this change is accepted, the code before the change is
  // the start code of its first unaccepted loop, whatever Spec export it ran
  // for. Every base record, one that runs or one that declares a baseline
  // unavailable, describes that code, never code a loop has already changed.
  const pin = side === 'base' ? pinnedStart(repo, name) : null;
  if (pin && sameCode(codeSnapshot(repo).snapshot, pin.start, repo) !== true) {
    const before = readRuns(runs).find((run) => run.run_id === pin.loop.baseline) ?? null;
    throw blocked('The code changed since the change\'s first unaccepted loop started.', repo, name, [{ code: 'baseline_after_change', kind: 'artifact', owner: 'agent', route: 'run-eval',
      message: `Until a loop of this change is accepted, every base record goes on the start code of its first unaccepted loop, ${restoreHint(name, pin.loop, before)}. A base record on other code would describe the change, not the code before it. Set your changes aside, restore that code, record it there, then bring your changes back.${recoveredText(pin.loop)}` }]);
  }
  // Whether the loop of this Spec export has ended or stopped, for what a
  // base record says of it.
  const loopEnded = side === 'base' && loop ? phaseOf(repo, name) === 'ended' : false;
  const cases = evals.cases.map((item) => ({ ...item, directory: path.join(root, 'evals', item.id),
    ...readJSON(path.join(root, 'evals', item.id, 'tests/checks.json')) }));
  for (const id of options.case ?? []) if (!cases.some((item) => item.id === id)) throw new Error(`No package named ${id}.`);
  // A partial run is for a quick look during a change. It never passes.
  const chosen = (item) => !options.case?.length || options.case.includes(item.id);
  const ready = cases.filter((item) => item.integration.state === 'ready' && chosen(item));
  const skipped = cases.filter((item) => item.integration.state !== 'ready')
    .map((item) => ({ case: item.id, reason: 'awaiting_integration', missing: item.integration.missing, detail: item.integration.detail }))
    .concat(cases.filter((item) => item.integration.state === 'ready' && !chosen(item)).map((item) => ({ case: item.id, reason: 'not_selected' })));
  // A head run with nothing to run would only record that; it is refused
  // before a folder is written, so it never counts as a run of a loop.
  if (side === 'head' && !ready.length) {
    const waiting = skipped.filter((item) => item.reason === 'awaiting_integration').map((item) => `${item.case} (${item.detail.join('; ')})`);
    throw blocked(`No package is ready to run.${waiting.length ? ` Waiting: ${waiting.join(', ')}.` : ''}`, repo, name, [noRunnableCase(Boolean(loop))]);
  }
  // A finished package that waits only for `eval check` is skipped; a loop
  // starts only on a baseline that ran it.
  const unproved = side === 'base' && !options.unavailable ? skipped.filter((item) => item.reason === 'awaiting_integration' && item.missing?.length
    && item.missing.every((entry) => entry === 'check')).map((item) => item.case) : [];
  const declared = expectations(options.expect, cases);
  const harnessDirectory = kitDirectory(repo);
  let harness = {};
  try { harness = readJSON(path.join(harnessDirectory, 'harness.json')); } catch { /* optional */ }
  // The checks the user confirmed for this Spec export, when they are the
  // packages as they are now. Its run plan is what a baseline runs.
  const confirmation = checksConfirmation(repo, name, spec.sha256);
  // Inside a loop, a head run takes the agent and the model of the loop's
  // checks confirmation, or, for a loop that kept none, of its baseline's plan.
  const loopEntry = side === 'head' && loop?.checks_confirmation && !confirmation.gap ? confirmationById(confirmation.entries, loop.checks_confirmation.id) : null;
  const fixed = side === 'head' && loop ? loopEntry?.run_plan ?? planOf(base) : null;
  let agent = fixed ? fixed.agent ?? harness.agent ?? undefined : options.agent ?? harness.agent ?? undefined;
  let model = fixed ? fixed.model ?? undefined : options.model ?? harness.model ?? undefined;
  const executes = !options.unavailable && ready.length > 0;
  const partial = Boolean(options.case?.length);
  const planWarnings = [];
  const list = (ids) => ids.join(', ');
  let plan;
  // Inside a loop that needs a final run, a full run is a screen run or the
  // final run of the screen run named by finalOf. Otherwise null.
  let role = null;
  let finalOf = null;
  let passedFinal = null;
  // A confirmation of a Spec export confirmed before is a revision, with --reason.
  const revisionFlag = confirmation.latest ? ' --reason' : '';
  const confirmed = side === 'base' && (executes || options.unavailable) ? confirmation.current : null;
  if (side === 'base' && confirmed) {
    const confirmedRun = confirmed.run_plan ?? {};
    // A model the plan leaves out counts as a value; an agent it leaves out
    // comes from harness.json.
    const differs = [
      ...(options.attempts !== undefined && options.attempts !== (confirmedRun.attempts ?? null) ? [times(options.attempts)] : []),
      ...(options.agent !== undefined && (confirmedRun.agent ?? null) !== null && options.agent !== confirmedRun.agent ? [`agent ${options.agent}`] : []),
      ...(options.model !== undefined && options.model !== (confirmedRun.model ?? null) ? [`model ${options.model}`] : []),
    ];
    // This export is confirmed, so a new confirmation of it is a revision.
    if (differs.length) {
      throw blocked('This baseline would use another run plan than the user confirmed.', repo, name, [{ code: 'run_plan_differs', kind: 'artifact', owner: 'agent', route: 'run-eval',
        message: `The user confirmed ${confirmedPlan(confirmedRun)} for this Spec export (confirmed.json). This baseline would use ${differs.join(', ')}. Run without --attempts, --agent and --model to use the confirmed plan; to change it, show the user and record a new \`eval confirm --reason <why>\` with the new flags first.` }]);
    }
    // The confirmed model runs as the user confirmed it, none included, so
    // the record never cites a confirmation for another model. An agent the
    // plan leaves out comes from harness.json.
    agent = options.agent ?? confirmedRun.agent ?? harness.agent ?? undefined;
    model = options.model ?? ('model' in confirmedRun ? confirmedRun.model : harness.model) ?? undefined;
    plan = { attempts: options.attempts ?? confirmedRun.attempts ?? null, pass_rule: 'all', agent: agent ?? null, model: model ?? null,
      source: 'confirmation', confirmation: confirmed.id };
  } else if (side === 'base') {
    // Once the confirmation no longer covers the packages as they are, as
    // after a fix to a package, the plan the user last confirmed for this
    // Spec export still stands where no flag gives another, with the agent and
    // the model of harness.json once it changed since, as eval confirm takes
    // them. The baseline records it as its own, never as a confirmation it
    // does not cover.
    const latest = confirmation.latest;
    let decided = {};
    const from = 'the plan the user last confirmed for this Spec export';
    if (latest?.run_plan) {
      const kitKept = (latest.kit?.files?.['harness.json'] ?? null) === (confirmation.snapshot.kit['harness.json'] ?? null);
      decided = kitKept ? latest.run_plan : { attempts: latest.run_plan.attempts ?? null };
    }
    // A model the plan names counts as a value, none included; an agent it
    // leaves out comes from harness.json.
    agent = options.agent ?? decided.agent ?? harness.agent ?? undefined;
    model = options.model ?? ('model' in decided ? decided.model : harness.model) ?? undefined;
    // The number of attempts of each package with a live dependency is the
    // user's, fixed before the baseline and kept by every later run.
    const needs = planNeeds(cases, ready, model);
    const given = !needs.needed || options.attempts !== undefined ? null : decided.attempts ?? null;
    const known = Number.isInteger(given) ? given : null;
    if (needs.needed && options.attempts === undefined && known === null) {
      throw blocked('The number of attempts is not decided.', repo, name, [attemptsUndecided(needs, model)]);
    }
    plan = { attempts: options.attempts ?? known, pass_rule: 'all', agent: agent ?? null, model: model ?? null, source: 'baseline' };
    // What it took from that plan, said when it is more than harness.json
    // gives; a value harness.json gave is not named.
    const taken = [...(known !== null ? [{ text: `${times(known)} of each package with a live dependency` }] : []),
      ...(options.agent === undefined && (decided.agent ?? null) !== null ? [{ text: `agent ${decided.agent}`, beyond: decided.agent !== (harness.agent ?? null) }] : []),
      ...(options.model === undefined && 'model' in decided ? [{ text: `model ${decided.model ?? 'none'}`, beyond: (decided.model ?? null) !== (harness.model ?? null) }] : [])];
    if (known !== null || taken.some((entry) => entry.beyond)) {
      const and = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);
      planWarnings.push(`This baseline takes ${and(taken.map((entry) => entry.text))} from ${from}. The user's checks confirmation does not cover the packages as they are, so the baseline records them as its own.`);
    }
    if (options.attempts !== undefined && !needs.live.length) {
      planWarnings.push(`No package declares a live dependency, so every package runs once. The baseline keeps --attempts ${options.attempts} for a package that declares one later.`);
    }
    if (needs.undeclared.length) {
      planWarnings.push(`${declare(needs.undeclared)} no live dependency although the agent runs with model ${model}, so ${they(needs.undeclared)} ${needs.undeclared.length === 1 ? 'runs' : 'run'} once. If a scenario calls the model, declare that in write-eval.`);
    }
    // A baseline without the user's confirmation runs, but no loop starts on it until they confirm.
    const why = confirmation.gap ?? confirmation.unconfirmed;
    if (why) planWarnings.push(why.message);
  } else {
    plan = planOf(base);
    const liveReady = ready.filter((item) => isLive(item.dependencies)).map((item) => item.id);
    if (loop) {
      // A full run of a loop that needs a final run is a screen run, unless
      // loop status names a passing, reviewed screen run whose final run is
      // still due on this code: then it is that final run. A final run of
      // this code that passed already is the one to accept.
      if (!partial) {
        const { final } = loopNow;
        role = !final.needed ? null : final.pending ? 'final' : 'screen';
        if (role === 'final') finalOf = final.candidate;
        passedFinal = role === 'screen' ? final.finals.find((entry) => entry.verdict === 'pass')?.run_id ?? null : null;
      }
    } else if (!partial && options.attempts === undefined && liveReady.length && plan.attempts === null && !plan.uniform) {
      planWarnings.push(`${declare(liveReady)} a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so ${they(liveReady)} ran once.`);
    }
    if (plan.uniform && base.is_baseline && !partial && role !== 'screen') {
      planWarnings.push(`The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs ${plan.attempts === 1 ? 'once' : `${plan.attempts} times`}, as it did there. A new baseline asks for the number of attempts of each package that declares a live dependency.`);
    }
    const undeclared = planNeeds([], ready, model).undeclared;
    if (undeclared.length && !plan.uniform) {
      planWarnings.push(`${declare(undeclared)} no live dependency although the agent runs with model ${model}, so ${they(undeclared)} ran once. If a scenario calls the model, declare that in write-eval.`);
    }
  }
  // The attempts each ready package makes in this run.
  const perCase = Object.fromEntries(ready.map((item) => [item.id, attemptsFor(item, plan, { partial, attempts: options.attempts, role })]));
  const attempts = role === 'screen' || (partial && options.attempts === undefined) ? 1 : options.attempts ?? plan.attempts ?? 1;
  // A final run runs first the packages whose gating checks failed before,
  // in any run of this Spec export, so a failure shows as soon as it can.
  let order = ready;
  if (role === 'final') {
    const gatingOf = new Map(cases.map((item) => [item.id, new Set(item.checks.filter((check) => check.role === 'gating').map((check) => check.id))]));
    const failedBefore = new Set(sameCodeResults(repo, runs, spec.sha256, earlier)
      .filter((entry) => entry.result === 'fail' && gatingOf.get(entry.case)?.has(entry.check)).map((entry) => entry.case));
    order = [...ready.filter((item) => failedBefore.has(item.id)), ...ready.filter((item) => !failedBefore.has(item.id))];
  }
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
  const unfinished = unfinishedRuns(runs);
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
  // The package and kit files this run executes, as they are at its start.
  const evalStart = evalSnapshot(repo, name);
  const warnings = [...evals.warnings, ...planWarnings];
  if (unproved.length) {
    warnings.push(`${unproved.join(', ')} changed since ${unproved.length === 1 ? 'its' : 'their'} last \`eval check\`, so this baseline skips ${unproved.length === 1 ? 'it' : 'them'}, and a loop does not start on it. Prove ${unproved.length === 1 ? 'it' : 'them'} with \`eval check\`, then record the baseline again.`);
  }
  if (unfinished.length) warnings.push(unfinishedWarning(unfinished));
  const { patch, error: patchError } = savePatch(repo, code.snapshot, path.join(directory, 'code.patch'));
  if (patchError) {
    warnings.push(`code.patch could not be written (${patchError}), so the code of this run cannot be restored: its commit does not hold the uncommitted files.`);
  }
  // Packages run one at a time. A final run stops at the first package whose
  // gating checks failed in an attempt that completed: that code can no
  // longer be accepted, so the rest would only spend time. Every package
  // builds from the application as it is when that package runs, so after
  // each one the code, the packages and the kit are read again, by content
  // and by when each file was last written: an edit put back before the run
  // ends still shows.
  const look = executes ? watchRun(repo, name, code.snapshot, evalStart) : null;
  const codeMoves = [];
  const packageMoves = {};
  const kitMoves = new Set();
  const outcomes = [];
  for (const item of executes ? order : []) {
    const stopped = role === 'final' ? outcomes.find((outcome) => failedValidly(outcome, cases.find((entry) => entry.id === outcome.id).checks)) : null;
    if (stopped) {
      skipped.push({ case: item.id, reason: 'final_stopped', after: stopped.id });
      continue;
    }
    outcomes.push(runCase(harborCommand(), item, item.checks, path.join(directory, item.id),
      { agent, model, yes: options.yes === true, timeout: options.timeout ?? 30, harness: harnessDirectory, repo, attempts: perCase[item.id] }));
    const seen = look();
    if (seen.code) codeMoves.push(item.id);
    for (const [id, files] of Object.entries(seen.packages)) packageMoves[id] = [...new Set([...(packageMoves[id] ?? []), ...files])].sort();
    for (const file of seen.kit) kitMoves.add(file);
  }
  const ranIds = new Set(outcomes.map((outcome) => outcome.id));
  const ran = ready.filter((item) => ranIds.has(item.id));
  warnings.push(...outcomes.flatMap((outcome) => outcome.warnings));
  // Code that changed during the run gives results that belong to no single
  // version of it: such a run neither passes nor counts as a baseline.
  const moved = codeMoves.length > 0;
  if (moved) warnings.push('The code changed while this run executed, so its results do not belong to one version of the code. Do not edit the code during a run; run again once it is stable.');
  // So do results of packages, or of a kit, that changed while they ran: a
  // package whose files changed, or every one once the kit changed.
  const digests = Object.fromEntries(cases.map((item) => [item.id, item.task_digest]));
  const ranConfirmation = confirmation.gap ? null : confirmationOf(confirmation.entries, spec.sha256, digests);
  const changedDuring = ran.map((item) => item.id).filter((id) => kitMoves.size > 0 || packageMoves[id] !== undefined);
  const packagesMoved = changedDuring.length > 0;
  if (packagesMoved) {
    const files = [...changedDuring.flatMap((id) => (packageMoves[id] ?? []).map((file) => (file.startsWith('\0') ? `${id}/ (${file.slice(1)})` : `${id}/${file}`))),
      ...[...kitMoves].sort().map((file) => `kit/${file}`)];
    const shown = files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', ');
    warnings.push(`The eval packages changed while this run executed: ${changedDuring.join(', ')}${shown ? ` (${shown})` : ''}. Its results do not belong to one version of them. Do not edit packages or the project kit during a run; prove them again with \`eval check\` and run again.`);
  }
  const status = options.unavailable ? 'not_run' : !executes ? 'blocked'
    : outcomes.every((outcome) => outcome.execution.status === 'completed') ? 'completed' : 'error';
  // The run's own minutes, from its start to its end, and the sums of its
  // attempts: their minutes and what the adapter reported they used.
  const finished = new Date();
  const attemptUsage = usageOf(outcomes.flatMap((outcome) => outcome.attempts));
  const usage = { minutes: tenths(minutesBetween(started.toISOString(), finished.toISOString()) ?? 0), attempt_minutes: attemptUsage.minutes,
    attempts: attemptUsage.attempts, reported: attemptUsage.reported, ...Object.fromEntries(USAGE_KEYS.map((key) => [key, attemptUsage[key]])) };
  // With a model, an adapter that reports nothing leaves the cost unknown.
  const silent = executes && model ? outcomes.filter((outcome) => outcome.usage.reported === 0
    && outcome.attempts.some((entry) => entry.status === 'completed')).map((outcome) => outcome.id) : [];
  if (silent.length) warnings.push(`The adapter reported no cost or tokens for ${silent.join(', ')}; the estimates count their time only.`);
  const record = {
    schema_version: '1.0', run_id: runId, side, scope: options.case?.length ? 'partial' : 'full',
    // screen or final inside a loop that needs a final run; otherwise null.
    // A final run names its screen run and the order its packages ran in.
    role, ...(role === 'final' ? { final_of: finalOf, run_order: outcomes.map((outcome) => outcome.id) } : {}),
    started_at: started.toISOString(), finished_at: finished.toISOString(),
    execution_status: status, verdict: null,
    code_version: code.version, spec_snapshot: spec,
    code_changed_during_run: moved,
    // The packages after whose run the code differed from the run's start.
    ...(moved ? { code_changed_during: codeMoves } : {}),
    packages_changed_during_run: packagesMoved,
    is_baseline: side === 'base' && status === 'completed' && !moved && !packagesMoved,
    baseline: side === 'head' && base.is_baseline ? base.run_id : null,
    // The base record a head run was compared with, also when it records an
    // unavailable baseline.
    base_run: side === 'head' ? base.run_id : null,
    // The loop of loop.json this head run was made in: its start, baseline
    // and start code, or null outside a loop. Only a run that names a loop
    // is one of its runs.
    ...(side === 'head' ? { loop: loop ? { started_at: loop.started_at, baseline: loop.baseline, start_code: loopStartCode(repo, name, loop) } : null } : {}),
    baseline_unavailable_reason: null,
    code_snapshot: { ...code.snapshot, ...(patch ? { patch } : {}) }, task_digest: digests,
    // The files behind each task digest, so a report can name what changed.
    eval_snapshot: { packages: evalStart.packages, kit: evalStart.kit, ...(packagesMoved ? { changed_during_run: changedDuring } : {}) },
    // The user's checks confirmation of the packages this run ran, or null.
    checks_confirmation: ranConfirmation ? { id: ranConfirmation.id, at: ranConfirmation.confirmed?.at ?? null } : null,
    // attempts is the number each package with a live dependency makes;
    // attempts_by_case what each package that ran made. Head runs copy the
    // plan of their base record.
    environment_ref: { harbor: tools.harbor, agent: executes ? agent : null, model: executes ? model ?? null : null, attempts,
      attempts_by_case: executes ? Object.fromEntries(ran.map((item) => [item.id, perCase[item.id]])) : {}, run_plan: plan,
      dependencies: Object.fromEntries(ready.map((item) => [item.id, item.dependencies])) },
    map_ref: evals.map ?? null,
    // What the run took and used; each case's usage counts its attempts.
    usage,
    cases: outcomes.map((outcome) => outcome.summary), skipped, warnings,
  };
  let comparison = null;
  if (side === 'base') {
    record.baseline_unavailable_reason = options.unavailable ?? (record.is_baseline ? null : 'execution_blocked');
    // Every declared check, including packages not connected yet: what the
    // change is expected to do is fixed before the code changes, whether or
    // not the package could run.
    record.baseline_expectations = options.unavailable ? [] : cases.flatMap((item) => item.checks.map((check) => declared
      .find((entry) => entry.case === item.id && entry.check === check.id)
      ?? { case: item.id, check: check.id, expected: 'any', reason: 'No expectation was declared before the baseline ran.' }));
    const expectedOf = (id, check) => declared.find((item) => item.case === id && item.check === check)?.expected ?? 'any';
    // A check that passed in some attempts and failed in others has no settled
    // result before the change: it is unstable, never a mismatch.
    record.baseline_unstable = outcomes.flatMap((outcome) => outcome.results.flatMap((entry) => {
      const counts = outcome.counts[entry.id];
      return counts?.pass > 0 && counts.fail > 0 ? [{ case: outcome.id, check: entry.id, expected: expectedOf(outcome.id, entry.id), counts }] : [];
    }));
    const unstableAt = (list, id, check) => (list ?? []).some((item) => item.case === id && item.check === check);
    record.baseline_mismatch = outcomes.flatMap((outcome) => outcome.results.flatMap((entry) => {
      const expected = expectedOf(outcome.id, entry.id);
      return expected !== 'any' && entry.result !== 'unknown' && entry.result !== expected && !unstableAt(record.baseline_unstable, outcome.id, entry.id)
        ? [{ case: outcome.id, check: entry.id, expected, got: entry.result }] : [];
    }));
    if (record.baseline_unstable.length) {
      const shown = record.baseline_unstable.map(({ case: id, check, counts }) => `${id}/${check} ${counts.pass} of ${counts.pass + counts.fail + counts.unknown} passed`);
      warnings.push(`Checks that passed in some attempts and failed in others at the baseline (baseline_unstable): ${shown.join(', ')}. Their result before the change is not settled, so a later pass shows nothing about this change. Read their logs/ for what differed between the attempts, and tell the user. Do not change an expectation to fit one outcome.`);
    }
    // An expectation follows what the change does, so it does not flip with
    // one outcome of a check that was unstable at the previous baseline.
    const previous = earlier.filter((run) => run.side === 'base' && run.is_baseline).pop() ?? null;
    if (previous && !options.unavailable) {
      for (const item of previous.baseline_unstable ?? []) {
        const now = expectedOf(item.case, item.check);
        if (now !== item.expected) {
          warnings.push(`The expected result of ${item.case}/${item.check} changed from ${item.expected} to ${now} since the baseline ${previous.run_id}, where it was unstable. An expectation follows what the change does, not one outcome of an unstable check.`);
        }
      }
    }
    if (earlier.some((run) => run.side === 'base' && run.is_baseline && sameCode(run.code_snapshot, code.snapshot, repo) === false)) {
      warnings.push('An earlier baseline for this Spec ran on different code. A baseline must be the code before the change.');
    }
    if (loop) {
      warnings.push(loopEnded
        ? `The loop for this Spec has ended; it compared every run with its own baseline ${loop.baseline}. A new loop, once the user agrees, may start on this one.`
        : `The loop for this Spec keeps comparing with its own baseline ${loop.baseline} while it runs; a new loop, after it ended and once the user agrees, may start on this one.`);
    }
  } else {
    record.baseline_unavailable_reason = base.is_baseline ? null : base.baseline_unavailable_reason ?? 'execution_blocked';
    const results = outcomes.flatMap((outcome) => {
      // A package that did not run in the baseline has no result to compare;
      // one that changed since has a result for a different package.
      const ranAtBase = base.is_baseline && (base.cases ?? []).some((item) => item.id === outcome.id);
      const comparable = ranAtBase && base.task_digest?.[outcome.id] === digests[outcome.id];
      const declaredChecks = cases.find((item) => item.id === outcome.id).checks;
      const before = comparable ? readResults(path.join(runs, base.run_id, outcome.id), declaredChecks) : null;
      // Base and head attempts are never paired: each side gives its counts.
      const beforeCounts = comparable ? readCounts(path.join(runs, base.run_id, outcome.id), declaredChecks,
        base.environment_ref?.attempts_by_case?.[outcome.id] ?? base.environment_ref?.attempts ?? 1) : null;
      const reason = !base.is_baseline ? record.baseline_unavailable_reason : ranAtBase ? 'incompatible_tasks' : 'not_run_at_baseline';
      return outcome.results.map((entry) => {
        const earlierResult = before?.find((item) => item.id === entry.id).result ?? null;
        const expected = base.baseline_expectations?.find((item) => item.case === outcome.id && item.check === entry.id)?.expected ?? 'any';
        const verdict = entry.result === 'fail' ? 'violated' : entry.result === 'unknown' ? 'unverified'
          : earlierResult === null ? 'head_only' : earlierResult === 'unknown' ? 'unverified'
            : expected !== 'any' && earlierResult !== expected ? 'base_mismatch' : 'holds';
        return { case: outcome.id, check: entry.id, intent: entry.intent, ...(entry.then !== undefined ? { then: entry.then } : {}), role: entry.role, before: earlierResult,
          ...(earlierResult === null ? { before_unavailable_reason: reason } : {}),
          after: entry.result, before_counts: earlierResult === null ? null : beforeCounts?.[entry.id] ?? null, after_counts: outcome.counts[entry.id],
          verdict, evidence: entry.evidence, ...(entry.flaky ? { flaky: true } : {}) };
      });
    });
    const gating = results.filter((entry) => entry.role === 'gating');
    // A partial run never passes, even when it names every package.
    record.verdict = moved || packagesMoved ? 'unverified' : gating.some((entry) => entry.after === 'fail') ? 'fail'
      : record.scope === 'full' && status === 'completed' && !skipped.length && gating.length && gating.every((entry) => entry.after === 'pass') ? 'pass' : 'unverified';
    // The comparison holds only when both sides ran the same way. It is shown,
    // not enforced: the verdicts stay as they are. A partial run makes one
    // attempt of each package unless --attempts says otherwise. Inside a loop
    // only Harbor can still differ: other settings are refused.
    if (base.is_baseline && base.environment_ref) {
      const names = { agent: 'agent', model: 'model', attempts: 'attempts', harbor: 'Harbor version' };
      // A screen run makes one attempt of each package by design.
      const differ = Object.keys(names).filter((key) => key in base.environment_ref
        && (key !== 'attempts' || (role !== 'screen' && (!partial || options.attempts !== undefined)))
        && (base.environment_ref[key] ?? null) !== (record.environment_ref[key] ?? null));
      if (differ.length) {
        warnings.push(`The settings of this run differ from those of the baseline ${base.run_id}: ${differ.map((key) => `${names[key]} ${record.environment_ref[key] ?? 'none'} here, ${base.environment_ref[key] ?? 'none'} in the baseline`).join('; ')}. A different result may come from that, not from the change. Run with the baseline's settings to compare like with like.`);
      }
    }
    // The lines no check verifies, of the packages that ran: the user judges
    // them at acceptance, from what the evaluated agent produced.
    const manual = ran.flatMap((item) => (Array.isArray(item.scenario?.manual) ? item.scenario.manual : [])
      .map((entry) => ({ case: item.id, then: thenKey(entry.then), reason: entry.reason.trim() })));
    comparison = { schema_version: '1.0', run_id: runId, baseline: record.baseline, base_run: record.base_run, results, manual };
    writeJSON(path.join(directory, 'compare.json'), comparison);
  }
  writeJSON(path.join(directory, 'run.json'), record);
  // A screen run that passed on code that already failed a gating check, with
  // these packages, agent and model, leads to no final run.
  const burned = role === 'screen' && record.verdict === 'pass'
    ? [...new Set(failuresOf(sameCodeResults(repo, runs, spec.sha256, earlier), record,
      new Set(comparison.results.filter((entry) => entry.role === 'gating').map((entry) => checkKey(entry.case, entry.check))), repo).map((entry) => entry.run_id))] : [];
  // The packages whose gating checks failed in an attempt that completed.
  const failedHere = outcomes.filter((outcome) => failedValidly(outcome, cases.find((entry) => entry.id === outcome.id).checks)).map((outcome) => outcome.id);
  const tally = (key, checkRole) => comparison?.results.filter((entry) => entry.verdict === key && (!checkRole || entry.role === checkRole)).length;
  const verdicts = ['holds', 'violated', 'base_mismatch', 'head_only', 'unverified'];
  return {
    run_id: runId, directory, side, scope: record.scope, role, execution_status: status, verdict: record.verdict,
    is_baseline: record.is_baseline, baseline: record.baseline, baseline_unavailable_reason: record.baseline_unavailable_reason,
    cases: record.cases, skipped, warnings, run_plan: plan, attempts: record.environment_ref.attempts_by_case, usage,
    // Every check, then the gating ones alone: only they decide the verdict.
    ...(side === 'base' ? { baseline_mismatch: record.baseline_mismatch, baseline_unstable: record.baseline_unstable } : {
      compare: Object.fromEntries(verdicts.map((key) => [key, tally(key)])),
      compare_gating: Object.fromEntries(verdicts.map((key) => [key, tally(key, 'gating')])) }),
    next: !['completed', 'not_run'].includes(status)
      ? side === 'head' && !moved && !packagesMoved && failedHere.length
        // A failure in an attempt that completed is a result of the code,
        // whatever else errored.
        ? `Execution did not complete: read cases[].execution.reason and each case's logs/harbor.log, and fix the cause. But ${list(failedHere)} failed a gating check in an attempt that completed, which is a result of the code and counts${role === 'final' ? ': this final run failed, and this code can never be accepted' : ': no run of this code with these packages can be accepted'}. ${loop ? 'Run `loop status` next.' : 'Change the code before the next run.'}`
        : 'Execution did not complete. Read cases[].execution.reason and each case\'s logs/harbor.log, fix the cause, then run the same command again.'
      : moved ? 'The code changed while this run executed, so it shows nothing about any one version of the code. Leave the code as it is during a run, and run the same command again.'
      : packagesMoved ? 'The eval packages changed while this run executed, so it shows nothing about any one version of them. Leave them and the project kit as they are during a run, prove them again with `eval check`, then run the same command again.'
      : side === 'base'
        ? record.baseline_mismatch?.length
          ? 'The baseline did not behave as declared (baseline_mismatch). Before changing code, find out why: this is not the code before the change, the expectation is wrong, or the check cannot tell the two apart. Then run the baseline again.'
          // A baseline that skipped a package waiting for `eval check` is no
          // baseline a loop starts on.
          : unproved.length ? `This baseline skipped ${list(unproved)}, which ${unproved.length === 1 ? 'waits' : 'wait'} for \`eval check\`, so no loop starts on it. Prove ${unproved.length === 1 ? 'it' : 'them'} with \`eval check\`, then record the baseline again with the same flags before \`loop start\`.`
          : `${loop && !(pin && loopEnded) ? `The loop for this Spec compares every run with its own baseline ${loop.baseline} while it runs. Once it has ended or stopped, and the user agrees, \`loop start\` starts a new loop on this baseline${confirmed ? '' : '; first the user confirms the checks as they are now (`eval review`, `eval confirm --reason`)'}.`
            : pin ? `${loopEnded ? 'The loop for this Spec has ended. ' : ''}${record.is_baseline ? 'The baseline is recorded' : 'That no baseline could run is recorded'} on the start code of the change's first unaccepted loop (${restoreHint(name, pin.loop, null)}). ${!confirmed
              ? `Have the user confirm the checks first (\`eval review\`, \`eval confirm${revisionFlag}\`): \`loop start\` refuses checks_unconfirmed. Then bring` : 'Bring'} back any changes you set aside and, once the user agrees, run \`loop start\`: the new loop keeps that start code.`
            : record.is_baseline
              ? `The baseline is recorded. ${confirmed ? 'Start the implementation loop before changing any code: `loop start` (loop-and-implement) takes the budget the user confirmed in confirmed.json' : `Have the user confirm the checks first (\`eval review\`, \`eval confirm${revisionFlag}\`): \`loop start\` refuses checks_unconfirmed. Then start the implementation loop before changing any code with \`loop start\` (loop-and-implement)`}; a loop does not start on code other than the baseline's. To change the code without a loop, change it, then run \`run start\` again; later runs are compared with this baseline.`
              : `That no baseline could run is recorded. ${confirmed ? 'To implement the change, run `loop start` (loop-and-implement): it takes the budget the user confirmed in confirmed.json' : `Have the user confirm the checks first (\`eval review\`, \`eval confirm${revisionFlag}\`): \`loop start\` refuses checks_unconfirmed. Then, to implement the change, run \`loop start\` (loop-and-implement)`}. Without a loop, write the code, then run \`run start\`; its checks have no baseline result to compare with.`}${record.baseline_unstable?.length
            ? ' Some checks passed in some attempts and failed in others (baseline_unstable): tell the user before the loop starts, and leave their expectations as they are.' : ''}`
        : record.scope === 'partial'
          ? loop && record.verdict === 'fail'
            ? 'A partial run never counts as passing, but its failure always counts for the same code: no run of that code and those packages can be accepted. Run `loop status` next.'
            : 'A partial run is a quick look and never counts as passing. Run every package before saying the change works.'
        // Inside a loop, its status says what comes next: the report, then the
        // final review, before the user is asked.
        : loop ? role === 'screen' && record.verdict === 'pass'
          ? burned.length ? `The screen run passed, but its code already failed a gating check in ${burned.join(', ')}, so no final run of it can be accepted. Run \`loop status\` next: write its report, then change the code.`
            : passedFinal ? `The screen run passed, and final run ${passedFinal} of this code passed already: that is the run to accept. Run \`loop status\` next: write this run's report first.`
            : 'The screen run passed: one attempt of each package is a lead, not a result. Run `loop status` next: the report and the final review come before the final run.'
          : role === 'final' && record.verdict === 'pass' ? 'The final run passed. Run `loop status` next: write its report, then ask the user to accept.'
            : role === 'final' && record.verdict === 'fail' ? 'The final run failed, so this code can never be accepted. Run `loop status` next.'
              : record.verdict === 'pass'
                ? 'Every gating check passes. Run `loop status` next: the report and the final review come before the user is asked to accept.'
                : 'Read compare.json and each case\'s logs/ before changing anything; classify the cause first. Then run `loop status`, which asks for this run\'s report.'
        : record.verdict !== 'pass' ? 'Read compare.json and each case\'s logs/ before changing anything; classify the cause first.'
          : tally('base_mismatch') || tally('head_only')
            ? 'Every gating check passes. The base_mismatch and head_only checks have no usable baseline result, so they do not show that this change made the difference. Report them with the comparison; the user decides whether to accept.'
            : 'Acceptance is met. Report the per-check comparison; the user decides whether to accept.',
  };
}
