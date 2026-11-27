import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ROOT, changeDirectory, digest, ignoredArtifacts, isLeftover, listFiles, localPath, readJSON, writeJSON } from './project.js';
import { frozenSpec } from './spec.js';

const HELPER = readFileSync(path.join(ROOT, 'skills/write-eval/assets/genesis.sh'), 'utf8');
const TEMPLATE_MARK = 'GENESIS_EDD_TEMPLATE';
const MODES = ['live', 'frozen', 'simulated'];
const RESULTS = ['pass', 'fail', 'unknown'];
// checks.json 1.1 binds each check to the THEN or AND line it verifies; 1.0
// is still read, under its own rules.
const VERSIONS = ['1.0', '1.1'];
// Who wrote a fixture: the package's author, a reviewer who wrote it from the
// scenario without reading the verifier, or the author doing that review alone.
const ORIGINS = ['author', 'review', 'self-review'];
// The origins of a counterexample: a fixture the author wrote does not count.
const REVIEWERS = ['review', 'self-review'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The form of a THEN or AND line that checks bind: every run of whitespace,
// full-width spaces and line breaks included, is one space, and the ends are
// trimmed. Otherwise the text must match character for character.
export const thenKey = (text) => text.replace(/\s+/g, ' ').trim();

// The packages that still use checks.json 1.0, from validateEval: ids in order.
export const legacyPackages = (evals) => (evals?.cases ?? []).filter((item) => item.schema_version === '1.0').map((item) => item.id);

// The THEN lines the user judges at acceptance, from validateEval.
export const manualLines = (evals) => (evals?.then_lines ?? []).filter((row) => row.status === 'manual');

// Eval packages and run records live beside the Map output, one folder per change.
export function eddDirectory(repo, name) {
  changeDirectory(repo, name);
  return localPath(repo, `.genesis/edd/${name}`);
}

// The project kit: what every package of this project shares. The adapter, shared
// environment files and shared verifier code live here once; a package keeps only
// what is particular to its scenario.
export const kitDirectory = (repo) => localPath(repo, '.genesis/edd/harness');

// Finder and Explorer metadata, swap files and backups never take part in a run.
const ownFiles = (directory) => listFiles(directory).filter((file) => !isLeftover(file));
// Files that take part in a run. Notes, Python caches and leftovers do not.
const executed = (directory, notes) => ownFiles(directory).filter((file) =>
  !file.split(path.sep).includes('__pycache__') && path.relative(directory, file) !== notes);
const lines = (directory, files, prefix = '') => files
  .map((file) => `${prefix}${path.relative(directory, file).split(path.sep).join('/')}\n${digest(readFileSync(file))}`);
const filled = (file) => existsSync(file) && !readFileSync(file, 'utf8').includes(TEMPLATE_MARK) && nonempty(readFileSync(file, 'utf8'));

// The adapter and the model harness.json names, each null when it names none
// or cannot be read.
function harnessSettings(directory) {
  let harness = null;
  try { harness = readJSON(path.join(directory, 'harness.json')); } catch { /* reported as missing */ }
  return { agent: nonempty(harness?.agent) ? harness.agent : null, model: nonempty(harness?.model) ? harness.model : null };
}

function readKit(repo) {
  const directory = kitDirectory(repo);
  const { agent, model } = harnessSettings(directory);
  const verifier = path.join(directory, 'verifier');
  return {
    directory, agent, model, notes: filled(path.join(directory, 'PROJECT.md')),
    lines: lines(directory, executed(directory, 'PROJECT.md'), 'kit/'),
    verifier: lines(verifier, ownFiles(verifier)),
    environment: listFiles(path.join(directory, 'environment')),
  };
}

// The evaluated agent and model the project kit names: { agent, model }, each
// null when harness.json names none or cannot be read. Read-only.
export const kitSettings = (repo) => harnessSettings(kitDirectory(repo));

// The digest of harness.json, as a run's eval_snapshot keeps it under kit, or
// null when there is none. Read-only.
export function harnessDigest(repo) {
  try { return digest(readFileSync(path.join(kitDirectory(repo), 'harness.json'))); } catch { return null; }
}

// Whether a package declares a live dependency, such as a model call: its
// results can differ from one attempt to the next, so it runs the number of
// attempts the user fixed before the baseline.
export const isLive = (dependencies) => Array.isArray(dependencies) && dependencies.some((entry) => entry?.mode === 'live');

const scenariosOf = (handoff) => handoff.requirements.flatMap((requirement) =>
  requirement.scenarios.map((scenario, index) => ({
    case: `${requirement.id.replace(/^REQ-/, '').toLowerCase()}-s${index + 1}`,
    requirement: requirement.id, requirement_name: requirement.name, ...scenario,
  })));
const scenarioKey = (scenario) => `${scenario?.requirement}\n${scenario?.name}`;
// A package is matched to its scenario by the requirement and name its
// checks.json gives.
const namesScenario = (checks) => record(checks?.scenario) && nonempty(checks.scenario.requirement) && nonempty(checks.scenario.name);

// Each scenario of the frozen Spec with the folders of the packages whose
// checks.json names it.
function packagesOf(root, handoff) {
  const scenarios = scenariosOf(handoff);
  const owners = new Map(scenarios.map((item) => [scenarioKey(item), []]));
  for (const item of readCases(root)) {
    if (namesScenario(item.checks)) owners.get(scenarioKey(item.checks.scenario))?.push(item.id);
  }
  return scenarios.map((item) => ({ ...item, packages: owners.get(scenarioKey(item)) }));
}

// Folders under evals/ whose tests/checks.json cannot be read or names no
// scenario. Which scenario such a folder was written for cannot be told: its
// place may now belong to a scenario inserted before that one. So `eval new`
// writes nothing while there is one.
export function unnamedPackages(repo, name) {
  return readCases(path.join(eddDirectory(repo, name), 'evals')).filter((item) => !namesScenario(item.checks)).map((item) => item.id);
}

// What is wrong with those folders, and how to repair them.
export function unnamedMessage(ids) {
  const one = ids.length === 1;
  return {
    problem: `${ids.join(', ')}: tests/checks.json cannot be read or names no scenario, so \`eval new\` cannot tell which scenario ${one ? 'this folder was' : 'these folders were'} written for, and a new package could duplicate ${one ? 'it' : 'one'}.`,
    repair: `Repair ${one ? 'its tests/checks.json, or delete the folder if it is not a package' : 'each tests/checks.json, or delete a folder that is not a package'}; \`eval validate\` reports ${one ? 'it' : 'them'} as case_invalid and says what is wrong.`,
  };
}

// The folder of a new package: the scenario's place in its requirement, or the
// next free number when another package already holds that name, such as after
// a scenario was inserted before it. Existing folders are never renamed.
function freeCase(root, id) {
  const [, stem, number] = id.match(/^(.*)-s(\d+)$/);
  let index = Number(number);
  while (existsSync(path.join(root, `${stem}-s${index}`))) index += 1;
  return `${stem}-s${index}`;
}

// The scenarios of the frozen Spec that no package names yet: what `eval new`
// writes once every folder under evals/ has a checks.json that names one.
export function unpackagedScenarios(repo, name, handoff) {
  return packagesOf(path.join(eddDirectory(repo, name), 'evals'), handoff).filter((item) => !item.packages.length)
    .map((item) => ({ requirement: item.requirement, name: item.name }));
}

// The current frozen Spec, or the gaps that keep later stages from using it.
export function requireSpec(repo, name, stage) {
  const { gaps, handoff } = frozenSpec(repo, name);
  if (gaps.length) {
    throw Object.assign(new Error(`${stage} needs the current exported Spec: ${gaps.map((gap) => gap.message).join('; ')}`), {
      code: 'SPEC_INPUT_BLOCKED', gaps,
      resume: { stage, change: name, command: ['workflow', 'check', stage, name, '--repo', repo] },
    });
  }
  return handoff;
}

const taskToml = (name, item) => `schema_version = "1.4"

[task]
name = "genesis-edd/${name}--${item.case}"
description = ${JSON.stringify(`${item.requirement} ${item.requirement_name}: ${item.name}`)}

[verifier]
timeout_sec = 600.0
environment_mode = "shared"

[agent]
timeout_sec = 600.0

[environment]
network_mode = "public"
build_timeout_sec = 600.0
`;

const instruction = (item) => `<!-- ${TEMPLATE_MARK}: replace this file with the exact input the evaluated agent receives.
Trigger this scenario; do not mention checks, expected results or scoring.

${[...item.given.map((line) => `GIVEN ${line}`), ...item.when.map((line) => `WHEN ${line}`)].join('\n')}
-->
`;

const taskNotes = (item) => `<!-- ${TEMPLATE_MARK}: replace the notes under each heading; keep the headings. -->
# ${item.case}: ${item.name}

## Trigger
How this package makes the scenario happen, and how the verifier knows it did.

## Environment
What is live, frozen or simulated here, and how that differs from production.

## Evidence
What each check reads. It is never the agent's own claim.

## Choices made here
Technical choices the Spec does not state, such as which failure is simulated.
A choice that changes what the business accepts belongs in the Spec instead.

## Not covered
`;

const projectNotes = `<!-- ${TEMPLATE_MARK}: notes for writing and running evals in this project. Keep what another
package can reuse. One package's exact input and expected results stay in that package. -->
# Eval notes for this project

## How the evaluated program is started

## External dependencies
For each one: live, frozen or simulated, and where its shared stand-in lives.

## Independent evidence
Which records prove an effect, and how a verifier reads them.

## Known traps
Shortcuts, leaks, and exit codes or errors that look like failures but are not.

## Open gaps
`;

const testScript = (checks) => `#!/bin/sh
# ${TEMPLATE_MARK}: replace the lines between the markers with checks that read
# independent evidence (final state, service records), never the agent's own claim.
. "$(dirname "$0")/genesis.sh"

# --- project checks ---
${checks.map((check) => `gate ${check.id} unknown "not implemented: ${check.expect.replace(/["\\$`]/g, '')}"`).join('\n')}
# --- end project checks ---

finish
`;

// One package per scenario of the frozen Spec. What an existing package owns is
// never rewritten: expectations change only through a new Spec export and a
// review. The shipped helper and the kit's shared verifier code are not the
// package's own, so every package is brought in line with them here.
export function newEval(repo, name) {
  const handoff = requireSpec(repo, name, 'write-eval');
  const root = path.join(eddDirectory(repo, name), 'evals');
  const unnamed = unnamedPackages(repo, name);
  if (unnamed.length) {
    const { problem, repair } = unnamedMessage(unnamed);
    throw new Error(`${problem} Nothing was written. ${repair} Then run \`eval new\` again.`);
  }
  const plan = packagesOf(root, handoff.handoff);
  const kit = kitDirectory(repo);
  mkdirSync(kit, { recursive: true });
  if (!existsSync(path.join(kit, 'PROJECT.md'))) writeFileSync(path.join(kit, 'PROJECT.md'), projectNotes);
  const created = [];
  const kept = [];
  for (const scenario of plan) {
    if (scenario.packages.length) { kept.push(...scenario.packages); continue; }
    const item = { ...scenario, case: freeCase(root, scenario.case) };
    const directory = path.join(root, item.case);
    // One check per THEN or AND line: then names the line, and expect starts
    // as its text until the author makes it concrete.
    const checks = item.then.map((line, index) => ({ id: `c${index + 1}`, intent: item.requirement, then: line, expect: line, role: 'gating' }));
    mkdirSync(path.join(directory, 'tests'), { recursive: true });
    writeFileSync(path.join(directory, 'task.toml'), taskToml(name, item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'instruction.md'), instruction(item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'Task.md'), taskNotes(item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'tests/genesis.sh'), HELPER, { flag: 'wx' });
    writeFileSync(path.join(directory, 'tests/test.sh'), testScript(checks), { flag: 'wx' });
    chmodSync(path.join(directory, 'tests/test.sh'), 0o755);
    writeJSON(path.join(directory, 'tests/checks.json'), {
      schema_version: '1.1', status: 'confirmed',
      spec_ref: { id: name, sha256: handoff.id },
      scenario: { requirement: item.requirement, name: item.name, manual: [] },
      dependencies: [],
      checks,
      fixtures: [],
    });
    created.push(item.case);
  }
  const shared = path.join(kit, 'verifier');
  const synced = [];
  for (const item of readCases(root)) {
    const tests = path.join(item.directory, 'tests');
    const target = path.join(tests, 'shared');
    const before = [existsSync(path.join(tests, 'genesis.sh')) ? readFileSync(path.join(tests, 'genesis.sh'), 'utf8') : '',
      ...lines(target, ownFiles(target))].join('\n');
    if (before === [HELPER, ...lines(shared, ownFiles(shared))].join('\n')) continue;
    mkdirSync(tests, { recursive: true });
    writeFileSync(path.join(tests, 'genesis.sh'), HELPER);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(shared)) cpSync(shared, target, { recursive: true });
    if (!created.includes(item.id)) synced.push(item.id);
  }
  const ignored = ignoredArtifacts(repo, name).warning;
  return {
    change: name, spec: handoff.id, directory: root, kit, created, kept, synced, warnings: ignored ? [ignored] : [],
    note: 'Each check names the THEN or AND line it verifies in then, and its expect starts as that line. Make expect concrete and keep then. A line no program can judge goes into scenario.manual with the reason. Build the project kit first, then each package; a package can run once `eval check` has proved its verifier.',
    next: { stage: 'write-eval', command: ['eval', 'validate', name, '--repo', repo] },
  };
}

function readCases(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
      const directory = path.join(root, entry.name);
      let checks = null;
      let unreadable;
      try { checks = readJSON(path.join(directory, 'tests/checks.json')); } catch (cause) { unreadable = cause.message; }
      return { id: entry.name, directory, checks, unreadable };
    });
}

// Content identity of a package: runs compare results only between equal
// packages. The kit is part of it, because a changed adapter or stand-in
// changes what a run measures. Task.md is prose and is left out.
const taskDigest = (directory, kit) => digest([...lines(directory, executed(directory, 'Task.md')), ...kit.lines].join('\n'));

// What a run executes of the evals: every file of each package and of the
// kit by its digest, and each package's task digest, which is the one
// validateEval reports. Task.md, PROJECT.md, Python caches and leftovers are
// left out, as they are from the task digest. Every package is listed, ready
// or not. Read-only, with no validation, so a run can take it at its start
// and again at its end.
export function evalSnapshot(repo, name) {
  const kit = readKit(repo);
  // Each line is a path, a newline and a digest; a path may hold a newline.
  const files = (entries, prefix = '') => Object.fromEntries(entries.map((entry) => {
    const at = entry.lastIndexOf('\n');
    return [entry.slice(prefix.length, at), entry.slice(at + 1)];
  }));
  const items = readCases(path.join(eddDirectory(repo, name), 'evals'));
  return {
    packages: Object.fromEntries(items.map((item) => [item.id, files(lines(item.directory, executed(item.directory, 'Task.md')))])),
    kit: files(kit.lines, 'kit/'),
    task_digest: Object.fromEntries(items.map((item) => [item.id, taskDigest(item.directory, kit)])),
  };
}

// The files that differ between two eval snapshots: { packages: { id: [file]
// or 'added' or 'removed' }, kit: [file] }, each list sorted.
export function evalFilesChanged(before, after) {
  const differ = (first = {}, second = {}) => [...new Set([...Object.keys(first), ...Object.keys(second)])]
    .filter((file) => first[file] !== second[file]).sort();
  const ids = [...new Set([...Object.keys(before?.packages ?? {}), ...Object.keys(after?.packages ?? {})])].sort();
  const packages = {};
  for (const id of ids) {
    const was = before?.packages?.[id];
    const now = after?.packages?.[id];
    const changed = !was ? 'added' : !now ? 'removed' : differ(was, now);
    if (typeof changed === 'string' || changed.length) packages[id] = changed;
  }
  return { packages, kit: differ(before?.kit, after?.kit) };
}

// The user's checks confirmation of a change, and the reviewer's answers it
// is recorded from. Both are committed beside the packages.
export const confirmationFile = (repo, name) => path.join(eddDirectory(repo, name), 'confirmed.json');
export const reviewFile = (repo, name) => path.join(eddDirectory(repo, name), 'review.json');

// The id of a confirmation entry: the digest of what it records, without its
// id and the entries before it. A hand edit makes the id no longer match.
export function confirmationId(entry) {
  const { id, earlier, ...content } = entry;
  return digest(JSON.stringify(content));
}

// Files named in a message: the first ten, then how many more.
const named = (files) => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));

// confirmed.json as it is: { file, record, entries, gap }. entries are the
// confirmations it holds, newest first, each without earlier. gap is
// confirmation_unreadable when the file is no JSON object, and
// confirmation_invalid when an entry's id no longer matches its content. No
// file gives no entries and no gap. Read-only.
export function readConfirmation(repo, name) {
  const file = confirmationFile(repo, name);
  const shown = `.genesis/edd/${name}/confirmed.json`;
  const none = { file, record: null, entries: [], gap: null };
  if (!existsSync(file)) return none;
  const unreadable = (why) => ({ ...none, gap: { code: 'confirmation_unreadable', kind: 'artifact', owner: 'agent', route: 'run-eval',
    message: `${shown} cannot be read (${why}). Restore it from Git; it holds the user's checks confirmation.` } });
  let stored;
  try { stored = readJSON(file); } catch (error) { return unreadable(error.message); }
  if (!record(stored)) return unreadable('it is not a JSON object');
  const { earlier, ...top } = stored;
  const entries = [top, ...[...(Array.isArray(earlier) ? earlier : [])].reverse()];
  const broken = entries.find((entry) => !record(entry) || entry.id !== confirmationId(entry));
  return { file, record: stored, entries,
    gap: broken === undefined ? null : { code: 'confirmation_invalid', kind: 'artifact', owner: 'agent', route: 'run-eval',
      message: `${shown} was edited by hand: the id of the entry of ${record(broken) ? broken.confirmed?.at ?? 'unknown date' : 'unknown date'} no longer matches its content. Restore it from Git, or record the confirmation again with \`eval confirm\`.` } };
}

// The newest confirmation of a Spec export, or null.
export const latestConfirmation = (entries, spec) => entries.find((entry) => entry?.spec?.sha256 === spec) ?? null;

// Whether the packages of a confirmation entry are those with the given task
// digests: the same ids, each with the same digest.
const samePackages = (packages, digests) => {
  const ids = Object.keys(packages ?? {});
  return ids.length === Object.keys(digests ?? {}).length && ids.every((id) => packages[id]?.task_digest === digests[id]);
};

// The newest confirmation of a Spec export whose packages are those with the
// given task digests, such as the ones a run ran, or null.
export const confirmationOf = (entries, spec, digests) => entries.find((entry) => entry?.spec?.sha256 === spec && samePackages(entry.packages, digests)) ?? null;

// The confirmation entry with this id, or null.
export const confirmationById = (entries, id) => (id ? entries.find((entry) => entry?.id === id) ?? null : null);

// How the packages as an eval snapshot has them differ from a confirmation:
// { matches, spec_differs, packages: [{ id, change: changed, added or removed,
// files }], kit: [files] }. matches is true when the confirmation is of this
// Spec export and every package is as it was confirmed.
export function confirmationMatch(entry, snapshot, spec) {
  const confirmed = { packages: Object.fromEntries(Object.entries(entry?.packages ?? {}).map(([id, item]) => [id, item?.files ?? {}])), kit: entry?.kit?.files ?? {} };
  const files = evalFilesChanged(confirmed, snapshot);
  const ids = [...new Set([...Object.keys(entry?.packages ?? {}), ...Object.keys(snapshot.task_digest)])].sort();
  const packages = ids.flatMap((id) => {
    const was = entry?.packages?.[id];
    const now = snapshot.task_digest[id];
    if (was && now !== undefined && was.task_digest === now) return [];
    const listed = files.packages[id];
    return [{ id, change: !was ? 'added' : now === undefined ? 'removed' : 'changed', files: Array.isArray(listed) ? listed : [] }];
  });
  const differs = entry?.spec?.sha256 !== spec;
  return { matches: !differs && !packages.length, spec_differs: differs, packages, kit: files.kit };
}

// The files a confirmationMatch names, for a message: <case>/<file>, a
// package added or removed since, and kit/<file>.
export const matchFiles = (match) => [...match.packages.flatMap((entry) => (entry.change === 'changed'
  ? entry.files.map((file) => `${entry.id}/${file}`) : [`${entry.id}/ (${entry.change})`])), ...match.kit.map((file) => `kit/${file}`)];

// Why a loop does not start on these checks: the gap checks_unconfirmed when
// no confirmation of this Spec export covers the packages as they are, or null.
export function unconfirmedGap(entries, spec, snapshot) {
  const gap = (message, cases) => ({ code: 'checks_unconfirmed', kind: 'business', owner: 'user', route: 'run-eval', message, ...(cases ? { cases } : {}) });
  const latest = latestConfirmation(entries, spec);
  if (!latest) {
    return entries.length
      ? gap(`The latest checks confirmation is for another Spec export (${String(entries[0]?.spec?.sha256 ?? '').slice(7, 19)}). Confirm the checks of this export: \`eval review\`, the reviewer's answers in review.json, then \`eval confirm\` with the user's words.`)
      : gap('The user has not confirmed the checks of this Spec export. Run `eval review`, have a reviewer answer it in review.json, show the user the review and the run plan, and record their confirmation with `eval confirm` before `loop start`.');
  }
  const match = confirmationMatch(latest, snapshot, spec);
  if (match.matches) return null;
  const ids = match.packages.map((entry) => entry.id);
  return gap(`${ids.join(', ')} changed since the user confirmed the checks (${named(matchFiles(match))}). A loop compares with the checks the user confirmed. Run \`eval review\`: the reviewer checks the diff and says whether it loosens a THEN line; then show the user and record \`eval confirm --reason\`.`, ids);
}

// The checks confirmation of a Spec export as it stands now: what
// readConfirmation gives, with latest (the newest confirmation of this export,
// or null), match (confirmationMatch of it), current (latest when it covers
// the packages as they are) and unconfirmed (unconfirmedGap). An unreadable
// or invalid file gives no confirmation at all. Read-only.
export function checksConfirmation(repo, name, spec, snapshot = evalSnapshot(repo, name)) {
  const read = readConfirmation(repo, name);
  const latest = read.gap ? null : latestConfirmation(read.entries, spec);
  const match = latest ? confirmationMatch(latest, snapshot, spec) : null;
  return { ...read, snapshot, latest, match, current: match?.matches ? latest : null, unconfirmed: read.gap ? null : unconfirmedGap(read.entries, spec, snapshot) };
}

// The last fixture check of a package, when it still describes the package as it is.
function checkRecord(directory, id, current) {
  let last;
  try { last = readJSON(path.join(path.dirname(path.dirname(directory)), 'checks', id, 'check.json')); } catch { return 'never run'; }
  if (last.task_digest !== current) return 'the package or the kit changed since the last run';
  return last.passed === true ? null : `the last run failed: ${(last.fixtures ?? []).filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`;
}

// Whether a path is the folder or inside it.
const within = (folder, file) => {
  const relative = path.relative(folder, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// The build contexts of the services in a Compose file, resolved as Compose
// resolves them during a trial: merge keys (`<<: *fragment`), the variables
// Genesis sets, and relative paths from the file's folder, which is the
// project directory Harbor passes. A context that cannot be resolved here,
// such as a URL or another variable, is left out. Compose's own tags, such as
// !reset, are not YAML's, so the parser's warnings about them are not shown.
function buildContexts(file, text, repo, kit) {
  if (!/\.ya?ml$/.test(file)) return [];
  let services;
  try { services = parse(text, { merge: true, logLevel: 'error' })?.services; } catch { return []; }
  if (!record(services)) return [];
  return Object.values(services).flatMap((service) => {
    const build = record(service) ? service.build : undefined;
    const context = typeof build === 'string' ? build : record(build) ? (build.context ?? '.') : null;
    if (typeof context !== 'string') return [];
    const value = context.replace(/\$\{(GENESIS_EDD_REPO|GENESIS_EDD_HARNESS)(?:[:?-][^}]*)?\}|\$(GENESIS_EDD_REPO|GENESIS_EDD_HARNESS)\b/g,
      (match, braced, bare) => ((braced ?? bare) === 'GENESIS_EDD_REPO' ? repo : kit));
    if (value.includes('$') || /^[a-z][a-z0-9+.-]*:\/\/|^git@/i.test(value)) return [];
    return [path.resolve(path.dirname(file), value)];
  });
}

// A leading keyword of the Spec's Markdown left in a then; it names which.
const KEYWORD = /^\s*(?:-\s*)?(?:\*\*)?(THEN|AND|GIVEN|WHEN)(?:\*\*)?(?![A-Za-z0-9_])/i;
// A list of lines for a message.
const quoted = (texts) => texts.map((text) => `"${text}"`).join(', ');

function validateCase(repo, item, handoff, name, dockerignore, kit, fail, warn) {
  const { directory, checks } = item;
  const has = (relative) => existsSync(path.join(directory, relative));
  const read = (relative) => (has(relative) ? readFileSync(path.join(directory, relative), 'utf8') : '');
  const steps = has('steps') ? readdirSync(path.join(directory, 'steps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  // lines holds one row per THEN or AND line of the scenario, for validateEval;
  // it is not part of the summary eval validate returns.
  const summary = { id: item.id, path: path.relative(path.dirname(path.dirname(directory)), directory), schema_version: null, status: null, scenario: null,
    integration: null, checks: 0, gating: 0, manual: 0, steps, live: false, task_digest: taskDigest(directory, kit), lines: [] };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) fail('Case folder must be lowercase kebab-case.');
  if (!record(checks)) { fail(`tests/checks.json is missing or not a JSON object${item.unreadable ? `: ${item.unreadable}` : '.'}`); return summary; }
  if (!VERSIONS.includes(checks.schema_version)) fail('schema_version must be "1.0" or "1.1".');
  summary.schema_version = checks.schema_version ?? null;
  // A 1.0 package is read under the rules it was written for.
  const current = checks.schema_version === '1.1';
  const list = (value) => (Array.isArray(value) ? value : []);
  if (checks.schema_version === '1.0' && (list(checks.checks).some((check) => record(check) && check.then !== undefined)
    || (record(checks.scenario) && checks.scenario.manual !== undefined)
    || list(checks.fixtures).some((fixture) => record(fixture) && (fixture.origin !== undefined || fixture.note !== undefined)))) {
    fail('then, scenario.manual and fixtures[].origin and note belong to checks.json 1.1. Set schema_version to "1.1", or remove them.');
  }
  if (!['draft', 'confirmed'].includes(checks.status)) fail('status must be draft or confirmed.');
  summary.status = checks.status ?? null;
  if (!record(checks.spec_ref) || checks.spec_ref.id !== name || !nonempty(checks.spec_ref.sha256)) {
    fail(`spec_ref needs id "${name}" and the sha256 of the exported Spec handoff.`);
  }
  const requirements = new Map(handoff.requirements.map((requirement) => [requirement.id, requirement]));
  const scenario = checks.scenario;
  const target = record(scenario) ? requirements.get(scenario.requirement)?.scenarios.find((entry) => entry.name === scenario.name) : undefined;
  if (!target) {
    fail('scenario must name a requirement and one of its scenarios in the exported Spec.');
  } else summary.scenario = { requirement: scenario.requirement, name: scenario.name };
  // The scenario's THEN and AND lines by their key, each with its first text:
  // a line written twice in the Spec is one line.
  const lineTexts = new Map();
  for (const text of target?.then ?? []) if (!lineTexts.has(thenKey(text))) lineTexts.set(thenKey(text), text);
  const setup = new Set([...(target?.given ?? []), ...(target?.when ?? [])].map(thenKey));
  if (current && target && !lineTexts.size) {
    fail(`Scenario "${target.name}" has no THEN line, so there is nothing to check. Add its outcome in the Spec with agent-spec, then export again.`);
  }
  // The key of the line a then names, or null when it names none.
  const bind = (label, value) => {
    if (Array.isArray(value)) {
      fail(`${label}: then is one line, not a list. A check verifies exactly one THEN or AND line: split it into one check per line, or, when the lines can only fail together, merge them into one line in the Spec with agent-spec.`);
      return null;
    }
    if (!nonempty(value)) { fail(`${label}: then must be one THEN or AND line of the scenario.`); return null; }
    if (!target) return null;
    const key = thenKey(value);
    if (lineTexts.has(key)) return key;
    const bare = thenKey(value.replace(KEYWORD, ''));
    // The keyword hint names only the keywords a THEN or AND line carries.
    const word = value.match(KEYWORD)?.[1].toUpperCase();
    const hint = (word === 'THEN' || word === 'AND') && lineTexts.has(bare) ? ' Leave out the THEN or AND keyword.'
      : setup.has(key) || setup.has(bare) ? ' That is a GIVEN or WHEN line, which sets the scenario up; a check verifies a THEN or AND line.' : '';
    fail(`${label}: then "${value}" is not a THEN or AND line of scenario "${target.name}".${hint} Copy one of its lines exactly: ${quoted([...lineTexts.values()])}.`);
    return null;
  };
  // The lines the user judges, each with its reason.
  const manual = new Map();
  if (current && scenario?.manual !== undefined) {
    if (!Array.isArray(scenario.manual)) fail('scenario.manual must be a list of {then, reason}; use [] when a gating check verifies every line.');
    for (const [index, entry] of list(scenario.manual).entries()) {
      const label = `scenario.manual entry ${index + 1}`;
      if (!record(entry)) { fail(`${label} needs then, the line, and reason, why no program can judge it.`); continue; }
      if (!nonempty(entry.reason)) fail(`${label} needs reason: why no program can judge the line.`);
      const key = bind(label, entry.then);
      if (key === null) continue;
      if (manual.has(key)) fail(`${label}: "${lineTexts.get(key)}" is in scenario.manual more than once. List each line once.`);
      else manual.set(key, nonempty(entry.reason) ? entry.reason.trim() : null);
    }
  }
  // The checks that verify each line, and the diagnostic ones that cite it.
  const bound = new Map();
  const cited = new Map();
  const add = (map, key, entry) => map.set(key, [...(map.get(key) ?? []), entry]);
  if (checks.integration !== undefined) fail('Remove integration from checks.json: whether a package can run is worked out from its files and its last `eval check`.');
  if (!Array.isArray(checks.dependencies) || checks.dependencies.some((entry) => !record(entry) || !nonempty(entry.name) || !MODES.includes(entry.mode))) {
    fail(`dependencies must list each external dependency with name and mode (${MODES.join(', ')}); use [] when there is none.`);
  }
  // Not part of the task digest: it is read from checks.json, which is.
  summary.live = isLive(checks.dependencies);
  const ids = new Set();
  // A 1.1 package whose every line the user judges has no check.
  if (current ? !Array.isArray(checks.checks) : !Array.isArray(checks.checks) || !checks.checks.length) {
    fail(current ? 'checks must be a list.' : 'checks must be a non-empty list.');
  }
  for (const check of Array.isArray(checks.checks) ? checks.checks : []) {
    const label = `check ${record(check) && nonempty(check.id) ? check.id : '?'}`;
    if (!record(check) || !/^[A-Za-z0-9_-]+$/.test(check.id ?? '') || !nonempty(check.expect) || !['gating', 'diagnostic'].includes(check.role)) {
      fail(`${label} needs id, expect and role (gating or diagnostic).`);
      continue;
    }
    if (ids.has(check.id)) fail(`Duplicate check id: ${check.id}`);
    ids.add(check.id);
    if (current && check.role === 'gating') {
      // A gating check verifies one line of its own scenario.
      if (summary.scenario && check.intent !== summary.scenario.requirement) {
        fail(`${label} is gating, so its intent must be ${summary.scenario.requirement}, the requirement of its scenario; it cites ${check.intent ?? 'no requirement'}. A check of another requirement can only be diagnostic.`);
      } else if (!summary.scenario && !requirements.has(check.intent)) {
        fail(`${label} cites ${check.intent ?? 'no requirement'}, which is not in the exported Spec. Every check needs a source.`);
      }
      if (check.then === undefined) fail(`${label} is gating, so it needs then: the THEN or AND line of its scenario it verifies.`);
      else {
        const key = bind(label, check.then);
        if (key !== null) add(bound, key, { check: check.id, expect: check.expect });
      }
    } else {
      if (!requirements.has(check.intent)) fail(`${label} cites ${check.intent ?? 'no requirement'}, which is not in the exported Spec. Every check needs a source.`);
      // A diagnostic check may cite a line, but it covers none.
      if (current && check.then !== undefined) {
        const key = bind(label, check.then);
        if (key !== null) add(cited, key, { check: check.id, expect: check.expect });
      }
      if (!current && check.role === 'gating' && summary.scenario && requirements.has(check.intent) && check.intent !== summary.scenario.requirement) {
        warn(`${item.id}: gating check ${check.id} cites ${check.intent}, not ${summary.scenario.requirement}, the requirement of its scenario. checks.json 1.1 refuses that: a gating check verifies a line of its own scenario.`);
      }
    }
    if (steps.length ? !steps.includes(check.at) : check.at !== undefined) {
      fail(steps.length ? `${label} needs at: one of ${steps.join(', ')}.` : `${label} has at, but the package has no steps/ folder.`);
    }
    summary.checks += 1;
    if (check.role === 'gating') summary.gating += 1;
  }
  for (const [key, entries] of bound) {
    if (manual.has(key)) {
      fail(`"${lineTexts.get(key)}" is in scenario.manual and verified by gating check ${entries.map((entry) => entry.check).join(', ')}. A line is judged by a check or by the user, not both: keep one.`);
    }
  }
  summary.manual = manual.size;
  const keyed = [...lineTexts].map(([key, text]) => {
    const status = !current ? 'unbound' : bound.has(key) ? 'gating' : manual.has(key) ? 'manual' : 'uncovered';
    return [key, { then: text, status, gating: bound.get(key) ?? [], diagnostic: cited.get(key) ?? [],
      ...(status === 'manual' && manual.get(key) ? { reason: manual.get(key) } : {}) }];
  });
  summary.lines = keyed.map(([, row]) => row);
  const allManual = lineTexts.size > 0 && [...lineTexts.keys()].every((key) => manual.has(key));
  if (!summary.gating && !(current && allManual)) {
    fail(current ? 'At least one gating check is required, unless scenario.manual lists every THEN and AND line of the scenario.' : 'At least one gating check is required.');
  }
  // A fixture replaces the agent with a script, so the real verifier can be
  // shown to tell a right result, a wrong one and missing evidence apart.
  const produced = new Map([...ids].map((id) => [id, new Set()]));
  const names = new Set();
  // The fixtures a reviewer wrote, as candidates for counterexamples.
  const reviewed = [];
  if (!Array.isArray(checks.fixtures)) fail('fixtures must be a list; use [] until the verifier is written.');
  for (const fixture of Array.isArray(checks.fixtures) ? checks.fixtures : []) {
    const label = `fixture ${record(fixture) && nonempty(fixture.name) ? fixture.name : '?'}`;
    if (!record(fixture) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.name ?? '') || !record(fixture.expect) || !Object.keys(fixture.expect).length
      || Object.entries(fixture.expect).some(([id, result]) => !ids.has(id) || !RESULTS.includes(result))) {
      fail(`${label} needs a kebab-case name and expect: a result (${RESULTS.join(', ')}) for declared check ids.`);
      continue;
    }
    // What a fixture says of itself is checked by value only.
    if (current && fixture.origin !== undefined && !ORIGINS.includes(fixture.origin)) fail(`${label}: origin must be author, review or self-review.`);
    if (current && fixture.note !== undefined && !nonempty(fixture.note)) {
      fail(`${label}: note must be a sentence saying, in the words of the business, what result the script leaves.`);
    }
    if (names.has(fixture.name)) fail(`Duplicate fixture name: ${fixture.name}`);
    names.add(fixture.name);
    if (!has(`tests/fixtures/${fixture.name}.sh`)) fail(`${label} has no script at tests/fixtures/${fixture.name}.sh.`);
    for (const [id, result] of Object.entries(fixture.expect)) produced.get(id).add(result);
    if (current && REVIEWERS.includes(fixture.origin)) reviewed.push(fixture);
  }
  // A counterexample of a line is a reviewer's fixture that fails only that
  // line: every gating check bound to it fails, and every other gating check
  // of the package passes or cannot tell. It names every gating check, so it
  // says what it expects of each.
  const gatingIds = (Array.isArray(checks.checks) ? checks.checks : []).filter((check) => record(check) && check.role === 'gating' && ids.has(check.id))
    .map((check) => check.id);
  for (const [key, row] of keyed) {
    const own = new Set((bound.get(key) ?? []).map((entry) => entry.check));
    row.counterexamples = row.status !== 'gating' ? [] : reviewed
      .filter((fixture) => gatingIds.every((id) => (own.has(id) ? fixture.expect[id] === 'fail' : ['pass', 'unknown'].includes(fixture.expect[id]))))
      .map((fixture) => ({ fixture: fixture.name, origin: fixture.origin }));
  }
  if (!has('task.toml')) fail('task.toml is missing.');
  if (read('tests/genesis.sh') !== HELPER || lines(path.join(directory, 'tests/shared'), ownFiles(path.join(directory, 'tests/shared'))).join('\n') !== kit.verifier.join('\n')) {
    fail('tests/genesis.sh or tests/shared/ differs from the shipped helper and the kit\'s verifier/ folder. Run `eval new` to bring them in line; edit shared verifier code in the kit.');
  }
  // The package's environment files and the kit's, which a package builds with.
  const environment = [...listFiles(path.join(directory, 'environment')), ...kit.environment];
  for (const file of environment) {
    const label = within(kit.directory, file) ? path.relative(repo, file) : path.relative(directory, file);
    const text = /\.(?:ya?ml)$|Dockerfile/.test(file) ? readFileSync(file, 'utf8') : '';
    if (/checks\.json|(?:^|[\s"'/])(?:\.\.\/)+(?:tests|solution)\b/m.test(text)) {
      fail(`${label} reaches tests/ or solution/. Expected results and the reference path must stay out of the agent's image.`);
    }
    const contexts = buildContexts(file, text, repo, kit.directory);
    // A build from the application root would otherwise copy every package's expected results.
    if ((text.includes('GENESIS_EDD_REPO') || contexts.includes(repo)) && !/^\/?\.genesis\/?\s*$/m.test(dockerignore)) {
      fail(`${label} builds from the application root. Add .genesis to the project's .dockerignore so expected results stay out of the image.`);
    }
    // Any other folder that holds the package, such as .genesis/ or a folder
    // above the project, has no .dockerignore that keeps its tests/ out.
    for (const context of new Set(contexts.filter((entry) => entry !== repo && within(entry, directory)))) {
      fail(`${label} builds from ${path.relative(repo, context)}, which holds this package's tests/. Build from \${GENESIS_EDD_REPO} with .genesis in .dockerignore, or from the kit, so expected results stay out of the image.`);
    }
  }
  // Whether the package can run is worked out here, never declared by its author.
  const missing = [];
  const detail = [];
  const lack = (what, why) => { missing.push(what); detail.push(`${what}: ${why}`); };
  const written = (file) => filled(path.join(directory, file));
  const inputs = steps.length ? steps.map((step) => `steps/${step}/instruction.md`) : ['instruction.md'];
  if (!inputs.every(written)) lack('instruction', 'write the exact input the evaluated agent receives');
  if (!has('environment/Dockerfile') && !has('environment/docker-compose.yaml')) lack('environment', 'add a Dockerfile or docker-compose.yaml');
  const scripts = steps.length && steps.every((step) => has(`steps/${step}/tests/test.sh`))
    ? steps.map((step) => `steps/${step}/tests/test.sh`) : ['tests/test.sh'];
  if (!scripts.every(written)) lack('verifier', 'replace the template checks in test.sh with real ones');
  if (!written('Task.md')) lack('design', 'fill in Task.md');
  if (!kit.agent || !kit.notes) lack('kit', `${kit.agent ? '' : 'name the adapter in harness.json; '}${kit.notes ? '' : 'fill in PROJECT.md'}`.replace(/; $/, ''));
  // Fixtures cannot prove a verifier step by step yet, and a run does not read
  // each check after its own step, so a multi-step package never runs.
  if (steps.length) lack('steps', 'multi-step packages are not supported yet: `eval check` cannot prove their verifier step by step, so every run skips this package and a full run of this change cannot pass');
  const uncovered = [...produced].filter(([id]) => (Array.isArray(checks.checks) ? checks.checks : []).some((check) => check?.id === id && check.role === 'gating'))
    .flatMap(([id, results]) => RESULTS.filter((result) => !results.has(result)).map((result) => `${id} ${result}`));
  if (uncovered.length) lack('fixtures', `no fixture expects ${uncovered.join(', ')}`);
  // Every line a program checks needs a counterexample from a reviewer, which
  // eval check then proves the verifier rejects.
  const unreviewed = summary.lines.filter((row) => row.status === 'gating' && !row.counterexamples.length);
  if (unreviewed.length) missing.push('review');
  for (const row of unreviewed) {
    detail.push(`review: no reviewer counterexample fails only "${row.then}": a reviewer writes a fixture with origin review that fails this line's gating checks and no other`);
  }
  if (!missing.length) {
    const stale = checkRecord(directory, item.id, summary.task_digest);
    if (stale) lack('check', `run \`eval check\` (${stale})`);
  }
  summary.integration = { state: missing.length ? 'awaiting_integration' : 'ready', missing, detail };
  return summary;
}

// Read-only. Structure and sources are checked here; whether an expectation is
// faithful to the Spec and whether a verifier is sound stay with the author.
export function validateEval(repo, name) {
  const root = path.join(eddDirectory(repo, name), 'evals');
  const { gaps: specGaps, handoff, moved_evidence: moved } = frozenSpec(repo, name);
  const gaps = [...specGaps];
  const warnings = moved?.length
    ? [`impact.md evidence no longer matches the code: ${moved.join(' ')} The exported Spec keeps it as it was.`] : [];
  const ignored = ignoredArtifacts(repo, name).warning;
  if (ignored) warnings.push(ignored);
  // One row per THEN or AND line of each package's scenario.
  const thenLines = [];
  const report = (cases = [], coverage = null) => {
    const structural = gaps.filter((gap) => gap.kind !== 'business' && gap.code !== 'integration_pending');
    const runnable = cases.filter((item) => item.integration?.state === 'ready' && item.status === 'confirmed' && !item.errors.length);
    return {
      change: name, valid: structural.length === 0,
      business_ready: gaps.every((gap) => gap.code === 'integration_pending'),
      ready_for_run: structural.length === 0 && runnable.length > 0 && gaps.every((gap) => gap.code === 'integration_pending'),
      spec: handoff ? handoff.id : null,
      map: handoff?.handoff.context.map.status === 'available' ? handoff.handoff.context.map : null,
      cases, coverage, then_lines: thenLines, gaps, warnings,
    };
  };
  if (!handoff) return report();
  const scenarios = scenariosOf(handoff.handoff);
  const items = readCases(root);
  if (!items.length) {
    gaps.push({ code: 'cases_missing', kind: 'artifact', owner: 'agent', route: 'write-eval',
      message: 'No eval packages yet. Create one per scenario of the exported Spec.' });
    return report();
  }
  const kit = readKit(repo);
  const ignoreFile = localPath(repo, '.dockerignore');
  const dockerignore = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
  const cases = [];
  const gated = new Set();
  // Requirements whose 1.1 packages leave every line to the user.
  const judged = new Set();
  const seen = new Set();
  const legacy = [];
  for (const item of items) {
    const errors = [];
    const summary = validateCase(path.resolve(repo), item, handoff.handoff, name, dockerignore, kit, (message) => errors.push(message),
      (message) => warnings.push(message));
    const { lines: rows, ...shown } = summary;
    cases.push({ ...shown, errors });
    for (const message of errors) {
      gaps.push({ code: 'case_invalid', kind: 'technical', owner: 'agent', route: 'write-eval', case: item.id, message: `${item.id}: ${message}` });
    }
    if (!record(item.checks)) continue;
    if (item.checks.spec_ref?.sha256 && item.checks.spec_ref.sha256 !== handoff.id) {
      gaps.push({ code: 'case_stale', kind: 'technical', owner: 'agent', route: 'write-eval', case: item.id,
        message: `${item.id} was written for another Spec export. Review it against the current requirements, then update spec_ref; do not carry old expectations over silently. Check that each then and scenario.manual entry still names a line of the current scenario.` });
      continue;
    }
    if (summary.scenario) {
      const { requirement, name: scenario } = summary.scenario;
      for (const row of rows) {
        thenLines.push({ case: item.id, requirement, scenario, ...row });
        if (row.status !== 'uncovered') continue;
        gaps.push({ code: 'then_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', case: item.id, requirement_id: requirement, scenario, then: row.then,
          message: `${item.id}: no gating check verifies "${row.then}" of scenario "${scenario}". Add a gating check with this line as its then. If no program can judge the line, such as tone or the quality of an answer, list it in scenario.manual with the reason. A diagnostic check does not cover a line.` });
      }
      if (summary.schema_version === '1.1' && rows.length && rows.every((row) => row.status === 'manual')) judged.add(requirement);
    }
    if (summary.schema_version === '1.0') legacy.push(item.id);
    if (summary.scenario) seen.add(`${summary.scenario.requirement}\n${summary.scenario.name}`);
    for (const check of Array.isArray(item.checks.checks) ? item.checks.checks : []) if (check?.role === 'gating') gated.add(check.intent);
    if (item.checks.status === 'draft') {
      gaps.push({ code: 'case_draft', kind: 'business', owner: 'user', route: 'agent-spec', case: item.id,
        message: `${item.id} holds an expectation the Spec does not state. Settle it in the Spec, export again, then confirm the package.` });
    }
    if (summary.integration?.state === 'awaiting_integration') {
      gaps.push({ code: 'integration_pending', kind: 'artifact', owner: 'agent', route: 'write-eval', case: item.id,
        missing: summary.integration.missing, message: `${item.id} is not runnable yet. ${summary.integration.detail.join('; ')}.` });
    }
    // Connecting it is no way out: say so wherever the packages are checked.
    if (summary.integration?.missing.includes('steps')) {
      warnings.push(`${item.id} is a multi-step package, which this release cannot run, so a full run of this change cannot pass. Tell the user before a loop starts.`);
    }
  }
  if (legacy.length) {
    const one = legacy.length === 1;
    warnings.push(`${legacy.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0: ${one ? 'its' : 'their'} checks do not name the THEN lines they verify, so whether every line is checked is not known, and ${one ? 'it has' : 'they have'} no reviewer counterexamples; \`eval confirm\` needs 1.1. This is a warning until the next \`loop start\`, which refuses 1.0 packages. Upgrade ${one ? 'it' : 'them'} to 1.1 before recording the baseline; task-package.md says how. The upgrade changes ${one ? 'the package' : 'each package'}, so a baseline recorded before it compares nothing with ${one ? 'it' : 'them'}.`);
  }
  const manual = thenLines.filter((row) => row.status === 'manual');
  if (manual.length) {
    const one = manual.length === 1;
    warnings.push(`The user judges ${one ? 'this THEN line' : 'these THEN lines'} at acceptance, since no check verifies ${one ? 'it' : 'them'}: ${manual.map((row) => `"${row.then}" in ${row.case} (${row.reason})`).join('; ')}. Tell the user before the baseline. A line a program can judge needs a gating check instead.`);
  }
  // Checks bind the text, so a line written twice in a scenario is one line.
  for (const item of scenarios) {
    const counts = new Map();
    for (const text of item.then) counts.set(thenKey(text), [...(counts.get(thenKey(text)) ?? []), text]);
    for (const [, texts] of counts) {
      if (texts.length > 1) warnings.push(`Scenario "${item.name}" of ${item.requirement} lists "${texts[0]}" more than once. Checks bind the text, so the copies count as one line. Ask for them to be merged in the Spec with agent-spec.`);
    }
  }
  if (!gated.size && judged.size) {
    warnings.push('No package of this change has a gating check: the user judges every THEN line. A run passes only on gating checks, so no run of this change can pass, and `loop start` refuses it (gating_missing). Tell the user.');
  }
  const uncovered = scenarios.filter((item) => !seen.has(`${item.requirement}\n${item.name}`));
  for (const item of uncovered) {
    gaps.push({ code: 'scenario_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: item.requirement,
      message: `No package for scenario "${item.name}" of ${item.requirement}.` });
  }
  // A requirement whose 1.1 packages leave every line to the user needs no gating check.
  const ungated = handoff.handoff.requirements.filter((requirement) => !gated.has(requirement.id) && !judged.has(requirement.id)).map((requirement) => requirement.id);
  for (const id of ungated) {
    gaps.push({ code: 'requirement_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: id,
      message: `${id} has no gating check. Every accepted requirement needs one before the change can pass.` });
  }
  const count = (status) => thenLines.filter((row) => row.status === status).length;
  return report(cases, { scenarios: scenarios.length, covered: scenarios.length - uncovered.length, requirements_without_gating_check: ungated,
    lines: { total: thenLines.length, gating: count('gating'), manual: count('manual'), uncovered: count('uncovered'), unbound: count('unbound') } });
}
