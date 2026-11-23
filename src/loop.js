import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { codeState, digest, genesisReview, isGenerated, readJSON } from './project.js';
import { eddDirectory, validateEval } from './eval.js';
import { activeLoop, codeSnapshot, ignoreRecords, pinnedBase, readRuns, recordedBaseline, restoreHint, sameCode, savePatch, startCode } from './run.js';

const TEMPLATE_MARK = 'GENESIS_EDD_TEMPLATE';
const SECTIONS = ['Result', 'Cause', 'Changes', 'Next'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const short = (commit) => (commit ? commit.slice(0, 7) : 'none');
const gap = (code, route, message, owner = 'agent', kind = 'artifact') => ({ code, kind, owner, route, message });

function blocked(message, repo, name, gaps) {
  return Object.assign(new Error(message), {
    code: 'LOOP_INPUT_BLOCKED', gaps,
    resume: { stage: 'loop-and-implement', change: name, command: ['workflow', 'check', 'loop-and-implement', name, '--repo', repo] },
  });
}

const loopFile = (repo, name) => path.join(eddDirectory(repo, name), 'loop.json');
const reportFile = (repo, name, runId) => path.join(eddDirectory(repo, name), 'reports', `${runId}.md`);
const acceptedFile = (repo, name) => path.join(eddDirectory(repo, name), 'accepted.json');

// loop.json is replaced when a loop restarts or its budget is raised. A
// restarted loop keeps the loops before it under previous.
function saveLoop(repo, name, loop) {
  const file = loopFile(repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(loop, null, 2)}\n`);
}

function budgetOptions(options) {
  const iterations = options.iterations ?? 5;
  const minutes = options.minutes ?? 60;
  if (!Number.isInteger(iterations) || iterations < 1 || !(minutes > 0)) throw new Error('--max-iterations is a whole number of 1 or more and --max-minutes a number above 0.');
  return { iterations, minutes };
}

const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));

// An acceptance belongs to the loop it was given in: the same Spec, and the
// same start. Records written before loops were named are matched by run.
const acceptedIn = (record, loop, runs) => record?.spec?.sha256 === loop.spec
  && (record.loop_started_at ? record.loop_started_at === loop.started_at : runs.some((run) => run.run_id === record.run_id));

// The head runs of one loop: its Spec, from its start. Full runs count toward
// the budget and can be accepted; partial ones are a quick look.
const loopRuns = (all, loop) => all.filter((run) => run.side === 'head' && run.spec_snapshot?.sha256 === loop.spec && run.started_at >= loop.started_at);
const fullRuns = (runs) => runs.filter((run) => (run.scope ?? 'full') === 'full');

// The code an acceptance covers, as accepted.json keeps it, for when the
// accepted run's folder is gone. Records written before the digest named its
// kind compare by their commit when nothing was uncommitted.
const acceptedSnapshot = (record) => ({ commit: record.commit ?? null, changed_files: record.uncommitted_files ?? null,
  digest: record.code_digest ?? null, ...(record.code_digest_of ? { digest_of: record.code_digest_of } : {}) });

// The user's acceptance of the loop running for this Spec, or null. Read-only.
export function loopAcceptance(repo, name, spec) {
  const loop = readLoop(repo, name);
  if (!loop || loop.spec !== spec || !existsSync(acceptedFile(repo, name))) return null;
  let record = null;
  try { record = readJSON(acceptedFile(repo, name)); } catch { return null; }
  return acceptedIn(record, loop, fullRuns(loopRuns(readRuns(path.join(eddDirectory(repo, name), 'runs')), loop))) ? record : null;
}

// What the loop needs before it may change code. Read-only. While a loop runs
// for the Spec, its baseline is the one it pinned; latest asks for the
// baseline a new or restarted loop would pin instead.
export function loopInputs(repo, name, { latest = false } = {}) {
  const evals = validateEval(repo, name);
  // Packages still waiting for a connection are expected in a project with no
  // implementation yet: building that connection is part of the loop.
  const gaps = evals.gaps.filter((entry) => entry.code !== 'integration_pending');
  const loop = !latest && evals.spec ? activeLoop(repo, name, evals.spec) : null;
  let base = null;
  if (loop) {
    const pinned = pinnedBase(repo, name, loop);
    base = pinned.run;
    if (pinned.gap) gaps.push(pinned.gap);
  } else if (evals.spec) {
    base = recordedBaseline(repo, name, evals.spec);
    if (!base) gaps.push(gap('baseline_missing', 'run-eval', 'Record the baseline first: `run start --baseline --expect FILE`, or `--baseline --unavailable no_implementation` when nothing can run yet.'));
  }
  const code = codeState(repo);
  if (code.changed === null) {
    gaps.push(gap('git_missing', 'loop-and-implement', 'Every run records its code as a commit plus a patch, which needs Git. Initialize Git in the project, or ask the user to.', 'user', 'technical'));
  }
  return { evals, base, code, gaps };
}

const readLoop = (repo, name) => (existsSync(loopFile(repo, name)) ? readJSON(loopFile(repo, name)) : null);

// Fixes the reference points of one loop: the Spec, the baseline and the code
// it ran on, the packages as they were, and the budget the user agreed to.
// Nothing has to be committed: every run keeps its code as commit plus patch.
export function startLoop(repo, name, options = {}) {
  const { iterations, minutes } = budgetOptions(options);
  const { evals, base, code, gaps } = loopInputs(repo, name, { latest: true });
  const current = readLoop(repo, name);
  const same = Boolean(current && evals.spec && current.spec === evals.spec);
  if (same && !options.restart) {
    gaps.push(gap('loop_running', 'loop-and-implement', `A loop for this Spec started at ${current.started_at}. Continue it with \`loop status\`, raise its budget with \`loop extend\` once the user agrees, or pass --restart to start it over.`));
  }
  const snapshot = code.changed === null ? null : codeSnapshot(repo).snapshot;
  // A restart keeps the code before the change: the code the first loop of
  // this Spec started from. A loop written before that was recorded started
  // where its baseline ran, when one ran.
  const pinned = same && !current.start_code ? readRuns(path.join(eddDirectory(repo, name), 'runs')).find((run) => run.run_id === current.baseline) : null;
  const kept = same ? current.start_code ?? (pinned?.is_baseline ? startCode(current.base_commit ?? null, pinned.code_snapshot, repo) : null) : null;
  if (base && snapshot) {
    if (kept?.digest) {
      // The baseline the loop already had was checked when it started; a newer
      // one must have run on the same starting code.
      if (base.run_id !== current.baseline && sameCode(base.code_snapshot, kept, repo) !== true) {
        const before = readRuns(path.join(eddDirectory(repo, name), 'runs')).find((run) => run.run_id === current.baseline) ?? null;
        gaps.push(gap('baseline_not_at_start', 'run-eval', `A restart keeps the loop's starting code, ${restoreHint(name, { start_code: kept }, before)}. The baseline ${base.run_id} ran on other code. Record the baseline on the starting code, then run this again. To go on from the current code instead, use \`loop status\`, or \`loop extend\` once the user agrees to more budget.`));
      }
    } else if (base.is_baseline && sameCode(base.code_snapshot, snapshot, repo) !== true) {
      // The baseline must be the code the loop starts from, or comparisons mislead.
      gaps.push(gap('baseline_not_at_start', 'run-eval', `The code changed after the baseline ${base.run_id}. If the change only served the evals, such as .dockerignore, record the baseline again with the same --expect file. Otherwise restore the baseline's code first: its commit plus its code.patch.`));
    }
  }
  if (gaps.length) throw blocked(`The loop cannot start: ${gaps.map((entry) => entry.message).join(' ')}`, repo, name, gaps);
  ignoreRecords(repo);
  let start = kept;
  if (!start) {
    // The starting code is kept as its commit plus a patch of what the commit
    // does not hold, so it can be restored to record a baseline on it.
    const file = path.join(eddDirectory(repo, name), 'loop-start.patch');
    rmSync(file, { force: true });
    const patch = savePatch(repo, snapshot, file);
    start = startCode(code.head, snapshot, repo, patch);
  }
  const now = new Date().toISOString();
  const loop = {
    schema_version: '1.0', change: name, started_at: now,
    spec: evals.spec, baseline: base.run_id, baseline_available: base.is_baseline === true,
    base_commit: start.commit,
    // The code before the change. While the loop runs, every base record must
    // describe this code.
    start_code: start,
    budget: { iterations, minutes },
    // The minutes of the budget count from here; raising the budget restarts them.
    clock_started_at: now, extensions: [],
    task_digest: Object.fromEntries(evals.cases.map((item) => [item.id, item.task_digest])),
    ...(current ? { previous: [...(current.previous ?? []), without(current, 'previous')] } : {}),
  };
  saveLoop(repo, name, loop);
  return { loop, next: { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo] } };
}

// Raises the budget of the running loop when the user agrees to go on: N more
// full runs from now, and M minutes from now. Runs, reports and the baseline
// stay as they are.
export function extendLoop(repo, name, options = {}) {
  const { iterations, minutes } = budgetOptions(options);
  const status = loopStatus(repo, name);
  if (['restart', 'repair_spec'].includes(status.next.action)) {
    throw blocked(`The loop cannot be extended: ${status.next.message}`, repo, name, [gap('spec_changed', status.next.route, status.next.message, status.next.owner ?? 'agent')]);
  }
  const loop = readLoop(repo, name);
  const now = new Date().toISOString();
  const used = status.loop.used.iterations;
  const extended = {
    ...loop, budget: { iterations: used + iterations, minutes }, clock_started_at: now,
    extensions: [...(loop.extensions ?? []), { at: now, runs_used: used, iterations, minutes }],
  };
  saveLoop(repo, name, extended);
  return { loop: extended, next: { action: 'loop_status', command: ['loop', 'status', name, '--repo', repo] } };
}

const compareOf = (runs, run) => {
  try { return readJSON(path.join(runs, run.run_id, 'compare.json')).results; } catch { return []; }
};

// A report is written once per full run. It is complete when the template mark
// is gone and every section has content; a passing run also needs its review.
export function reportGaps(repo, name, run) {
  const file = reportFile(repo, name, run.run_id);
  if (!existsSync(file)) return [`no report at reports/${run.run_id}.md`];
  const text = readFileSync(file, 'utf8');
  const missing = [];
  if (text.includes(TEMPLATE_MARK)) missing.push('the template line is still there');
  for (const section of [...SECTIONS, ...(run.verdict === 'pass' ? ['Review'] : [])]) {
    const match = text.match(new RegExp(`^## ${section}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    if (!match || !match[1].replace(/<!--[\s\S]*?-->/g, '').trim()) missing.push(`section ${section} is empty`);
    else if (section === 'Cause' && /^- `[^`]+` `[^`]+` \([a-z_]+\):\s*$/m.test(match[1])) missing.push('a check in Cause has no cause yet');
  }
  return missing;
}

// Where the loop stands, worked out from the run records. Read-only.
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
  const previous = runs.at(-2) ?? null;
  const warnings = [...evals.warnings];
  if (!base) warnings.push(`The loop's baseline ${loop.baseline} is no longer in runs/. Head runs are refused until it is restored or the loop restarts.`);

  // Each check through the loop: the baseline, then every full run.
  const results = runs.map((run) => new Map(compareOf(runsDirectory, run).map((entry) => [`${entry.case}\n${entry.check}`, entry])));
  const keys = evals.cases.flatMap((item) => {
    let declared = [];
    try { declared = readJSON(path.join(eddDirectory(repo, name), 'evals', item.id, 'tests/checks.json')).checks ?? []; } catch { /* reported by validation */ }
    return declared.map((check) => ({ case: item.id, check: check.id, intent: check.intent, role: check.role }));
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
  const failing = (index) => checks.filter((entry) => entry.role === 'gating' && entry.runs[index] !== 'pass')
    .map((entry) => `${entry.case}/${entry.check}=${entry.runs[index] ?? 'missing'}`).sort();
  // A regression breaks what worked before the change: a gating check that
  // passed in the baseline, or in the run before when there is no baseline
  // result, fails now. A check that only passed during the loop and fails
  // again is lost progress: worth a look, not a reason to unwind. Either
  // compares only results of the same package.
  const brief = ({ case: id, check, intent }) => ({ case: id, check, intent });
  const fails = (entry) => entry.role === 'gating' && entry.runs.at(-1) === 'fail';
  const change = (entry) => {
    if (!latest || !fails(entry)) return null;
    const baseline = comparable(entry.case, latest.task_digest?.[entry.case]) && ['pass', 'fail'].includes(entry.baseline) ? entry.baseline : null;
    const before = previous && previous.task_digest?.[entry.case] === latest.task_digest?.[entry.case] ? entry.runs.at(-2) : null;
    if (baseline === 'pass' || (baseline === null && before === 'pass')) return 'regression';
    return baseline === 'fail' && before === 'pass' ? 'lost' : null;
  };
  const regressions = checks.filter((entry) => change(entry) === 'regression').map(brief);
  const lost = checks.filter((entry) => change(entry) === 'lost').map(brief);
  if (lost.length) warnings.push(`Passed in the run before and fails again: ${lost.map((entry) => `${entry.case}/${entry.check}`).join(', ')}. Compare the two commits.`);
  const repeated = latest && previous ? sameCode(latest.code_snapshot, previous.code_snapshot, repo) : null;
  const stuck = Boolean(latest && previous && repeated !== true && latest.verdict !== 'pass'
    && failing(runs.length - 1).length && failing(runs.length - 1).join() === failing(runs.length - 2).join());
  if (repeated) warnings.push('The last two runs used the same code. Running again without a change shows nothing new.');

  let accepted = null;
  try { accepted = existsSync(acceptedFile(repo, name)) ? readJSON(acceptedFile(repo, name)) : null; } catch {
    warnings.push('accepted.json cannot be read. Restore it; it records the user\'s acceptance.');
  }
  if (!acceptedIn(accepted, loop, runs)) accepted = null;
  // Minutes count from the start of the loop or from the last time the user
  // raised the budget, so a wait for the user is not spent twice. They stop
  // when the user accepts: a finished loop spends no more budget.
  const clock = loop.clock_started_at ?? loop.started_at;
  const stopped = accepted ? Date.parse(accepted.accepted?.at) : Number.NaN;
  const used = { iterations: runs.length, minutes: Math.max(0, Math.round(((Number.isFinite(stopped) ? stopped : Date.now()) - Date.parse(clock)) / 60_000)) };
  const exhausted = used.iterations >= loop.budget.iterations || used.minutes >= loop.budget.minutes;
  const changedPackages = evals.cases.filter((item) => loop.task_digest[item.id] !== item.task_digest).map((item) => item.id);
  if (changedPackages.length) warnings.push(`Changed since the loop started: ${changedPackages.join(', ')}. Their checks now compare with no baseline result (head_only). Say why in the report's Cause.`);
  const reports = Object.fromEntries(runs.map((run) => [run.run_id, reportGaps(repo, name, run)]));
  const acceptedCode = accepted && (runs.find((run) => run.run_id === accepted.run_id)?.code_snapshot ?? acceptedSnapshot(accepted));
  const now = accepted ? codeSnapshot(repo).snapshot : null;
  const keeps = accepted ? sameCode(acceptedCode, now, repo) : null;
  if (keeps === false) warnings.push(`The code changed after the accepted run ${accepted.run_id}. The acceptance covers that run's code only.`);
  // The accepted code is committed when the commit holds all of it.
  const committed = keeps === true && Array.isArray(now.changed_files) && !now.changed_files.length ? now.commit : null;

  const command = (...words) => [...words, name, '--repo', repo];
  const stopBudget = (detail) => ({ action: 'stop_budget', owner: 'user',
    command: [...command('loop', 'extend'), '--max-iterations', '<N>', '--max-minutes', '<M>'],
    message: `The budget is used up (${used.iterations} of ${loop.budget.iterations} runs, ${used.minutes} of ${loop.budget.minutes} minutes).${detail ? ` ${detail}` : ''} Stop and report what still fails. Go on only if the user raises the budget: \`loop extend\`.` });
  let next;
  if (!evals.spec) {
    // The Spec no longer matches the export this loop started from. That is
    // not a new export: nothing is restarted until the cause is known.
    const edited = evals.gaps.some((entry) => entry.code === 'handoff_missing');
    const owner = evals.gaps.some((entry) => entry.owner === 'agent') || edited ? 'agent' : 'user';
    next = { action: 'repair_spec', owner, route: 'agent-spec',
      message: `${edited ? `The Spec files differ from the export this loop started from (${loop.spec.slice(7, 19)}).`
        : `The Spec this loop started from no longer validates: ${evals.gaps.map((entry) => entry.message).join(' ')}`} A loop never changes the Spec: restore what changed. If a requirement itself has to change, that is the user's decision through agent-spec, then a new export and a new loop.` };
  } else if (evals.spec !== loop.spec) {
    next = { action: 'restart', route: 'write-eval', message: 'The Spec was exported again. Bring the packages in line with write-eval, record a baseline for the new Spec, then `loop start --restart`. Expected results never change inside a loop.' };
  } else if (accepted) {
    next = { action: 'done', ...(committed ? { commit: committed } : {}),
      message: `${accepted.accepted?.by ?? 'The user'} accepted run ${accepted.run_id} (${accepted.accepted?.ref ?? 'no reference'}). The loop is finished. ${committed
        ? `The accepted code is committed in ${short(committed)}. Offer to merge it or open a pull request; do neither without the user.`
        : 'Offer to commit the change, merge it or open a pull request; do none of them without the user.'}` };
  } else if (latest && latest.execution_status !== 'completed') {
    next = exhausted ? stopBudget(`The last run, ${latest.run_id}, did not complete.`)
      : { action: 'repair_execution', route: 'write-eval', message: `${latest.run_id} did not complete. Read cases[].execution.reason and each logs/harbor.log. An adapter or environment fault goes to write-eval; a build or timeout fault is rerun. Neither is a result of the code.` };
  } else if (latest && reports[latest.run_id].length && !(latest.verdict === 'pass' && reports[latest.run_id].every((entry) => entry === 'section Review is empty'))) {
    next = { action: 'write_report', command: command('loop', 'report'), message: `Write the report for ${latest.run_id} before anything else: ${reports[latest.run_id].join('; ')}.` };
  } else if (latest?.verdict === 'pass' && reports[latest.run_id].length) {
    // A Genesis review of the change starts from the Map the Spec was written
    // against, so the change lands on that Map's flows on every clone.
    const review = genesisReview(repo, name, evals.map, loop.base_commit);
    next = { action: 'final_review', ...(review ? { genesis_review: review } : {}),
      message: `Every gating check passes.${review ? ` If Genesis is installed, first review the change with its skill, and run every \`map prepare\` of that review as \`genesis ${review.prepare.join(' ')}\`: it starts from the Map the Spec was written against, so the change lands on the same flows on every clone. Give the reviewer the result.` : ''} Have the whole change reviewed in a fresh context against the Spec, then write the Review section of this run's report.` };
  } else if (latest?.verdict === 'pass') {
    next = { action: 'ask_acceptance', owner: 'user', command: [...command('loop', 'accept'), '--run', latest.run_id, '--by', '<user>', '--ref', '<where they said so>'],
      message: 'Show the user the per-check comparison and the report. Record acceptance only with their own words; a pass is not acceptance.' };
  } else if (exhausted) {
    next = stopBudget([regressions.length ? `A check that passed now fails: ${regressions.map((entry) => `${entry.case}/${entry.check}`).join(', ')}.` : '',
      stuck ? 'The same gating checks failed in the last two runs on different code.' : ''].filter(Boolean).join(' '));
  } else if (regressions.length) {
    next = { action: 'split_changes', message: `A check that passed now fails: ${regressions.map((entry) => `${entry.case}/${entry.check}`).join(', ')}. Restore the code of the last run where it passed (its commit, then \`git apply\` its code.patch) and reapply the changes one at a time to find the one that breaks it.` };
  } else if (stuck) {
    next = { action: 'stop_stuck', owner: 'user', message: `The same gating checks failed in the last two runs on different code: ${failing(runs.length - 1).join(', ')}. Stop, report what was tried, and ask the user how to proceed.` };
  } else {
    const open = latest ? failing(runs.length - 1) : checks.filter((entry) => entry.role === 'gating' && entry.baseline !== 'pass').map((entry) => `${entry.case}/${entry.check}=${entry.baseline ?? 'no baseline'}`);
    next = { action: 'iterate', message: `Classify, then change the right layer and run again; nothing has to be committed. Open: ${open.join(', ') || 'none recorded'}.`,
      pending_packages: evals.cases.filter((item) => item.integration?.state !== 'ready').map((item) => item.id) };
  }
  return {
    change: name,
    loop: { started_at: loop.started_at, base_commit: loop.base_commit, baseline: loop.baseline,
      baseline_available: loop.baseline_available, budget: loop.budget, clock_started_at: clock,
      extensions: loop.extensions ?? [], used },
    runs: runs.map((run) => ({ run_id: run.run_id, commit: run.code_snapshot?.commit ?? null, patch: run.code_snapshot?.patch ?? null, execution_status: run.execution_status,
      verdict: run.verdict, report: reports[run.run_id].length ? 'incomplete' : 'complete' })),
    partial_runs: ours.length - runs.length, checks, regressions, lost_progress: lost, stuck, changed_packages: changedPackages,
    accepted: accepted ? { run_id: accepted.run_id, by: accepted.accepted?.by ?? null, ref: accepted.accepted?.ref ?? null, at: accepted.accepted?.at ?? null } : null,
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

// Writes the report skeleton of a full run, with Result taken from the records.
// It never overwrites a report.
export function writeReport(repo, name, options = {}) {
  const status = loopStatus(repo, name);
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const id = options.run ?? status.runs.at(-1)?.run_id;
  const index = status.runs.findIndex((run) => run.run_id === id);
  if (index < 0) throw new Error(`${id ?? 'No run'} is not a full run of this loop. Reports cover full runs only.`);
  const file = reportFile(repo, name, id);
  if (existsSync(file)) return { file, created: false, missing: reportGaps(repo, name, readJSON(path.join(runsDirectory, id, 'run.json'))) };
  const run = readJSON(path.join(runsDirectory, id, 'run.json'));
  const compare = compareOf(runsDirectory, run);
  const before = index ? readJSON(path.join(runsDirectory, status.runs[index - 1].run_id, 'run.json'))
    : readRuns(runsDirectory).find((entry) => entry.run_id === status.loop.baseline);
  const files = changedFiles(repo, before?.code_snapshot, run.code_snapshot);
  const from = index ? `run ${status.runs[index - 1].run_id}` : `the baseline ${status.loop.baseline}`;
  const baseline = run.baseline ?? `unavailable (${run.baseline_unavailable_reason})`;
  const open = compare.filter((entry) => entry.verdict !== 'holds');
  const text = `<!-- ${TEMPLATE_MARK}: keep Result as written; write the other sections, then delete this line. -->
# ${name}: run ${id}

Code \`${short(run.code_snapshot?.commit)}\`${run.code_snapshot?.patch ? ' + code.patch' : ''} · verdict \`${run.verdict}\` · baseline \`${baseline}\` · run ${index + 1} of ${status.loop.budget.iterations}

## Result

Only gating checks decide the verdict; a diagnostic result is shown for reference.

| Case | Check | Requirement | Role | Before | After | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
${compare.map((entry) => `| ${entry.case} | ${entry.check} | ${entry.intent} | ${entry.role ?? '—'} | ${entry.before ?? '—'} | ${entry.after} | ${entry.verdict}${entry.flaky ? ' (varied)' : ''} |`).join('\n')}

## Cause

<!-- For each check below, name the cause: requirement unclear, package or environment, code logic, or needs the user. Cite the log you read. -->
${open.length ? open.map((entry) => `- \`${entry.case}\` \`${entry.check}\` (${entry.verdict}):`).join('\n') : '- Every check holds.'}

## Changes

<!-- Say what each change does and why. -->
Files changed since ${from}:
${files.length ? files.map((item) => `- \`${item}\``).join('\n') : '- none'}

## Next

<!-- The next step: which layer to change, stop, or hand to the user. -->
${run.verdict === 'pass' ? `
## Review

<!-- Who reviewed the whole change in a fresh context, what they checked (special cases for eval inputs, changes beyond the Spec, side effects no check covers), what they found, and how each finding was handled. -->
` : ''}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { flag: 'wx' });
  return { file, created: true, next: 'Fill in every section except Result, then delete the template line.' };
}

// Records the user's acceptance of one passing run, and only of the code that ran.
export function acceptLoop(repo, name, options = {}) {
  if (!nonempty(options.by) || !nonempty(options.ref)) throw new Error('--by and --ref name who accepted and where they said so. Acceptance is the user\'s decision.');
  const status = loopStatus(repo, name);
  const runsDirectory = path.join(eddDirectory(repo, name), 'runs');
  const listed = status.runs.find((entry) => entry.run_id === options.run);
  const gaps = [];
  if (!listed) gaps.push(gap('run_unknown', 'loop-and-implement', `${options.run ?? 'No run'} is not a full run of this loop.`));
  const run = listed ? readJSON(path.join(runsDirectory, listed.run_id, 'run.json')) : null;
  if (run && (run.verdict !== 'pass' || run.execution_status !== 'completed')) gaps.push(gap('not_passing', 'loop-and-implement', `${run.run_id} has verdict ${run.verdict}; only a passing run can be accepted.`));
  if (['restart', 'repair_spec'].includes(status.next.action)) gaps.push(gap('spec_changed', status.next.route, status.next.message, status.next.owner ?? 'agent'));
  const now = codeSnapshot(repo).snapshot;
  if (run) {
    const missing = reportGaps(repo, name, run);
    if (missing.length) gaps.push(gap('report_incomplete', 'loop-and-implement', `The report for ${run.run_id} is incomplete: ${missing.join('; ')}.`));
    if (sameCode(now, run.code_snapshot, repo) !== true) {
      gaps.push(gap('code_changed', 'run-eval', `The code changed after ${run.run_id}. Run again and accept that run.`));
    }
  }
  const accepted = acceptedFile(repo, name);
  if (status.accepted) gaps.push(gap('already_accepted', 'loop-and-implement', `This loop was already accepted: run ${status.accepted.run_id}, in ${path.relative(repo, accepted)}.`));
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
  const compare = compareOf(runsDirectory, run);
  const record = {
    schema_version: '1.0', change: name, run_id: run.run_id, loop_started_at: status.loop.started_at,
    spec: run.spec_snapshot, baseline: run.baseline,
    baseline_unavailable_reason: run.baseline_unavailable_reason, commit: run.code_snapshot.commit,
    uncommitted_files: run.code_snapshot.changed_files ?? [], code_digest: run.code_snapshot.digest,
    ...(run.code_snapshot.digest_of ? { code_digest_of: run.code_snapshot.digest_of } : {}),
    checks: compare.map(({ case: id, check, intent, role, before, after, verdict }) => ({ case: id, check, intent, role, before, after, verdict })),
    changed_packages: status.changed_packages,
    accepted: { by: options.by.trim(), ref: options.ref.trim(), at: new Date().toISOString() },
    ...(earlier.length ? { earlier } : {}),
  };
  writeFileSync(accepted, `${JSON.stringify(record, null, 2)}\n`);
  // The code now is the accepted code; it is committed when the commit holds all of it.
  const committed = Array.isArray(now.changed_files) && !now.changed_files.length ? now.commit : null;
  return { file: accepted, accepted: record, ...(committed ? { commit: committed } : {}),
    next: committed ? `Acceptance is recorded. The accepted code is committed in ${short(committed)}. Offer to merge it or open a pull request; do neither without the user.`
      : 'Acceptance is recorded. Offer to commit the change, merge it or open a pull request; do none of them without the user.' };
}

export const hasLoop = (repo, name, spec) => readLoop(repo, name)?.spec === spec;
