import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ROOT, changeDirectory, digest, ignoredArtifacts, isLeftover, listFiles, localPath, readJSON, writeJSON } from './project.js';
import { frozenSpec } from './spec.js';

const HELPER = readFileSync(path.join(ROOT, 'skills/write-eval/assets/genesis.sh'), 'utf8');
const TEMPLATE_MARK = 'GENESIS_EDD_TEMPLATE';
const MODES = ['live', 'frozen', 'simulated'];
const RESULTS = ['pass', 'fail', 'unknown'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

function readKit(repo) {
  const directory = kitDirectory(repo);
  let agent = null;
  try { agent = readJSON(path.join(directory, 'harness.json')).agent; } catch { /* reported as missing */ }
  const verifier = path.join(directory, 'verifier');
  return {
    directory, agent: nonempty(agent) ? agent : null, notes: filled(path.join(directory, 'PROJECT.md')),
    lines: lines(directory, executed(directory, 'PROJECT.md'), 'kit/'),
    verifier: lines(verifier, ownFiles(verifier)),
    environment: listFiles(path.join(directory, 'environment')),
  };
}

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
function requireSpec(repo, name, stage) {
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
    const checks = item.then.map((expect, index) => ({ id: `c${index + 1}`, intent: item.requirement, expect, role: 'gating' }));
    mkdirSync(path.join(directory, 'tests'), { recursive: true });
    writeFileSync(path.join(directory, 'task.toml'), taskToml(name, item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'instruction.md'), instruction(item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'Task.md'), taskNotes(item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'tests/genesis.sh'), HELPER, { flag: 'wx' });
    writeFileSync(path.join(directory, 'tests/test.sh'), testScript(checks), { flag: 'wx' });
    chmodSync(path.join(directory, 'tests/test.sh'), 0o755);
    writeJSON(path.join(directory, 'tests/checks.json'), {
      schema_version: '1.0', status: 'confirmed',
      spec_ref: { id: name, sha256: handoff.id },
      scenario: { requirement: item.requirement, name: item.name },
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
    note: 'Expected results are copied from the accepted THEN lines. Build the project kit first, then each package; a package can run once `eval check` has proved its verifier.',
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

function validateCase(repo, item, handoff, name, dockerignore, kit, fail) {
  const { directory, checks } = item;
  const has = (relative) => existsSync(path.join(directory, relative));
  const read = (relative) => (has(relative) ? readFileSync(path.join(directory, relative), 'utf8') : '');
  const steps = has('steps') ? readdirSync(path.join(directory, 'steps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const summary = { id: item.id, path: path.relative(path.dirname(path.dirname(directory)), directory), status: null, scenario: null,
    integration: null, checks: 0, gating: 0, steps, task_digest: taskDigest(directory, kit) };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) fail('Case folder must be lowercase kebab-case.');
  if (!record(checks)) { fail(`tests/checks.json is missing or not a JSON object${item.unreadable ? `: ${item.unreadable}` : '.'}`); return summary; }
  if (checks.schema_version !== '1.0') fail('schema_version must be "1.0".');
  if (!['draft', 'confirmed'].includes(checks.status)) fail('status must be draft or confirmed.');
  summary.status = checks.status ?? null;
  if (!record(checks.spec_ref) || checks.spec_ref.id !== name || !nonempty(checks.spec_ref.sha256)) {
    fail(`spec_ref needs id "${name}" and the sha256 of the exported Spec handoff.`);
  }
  const requirements = new Map(handoff.requirements.map((requirement) => [requirement.id, requirement]));
  const scenario = checks.scenario;
  if (!record(scenario) || !requirements.get(scenario.requirement)?.scenarios.some((entry) => entry.name === scenario.name)) {
    fail('scenario must name a requirement and one of its scenarios in the exported Spec.');
  } else summary.scenario = { requirement: scenario.requirement, name: scenario.name };
  if (checks.integration !== undefined) fail('Remove integration from checks.json: whether a package can run is worked out from its files and its last `eval check`.');
  if (!Array.isArray(checks.dependencies) || checks.dependencies.some((entry) => !record(entry) || !nonempty(entry.name) || !MODES.includes(entry.mode))) {
    fail(`dependencies must list each external dependency with name and mode (${MODES.join(', ')}); use [] when there is none.`);
  }
  const ids = new Set();
  if (!Array.isArray(checks.checks) || !checks.checks.length) fail('checks must be a non-empty list.');
  for (const check of Array.isArray(checks.checks) ? checks.checks : []) {
    const label = `check ${record(check) && nonempty(check.id) ? check.id : '?'}`;
    if (!record(check) || !/^[A-Za-z0-9_-]+$/.test(check.id ?? '') || !nonempty(check.expect) || !['gating', 'diagnostic'].includes(check.role)) {
      fail(`${label} needs id, expect and role (gating or diagnostic).`);
      continue;
    }
    if (ids.has(check.id)) fail(`Duplicate check id: ${check.id}`);
    ids.add(check.id);
    if (!requirements.has(check.intent)) fail(`${label} cites ${check.intent ?? 'no requirement'}, which is not in the exported Spec. Every check needs a source.`);
    if (steps.length ? !steps.includes(check.at) : check.at !== undefined) {
      fail(steps.length ? `${label} needs at: one of ${steps.join(', ')}.` : `${label} has at, but the package has no steps/ folder.`);
    }
    summary.checks += 1;
    if (check.role === 'gating') summary.gating += 1;
  }
  if (!summary.gating) fail('At least one gating check is required.');
  // A fixture replaces the agent with a script, so the real verifier can be
  // shown to tell a right result, a wrong one and missing evidence apart.
  const produced = new Map([...ids].map((id) => [id, new Set()]));
  const names = new Set();
  if (!Array.isArray(checks.fixtures)) fail('fixtures must be a list; use [] until the verifier is written.');
  for (const fixture of Array.isArray(checks.fixtures) ? checks.fixtures : []) {
    const label = `fixture ${record(fixture) && nonempty(fixture.name) ? fixture.name : '?'}`;
    if (!record(fixture) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.name ?? '') || !record(fixture.expect) || !Object.keys(fixture.expect).length
      || Object.entries(fixture.expect).some(([id, result]) => !ids.has(id) || !RESULTS.includes(result))) {
      fail(`${label} needs a kebab-case name and expect: a result (${RESULTS.join(', ')}) for declared check ids.`);
      continue;
    }
    if (names.has(fixture.name)) fail(`Duplicate fixture name: ${fixture.name}`);
    names.add(fixture.name);
    if (!has(`tests/fixtures/${fixture.name}.sh`)) fail(`${label} has no script at tests/fixtures/${fixture.name}.sh.`);
    for (const [id, result] of Object.entries(fixture.expect)) produced.get(id).add(result);
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
  const uncovered = [...produced].filter(([id]) => (Array.isArray(checks.checks) ? checks.checks : []).some((check) => check?.id === id && check.role === 'gating'))
    .flatMap(([id, results]) => RESULTS.filter((result) => !results.has(result)).map((result) => `${id} ${result}`));
  if (uncovered.length) lack('fixtures', `no fixture expects ${uncovered.join(', ')}`);
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
  const report = (cases = [], coverage = null) => {
    const structural = gaps.filter((gap) => gap.kind !== 'business' && gap.code !== 'integration_pending');
    const runnable = cases.filter((item) => item.integration?.state === 'ready' && item.status === 'confirmed' && !item.errors.length);
    return {
      change: name, valid: structural.length === 0,
      business_ready: gaps.every((gap) => gap.code === 'integration_pending'),
      ready_for_run: structural.length === 0 && runnable.length > 0 && gaps.every((gap) => gap.code === 'integration_pending'),
      spec: handoff ? handoff.id : null,
      map: handoff?.handoff.context.map.status === 'available' ? handoff.handoff.context.map : null,
      cases, coverage, gaps, warnings,
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
  const seen = new Set();
  for (const item of items) {
    const errors = [];
    const summary = validateCase(path.resolve(repo), item, handoff.handoff, name, dockerignore, kit, (message) => errors.push(message));
    cases.push({ ...summary, errors });
    for (const message of errors) {
      gaps.push({ code: 'case_invalid', kind: 'technical', owner: 'agent', route: 'write-eval', case: item.id, message: `${item.id}: ${message}` });
    }
    if (!record(item.checks)) continue;
    if (item.checks.spec_ref?.sha256 && item.checks.spec_ref.sha256 !== handoff.id) {
      gaps.push({ code: 'case_stale', kind: 'technical', owner: 'agent', route: 'write-eval', case: item.id,
        message: `${item.id} was written for another Spec export. Review it against the current requirements, then update spec_ref; do not carry old expectations over silently.` });
      continue;
    }
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
  }
  const uncovered = scenarios.filter((item) => !seen.has(`${item.requirement}\n${item.name}`));
  for (const item of uncovered) {
    gaps.push({ code: 'scenario_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: item.requirement,
      message: `No package for scenario "${item.name}" of ${item.requirement}.` });
  }
  const ungated = handoff.handoff.requirements.filter((requirement) => !gated.has(requirement.id)).map((requirement) => requirement.id);
  for (const id of ungated) {
    gaps.push({ code: 'requirement_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: id,
      message: `${id} has no gating check. Every accepted requirement needs one before the change can pass.` });
  }
  return report(cases, { scenarios: scenarios.length, covered: scenarios.length - uncovered.length, requirements_without_gating_check: ungated });
}
