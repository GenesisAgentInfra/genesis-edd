// Test harness for eval check, run, and loop: a ready synthetic project, a fake
// Harbor and a fake Docker. Nothing here needs Docker, Harbor, a network or a
// model. The "application" is app/results.json, which the fake Harbor reads as
// the verifier's results (see fake-harbor.mjs). Rewriting it is changing the code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, initProject, projectRoot, readJSON } from '../../src/project.js';
import { exportSpec, newSpec } from '../../src/spec.js';
import { newEval, reviewFile } from '../../src/eval.js';
import { checkEval, startRun } from '../../src/run.js';
import { confirmEval, reviewEval } from '../../src/confirm.js';
import { startLoop as startLoopOf } from '../../src/loop.js';

export const CHANGE = 'report-notifications';
// Who made a user's decision in these tests, and where they said so. Every
// decision the CLI records as the user's (checks confirmation, loop start,
// budget, acceptance, decline, abandon, cost approval) takes both.
export const USER = 'Test User';
export const REF = 'test setup';
// The same as options of the functions in src/ and as CLI flags.
export const CONSENT = Object.freeze({ by: USER, ref: REF });
export const CONSENT_FLAGS = Object.freeze(['--by', USER, '--ref', REF]);
// The user's approval of what a model-calling run costs before any checks
// confirmation (run start --approved-by --ref).
export const APPROVAL = Object.freeze({ approvedBy: USER, ref: REF });
export const APPROVAL_FLAGS = Object.freeze(['--approved-by', USER, '--ref', REF]);
export const AGENT = 'app_agent:AppAgent';
export const FAKE_HARBOR = fileURLToPath(new URL('./fake-harbor.mjs', import.meta.url));
export const FAKE_HARBOR_VERSION = 'harbor 0.0.0 (fake)';
export const FIXTURES = ['pass', 'fail', 'unknown'];
const CLI = path.join(ROOT, 'bin/genesis-edd.js');

const EXAMPLE = readFileSync(path.join(ROOT, 'examples/report-notifications/spec.md'), 'utf8');
// The example plus a second explicit requirement with its own quoted source, so
// the project has two packages and the second one has two checks.
const TWO = `${EXAMPLE
  .replace('requirements:', `  success:
    kind: user
    ref: "example:report-notifications/success"
    quote: "报告提交成功时，只发一条成功通知，也不要发失败通知。"
requirements:`)
  .replace('    state: explicit', `    state: explicit
  REQ-submit-success:
    source: success
    state: explicit`)}
### Requirement: REQ-submit-success 提交成功时只发送一条成功通知

系统 MUST 在报告提交成功时只发送一条成功通知，并且不发送失败通知。

#### Scenario: 提交成功

- **WHEN** 报告提交返回成功
- **THEN** 本次提交发送的成功通知数量为一
- **AND** 本次提交发送的失败通知数量为零
`;
// spec option of readyProject -> Spec text. 'example' is the shipped example as is.
export const SPECS = { example: EXAMPLE, two: TWO };

// Packages and check ids of the default ('two') project. 'example' has only the first.
export const PACKAGES = { 'submit-failure-s1': ['c1'], 'submit-success-s1': ['c1', 'c2'] };

// Results with the same value for every check of every package.
export function everyCheck(value, packages = PACKAGES) {
  return Object.fromEntries(Object.entries(packages).map(([id, checks]) => [id, Object.fromEntries(checks.map((check) => [check, value]))]));
}
// The code before the change: a failed submission still sends a success notice.
export const BEFORE = { 'submit-failure-s1': { c1: 'fail' }, 'submit-success-s1': { c1: 'pass', c2: 'pass' } };
// The code after the change: every check passes.
export const AFTER = everyCheck('pass');

// Fake Docker for tests. `docker info` reports a running daemon unless
// FAKE_DOCKER_DOWN is set. Every other command goes to DOCKER_OBJECTS (below),
// which lists and removes compose containers, networks and volumes.
const dockerScript = (objects) => `#!/bin/sh
if [ -n "\${FAKE_DOCKER_DOWN:-}" ]; then
  echo "Cannot connect to the Docker daemon (fake)" >&2
  exit 1
fi
if [ "$1" = "info" ]; then
  echo "27.0.0-fake"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(objects)} "$@"
`;
// The objects of the fake Docker are FAKE_DOCKER_OBJECTS, a JSON file of
// { containers: [{ id, project }], networks: [...], volumes: [...] } (none
// when it does not exist). It answers what `run cleanup` asks: `ps -a`,
// `network ls` and `volume ls` with --filter label=com.docker.compose.project
// (every object with a project) or label=com.docker.compose.project=NAME, and
// either --format (prints the project) or -q (prints the ids); `rm -f IDS`,
// `network rm IDS` and `volume rm IDS` remove objects, and exit 1 for an id
// that does not exist. Each such call is appended to FAKE_DOCKER_LOG.
const DOCKER_OBJECTS = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ argv }) + '\\n');
const file = process.env.FAKE_DOCKER_OBJECTS;
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const kinds = { ps: 'containers', network: 'networks', volume: 'volumes', rm: 'containers' };
const kind = kinds[argv[0]];
if (!kind) { process.stderr.write('fake docker: unsupported command: ' + argv.join(' ') + '\\n'); process.exit(1); }
const objects = Array.isArray(state[kind]) ? state[kind] : [];
const removing = argv[0] === 'rm' || argv[1] === 'rm';
if (removing) {
  const ids = argv.slice(argv[0] === 'rm' ? 1 : 2).filter((word) => !word.startsWith('-'));
  const unknown = ids.filter((id) => !objects.some((entry) => entry.id === id));
  state[kind] = objects.filter((entry) => !ids.includes(entry.id));
  if (file) writeFileSync(file, JSON.stringify(state, null, 2) + '\\n');
  if (unknown.length) { process.stderr.write('fake docker: no such object: ' + unknown.join(', ') + '\\n'); process.exit(1); }
  process.stdout.write(ids.join('\\n') + (ids.length ? '\\n' : ''));
  process.exit(0);
}
const filter = argv[argv.indexOf('--filter') + 1] ?? '';
const label = 'label=com.docker.compose.project';
const project = filter.startsWith(label + '=') ? filter.slice(label.length + 1) : null;
const listed = objects.filter((entry) => entry.project && (project === null || entry.project === project));
const lines = argv.includes('-q') ? listed.map((entry) => entry.id) : listed.map((entry) => entry.project);
process.stdout.write(lines.join('\\n') + (lines.length ? '\\n' : ''));
`;
// Git reads the user's own configuration and location variables; the tests
// run Git with none of them, so they behave the same on every machine.
const GIT_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES'];
const ENV_KEYS = ['GENESIS_EDD_HARBOR', 'GENESIS_EDD_PROGRESS', 'PATH', 'FAKE_HARBOR_LOG', 'FAKE_DOCKER_DOWN', 'FAKE_DOCKER_OBJECTS', 'FAKE_DOCKER_LOG', ...GIT_KEYS];
let active = null;

const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

// Points process.env at the fake Harbor and a fake `docker` on PATH until the
// test ends. src/ and every child process (cli()) read them from there, so the
// tests of one file must run one at a time (the node:test default). Calling it
// again in the same test returns the same handle. Run progress on stderr is
// off (GENESIS_EDD_PROGRESS=0) unless the test turns it on.
//   tools.directory        a folder of this test, removed when it ends
//   tools.calls()          every Harbor call so far: [{ argv, env }]
//   tools.runs()           only the `run` calls
//   tools.docker(false)    every Docker command exits 1 until docker(true)
//   tools.dockerObjects(o) the compose objects Docker holds: { containers:
//                          [{ id, project }], networks, volumes }; with no
//                          argument, what it holds now
//   tools.dockerCalls()    every Docker call but `docker info`: [{ argv }]
//   tools.harbor(false)    the Harbor command cannot be started until harbor(true)
//   tools.progress(true)   runs report their progress on stderr until progress(false)
export function useFakeTools(t) {
  if (active) return active;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-tools-'));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  const objectsScript = path.join(directory, 'docker-objects.mjs');
  writeFileSync(objectsScript, DOCKER_OBJECTS);
  writeFileSync(path.join(bin, 'docker'), dockerScript(objectsScript), { mode: 0o755 });
  const log = path.join(directory, 'harbor-calls.jsonl');
  const objects = path.join(directory, 'docker-objects.json');
  const dockerLog = path.join(directory, 'docker-calls.jsonl');
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const harbor = JSON.stringify([process.execPath, FAKE_HARBOR]);
  process.env.GENESIS_EDD_HARBOR = harbor;
  process.env.GENESIS_EDD_PROGRESS = '0';
  process.env.PATH = [bin, saved.PATH].filter(Boolean).join(path.delimiter);
  process.env.FAKE_HARBOR_LOG = log;
  process.env.FAKE_DOCKER_OBJECTS = objects;
  process.env.FAKE_DOCKER_LOG = dockerLog;
  delete process.env.FAKE_DOCKER_DOWN;
  for (const key of GIT_KEYS) delete process.env[key];
  const gitConfig = path.join(directory, 'gitconfig');
  writeFileSync(gitConfig, '');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const calls = () => readLines(log);
  const tools = {
    directory, log, calls, gitConfig,
    runs: () => calls().filter((call) => call.argv[0] === 'run'),
    docker(running) {
      if (running) delete process.env.FAKE_DOCKER_DOWN;
      else process.env.FAKE_DOCKER_DOWN = '1';
    },
    dockerObjects(given) {
      if (given === undefined) return existsSync(objects) ? readJSON(objects) : { containers: [], networks: [], volumes: [] };
      writeFileSync(objects, `${JSON.stringify({ containers: [], networks: [], volumes: [], ...given }, null, 2)}\n`);
      return given;
    },
    dockerCalls: () => readLines(dockerLog),
    harbor(available) {
      process.env.GENESIS_EDD_HARBOR = available ? harbor : JSON.stringify([path.join(directory, 'no-such-harbor')]);
    },
    progress(on) {
      if (on) delete process.env.GENESIS_EDD_PROGRESS;
      else process.env.GENESIS_EDD_PROGRESS = '0';
    },
  };
  active = tools;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
    active = null;
  });
  return tools;
}

// Points GENESIS_EDD_HARBOR at a Harbor that runs the fake one and then, after
// each `run` call, the script body `after`. In its scope: argv, logs (the -o
// folder of the package), repo (GENESIS_EDD_REPO), path, appendFileSync,
// readFileSync and writeFileSync. tools.harbor(true) goes back to the plain
// fake, and useFakeTools restores the command when the test ends.
export function harborThen(t, after) {
  useFakeTools(t);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-harbor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'harbor.mjs');
  writeFileSync(file, `import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const done = spawnSync(process.execPath, [${JSON.stringify(FAKE_HARBOR)}, ...argv], { stdio: 'inherit' });
if (argv[0] === 'run') {
  const logs = argv[argv.indexOf('-o') + 1];
  const repo = process.env.GENESIS_EDD_REPO;
  ${after}
}
process.exit(done.status ?? 1);
`);
  process.env.GENESIS_EDD_HARBOR = JSON.stringify([process.execPath, file]);
}

// Points GENESIS_EDD_HARBOR at a Harbor that, while the `run` call of package
// id runs the fake one, has file (a path in the project) hold text, and puts
// the file back as it was once that call is done: an edit made and undone
// from another shell during a run. tools.harbor(true) goes back to the plain
// fake, and useFakeTools restores the command when the test ends.
export function harborWhile(t, id, file, text) {
  useFakeTools(t);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-harbor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wrapper = path.join(directory, 'harbor.mjs');
  writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const at = argv.indexOf('-p');
const target = argv[0] === 'run' && at >= 0 && path.basename(argv[at + 1]) === ${JSON.stringify(id)} ? path.join(process.env.GENESIS_EDD_REPO, ${JSON.stringify(file)}) : null;
const kept = target ? readFileSync(target) : null;
if (kept) writeFileSync(target, ${JSON.stringify(text)});
const done = spawnSync(process.execPath, [${JSON.stringify(FAKE_HARBOR)}, ...argv], { stdio: 'inherit' });
if (kept) writeFileSync(target, kept);
process.exit(done.status ?? 1);
`);
  process.env.GENESIS_EDD_HARBOR = JSON.stringify([process.execPath, wrapper]);
}

// Git in the project with a fixed test identity. Fails the test on a non-zero exit.
export function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// Commits everything in the working tree and returns the new HEAD.
export function commit(repo, message = 'Change the application') {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

// Rewrites app/results.json: the application the fake Harbor evaluates.
export function setResults(repo, results) {
  mkdirSync(path.join(repo, 'app'), { recursive: true });
  writeFileSync(path.join(repo, 'app/results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

// Writes the change's Spec, e.g. SPECS.two with a revision bump before exporting again.
export function writeSpec(repo, content) {
  const file = path.join(repo, 'openspec/changes', CHANGE, 'specs/notifications/spec.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const packageDirectory = (repo, id) => path.join(repo, '.genesis/edd', CHANGE, 'evals', id);

// Writes the exact input of a package left unconnected, which makes it
// runnable once `eval check` (checkEval) proves it again.
export function connect(repo, id) {
  writeFileSync(path.join(packageDirectory(repo, id), 'instruction.md'), `Submit the weekly report for scenario ${id}, then stop.\n`);
}

// Rewrites a package's tests/checks.json with change(declared), which edits it
// in place or returns the new content. Returns what was written.
export function editChecks(repo, id, change) {
  const file = path.join(packageDirectory(repo, id), 'tests/checks.json');
  const declared = readJSON(file);
  const written = change(declared) ?? declared;
  writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`);
  return written;
}

// checks.json as a package written in checks.json 1.0 has it: no then, no
// scenario.manual, and no fixture origin or note.
export function toLegacy(declared) {
  const { manual, ...scenario } = declared.scenario ?? {};
  return { ...declared, schema_version: '1.0', scenario,
    checks: declared.checks.map(({ then, ...check }) => check),
    fixtures: declared.fixtures.map(({ origin, note, ...fixture }) => fixture) };
}

// Takes a check out of checks.json, and out of what each fixture expects.
export function dropCheck(declared, id) {
  declared.checks = declared.checks.filter((check) => check.id !== id);
  for (const fixture of declared.fixtures) delete fixture.expect[id];
  return declared;
}

// The warning eval validate gives for packages still in checks.json 1.0.
export function legacyWarning(ids) {
  const one = ids.length === 1;
  return `${ids.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0: ${one ? 'its' : 'their'} checks do not name the THEN lines they verify, so whether every line is checked is not known, and ${one ? 'it has' : 'they have'} no reviewer counterexamples. \`eval confirm\` needs 1.1, and \`loop start\` refuses 1.0 packages. Upgrading changes ${one ? 'the package' : 'each package'}, so a baseline recorded before it compares nothing with ${one ? 'it' : 'them'}.`;
}

// The dependency a package declares in these tests when it is live.
export const LIVE_DEPENDENCY = { name: 'model', mode: 'live', note: 'Synthetic model call.' };

// The reviewer's counterexamples of a package's checks.json: for each THEN line
// its gating checks verify, review-<first check> fails that line's checks and
// passes every other gating check. Lines in except get none. Returns the
// fixtures, without scripts.
export function reviewFixtures(declared, { except = [] } = {}) {
  const gating = declared.checks.filter((check) => check.role === 'gating' && typeof check.then === 'string');
  const lines = [...new Set(gating.map((check) => check.then))].filter((then) => !except.includes(then));
  return lines.map((then) => {
    const own = gating.filter((check) => check.then === then).map((check) => check.id);
    return { name: `review-${own[0].toLowerCase()}`, origin: 'review', note: `Synthetic counterexample for ${then}.`,
      expect: Object.fromEntries(gating.map((check) => [check.id, own.includes(check.id) ? 'fail' : 'pass'])) };
  });
}

// Writes a synthetic script for each named fixture of a package.
export function writeFixtureScripts(repo, id, names) {
  const directory = path.join(packageDirectory(repo, id), 'tests/fixtures');
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    writeFileSync(path.join(directory, `${name}.sh`), `#!/bin/sh\n# Synthetic fixture: leaves a state the verifier judges as ${name}.\nexit 0\n`, { mode: 0o755 });
  }
}

// The THEN lines of a package whose gating checks all fail in results (the
// app/results.json entry of the package): the lines a change to that code fixes.
export function failingLines(declared, results) {
  const gating = declared.checks.filter((check) => check.role === 'gating' && typeof check.then === 'string');
  const value = (check) => (results !== null && typeof results === 'object' && !Array.isArray(results) ? results[check.id] : undefined);
  return [...new Set(gating.map((check) => check.then))]
    .filter((then) => gating.filter((check) => check.then === then).every((check) => value(check) === 'fail'));
}

// The expected baseline result of every check of the packages, read from
// results as the code before the change gives them: fail or pass, and any for
// a check results gives no such value for. Keyed '<case>/<check>', as
// writeExpectations takes it.
export function expectationsOf(packages, results) {
  return Object.fromEntries(Object.entries(packages).flatMap(([id, checks]) => checks.map((check) => {
    const value = results?.[id]?.[check];
    return [`${id}/${check}`, value === 'fail' || value === 'pass' ? value : 'any'];
  })));
}

// Fills every file eval validate needs, except instruction.md when connected is
// false. A live package declares LIVE_DEPENDENCY. The author's fixtures pass,
// fail and unknown are written unless authorFixtures is false, and every gating
// line gets a reviewer's counterexample (reviewFixtures) but those in except.
function fillPackage(repo, id, { connected, live, authorFixtures = true, except = [] }) {
  const directory = packageDirectory(repo, id);
  const file = path.join(directory, 'tests/checks.json');
  const declared = readJSON(file);
  const ids = declared.checks.map((check) => check.id);
  declared.fixtures = [...(authorFixtures ? FIXTURES.map((name) => ({ name, expect: Object.fromEntries(ids.map((check) => [check, name])) })) : []),
    ...reviewFixtures(declared, { except })];
  if (live) declared.dependencies = [LIVE_DEPENDENCY];
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  writeFixtureScripts(repo, id, declared.fixtures.map((fixture) => fixture.name));
  mkdirSync(path.join(directory, 'environment'), { recursive: true });
  writeFileSync(path.join(directory, 'environment/Dockerfile'), 'FROM alpine:3.20\nWORKDIR /app\n');
  writeFileSync(path.join(directory, 'tests/test.sh'), `#!/bin/sh
. "$(dirname "$0")/genesis.sh"
# Synthetic verifier. In these tests the fake Harbor stands in for it.
${ids.map((check) => `gate ${check} unknown "synthetic"`).join('\n')}
finish
`, { mode: 0o755 });
  writeFileSync(path.join(directory, 'Task.md'), `# ${id}\n\n## Trigger\nSynthetic.\n\n## Environment\nSynthetic.\n\n## Evidence\nSynthetic.\n\n## Choices made here\nNone.\n\n## Not covered\nEverything real.\n`);
  if (connected) connect(repo, id);
}

// A project whose packages are proven by `eval check` and ready to run.
// Options (defaults first):
//   mode: 'existing' | 'new'        project mode for init and the Spec
//   spec: 'two' | 'example'         two packages (PACKAGES), or the example's one
//   results: BEFORE                 initial app/results.json
//   unconnected: []                 package ids left with the template instruction.md
//                                   (awaiting_integration, skipped by runs)
//   commit: true                    commit everything before eval check
//   check: true                     run checkEval; it must pass when anything is finished
//   map: null                       a business-map.json object for spec new --map
//   parent: os.tmpdir()             the folder the project is created in
//   live: []                        package ids that declare a live dependency
//                                   (LIVE_DEPENDENCY): the change is of the full tier,
//                                   and the confirmation fixes the number of attempts
//   model: null                     the model harness.json names beside the agent
//                                   (the full tier as well)
//   authorFixtures: true            write the author's fixtures pass, fail and unknown
//                                   beside the reviewer's counterexamples; false
//                                   writes only the counterexamples
//   proof: 'counterexample'         every gating line gets a reviewer's counterexample.
//          | 'baseline'             the lines whose gating checks all fail in results
//                                   get none: their proof that the checks can fail is
//                                   a baseline on that code, which is recorded after
//                                   eval check and before the confirmation, with the
//                                   expectations results gives (expectationsOf),
//                                   committed first; project.base is that baseline
//   confirm: check                  confirm the checks after eval check (confirmChecks),
//                                   committing review.json and confirmed.json with commit
//   tier: 'full' when unconnected   the tier the user confirms (eval confirm --tier).
//         is not empty, else none   With none the confirmation takes the CLI's
//                                   proposal: light when the change qualifies (no
//                                   live package, no model, every package sealed).
//                                   The light tier cannot confirm a line of a package
//                                   that is not connected, so those projects default
//                                   to the full tier
//   attempts: 3 when live or model  the number of attempts the confirmation fixes
//   budget: {}                      the budget the confirmation fixes: { iterations,
//                                   minutes, maxCost }, as confirmEval takes them
//   startLoop: false                the confirmation also records the user's consent
//                                   to start a loop (eval confirm --start-loop)
// Every confirmation is the user's, recorded with by USER and ref REF.
// Returns { repo, name, tools, packages: { id: [check ids] }, check (checkEval result
// or null), confirmation (confirmEval result or null), base (the baseline of
// proof 'baseline', or null), root (.genesis/edd/<change>), runs (its runs/ folder) }.
//
// Building a project takes about two seconds, so each test process builds every
// distinct set of options once, as a template, and gives each test its own copy
// of it (see copyTemplate). A copy is the project a build would give: no file in
// it holds its own path, and the template's Harbor calls are added to this
// test's tools.calls() with the copy's paths. Options that are not plain data, a
// parent, a changed Harbor or Docker, or a Git configuration build the project
// as before.
export function readyProject(t, options = {}) {
  const { mode = 'existing', spec = 'two', results = BEFORE, unconnected = [], commit: committed = true, check = true, map = null,
    parent = os.tmpdir(), live = [], model = null, authorFixtures = true, proof = 'counterexample', budget = {}, startLoop = false } = options;
  const { confirm = check, attempts = live.length || model ? 3 : undefined, tier = unconnected.length ? 'full' : undefined } = options;
  if (!SPECS[spec]) throw new Error(`spec must be one of ${Object.keys(SPECS).join(', ')}.`);
  if (!['counterexample', 'baseline'].includes(proof)) throw new Error('proof must be counterexample or baseline.');
  if (proof === 'baseline' && !check) throw new Error('proof baseline records a baseline, which needs check: true.');
  if (tier !== undefined && !['light', 'full'].includes(tier)) throw new Error('tier must be light or full.');
  const tools = useFakeTools(t);
  const settings = { mode, spec, results, unconnected, committed, check, map, live, model, confirm, attempts, authorFixtures, proof, tier, budget, startLoop };
  const key = options.parent === undefined ? templateKey(settings, tools) : null;
  const template = key === null ? null : templates.get(key) ?? makeTemplate(key, settings, tools);
  if (template?.copyable) return copyTemplate(t, template, tools);
  const repo = projectRoot(mkdtempSync(path.join(parent, 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  return buildProject(repo, tools, settings);
}

function buildProject(repo, tools, settings) {
  const { mode, spec, results, unconnected, committed, check, map, live, model, confirm, attempts, authorFixtures, proof, tier, budget, startLoop } = settings;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Genesis Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  initProject(repo, mode, 'none');
  let mapFile = null;
  if (map) {
    mapFile = path.join(repo, '.genesis/out/ses_test/business-map.json');
    mkdirSync(path.dirname(mapFile), { recursive: true });
    writeFileSync(mapFile, JSON.stringify(map));
  }
  newSpec(repo, CHANGE, mapFile ? { map: mapFile } : {});
  writeSpec(repo, SPECS[spec]);
  exportSpec(repo, CHANGE);
  newEval(repo, CHANGE);
  const root = path.join(repo, '.genesis/edd', CHANGE);
  const kit = path.join(repo, '.genesis/edd/harness');
  writeFileSync(path.join(kit, 'harness.json'), `${JSON.stringify({ agent: AGENT, ...(model ? { model } : {}) }, null, 2)}\n`);
  writeFileSync(path.join(kit, 'PROJECT.md'), '# Eval notes for this project\n\nSynthetic project. app/results.json stands in for the application.\n');
  const ids = readdirSync(path.join(root, 'evals')).sort();
  for (const id of [...unconnected, ...live]) if (!ids.includes(id)) throw new Error(`No package named ${id}; packages are ${ids.join(', ')}.`);
  const packages = {};
  for (const id of ids) {
    const file = path.join(root, 'evals', id, 'tests/checks.json');
    const except = proof === 'baseline' ? failingLines(readJSON(file), results?.[id]) : [];
    fillPackage(repo, id, { connected: !unconnected.includes(id), live: live.includes(id), authorFixtures, except });
    packages[id] = readJSON(file).checks.map((entry) => entry.id);
  }
  setResults(repo, results);
  if (committed) commit(repo, 'Add the application and its evals');
  let checked = null;
  if (check) {
    checked = checkEval(repo, CHANGE);
    if (checked.cases.length) assert.equal(checked.passed, true, `eval check failed: ${JSON.stringify(checked, null, 2)}`);
  }
  let base = null;
  if (proof === 'baseline') {
    const expect = writeExpectations(repo, expectationsOf(packages, results));
    if (committed) {
      const file = path.relative(repo, expect);
      git(repo, ['add', '--', file]);
      git(repo, ['commit', '-q', '-m', 'Expect the baseline results', '--', file]);
    }
    base = startRun(repo, CHANGE, { baseline: true, expect });
    assert.equal(base.is_baseline, true, `the baseline did not record: ${JSON.stringify(base, null, 2)}`);
  }
  const project = { repo, name: CHANGE, tools, packages, check: checked, confirmation: null, base, root, runs: path.join(root, 'runs') };
  if (confirm) {
    project.confirmation = confirmChecks(project, { attempts, tier, ...budget, ...(startLoop ? { startLoop: true } : {}) });
    if (committed) commitConfirmation(repo);
  }
  return project;
}

// Templates of this test process by key, and the folder that holds them until
// the process exits.
const templates = new Map();
let templateFolder = null;
const FAKE_HARBOR_COMMAND = JSON.stringify([process.execPath, FAKE_HARBOR]);
// Variables useFakeTools sets for every test, or that hold a path of the test.
const PER_TEST = new Set(['GENESIS_EDD_HARBOR', 'GENESIS_EDD_PROGRESS', 'FAKE_HARBOR_LOG', 'FAKE_DOCKER_DOWN', 'FAKE_DOCKER_OBJECTS', 'FAKE_DOCKER_LOG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH']);

// Numbers, strings, booleans, null, and arrays and plain objects of them.
function plainData(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(plainData);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(plainData);
}

// The template key of a build, or null when the build must not be shared: the
// options are not plain data, or the test changed what a build reads besides
// them (the Harbor command, Docker, its Git configuration).
function templateKey(settings, tools) {
  if (!plainData(settings)) return null;
  if (process.env.GENESIS_EDD_HARBOR !== FAKE_HARBOR_COMMAND || process.env.FAKE_DOCKER_DOWN !== undefined) return null;
  if (process.env.FAKE_HARBOR_LOG !== tools.log || readFileSync(tools.gitConfig, 'utf8') !== '') return null;
  // Everything else the build or Git could read from the environment is part of the key.
  const env = Object.fromEntries(Object.keys(process.env).sort()
    .filter((name) => !PER_TEST.has(name) && /^(GIT_|GENESIS_EDD_|FAKE_|PYTHON)/.test(name)).map((name) => [name, process.env[name]]));
  return JSON.stringify({ settings, env, path: process.env.PATH.split(path.delimiter).slice(1) });
}

// Builds the project of these settings in the template folder, with its Harbor
// calls logged apart. A template is copyable when no file in it, Git's own
// files included, names the template folder or the builder's tools folder, and
// none is a symbolic link. Otherwise every test builds its project as before.
function makeTemplate(key, settings, tools) {
  if (!templateFolder) {
    templateFolder = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-templates-'));
    const folder = templateFolder;
    process.on('exit', () => rmSync(folder, { recursive: true, force: true }));
  }
  const given = mkdtempSync(path.join(templateFolder, 'genesis-edd-project-'));
  const repo = projectRoot(given);
  const log = `${repo}.harbor-calls.jsonl`;
  const saved = process.env.FAKE_HARBOR_LOG;
  process.env.FAKE_HARBOR_LOG = log;
  let project;
  try {
    project = buildProject(repo, tools, settings);
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  } finally {
    process.env.FAKE_HARBOR_LOG = saved;
  }
  // The template's folders, and the tools folder of the test that built it.
  const marks = [...new Set([path.basename(templateFolder), path.basename(repo), path.basename(path.dirname(tools.log))])];
  const data = Object.fromEntries(Object.entries(project).filter(([name]) => name !== 'tools'));
  const template = { repo, given, data, calls: existsSync(log) ? readFileSync(log, 'utf8') : '', marks, copyable: !mentions(repo, marks) };
  templates.set(key, template);
  return template;
}

// Whether any file under the folder holds one of the marks, or is a symbolic link.
function mentions(folder, marks) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() ? mentions(file, marks) : marks.some((mark) => readFileSync(file, 'latin1').includes(mark))) return true;
  }
  return false;
}

// A test's own copy of a template, in a new folder of os.tmpdir() as a build
// makes it. Paths of the template, as given and as resolved (/var and
// /private/var on macOS), become the copy's in the returned project and in the
// Harbor calls added to tools.calls(). Git's index is refreshed, since the
// copied files have other inodes and times than the index recorded.
function copyTemplate(t, template, tools) {
  const given = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-'));
  const repo = projectRoot(given);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  cpSync(template.repo, repo, { recursive: true, verbatimSymlinks: true });
  if (existsSync(path.join(repo, '.git/index'))) {
    const refreshed = spawnSync('git', ['-C', repo, 'update-index', '-q', '--refresh'], { encoding: 'utf8' });
    assert.equal(refreshed.error, undefined, `git update-index: ${refreshed.error?.message}`);
  }
  const pairs = [[template.repo, repo], [template.given, given]];
  const rewrite = (text) => pairs.reduce((value, [from, to]) => value.replaceAll(from, to), text);
  const copy = (value) => (typeof value === 'string' ? rewrite(value) : Array.isArray(value) ? value.map(copy)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, copy(item)])) : value);
  const calls = rewrite(template.calls);
  const data = copy(template.data);
  const left = template.marks.filter((mark) => calls.includes(mark) || JSON.stringify(data).includes(mark));
  if (left.length) throw new Error(`readyProject: the copy of a template still names ${left.join(', ')}; build this project without the template.`);
  if (calls) appendFileSync(tools.log, calls);
  const { name, packages, check, confirmation, base, root, runs } = data;
  return { repo, name, tools, packages, check, confirmation, base, root, runs };
}

// Commits review.json and confirmed.json, and nothing else.
export function commitConfirmation(repo, message = 'Confirm the checks') {
  const files = [reviewFile(repo, CHANGE), path.join(repo, '.genesis/edd', CHANGE, 'confirmed.json')].map((file) => path.relative(repo, file));
  git(repo, ['add', '--', ...files]);
  git(repo, ['commit', '-q', '-m', message, '--', ...files]);
}

// Records the user's confirmation of the checks as the skills do: review.json
// written from eval review's review_template, with every line faithful (a
// scenario.manual line not_observable) unless verdict(line) says otherwise,
// and every changed package answered as not loosening a line. Then eval
// confirm, as the user's decision with by and ref. Options:
//   by (USER), ref (REF)       who confirmed and where they said so
//   verdict(line)              the verdict of a line of the template, or undefined
//   origin ('review')          review.origin of the answers
//   any other option goes to confirmEval as given (undefined ones are left
//   out): reason, tier ('light' | 'full'), attempts, agent, model, iterations,
//   minutes, maxCost, startLoop, stopOnStuck, judgeGating, acceptVerdict,
//   acceptReason.
// With no tier the confirmation takes the tier eval review proposes. In the
// light tier every gating line needs a proof that its checks can fail: a
// reviewer's counterexample eval check proved (readyProject writes one for
// every line), or, for a line the change fixes, its failure at a baseline that
// expected it (readyProject's proof 'baseline'). Returns the confirmEval
// result; it throws a refusal as confirmEval does.
export function confirmChecks(project, options = {}) {
  const { repo } = project;
  const { verdict = () => undefined, origin = 'review', by = USER, ref = REF, ...plan } = options;
  const review = reviewEval(repo, CHANGE);
  const manual = new Set(review.lines.filter((line) => line.status === 'manual').map((line) => `${line.package}\n${line.then}`));
  const answers = { ...review.review_template, review: { origin, note: 'Synthetic review.' },
    lines: review.review_template.lines.map((line) => ({ ...line,
      verdict: verdict(line) ?? (manual.has(`${line.package}\n${line.then}`) ? 'not_observable' : 'faithful'), note: line.note ?? 'Synthetic verdict.' })),
    ...(review.review_template.packages ? { packages: review.review_template.packages.map((item) => ({ ...item, loosens: false, note: 'Synthetic diff review.' })) } : {}) };
  const file = reviewFile(repo, CHANGE);
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  const defined = Object.fromEntries(Object.entries(plan).filter(([, value]) => value !== undefined));
  return confirmEval(repo, CHANGE, { verdicts: file, by, ref, ...defined });
}

// The layers a gap names: where the cause is.
export const LAYERS = ['spec', 'package', 'kit', 'confirmation', 'baseline', 'loop', 'ledger', 'machine', 'code'];

// Asserts the shape every gap has: a code, a kind, an owner (agent or user),
// a layer and a message, and no route or resume (a gap states facts, never
// the skill or command to go to). expected holds fields it must have too,
// such as { code: 'loop_consent_missing', owner: 'user', layer: 'loop' }.
// Returns the gap.
export function assertGapShape(entry, expected = {}) {
  const shown = JSON.stringify(entry);
  assert.ok(entry !== null && typeof entry === 'object', `not a gap: ${shown}`);
  assert.equal(typeof entry.code, 'string', shown);
  assert.equal(typeof entry.kind, 'string', shown);
  assert.ok(['agent', 'user'].includes(entry.owner), `owner: ${shown}`);
  assert.ok(LAYERS.includes(entry.layer), `layer: ${shown}`);
  assert.equal(typeof entry.message, 'string', shown);
  assert.ok(!('route' in entry) && !('resume' in entry), `a gap names no route or resume: ${shown}`);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(entry[key], value, `${key}: ${shown}`);
  return entry;
}

// Asserts that no object anywhere in value carries route, resume or next:
// results and gaps state facts and at most one suggestion.
export function assertNoRoutes(value, where = 'result') {
  const seen = [];
  const walk = (item, at) => {
    if (item === null || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach((entry, index) => walk(entry, `${at}[${index}]`)); return; }
    for (const key of ['route', 'resume', 'next']) if (key in item) seen.push(`${at}.${key}`);
    for (const [key, entry] of Object.entries(item)) walk(entry, `${at}.${key}`);
  };
  walk(value, where);
  assert.deepEqual(seen, [], `found ${seen.join(', ')}`);
}

// Asserts a result's suggestion: null when command is null, else { command,
// why } whose command starts with the given words.
export function assertSuggestion(result, command) {
  if (command === null) {
    assert.equal(result.suggestion, null, JSON.stringify(result.suggestion));
    return null;
  }
  const { suggestion } = result;
  assert.ok(suggestion && Array.isArray(suggestion.command) && typeof suggestion.why === 'string', JSON.stringify(suggestion));
  assert.deepEqual(suggestion.command.slice(0, command.length), command, JSON.stringify(suggestion));
  return suggestion;
}

// The action of a workflow status (workflowStatus, or checkWorkflow, its old
// name) whose command is words[0] words[1] and holds every further word, such
// as '--baseline': actionOf(status, 'run', 'start', '--baseline'). Undefined
// when it lists none.
export const actionOf = (status, ...words) => status.actions.find((entry) => entry.command[0] === words[0] && entry.command[1] === words[1]
  && words.slice(2).every((word) => entry.command.includes(word)));
// The actions a workflow status allows now (allowed: nothing refuses them), as
// 'group command --flag ...' with the flags that tell them apart, never --repo
// or placeholder values: ['eval check', 'run start --baseline', ...].
export const allowedActions = (status) => status.actions.filter((entry) => entry.allowed)
  .map((entry) => [...entry.command.slice(0, 2), ...entry.command.slice(2).filter((word) => word.startsWith('--') && word !== '--repo')].join(' '));

// Starts a loop as the user's decision: startLoop of src/loop.js with by USER
// and ref REF, as `loop start --by --ref` records the user's consent. Options
// go to it as given and win over those: budget flags (iterations, minutes,
// maxCost), or another by and ref. To start one without --by and --ref, as
// after `eval confirm --start-loop`, pass { by: undefined, ref: undefined },
// or call startLoop of src/loop.js. Returns what it returns; throws its refusals.
export function startLoop(repo, name = CHANGE, options = {}) {
  return startLoopOf(repo, name, { ...CONSENT, ...options });
}

// An --expect file for a baseline. expected is { '<case>/<check>': 'pass' | 'fail' | 'any' },
// or an array written as given (to test invalid input). It lives under .genesis/,
// so it does not count as an application change.
export function writeExpectations(repo, expected) {
  const entries = Array.isArray(expected) ? expected : Object.entries(expected).map(([key, value]) => {
    const [id, check] = key.split('/');
    return { case: id, check, expected: value, reason: `Synthetic expectation for ${key}.` };
  });
  const file = path.join(repo, '.genesis/edd', CHANGE, 'baseline-expectations.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  return file;
}

// run.json and compare.json (null for a baseline) of a startRun result or run folder.
export function readRecord(run) {
  const directory = typeof run === 'string' ? run : run.directory;
  const compare = path.join(directory, 'compare.json');
  return { run: readJSON(path.join(directory, 'run.json')), compare: existsSync(compare) ? readJSON(compare) : null };
}

// Runs bin/genesis-edd.js with process.env (which useFakeTools has set).
// Returns { status, json, stdout, stderr }; json is stdout, or the error on stderr.
export function cli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  for (const text of [result.stdout, result.stderr]) {
    if (json === null && text?.trim()) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}
