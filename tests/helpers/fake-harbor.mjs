#!/usr/bin/env node
// Stands in for Harbor in tests. It accepts the two calls Genesis EDD makes:
//
//   --version                     prints a fixed version line
//   run -p PACKAGE -a AGENT -k N -n 1 -o LOGS --job-name JOB --quiet [-m MODEL] [--yes]
//
// A run writes LOGS/JOB/trial-<i>/result.json and, when the verifier "ran",
// trial-<i>/verifier/check-results.json and reward.json, for i = 1..N. Nothing
// is built or executed: the results are read from files.
//
// With -a genesis_fixture:FixtureAgent (eval check) every check gets the result
// the fixture named by GENESIS_EDD_FIXTURE expects in PACKAGE/tests/checks.json.
// A fixture script that does not exist fails the trial, as the real agent would.
//
// With any other agent the results come from the application:
// GENESIS_EDD_REPO/app/results.json, keyed by the package folder name.
//
//   { "<case>": { "<check>": "pass" } }              one value for every attempt
//   { "<case>": { "<check>": ["pass", "fail"] } }    one value per attempt
//   { "<case>": "error" }                            Harbor exits 1 and writes no trial
//   { "<case>": "exception" }                        each trial records exception_info
//                                                    and the verifier writes nothing
//   { "<case>": [{ "c1": "pass" }, "exception"] }    one case value per attempt;
//                                                    an "error" attempt writes no trial
//                                                    folder and Harbor exits 1
//
// A missing case, check or attempt is "unknown". A check value of "missing"
// leaves the check out of check-results.json; any other value is written as
// given. "$reward" in a case object overrides the reward the verifier writes.
// The reward is otherwise 1 when every gating check passed, else 0.
// "$usage" in a case object, such as { "n_input_tokens": 10, "cost_usd": 0.01 },
// is written as the trial's agent_result, as an adapter reports what it used.
//
// Every trial's result.json has started_at and finished_at, as Harbor writes
// them: trial-<i> starts one second after trial-<i-1> finished. A trial takes
// one second, or n seconds with "$seconds": n in its case object; under eval
// check, with "$seconds": n on the fixture in checks.json (beside its name and
// expect, which names check ids only). Nothing waits: only the times say so.
//
// When FAKE_HARBOR_LOG names a file, every call appends one JSON line with its
// arguments and the environment Genesis EDD passes, so tests can assert on it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Keep in step with FAKE_HARBOR_VERSION in edd.js. Importing this file would run it.
const VERSION = 'harbor 0.0.0 (fake)';
const FIXTURE_AGENT = 'genesis_fixture:FixtureAgent';
const LOGGED_ENV = ['GENESIS_EDD_REPO', 'GENESIS_EDD_HARNESS', 'GENESIS_EDD_FIXTURE', 'PYTHONPATH'];
const VALUED = new Set(['-p', '-a', '-k', '-n', '-o', '--job-name', '-m']);
const FLAGS = new Set(['--quiet', '--yes']);

const argv = process.argv.slice(2);

function stop(message, status = 2) {
  process.stderr.write(`fake harbor: ${message}\n`);
  process.exit(status);
}

if (process.env.FAKE_HARBOR_LOG) {
  const env = Object.fromEntries(LOGGED_ENV.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  appendFileSync(process.env.FAKE_HARBOR_LOG, `${JSON.stringify({ argv, env })}\n`);
}

if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv[0] !== 'run') stop(`unsupported arguments: ${argv.join(' ')}`);

const options = { flags: new Set() };
for (let index = 1; index < argv.length; index += 1) {
  const word = argv[index];
  if (FLAGS.has(word)) options.flags.add(word);
  else if (VALUED.has(word) && index + 1 < argv.length) options[word] = argv[++index];
  else stop(`unknown or incomplete argument: ${word}`);
}
for (const required of ['-p', '-a', '-o']) if (!options[required]) stop(`run needs ${required}`);
const attempts = Number(options['-k'] ?? '1');
if (!Number.isInteger(attempts) || attempts < 1) stop(`-k must be a whole number of 1 or more, got ${options['-k']}`);

const packageDirectory = options['-p'];
const caseId = path.basename(packageDirectory);
let declared;
try { declared = JSON.parse(readFileSync(path.join(packageDirectory, 'tests/checks.json'), 'utf8')); } catch (cause) {
  stop(`cannot read ${path.join(packageDirectory, 'tests/checks.json')}: ${cause.message}`);
}
const checks = Array.isArray(declared.checks) ? declared.checks : [];

// What happens in one attempt: no trial at all, a trial that raised, or a
// trial whose verifier recorded these values.
function fixturePlan() {
  const script = process.env.GENESIS_EDD_FIXTURE;
  if (!script || !existsSync(script)) {
    return { kind: 'exception', type: 'FileNotFoundError', message: `fixture script not found: ${script ?? '(GENESIS_EDD_FIXTURE is not set)'}` };
  }
  const name = path.basename(script).replace(/\.sh$/, '');
  const fixture = (declared.fixtures ?? []).find((entry) => entry?.name === name);
  const expect = fixture?.expect ?? {};
  return { kind: 'results', values: Object.fromEntries(checks.map((check) => [check.id, expect[check.id] ?? 'unknown'])), ...seconds(fixture) };
}

// The seconds a trial takes, when the object gives them.
const seconds = (given) => (typeof given?.$seconds === 'number' && given.$seconds >= 0 ? { seconds: given.$seconds } : {});

function applicationResults() {
  const repo = process.env.GENESIS_EDD_REPO;
  if (!repo) stop('GENESIS_EDD_REPO is not set');
  const file = path.join(repo, 'app/results.json');
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (cause) { return stop(`cannot read ${file}: ${cause.message}`, 3); }
}

function applicationPlan(entry, attempt) {
  if (entry === 'error') return { kind: 'error' };
  if (entry === 'exception') return { kind: 'exception', type: 'RuntimeError', message: `the application failed in ${caseId}` };
  const given = entry !== null && typeof entry === 'object' ? entry : {};
  const values = Object.fromEntries(checks.map((check) => {
    const value = given[check.id];
    return [check.id, (Array.isArray(value) ? value[attempt - 1] : value) ?? 'unknown'];
  }));
  return { kind: 'results', values, ...(typeof given.$reward === 'number' ? { reward: given.$reward } : {}),
    ...(given.$usage !== null && typeof given.$usage === 'object' ? { usage: given.$usage } : {}), ...seconds(given) };
}

const fixture = options['-a'] === FIXTURE_AGENT;
const results = fixture ? null : applicationResults();
const job = path.join(options['-o'], options['--job-name'] ?? 'harbor');
// The first attempt starts with this call; each later one, one second after
// the one before it finished.
const clock = Date.now();
const at = (offset) => new Date(clock + offset * 1000).toISOString();
let offset = 0;
let status = 0;
let written = 0;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  let plan;
  if (fixture) plan = fixturePlan();
  else {
    const entry = results[caseId];
    plan = applicationPlan(Array.isArray(entry) ? entry[attempt - 1] : entry, attempt);
  }
  if (plan.kind === 'error') {
    status = 1;
    process.stderr.write(`fake harbor: ${caseId} attempt ${attempt} could not start\n`);
    continue;
  }
  const trial = path.join(job, `trial-${attempt}`);
  mkdirSync(trial, { recursive: true });
  const took = plan.seconds ?? 1;
  const outcome = { task_name: caseId, trial_name: `trial-${attempt}`, agent: options['-a'], model: options['-m'] ?? null,
    started_at: at(offset), finished_at: at(offset + took) };
  offset += took + 1;
  if (plan.usage) outcome.agent_result = plan.usage;
  if (plan.kind === 'exception') {
    outcome.exception_info = { exception_type: plan.type, exception_message: plan.message };
  } else {
    const verifier = path.join(trial, 'verifier');
    mkdirSync(verifier, { recursive: true });
    const recorded = checks.filter((check) => plan.values[check.id] !== 'missing').map((check) => ({
      id: check.id, result: plan.values[check.id], evidence: `fake verifier: ${caseId}/${check.id} attempt ${attempt} is ${plan.values[check.id]}`,
    }));
    const passed = checks.filter((check) => check.role === 'gating').every((check) => plan.values[check.id] === 'pass');
    const reward = plan.reward ?? (passed ? 1 : 0);
    writeFileSync(path.join(verifier, 'check-results.json'), `${JSON.stringify({ results: recorded }, null, 2)}\n`);
    writeFileSync(path.join(verifier, 'reward.json'), `${JSON.stringify({ reward })}\n`);
    outcome.verifier_result = { rewards: { reward } };
  }
  writeFileSync(path.join(trial, 'result.json'), `${JSON.stringify(outcome, null, 2)}\n`);
  written += 1;
}
process.stdout.write(`fake harbor: ${caseId} wrote ${written} of ${attempts} trials with ${options['-a']}\n`);
process.exit(status);
