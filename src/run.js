import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, applicationDigest, codeState, digest, isGenerated, localPath, readJSON, requireProject, writeJSON } from './project.js';
import {
  PROBE_FOLDER, casesDigests, checksConfirmation, confirmationById, confirmationOf, digestsAt, draftBound as boundToDraft, eddDirectory, entryDigests, evalFilesChanged, evalSnapshot,
  fixtureDigest, fixturePatch, fixturesProvedFor, isLive, kitDirectory, packageSteps, probeHolds, projectReads, readCheckRecord, reportedModelUse, samePackage, sharedCodeMismatches, thenKey,
  validateEval,
} from './eval.js';
import { appendDecision, appendRunIndex, latestDecision, readRunIndex } from './records.js';
// run.js and loop.js import each other: a head run inside a loop asks
// loopStatus whether the loop goes on and whether a full run is a screen run
// or the final run. The cycle is safe because neither module uses the other's
// exports while it loads; keep the top level of both free of such calls.
import { headRunGap, loopPhase, loopStatus, writeReport } from './loop.js';

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
    gaps.push({ code: 'harbor_missing', kind: 'technical', owner: 'agent', layer: 'machine',
      message: `Harbor could not be run as \`${[bin, ...rest].join(' ')}\`${reason ? `: ${reason}.` : '.'} genesis-edd runs Harbor 0.27.0 (\`uv tool install harbor==0.27.0\`), or the command GENESIS_EDD_HARBOR names.` });
  }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  if (!docker) {
    gaps.push({ code: 'docker_unavailable', kind: 'technical', owner: 'agent', layer: 'machine',
      message: 'Docker is not running on this machine. A run that cannot reach Docker is no result of the code and records nothing.' });
  }
  return { harbor, docker, gaps };
}

// A gap as this module reports it: without the skill and workflow pointers
// earlier releases and other modules attached.
const clean = (gap) => {
  if (!gap || typeof gap !== 'object') return gap;
  const { route, resume, ...rest } = gap;
  return rest;
};

// A refusal: the message and the gaps that caused it, each with its layer and
// owner.
function blocked(message, repo, name, gaps) {
  return Object.assign(new Error(message), { code: 'RUN_INPUT_BLOCKED', change: name, gaps: gaps.map(clean) });
}

// Progress of a run on stderr, one line per package, so a long run shows
// where it is. The JSON result on stdout is unchanged. GENESIS_EDD_PROGRESS=0
// turns it off.
const progress = (text) => {
  if (process.env.GENESIS_EDD_PROGRESS === '0') return;
  try { process.stderr.write(`genesis-edd: ${text}\n`); } catch { /* a closed stderr loses only progress */ }
};

// What a run, a trial and a lost record are. A trial runs the real adapter on
// structurally valid packages to see how they behave: it is never a baseline,
// a run of a loop, an accepted run or a proof, but its completed failures count
// for its code like any run's. A lost run is one the run index records whose
// folder or run.json is gone; an interrupted one started and never finished,
// with its folder still there.
export const isTrial = (run) => run?.side === 'trial';
export const isLost = (run) => run?.lost === true || run?.execution_status === 'lost';
export const isInterrupted = (run) => run?.interrupted === true || run?.execution_status === 'interrupted';
export const usableRun = (run) => Boolean(run) && !isLost(run) && !isInterrupted(run);

// The trials made inside a loop, which spend its budget.
export const loopTrials = (runs, loop) => (runs ?? []).filter((run) => isTrial(run) && Boolean(loop?.started_at) && run.loop?.started_at === loop.started_at);

// The head runs of a loop that the run index keeps but whose records are gone
// or never finished: they spend the loop's budget by their recorded minutes,
// and a lost one counts as a failure of its code.
export const loopLostRuns = (runs, loop) => (runs ?? []).filter((run) => run.side === 'head' && !usableRun(run)
  && Boolean(loop?.started_at) && run.loop?.started_at === loop.started_at);

// Host variables a package's task.toml asks Harbor for: each ${NAME} or
// ${NAME:-default} in an env table. [{ name, default }], by name.
function declaredHostVariables(directory) {
  const files = [path.join(directory, 'task.toml')];
  try {
    for (const step of readdirSync(path.join(directory, 'steps'), { withFileTypes: true })) {
      if (step.isDirectory()) files.push(path.join(directory, 'steps', step.name, 'task.toml'));
    }
  } catch { /* no steps */ }
  const found = new Map();
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let table = '';
    for (const line of text.split('\n')) {
      const header = /^\s*\[+([^\]]+)\]+\s*(?:#.*)?$/.exec(line);
      if (header) { table = header[1].trim(); continue; }
      if (!/(?:^|\.)env$/.test(table) && !table.includes('mcp_servers')) continue;
      for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
        if (!found.has(match[1])) found.set(match[1], { name: match[1], default: match[2] ?? null });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Which host variables a run passes to Harbor. --yes passes every variable a
// package declares; --allow-env names the ones passed, and the others are
// left out of Harbor's environment, so a declared one without a default
// stops that package. Neither passes none. { mode: all, listed or none,
// names (passed), declared, withheld, yes (Harbor's --yes) }.
function hostEnvironment(directories, options) {
  const declared = [...new Map(directories.flatMap((directory) => declaredHostVariables(directory)).map((entry) => [entry.name, entry])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = declared.map((entry) => entry.name);
  if (Array.isArray(options.allowEnv)) {
    const allowed = new Set(options.allowEnv);
    return { mode: 'listed', names: names.filter((entry) => allowed.has(entry)), allowed: [...allowed].sort(), declared: names,
      withheld: names.filter((entry) => !allowed.has(entry)), yes: true };
  }
  if (options.yes === true) return { mode: 'all', names, declared: names, withheld: [], yes: true };
  return { mode: 'none', names: [], declared: names, withheld: names, yes: false };
}

// The names --allow-env gives: a list of variable names, or a refusal.
function allowedNames(options) {
  if (options.allowEnv === undefined) return;
  const list = (Array.isArray(options.allowEnv) ? options.allowEnv : [options.allowEnv]).flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
  if (!list.length || list.some((entry) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))) throw new Error('--allow-env names host variables, separated by commas.');
  if (options.yes === true) throw new Error('--yes passes every host variable a package declares and --allow-env names the ones passed: give one of them.');
  options.allowEnv = [...new Set(list)];
}

// A package written against a Spec draft rather than an export: it can be
// written and proved, never confirmed or run.
export const draftBound = (item) => boundToDraft(item) || item?.spec_ref?.draft === true;

// The checks of a package as a run counts them. A judge check, which runs the
// project's own judging program, is diagnostic unless the user made its line
// gating at a checks confirmation (judge_gating, `case:then` entries).
export const JUDGE_KIND = 'judge';
export const CODE_KIND = 'code_test';
export const judgeKey = (id, then) => `${id}:${thenKey(String(then ?? ''))}`;
export function countedChecks(id, checks, judgeGating = []) {
  const gating = new Set((Array.isArray(judgeGating) ? judgeGating : []).map((entry) => {
    const at = String(entry).indexOf(':');
    return at > 0 ? judgeKey(String(entry).slice(0, at), String(entry).slice(at + 1)) : String(entry);
  }));
  return (Array.isArray(checks) ? checks : []).map((check) => (check?.kind === JUDGE_KIND
    ? { ...check, role: gating.has(judgeKey(id, check.then)) ? 'gating' : 'diagnostic', declared_role: check.role ?? null } : check));
}

// The compose projects Harbor gives one package of a run, read from the
// trial folders it wrote: the environment of trial T runs as project
// "T__env", and a verifier in its own environment as "T__verifier__…", each
// lowercased with any character but a-z, 0-9, - and _ replaced by -. A trial
// is named after its task and a random suffix, so the names are known only
// once its folder exists.
const composeName = (value) => {
  const lower = String(value).toLowerCase();
  return (/^[a-z0-9]/.test(lower) ? lower : `0${lower}`).replace(/[^a-z0-9_-]/g, '-');
};
function trialProjects(folder) {
  const job = path.join(folder, 'logs', 'harbor');
  let trials = [];
  try { trials = readdirSync(job, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  return trials.sort().map((trial) => ({ trial, project: composeName(`${trial}__env`), prefix: composeName(`${trial}__`) }));
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

// The content digest of the commit's files with the changed paths as they are
// on disk. It is the one `spec new` records for the code, so the two compare.
function contentDigest(repo, commit, changed) {
  return applicationDigest(repo, commit, changed);
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
// runs defaults to every record in runsDirectory. Two results are of the
// same package as samePackage says: by run_digest when both runs recorded
// one, so a fixture added since keeps the count, else by task_digest.
// Each entry: { run, run_id, started_at, side, scope, code, case,
// task_digest, run_digest, agent, model, attempt (null for a combined
// result), check, result }.
// Trials count here like any run. A run the run index keeps whose record is
// gone (lost) counts as one failed attempt of every gating check its start
// entry named, for each of its packages, on its code and packages: what it
// found cannot be read, so it cannot be shown to have passed. An interrupted
// run counts the attempts that completed before it stopped.
export function sameCodeResults(repo, runsDirectory, spec, runs = readRuns(runsDirectory)) {
  return runs.flatMap((run) => {
    if (run.spec_snapshot?.sha256 !== spec) return [];
    const lost = isLost(run);
    const interrupted = isInterrupted(run);
    if (!lost && !interrupted && (run.code_changed_during_run === true || run.packages_changed_during_run === true
      || !['completed', 'error'].includes(run.execution_status))) return [];
    const code = codeIdentity(run.code_snapshot, repo) ?? run.code_identity ?? null;
    if (!code) return [];
    const agent = run.environment_ref?.agent ?? null;
    const model = run.environment_ref?.model ?? null;
    return (run.cases ?? []).flatMap((item) => {
      const folder = path.join(runsDirectory, run.run_id, item.id);
      const entry = (attempt, check, result) => ({ run, run_id: run.run_id, started_at: run.started_at, side: run.side, scope: run.scope ?? 'full', code,
        case: item.id, task_digest: run.task_digest?.[item.id] ?? null, run_digest: run.run_digest?.[item.id] ?? null, agent, model, attempt, check, result,
        ...(lost ? { lost: true } : {}), ...(interrupted ? { interrupted: true } : {}) });
      const counted = (result) => result === 'fail' || result === 'pass';
      if (lost) return (run.gating?.[item.id] ?? []).map((check) => entry(null, check, 'fail'));
      if (interrupted && !existsSync(path.join(folder, 'attempts.json'))) {
        const layout = run.check_steps?.[item.id] ?? packageLayout(path.dirname(runsDirectory), item.id);
        return trialAttempts(folder, layout).filter((attempt) => attempt.status === 'completed')
          .flatMap((attempt) => Object.entries(attempt.results).filter(([, result]) => counted(result)).map(([check, result]) => entry(null, check, result)));
      }
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
// package, agent and model. code is a content digest, digests a record that
// keeps the task digest and the run digest of each package (task_digest,
// run_digest), checks a Set of `<case>\n<check>`. Each group: { case, check,
// agent, model, pass: [run_id], fail: [run_id], head: whether a head run is
// among them }, sorted by case, then check.
export function unstableChecks(results, { code, digests, checks }) {
  const groups = new Map();
  for (const entry of results) {
    if (entry.code !== code || !samePackage(entryDigests(entry), digestsAt(digests, entry.case)) || !checks.has(checkKey(entry.case, entry.check))) continue;
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
    && samePackage(entryDigests(entry), digestsAt(run, entry.case))
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
    && (!run || (samePackage(entryDigests(entry), digestsAt(run, entry.case))
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

// What a loop has spent of its budget: its full head runs so far, the
// minutes since its clock started, the run minutes and the cost of its head
// runs, full and partial (usage, from usageOfRuns). A budget counts run
// minutes, the Docker time of the runs, so time spent waiting for the user
// does not count; a budget recorded before run minutes counts the minutes
// since the clock started instead, as it did then. A cost cap counts the cost
// the adapter reported. The caller passes acceptedAt only while that
// acceptance covers the loop: a finished loop spends no more clock minutes.
export function budgetUsed(loop, fullRuns, acceptedAt, usage = null) {
  const clock = loop.clock_started_at ?? loop.started_at;
  const stopped = Date.parse(acceptedAt);
  const budget = loop.budget ?? {};
  const used = { iterations: fullRuns.length,
    minutes: Math.max(0, Math.round(((Number.isFinite(stopped) ? stopped : Date.now()) - Date.parse(clock)) / 60_000)),
    run_minutes: usage?.minutes ?? 0, cost_usd: usage?.cost_usd ?? null };
  const minutesUp = isNumber(budget.run_minutes) ? used.run_minutes >= budget.run_minutes : isNumber(budget.minutes) && used.minutes >= budget.minutes;
  const costUp = isNumber(budget.max_cost_usd) && used.cost_usd !== null && used.cost_usd >= budget.max_cost_usd;
  return { clock, used, exhausted: used.iterations >= budget.iterations || minutesUp || costUp };
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// What a budget allows, for a message: "5 full runs and 30 run minutes".
export function budgetLimits(budget) {
  const parts = [`${budget.iterations} full run${budget.iterations === 1 ? '' : 's'}`,
    ...(isNumber(budget.run_minutes) ? [`${shownMinutes(budget.run_minutes)} run minutes`] : isNumber(budget.minutes) ? [`${budget.minutes} minutes`] : []),
    ...(isNumber(budget.max_cost_usd) ? [`a cost cap of ${shownCost(budget.max_cost_usd)}`] : [])];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

// What a loop used of its budget, for a message: "2 of 5 runs, 12.5 of 30
// run minutes".
export function budgetText(budget, used) {
  return [`${used.iterations} of ${budget.iterations} runs`,
    ...(isNumber(budget.run_minutes) ? [`${shownMinutes(used.run_minutes ?? 0)} of ${shownMinutes(budget.run_minutes)} run minutes`]
      : isNumber(budget.minutes) ? [`${used.minutes} of ${budget.minutes} minutes`] : []),
    ...(isNumber(budget.max_cost_usd) ? [`${used.cost_usd === null || used.cost_usd === undefined ? 'no reported cost' : shownCost(used.cost_usd)} of ${shownCost(budget.max_cost_usd)}`] : [])].join(', ');
}

// Where the verifiers of a package record its checks: the steps Harbor runs,
// in the order task.toml declares them ([] for a package of one step), and
// the step each check is recorded at, from its at.
function stepLayout(directory, checks) {
  const steps = directory ? packageSteps(directory) : [];
  return { steps, at: Object.fromEntries((Array.isArray(checks) ? checks : [])
    .filter((check) => typeof check?.id === 'string' && typeof check.at === 'string').map((check) => [check.id, check.at])) };
}

// The layout of a package as it is now, read from its checks.json, for a
// run that never finished and recorded none.
function packageLayout(root, id) {
  const directory = path.join(root, 'evals', id);
  let checks = [];
  try { checks = readJSON(path.join(directory, 'tests/checks.json')).checks ?? []; } catch { /* no checks: nothing is read */ }
  return stepLayout(directory, checks);
}

// What the verifier of one Harbor trial recorded. In a package of one step,
// from the trial's verifier/ folder. In a package with steps, Harbor runs
// one agent run per step, in task.toml order, and then that step's verifier,
// with tests/ and the step's tests/ merged into /tests, and keeps what it
// wrote under steps/STEP/verifier/: each check is read only from the folder
// of the step it is at, so a result another step's verifier wrote for it
// never counts. layout is stepLayout's.
function verifierResults(trialDirectory, layout = null) {
  const read = (directory) => {
    try {
      const found = readJSON(path.join(directory, 'check-results.json')).results;
      return Array.isArray(found) ? found : [];
    } catch { return []; }
  };
  const ordered = Array.isArray(layout?.steps) ? layout.steps : [];
  if (ordered.length) {
    const byStep = Object.fromEntries(ordered.map((step) => [step, path.join(trialDirectory, 'steps', step, 'verifier')]));
    const recorded = Object.fromEntries(ordered.map((step) => [step, read(byStep[step])]));
    const results = Object.entries(layout.at ?? {}).flatMap(([id, step]) => {
      const found = (recorded[step] ?? []).find((entry) => entry?.id === id);
      return found ? [found] : [];
    });
    return { folders: ordered.map((step) => byStep[step]), steps: byStep, results };
  }
  const steps = path.join(trialDirectory, 'steps');
  let folders = [path.join(trialDirectory, 'verifier')];
  if (existsSync(steps)) {
    try { folders = readdirSync(steps).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((step) => path.join(steps, step, 'verifier')); } catch { /* none */ }
  }
  return { folders, results: folders.flatMap((directory) => {
    try {
      const found = readJSON(path.join(directory, 'check-results.json')).results;
      return Array.isArray(found) ? found : [];
    } catch { return []; }
  }) };
}

// The exception Harbor recorded for a trial, or null: the trial's own first,
// then the first step that raised. A trial with steps records a step's
// failure on that step's entry in step_results, not on the trial.
// { info, step }: step is the name of the step that raised (its position
// when Harbor gave it no name), or null for the trial's own exception.
function trialException(outcome) {
  if (outcome?.exception_info) return { info: outcome.exception_info, step: null };
  const steps = Array.isArray(outcome?.step_results) ? outcome.step_results : [];
  const index = steps.findIndex((step) => isObject(step) && step.exception_info);
  if (index < 0) return null;
  const name = steps[index].step_name;
  return { info: steps[index].exception_info, step: typeof name === 'string' && name ? name : String(index + 1) };
}

// What the adapter reported it used in a trial: the trial's agent_result, or,
// for a trial with steps, where Harbor records an agent result per step and
// none for the trial, the sum of each step's figures. null when nothing was
// reported. Model use is read from these figures, so a step's usage counts.
function trialUsage(outcome) {
  if (isObject(outcome?.agent_result)) return outcome.agent_result;
  const steps = (Array.isArray(outcome?.step_results) ? outcome.step_results : []).map((step) => step?.agent_result).filter(isObject);
  if (!steps.length) return null;
  return Object.fromEntries(USAGE_KEYS.flatMap((key) => {
    const values = steps.map((result) => result[key]).filter((value) => typeof value === 'number');
    return values.length ? [[key, values.reduce((sum, value) => sum + value, 0)]] : [];
  }));
}

// The attempts Harbor finished for a package whose run stopped before it
// wrote attempts.json: each trial folder with a readable result.json,
// completed when Harbor recorded no exception for the trial or any of its
// steps, with what its verifier recorded. [{ trial, status, step?, results:
// { check: result }, started_at, finished_at }]; step names the step that
// raised. layout says where a package with steps records each check
// (stepLayout).
function trialAttempts(folder, layout = null) {
  const job = path.join(folder, 'logs', 'harbor');
  let trials = [];
  try { trials = readdirSync(job, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return []; }
  return trials.flatMap((trial) => {
    const directory = path.join(job, trial);
    let outcome;
    try { outcome = readJSON(path.join(directory, 'result.json')); } catch { return []; }
    const results = Object.fromEntries(verifierResults(directory, layout).results.filter((found) => typeof found?.id === 'string' && RESULTS.includes(found.result))
      .map((found) => [found.id, found.result]));
    const raised = trialException(outcome);
    return [{ trial, status: raised ? 'error' : 'completed', ...(raised?.step ? { step: raised.step } : {}), results,
      started_at: outcome?.started_at ?? null, finished_at: outcome?.finished_at ?? null, ...(trialUsage(outcome) ? { usage: trialUsage(outcome) } : {}) }];
  });
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

// The environment of a Git command run outside the project: none of the
// variables that point Git at a repository, an index or an object store.
const outsideGit = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES'].includes(key)));

// The last line of what a failed command said, for a message.
const saidBy = (result) => (result.error?.message ?? String(result.stderr ?? '')).trim().split('\n').pop() || `exit ${result.status}`;

// The paths of a NUL-separated Git listing.
const nulPaths = (output) => String(output ?? '').split('\0').filter(Boolean);

// The .dockerignore rule that keeps the change's packages, and their expected
// results, out of an image built from the application root.
const IGNORES_GENESIS = /^\/?\.genesis\/?\s*$/m;

// The start code of a loop, rebuilt outside the project for a baseline on it
// (`run start --baseline --at-start`): the start commit as `git archive`
// writes it, with the files that commit did not hold put back from the patch
// the loop kept. Nothing is written into the project or its .git, so the
// working directory keeps the change and a read-only .git does not matter.
// The rebuilt code must be the start code: its content digest, worked out as
// a run works out its own (the commit in a scratch index, each file that
// differs from it hashed as a commit of it would hash it, generated files
// left out), must equal start_code's. Its .dockerignore must keep .genesis
// out of an image built from it. The scratch folder is added to held, which
// the caller deletes. Returns { tree, scratch, patch (the patch file to keep
// as the run's code.patch, or null), snapshot, files }, or throws a refusal.
function rebuildStart(repo, name, pin, held) {
  const start = pin.start;
  const root = eddDirectory(repo, name);
  const want = codeIdentity(start, repo);
  const where = restoreHint(name, pin.loop, null);
  const refuse = (code, message) => blocked('The start code cannot be rebuilt for this baseline.', repo, name, [{ code, kind: 'artifact', owner: 'agent', layer: 'code', message }]);
  if (!want) {
    throw refuse('start_code_unknown', `loop.json keeps the start code (${where}) without a content digest, as an earlier release wrote it, so rebuilt code cannot be compared with it. Without --at-start, a base record describes the code in the working directory.`);
  }
  // The patch of the files the start commit does not hold: the one loop.json
  // names, or, for a loop recorded before it kept one, its baseline's.
  const before = readRuns(path.join(root, 'runs')).filter(usableRun).find((run) => run.run_id === pin.loop.baseline) ?? null;
  const patch = start.patch ? path.join(root, start.patch)
    : before?.code_snapshot?.patch && sameCode(before.code_snapshot, start, repo) ? path.join(root, 'runs', before.run_id, before.code_snapshot.patch) : null;
  if (patch && !existsSync(patch)) {
    throw refuse('start_code_unrebuilt', `${path.relative(repo, patch).split(path.sep).join('/')} is gone, and it holds the files the loop's start commit does not, so the start code (${where}) cannot be rebuilt. It is not in Git.`);
  }
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-start-')));
  held.push(scratch);
  const built = rebuildTree(repo, { commit: start.commit ?? null, patch }, scratch);
  if (built.error) throw refuse('start_code_unrebuilt', `The start code (${where}) cannot be rebuilt: ${built.error}.`);
  const { tree, entries, changed } = built;
  const got = digest(entries.join('\0'));
  if (got !== want) {
    throw refuse('start_code_differs', `The code rebuilt from ${where} is not the loop's start code: its content digest is ${got}, and loop.json records ${want}${changed.length ? `; it differs from the start commit in ${changed.length > 10 ? `${changed.slice(0, 10).join(', ')} and ${changed.length - 10} more` : changed.join(', ')}` : ''}. A baseline on other code would not describe the code before the change. A .gitattributes rule such as export-ignore or export-subst changes what \`git archive\` writes.`);
  }
  let ignore = '';
  try { ignore = readFileSync(path.join(tree, '.dockerignore'), 'utf8'); } catch { /* reported below */ }
  if (!IGNORES_GENESIS.test(ignore)) {
    throw refuse('dockerignore_missing', `.dockerignore of the start code (${where}) ${ignore ? 'has no .genesis rule' : 'is missing'}, so an image built from that code would hold every package's expected results. No baseline is recorded on it as it is, and the start code stays fixed until a loop of this change is accepted or the user abandons the change. How to go on is the user's decision.`);
  }
  const uncommitted = Array.isArray(start.uncommitted_files) ? start.uncommitted_files : [];
  const fileDigests = Object.fromEntries(uncommitted.map((file) => {
    try { return [file, digest(readFileSync(path.join(tree, file)))]; } catch { return [file, 'deleted']; }
  }));
  return { tree, scratch, patch,
    snapshot: { commit: start.commit ?? null, changed_files: uncommitted, file_digests: fileDigests, digest: got, digest_of: 'content' },
    version: start.commit && !uncommitted.length ? start.commit : start.commit || uncommitted.length ? 'uncommitted' : 'empty',
    files: entries.map((entry) => entry.slice(entry.indexOf('\t') + 1)) };
}

// Application code rebuilt in scratch/code from a commit, as `git archive`
// writes it, with a patch Git applies on top: nothing is written into the
// project or its .git. Returns { tree, entries (the scratch index entries,
// generated files left out, as a run's content digest lists them), changed
// (files that differ from the commit) } or { error }.
function rebuildTree(repo, { commit, patch }, scratch) {
  const gitDir = spawnSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
  if (gitDir.status !== 0) return { error: `Git cannot read this project (${saidBy(gitDir)})` };
  const tree = path.join(scratch, 'code');
  mkdirSync(tree, { recursive: true });
  const failed = (step, result) => ({ error: `${step} failed: ${saidBy(result)}` });
  if (commit) {
    const archive = path.join(scratch, 'start.tar');
    const written = spawnSync('git', ['-C', repo, 'archive', '--format=tar', `--output=${archive}`, commit], { encoding: 'utf8' });
    if (written.status !== 0) return failed('git archive', written);
    const unpacked = spawnSync('tar', ['-xf', archive, '-C', tree], { encoding: 'utf8' });
    if (unpacked.status !== 0) return failed('tar', unpacked);
    rmSync(archive, { force: true });
  }
  // git apply runs in the rebuilt folder as a plain patch tool: no
  // repository is looked for above it.
  for (const file of [patch].flat().filter(Boolean)) {
    const applied = spawnSync('git', [...PATCH_CONFIG, 'apply', '--whitespace=nowarn', file], { cwd: tree, encoding: 'utf8',
      env: { ...outsideGit(), GIT_CEILING_DIRECTORIES: scratch } });
    if (applied.status !== 0) return failed(`git apply ${path.basename(file)}`, applied);
  }
  // The project's Git, with the rebuilt folder as its working tree and a
  // scratch index: it reads objects and writes only that index.
  const env = { ...outsideGit(), GIT_DIR: gitDir.stdout.trim(), GIT_WORK_TREE: tree, GIT_INDEX_FILE: path.join(scratch, 'index') };
  const git = (args, input) => spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    { cwd: tree, env, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  const step = (args, input) => {
    const result = git(args, input);
    if (result.status !== 0) throw Object.assign(new Error(`git ${args[0]} failed: ${saidBy(result)}`), { rebuild: true });
    return result.stdout;
  };
  try {
    step(['read-tree', ...(commit ? [commit] : ['--empty'])]);
    // git archive leaves a submodule's folder empty, so its code is not there.
    const links = nulPaths(step(['ls-files', '--stage', '-z'])).filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.slice(entry.indexOf('\t') + 1));
    if (links.length) return { error: `the code holds Git submodules (${links.join(', ')}), whose files \`git archive\` does not write` };
    // The files that differ from the commit, as `git status` lists them for a
    // run: modified and deleted ones, and untracked ones Git does not ignore.
    git(['update-index', '-q', '--refresh']);
    const changed = [...new Set([...nulPaths(step(['diff-files', '--name-only', '-z'])), ...nulPaths(step(['ls-files', '--others', '--exclude-standard', '-z']))])]
      .filter((file) => !isGenerated(file)).sort();
    if (changed.length) step(['update-index', '--add', '--remove', '--info-only', '-z', '--stdin'], changed.join('\0'));
    const entries = nulPaths(step(['ls-files', '--stage', '-z'])).filter((entry) => !isGenerated(entry.slice(entry.indexOf('\t') + 1)));
    return { tree, entries, changed };
  } catch (error) {
    if (error.rebuild) return { error: error.message };
    throw error;
  }
}

// The application code as it is now, copied into scratch: its commit and the
// patch of what that commit does not hold. { tree } or { error }.
function copyCurrentCode(repo, scratch) {
  const { snapshot } = codeSnapshot(repo);
  if (snapshot.commit === null && snapshot.changed_files === null) return { error: 'the project is not a Git repository' };
  const saved = savePatch(repo, snapshot, path.join(scratch, 'current.patch'));
  if (saved.error) return { error: saved.error };
  const built = rebuildTree(repo, { commit: snapshot.commit, patch: saved.patch ? path.join(scratch, saved.patch) : null }, scratch);
  return built.error ? built : { tree: built.tree };
}

// The current .genesis/edd/ and openspec/ laid over rebuilt code, as the
// working directory holds them: a package builds from the application root,
// with the kit's environment files under .genesis/edd/harness/. The run and
// check records of each change, which no build reads, are left out.
function overlayCurrent(repo, tree) {
  const edd = path.join(repo, '.genesis/edd');
  for (const folder of ['.genesis/edd', 'openspec']) {
    rmSync(path.join(tree, folder), { recursive: true, force: true });
    const from = path.join(repo, folder);
    if (!existsSync(from)) continue;
    mkdirSync(path.dirname(path.join(tree, folder)), { recursive: true });
    cpSync(from, path.join(tree, folder), { recursive: true, filter: (source) => {
      const parts = path.relative(edd, source).split(path.sep);
      return !(parts.length === 2 && !['..', 'harness'].includes(parts[0]) && ['runs', 'checks'].includes(parts[1]));
    } });
  }
}

// Run and check records are evidence of this machine, not source. Lines the
// user added to the file stay; only the missing ones are added.
export function ignoreRecords(repo) {
  const file = localPath(repo, '.genesis/edd/.gitignore');
  const wanted = ['/*/runs/', '/*/checks/', '/*/loop.json', '/*/loop-start.patch', '/*/decisions.jsonl', '__pycache__/'];
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new Set(text.split('\n').map((line) => line.trim()));
  const missing = wanted.filter((line) => !present.has(line));
  if (missing.length) writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

// The run.json of each run folder that has a readable one, by run id.
function runRecords(directory) {
  const folders = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const records = new Map();
  for (const folder of folders) {
    try {
      const run = readJSON(path.join(directory, folder, 'run.json'));
      if (run && typeof run === 'object' && !Array.isArray(run)) records.set(run.run_id ?? folder, run);
    } catch { /* not finished, or unreadable */ }
  }
  return { folders: new Set(folders), records };
}

// The record a run's start entry in the run index stands for, when its
// run.json cannot be read. A run whose folder is still there and that never
// finished is interrupted: the attempts it completed are read from its
// folder. Otherwise it is lost: its folder or its run.json is gone, so
// nothing it found can be read, and it counts as a failure of every gating
// check of its packages (sameCodeResults) and spends its recorded minutes.
function indexedRun(directory, name, start, finish, state) {
  const lost = state === 'lost';
  const folder = path.join(directory, start.run_id);
  const cases = (Array.isArray(start.cases) ? start.cases : []).filter((id) => typeof id === 'string').map((id) => ({ id }));
  // A package with steps is read by the layout its start entry recorded, or,
  // for an entry written before it kept one, by the package as it is now.
  const layoutOf = (id) => start.check_steps?.[id] ?? packageLayout(path.dirname(directory), id);
  const attempts = lost ? [] : cases.flatMap(({ id }) => readAttempts(path.join(folder, id, 'attempts.json')) ?? trialAttempts(path.join(folder, id), layoutOf(id)));
  const counted = usageOf(attempts);
  const usage = lost
    ? { minutes: typeof finish?.minutes === 'number' ? finish.minutes : null, attempt_minutes: null, attempts: 0, reported: 0,
      ...Object.fromEntries(USAGE_KEYS.map((key) => [key, null])) }
    : { minutes: counted.minutes, attempt_minutes: counted.minutes, attempts: counted.attempts, reported: counted.reported,
      ...Object.fromEntries(USAGE_KEYS.map((key) => [key, counted[key]])) };
  return {
    schema_version: '1.0', run_id: start.run_id, side: start.side ?? null, scope: start.scope ?? 'full', role: start.role ?? null,
    started_at: start.started_at ?? start.at ?? null, ...(finish?.at ? { finished_at: finish.at } : {}),
    execution_status: state, verdict: lost ? 'fail' : null, is_baseline: false,
    spec_snapshot: { id: name, sha256: start.spec ?? null },
    ...(start.side === 'base' ? {} : { loop: start.loop ?? null }),
    code_snapshot: start.code?.snapshot ?? null, code_identity: start.code?.identity ?? null,
    task_digest: start.task_digest ?? {}, run_digest: start.run_digest ?? {},
    environment_ref: { agent: start.agent ?? null, model: start.model ?? null, attempts_by_case: start.attempts ?? {}, run_plan: start.run_plan ?? null },
    cases, gating: start.gating ?? {},
    ...(start.check_steps && typeof start.check_steps === 'object' ? { check_steps: start.check_steps } : {}),
    ...(Array.isArray(start.expectations) ? { baseline_expectations: start.expectations } : {}),
    ...(start.cost_approval ? { cost_approval: start.cost_approval } : {}),
    ...(lost ? { lost: true } : { interrupted: true }), indexed: true, usage,
    ...(finish ? { recorded_finish: { execution_status: finish.execution_status ?? null, verdict: finish.verdict ?? null } } : {}),
  };
}

// Every run of a change: each run.json, and for every run the run index
// keeps whose run.json cannot be read, the record indexedRun gives, marked
// lost or interrupted. Oldest first. Runs written before the index existed
// are read from their folders alone.
export function readRuns(directory) {
  if (!existsSync(directory)) return [];
  const { folders, records } = runRecords(directory);
  const index = readRunIndex(directory);
  const name = path.basename(path.dirname(directory));
  const synthetic = [];
  for (const [id, { start, finish }] of index.runs) {
    if (records.has(id) || !start) continue;
    synthetic.push(indexedRun(directory, name, start, finish, folders.has(id) && !finish ? 'interrupted' : 'lost'));
  }
  return [...records.values(), ...synthetic].sort((a, b) => `${a.started_at}${a.run_id}`.localeCompare(`${b.started_at}${b.run_id}`));
}

// The state of the run index of a change: { index_exists, index_missing
// (runs that were written into the index exist, but the index is gone),
// broken_lines, lost, interrupted, unindexed (indexed runs the index no
// longer lists), altered (runs whose run.json differs from the one the index
// recorded when they finished) }. Read-only.
export function ledgerState(runsDirectory) {
  const { folders, records } = runRecords(runsDirectory);
  const index = readRunIndex(runsDirectory);
  const indexed = [...records.values()].filter((run) => run.indexed === true);
  const lost = [];
  const interrupted = [];
  const altered = [];
  const facts = (start, finish) => ({ run_id: start.run_id, side: start.side ?? null, scope: start.scope ?? 'full', started_at: start.started_at ?? start.at ?? null,
    cases: start.cases ?? [], loop: start.loop?.started_at ?? null, minutes: typeof finish?.minutes === 'number' ? finish.minutes : null, finished: Boolean(finish) });
  for (const [id, { start, finish }] of index.runs) {
    if (records.has(id)) {
      if (finish?.run_json) {
        let now = null;
        try { now = digest(readFileSync(path.join(runsDirectory, id, 'run.json'))); } catch { /* read above */ }
        if (now && now !== finish.run_json) altered.push(id);
      }
      continue;
    }
    if (!start) {
      lost.push({ run_id: id, side: null, scope: null, started_at: null, cases: [], loop: null, minutes: typeof finish?.minutes === 'number' ? finish.minutes : null,
        finished: Boolean(finish), start_unreadable: true });
      continue;
    }
    if (folders.has(id) && !finish) interrupted.push(facts(start, finish));
    else lost.push(facts(start, finish));
  }
  return { index_exists: index.exists, index_missing: !index.exists && indexed.length > 0, broken_lines: index.broken,
    lost, interrupted, unindexed: index.exists ? indexed.filter((run) => !index.runs.has(run.run_id)).map((run) => run.run_id) : [], altered };
}

// Facts of a ledger state for a message, or null when there is nothing to say.
export function ledgerText(state) {
  const parts = [
    ...(state.index_missing ? ['runs/index.jsonl is gone, though runs were recorded in it, so a run whose folder was deleted since cannot be counted'] : []),
    ...(state.unindexed.length ? [`runs/index.jsonl no longer lists ${state.unindexed.join(', ')}, which were recorded in it, so it was replaced or cut`] : []),
    ...(state.broken_lines.length ? [`lines ${state.broken_lines.join(', ')} of runs/index.jsonl cannot be read`] : []),
    ...(state.lost.length ? [`${state.lost.map((entry) => entry.run_id).join(', ')} ${state.lost.length === 1 ? 'is' : 'are'} in the run index but ${state.lost.length === 1 ? 'its folder or run.json is' : 'their folders or run.json are'} gone: each counts as a failure of every gating check of its packages on its code, and spends its recorded minutes`] : []),
    ...(state.interrupted.length ? [`${state.interrupted.map((entry) => entry.run_id).join(', ')} started and never finished: the attempts ${state.interrupted.length === 1 ? 'it' : 'they'} completed count`] : []),
    ...(state.altered.length ? [`run.json of ${state.altered.join(', ')} differs from the one recorded when ${state.altered.length === 1 ? 'it' : 'they'} finished`] : []),
  ];
  return parts.length ? `${parts.join('; ')}.` : null;
}

// Run folders with no readable run.json. A run writes it last, so these are
// runs that were interrupted, or one still running. readRuns reads those the
// run index keeps as interrupted runs.
export function unfinishedRuns(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .filter((entry) => { try { readJSON(path.join(directory, entry.name, 'run.json')); return false; } catch { return true; } })
    .map((entry) => entry.name).sort();
}

export const unfinishedWarning = (names) => `Run folders without a readable run.json, left by a run that was interrupted or is still running: ${names.join(', ')}. A run the run index lists counts as interrupted: the attempts it completed count for its code. The folders hold that evidence and their logs.`;

// No package can run. A head run is refused with this gap. unchecked names
// the packages that wait only for `eval check`; fresh says that this is a new
// project with no loop yet, whose packages are connected to an entry skeleton
// before anything else. inLoop is kept for callers; a loop changes nothing
// here.
export const noRunnableCase = (inLoop = false, { unchecked = [], fresh = false } = {}) => ({ code: 'no_runnable_case', kind: 'artifact', owner: 'agent', layer: 'package',
  unchecked, ...(fresh ? { fresh: true } : {}), in_loop: Boolean(inLoop),
  message: `No package is ready to run.${unchecked.length ? ` ${unchecked.join(', ')} ${unchecked.length === 1 ? 'waits' : 'wait'} only for its \`eval check\` record.` : ''} \`eval validate\` lists what each package still needs.${fresh ? ' This is a new project: its packages run once they are connected to an entry of the program.' : ''}` });

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
export const attemptsUndecided = (needs, model) => ({ code: 'attempts_undecided', kind: 'business', owner: 'user', layer: 'confirmation',
  live: needs.live, undeclared: needs.undeclared, model: model ?? null,
  message: [
    ...(needs.live.length ? [`${declare(needs.live)} a live dependency, so ${needs.live.length === 1 ? 'its' : 'their'} results can differ from one attempt to the next.`] : []),
    ...(needs.undeclared.length ? [`The evaluated agent runs with model ${model}, but ${declare(needs.undeclared)} no live dependency.`] : []),
    'How many attempts each package with a live dependency runs, at the baseline and in the final run of a loop, is the user\'s decision: only the number a checks confirmation records (`eval confirm --attempts N`) settles it, not a run\'s own --attempts. 1 is allowed, and an acceptance then says it rests on one attempt. Packages without a live dependency run once.',
    ...(needs.undeclared.length ? [`A scenario of ${needs.undeclared.join(', ')} that calls the model is a live dependency of that package.`] : []),
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
// (loop_attempts). A budget charges each run its wall time, which is more
// than the time of its attempts, so with a baseline at hand an estimate from
// attempts adds the baseline's per-run overhead, its wall time less the time
// of its attempts, to each run, and says so in run_overhead ({ minutes,
// baseline }). Read-only.
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
  // The fixtures and the probe of the last eval check, which builds the
  // environment and runs the verifier as a run does.
  const checked = (id) => {
    let last = null;
    try { last = readJSON(path.join(root, 'checks', id, 'check.json')); } catch { return []; }
    const fixtures = Array.isArray(last?.fixtures) ? last.fixtures : [];
    return [...fixtures.flatMap((fixture) => (typeof fixture?.name === 'string'
      ? readAttempts(path.join(root, 'checks', id, fixture.name, 'attempts.json')) ?? [] : [])),
    ...(last?.probe ? readAttempts(path.join(root, 'checks', id, PROBE_FOLDER, 'attempts.json')) ?? [] : [])];
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
    // What the baseline's run took beyond its attempts, never below 0.
    const usage = base?.is_baseline ? runUsage(path.join(root, 'runs'), base) : null;
    const overhead = isNumber(usage?.minutes) && isNumber(usage?.attempt_minutes) ? tenths(Math.max(0, usage.minutes - usage.attempt_minutes)) : 0;
    const withOverhead = (entry) => (overhead ? { ...entry, minutes: tenths(entry.minutes + overhead) } : entry);
    const final = withOverhead(run(planned));
    return { basis,
      ...(overhead ? { run_overhead: { minutes: overhead, baseline: base.run_id } } : {}),
      per_attempt: Object.fromEntries(ready.map((item) => {
        const { minutes, cost_usd: cost, basis: from } = figures[item.id];
        return [item.id, { minutes: tenths(minutes), cost_usd: cost === null ? null : money(cost), basis: from }];
      })),
      screen: withOverhead(run(once)), final, full: final };
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
    // Host variables the user did not allow (--allow-env) are left out.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !(options.withheld ?? []).includes(key))), ...options.env,
      GENESIS_EDD_REPO: options.repo, GENESIS_EDD_HARNESS: options.harness,
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
  // A package with steps records each check at its own step.
  const layout = stepLayout(item.directory, checks);
  // The gating checks the helper counts in the reward it writes: those
  // declared gating with gate or gate_code. A judge is recorded as a
  // diagnostic check there, also when the user made its line gating.
  const helperGating = checks.filter((check) => (check.kind === JUDGE_KIND ? check.declared_role ?? null : check.role) === 'gating');
  const rewardOf = (file) => {
    let value;
    try { value = readJSON(file).reward; } catch { /* reported by the comparison */ }
    return value;
  };
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
    // A step that raised makes the attempt an error, as an exception of the
    // trial itself does; the entry names that step.
    const raised = trialException(outcome);
    if (raised) {
      entry.status = 'error';
      if (raised.step) entry.step = raised.step;
      entry.reason = `${raised.step ? `step ${raised.step}: ` : ''}${raised.info.exception_type}: ${raised.info.exception_message}`;
      if (execution.status === 'completed') execution = { status: 'error', reason: entry.reason };
    }
    // A package with steps has a verifier for each step.
    const { folders: verifiers, results } = verifierResults(trial.directory, layout);
    // Harbor still grades a trial whose agent or harness raised, as after a
    // rate limit. What its verifier recorded, pass or fail, is no result of
    // the code: every check of that attempt is unknown.
    const completed = entry.status === 'completed';
    recorded.push(completed ? results : results.map((found) => ({ ...found, result: 'unknown',
      evidence: `Attempt ${entry.attempt} did not complete (${entry.reason}), so what its verifier recorded${RESULTS.includes(found?.result) ? ` (${found.result})` : ''} is no result of the code. ${found?.evidence ?? ''}`.trim() })));
    let reward = null;
    let rewards = null;
    const passed = (check) => results.find((found) => found?.id === check.id)?.result === 'pass';
    if (layout.steps.length) {
      // Each step's verifier writes its own reward, from the gating checks
      // it recorded: 0 for a step with none. Each is compared with the
      // gating checks at that step.
      rewards = {};
      for (const step of layout.steps) {
        const file = path.join(trial.directory, 'steps', step, 'verifier', 'reward.json');
        if (!existsSync(file)) continue;
        const value = rewardOf(file);
        rewards[step] = typeof value === 'number' ? value : null;
        reward = rewards[step];
        const own = helperGating.filter((check) => layout.at[check.id] === step);
        const expected = own.length && own.every(passed) ? 1 : 0;
        if (value !== expected) {
          warnings.add(`${item.id}: the verifier of step ${step} wrote reward ${value}, but the gating results at that step give ${expected}. Check that steps/${step}/tests/test.sh uses gate and note as checks.json declares for the checks at ${step}.`);
        }
      }
    } else {
      const rewardFile = verifiers.map((directory) => path.join(directory, 'reward.json')).filter(existsSync).pop();
      if (rewardFile) {
        const value = rewardOf(rewardFile);
        reward = typeof value === 'number' ? value : null;
        const expected = helperGating.every(passed) ? 1 : 0;
        if (value !== expected) {
          warnings.add(`${item.id}: the verifier wrote reward ${value}, but its gating results give ${expected}. Check that tests/test.sh uses gate and note as checks.json declares.`);
        }
      }
    }
    // What the adapter reported it used, when it reported anything.
    const reported = trialUsage(outcome);
    const usage = Object.fromEntries(['n_input_tokens', 'n_cache_tokens', 'n_output_tokens', 'cost_usd']
      .filter((key) => reported?.[key] !== null && reported?.[key] !== undefined).map((key) => [key, reported[key]]));
    const graded = Object.fromEntries(checks.map((check) => {
      const value = results.find((found) => found?.id === check.id)?.result;
      return [check.id, RESULTS.includes(value) ? value : 'unknown'];
    }));
    // An attempt that did not complete keeps what its verifier recorded as
    // graded, for its logs; its results are unknown.
    return { ...entry, results: completed ? graded : unknown(), ...(!completed && results.length ? { graded } : {}),
      reward, ...(rewards ? { rewards } : {}), started_at: outcome.started_at ?? null, finished_at: outcome.finished_at ?? null,
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
// named by a NUL and 'added' or 'removed'. For a baseline on the rebuilt
// start code (rebuilt, from rebuildStart), the code is that folder, whose
// files are watched by when each was last written: the working directory may
// change meanwhile, and no run builds from it.
function watchRun(repo, name, snapshot, evalStart, rebuilt = null) {
  const root = eddDirectory(repo, name);
  const kit = kitDirectory(repo);
  const codeRoot = rebuilt?.tree ?? repo;
  let codeFiles = rebuilt?.files ?? [];
  if (!rebuilt) {
    const listed = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const tracked = listed.status === 0 ? listed.stdout.split('\0') : [];
    codeFiles = [...new Set([...tracked, ...(snapshot.changed_files ?? [])])].filter((file) => file && !isGenerated(file));
  }
  const code = stampsOf(codeRoot, codeFiles);
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
      code: restamped(code, codeRoot).length > 0 || (!rebuilt && sameCode(snapshot, codeSnapshot(repo).snapshot, repo) === false),
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

// The base records of a Spec export a loop can rest on: full ones whose
// record is there, oldest first. A partial base record (--baseline --case)
// and a trial never are.
const fullBaseRecords = (runs, spec) => runs.filter((run) => run.side === 'base' && run.spec_snapshot?.sha256 === spec && usableRun(run) && (run.scope ?? 'full') === 'full');

// The baseline recorded for the current Spec export, if any: the latest full
// base record, when it ran or records that nothing could run. A later attempt
// that could not execute hides an earlier one: record the baseline again.
// Read-only.
export function recordedBaseline(repo, name, spec) {
  const base = fullBaseRecords(readRuns(path.join(eddDirectory(repo, name), 'runs')), spec).pop() ?? null;
  return base && (base.is_baseline || base.execution_status === 'not_run') ? base : null;
}

// The latest full base record of a Spec export that is a baseline, or records
// that nothing could run, whatever came after it, and the later full base
// attempts that are not, for a comparison outside a loop. { base, later }.
export function latestValidBaseline(runs, spec) {
  const records = fullBaseRecords(runs, spec);
  const valid = records.filter((run) => run.is_baseline || run.execution_status === 'not_run');
  const base = valid.at(-1) ?? null;
  return { base, later: base ? records.slice(records.indexOf(base) + 1) : records };
}

// The key of a line's proof in what lineProofs returns.
export const proofKey = (id, then) => `${id}\n${thenKey(then)}`;

// What proves, for each line a program checks, that its checks can fail:
// { sources, baseline, counterexamples, missing } by proofKey. sources lists
// what holds, in this order:
// - baseline_failure: every gating check of the line failed, with evidence,
//   in an attempt that completed at the baseline base, a full base record
//   that ran the package as head holds it (samePackage), the package of the
//   run that is accepted; every base record of this Spec export expected that
//   check to fail, so the expectation was written before any baseline; and no
//   run on the baseline's code, of any kind, saw the check pass, so the
//   failure is no draw of a check that also passes there. A new project's
//   baseline runs on an entry with no behavior, so it proves nothing there.
//   A check bound to several lines, as a then_group check is, proves none of
//   them by failing: each line needs a counterexample that breaks it alone.
//   A line a code test checks is proved by its failure like any other.
// - counterexample: a reviewer's counterexample of the line that the last
//   `eval check` of the package as it is proved (counterexamples names them);
//   for a line a code test checks, only a code patch counts.
// Trials are never a source. missing says why each source does not hold,
// when none does. head defaults to the packages as eval validate lists them.
// A line the user judges needs no proof. When a judge check judges it, its
// proof is here too, with judge: true and the judge checks in place of the
// gating ones: it counts only once the user made that check gating
// (judge_gating), and then that line is held like any gating line. Its
// counterexample is a reviewer's fixture whose then names the line, that
// expects fail for those judge checks and pass or unknown for every gating
// check of the package. Read-only.
export function lineProofs(repo, name, evals, { base = null, head = null } = {}) {
  const root = eddDirectory(repo, name);
  const runsDirectory = path.join(root, 'runs');
  const fresh = requireProject(repo).mode === 'new';
  const holder = head ?? casesDigests(evals.cases);
  const now = new Map(evals.cases.map((item) => [item.id, item]));
  const all = readRuns(runsDirectory);
  const bases = all.filter((run) => run.spec_snapshot?.sha256 === evals.spec && run.side === 'base');
  const baseCode = base && usableRun(base) ? codeIdentity(base.code_snapshot, repo) : null;
  // Every pass on the baseline's code, from runs of any kind.
  const passes = baseCode ? sameCodeResults(repo, runsDirectory, evals.spec, all).filter((entry) => entry.result === 'pass' && entry.code === baseCode) : [];
  // How many lines of a package each gating check is bound to.
  const boundTo = new Map();
  for (const row of (evals.then_lines ?? []).filter((entry) => entry.status === 'gating')) {
    for (const entry of row.gating ?? []) boundTo.set(`${row.case}\n${entry.check}`, (boundTo.get(`${row.case}\n${entry.check}`) ?? 0) + 1);
  }
  const records = new Map();
  const recordOf = (id) => {
    if (!records.has(id)) records.set(id, readCheckRecord(repo, name, id));
    return records.get(id);
  };
  const read = (file) => { try { return readJSON(file); } catch { return null; } };
  // A line of scenario.manual that a judge check judges.
  const judgedLine = (row) => row.status === 'manual' && Array.isArray(row.judges) && row.judges.some((entry) => typeof entry?.check === 'string');
  const proofs = new Map();
  for (const row of (evals.then_lines ?? []).filter((entry) => entry.status === 'gating' || judgedLine(entry))) {
    const judge = judgedLine(row);
    const checks = judge ? row.judges.map((entry) => entry.check).filter((check) => typeof check === 'string') : (row.gating ?? []).map((entry) => entry.check);
    // Checks bound to several lines: a then_group check, or one counted on
    // more than one line.
    const grouped = judge ? [] : checks.filter((check) => (boundTo.get(`${row.case}\n${check}`) ?? 0) > 1
      || (row.gating ?? []).some((entry) => entry.check === check && entry.group));
    if (!judge && row.grouped === true && !grouped.length) grouped.push(...checks);
    const codeLine = !judge && (row.code_test === true || (row.gating ?? []).some((entry) => entry.kind === CODE_KIND));
    const missing = [];
    // The real failure before the change.
    let failed = false;
    if (fresh) missing.push('this is a new project, whose baseline runs on code with no behavior yet');
    else if (!base) missing.push('no baseline is recorded for this Spec export');
    else if (!usableRun(base) || isTrial(base) || base.side !== 'base') missing.push(`${base.run_id} is no base record whose results can be read`);
    else if ((base.scope ?? 'full') !== 'full') missing.push(`the base record ${base.run_id} is partial`);
    else if (!base.is_baseline) missing.push(`the baseline ${base.run_id} records that nothing could run`);
    else if (!(base.cases ?? []).some((entry) => entry.id === row.case)) missing.push(`the baseline ${base.run_id} did not run ${row.case}`);
    else if (!samePackage(digestsAt(base, row.case), digestsAt(holder, row.case))) missing.push(`the baseline ${base.run_id} ran another version of ${row.case}`);
    else if (grouped.length) missing.push(`${grouped.join(', ')} ${grouped.length === 1 ? 'is' : 'are'} bound to several lines, so a failure shows no one line can fail`);
    else {
      const folder = path.join(runsDirectory, base.run_id, row.case);
      const attempts = read(path.join(folder, 'attempts.json'))?.attempts;
      const results = read(path.join(folder, 'check-results.json'))?.results;
      for (const check of checks) {
        const expected = (base.baseline_expectations ?? []).find((entry) => entry.case === row.case && entry.check === check)?.expected ?? 'any';
        const earlier = bases.find((run) => run.run_id !== base.run_id && Array.isArray(run.baseline_expectations) && run.baseline_expectations.some((entry) => entry.case === row.case && entry.check === check
          && (entry.expected ?? 'any') !== 'fail'));
        const passed = passes.find((entry) => entry.case === row.case && entry.check === check);
        const evidence = (Array.isArray(results) ? results : []).find((entry) => entry?.id === check);
        if (expected !== 'fail') missing.push(`the baseline ${base.run_id} expected ${check} to ${expected}, not fail`);
        else if (earlier) missing.push(`the base record ${earlier.run_id} expected ${check} to ${(earlier.baseline_expectations.find((entry) => entry.case === row.case && entry.check === check).expected) ?? 'any'}, so fail was not written before every baseline`);
        else if (passed) missing.push(`${check} passed on the baseline's code in ${passed.run_id === base.run_id ? `an attempt of the baseline ${base.run_id}` : `${passed.run_id}${passed.side === 'trial' ? ' (a trial)' : ''}`}`);
        else if (!(Array.isArray(attempts) ? attempts : []).some((attempt) => attempt?.status === 'completed' && attempt.results?.[check] === 'fail')) {
          missing.push(`${check} did not fail in an attempt that completed at the baseline ${base.run_id} (it got ${evidence?.result ?? 'no result'})`);
        } else if (evidence?.result !== 'fail' || typeof evidence.evidence !== 'string' || !evidence.evidence.trim() || evidence.evidence === 'No result was recorded for this check.') {
          missing.push(`${check} failed at the baseline ${base.run_id} without evidence`);
        }
      }
      failed = !missing.length;
    }
    // A reviewer's counterexample the last eval check proved.
    const item = now.get(row.case);
    const last = recordOf(row.case);
    // An edit to the adapter alone keeps the proof (fixturesProvedFor); so
    // does a fixture added since, which is proved on its own.
    const current = Boolean(last && item) && (fixturesProvedFor(last, item) || Boolean(item.probe_digest));
    let declaredFixtures = [];
    let declaredChecks = [];
    try {
      const declared = readJSON(path.join(root, 'evals', row.case, 'tests/checks.json'));
      declaredFixtures = Array.isArray(declared?.fixtures) ? declared.fixtures : [];
      declaredChecks = Array.isArray(declared?.checks) ? declared.checks : [];
    } catch { /* none */ }
    // eval validate lists the counterexamples of a line a gating check
    // verifies; those of a judged line are read from the fixtures here.
    const judgeCounterexamples = () => {
      // Every gating check of the package passes or cannot tell; a code test
      // it leaves out rests on the code, not on the script.
      const own = new Set(checks);
      const others = declaredChecks.filter((check) => check?.role === 'gating' && typeof check.id === 'string' && !own.has(check.id));
      return declaredFixtures.filter((fixture) => ['review', 'self-review'].includes(fixture?.origin) && typeof fixture.then === 'string'
        && thenKey(fixture.then) === thenKey(row.then) && isObject(fixture.expect) && checks.every((check) => fixture.expect[check] === 'fail')
        && others.every((check) => (check.kind === CODE_KIND && fixture.expect[check.id] === undefined) || ['pass', 'unknown'].includes(fixture.expect[check.id])))
        .map((fixture) => fixture.name);
    };
    const written = judge ? judgeCounterexamples()
      : (row.counterexamples ?? []).filter((entry) => !codeLine || entry.code_patch === true).map((entry) => entry.fixture);
    const ownDigest = (fixture) => {
      const found = (Array.isArray(declaredFixtures) ? declaredFixtures : []).find((entry) => entry?.name === fixture);
      return found ? fixtureDigest(path.join(root, 'evals', row.case), found) : null;
    };
    const provedFixture = (fixture) => (last?.fixtures ?? []).some((entry) => entry?.name === fixture && entry.ok === true
      && (fixturesProvedFor(last, item) || (Boolean(entry.package_digest) && entry.package_digest === item?.probe_digest
        && Boolean(entry.fixture_digest) && entry.fixture_digest === ownDigest(fixture))));
    const proved = written.filter((fixture) => current && provedFixture(fixture));
    if (!written.length) {
      missing.push(`no reviewer counterexample fails only this line${codeLine ? ' as a code patch its code tests fail on' : judge ? `, naming it in its then and expecting fail for ${checks.join(', ')}` : ''}`);
    } else if (!proved.length) missing.push(`${written.join(', ')} ${written.length === 1 ? 'is' : 'are'} not proved by the last \`eval check\` of ${row.case} as it is`);
    const sources = [...(failed ? ['baseline_failure'] : []), ...(proved.length ? ['counterexample'] : [])];
    proofs.set(proofKey(row.case, row.then), { sources, baseline: failed ? base.run_id : null, counterexamples: proved, ...(grouped.length ? { group_checks: grouped } : {}),
      ...(judge ? { judge: true, judge_checks: checks } : {}), ...(sources.length ? {} : { missing }) });
  }
  return proofs;
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
  const run = readRuns(path.join(eddDirectory(repo, name), 'runs')).find((entry) => entry.run_id === loop.baseline && entry.side === 'base' && usableRun(entry)) ?? null;
  return { run, gap: run ? null : { code: 'loop_baseline_missing', kind: 'artifact', owner: 'agent', layer: 'baseline', run: loop.baseline,
    start_code: restoreHint(name, loop, null),
    message: `The loop for this Spec compares every run with ${loop.baseline}, whose record is no longer in runs/, so the loop has ended (baseline_missing). A new loop needs a baseline on the loop's start code (${restoreHint(name, loop, null)}), which \`run start --baseline --at-start\` rebuilds outside the project, and the user's consent.` } };
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
// their loop is placed by its Spec and start time. A trial is never one, nor
// is a run whose record is lost or that never finished: loopTrials and
// loopLostRuns list those of a loop.
export const ofLoop = (run, loop) => run.side === 'head' && usableRun(run) && run.spec_snapshot?.sha256 === loop.spec && run.started_at >= loop.started_at
  && (run.loop === undefined || run.loop?.started_at === loop.started_at);

// The user's acceptance accepted.json records for this change, committed
// with it, or null when there is none or it cannot be read. Read-only.
export function acceptedRecord(repo, name) {
  const file = path.join(eddDirectory(repo, name), 'accepted.json');
  if (!existsSync(file)) return null;
  try { return readJSON(file); } catch { return null; }
}

// The gap code_holds_accepted_change when the code in the working directory
// is the code the user accepted for this Spec export, as accepted.json
// records it (an earlier acceptance of the export kept under earlier
// included), and not also the start code of that loop, or null. Read-only.
export function acceptedHolding(repo, name, spec) {
  const record = acceptedRecord(repo, name);
  if (!record || !spec) return null;
  const acceptances = [record, ...(Array.isArray(record.earlier) ? record.earlier : [])].filter((entry) => entry?.spec?.sha256 === spec);
  if (!acceptances.length) return null;
  const now = codeIdentity(codeSnapshot(repo).snapshot, repo);
  const held = now ? acceptances.find((entry) => codeIdentity(acceptedSnapshot(entry), repo) === now) : null;
  if (!held) return null;
  const start = held.start_code ?? null;
  // A change accepted with no code change leaves the start code in place, and
  // a base record on it describes the code before the change.
  if (start?.digest === now) return null;
  // The patch is not committed, so a fresh clone does not hold it.
  const kept = Array.isArray(start?.uncommitted_files) && start.uncommitted_files.length ? `; it held ${start.uncommitted_files.join(', ')}` : '';
  const patch = start?.patch ? ` plus ${start.patch}${existsSync(path.join(repo, start.patch)) ? '' : `, which is not in this working directory${kept}`}` : '';
  const where = start?.commit ? `commit ${start.commit.slice(0, 7)}${patch}` : 'the commit its first loop started on';
  return { code: 'code_holds_accepted_change', kind: 'artifact', owner: 'agent', layer: 'baseline', run: held.run_id ?? null, code_digest: now,
    path: `.genesis/edd/${name}/accepted.json`, start_code: start,
    message: `This code holds the change the user accepted for this Spec export: its content digest is the one .genesis/edd/${name}/accepted.json records for run ${held.run_id ?? 'unknown'}. A base record on it would describe the change, not the code before it. A baseline for this change runs on its start code, ${where}.` };
}

// Whether the user accepted a run of this loop: accepted.json belongs to it.
// Read-only.
export function loopAccepted(repo, name, loop) {
  const record = loop ? acceptedRecord(repo, name) : null;
  if (!record) return false;
  const runs = readRuns(path.join(eddDirectory(repo, name), 'runs')).filter((run) => ofLoop(run, loop) && (run.scope ?? 'full') === 'full');
  return acceptedIn(record, loop, runs);
}

// The loop the latest head run of this change was made in, as that run
// recorded it, for when loop.json is missing or cannot be read: runs/ keeps
// what every base record and new loop must hold to, the loop's start code and
// baseline. The run index keeps it too for a run whose folder is gone. Its
// budget and the loops before it were only in loop.json. Null when no head
// run names a loop.
export function recordedLoop(repo, name) {
  const named = readRuns(path.join(eddDirectory(repo, name), 'runs')).filter((run) => ['head', 'trial'].includes(run.side) && run.loop?.started_at && run.loop.start_code);
  const latest = named.sort((a, b) => a.loop.started_at.localeCompare(b.loop.started_at) || String(a.started_at).localeCompare(String(b.started_at))).at(-1);
  if (!latest) return null;
  const runs = named.filter((run) => run.loop.started_at === latest.loop.started_at).map((run) => run.run_id);
  return { change: name, started_at: latest.loop.started_at, spec: latest.spec_snapshot?.sha256 ?? null, baseline: latest.loop.baseline ?? latest.base_run ?? null,
    base_commit: latest.loop.start_code.commit ?? null, start_code: latest.loop.start_code, recovered_from: runs };
}

// What a message adds when the loop it names is known from its head runs
// only, as recordedLoop reads it: nothing otherwise.
export const recoveredText = (loop) => (loop?.recovered_from
  ? ` loop.json is missing or cannot be read, so this comes from the head runs of the loop that started at ${loop.started_at} (${loop.recovered_from.join(', ')}); loop.json alone kept that loop's budget and the loops before it, and it is not in Git.` : '');

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
  const pinned = readRuns(path.join(eddDirectory(repo, name), 'runs')).filter(usableRun).find((run) => run.run_id === loop.baseline) ?? null;
  return pinned?.is_baseline ? startCode(loop.base_commit ?? null, pinned.code_snapshot, repo) : null;
}

// Whether the user abandoned this change after a time: the latest
// change_abandon decision is not older than at.
const abandonedSince = (repo, name, at) => {
  const abandoned = latestDecision(eddDirectory(repo, name), 'change_abandon');
  return Boolean(abandoned) && Date.parse(abandoned.at) >= Date.parse(at);
};

// The start code every base record and every new loop of this change keeps:
// the start code of the loop in loop.json, whatever Spec export it ran for,
// until the user accepted that loop or abandoned the change after it started
// (change_abandon). A new loop copies it, so loop.json holds the start code
// of the change's first loop not yet accepted. Without a readable loop.json,
// the loop its head runs name keeps the pin. { loop, start }, or null once
// that loop is accepted, the change abandoned, or when no loop kept a start
// code.
export function pinnedStart(repo, name) {
  const loop = loopRecordOf(repo, name);
  if (!loop || loopAccepted(repo, name, loop)) return null;
  if (loop.started_at && abandonedSince(repo, name, loop.started_at)) return null;
  const start = loopStartCode(repo, name, loop);
  return start?.digest ? { loop, start } : null;
}

// Whether head runs of this change, and trials of its application code, are
// refused: its latest loop, whatever Spec export it ran for, ended or
// stopped without an acceptance of the user that still covers it, no loop
// started after it, and the user did not abandon the change since it
// started. A loop whose loop.json is gone, known from its runs or the run
// index, counts as ended. A new Spec export does not lift the lock. Null, or
// { code: change_locked, kind, layer: loop, owner: user, loop: { started_at,
// spec }, reason, ended_at, acceptance?, message, unlocks }. acceptance names
// the run the user accepted when that acceptance no longer covers the loop.
// spec is the current export, when the caller knows it. Read-only.
export function changeLock(repo, name, { spec } = {}) {
  let status = null;
  try { status = loopStatus(repo, name); } catch { /* read the records below */ }
  // A loop that ended only on its budget also goes on once the user revises
  // its budget.
  const locked = (loop, reason, endedAt, acceptance = null) => ({ code: 'change_locked', kind: 'business', layer: 'loop', owner: 'user',
    loop: { started_at: loop.started_at ?? null, spec: loop.spec ?? null }, reason: reason ?? null, ended_at: endedAt ?? null,
    ...(acceptance ? { acceptance: { run_id: acceptance.run_id ?? null, by: acceptance.by ?? null, ref: acceptance.ref ?? null, at: acceptance.at ?? null, outdated: true } } : {}),
    unlocks: ['a new loop the user agreed to (loop start --by --ref)',
      ...(reason === 'stop_budget' ? ['a revised budget the user gives this loop, which ended only on its budget (loop budget --by --ref)'] : []),
      'the user abandoning the change (change abandon --by --ref)'],
    message: `The latest loop of this change, started at ${loop.started_at ?? 'an unknown time'}, ended${reason ? ` (${reason})` : ''}${endedAt ? ` at ${endedAt}` : ''}${acceptance
      ? `. The user accepted run ${acceptance.run_id ?? 'unknown'} of it${acceptance.by ? ` (${acceptance.by}${acceptance.ref ? `, ${acceptance.ref}` : ''})` : ''}, and that acceptance no longer covers the loop`
      : ' without the user\'s acceptance'}. Until a new loop starts with the user's consent,${reason === 'stop_budget' ? ' the user revises the budget of this loop, which ended only on its budget (`loop budget`),' : ''} or the user abandons the change, \`run start\` refuses head runs and trials of the application code of this change, whatever Spec export they are for. Base records and trials on the start code (--at-start) are not refused.` });
  if (status?.loop) {
    const loop = { ...status.loop, spec: status.loop.spec ?? status.spec ?? null };
    if (status.accepted === true || (status.accepted && typeof status.accepted === 'object')) return null;
    let phase = null;
    try { phase = loopPhase(status); } catch { /* read ended below */ }
    const ended = status.ended ?? null;
    if (phase !== 'ended' && !ended) return null;
    if (loop.started_at && abandonedSince(repo, name, loop.started_at)) return null;
    // An acceptance that no longer covers the loop, once it ended, is named
    // with the lock.
    const outdated = status.acceptance && status.acceptance.holds !== true ? status.acceptance : null;
    return locked(loop, ended?.reason ?? ended?.code ?? status.situation?.reason ?? null, ended?.at ?? null, outdated);
  }
  const record = loopRecordOf(repo, name);
  if (!record?.started_at) return null;
  if (loopAccepted(repo, name, record)) return null;
  if (abandonedSince(repo, name, record.started_at)) return null;
  // loop.json is there and of the current export, but its status could not be
  // read: run start reads that loop's own status.
  if (!record.recovered_from) {
    let current = spec;
    if (current === undefined) {
      try { current = validateEval(repo, name).spec; } catch { current = null; }
    }
    if (current && record.spec === current) return null;
    if (record.ended_at || record.ended) return locked(record, record.ended?.reason ?? 'ended', record.ended_at ?? record.ended?.at ?? null);
    return locked(record, 'spec_exported_again', null);
  }
  return locked(record, 'loop_record_missing', null);
}

// The probe of a package: one run through Harbor with its nop agent, which does
// nothing, in the evaluated agent's place. Every gating check must come out
// unknown: a verifier that judges a result when nothing was done reads no
// evidence of the run, or makes its own, for example by starting the program.
// A code-level check runs the project's own tests against the application
// code, with no adapter, so it judges a result under the probe too: the rule
// does not apply to it. A judge check is diagnostic unless the user made it
// gating, and then it is held to the rule like any other.
// { run_digest, probe_digest, checked_at, agent, execution, results,
// unexpected, ok, usage }. probe_digest is the run digest without harness.json
// and the adapter modules, which the nop agent never runs.
function probePackage(repo, item, directory, checks, target, options) {
  const outcome = runCase(harborCommand(), { id: item.id, directory }, checks, target, {
    agent: 'nop', yes: options.yes === true, withheld: options.withheld, timeout: options.timeout ?? 30, harness: kitDirectory(repo), repo });
  const got = Object.fromEntries(outcome.results.map((entry) => [entry.id, entry.result]));
  const unexpected = checks.filter((check) => check.role === 'gating' && check.kind !== CODE_KIND && got[check.id] !== 'unknown').map((check) => ({ check: check.id, result: got[check.id] }));
  return { run_digest: item.run_digest, probe_digest: item.probe_digest ?? null, checked_at: new Date().toISOString(), agent: 'nop', execution: outcome.execution,
    results: got, unexpected, ok: outcome.execution.status === 'completed' && !unexpected.length, usage: usageOf(outcome.attempts),
    ...(checks.some((check) => check.kind === CODE_KIND) ? { exempt: checks.filter((check) => check.kind === CODE_KIND).map((check) => check.id) } : {}) };
}

// Whether a fixture is a code-level counterexample: a patch to the
// application code that a code-level check must fail on, rather than a
// script that stands in for the evaluated agent. eval validate decides it and
// lists those fixtures of the package (code_patches); fixturePatch finds the
// patch.
const patchFixture = (item, fixture) => Array.isArray(item?.code_patches) && item.code_patches.includes(fixture?.name);

// A code-level counterexample: the patch applied to a copy of the application
// code as it is now, outside the project, with the current .genesis/edd/ and
// openspec/ over it; Harbor's nop agent in the evaluated agent's place; and
// the package's verifier run there, as it runs the project's own tests
// against that code. The project and its .git are not written.
function runPatchFixture(repo, item, directory, checks, target, fixture, options) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-fixture-')));
  try {
    const file = fixturePatch(directory, fixture);
    const copied = file ? copyCurrentCode(repo, scratch) : { error: `no patch of ${fixture.name} is under tests/fixtures/` };
    const applied = copied.error ? null : spawnSync('git', [...PATCH_CONFIG, 'apply', '--whitespace=nowarn', file],
      { cwd: copied.tree, encoding: 'utf8', env: { ...outsideGit(), GIT_CEILING_DIRECTORIES: scratch } });
    const reason = copied.error ? `the application code could not be copied: ${copied.error}` : applied.status !== 0 ? `the patch does not apply to the code as it is: ${saidBy(applied)}` : null;
    if (reason) {
      mkdirSync(path.join(target, 'logs'), { recursive: true });
      return { id: item.id, execution: { status: 'error', reason }, results: checks.map((check) => ({ id: check.id, result: 'unknown' })), attempts: [] };
    }
    overlayCurrent(repo, copied.tree);
    return runCase(harborCommand(), { id: item.id, directory }, checks, target, {
      agent: 'nop', yes: options.yes === true, withheld: options.withheld, timeout: options.timeout ?? 30, harness: kitDirectory(repo), repo: copied.tree });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Proves each finished package's verifier before any real run: every fixture
// script takes the agent's place, then the verifier runs through Harbor exactly
// as it will in a run. In the light tier the probe runs too (probePackage). A
// package is ready only while this record matches it: its fixtures by the
// proof digest, which covers every file but harness.json and the adapter
// modules at the kit's root, and its probe by the run digest. Each fixture is
// kept by its own digest and the package it ran against, so a fixture added
// or changed since, such as a reviewer's counterexample, runs alone, and the
// probe is not run again. Neither fixtures nor the probe run the adapter, so
// an edit to it alone keeps both proofs and runs nothing.
// Packages are checked one by one: a package that cannot be checked is
// listed with why, and the others go on. Its digests and files are read
// again after its trials: a package or kit changed meanwhile records no
// proof (package_changed_during_check). A package whose shared verifier code
// differs from the kit's is refused (shared_code_mismatch). A package written
// against a Spec draft can be proved.
const COVERAGE_GAPS = ['integration_pending', 'scenario_uncovered', 'requirement_uncovered', 'then_uncovered', 'case_draft', 'cases_missing'];

export function checkEval(repo, name, options = {}) {
  allowedNames(options);
  const evals = validateEval(repo, name);
  // --case names one package or several.
  const named = [...new Set((options.case === undefined || options.case === null ? [] : [options.case].flat())
    .filter((id) => id !== undefined && id !== null && String(id) !== '').map(String))];
  const unnamed = named.filter((id) => !evals.cases.some((item) => item.id === id));
  if (unnamed.length) throw new Error(`No package named ${unnamed.join(', ')}.`);
  const picked = named.length > 0;
  const chosen = evals.cases.filter((item) => !picked || named.includes(item.id));
  // Gaps of the change as a whole stop the check, unless only packages
  // written against a draft are checked, which need no export.
  const blocking = evals.gaps.filter((gap) => !gap.case && !COVERAGE_GAPS.includes(gap.code));
  if (blocking.length && !(chosen.length && chosen.every(draftBound))) {
    throw blocked(`Eval packages cannot be checked: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking);
  }
  const root = eddDirectory(repo, name);
  const missingOf = (item) => item.integration?.missing ?? [];
  // A package that cannot be checked as it is: invalid, written for another
  // Spec, or one whose environment could hand the evaluated program its
  // expected results.
  const unfit = new Map(chosen.flatMap((item) => {
    const own = evals.gaps.filter((gap) => gap.case === item.id && ['case_invalid', 'case_stale', 'expected_results_exposed'].includes(gap.code));
    return item.errors?.length || own.length ? [[item.id, own.length ? own.map(clean) : [{ code: 'case_invalid', kind: 'technical', owner: 'agent', layer: 'package', case: item.id, message: item.errors.join(' ') }]]] : [];
  }));
  // A package whose record still matches it is proved already. Naming it with
  // --case proves it again; a fixture whose record still holds is kept.
  const current = picked ? [] : chosen.filter((item) => !unfit.has(item.id) && !missingOf(item).length).map((item) => item.id);
  // A package is checked once only its proof, or its reviewer's
  // counterexamples, are missing; --case checks a ready one again.
  const checkable = (item) => !unfit.has(item.id) && !current.includes(item.id)
    && missingOf(item).every((entry) => ['check', 'review'].includes(entry)) && (picked || missingOf(item).length > 0);
  let finished = chosen.filter(checkable);
  // Shared verifier code that differs from the kit's is refused.
  const mismatches = finished.length ? sharedMismatches(repo, name, finished.map((item) => item.id)) : [];
  // An entry that names no package stops every package it may be about.
  const mismatched = new Set(mismatches.some((entry) => !entry.case) ? finished.map((item) => item.id) : mismatches.map((entry) => entry.case));
  const refused = [...mismatched].map((id) => sharedCodeGap(name, id, mismatches.filter((entry) => !entry.case || entry.case === id), repo));
  finished = finished.filter((item) => !mismatched.has(item.id));
  const skipped = chosen.filter((item) => !finished.includes(item) && !current.includes(item.id) && !mismatched.has(item.id))
    .map((item) => ({ case: item.id, ...(unfit.has(item.id) ? { reason: 'invalid', gaps: unfit.get(item.id) } : { reason: 'not_finished' }),
      missing: missingOf(item), detail: item.integration?.detail ?? [] }));
  const host = hostEnvironment(finished.map((item) => path.join(root, 'evals', item.id)), options);
  // Docker and Harbor are needed once a fixture or a probe has to run.
  let toolsReady = false;
  const needTools = () => {
    if (toolsReady) return;
    const tools = runTools();
    if (tools.gaps.length) throw blocked(tools.gaps.map((gap) => gap.message).join(' '), repo, name, tools.gaps);
    ignoreRecords(repo);
    toolsReady = true;
  };
  // A package in checks.json 1.1 is proved by its probe in either tier; its
  // fixtures, if any, are proved too.
  const kit = kitDirectory(repo);
  const before = finished.length ? evalSnapshot(repo, name) : null;
  const kitStamps = before ? stampsOf(kit, Object.keys(before.kit)) : {};
  const run = { yes: host.yes, withheld: host.withheld, timeout: options.timeout };
  // A judge check stays diagnostic in a proof unless a confirmation of this
  // export made it gating.
  const latest = evals.spec && finished.length ? checksConfirmation(repo, name, evals.spec).latest : null;
  const cases = finished.map((item, position) => {
    const directory = path.join(root, 'evals', item.id);
    const declared = readJSON(path.join(directory, 'tests/checks.json'));
    const checks = countedChecks(item.id, declared.checks, latest?.judge_gating);
    const target = path.join(root, 'checks', item.id);
    const last = readCheckRecord(repo, name, item.id);
    const stamps = stampsOf(directory, Object.keys(before.packages[item.id] ?? {}));
    // A fixture proved for the package as it is, whose own digest is as it
    // was, is kept, unless --case asks for every fixture again. A record
    // written before fixtures kept their digest keeps them all or none.
    const wholeKept = !picked && fixturesProvedFor(last, item) && Array.isArray(last?.fixtures) && last.fixtures.every((entry) => entry?.ok === true);
    const keptFixture = (fixture) => {
      if (picked || !Array.isArray(last?.fixtures)) return null;
      const was = last.fixtures.find((entry) => entry?.name === fixture.name);
      if (!was || was.ok !== true) return null;
      if (was.fixture_digest) {
        const samePackageRun = fixturesProvedFor(last, item) || (Boolean(was.package_digest) && was.package_digest === item.probe_digest);
        return samePackageRun && was.fixture_digest === fixtureDigest(directory, fixture) ? was : null;
      }
      return wholeKept ? was : null;
    };
    const keepProbe = probeHolds(last, item);
    const probeNeeded = item.schema_version === '1.1';
    mkdirSync(target, { recursive: true });
    const declaredFixtures = Array.isArray(declared.fixtures) ? declared.fixtures : [];
    const kept = new Map(declaredFixtures.map((fixture) => [fixture.name, keptFixture(fixture)]).filter(([, entry]) => entry));
    const toRun = declaredFixtures.filter((fixture) => !kept.has(fixture.name));
    if (toRun.length || (probeNeeded && !keepProbe)) needTools();
    for (const entry of readdirSync(target)) {
      if (entry === 'check.json') continue;
      if (entry === PROBE_FOLDER ? !keepProbe : !kept.has(entry)) rmSync(path.join(target, entry), { recursive: true, force: true });
    }
    progress(`eval check ${item.id}: started (${position + 1}/${finished.length}, ${toRun.length} fixture${toRun.length === 1 ? '' : 's'} to run${probeNeeded && !keepProbe ? ' and the probe' : ''})`);
    const steps = Array.isArray(item.steps) ? item.steps : [];
    const ran = new Map(toRun.map((fixture) => {
      const outcome = patchFixture(item, fixture)
        ? runPatchFixture(repo, item, directory, checks, path.join(target, fixture.name), fixture, run)
        : runCase(harborCommand(), { id: item.id, directory }, checks, path.join(target, fixture.name), {
          agent: 'genesis_fixture:FixtureAgent', yes: host.yes, withheld: host.withheld, timeout: options.timeout ?? 30,
          harness: kit, repo, modules: [path.join(ROOT, 'src/harbor')],
          // A package with steps gives the fixture agent every step and the
          // folder of the fixtures, where each step has a script of its own.
          env: { GENESIS_EDD_FIXTURE: path.join(directory, 'tests/fixtures', `${fixture.name}.sh`), GENESIS_EDD_FIXTURE_NAME: fixture.name,
            GENESIS_EDD_FIXTURE_DIR: path.join(directory, 'tests/fixtures'), ...(steps.length ? { GENESIS_EDD_STEPS: JSON.stringify(steps) } : {}) } });
      const got = Object.fromEntries(outcome.results.map((entry) => [entry.id, entry.result]));
      return [fixture.name, { name: fixture.name, expect: fixture.expect, got, execution: outcome.execution,
        ok: outcome.execution.status === 'completed' && Object.entries(fixture.expect).every(([id, result]) => got[id] === result), attempts: outcome.attempts,
        fixture_digest: fixtureDigest(directory, fixture), package_digest: item.probe_digest ?? null, ...(patchFixture(item, fixture) ? { kind: 'code_patch' } : {}) }];
    }));
    const fixtures = declaredFixtures.map((fixture) => ran.get(fixture.name) ?? kept.get(fixture.name));
    const probe = keepProbe ? last.probe : probeNeeded ? probePackage(repo, item, directory, checks, path.join(target, PROBE_FOLDER), run) : null;
    // What the fixtures took together, from their attempts; the probe keeps its own.
    const usage = toRun.length ? usageOf([...ran.values()].flatMap((fixture) => fixture.attempts ?? [])) : last?.usage ?? usageOf([]);
    // The package and the kit as they are after its trials, by content and by
    // when each file was last written: an edit put back still shows.
    const after = evalSnapshot(repo, name);
    const moved = [...new Set([...(() => {
      const changed = evalFilesChanged({ packages: { [item.id]: before.packages[item.id] }, kit: before.kit }, { packages: { [item.id]: after.packages[item.id] }, kit: after.kit });
      const own = changed.packages[item.id];
      return [...(typeof own === 'string' ? [`${item.id}/ (${own})`] : (own ?? []).map((file) => `${item.id}/${file}`)), ...changed.kit.map((file) => `kit/${file}`)];
    })(), ...restamped(stamps, directory).map((file) => `${item.id}/${file}`), ...restamped(kitStamps, kit).map((file) => `kit/${file}`)])].sort();
    const changedDuring = moved.length > 0 || after.task_digest[item.id] !== before.task_digest[item.id];
    const summary = { schema_version: '1.1', case: item.id, checked_at: new Date().toISOString(), task_digest: item.task_digest, run_digest: item.run_digest,
      proof_digest: item.proof_digest ?? null,
      passed: fixtures.every((fixture) => fixture.ok) && (!probeNeeded || probe?.ok === true), fixtures: fixtures.map(({ attempts, ...fixture }) => fixture), usage,
      ...(probe ? { probe } : {}), host_env: { mode: host.mode, names: host.names } };
    progress(`eval check ${item.id}: finished, ${changedDuring ? 'package changed during the check' : summary.passed ? 'proved' : 'not proved'}`);
    // The record is replaced; writeJSON never overwrites a file. A package
    // that changed during its trials keeps no record: what ran is no one
    // version of it.
    rmSync(path.join(target, 'check.json'), { force: true });
    if (changedDuring) return { ...summary, passed: false, package_changed_during_check: true, changed_files: moved, probe_needed: probeNeeded, recorded: false };
    writeJSON(path.join(target, 'check.json'), summary);
    return { ...summary, probe_needed: probeNeeded, recorded: true, kept_fixtures: [...kept.keys()], ran_fixtures: toRun.map((fixture) => fixture.name) };
  });
  const passed = (cases.length > 0 || current.length > 0) && cases.every((item) => item.passed) && !refused.length;
  const probeErrored = cases.filter((item) => item.probe_needed && item.probe && item.probe.execution?.status !== 'completed').map((item) => item.case);
  const probeJudged = cases.filter((item) => item.probe_needed && item.probe?.unexpected?.length).map((item) => item.case);
  const fixtureFailed = cases.filter((item) => item.fixtures.some((fixture) => !fixture.ok)).map((item) => item.case);
  const changedDuring = cases.filter((item) => item.package_changed_during_check).map((item) => item.case);
  return {
    change: name, passed, cases: cases.map(({ probe_needed: probeNeeded, ...item }) => item), already_proved: current, skipped,
    ...(refused.length ? { refused, gaps: refused } : {}),
    proved: cases.filter((item) => item.passed && item.recorded).map((item) => item.case),
    // What did not hold, by package: a probe that judged a result when
    // nothing was done, or did not complete; a fixture that did not get the
    // result it expects (the verifier, the environment or the fixture is
    // wrong; never its expectation); a package changed while it was checked.
    failed: { probe_judged: probeJudged, probe_errored: probeErrored, fixture_failed: fixtureFailed, package_changed_during_check: changedDuring },
    host_env: { mode: host.mode, names: host.names, withheld: host.withheld },
    suggestion: null,
  };
}

// What eval.js sharedCodeMismatches reports for these packages, as
// [{ case, ...facts }]: it may list package ids, entries that name their
// package, or entries by package.
export function sharedMismatches(repo, name, ids) {
  const found = sharedCodeMismatches(repo, name, ids);
  const entries = Array.isArray(found) ? found
    : found && typeof found === 'object' ? Object.entries(found).flatMap(([id, value]) => (Array.isArray(value) ? value : [value])
      .filter((entry) => entry !== null && entry !== undefined && entry !== false)
      .map((entry) => (entry && typeof entry === 'object' ? { case: id, ...entry } : { case: id, detail: entry }))) : [];
  return entries.map((entry) => (typeof entry === 'string' ? { case: entry }
    : { ...entry, case: entry?.case ?? entry?.id ?? entry?.package ?? null }));
}

// The gap of a package whose shared verifier code differs from the kit's.
function sharedCodeGap(name, id, entries, repo) {
  const files = entries.map((entry) => entry?.file ?? entry?.path).filter(Boolean);
  return { code: 'shared_code_mismatch', kind: 'artifact', owner: 'agent', layer: 'package', case: id, ...(files.length ? { files } : {}), mismatches: entries,
    message: `${id}: tests/genesis.sh or tests/shared/ differs from the shipped helper or the kit's verifier/ folder${files.length ? ` (${files.join(', ')})` : ''}, so the package would not run the verifier code the review read. \`eval sync\` writes the shared code into the package.`,
    suggestion: { command: ['eval', 'sync', name, '--repo', repo], why: 'writes the shipped helper and the kit\'s verifier code into the package' } };
}

// One run of packages against the code as it is now. A base run is taken
// before the change; every later head run is compared with that fixed base.
// A trial runs structurally valid packages, ready or not, with the real
// adapter, to see how they behave before they are proved or confirmed: it is
// never a baseline, a run of a loop, an accepted run or a proof, and its
// completed failures count for its code like any run's. Results are written
// once and never overwritten. With atStart (`--at-start`), a baseline or a
// trial runs on the start code of the change's first unaccepted loop,
// rebuilt outside the project (rebuildStart), whatever the working directory
// holds; the rebuilt folder is deleted once the run is recorded or refused.
// Every run that gets a folder gets a start entry in the run index before
// Harbor starts, and a finish entry once run.json is written.
export function startRun(repo, name, options = {}) {
  const held = [];
  try { return recordRun(repo, name, options, held); } finally {
    for (const folder of held) rmSync(folder, { recursive: true, force: true });
  }
}

const filled = (value) => typeof value === 'string' && value.trim().length > 0;
const listed = (items) => (items.length > 10 ? `${items.slice(0, 10).join(', ')} and ${items.length - 10} more` : items.join(', '));

// Why a full base record does not give a baseline, for a message.
const baseAttemptWhy = (run) => (isLost(run) ? 'its record is lost' : isInterrupted(run) ? 'it never finished'
  : run.code_changed_during_run ? 'the code changed while it ran' : run.packages_changed_during_run ? 'the eval packages changed while it ran'
    : `it did not complete (${run.execution_status})`);

// What a run compares with its base record, check by check: each check of
// the packages in outcomes ({ id, results, counts }), with its result before
// and after and a verdict. cases holds each package's counted checks. A
// package that did not run at the base, or ran there as another package,
// has no result before.
function comparisonOf({ base, runsDirectory, outcomes, cases, digests, runDigests, unavailableReason }) {
  return outcomes.flatMap((outcome) => {
    const ranAtBase = Boolean(base?.is_baseline) && (base.cases ?? []).some((item) => item.id === outcome.id);
    const comparable = ranAtBase && samePackage(digestsAt(base, outcome.id), { task: digests[outcome.id] ?? null, run: runDigests[outcome.id] ?? null });
    const declaredChecks = cases.find((item) => item.id === outcome.id)?.checks ?? [];
    const before = comparable ? readResults(path.join(runsDirectory, base.run_id, outcome.id), declaredChecks) : null;
    // Base and head attempts are never paired: each side gives its counts.
    const beforeCounts = comparable ? readCounts(path.join(runsDirectory, base.run_id, outcome.id), declaredChecks,
      base.environment_ref?.attempts_by_case?.[outcome.id] ?? base.environment_ref?.attempts ?? 1) : null;
    const reason = !base ? 'no_baseline' : !base.is_baseline ? unavailableReason : ranAtBase ? 'incompatible_tasks' : 'not_run_at_baseline';
    return outcome.results.map((entry) => {
      const earlierResult = before?.find((item) => item.id === entry.id)?.result ?? null;
      const expected = base?.baseline_expectations?.find((item) => item.case === outcome.id && item.check === entry.id)?.expected ?? 'any';
      const verdict = entry.result === 'fail' ? 'violated' : entry.result === 'unknown' ? 'unverified'
        : earlierResult === null ? 'head_only' : earlierResult === 'unknown' ? 'unverified'
          : expected !== 'any' && earlierResult !== expected ? 'base_mismatch' : 'holds';
      return { case: outcome.id, check: entry.id, intent: entry.intent, ...(entry.then !== undefined ? { then: entry.then } : {}), role: entry.role, before: earlierResult,
        ...(earlierResult === null ? { before_unavailable_reason: reason } : {}),
        after: entry.result, before_counts: earlierResult === null ? null : beforeCounts?.[entry.id] ?? null, after_counts: outcome.counts?.[entry.id] ?? null,
        verdict, evidence: entry.evidence, ...(entry.flaky ? { flaky: true } : {}) };
    });
  });
}

const VERDICTS = ['holds', 'violated', 'base_mismatch', 'head_only', 'unverified'];
const tallyOf = (results, role = null) => Object.fromEntries(VERDICTS.map((key) => [key, results.filter((entry) => entry.verdict === key && (!role || entry.role === role)).length]));

function recordRun(repo, name, options, held) {
  const trial = options.trial === true;
  if (trial && options.baseline) throw new Error('--trial and --baseline are two kinds of run: a trial is never a baseline.');
  const side = trial ? 'trial' : options.baseline ? 'base' : 'head';
  if (options.unavailable !== undefined && (side !== 'base' || !UNAVAILABLE.includes(options.unavailable))) {
    throw new Error(`--unavailable belongs to --baseline and must be one of ${UNAVAILABLE.join(', ')}.`);
  }
  if (options.expect && (side !== 'base' || options.unavailable)) throw new Error('--expect belongs to a baseline that actually runs.');
  if (options.unavailable !== undefined && options.case?.length) throw new Error('--unavailable records that nothing could run for the whole change; it takes no --case.');
  // A record that nothing could run describes the code in the working
  // directory, and nothing is built for it.
  if (options.atStart && (side === 'head' || options.unavailable !== undefined)) {
    throw new Error('--at-start belongs to a baseline or a trial that runs: it rebuilds the start code of the change\'s first unaccepted loop outside the project and runs there. A record that nothing could run (--unavailable) describes the code in the working directory.');
  }
  if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1)) throw new Error('--attempts is a whole number of 1 or more.');
  if ((options.approvedBy === undefined) !== (options.ref === undefined) || [options.approvedBy, options.ref].some((value) => value !== undefined && !filled(value))) {
    throw new Error('--approved-by and --ref go together: who approved what this run costs, and where they said so.');
  }
  if (options.allPackages && side !== 'head') throw new Error('--all-packages belongs to a head run: a final run then runs every package after a failure.');
  allowedNames(options);
  const evals = validateEval(repo, name);
  const root = eddDirectory(repo, name);
  const runs = path.join(root, 'runs');
  const harnessDirectory = kitDirectory(repo);
  let harness = {};
  try { harness = readJSON(path.join(harnessDirectory, 'harness.json')); } catch { /* optional */ }
  // A trial needs the Spec export and packages that are structurally valid;
  // what else the change still lacks does not stop it. Other runs need the
  // change as a whole in order.
  if (trial) {
    const blocking = evals.gaps.filter((gap) => !gap.case && !COVERAGE_GAPS.includes(gap.code));
    if (blocking.length || !evals.spec) {
      throw blocked(`A trial needs an exported Spec and valid packages: ${blocking.map((gap) => gap.message).join('; ') || 'no Spec export is recorded'}`, repo, name, blocking);
    }
  } else {
    const blocking = evals.gaps.filter((gap) => gap.code !== 'integration_pending');
    if (blocking.length) throw blocked(`Eval packages are not ready: ${blocking.map((gap) => gap.message).join('; ')}`, repo, name, blocking);
  }
  // In the light tier, a line this change fixes is proved able to fail by its
  // real failure before the change, so an existing project records a real
  // baseline: one declared unavailable proves nothing.
  if (side === 'base' && options.unavailable && evals.tier?.readiness === 'light' && requireProject(repo).mode === 'existing') {
    throw blocked('The light tier needs a baseline that runs.', repo, name, [{ code: 'light_baseline_required', kind: 'artifact', owner: 'agent', layer: 'baseline',
      message: `This change is held to the light tier, where a line the change fixes is proved able to fail by its real failure before the change, so an existing project records a baseline that runs, not --unavailable ${options.unavailable}. An unavailable baseline is allowed in the full tier, which the user can confirm with \`eval confirm --tier full\`.` }]);
  }
  const spec = { id: name, sha256: evals.spec };
  const all = readRuns(runs);
  const earlier = all.filter((run) => run.spec_snapshot?.sha256 === spec.sha256);
  const usable = earlier.filter(usableRun);
  const recorded = activeLoop(repo, name, spec.sha256);
  // Once the user abandoned the change after its loop started, that loop no
  // longer holds the change: a head run or a trial is made outside any loop,
  // and a head run compares with the latest valid baseline.
  let loop = recorded && side !== 'base' && abandonedSince(repo, name, recorded.started_at) ? null : recorded;
  let inLoop = Boolean(loop) && side !== 'base';
  // The status of that loop, read once, when a head run or a trial needs it.
  let loopNow = null;
  const statusNow = () => (loopNow ??= loopStatus(repo, name));
  // A trial on the start code (--at-start) runs none of the change's code, so
  // a loop that ended does not refuse it: it runs outside any loop.
  if (trial && options.atStart && inLoop && loopPhase(statusNow()) === 'ended') {
    loop = null;
    inLoop = false;
    loopNow = null;
  }
  // Once the latest loop of this change ended without the user's acceptance,
  // its head runs and trials of the application code wait for a new loop the
  // user agreed to, or for the user to abandon the change: a new Spec export
  // does not lift that. When the run would be made in that loop, the loop's
  // own end comes beside the lock, with its reason, owner and layer, as loop
  // status names it for a head run.
  if (side === 'head' || (trial && !options.atStart)) {
    const lock = changeLock(repo, name, { spec: spec.sha256 });
    if (lock) {
      const end = inLoop ? headRunGap(statusNow()) : null;
      throw blocked([lock.message, end?.message].filter(Boolean).join(' '), repo, name, [lock, ...(end ? [end] : [])]);
    }
  }
  // The checks the user confirmed for this Spec export, when they are the
  // packages as they are now. Its run plan is what a baseline runs.
  const confirmation = checksConfirmation(repo, name, spec.sha256);
  // The loop's checks confirmation gives its tier and the judge checks it
  // made gating.
  const loopEntry = inLoop && loop.checks_confirmation && !confirmation.gap ? confirmationById(confirmation.entries, loop.checks_confirmation.id) : null;
  const pinned = loop ? usable.find((run) => run.run_id === loop.baseline && run.side === 'base') ?? null : null;
  // Inside a loop, a head run and a trial follow the run plan of the loop's
  // baseline: the plan loop start fixed and loop status reports. A baseline
  // recorded before run plans ran every package its number of times, and so
  // does every run of a loop on it.
  const fixed = inLoop ? planOf(pinned) : null;
  // The tier of the loop a run is made in: that of the loop's checks
  // confirmation, else the one loop.json recorded, else full.
  const tier = inLoop ? loopEntry?.run_plan?.tier ?? loop.tier ?? 'full' : null;
  const planWarnings = [];
  // The run plan of a loop is fixed: a flag that gives the plan's own value is
  // taken, another value is refused before anything runs. In the light tier
  // every package runs once, so --attempts changes nothing there.
  if (inLoop && fixed) {
    const planAgent = fixed.agent ?? harness.agent ?? null;
    const differs = [
      ...(options.attempts !== undefined && tier !== 'light' && options.attempts !== (fixed.attempts ?? null) ? [{ key: 'attempts', given: options.attempts, plan: fixed.attempts ?? null }] : []),
      ...(options.agent !== undefined && options.agent !== planAgent ? [{ key: 'agent', given: options.agent, plan: planAgent }] : []),
      ...(options.model !== undefined && options.model !== (fixed.model ?? null) ? [{ key: 'model', given: options.model, plan: fixed.model ?? null }] : []),
    ];
    if (differs.length) {
      throw blocked('The run plan of this loop is fixed.', repo, name, [{ code: 'run_plan_fixed', kind: 'artifact', owner: 'agent', layer: 'loop', differs,
        plan: { attempts: fixed.attempts ?? null, agent: planAgent, model: fixed.model ?? null, tier },
        message: `A loop runs for this Spec export, and its run plan is fixed by its checks confirmation: ${confirmedPlan(fixed)}${tier === 'light' ? ', light tier' : ''}. This run gives ${differs.map((entry) => `${entry.key} ${entry.given}`).join(', ')}. Another plan is the user's decision, recorded with \`eval confirm\`, and a confirmation of another plan ends the loop.` }]);
    }
    if (options.attempts !== undefined && tier === 'light') planWarnings.push(`In the light tier every package runs once, so --attempts ${options.attempts} changes nothing.`);
  }
  // A head run or a trial of a loop that ended, that a stop holds for, or
  // whose budget is used up is refused before any folder, Docker or Harbor.
  // Once the user accepted the loop, head runs go on. The same status says
  // whether a full run is a screen run or the final run.
  if (inLoop) statusNow();
  const refusal = loopNow ? headRunGap(loopNow) : null;
  if (refusal) throw blocked(refusal.message, repo, name, [refusal]);
  // A running loop pins its baseline: a later base run must not move the
  // reference every head run of that loop is compared with. Outside a loop a
  // run compares with the latest valid baseline, whatever base attempt came
  // after it.
  const outside = latestValidBaseline(earlier, spec.sha256);
  const base = side === 'base' ? null : loop ? pinned : outside.base;
  if (side === 'head' && !base) {
    const attempt = fullBaseRecords(earlier, spec.sha256).at(-1) ?? earlier.filter((run) => run.side === 'base').at(-1) ?? null;
    throw blocked('No baseline is recorded for this Spec.', repo, name, [{ code: 'baseline_missing', kind: 'artifact', owner: 'agent', layer: 'baseline',
      ...(attempt ? { last_attempt: { run_id: attempt.run_id, why: baseAttemptWhy(attempt) } } : {}),
      message: `No baseline is recorded for this Spec export${attempt ? `: the last base attempt, ${attempt.run_id}, gives none because ${baseAttemptWhy(attempt)}` : ''}. A head run is compared with a baseline and is never promoted to one; \`run start --baseline\` records one, or \`--baseline --unavailable REASON\` that nothing could run yet. A trial (--trial) runs without one.` }]);
  }
  if (!loop && side !== 'base' && base && outside.later.length) {
    planWarnings.push(`The latest base attempt${outside.later.length === 1 ? '' : 's'} ${outside.later.map((run) => `${run.run_id} (${baseAttemptWhy(run)})`).join(', ')} gave no baseline, so this run compares with the baseline ${base.run_id}.`);
  }
  // Until a loop of this change is accepted, or the user abandons the change,
  // the code before the change is the start code of its first unaccepted
  // loop, whatever Spec export it ran for. Every base record, one that runs
  // or one that declares a baseline unavailable, describes that code, never
  // code a loop has already changed.
  const pin = side === 'base' || (trial && options.atStart) ? pinnedStart(repo, name) : null;
  // --at-start rebuilds that start code, so there must be one.
  if (options.atStart && !pin) {
    throw blocked('There is no start code to rebuild.', repo, name, [{ code: 'start_code_unknown', kind: 'artifact', owner: 'agent', layer: 'code',
      message: '--at-start runs on the start code of the change\'s first unaccepted loop, and there is none: no loop has started for this change, its loop was accepted, the user abandoned the change, or loop.json records no start code. Without --at-start a run describes the code in the working directory.' }]);
  }
  if (side === 'base' && pin && !options.atStart && sameCode(codeSnapshot(repo).snapshot, pin.start, repo) !== true) {
    const before = usable.find((run) => run.run_id === pin.loop.baseline) ?? null;
    throw blocked('The code changed since the change\'s first unaccepted loop started.', repo, name, [{ code: 'baseline_after_change', kind: 'artifact', owner: 'agent', layer: 'baseline',
      start_code: restoreHint(name, pin.loop, before),
      message: `Until a loop of this change is accepted or the user abandons the change, every base record goes on the start code of its first unaccepted loop, ${restoreHint(name, pin.loop, before)}, and the working directory holds other code. A base record on other code would describe the change, not the code before it. \`--at-start\` rebuilds the start code outside the project and leaves the working directory as it is; a record that nothing could run (--unavailable) describes the working directory, so it needs that code there.${recoveredText(pin.loop)}` }]);
  }
  // accepted.json is committed, so a fresh clone holds it while loop.json and
  // the runs stay on the machine that made them. A base record on the code
  // the user accepted for this Spec export would describe the change.
  const holding = side === 'base' && !options.atStart ? acceptedHolding(repo, name, spec.sha256) : null;
  if (holding) throw blocked('This code holds the accepted change.', repo, name, [holding]);
  // Whether the loop of this Spec export has ended or stopped, for what a
  // base record says of it.
  const loopEnded = side === 'base' && loop ? phaseOf(repo, name) === 'ended' : false;
  // Each package with its checks.json, and its checks as a run counts them: a
  // judge check is gating only when the confirmation the run follows made
  // its line gating.
  const judgeSource = inLoop ? loopEntry : confirmation.current;
  const judgeGating = Array.isArray(judgeSource?.judge_gating) ? judgeSource.judge_gating : [];
  const cases = evals.cases.map((item) => {
    const directory = path.join(root, 'evals', item.id);
    let declaredChecks = null;
    try { declaredChecks = readJSON(path.join(directory, 'tests/checks.json')); } catch { /* listed by validation */ }
    const merged = declaredChecks && typeof declaredChecks === 'object' ? { ...item, directory, ...declaredChecks } : { ...item, directory, checks: [], unreadable: true };
    return { ...merged, checks: countedChecks(item.id, merged.checks, judgeGating) };
  });
  for (const id of options.case ?? []) if (!cases.some((item) => item.id === id)) throw new Error(`No package named ${id}.`);
  // A partial run is for a quick look during a change. It never passes, and
  // a partial base record never becomes a loop's baseline.
  const chosen = (item) => !options.case?.length || options.case.includes(item.id);
  const stale = (item) => evals.gaps.some((gap) => gap.case === item.id && gap.code === 'case_stale');
  let ready;
  let skipped;
  if (trial) {
    const fit = (item) => !item.errors?.length && !item.unreadable && !draftBound(item) && !stale(item);
    const unfit = cases.filter((item) => chosen(item) && !fit(item));
    if (options.case?.length && unfit.length) {
      throw blocked('A trial runs structurally valid packages of the Spec export.', repo, name, unfit.map((item) => (draftBound(item)
        ? { code: 'draft_bound', kind: 'artifact', owner: 'agent', layer: 'package', case: item.id, message: `${item.id} is written against a Spec draft: it can be proved, not run.` }
        : { code: 'case_invalid', kind: 'technical', owner: 'agent', layer: 'package', case: item.id,
          message: `${item.id} cannot run as it is: ${[...(item.errors ?? []), ...(item.unreadable ? ['tests/checks.json cannot be read'] : []), ...(stale(item) ? ['it was written for another Spec export'] : [])].join('; ')}.` })));
    }
    ready = cases.filter((item) => chosen(item) && fit(item));
    skipped = cases.filter((item) => chosen(item) && !fit(item)).map((item) => ({ case: item.id, reason: draftBound(item) ? 'draft_bound' : 'invalid' }))
      .concat(cases.filter((item) => !chosen(item)).map((item) => ({ case: item.id, reason: 'not_selected' })));
    if (!ready.length) {
      throw blocked('No package can run in a trial.', repo, name, [{ code: 'no_trial_case', kind: 'artifact', owner: 'agent', layer: 'package',
        message: 'A trial runs every structurally valid package of the Spec export, ready or not, and none is: `eval validate` lists what each package lacks.' }]);
    }
  } else {
    const draft = cases.filter((item) => chosen(item) && draftBound(item));
    if (options.case?.length && draft.length) {
      throw blocked('A package written against a Spec draft does not run.', repo, name, draft.map((item) => ({ code: 'draft_bound', kind: 'artifact', owner: 'agent', layer: 'package', case: item.id,
        message: `${item.id} is written against a Spec draft: it can be written and proved, but no run or confirmation takes it until it is bound to the Spec export (\`eval rebind\`).` })));
    }
    ready = cases.filter((item) => item.integration?.state === 'ready' && chosen(item) && !draftBound(item));
    skipped = cases.filter((item) => item.integration?.state !== 'ready' || draftBound(item))
      .map((item) => (draftBound(item) ? { case: item.id, reason: 'draft_bound' }
        : { case: item.id, reason: 'awaiting_integration', missing: item.integration?.missing ?? [], detail: item.integration?.detail ?? [] }))
      .concat(cases.filter((item) => item.integration?.state === 'ready' && !draftBound(item) && !chosen(item)).map((item) => ({ case: item.id, reason: 'not_selected' })));
  }
  // A finished package that waits only for `eval check`: a run skips it.
  const waitsCheck = skipped.filter((item) => item.reason === 'awaiting_integration' && item.missing?.length
    && item.missing.every((entry) => entry === 'check')).map((item) => item.case);
  // A head run with nothing to run would only record that; it is refused
  // before a folder is written, so it never counts as a run of a loop.
  if (side === 'head' && !ready.length) {
    const waiting = skipped.filter((item) => item.reason === 'awaiting_integration').map((item) => `${item.case} (${(item.detail ?? []).join('; ')})`);
    throw blocked(`No package is ready to run.${waiting.length ? ` Waiting: ${waiting.join(', ')}.` : ''}`, repo, name, [noRunnableCase(Boolean(loop), { unchecked: waitsCheck })]);
  }
  const executes = !options.unavailable && ready.length > 0;
  // Shared verifier code that differs from the kit's is refused before
  // anything runs.
  if (executes) {
    const mismatches = sharedMismatches(repo, name, ready.map((item) => item.id));
    if (mismatches.length) {
      const ids = mismatches.some((entry) => !entry.case) ? ready.map((item) => item.id) : [...new Set(mismatches.map((entry) => entry.case))];
      throw blocked('Shared verifier code differs from the kit\'s.', repo, name, ids.map((id) => sharedCodeGap(name, id,
        mismatches.filter((entry) => !entry.case || entry.case === id), repo)));
    }
  }
  // A finished package that waits only for `eval check` is skipped; a loop
  // starts only on a baseline that ran it.
  const unproved = side === 'base' && !options.unavailable ? waitsCheck : [];
  // --expect names a file relative to the project, as the commands workflow
  // status offers do, wherever run start runs; an absolute path stays as it is.
  const declared = expectations(options.expect ? path.resolve(repo, options.expect) : options.expect, cases);
  // A new project's baseline runs on an entry skeleton with no business
  // behavior, so every check is expected to fail there: a check that passes
  // shows behavior written before the loop (baseline_mismatch), and one that
  // cannot tell comes out unknown, which is no mismatch.
  if (side === 'base' && !options.unavailable && requireProject(repo).mode === 'new') {
    const unfit = cases.flatMap((item) => (Array.isArray(item.checks) ? item.checks : []).map((check) => ({ case: item.id, check: check.id,
      expected: declared.find((entry) => entry.case === item.id && entry.check === check.id)?.expected ?? null }))).filter((entry) => entry.expected !== 'fail');
    if (unfit.length) {
      const shown = unfit.map((entry) => `${entry.case}/${entry.check} (${entry.expected ?? 'no expectation'})`);
      throw blocked('A new project\'s baseline expects every check to fail.', repo, name, [{ code: 'expectation_not_fail', kind: 'artifact', owner: 'agent', layer: 'baseline',
        checks: unfit, message: `In a new project the baseline runs on an entry skeleton that starts the program and has no business behavior yet, so every check is expected to fail there; pass and any are refused. These checks expect otherwise: ${listed(shown)}. A check that cannot tell on the skeleton comes out unknown, which is no mismatch; one that passes there shows behavior written before the loop.` }]);
    }
  }
  let agent;
  let model;
  const partial = Boolean(options.case?.length);
  const list = (ids) => ids.join(', ');
  let plan;
  // Inside a loop that needs a final run, a full run is a screen run or the
  // final run of the screen run named by finalOf; a trial in a loop is a
  // trial. Otherwise null.
  let role = trial && inLoop ? 'trial' : null;
  let finalOf = null;
  let passedFinal = null;
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
    if (differs.length) {
      throw blocked('This baseline would use another run plan than the user confirmed.', repo, name, [{ code: 'run_plan_differs', kind: 'artifact', owner: 'agent', layer: 'confirmation',
        confirmed: { attempts: confirmedRun.attempts ?? null, agent: confirmedRun.agent ?? null, model: confirmedRun.model ?? null }, given: differs,
        message: `The user confirmed ${confirmedPlan(confirmedRun)} for this Spec export (confirmed.json), and this baseline would use ${differs.join(', ')}. Another plan is the user's decision, recorded with \`eval confirm\`.` }]);
    }
    // The confirmed model runs as the user confirmed it, none included, so
    // the record never cites a confirmation for another model. An agent the
    // plan leaves out comes from harness.json.
    agent = options.agent ?? confirmedRun.agent ?? harness.agent ?? undefined;
    model = options.model ?? ('model' in confirmedRun ? confirmedRun.model : harness.model) ?? undefined;
    plan = { attempts: options.attempts ?? confirmedRun.attempts ?? null, pass_rule: 'all', agent: agent ?? null, model: model ?? null,
      source: 'confirmation', confirmation: confirmed.id, tier: confirmedRun.tier ?? 'full' };
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
    // user's: only a checks confirmation of this export settles it, never a
    // run's own --attempts.
    const needs = planNeeds(cases, ready, model);
    const known = needs.needed && Number.isInteger(decided.attempts) ? decided.attempts : null;
    if (needs.needed && known === null) throw blocked('The number of attempts is not decided.', repo, name, [attemptsUndecided(needs, model)]);
    plan = { attempts: options.attempts ?? known, pass_rule: 'all', agent: agent ?? null, model: model ?? null, source: 'baseline' };
    if (needs.needed && options.attempts !== undefined && options.attempts !== known) {
      planWarnings.push(`The user last confirmed ${times(known)} of each package with a live dependency for this Spec export, and this baseline runs ${times(options.attempts)}: a loop starts only on a baseline of the plan a confirmation records.`);
    }
    // What it took from that plan, said when it is more than harness.json
    // gives; a value harness.json gave is not named.
    const taken = [...(known !== null && options.attempts === undefined ? [{ text: `${times(known)} of each package with a live dependency` }] : []),
      ...(options.agent === undefined && (decided.agent ?? null) !== null ? [{ text: `agent ${decided.agent}`, beyond: decided.agent !== (harness.agent ?? null) }] : []),
      ...(options.model === undefined && 'model' in decided ? [{ text: `model ${decided.model ?? 'none'}`, beyond: (decided.model ?? null) !== (harness.model ?? null) }] : [])];
    if ((known !== null && options.attempts === undefined) || taken.some((entry) => entry.beyond)) {
      const and = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);
      planWarnings.push(`This baseline takes ${and(taken.map((entry) => entry.text))} from ${from}. The user's checks confirmation does not cover the packages as they are, so the baseline records them as its own.`);
    }
    if (options.attempts !== undefined && !needs.live.length) {
      planWarnings.push(`No package declares a live dependency, so every package runs once. The baseline keeps --attempts ${options.attempts} for a package that declares one later.`);
    }
    if (needs.undeclared.length) {
      planWarnings.push(`${declare(needs.undeclared)} no live dependency although the agent runs with model ${model}, so ${they(needs.undeclared)} ${needs.undeclared.length === 1 ? 'runs' : 'run'} once.`);
    }
    // A baseline without the user's confirmation runs, but no loop starts on it until they confirm.
    const why = confirmation.gap ?? confirmation.unconfirmed;
    if (why) planWarnings.push(why.message);
  } else if (inLoop) {
    plan = fixed ?? planOf(base);
    agent = fixed ? fixed.agent ?? harness.agent ?? undefined : options.agent ?? harness.agent ?? undefined;
    model = fixed ? fixed.model ?? undefined : options.model ?? harness.model ?? undefined;
    // A full run of a loop that needs a final run is a screen run, unless
    // loop status names a passing, reviewed screen run whose final run is
    // still due on this code: then it is that final run. A final run of
    // this code that passed already is the one to accept.
    if (side === 'head' && !partial) {
      const { final } = loopNow;
      role = !final.needed ? null : final.pending ? 'final' : 'screen';
      if (role === 'final') finalOf = final.candidate;
      passedFinal = role === 'screen' ? final.finals.find((entry) => entry.verdict === 'pass')?.run_id ?? null : null;
    }
  } else if (side === 'head') {
    plan = planOf(base);
    agent = options.agent ?? harness.agent ?? undefined;
    model = options.model ?? harness.model ?? undefined;
    const liveReady = ready.filter((item) => isLive(item.dependencies)).map((item) => item.id);
    if (!partial && options.attempts === undefined && liveReady.length && plan.attempts === null && !plan.uniform) {
      planWarnings.push(`${declare(liveReady)} a live dependency, but the baseline ${base.run_id} fixed no number of attempts, so ${they(liveReady)} ran once.`);
    }
    if (plan.uniform && base.is_baseline && !partial) {
      planWarnings.push(`The baseline ${base.run_id} was recorded before runs followed a run plan, so every package runs ${plan.attempts === 1 ? 'once' : `${plan.attempts} times`}, as it did there.`);
    }
  } else {
    // A trial outside a loop takes the agent and the model the user last
    // confirmed for this export, else those of harness.json, and runs each
    // package once unless --attempts says otherwise.
    const decided = confirmation.latest?.run_plan ?? {};
    agent = options.agent ?? decided.agent ?? harness.agent ?? undefined;
    model = options.model ?? ('model' in decided ? decided.model : harness.model) ?? undefined;
    plan = { attempts: options.attempts ?? 1, pass_rule: 'all', agent: agent ?? null, model: model ?? null, source: 'trial' };
  }
  if (side !== 'base') {
    const undeclared = planNeeds([], ready, model).undeclared;
    if (undeclared.length && !plan?.uniform) {
      planWarnings.push(`${declare(undeclared)} no live dependency although the agent runs with model ${model}, so ${they(undeclared)} ran once.`);
    }
  }
  // A run that calls a model, through a package with a live dependency or
  // with a model the agent runs with, costs the user money. Before any checks
  // confirmation of this export records the user's plan, that spending is
  // the user's decision too: --approved-by and --ref record who approved it
  // and where. eval review lists such runs.
  const modelCalling = executes && (Boolean(model) || ready.some(liveCase));
  const approval = options.approvedBy !== undefined ? { by: options.approvedBy.trim(), ref: options.ref.trim(), at: new Date().toISOString() } : null;
  if (modelCalling && !confirmation.latest && !approval) {
    const live = ready.filter(liveCase).map((item) => item.id);
    throw blocked('What this run costs is not approved.', repo, name, [{ code: 'cost_unapproved', kind: 'business', owner: 'user', layer: 'confirmation',
      model: model ?? null, live,
      message: `This run calls a model (${[...(model ? [`model ${model}`] : []), ...(live.length ? [`${declare(live)} a live dependency`] : [])].join('; ')}) and no checks confirmation of this Spec export records the user's plan yet, so its cost is the user's decision: --approved-by NAME --ref REF records who approved it and where they said so. \`eval review\` lists such runs for the user.` }]);
  }
  // The attempts each package makes in this run. A trial makes one unless
  // --attempts says, and inside a loop it follows the loop's plan as a
  // partial run does.
  const perCase = Object.fromEntries(ready.map((item) => [item.id, trial
    ? (inLoop ? attemptsFor(item, plan, { partial: true, attempts: options.attempts }) : options.attempts ?? 1)
    : attemptsFor(item, plan, { partial, attempts: options.attempts, role })]));
  const attempts = trial ? options.attempts ?? 1
    : role === 'screen' || (partial && options.attempts === undefined) ? 1 : options.attempts ?? plan.attempts ?? 1;
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
      throw blocked('No agent adapter is configured.', repo, name, [{ code: 'harness_missing', kind: 'artifact', owner: 'agent', layer: 'kit',
        message: 'No evaluated agent is named for Harbor: --agent, or .genesis/edd/harness/harness.json with {"agent": "module:Class"}, names it.' }]);
    }
    tools = runTools();
    if (tools.gaps.length) throw blocked(tools.gaps.map((gap) => gap.message).join(' '), repo, name, tools.gaps);
  }
  // Which host variables Harbor may read for these packages.
  const host = hostEnvironment(order.map((item) => item.directory), options);
  // The start code rebuilt outside the project, before any run folder: a
  // rebuild that does not give the start code is refused, and so is an
  // environment that would read the working directory by a path of its own.
  if (options.atStart) {
    const reads = projectReads(repo, name, ready.map((item) => item.id));
    if (reads.length) {
      throw blocked('An environment reads the working directory.', repo, name, [{ code: 'working_tree_read', kind: 'artifact', owner: 'agent', layer: 'package',
        reads, message: `--at-start builds every image from the rebuilt start code, which \${GENESIS_EDD_REPO} names, but ${reads.map((entry) => `${entry.file} reads ${entry.path}`).join('; ')}: a path into the project outside .genesis/, or one this cannot resolve, so that part would come from the working directory, which holds the change.` }]);
    }
  }
  const rebuilt = options.atStart ? rebuildStart(repo, name, pin, held) : null;
  // The code this run executes: the rebuilt start code, whose snapshot is the
  // loop's start code, or the working directory. Its patch, which restores
  // what the commit does not hold, is written before the run folder: a base
  // record whose code cannot be restored is refused, since no loop could
  // start from it.
  const code = rebuilt ? { version: rebuilt.version, snapshot: rebuilt.snapshot } : codeSnapshot(repo);
  let patchFile = rebuilt?.patch ?? null;
  let patchError = null;
  if (!rebuilt) {
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-patch-')));
    held.push(scratch);
    const saved = savePatch(repo, code.snapshot, path.join(scratch, 'code.patch'));
    patchError = saved.error;
    patchFile = saved.patch ? path.join(scratch, saved.patch) : null;
  }
  if (patchError && side === 'base') {
    throw blocked('The code of this base record could not be saved.', repo, name, [{ code: 'code_unrestorable', kind: 'technical', owner: 'agent', layer: 'code',
      message: `code.patch could not be written (${patchError}), so the code of this base record could not be restored from its commit, and no loop could start from it.` }]);
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
  let patch = null;
  if (patchFile) {
    copyFileSync(patchFile, path.join(directory, 'code.patch'));
    patch = 'code.patch';
  }
  const snapshot = { ...code.snapshot, ...(patch ? { patch } : {}) };
  // The package and kit files this run executes, as they are at its start.
  const evalStart = evalSnapshot(repo, name);
  // A package builds from the rebuilt code with the kit as it is now.
  if (rebuilt) overlayCurrent(repo, rebuilt.tree);
  const warnings = [...evals.warnings, ...planWarnings];
  if (unproved.length) {
    warnings.push(`${unproved.join(', ')} changed since ${unproved.length === 1 ? 'its' : 'their'} last \`eval check\`, so this baseline skips ${unproved.length === 1 ? 'it' : 'them'}, and a loop does not start on it.`);
  }
  if (unfinished.length) warnings.push(unfinishedWarning(unfinished));
  const ledger = ledgerText(ledgerState(runs));
  if (ledger) warnings.push(`Run index: ${ledger}`);
  if (patchError) {
    warnings.push(`code.patch could not be written (${patchError}), so the code of this run cannot be restored: its commit does not hold the uncommitted files.`);
  }
  if (code.snapshot.commit === null && code.snapshot.changed_files === null) warnings.push('This is not a Git repository, so the code of this run is not pinned.');
  const digests = Object.fromEntries(cases.map((item) => [item.id, item.task_digest]));
  // What the run executes of each package, which leaves the fixtures out.
  const runDigests = casesDigests(cases).run_digest;
  // The expected result of every declared check, including packages not
  // connected yet: what the change is expected to do is fixed before the
  // code changes, whether or not the package could run. declared says
  // whether --expect gave it, or it was left as any.
  const baselineExpectations = side === 'base' && !options.unavailable ? cases.flatMap((item) => item.checks.map((check) => {
    const given = declared.find((entry) => entry.case === item.id && entry.check === check.id);
    return given ? { ...given, declared: true }
      : { case: item.id, check: check.id, expected: 'any', reason: 'No expectation was declared before the baseline ran.', declared: false };
  })) : side === 'base' ? [] : null;
  const loopRef = side !== 'base' && loop ? { started_at: loop.started_at, baseline: loop.baseline, start_code: loopStartCode(repo, name, loop) } : null;
  const scope = options.case?.length ? 'partial' : 'full';
  // A package may name its own adapter in a harness.json at its root; it
  // runs with that one whatever the plan's agent is, and its run_digest
  // covers that file.
  const agentOf = (item) => (item.adapter?.from === 'package' && typeof item.adapter.agent === 'string' && item.adapter.agent.trim() ? item.adapter.agent.trim() : agent);
  const ownAgents = Object.fromEntries(order.filter((item) => agentOf(item) !== agent).map((item) => [item.id, agentOf(item)]));
  const checkSteps = Object.fromEntries((executes ? order : []).map((item) => [item.id, stepLayout(item.directory, item.checks)]).filter(([, layout]) => layout.steps.length));
  // The run index learns of this run before Harbor starts: if its folder or
  // run.json goes, it still counts.
  appendRunIndex(runs, { event: 'start', run_id: runId, started_at: started.toISOString(), side, scope, role,
    loop: side === 'base' ? null : loopRef, spec: spec.sha256, code: { identity: codeIdentity(snapshot, repo), snapshot },
    cases: executes ? order.map((item) => item.id) : [], task_digest: digests, run_digest: runDigests, agent: executes ? agent ?? null : null,
    model: executes ? model ?? null : null, attempts: executes ? Object.fromEntries(order.map((item) => [item.id, perCase[item.id]])) : {}, run_plan: plan,
    ...(executes && Object.keys(ownAgents).length ? { agents_by_case: ownAgents } : {}),
    gating: Object.fromEntries(order.map((item) => [item.id, item.checks.filter((check) => check.role === 'gating').map((check) => check.id)])),
    // Where each package with steps records its checks, so the attempts of
    // a run that never finishes are read by the steps it ran.
    ...(Object.keys(checkSteps).length ? { check_steps: checkSteps } : {}),
    ...(baselineExpectations ? { expectations: baselineExpectations.filter((entry) => entry.declared) } : {}),
    ...(approval ? { cost_approval: approval } : {}),
    harbor_jobs: Object.fromEntries(order.map((item) => [item.id, `${item.id}/logs/harbor`])),
    host_env: { mode: host.mode, names: host.names } });
  if (approval) {
    appendDecision(root, { type: 'cost_approval', by: approval.by, ref: approval.ref, run_id: runId, side, spec: spec.sha256,
      cases: order.map((item) => item.id), model: model ?? null, attempts: perCase });
  }
  // Packages run one at a time. A final run stops at the first package whose
  // gating checks failed in an attempt that completed: that code can no
  // longer be accepted, so the rest would only spend time, unless
  // --all-packages asks for every package, which spends the loop's budget
  // the same way. Every package builds from the application as it is when
  // that package runs, so after each one the code, the packages and the kit
  // are read again, by content and by when each file was last written: an
  // edit put back before the run ends still shows.
  const look = executes ? watchRun(repo, name, code.snapshot, evalStart, rebuilt) : null;
  const codeMoves = [];
  const packageMoves = {};
  const kitMoves = new Set();
  const outcomes = [];
  const projects = {};
  const running = executes ? order : [];
  for (const [position, item] of running.entries()) {
    const stopped = role === 'final' && !options.allPackages ? outcomes.find((outcome) => failedValidly(outcome, cases.find((entry) => entry.id === outcome.id).checks)) : null;
    if (stopped) {
      skipped.push({ case: item.id, reason: 'final_stopped', after: stopped.id });
      continue;
    }
    progress(`run ${runId} (${side}${role ? `, ${role}` : ''}): ${item.id} started (${position + 1}/${running.length}, ${times(perCase[item.id])})`);
    // A baseline on the rebuilt start code builds every image from that folder.
    const outcome = runCase(harborCommand(), item, item.checks, path.join(directory, item.id),
      { agent: agentOf(item), model, yes: host.yes, withheld: host.withheld, timeout: options.timeout ?? 30, harness: harnessDirectory, repo: rebuilt?.tree ?? repo, attempts: perCase[item.id] });
    outcomes.push(outcome);
    projects[item.id] = trialProjects(path.join(directory, item.id));
    const gate = outcome.summary.gating;
    progress(`run ${runId}: ${item.id} finished, ${outcome.execution.status}, gating ${gate.pass} pass, ${gate.fail} fail, ${gate.unknown} unknown`);
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
  if (moved) warnings.push('The code changed while this run executed, so its results do not belong to one version of the code: it neither passes nor counts as a baseline.');
  // So do results of packages, or of a kit, that changed while they ran: a
  // package whose files changed, or every one once the kit changed.
  const ranConfirmation = confirmation.gap ? null : confirmationOf(confirmation.entries, spec.sha256, { task_digest: digests, run_digest: runDigests });
  const changedDuring = ran.map((item) => item.id).filter((id) => kitMoves.size > 0 || packageMoves[id] !== undefined);
  const packagesMoved = changedDuring.length > 0;
  if (packagesMoved) {
    const files = [...changedDuring.flatMap((id) => (packageMoves[id] ?? []).map((file) => (file.startsWith('\0') ? `${id}/ (${file.slice(1)})` : `${id}/${file}`))),
      ...[...kitMoves].sort().map((file) => `kit/${file}`)];
    warnings.push(`The eval packages changed while this run executed: ${changedDuring.join(', ')}${files.length ? ` (${listed(files)})` : ''}. Its results do not belong to one version of them: it neither passes nor counts as a baseline.`);
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
  // The light tier holds only for code that calls no model. An attempt whose
  // adapter reported tokens or cost shows that a result can depend on one:
  // such a run of a light-tier loop cannot pass, and the loop ends
  // (tier_changed).
  const modelUse = outcomes.filter((outcome) => outcome.attempts.some(reportedModelUse)).map((outcome) => outcome.id);
  const tripped = side !== 'base' && tier === 'light' ? modelUse : [];
  if (tripped.length) {
    warnings.push(`The adapter reported model use (tokens or cost) for ${list(tripped)} in this light-tier loop. The light tier holds only for code that calls no model, so this ${trial ? 'trial shows the loop rests on a tier that no longer holds' : 'run cannot pass'}, and the loop has ended (tier_changed).`);
  } else if (modelUse.length && (tier === 'light' || plan?.tier === 'light' || (side !== 'head' && !confirmed && evals.tier?.eligible))) {
    warnings.push(`The adapter reported model use (tokens or cost) for ${list(modelUse)} in this ${side === 'base' ? 'baseline' : side === 'trial' ? 'trial' : 'run'}. The light tier holds only for code that calls no model, so the change no longer qualifies for it while ${modelUse.length === 1 ? 'that package stays' : 'those packages stay'} as ${modelUse.length === 1 ? 'it is' : 'they are'} (\`eval validate\` names it under tier.reasons).`);
  }
  // A cost cap counts only the cost an adapter reports.
  const cap = inLoop && isNumber(loop.budget?.max_cost_usd) ? loop.budget.max_cost_usd : null;
  const uncosted = cap === null ? [] : outcomes.filter((outcome) => outcome.attempts.some((entry) => entry.status === 'completed' && typeof entry.usage?.cost_usd !== 'number'))
    .map((outcome) => outcome.id);
  if (uncosted.length) {
    warnings.push(`The adapter reported no cost for ${list(uncosted)}, so the loop's cost cap of ${shownCost(cap)} cannot be enforced for ${they(uncosted)}: the budget counts only the cost an adapter reports.`);
  }
  const record = {
    schema_version: '1.0', run_id: runId, side, scope,
    // screen or final inside a loop that needs a final run, trial for a trial
    // inside a loop; otherwise null. A final run names its screen run and the
    // order its packages ran in.
    role, ...(role === 'final' ? { final_of: finalOf, run_order: outcomes.map((outcome) => outcome.id), ...(options.allPackages ? { all_packages: true } : {}) } : {}),
    started_at: started.toISOString(), finished_at: finished.toISOString(),
    execution_status: status, verdict: null,
    code_version: code.version, spec_snapshot: spec,
    code_changed_during_run: moved,
    // The packages after whose run the code differed from the run's start.
    ...(moved ? { code_changed_during: codeMoves } : {}),
    packages_changed_during_run: packagesMoved,
    // A partial base record never becomes a loop's baseline.
    is_baseline: side === 'base' && scope === 'full' && status === 'completed' && !moved && !packagesMoved,
    // A run on the start code rebuilt outside the project (--at-start).
    ...(rebuilt ? { at_start: true } : {}),
    baseline: side !== 'base' && base?.is_baseline ? base.run_id : null,
    // The base record a head run or a trial was compared with, also when it
    // records an unavailable baseline.
    base_run: side !== 'base' ? base?.run_id ?? null : null,
    // The loop of loop.json this head run or trial was made in: its start,
    // baseline and start code, or null outside a loop. Only a head run that
    // names a loop is one of its runs.
    ...(side !== 'base' ? { loop: loopRef } : {}),
    // A head run made outside a loop is a comparison only: no budget, final
    // review or final run applies to it, so whatever its verdict, it is not
    // an acceptance.
    ...(side === 'head' && !inLoop ? { not_acceptance: true } : {}),
    // The tier of that loop, light or full, or null outside a loop. A run of
    // a light-tier loop whose adapter reported model use names its packages.
    ...(side !== 'base' ? { tier } : {}),
    ...(tripped.length ? { tier_changed: { reason: 'model_use', cases: tripped } } : {}),
    baseline_unavailable_reason: null,
    // task_digest covers every file of each package and the kit; run_digest
    // leaves the fixtures out, and decides whether two runs ran the same
    // package.
    code_snapshot: snapshot, task_digest: digests, run_digest: runDigests,
    // The files behind each task digest, so a report can name what changed.
    eval_snapshot: { packages: evalStart.packages, kit: evalStart.kit, ...(packagesMoved ? { changed_during_run: changedDuring } : {}) },
    // The user's checks confirmation of the packages this run ran, or null.
    checks_confirmation: ranConfirmation ? { id: ranConfirmation.id, at: ranConfirmation.confirmed?.at ?? null } : null,
    // The judge checks this run counted as gating, as `case:then`.
    ...(judgeGating.length ? { judge_gating: judgeGating } : {}),
    // Who approved what a model-calling run costs before any confirmation.
    ...(approval ? { cost_approval: approval } : {}),
    // The host variables Harbor could read: every declared one (--yes), the
    // ones --allow-env names, or none.
    host_env: { mode: host.mode, names: host.names, declared: host.declared, withheld: host.withheld },
    // attempts is the number each package with a live dependency makes;
    // attempts_by_case what each package that ran made. Head runs copy the
    // plan of their base record.
    environment_ref: { harbor: tools.harbor, agent: executes ? agent : null, model: executes ? model ?? null : null, attempts,
      ...(executes && Object.keys(ownAgents).length ? { agents_by_case: ownAgents } : {}),
      attempts_by_case: executes ? Object.fromEntries(ran.map((item) => [item.id, perCase[item.id]])) : {}, run_plan: plan,
      dependencies: Object.fromEntries(ready.map((item) => [item.id, item.dependencies])) },
    map_ref: evals.map ?? null,
    // The compose projects Harbor ran each package's trials in, as
    // `run cleanup` removes them.
    harbor_projects: projects,
    // What the run took and used; each case's usage counts its attempts.
    usage,
    // The run index lists this run.
    indexed: true,
    cases: outcomes.map((outcome) => outcome.summary), skipped, warnings,
  };
  let comparison = null;
  if (side === 'base') {
    record.baseline_unavailable_reason = options.unavailable ?? (record.is_baseline ? null : scope === 'partial' && status === 'completed' && !moved && !packagesMoved ? null : 'execution_blocked');
    record.baseline_expectations = baselineExpectations;
    const expectedOf = (id, check) => declared.find((item) => item.case === id && item.check === check)?.expected ?? 'any';
    // A check that passed in some attempts and failed in others has no settled
    // result before the change: it is unstable, never a mismatch.
    record.baseline_unstable = outcomes.flatMap((outcome) => outcome.results.flatMap((entry) => {
      const counts = outcome.counts[entry.id];
      return counts?.pass > 0 && counts.fail > 0 ? [{ case: outcome.id, check: entry.id, expected: expectedOf(outcome.id, entry.id), counts }] : [];
    }));
    const unstableAt = (items, id, check) => (items ?? []).some((item) => item.case === id && item.check === check);
    record.baseline_mismatch = outcomes.flatMap((outcome) => outcome.results.flatMap((entry) => {
      const expected = expectedOf(outcome.id, entry.id);
      return expected !== 'any' && entry.result !== 'unknown' && entry.result !== expected && !unstableAt(record.baseline_unstable, outcome.id, entry.id)
        ? [{ case: outcome.id, check: entry.id, expected, got: entry.result }] : [];
    }));
    if (record.baseline_unstable.length) {
      const shown = record.baseline_unstable.map(({ case: id, check, counts }) => `${id}/${check} ${counts.pass} of ${counts.pass + counts.fail + counts.unknown} passed`);
      warnings.push(`Checks that passed in some attempts and failed in others at the baseline (baseline_unstable): ${shown.join(', ')}. Their result before the change is not settled, so a later pass shows nothing about this change.`);
    }
    // An expectation follows what the change does, so it does not flip with
    // one outcome of a check that was unstable at the previous baseline.
    const previous = fullBaseRecords(earlier, spec.sha256).filter((run) => run.is_baseline).pop() ?? null;
    if (previous && !options.unavailable) {
      for (const item of previous.baseline_unstable ?? []) {
        const now = expectedOf(item.case, item.check);
        if (now !== item.expected) {
          warnings.push(`The expected result of ${item.case}/${item.check} changed from ${item.expected} to ${now} since the baseline ${previous.run_id}, where it was unstable.`);
        }
      }
    }
    if (fullBaseRecords(earlier, spec.sha256).some((run) => run.is_baseline && sameCode(run.code_snapshot, code.snapshot, repo) === false)) {
      warnings.push('An earlier baseline for this Spec ran on different code. A baseline describes the code before the change.');
    }
    if (loop) {
      warnings.push(loopEnded
        ? `The loop for this Spec has ended; it compared every run with its own baseline ${loop.baseline}.`
        : `The loop for this Spec keeps comparing with its own baseline ${loop.baseline} while it runs.`);
    }
  } else {
    record.baseline_unavailable_reason = !base ? 'no_baseline' : base.is_baseline ? null : base.baseline_unavailable_reason ?? 'execution_blocked';
    const results = comparisonOf({ base, runsDirectory: runs, outcomes, cases, digests, runDigests, unavailableReason: record.baseline_unavailable_reason });
    const gating = results.filter((entry) => entry.role === 'gating');
    // A partial run never passes, even when it names every package. Nor does
    // a light-tier run whose adapter reported model use, nor a trial.
    record.verdict = moved || packagesMoved ? 'unverified' : gating.some((entry) => entry.after === 'fail') ? 'fail'
      : tripped.length || trial ? 'unverified'
        : record.scope === 'full' && status === 'completed' && !skipped.length && gating.length && gating.every((entry) => entry.after === 'pass') ? 'pass' : 'unverified';
    if (trial && !moved && !packagesMoved && gating.length && gating.every((entry) => entry.after === 'pass')) record.trial_gating_passed = true;
    // The comparison holds only when both sides ran the same way. It is shown,
    // not enforced: the verdicts stay as they are. A partial run makes one
    // attempt of each package unless --attempts says otherwise. Inside a loop
    // only Harbor can still differ: other settings are refused.
    if (base?.is_baseline && base.environment_ref) {
      const names = { agent: 'agent', model: 'model', attempts: 'attempts', harbor: 'Harbor version' };
      // A screen run makes one attempt of each package by design.
      const differ = Object.keys(names).filter((key) => key in base.environment_ref
        && (key !== 'attempts' || (role !== 'screen' && !trial && (!partial || options.attempts !== undefined)))
        && (base.environment_ref[key] ?? null) !== (record.environment_ref[key] ?? null));
      if (differ.length) {
        warnings.push(`The settings of this run differ from those of the baseline ${base.run_id}: ${differ.map((key) => `${names[key]} ${record.environment_ref[key] ?? 'none'} here, ${base.environment_ref[key] ?? 'none'} in the baseline`).join('; ')}. A different result may come from that, not from the change.`);
      }
    }
    // The lines no check verifies, of the packages that ran: the user judges
    // them at acceptance, from what the evaluated agent produced. A line whose
    // judge check this run counted as gating is verified by that check, so it
    // is not among them.
    const heldJudged = new Set(judgeGating.map((entry) => {
      const at = String(entry).indexOf(':');
      return at > 0 ? judgeKey(String(entry).slice(0, at), String(entry).slice(at + 1)) : String(entry);
    }));
    const manual = ran.flatMap((item) => (Array.isArray(item.scenario?.manual) ? item.scenario.manual : [])
      .filter((entry) => !heldJudged.has(judgeKey(item.id, entry.then)))
      .map((entry) => ({ case: item.id, then: thenKey(entry.then), reason: entry.reason.trim() })));
    comparison = { schema_version: '1.0', run_id: runId, baseline: record.baseline, base_run: record.base_run, results, manual };
    writeJSON(path.join(directory, 'compare.json'), comparison);
  }
  const runJson = path.join(directory, 'run.json');
  writeJSON(runJson, record);
  appendRunIndex(runs, { event: 'finish', run_id: runId, execution_status: status, verdict: record.verdict, minutes: usage.minutes,
    run_json: digest(readFileSync(runJson)) });
  // Inside a loop, a full head run writes its report at once, with Result
  // and Changes taken from the records.
  let report = null;
  if (side === 'head' && loop && record.scope === 'full') {
    try {
      const written = writeReport(repo, name, { run: runId });
      report = { file: written.file, created: written.created };
    } catch (error) {
      warnings.push(`The report of ${runId} could not be written (${error.message}); \`loop report --run ${runId}\` writes it.`);
    }
  }
  // A screen run that passed on code that already failed a gating check, with
  // these packages, agent and model, leads to no final run.
  const burned = role === 'screen' && record.verdict === 'pass'
    ? [...new Set(failuresOf(sameCodeResults(repo, runs, spec.sha256, earlier), record,
      new Set(comparison.results.filter((entry) => entry.role === 'gating').map((entry) => checkKey(entry.case, entry.check))), repo).map((entry) => entry.run_id))] : [];
  // The packages whose gating checks failed in an attempt that completed: a
  // result of the code, whatever else errored, and it counts.
  const failedHere = moved || packagesMoved ? [] : outcomes.filter((outcome) => failedValidly(outcome, cases.find((entry) => entry.id === outcome.id).checks)).map((outcome) => outcome.id);
  // What keeps this run from being a baseline a loop starts on, or from
  // passing.
  const unverifiedBy = [...(moved ? ['code_changed_during_run'] : []), ...(packagesMoved ? ['packages_changed_during_run'] : []),
    ...(!['completed', 'not_run'].includes(status) ? ['execution_incomplete'] : []), ...(record.scope === 'partial' ? ['partial'] : []),
    ...(tripped.length ? ['model_use'] : []), ...(trial ? ['trial'] : []), ...(skipped.some((item) => item.reason === 'final_stopped') ? ['final_stopped'] : [])];
  const baseFacts = side !== 'base' ? null : {
    // Whether a loop can start on this base record as far as the record
    // goes; loop start checks the confirmation, the plan and the start code.
    loop_baseline: { usable: (record.is_baseline || status === 'not_run') && !record.baseline_mismatch?.length && !unproved.length,
      reasons: [...unverifiedBy.filter((entry) => entry !== 'trial'), ...(record.baseline_mismatch?.length ? ['baseline_mismatch'] : []), ...(unproved.length ? ['skipped_unproved'] : [])] },
    confirmation_current: Boolean(confirmed),
    ...(pin ? { start_code: restoreHint(name, pin.loop, null) } : {}),
    ...(loop ? { loop: { started_at: loop.started_at, baseline: loop.baseline, ended: loopEnded } } : {}),
  };
  const headFacts = side === 'base' ? null : {
    in_loop: inLoop,
    // Whether this run could be accepted, as far as it goes: a passing full
    // head run of a loop, not a screen run. A pass outside a loop, or of a
    // trial, is no acceptance: no budget, final review or final run applies.
    acceptable: side === 'head' && inLoop && record.verdict === 'pass' && record.scope === 'full' && role !== 'screen' && !burned.length,
    ...(record.verdict === 'pass' && !inLoop ? { not_acceptance: 'This pass was made outside a loop: no budget, final review or final run applies to it, so it is not an acceptance.' } : {}),
    ...(trial ? { not_acceptance: 'A trial is never a baseline, a run of a loop, an accepted run or a proof; its completed failures count for its code.' } : {}),
    // A failure in an attempt that completed counts for this code with these
    // packages, agent and model: no run of that code can be accepted.
    ...(failedHere.length ? { failures_count: { cases: failedHere, ...(role === 'final' ? { final_failed: true } : {}) } } : {}),
    ...(burned.length ? { failed_before: burned } : {}), ...(passedFinal ? { final_passed_before: passedFinal } : {}),
    ...(tripped.length ? { loop_ended: { reason: 'tier_changed', cases: tripped } } : {}),
  };
  return {
    run_id: runId, directory, side, scope: record.scope, role, execution_status: status, verdict: record.verdict,
    is_baseline: record.is_baseline, baseline: record.baseline, base_run: record.base_run ?? null, baseline_unavailable_reason: record.baseline_unavailable_reason,
    cases: record.cases, skipped, warnings, run_plan: plan, attempts: record.environment_ref.attempts_by_case, usage,
    host_env: record.host_env, ...(approval ? { cost_approval: approval } : {}),
    ...(side !== 'base' ? { tier } : {}), ...(tripped.length ? { tier_changed: record.tier_changed } : {}), ...(report ? { report } : {}),
    ...(trial && record.trial_gating_passed ? { trial_gating_passed: true } : {}),
    unverified_by: unverifiedBy,
    // Every check, then the gating ones alone: only they decide the verdict.
    ...(side === 'base' ? { baseline_mismatch: record.baseline_mismatch, baseline_unstable: record.baseline_unstable, ...baseFacts } : {
      compare: tallyOf(comparison.results), compare_gating: tallyOf(comparison.results, 'gating'), ...headFacts }),
    suggestion: inLoop ? { command: ['loop', 'status', name, '--repo', repo], why: 'the loop\'s state after this run, and what it allows now' } : null,
  };
}

// The runs of a change, newest last, with what each one is: base, head or
// trial, full or partial, its loop, its code and result, and whether the run
// index keeps it only (lost) or it never finished (interrupted). side keeps
// one side. Read-only.
export function listRuns(repo, name, { side } = {}) {
  if (side !== undefined && !['base', 'head', 'trial'].includes(side)) throw new Error('--side is base, head or trial.');
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const runs = readRuns(runsDirectory).filter((run) => !side || run.side === side);
  return { change: name,
    runs: runs.map((run) => ({ run_id: run.run_id, side: run.side, scope: run.scope ?? 'full', role: run.role ?? null, started_at: run.started_at ?? null,
      finished_at: run.finished_at ?? null, spec: run.spec_snapshot?.sha256 ?? null, loop: run.loop?.started_at ?? null,
      execution_status: run.execution_status, verdict: run.verdict ?? null, is_baseline: run.is_baseline === true,
      code: { commit: run.code_snapshot?.commit ?? null, digest: codeIdentity(run.code_snapshot, repo) ?? run.code_identity ?? null,
        uncommitted: run.code_snapshot?.changed_files?.length ?? 0 },
      cases: (run.cases ?? []).map((item) => item.id), minutes: run.usage?.minutes ?? null,
      ...(run.cost_approval ? { cost_approval: run.cost_approval } : {}), ...(isLost(run) ? { lost: true } : {}), ...(isInterrupted(run) ? { interrupted: true } : {}),
      ...(run.at_start ? { at_start: true } : {}) })),
    ledger: ledgerState(runsDirectory) };
}

// One run as it is recorded: run.json, or what the run index keeps of a
// lost or interrupted one, its comparison, the attempts of each package and
// its run index entries. Read-only.
export function showRun(repo, name, { run } = {}) {
  if (!filled(run)) throw new Error('--run names the run to show.');
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const record = readRuns(runsDirectory).find((entry) => entry.run_id === run);
  if (!record) throw new Error(`No run ${run} in .genesis/edd/${name}/runs/ or its run index.`);
  const folder = path.join(runsDirectory, run);
  let compare = null;
  try { compare = readJSON(path.join(folder, 'compare.json')); } catch { /* a base record or no comparison */ }
  const attempts = Object.fromEntries((record.cases ?? []).map((item) => [item.id, readAttempts(path.join(folder, item.id, 'attempts.json'))
    ?? (isInterrupted(record) ? trialAttempts(path.join(folder, item.id), record.check_steps?.[item.id] ?? packageLayout(path.dirname(runsDirectory), item.id)) : null)]));
  const index = readRunIndex(runsDirectory).runs.get(run) ?? { start: null, finish: null };
  return { change: name, run: record, compare, attempts, index, folder_exists: existsSync(folder), usage: runUsage(runsDirectory, record) };
}

// A run compared with a base record of its Spec export: by default the
// latest valid baseline of the export, else the base record against names.
// The comparison is the one a run makes of itself, from the recorded results
// of both, so a run can be compared again with another baseline. Read-only.
export function compareRuns(repo, name, { run, against } = {}) {
  if (!filled(run)) throw new Error('--run names the run to compare.');
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const all = readRuns(runsDirectory);
  const record = all.find((entry) => entry.run_id === run);
  if (!record) throw new Error(`No run ${run} in .genesis/edd/${name}/runs/ or its run index.`);
  if (!usableRun(record)) throw new Error(`${run} is ${isLost(record) ? 'lost: its record is gone' : 'interrupted: it never finished'}, so it has no results to compare.`);
  const spec = record.spec_snapshot?.sha256 ?? null;
  const base = against ? all.find((entry) => entry.run_id === against) : latestValidBaseline(all, spec).base;
  if (against && !base) throw new Error(`No run ${against} in .genesis/edd/${name}/runs/.`);
  if (base && (base.side !== 'base' || !usableRun(base))) throw new Error(`${base.run_id} is no base record whose results can be read.`);
  const warnings = [];
  if (base && base.spec_snapshot?.sha256 !== spec) warnings.push(`${base.run_id} was recorded for another Spec export than ${run}.`);
  if (base && (base.scope ?? 'full') !== 'full') warnings.push(`${base.run_id} is a partial base record.`);
  if (base && sameCode(base.code_snapshot, record.code_snapshot, repo) === true) warnings.push(`${base.run_id} and ${run} ran the same code.`);
  // Each package's checks as they are now, with the roles the run counted.
  const root = eddDirectory(repo, name);
  const cases = (record.cases ?? []).map((item) => {
    let declared = [];
    try { declared = readJSON(path.join(root, 'evals', item.id, 'tests/checks.json')).checks ?? []; } catch { /* no longer there */ }
    return { id: item.id, checks: countedChecks(item.id, declared, record.judge_gating) };
  });
  const outcomes = cases.map((item) => {
    const folder = path.join(runsDirectory, run, item.id);
    return { id: item.id, results: readResults(folder, item.checks),
      counts: readCounts(folder, item.checks, record.environment_ref?.attempts_by_case?.[item.id] ?? record.environment_ref?.attempts ?? 1) };
  });
  const evals = (() => { try { return casesDigests(validateEval(repo, name).cases); } catch { return null; } })();
  const changedSince = evals ? cases.map((item) => item.id).filter((id) => !samePackage(digestsAt(record, id), digestsAt(evals, id))) : [];
  if (changedSince.length) warnings.push(`${changedSince.join(', ')} changed since ${run}: the checks are read as they are now.`);
  const results = comparisonOf({ base, runsDirectory, outcomes, cases, digests: record.task_digest ?? {}, runDigests: record.run_digest ?? {},
    unavailableReason: base && !base.is_baseline ? base.baseline_unavailable_reason ?? 'execution_blocked' : 'no_baseline' });
  return { change: name, run, against: base?.run_id ?? null, side: record.side, results, compare: tallyOf(results), compare_gating: tallyOf(results, 'gating'), warnings };
}

// Removes the Docker containers, networks and volumes Harbor made for one
// run's trials, and only those: the compose projects named after the trial
// folders of that run (harbor_projects, and the trial folders on disk for a
// run that never finished). Nothing else is pruned or removed; images stay.
// { run_id, projects, removed: { containers, networks, volumes }, errors }.
export function cleanupRun(repo, name, { run } = {}) {
  if (!filled(run)) throw new Error('--run names the run whose Harbor containers to remove.');
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const record = readRuns(runsDirectory).find((entry) => entry.run_id === run);
  const folder = path.join(runsDirectory, run);
  if (!record && !existsSync(folder)) throw new Error(`No run ${run} in .genesis/edd/${name}/runs/ or its run index.`);
  const trials = new Map();
  for (const entries of Object.values(record?.harbor_projects ?? {})) for (const entry of Array.isArray(entries) ? entries : []) if (entry?.project) trials.set(entry.project, entry);
  let caseFolders = [];
  try { caseFolders = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { /* lost */ }
  for (const id of caseFolders) for (const entry of trialProjects(path.join(folder, id))) trials.set(entry.project, entry);
  const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (docker(['info', '--format', '{{.ServerVersion}}']).status !== 0) {
    throw blocked('Docker is not running.', repo, name, [{ code: 'docker_unavailable', kind: 'technical', owner: 'agent', layer: 'machine',
      message: 'Docker is not running on this machine, so the containers of this run cannot be listed or removed.' }]);
  }
  // Every compose project on this machine, read only to find those of this
  // run's trials: a trial's environment, and a verifier in its own one.
  const label = 'com.docker.compose.project';
  const known = new Set();
  for (const kind of [['ps', '-a'], ['network', 'ls'], ['volume', 'ls']]) {
    const out = docker([...kind, '--filter', `label=${label}`, '--format', `{{.Label "${label}"}}`]);
    for (const line of String(out.stdout ?? '').split('\n')) if (line.trim()) known.add(line.trim());
  }
  const prefixes = [...trials.values()].map((entry) => entry.prefix).filter(Boolean);
  const projects = [...new Set([...trials.keys(), ...[...known].filter((project) => prefixes.some((prefix) => project.startsWith(prefix)))])].sort();
  const removed = { containers: [], networks: [], volumes: [] };
  const errors = [];
  for (const project of projects) {
    const ids = (args) => String(docker(args).stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    const filter = ['--filter', `label=${label}=${project}`];
    for (const [key, list, remove] of [['containers', ['ps', '-a', '-q', ...filter], ['rm', '-f']], ['networks', ['network', 'ls', '-q', ...filter], ['network', 'rm']],
      ['volumes', ['volume', 'ls', '-q', ...filter], ['volume', 'rm']]]) {
      const found = ids(list);
      if (!found.length) continue;
      const result = docker([...remove, ...found]);
      if (result.status === 0) removed[key].push(...found);
      else errors.push(`${project}: docker ${remove.join(' ')} failed: ${saidBy(result)}`);
    }
  }
  return { change: name, run_id: run, projects, removed, errors,
    ...(record && !record.finished_at && !isLost(record) ? { still_running_possible: true } : {}) };
}
