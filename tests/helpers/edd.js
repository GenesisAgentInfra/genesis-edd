// Test harness for eval check, run, and loop: a ready synthetic project, a fake
// Harbor and a fake Docker. Nothing here needs Docker, Harbor, a network or a
// model. The "application" is app/results.json, which the fake Harbor reads as
// the verifier's results (see fake-harbor.mjs). Rewriting it is changing the code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, initProject, projectRoot, readJSON } from '../../src/project.js';
import { exportSpec, newSpec } from '../../src/spec.js';
import { newEval } from '../../src/eval.js';
import { checkEval } from '../../src/run.js';

export const CHANGE = 'report-notifications';
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

const DOCKER = `#!/bin/sh
# Fake Docker for tests: \`docker info\` reports a running daemon unless
# FAKE_DOCKER_DOWN is set. Nothing else is supported.
if [ "$1" = "info" ]; then
  if [ -n "\${FAKE_DOCKER_DOWN:-}" ]; then
    echo "Cannot connect to the Docker daemon (fake)" >&2
    exit 1
  fi
  echo "27.0.0-fake"
  exit 0
fi
echo "fake docker: unsupported command: $*" >&2
exit 1
`;
// Git reads the user's own configuration and location variables; the tests
// run Git with none of them, so they behave the same on every machine.
const GIT_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES'];
const ENV_KEYS = ['GENESIS_EDD_HARBOR', 'PATH', 'FAKE_HARBOR_LOG', 'FAKE_DOCKER_DOWN', ...GIT_KEYS];
let active = null;

// Points process.env at the fake Harbor and a fake `docker` on PATH until the
// test ends. src/ and every child process (cli()) read them from there, so the
// tests of one file must run one at a time (the node:test default). Calling it
// again in the same test returns the same handle.
//   tools.calls()          every Harbor call so far: [{ argv, env }]
//   tools.runs()           only the `run` calls
//   tools.docker(false)    `docker info` exits 1 until docker(true)
//   tools.harbor(false)    the Harbor command cannot be started until harbor(true)
export function useFakeTools(t) {
  if (active) return active;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-tools-'));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), DOCKER, { mode: 0o755 });
  const log = path.join(directory, 'harbor-calls.jsonl');
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const harbor = JSON.stringify([process.execPath, FAKE_HARBOR]);
  process.env.GENESIS_EDD_HARBOR = harbor;
  process.env.PATH = [bin, saved.PATH].filter(Boolean).join(path.delimiter);
  process.env.FAKE_HARBOR_LOG = log;
  delete process.env.FAKE_DOCKER_DOWN;
  for (const key of GIT_KEYS) delete process.env[key];
  const gitConfig = path.join(directory, 'gitconfig');
  writeFileSync(gitConfig, '');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const tools = {
    log, calls, gitConfig,
    runs: () => calls().filter((call) => call.argv[0] === 'run'),
    docker(running) {
      if (running) delete process.env.FAKE_DOCKER_DOWN;
      else process.env.FAKE_DOCKER_DOWN = '1';
    },
    harbor(available) {
      process.env.GENESIS_EDD_HARBOR = available ? harbor : JSON.stringify([path.join(directory, 'no-such-harbor')]);
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

// Fills every file eval validate needs, except instruction.md when connected is false.
function fillPackage(repo, id, connected) {
  const directory = packageDirectory(repo, id);
  const file = path.join(directory, 'tests/checks.json');
  const declared = readJSON(file);
  const ids = declared.checks.map((check) => check.id);
  declared.fixtures = FIXTURES.map((name) => ({ name, expect: Object.fromEntries(ids.map((check) => [check, name])) }));
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  mkdirSync(path.join(directory, 'tests/fixtures'), { recursive: true });
  for (const name of FIXTURES) {
    writeFileSync(path.join(directory, 'tests/fixtures', `${name}.sh`), `#!/bin/sh\n# Synthetic fixture: leaves a state the verifier judges as ${name}.\nexit 0\n`, { mode: 0o755 });
  }
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
// Returns { repo, name, tools, packages: { id: [check ids] }, check (checkEval result
// or null), root (.genesis/edd/<change>), runs (its runs/ folder) }.
export function readyProject(t, options = {}) {
  const { mode = 'existing', spec = 'two', results = BEFORE, unconnected = [], commit: committed = true, check = true, map = null } = options;
  if (!SPECS[spec]) throw new Error(`spec must be one of ${Object.keys(SPECS).join(', ')}.`);
  const tools = useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-project-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
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
  writeFileSync(path.join(kit, 'harness.json'), `${JSON.stringify({ agent: AGENT }, null, 2)}\n`);
  writeFileSync(path.join(kit, 'PROJECT.md'), '# Eval notes for this project\n\nSynthetic project. app/results.json stands in for the application.\n');
  const ids = readdirSync(path.join(root, 'evals')).sort();
  for (const id of unconnected) if (!ids.includes(id)) throw new Error(`No package named ${id}; packages are ${ids.join(', ')}.`);
  const packages = {};
  for (const id of ids) {
    fillPackage(repo, id, !unconnected.includes(id));
    packages[id] = readJSON(path.join(root, 'evals', id, 'tests/checks.json')).checks.map((entry) => entry.id);
  }
  setResults(repo, results);
  if (committed) commit(repo, 'Add the application and its evals');
  let checked = null;
  if (check) {
    checked = checkEval(repo, CHANGE);
    if (checked.cases.length) assert.equal(checked.passed, true, `eval check failed: ${JSON.stringify(checked, null, 2)}`);
  }
  return { repo, name: CHANGE, tools, packages, check: checked, root, runs: path.join(root, 'runs') };
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
