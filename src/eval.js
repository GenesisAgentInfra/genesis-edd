import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { ROOT, changeDirectory, digest, ignoredArtifacts, isLeftover, listFiles, localPath, readJSON, writeJSON } from './project.js';
import { readRunIndex } from './records.js';
import { frozenSpec, specHandoff, validateSpec } from './spec.js';

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
// The kinds of check checks.json 1.1 knows. A verifier check reads what the
// evaluated program left. A code test runs a command frozen in the package
// against the application code in the container, through the shipped helper.
// A judge runs a judging program frozen in the package or the kit for a line
// the user judges; it is diagnostic unless the user makes that line gating.
const CODE_TEST = 'code_test';
const JUDGE = 'judge';
const KINDS = ['verifier', CODE_TEST, JUDGE];
// The kinds of fixture: a script that stands in for the evaluated agent, or a
// patch to the application code that a code test must fail on.
const FIXTURE_KINDS = ['script', 'code_patch'];
// How many lines a then_group may name: a few lines that can only fail
// together. More than that is more than one outcome.
const GROUP_LIMIT = 4;
// How long a code test or a judge may run when its check gives no
// timeout_sec, in seconds. The shipped helper uses the same default.
const PROGRAM_SECONDS = 300;
// A package's own harness.json, which may name the adapter it runs with.
const PACKAGE_HARNESS = 'harness.json';
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
const isDirectory = (file) => { try { return statSync(file).isDirectory(); } catch { return false; } };
const relativeOf = (directory, file) => path.relative(directory, file).split(path.sep).join('/');
// The short form of a digest, for a message.
const short = (sha) => String(sha ?? '').replace(/^sha256:/, '').slice(0, 12);

// A gap: what is wrong, the layer it is in (spec, package, kit, confirmation,
// baseline, loop, ledger, machine or code), whose decision it is, and where.
const gapOf = (code, layer, owner, kind, message, facts = {}) => ({ code, kind, owner, layer, message, ...facts });
// A gap another module reported, as this one passes it on: in its layer,
// without fields that named a skill or a command to go back to.
const passedOn = (gap, layer = 'spec') => {
  const { route, resume, ...rest } = record(gap) ? gap : {};
  return { layer, ...rest };
};

// The form of a THEN or AND line that checks bind: every run of whitespace,
// full-width spaces and line breaks included, is one space, and the ends are
// trimmed. Otherwise the text must match character for character.
export const thenKey = (text) => text.replace(/\s+/g, ' ').trim();

// The packages that still use checks.json 1.0, from validateEval: ids in order.
export const legacyPackages = (evals) => (evals?.cases ?? []).filter((item) => item.schema_version === '1.0').map((item) => item.id);

// The THEN lines the user judges at acceptance, from validateEval.
export const manualLines = (evals) => (evals?.then_lines ?? []).filter((row) => row.status === 'manual');

// Whether a package, as eval validate lists it, is bound to a Spec draft
// rather than to an export: it can be validated and proved, and nothing
// confirms, baselines or runs it until `eval rebind` binds it to an export.
export const draftBound = (summary) => summary?.draft_bound === true;

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

// A JSON value written with the keys of every object in order, so the same
// content always gives the same text.
const canonical = (value) => JSON.stringify(value, (key, item) => (record(item) ? Object.fromEntries(Object.keys(item).sort().map((entry) => [entry, item[entry]])) : item));

// checks.json as a run reads it: its content without fixtures, which only
// `eval check` runs, or null when it is no JSON object.
function runForm(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!record(parsed)) return null;
  const { fixtures, ...rest } = parsed;
  return canonical(rest);
}

// checks.json as a proof and a reviewer read it: its content without the Spec
// export it is bound to (spec_ref) and the record of its earlier bindings
// (rebound), and, with fixtures false, without its fixtures too. A package
// re-bound to a new export whose scenario says the same keeps what its
// fixtures and its probe proved and what a reviewer read. null when it is no
// JSON object.
function boundFree(text, { fixtures = true } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!record(parsed)) return null;
  const { spec_ref: ref, rebound, fixtures: list, ...rest } = parsed;
  return canonical(fixtures ? { ...rest, fixtures: list } : rest);
}

// The files of a package by their digests, each line its path, a newline and
// its digest. With fixtures false, tests/fixtures/ is left out. form says how
// checks.json is read: 'run' (runForm) or 'proof' (boundFree), which also
// leaves out the package's own harness.json, as no fixture or probe runs the
// adapter it names.
function packageLines(directory, { fixtures, form }) {
  const folder = `tests${path.sep}fixtures${path.sep}`;
  return executed(directory, 'Task.md').filter((file) => fixtures || !path.relative(directory, file).startsWith(folder)).flatMap((file) => {
    const relative = relativeOf(directory, file);
    if (form === 'proof' && relative === PACKAGE_HARNESS) return [];
    const content = readFileSync(file);
    const shaped = relative !== 'tests/checks.json' ? null
      : form === 'run' ? runForm(content.toString('utf8')) : boundFree(content.toString('utf8'), { fixtures });
    return [`${relative}\n${digest(shaped ?? content)}`];
  });
}

// The files of a package a run executes, each by its digest: every file the
// task digest covers but tests/fixtures/, and checks.json without its
// fixtures. A fixture only stands in for the evaluated agent in `eval check`;
// a real run never executes one.
const runLines = (directory) => packageLines(directory, { fixtures: false, form: 'run' });

// Whether two records hold the same package. Each side is { task, run }, its
// task digest and its run digest, either null when it has none. Two records
// that both have a run digest compare it, so a fixture added or changed keeps
// the package; otherwise their task digests, which cover every file, decide.
export function samePackage(a, b) {
  if (a?.run && b?.run) return a.run === b.run;
  return Boolean(a?.task) && a.task === b?.task;
}

// The digests one package has in a record that keeps them by package, such as
// a run, loop.json, an eval snapshot or the case list of eval validate:
// { task, run }.
export const digestsAt = (holder, id) => ({ task: holder?.task_digest?.[id] ?? null, run: holder?.run_digest?.[id] ?? null });

// The digests of one result of sameCodeResults: { task, run }.
export const entryDigests = (entry) => ({ task: entry?.task_digest ?? null, run: entry?.run_digest ?? null });

// The digests of the packages of a confirmation entry, as a record that keeps
// them by package: { task_digest, run_digest }.
export const confirmedDigests = (entry) => ({
  task_digest: Object.fromEntries(Object.entries(entry?.packages ?? {}).map(([id, item]) => [id, item?.task_digest ?? null])),
  run_digest: Object.fromEntries(Object.entries(entry?.packages ?? {}).filter(([, item]) => item?.run_digest).map(([id, item]) => [id, item.run_digest])),
});

// The digests of the packages eval validate lists, as a record that keeps
// them by package.
export const casesDigests = (cases) => ({
  task_digest: Object.fromEntries((cases ?? []).map((item) => [item.id, item.task_digest ?? null])),
  run_digest: Object.fromEntries((cases ?? []).filter((item) => item.run_digest).map((item) => [item.id, item.run_digest])),
});

// The packages that are not the same between two records that keep their
// digests by package (samePackage): ids in order, a package on one side only
// included.
export function packagesBetween(a, b) {
  const ids = new Set([a?.task_digest, a?.run_digest, b?.task_digest, b?.run_digest].flatMap((map) => Object.keys(map ?? {})));
  return [...ids].filter((id) => !samePackage(digestsAt(a, id), digestsAt(b, id))).sort();
}

// The adapter and the model harness.json names, each null when it names none
// or cannot be read.
function harnessSettings(directory) {
  let harness = null;
  try { harness = readJSON(path.join(directory, 'harness.json')); } catch { /* reported as missing */ }
  return { agent: nonempty(harness?.agent) ? harness.agent : null, model: nonempty(harness?.model) ? harness.model : null };
}

// The kit files no `eval check` proof rests on: harness.json, which names the
// evaluated agent and its model, and the adapter modules at the kit's root
// that Harbor imports for that agent. Fixtures and the probe run agents of
// their own in its place, so an edit to these alone keeps their proofs. A
// module in a folder of the kit is not one of them, and neither is a module
// at the root that an environment file of the package or the kit copies or
// mounts into a container (environmentKeeps): a stand-in may run it.
const adapterOnly = (relative) => relative === 'harness.json' || (!relative.includes('/') && relative.endsWith('.py'));

function readKit(repo) {
  const directory = kitDirectory(repo);
  const { agent, model } = harnessSettings(directory);
  const verifier = path.join(directory, 'verifier');
  const kitLines = lines(directory, executed(directory, 'PROJECT.md'), 'kit/');
  return {
    directory, agent, model, notes: filled(path.join(directory, 'PROJECT.md')),
    lines: kitLines,
    // Each line is kit/<file>, a newline and its digest.
    entries: kitLines.map((line) => ({ line, relative: line.slice('kit/'.length, line.lastIndexOf('\n')) })),
    // What a package checks rests on this code; Python caches are no part of it.
    verifier: lines(verifier, executed(verifier)),
    environment: listFiles(path.join(directory, 'environment')),
  };
}

// The kit's lines a proof of one package rests on: every one but harness.json
// and the adapter modules at the kit's root, unless kept names a module the
// package's environment reaches.
const kitProofLines = (kit, kept) => kit.entries.filter(({ relative }) => !adapterOnly(relative) || kept.has(relative)).map(({ line }) => line);

// Model SDKs, by the names Python imports them under.
const MODEL_SDKS = ['openai', 'anthropic', 'google.generativeai', 'google.genai', 'vertexai', 'mistralai', 'cohere', 'ollama', 'litellm', 'langchain',
  'langchain_core', 'langchain_openai', 'langchain_anthropic', 'langchain_community', 'llama_index', 'groq', 'together', 'replicate', 'huggingface_hub',
  'transformers', 'dashscope', 'zhipuai', 'qianfan'];
// General HTTP and RPC clients: an adapter that imports one can call a model
// over the network itself.
const HTTP_CLIENTS = ['requests', 'httpx', 'aiohttp', 'urllib3', 'urllib.request', 'http.client', 'httplib2', 'pycurl', 'treq', 'grpc', 'websocket',
  'websockets', 'boto3', 'botocore'];
const importsName = (module, names) => names.some((entry) => module === entry || module.startsWith(`${entry}.`));

// The modules a Python file imports, each dotted name as written, and for
// `from a import b` both a and a.b. Relative imports are left out. A line
// inside a string can match too: the scan only decides a tier, so a false
// match costs a full-tier run, never a refusal.
function importsOf(text) {
  const found = new Set();
  const names = (list) => list.split(',').map((item) => item.trim().split(/\s+/)[0]).filter((word) => word && word !== '*' && word !== '(');
  for (const line of text.split('\n')) {
    const from = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+\(?\s*([\w\s,*]*)/);
    if (from) {
      found.add(from[1]);
      for (const word of names(from[2])) found.add(`${from[1]}.${word}`);
      continue;
    }
    const plain = line.match(/^\s*import\s+([\w.,\s]+)/);
    if (plain) for (const word of names(plain[1])) found.add(word);
    for (const dynamic of line.matchAll(/(?:__import__|import_module)\(\s*["']([A-Za-z_][\w.]*)["']/g)) found.add(dynamic[1]);
  }
  return [...found];
}

// The kit's own Python files outside environment/ and verifier/: the adapter
// Harbor imports and the modules beside it, which run on the host.
const adapterFiles = (directory) => ownFiles(directory).filter((file) => file.endsWith('.py')
  && !['environment', 'verifier'].includes(path.relative(directory, file).split(path.sep)[0]) && !file.split(path.sep).includes('__pycache__'));

// What these Python files import of model SDKs and HTTP clients: [{ file,
// module }], file relative to the kit.
function importsIn(directory, files) {
  return files.flatMap((file) => {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return []; }
    return importsOf(text).filter((module) => importsName(module, [...MODEL_SDKS, ...HTTP_CLIENTS]))
      .map((module) => ({ file: relativeOf(directory, file), module }));
  });
}

// The kit module an agent given as module:Class is imported from, or null
// when the kit holds none, such as for an agent Harbor ships.
function moduleFile(kit, agent) {
  const module = String(agent ?? '').split(':')[0];
  if (!/^[A-Za-z_][\w.]*$/.test(module)) return null;
  const parts = module.split('.');
  return [`${path.join(kit, ...parts)}.py`, path.join(kit, ...parts, '__init__.py')].find(isFile) ?? null;
}

// The adapter a package runs with: the agent its own harness.json names, or
// the kit's. A package's harness.json names only the agent, as module:Class;
// the model is the kit's or the confirmed run plan's. { agent, from: 'package'
// or 'kit', file }, file the kit module the agent is imported from, relative
// to the project, or null when the kit holds none; null when neither names an
// agent. fail reports what is wrong with the package's harness.json.
function packageAdapter(repo, directory, kit, fail = () => {}) {
  const file = path.join(directory, PACKAGE_HARNESS);
  const shown = (agent, from) => {
    const found = moduleFile(kit.directory, agent);
    return { agent, from, file: found ? relativeOf(repo, found) : null };
  };
  if (!existsSync(file)) return kit.agent ? shown(kit.agent, 'kit') : null;
  let own;
  try { own = readJSON(file); } catch (error) {
    fail(`harness.json cannot be read (${error.message}).`);
    return null;
  }
  if (!record(own) || !nonempty(own.agent) || Object.keys(own).some((key) => key !== 'agent')) {
    fail('harness.json of a package names only agent: the module:Class of the adapter this package runs with. The model is the kit\'s or the confirmed run plan\'s.');
  }
  if (!record(own) || !nonempty(own.agent)) return kit.agent ? shown(kit.agent, 'kit') : null;
  if (!/^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/.test(own.agent.trim())) fail(`harness.json: agent ${own.agent} is not module:Class, as Harbor imports an adapter.`);
  return shown(own.agent.trim(), 'package');
}

// The network_mode task.toml sets in its [environment] table, or null.
function taskNetwork(text) {
  let section = '';
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) { section = header[1].trim(); continue; }
    const match = section === 'environment' ? line.match(/^\s*network_mode\s*=\s*["']([^"']*)["']/) : null;
    if (match) return match[1];
  }
  return null;
}

// The steps task.toml declares, in the order Harbor runs them: the name of
// each [[steps]] entry, or of each table of an inline `steps = [...]`, null
// for an entry without a name. [] when it declares none.
function tomlSteps(text) {
  const names = [];
  // Where the line is: 'top' before any table, 'step' in a [[steps]] entry,
  // 'other' anywhere else, such as in [steps.agent] or [task].
  let place = 'top';
  const all = text.split(/\r?\n/);
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index];
    const array = line.match(/^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/);
    if (array) {
      place = array[1] === 'steps' ? 'step' : 'other';
      if (place === 'step') names.push(null);
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) { place = 'other'; continue; }
    if (place === 'step') {
      const match = line.match(/^\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
      if (match && names.at(-1) === null) names[names.length - 1] = match[1] ?? match[2];
      continue;
    }
    if (place !== 'top') continue;
    const inline = line.match(/^\s*steps\s*=\s*\[(.*)$/);
    if (!inline) continue;
    let body = inline[1];
    let depth = 1 + (body.match(/\[/g) ?? []).length - (body.match(/\]/g) ?? []).length;
    while (depth > 0 && index + 1 < all.length) {
      index += 1;
      body += `\n${all[index]}`;
      depth += (all[index].match(/\[/g) ?? []).length - (all[index].match(/\]/g) ?? []).length;
    }
    for (const table of body.matchAll(/\{([^{}]*)\}/g)) {
      const match = table[1].match(/(?:^|[\s,])name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
      names.push(match ? match[1] ?? match[2] : null);
    }
  }
  return names;
}

// The folders under a package's steps/, in name order.
const stepFolders = (directory) => {
  try {
    return readdirSync(path.join(directory, 'steps'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch { return []; }
};

// The steps of a package in the order Harbor runs them: those task.toml
// declares, or else the folders under steps/. [] for a package of one step.
// A run of a fixture passes them to the fixture agent as GENESIS_EDD_STEPS.
export function packageSteps(directory) {
  let text = '';
  try { text = readFileSync(path.join(directory, 'task.toml'), 'utf8'); } catch { /* none declared */ }
  const declared = tomlSteps(text).filter(Boolean);
  return declared.length ? [...new Set(declared)] : stepFolders(directory);
}

// A package's docker-compose.yaml, parsed as Compose reads it, merge keys
// included, or { error }. Compose's own tags, such as !reset, are not YAML's,
// so the parser's warnings about them are not shown.
function readCompose(file) {
  try { return { compose: parse(readFileSync(file, 'utf8'), { merge: true, logLevel: 'error' }) }; } catch (error) { return { error: error.message.split('\n')[0] }; }
}

// Whether a package is sealed: the evaluated program and every stand-in
// service run without access to outside networks, as Harbor 0.27 runs them.
// { value, reason, warning? }. Harbor merges the package's
// environment/docker-compose.yaml over its own and keeps the network settings
// written there. With network_mode no-network or allowlist in task.toml it
// puts every service that sets no network of its own behind its egress
// sidecar. Anything that cannot be read is not sealed. The network only
// applies at run time: an image still builds with network access.
export function sealedOf(directory) {
  const open = (reason) => ({ value: false, reason });
  let mode;
  try { mode = taskNetwork(readFileSync(path.join(directory, 'task.toml'), 'utf8')); } catch { return open('task.toml cannot be read'); }
  if (mode === 'allowlist') return open('task.toml sets network_mode = "allowlist", so the package reaches the hosts it allows');
  const sidecar = mode === 'no-network';
  const file = path.join(directory, 'environment/docker-compose.yaml');
  if (!existsSync(file)) {
    return sidecar
      ? { value: true, reason: 'task.toml sets network_mode = "no-network", so Harbor blocks outbound traffic with its egress sidecar, which needs kernel support Harbor checks when the run starts. An environment/docker-compose.yaml with `services: main: network_mode: none` seals the package without it' }
      : open(`there is no environment/docker-compose.yaml and task.toml sets network_mode = "${mode ?? 'public'}", so the program can reach outside networks`);
  }
  const { compose, error } = readCompose(file);
  if (error) return open(`environment/docker-compose.yaml cannot be parsed (${error})`);
  if (!record(compose)) return open('environment/docker-compose.yaml is not a YAML mapping');
  if (compose.include !== undefined) return open('environment/docker-compose.yaml includes other Compose files, whose network settings are not read here');
  const services = record(compose.services) ? compose.services : {};
  const networks = record(compose.networks) ? compose.networks : {};
  const internal = (id) => record(networks[id]) && networks[id].internal === true && !networks[id].external;
  // Harbor's own main service joins the default network unless the package
  // gives it settings of its own.
  const all = { ...(Object.hasOwn(services, 'main') ? {} : { main: {} }), ...services };
  // Services left to the egress sidecar, which then shares their network.
  const bare = [];
  for (const [id, service] of Object.entries(all)) {
    const own = record(service) ? service : {};
    if (own.network_mode !== undefined && own.network_mode !== null) {
      if (own.network_mode !== 'none') return open(`service ${id} has network_mode ${own.network_mode}`);
      continue;
    }
    const joined = Array.isArray(own.networks) ? own.networks.map(String) : record(own.networks) ? Object.keys(own.networks) : [];
    if (!joined.length) {
      if (own.extends !== undefined) return open(`service ${id} extends another service, whose network settings are not read here`);
      if (sidecar) { bare.push(id); continue; }
      if (!internal('default')) return open(`service ${id} sets no network, so it joins the default network, which is not declared internal: true`);
      continue;
    }
    const outside = joined.find((entry) => !internal(entry));
    if (outside !== undefined) return open(`service ${id} joins network ${outside}, which is not declared internal: true`);
  }
  const stands = bare.filter((id) => id !== 'main');
  return { value: true, reason: bare.length
    ? 'task.toml sets network_mode = "no-network", so Harbor blocks outbound traffic of the services that set no network of their own with its egress sidecar, and every other service has network_mode: none or joins only networks declared internal: true'
    : 'environment/docker-compose.yaml gives every service network_mode: none or only networks declared internal: true',
  ...(stands.length ? { warning: `task.toml sets network_mode = "no-network", so Harbor puts ${stands.join(', ')}, which ${stands.length === 1 ? 'sets' : 'set'} no network of ${stands.length === 1 ? 'its' : 'their'} own, behind its egress sidecar, and main cannot reach ${stands.length === 1 ? 'it' : 'them'} by name: the run most likely errors. A package sealed in environment/docker-compose.yaml keeps network_mode = "public" in task.toml` } : {}) };
}

// The packages that can reach outside networks but declare no live
// dependency, of those whose environment is written: rule V, which every
// checks confirmation holds them to. A package without a finished
// environment cannot run yet.
export const networkUndeclared = (cases) => cases.filter((item) => item.sealed?.value === false && !item.live
  && !(item.integration?.missing ?? []).includes('environment'));

// The network_undeclared message for those packages.
export function networkUndeclaredText(items) {
  const one = items.length === 1;
  return `${items.map((item) => `${item.id} (${item.sealed.reason})`).join('; ')}: ${one ? 'this package' : 'these packages'} can reach outside networks but ${one ? 'declares' : 'declare'} no live dependency, so a remote call nobody declared, a model's included, could pass by chance in a single attempt. A package holds to this rule when it is sealed, every service having network_mode: none or joining only networks declared internal: true, or when it declares the dependency live in tests/checks.json, which runs the user's number of attempts in the full tier. A judge that calls a model over the network falls under the same rule.`;
}

// Whether the adapter reported that an attempt used a model: any tokens or
// cost above zero. The light tier holds only for code that calls no model.
export const reportedModelUse = (attempt) => record(attempt?.usage)
  && ['cost_usd', 'n_input_tokens', 'n_cache_tokens', 'n_output_tokens'].some((key) => typeof attempt.usage[key] === 'number' && attempt.usage[key] > 0);

// The runs of a change as this machine's ledger knows them: every run.json
// under runs/, and for every run the run index lists whose run.json is gone
// or cannot be read, what its start entry recorded, marked lost when its
// folder is gone too and interrupted when the folder is still there.
function ledgerRuns(runsRoot) {
  if (!existsSync(runsRoot)) return [];
  const runs = new Map();
  for (const entry of readdirSync(runsRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    try {
      const run = readJSON(path.join(runsRoot, entry.name, 'run.json'));
      if (record(run) && nonempty(run.run_id)) runs.set(run.run_id, run);
    } catch { /* an index entry may stand in for it */ }
  }
  let index = { runs: new Map() };
  try { index = readRunIndex(runsRoot); } catch { /* no index */ }
  for (const [id, { start }] of index.runs) {
    if (runs.has(id) || !record(start)) continue;
    const present = existsSync(path.join(runsRoot, id));
    const code = record(start.code) ? (record(start.code.snapshot) ? start.code.snapshot : start.code) : null;
    runs.set(id, {
      run_id: id, started_at: start.at ?? null,
      spec_snapshot: { sha256: typeof start.spec === 'string' ? start.spec : start.spec?.sha256 ?? null },
      cases: (Array.isArray(start.cases) ? start.cases : []).map((item) => (typeof item === 'string' ? { id: item } : record(item) ? { id: item.id } : null)).filter((item) => nonempty(item?.id)),
      task_digest: record(start.task_digest) ? start.task_digest : {}, run_digest: record(start.run_digest) ? start.run_digest : {},
      code_snapshot: code, environment_ref: { agent: start.agent ?? null, model: start.model ?? null },
      execution_status: present ? 'interrupted' : 'lost', ...(present ? { interrupted: true } : { lost: true }),
    });
  }
  return [...runs.values()];
}

// What this machine's runs of a Spec export show of each package as it is
// now (samePackage): a gating check that passed in one run and failed in
// another on the same code, agent and model, a judge check counting as gating
// when the newest confirmation of this export made its line gating, as a run
// counts it; the runs whose adapter reported model use; and the runs the run
// index lists whose records are gone, which
// could have shown either. Any of these keeps the change out of the light
// tier until the package changes. Only attempts that completed count for the
// first, as for the failures of the same code; a run whose code or packages
// changed while it ran counts for neither. runs/ is not in Git, so this
// covers this machine only. [{ condition, package, ... , message }].
function ledgerReasons(repo, name, spec, cases) {
  const root = path.join(eddDirectory(repo, name), 'runs');
  if (!spec || !existsSync(root)) return [];
  const runs = ledgerRuns(root).filter((run) => run?.spec_snapshot?.sha256 === spec)
    .sort((a, b) => `${a.started_at}${a.run_id}`.localeCompare(`${b.started_at}${b.run_id}`));
  const reasons = [];
  // The judge lines the user made gating (judge_gating, `case:then` entries).
  // This key must stay equal to judgeKey in run.js: the package id, a colon
  // and the line folded by thenKey.
  const judgeKey = (id, then) => `${id}:${thenKey(String(then ?? ''))}`;
  const read = readConfirmation(repo, name);
  const latest = read.gap ? null : latestConfirmation(read.entries, spec);
  const judgeGating = new Set((Array.isArray(latest?.judge_gating) ? latest.judge_gating : []).map((entry) => {
    const at = String(entry).indexOf(':');
    return at > 0 ? judgeKey(String(entry).slice(0, at), String(entry).slice(at + 1)) : String(entry);
  }));
  for (const item of cases) {
    let declared = null;
    try { declared = readJSON(path.join(eddDirectory(repo, name), 'evals', item.id, 'tests/checks.json')); } catch { continue; }
    // A judge check is gating only when its line is in judge_gating; any other check by its role.
    const counted = (check) => (check.kind === JUDGE ? judgeGating.has(judgeKey(item.id, check.then)) : check.role === 'gating');
    const gating = new Set((Array.isArray(declared?.checks) ? declared.checks : []).filter((check) => record(check) && counted(check)).map((check) => check.id));
    const now = { task: item.task_digest ?? null, run: item.run_digest ?? null };
    const groups = new Map();
    const used = [];
    const lost = [];
    for (const run of runs) {
      if (!(run.cases ?? []).some((entry) => entry?.id === item.id)) continue;
      const recorded = digestsAt(run, item.id);
      // A lost run whose start entry kept no digests could have run this package.
      if (run.lost) {
        if (samePackage(recorded, now) || (!recorded.task && !recorded.run)) lost.push(run.run_id);
        continue;
      }
      if (!samePackage(recorded, now)) continue;
      const folder = path.join(root, run.run_id, item.id);
      let attempts = null;
      try { attempts = readJSON(path.join(folder, 'attempts.json')).attempts; } catch { /* a run recorded before attempts.json */ }
      if (Array.isArray(attempts) && attempts.some(reportedModelUse)) used.push(run.run_id);
      const settled = run.code_changed_during_run !== true && run.packages_changed_during_run !== true && ['completed', 'error'].includes(run.execution_status);
      const code = run.code_snapshot?.digest_of === 'content' ? run.code_snapshot.digest : null;
      if (!settled || !code) continue;
      let results = [];
      if (Array.isArray(attempts)) {
        results = attempts.filter((attempt) => attempt?.status === 'completed').flatMap((attempt) => Object.entries(attempt.results ?? {}));
      } else if ((run.cases ?? []).find((entry) => entry?.id === item.id)?.execution?.status === 'completed') {
        try { results = (readJSON(path.join(folder, 'check-results.json')).results ?? []).map((entry) => [entry?.id, entry?.result]); } catch { /* no evidence */ }
      }
      for (const [check, result] of results) {
        if (!gating.has(check) || !['pass', 'fail'].includes(result)) continue;
        const key = JSON.stringify([code, check, run.environment_ref?.agent ?? null, run.environment_ref?.model ?? null]);
        const group = groups.get(key) ?? { check, pass: new Set(), fail: new Set() };
        group[result].add(run.run_id);
        groups.set(key, group);
      }
    }
    const varied = [...groups.values()].filter((group) => group.pass.size && group.fail.size);
    if (varied.length) {
      const checks = [...new Set(varied.map((group) => group.check))].sort();
      const ran = [...new Set(varied.flatMap((group) => [...group.pass, ...group.fail]))].sort();
      reasons.push({ condition: 'unstable', package: item.id, checks, runs: ran,
        message: `${item.id}: ${checks.join(', ')} passed and failed on the same code with the package as it is now (${ran.join(', ')}), so its result is not fixed. This reads the runs of this machine; a changed package is judged again.` });
    }
    if (used.length) {
      reasons.push({ condition: 'model_use', package: item.id, runs: used,
        message: `${item.id}: the adapter reported model use (tokens or cost) in ${used.join(', ')} with the package as it is now, so its result can depend on a model. This reads the runs of this machine; a changed package is judged again.` });
    }
    if (lost.length) {
      reasons.push({ condition: 'lost_run', package: item.id, runs: lost,
        message: `${item.id}: the run index lists ${lost.join(', ')} with the package as it is now, and ${lost.length === 1 ? 'its folder is' : 'their folders are'} gone, so whether ${lost.length === 1 ? 'it' : 'they'} varied or reported model use cannot be read. This reads the runs of this machine; a changed package is judged again.` });
    }
  }
  return reasons;
}

// Whether the change can run in the light tier: { eligible, reasons }, with
// one reason for each condition it misses. The light tier holds no package
// with a live dependency, no model in harness.json or the run plan, only
// sealed packages, adapters that import no model SDK or HTTP client (the
// kit's modules, and the module a package's own harness.json names, which
// must be in the kit to be read), and, given the change's name and Spec
// export, no package as it is now that passed and failed on the same code,
// reported model use or lost its records in this machine's runs. One tier
// holds the whole change. model is the model the run plan names.
export function changeTier(repo, cases, model, { name = null, spec = null } = {}) {
  const reasons = [];
  if (!cases.length) reasons.push({ condition: 'packages', message: 'No eval packages yet.' });
  for (const item of cases.filter((entry) => entry.live)) {
    reasons.push({ condition: 'live', package: item.id, message: `${item.id} declares a live dependency, so its results can differ from one attempt to the next.` });
  }
  if (model) reasons.push({ condition: 'model', message: `The evaluated agent runs with model ${model}.` });
  for (const item of cases.filter((entry) => entry.sealed?.value === false)) {
    reasons.push({ condition: 'sealed', package: item.id, message: `${item.id} is not sealed: ${item.sealed.reason}.` });
  }
  const kit = kitDirectory(repo);
  const scanned = adapterFiles(kit);
  const imports = importsIn(kit, scanned);
  // A package's own adapter module, when it lies where the kit's scan does not reach.
  for (const item of cases.filter((entry) => entry.adapter?.from === 'package')) {
    if (!item.adapter.file) {
      reasons.push({ condition: 'adapter_unscanned', package: item.id, agent: item.adapter.agent,
        message: `${item.id} runs with adapter ${item.adapter.agent}, which its harness.json names and whose module is not in the kit, so what it imports cannot be read.` });
      continue;
    }
    const file = path.resolve(repo, item.adapter.file);
    if (!scanned.includes(file)) imports.push(...importsIn(kit, [file]));
  }
  const seen = new Set();
  for (const entry of imports) {
    const key = `${entry.file}\n${entry.module}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ condition: 'adapter_import', file: `.genesis/edd/harness/${entry.file}`, module: entry.module,
      message: `.genesis/edd/harness/${entry.file} imports ${entry.module}, a model SDK or HTTP client, so the adapter could call a model from the host, where the sealed network does not reach.` });
  }
  if (name && spec) reasons.push(...ledgerReasons(repo, name, spec, cases));
  return { eligible: !reasons.length, reasons };
}

// Whether a confirmed run plan holds the full tier because the user asked for
// it: with --tier full on that confirmation (tier_by flag), or on an earlier
// one of the same Spec export, kept since without another --tier (kept).
export const fullTierByUser = (plan) => plan?.tier === 'full' && (plan.tier_by === 'flag' || plan.tier_by === 'kept');

// The tier a change is proposed for: light when it qualifies, unless the user
// confirmed the full tier for this Spec export with --tier full, which stands
// until they say otherwise. latest is the newest confirmation of the export.
export const proposedTier = (eligible, latest) => (eligible && !fullTierByUser(latest?.run_plan) ? 'light' : 'full');

// The tier whose rules decide whether a package is ready: light only while the
// change qualifies for it, and then that of the newest confirmation of this
// Spec export while it covers the packages as they are, else the proposed one.
// Everything else is held to the full tier, whose rules are the stricter.
function readinessTier(repo, name, spec, cases, eligible) {
  if (!eligible) return 'full';
  const read = readConfirmation(repo, name);
  const latest = read.gap ? null : latestConfirmation(read.entries, spec);
  if (latest && samePackages(latest.packages, casesDigests(cases))) return latest.run_plan?.tier ?? 'full';
  return proposedTier(true, latest);
}

// Dependency manifests at the project root, and the model SDKs they may name.
const MANIFEST = /^(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|package\.json|requirements[\w.-]*\.txt)$/;
const MANIFEST_SDKS = ['openai', 'anthropic', 'google-generativeai', 'google-genai', 'google-cloud-aiplatform', 'mistralai', 'cohere', 'ollama', 'litellm',
  'langchain', 'langchain-core', 'langchain-openai', 'langchain-anthropic', 'langchain-community', 'llama-index', 'llama-index-core', 'groq', 'together',
  'replicate', 'huggingface-hub', 'transformers', 'dashscope', 'zhipuai', 'qianfan'];
const NPM_SDKS = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', '@mistralai/mistralai', 'cohere-ai', 'ollama', 'groq-sdk',
  'together-ai', 'replicate', 'langchain', 'llamaindex', 'ai'];
const NPM_PREFIXES = ['@langchain/', '@ai-sdk/'];
// Hosts of model APIs.
const MODEL_HOSTS = ['api.openai.com', 'openai.azure.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com',
  'bedrock-runtime', 'api.mistral.ai', 'api.cohere.ai', 'api.cohere.com', 'api.groq.com', 'openrouter.ai', 'api.together.xyz', 'api.together.ai',
  'api.deepseek.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn', 'api.moonshot.cn'];
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function manifestSdks(file, text) {
  if (file === 'package.json') {
    let manifest = null;
    try { manifest = JSON.parse(text); } catch { return []; }
    const names = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .flatMap((key) => (record(manifest?.[key]) ? Object.keys(manifest[key]) : []));
    return [...new Set(names.filter((entry) => NPM_SDKS.includes(entry) || NPM_PREFIXES.some((prefix) => entry.startsWith(prefix))))];
  }
  return MANIFEST_SDKS.filter((entry) => new RegExp(`(?:^|[\\s"'\\[,(])${escaped(entry)}(?=\\s*(?:$|[\\s"'=<>~!\\[\\],;:(]))`, 'im').test(text));
}

// Hints that a scenario's result could depend on a model, which never decide
// a tier or refuse anything: model SDKs in the project's dependency
// manifests, *_API_KEY names and model API hosts in the packages and the
// kit, and model SDKs the kit's Python files import. [{ kind (dependency,
// api_key, api_host or import), file, name }]. Read-only.
export function variabilitySignals(repo, name) {
  const signals = [];
  const seen = new Set();
  const add = (kind, file, value) => {
    const key = `${kind}\n${file}\n${value}`;
    if (!seen.has(key)) { seen.add(key); signals.push({ kind, file, name: value }); }
  };
  const shown = (file) => path.relative(repo, file).split(path.sep).join('/');
  let entries = [];
  try { entries = readdirSync(repo).filter((entry) => MANIFEST.test(entry)).sort(); } catch { /* no manifests */ }
  for (const entry of entries) {
    let text = '';
    try { text = readFileSync(path.join(repo, entry), 'utf8'); } catch { continue; }
    for (const sdk of manifestSdks(entry, text)) add('dependency', entry, sdk);
  }
  const kit = kitDirectory(repo);
  for (const file of [...ownFiles(kit), ...ownFiles(path.join(eddDirectory(repo, name), 'evals'))]) {
    if (file.split(path.sep).includes('__pycache__')) continue;
    let content;
    try { content = readFileSync(file); } catch { continue; }
    if (content.length > 512 * 1024 || content.includes(0)) continue;
    const text = content.toString('utf8');
    for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]*_API_KEY)\b/g)) add('api_key', shown(file), match[1]);
    for (const host of MODEL_HOSTS.filter((entry) => text.includes(entry))) add('api_host', shown(file), host);
    if (file.endsWith('.py') && within(kit, file)) for (const module of importsOf(text).filter((entry) => importsName(entry, MODEL_SDKS))) add('import', shown(file), module);
  }
  return signals;
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

const stemOf = (id) => id.replace(/^REQ-/, '').toLowerCase();
const scenariosOf = (handoff) => handoff.requirements.flatMap((requirement) =>
  requirement.scenarios.map((scenario, index) => ({
    case: `${stemOf(requirement.id)}-s${index + 1}`,
    requirement: requirement.id, requirement_name: requirement.name, statement: requirement.statement ?? '', state: requirement.state ?? null, ...scenario,
  })));
const scenarioKey = (scenario) => `${scenario?.requirement}\n${scenario?.name}`;
// A package is matched to its scenario by the requirement and name its
// checks.json gives.
const namesScenario = (checks) => record(checks?.scenario) && nonempty(checks.scenario.requirement) && nonempty(checks.scenario.name);

// The text of a scenario as a package is bound to it: its requirement's id,
// name and statement, and the scenario's name and every GIVEN, WHEN and THEN
// or AND line, each with its whitespace folded (thenKey), in order. Two Specs
// that give a scenario the same digest ask the same of it, so a package
// written for one holds for the other.
export function scenarioDigest(requirement, scenario) {
  const fold = (list) => (Array.isArray(list) ? list : []).map((line) => thenKey(String(line)));
  return digest(canonical({
    requirement: { id: requirement?.id ?? null, name: thenKey(String(requirement?.name ?? '')), statement: thenKey(String(requirement?.statement ?? '')) },
    scenario: { name: thenKey(String(scenario?.name ?? '')), given: fold(scenario?.given), when: fold(scenario?.when), then: fold(scenario?.then) },
  }));
}

// A scenario of a handoff by its requirement and name: { requirement,
// scenario } or null.
function findScenario(handoff, requirementId, name) {
  const requirement = (Array.isArray(handoff?.requirements) ? handoff.requirements : []).find((entry) => entry?.id === requirementId);
  const scenario = (Array.isArray(requirement?.scenarios) ? requirement.scenarios : []).find((entry) => entry?.name === name);
  return requirement && scenario ? { requirement, scenario } : null;
}

// The current Spec draft: a Spec that validates but is not exported, as the
// handoff its export would write, by the digest that export would have.
// { id, handoff, draft: true }, or null when the Spec is exported, its export
// was edited, or it does not validate.
function draftHandoff(repo, name, frozen) {
  if (frozen.handoff || frozen.gaps.some((gap) => gap?.code === 'handoff_invalid')) return null;
  // frozenSpec checks the export by digest only; the draft itself is read
  // and validated here.
  let validation = frozen.validation;
  if (!record(validation) || validation.checked === 'digest') {
    try { validation = validateSpec(repo, name); } catch { return null; }
  }
  const valid = validation?.valid ?? !(validation?.errors ?? ['unknown']).length;
  if (valid !== true || !Array.isArray(validation.specs) || !validation.specs.length) return null;
  try {
    const { id, handoff } = specHandoff(repo, name, validation);
    return Array.isArray(handoff?.requirements) ? { id, handoff, draft: true } : null;
  } catch { return null; }
}

// The Spec drafts packages were bound to, kept beside the change's packages
// under the digest their export would have, so `eval rebind` can read what a
// draft said once the Spec has moved on.
const draftFile = (repo, name, id) => path.join(eddDirectory(repo, name), 'spec-drafts', `${String(id).replace(/^sha256:/, '')}.json`);

// The handoff a binding names, read from the Spec's exports or the kept
// drafts, and only when its content still has that digest; or null.
function boundHandoff(repo, name, sha, draft) {
  const hex = String(sha ?? '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  let exported = null;
  try { exported = localPath(repo, `openspec/changes/${name}/handoffs/${hex}.json`); } catch { /* not readable here */ }
  const files = [exported, draftFile(repo, name, sha)].filter(Boolean);
  for (const file of draft ? files.reverse() : files) {
    let stored;
    try { stored = readJSON(file); } catch { continue; }
    if (!record(stored)) continue;
    const { id, ...payload } = stored;
    if (id === sha && digest(JSON.stringify(payload)) === sha && Array.isArray(payload.requirements)) return payload;
  }
  return null;
}

// The error a command throws when the Spec it needs is not there: the gaps
// of the Spec, passed on without fields that named a skill or a command.
function specBlocked(gaps, needs = 'the current exported Spec') {
  const shown = gaps.map((gap) => passedOn(gap));
  return Object.assign(new Error(`This needs ${needs}: ${shown.map((gap) => gap.message).join('; ') || 'there is none'}`), { code: 'SPEC_INPUT_BLOCKED', gaps: shown });
}

// Each scenario of the Spec with the folders of the packages whose
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
// place may now belong to a scenario inserted before that one.
export function unnamedPackages(repo, name) {
  return readCases(path.join(eddDirectory(repo, name), 'evals')).filter((item) => !namesScenario(item.checks)).map((item) => item.id);
}

// What is wrong with those folders: { problem, repair }, both facts.
export function unnamedMessage(ids) {
  const one = ids.length === 1;
  return {
    problem: `${ids.join(', ')}: tests/checks.json cannot be read or names no scenario, so which scenario ${one ? 'this folder was' : 'these folders were'} written for cannot be told, and \`eval new\` writes no package for a scenario of the same requirement, which could duplicate ${one ? 'it' : 'one'}.`,
    repair: `A tests/checks.json that names its scenario's requirement and name makes ${one ? 'the folder' : 'a folder'} a package again; a folder that is not a package can be deleted. \`eval validate\` reports what is wrong with ${one ? 'it' : 'each one'} as case_invalid.`,
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
// writes, unless a folder whose checks.json names no scenario may be theirs.
export function unpackagedScenarios(repo, name, handoff) {
  return packagesOf(path.join(eddDirectory(repo, name), 'evals'), handoff).filter((item) => !item.packages.length)
    .map((item) => ({ requirement: item.requirement, name: item.name }));
}

// The current frozen Spec, or the error whose gaps keep later stages from
// using it. stage is no longer read; it is kept for callers that pass it.
export function requireSpec(repo, name, stage = null) {
  const { gaps, handoff } = frozenSpec(repo, name);
  if (gaps.length) throw specBlocked(gaps);
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

// A new package is sealed: its program runs without network access, so no
// remote service, a model included, decides its result. task.toml stays
// public, since Harbor's egress sidecar would take over every service without
// network settings of its own.
const sealedCompose = `# The evaluated program runs without network access, so no remote service,
# a model included, can decide its result. Add environment/Dockerfile, or a
# build for main, to make the environment. With stand-in services, give every
# service only networks declared internal: true instead of network_mode: none,
# so main reaches them by name and nothing reaches outside networks.
services:
  main:
    network_mode: none
`;

const instruction = (item) => `<!-- ${TEMPLATE_MARK}: replace this file with the exact input the evaluated agent receives.
Trigger this scenario; do not mention checks, expected results or scoring.

${[...item.given.map((line) => `GIVEN ${line}`), ...item.when.map((line) => `WHEN ${line}`)].join('\n')}
-->
`;

// The headings of a package's Task.md, which eval validate names when a
// package that declares a dependency has none: eval new writes none.
const TASK_HEADINGS = [
  'Trigger (how this package makes the scenario happen, and how the verifier knows it did)',
  'Environment (what is live, frozen or simulated here, and how that differs from production)',
  'Evidence (what each check reads; never the agent\'s own claim of an effect other than its reply)',
  'Choices made here (technical choices the Spec does not state; a choice that changes what the business accepts belongs in the Spec)',
  'Not covered',
];

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
# independent evidence (final state, service records, a recorded reply), never
# the agent's own claim of another effect.
. "$(dirname "$0")/genesis.sh"

# --- project checks ---
${checks.map((check) => `gate ${check.id} unknown "not implemented: ${check.expect.replace(/["\\$`]/g, '')}"`).join('\n')}
# --- end project checks ---

finish
`;

// Writes the shipped helper and a copy of the kit's verifier/ folder into a
// package's tests/.
function writeShared(directory, kit) {
  const tests = path.join(directory, 'tests');
  mkdirSync(tests, { recursive: true });
  writeFileSync(path.join(tests, 'genesis.sh'), HELPER);
  const target = path.join(tests, 'shared');
  rmSync(target, { recursive: true, force: true });
  const shared = path.join(kit, 'verifier');
  if (existsSync(shared)) cpSync(shared, target, { recursive: true });
}

// One package per scenario of the Spec that has none yet. What an existing
// package owns is never rewritten, the shipped helper and the kit's shared
// verifier code included: `eval sync` brings those in line, and out_of_line
// names the packages where they differ. A folder whose checks.json names no
// scenario may be the package of a scenario of the requirement its name
// starts with, so no package is written for that requirement's scenarios;
// skipped lists them with the folders, and every other scenario gets its
// package. With draft, when the Spec validates but is not exported, the new
// packages are bound to the draft by the digest its export would have, and
// the draft is kept under spec-drafts/: such a package can be validated and
// proved, never confirmed, baselined or run, until `eval rebind` binds it to
// an export. When the Spec is exported, draft changes nothing.
export function newEval(repo, name, options = {}) {
  const frozen = frozenSpec(repo, name);
  const warnings = [];
  let source = frozen.handoff ? { id: frozen.handoff.id, handoff: frozen.handoff.handoff, draft: false } : null;
  if (!source && options.draft === true) {
    source = draftHandoff(repo, name, frozen);
    if (!source) {
      const structural = frozen.gaps.filter((gap) => gap?.kind !== 'business' && gap?.code !== 'handoff_missing');
      throw specBlocked(structural.length ? structural : frozen.gaps, 'a Spec that validates');
    }
  }
  if (!source) throw specBlocked(frozen.gaps);
  if (options.draft === true && !source.draft) warnings.push('The Spec is exported as it is, so the new packages are bound to that export, not to a draft.');
  const root = path.join(eddDirectory(repo, name), 'evals');
  const unnamed = unnamedPackages(repo, name);
  // The folders whose checks.json names no scenario, by the requirement their name starts with.
  const unclaimed = new Map();
  for (const id of unnamed) {
    const stem = id.match(/^(.*)-s\d+$/)?.[1];
    if (stem) unclaimed.set(stem, [...(unclaimed.get(stem) ?? []), id]);
  }
  const plan = packagesOf(root, source.handoff);
  const kit = kitDirectory(repo);
  mkdirSync(kit, { recursive: true });
  if (!existsSync(path.join(kit, 'PROJECT.md'))) writeFileSync(path.join(kit, 'PROJECT.md'), projectNotes);
  const created = [];
  const kept = [];
  const skipped = [];
  for (const scenario of plan) {
    if (scenario.packages.length) { kept.push(...scenario.packages); continue; }
    const folders = unclaimed.get(stemOf(scenario.requirement)) ?? [];
    if (folders.length) { skipped.push({ requirement: scenario.requirement, name: scenario.name, folders }); continue; }
    const item = { ...scenario, case: freeCase(root, scenario.case) };
    const directory = path.join(root, item.case);
    // One check per THEN or AND line: then names the line, and expect starts
    // as its text until the author makes it concrete.
    const checks = item.then.map((line, index) => ({ id: `c${index + 1}`, intent: item.requirement, then: line, expect: line, role: 'gating' }));
    mkdirSync(path.join(directory, 'tests'), { recursive: true });
    mkdirSync(path.join(directory, 'environment'), { recursive: true });
    writeFileSync(path.join(directory, 'task.toml'), taskToml(name, item), { flag: 'wx' });
    writeFileSync(path.join(directory, 'environment/docker-compose.yaml'), sealedCompose, { flag: 'wx' });
    writeFileSync(path.join(directory, 'instruction.md'), instruction(item), { flag: 'wx' });
    writeShared(directory, kit);
    writeFileSync(path.join(directory, 'tests/test.sh'), testScript(checks), { flag: 'wx' });
    chmodSync(path.join(directory, 'tests/test.sh'), 0o755);
    writeJSON(path.join(directory, 'tests/checks.json'), {
      schema_version: '1.1', status: 'confirmed',
      spec_ref: { id: name, sha256: source.id, ...(source.draft ? { draft: true } : {}),
        scenario_sha256: scenarioDigest({ id: item.requirement, name: item.requirement_name, statement: item.statement }, item) },
      scenario: { requirement: item.requirement, name: item.name, manual: [] },
      dependencies: [],
      checks,
      fixtures: [],
    });
    created.push(item.case);
  }
  if (source.draft && created.length && !existsSync(draftFile(repo, name, source.id))) writeJSON(draftFile(repo, name, source.id), source.handoff);
  const outOfLine = [...new Set(sharedCodeMismatches(repo, name, kept).map((entry) => entry.case))];
  const ignored = ignoredArtifacts(repo, name).warning;
  if (ignored) warnings.push(ignored);
  return {
    change: name, spec: source.id, draft: source.draft, directory: root, kit, created, kept, skipped, unreadable: unnamed, out_of_line: outOfLine, warnings,
    note: `Each new package has one gating check per THEN or AND line, whose then names the line and whose expect starts as its text. Its environment/docker-compose.yaml gives main network_mode: none, so it is sealed, and its environment is finished once environment/Dockerfile or a build for main is added. No Task.md is written.${source.draft ? ' The new packages are bound to the Spec draft: they can be validated and proved, and nothing confirms, baselines or runs them until they are bound to an export.' : ''}`,
    suggestion: { command: ['eval', 'validate', name, '--repo', repo], why: 'lists what each package still needs before it can run' },
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

// Where the code a package shares with every other one differs from the
// shipped copies: tests/genesis.sh against the helper this release ships,
// tests/shared/ against the kit's verifier/ folder, and any genesis.sh or
// shared/ under a step's tests/, which Harbor lays over tests/ for that step.
// [{ case, file, expected, actual }]: file relative to the package, expected
// and actual its digests, null where there should be no file or is none.
// Read-only.
export function sharedCodeMismatches(repo, name, ids) {
  const root = path.join(eddDirectory(repo, name), 'evals');
  const verifier = path.join(kitDirectory(repo), 'verifier');
  const read = (file) => { try { return digest(readFileSync(file)); } catch { return null; } };
  const byFile = (directory) => Object.fromEntries(ownFiles(directory).map((file) => [relativeOf(directory, file), read(file)]));
  const shipped = digest(HELPER);
  const kit = byFile(verifier);
  const found = [];
  for (const id of ids ?? []) {
    const directory = path.join(root, id);
    const helper = read(path.join(directory, 'tests/genesis.sh'));
    if (helper !== shipped) found.push({ case: id, file: 'tests/genesis.sh', expected: shipped, actual: helper });
    const own = byFile(path.join(directory, 'tests/shared'));
    for (const file of [...new Set([...Object.keys(kit), ...Object.keys(own)])].sort()) {
      if (kit[file] !== own[file]) found.push({ case: id, file: `tests/shared/${file}`, expected: kit[file] ?? null, actual: own[file] ?? null });
    }
    for (const step of stepFolders(directory)) {
      const tests = path.join(directory, 'steps', step, 'tests');
      for (const file of ownFiles(tests)) {
        const relative = relativeOf(tests, file);
        if (relative === 'genesis.sh' || relative.startsWith('shared/')) found.push({ case: id, file: `steps/${step}/tests/${relative}`, expected: null, actual: read(file) });
      }
    }
  }
  return found;
}

// Brings the code packages share in line, explicitly: for each package, or
// those cases names, writes the shipped helper to tests/genesis.sh and the
// kit's verifier/ folder to tests/shared/ where they differ, and removes a
// genesis.sh or shared/ under a step's tests/, which would stand in for them
// in that step. Each package written changes, its run digest included, so a
// confirmation or a loop sees a changed package. { change, written: [{ case,
// files, removed, run_digest: { from, to } }], unchanged }.
export function syncEval(repo, name, options = {}) {
  const root = path.join(eddDirectory(repo, name), 'evals');
  const items = readCases(root);
  const wanted = options.cases === undefined || options.cases === null ? null : [options.cases].flat().filter(nonempty);
  const unknown = (wanted ?? []).filter((id) => !items.some((item) => item.id === id));
  if (unknown.length) throw new Error(`No package named ${unknown.join(', ')}.`);
  const chosen = items.filter((item) => !wanted || wanted.includes(item.id));
  const kitDir = kitDirectory(repo);
  const written = [];
  const unchanged = [];
  for (const item of chosen) {
    const mismatches = sharedCodeMismatches(repo, name, [item.id]);
    if (!mismatches.length) { unchanged.push(item.id); continue; }
    const before = runDigest(item.directory, readKit(repo));
    const files = [];
    const removed = [];
    if (mismatches.some((entry) => entry.file === 'tests/genesis.sh' || entry.file.startsWith('tests/shared/'))) {
      writeShared(item.directory, kitDir);
      files.push(...mismatches.filter((entry) => entry.file === 'tests/genesis.sh' || entry.file.startsWith('tests/shared/')).map((entry) => entry.file));
    }
    for (const entry of mismatches.filter((found) => found.file.startsWith('steps/'))) {
      const [, step] = entry.file.split('/');
      const tests = path.join(item.directory, 'steps', step, 'tests');
      rmSync(path.join(tests, 'genesis.sh'), { force: true });
      rmSync(path.join(tests, 'shared'), { recursive: true, force: true });
      removed.push(entry.file);
    }
    written.push({ case: item.id, files, removed, run_digest: { from: before, to: runDigest(item.directory, readKit(repo)) } });
  }
  return {
    change: name, written, unchanged,
    note: written.length ? 'A package written here is a changed package: its run digest is new, so a confirmation or a loop that covered it no longer does.' : 'Every package already holds the shipped helper and the kit\'s verifier code.',
    suggestion: written.length ? { command: ['eval', 'validate', name, '--repo', repo], why: 'shows each package as it is now' } : null,
  };
}

// Why a package bound to an older export or a draft cannot be re-bound to
// the current export: its requirement text or the GIVEN, WHEN and THEN lines
// of its scenario differ from those of the Spec it was bound to, or a line
// one of its checks, its then_groups, its scenario.manual or its fixtures
// names is no THEN or AND line of the current scenario. [] when it can.
// basis says what the old scenario was read from.
function rebindCheck(repo, name, item, from, current) {
  const reasons = [];
  const checks = item.checks;
  const ref = record(checks.spec_ref) ? checks.spec_ref : {};
  if (ref.id !== name) reasons.push(`spec_ref names change ${ref.id ?? 'none'}, not ${name}`);
  if (!from.sha256) reasons.push('spec_ref names no Spec');
  if (checks.schema_version !== '1.1') reasons.push('it uses checks.json 1.0, whose checks name no THEN line, so its lines cannot be checked against the current export');
  const { requirement: requirementId, name: scenarioName } = checks.scenario;
  const now = findScenario(current.handoff, requirementId, scenarioName);
  if (!now) return { reasons: [...reasons, `the current export has no scenario "${scenarioName}" of ${requirementId}`], basis: null, digest: null };
  if (now.requirement.state === 'proposed') reasons.push(`${requirementId} is proposed in the current export, and a proposed requirement never becomes a check`);
  const nowDigest = scenarioDigest(now.requirement, now.scenario);
  let was = null;
  let basis = null;
  const old = from.sha256 ? boundHandoff(repo, name, from.sha256, from.draft === true) : null;
  if (old) {
    const found = findScenario(old, requirementId, scenarioName);
    if (!found) reasons.push(`the Spec it is bound to (${short(from.sha256)}) has no scenario "${scenarioName}" of ${requirementId}`);
    else { was = scenarioDigest(found.requirement, found.scenario); basis = from.draft ? 'kept_draft' : 'export'; }
  } else if (from.sha256 && nonempty(ref.scenario_sha256)) {
    // Neither the export nor a kept draft with that digest is here: the
    // package's own record of its scenario is all there is, and the rebound
    // record says so.
    was = ref.scenario_sha256;
    basis = 'recorded_digest';
  } else if (from.sha256) {
    reasons.push(`the Spec it is bound to (${short(from.sha256)}) cannot be read: neither an export nor a kept draft with that digest is in this project, and spec_ref records no scenario_sha256`);
  }
  if (was !== null && was !== nowDigest) reasons.push(`the requirement text or the GIVEN, WHEN, THEN or AND lines of scenario "${scenarioName}" differ from those of ${short(from.sha256)}`);
  const linesNow = new Set((now.scenario.then ?? []).map((line) => thenKey(String(line))));
  const list = (value) => (Array.isArray(value) ? value : []);
  const named = [
    ...list(checks.checks).flatMap((check) => [...(nonempty(check?.then) ? [check.then] : []), ...list(check?.then_group).filter(nonempty)]),
    ...list(checks.scenario.manual).map((entry) => entry?.then).filter(nonempty),
    ...list(checks.fixtures).map((fixture) => fixture?.then).filter(nonempty),
  ];
  const missing = [...new Set(named.filter((text) => !linesNow.has(thenKey(text))))];
  if (missing.length) reasons.push(`${missing.map((text) => `"${text}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} no THEN or AND line of the scenario in the current export`);
  return { reasons, basis, digest: nowDigest };
}

// After a new export, binds each package written for an older export or a
// Spec draft to the current export when its scenario asks the same:
// rebindCheck compares the requirement text and every GIVEN, WHEN, THEN and
// AND line of its scenario, scenario.manual's lines included, with the
// current export, and checks every line a check, a then_group, scenario.manual
// or a fixture names against it again. A package that passes has spec_ref set
// to the current export and a rebound entry added to its checks.json: { from,
// to, at, basis }. A package that does not stays as it is and is listed with
// why. Its proofs and its reviewer's verdicts do not rest on spec_ref
// (boundFree), so a re-bound package keeps them; its task and run digests
// change. { change, spec, rebound, stale, current, unreadable }.
export function rebindEval(repo, name) {
  const frozen = frozenSpec(repo, name);
  if (!frozen.handoff) throw specBlocked(frozen.gaps);
  const current = { id: frozen.handoff.id, handoff: frozen.handoff.handoff };
  const root = path.join(eddDirectory(repo, name), 'evals');
  const at = new Date().toISOString();
  const result = { rebound: [], stale: [], current: [], unreadable: [] };
  for (const item of readCases(root)) {
    if (!record(item.checks) || !namesScenario(item.checks)) { result.unreadable.push(item.id); continue; }
    const ref = record(item.checks.spec_ref) ? item.checks.spec_ref : {};
    const from = { sha256: nonempty(ref.sha256) ? ref.sha256 : null, ...(ref.draft === true ? { draft: true } : {}) };
    if (from.sha256 === current.id && ref.draft !== true) { result.current.push(item.id); continue; }
    const { reasons, basis, digest: scenario } = rebindCheck(repo, name, item, from, current);
    if (reasons.length) { result.stale.push({ case: item.id, from, reasons }); continue; }
    const entry = { from, to: current.id, at, basis };
    const next = { ...item.checks, spec_ref: { id: name, sha256: current.id, scenario_sha256: scenario },
      rebound: [...(Array.isArray(item.checks.rebound) ? item.checks.rebound : []), entry] };
    writeFileSync(path.join(item.directory, 'tests/checks.json'), `${JSON.stringify(next, null, 2)}\n`);
    result.rebound.push({ case: item.id, ...entry });
  }
  return {
    change: name, spec: current.id, ...result,
    note: 'A re-bound package keeps its proofs and its reviewer\'s verdicts, which do not rest on the export it is bound to. Its task and run digests change, and the user confirms the checks of this export as of any other.',
    suggestion: result.stale.length || result.rebound.length ? { command: ['eval', 'validate', name, '--repo', repo], why: 'shows each package against the current export' } : null,
  };
}

// Content identity of a package: runs compare results only between equal
// packages. The kit is part of it, because a changed adapter or stand-in
// changes what a run measures. Task.md is prose and is left out.
const taskDigest = (directory, kit) => digest([...lines(directory, executed(directory, 'Task.md')), ...kit.lines].join('\n'));

// What a run executes of a package: the task digest without the fixtures
// (runLines). Two runs, a loop and its packages, and the failures counted for
// the same code compare this, so a reviewer's counterexample added to a
// package keeps it the same package.
const runDigest = (directory, kit) => digest([...runLines(directory), ...kit.lines].join('\n'));

// What the fixtures of `eval check` are proved for: every file of the package
// and the kit, checks.json without its binding to a Spec (boundFree), but
// harness.json and the adapter modules at the kit's root (adapterOnly) and the
// package's own harness.json, which no fixture runs; a module an environment
// file reaches stays (kept). An edit to the adapter alone, or a re-binding,
// keeps the proof.
const proofDigest = (directory, kit, kept) => digest([...packageLines(directory, { fixtures: true, form: 'proof' }), ...kitProofLines(kit, kept)].join('\n'));

// What the probe of `eval check` is proved for besides the run digest: the
// proof digest without the fixtures, which the probe's nop agent never runs
// either. A fixture's own proof rests on it and on the fixture
// (fixtureDigest).
const probeDigest = (directory, kit, kept) => digest([...packageLines(directory, { fixtures: false, form: 'proof' }), ...kitProofLines(kit, kept)].join('\n'));

// What a package checks: checks.json without its fixtures and its binding to
// a Spec, every other file of tests/ and of each step's tests/ but the
// fixtures (test.sh, the shipped helper, tests/shared/, code tests and judges),
// and the kit's verifier/ folder. A reviewer's verdict on a line rests on
// these, so `eval review` keeps it while they stay as they were, also when the
// adapter, the environment, the input or the export the package is bound to
// changed.
function checkDigest(directory, kit) {
  const inTests = (relative) => /^(?:steps\/[^/]+\/)?tests\//.test(relative) && !/^(?:steps\/[^/]+\/)?tests\/fixtures\//.test(relative);
  const own = executed(directory, 'Task.md').flatMap((file) => {
    const relative = relativeOf(directory, file);
    if (!inTests(relative)) return [];
    const content = readFileSync(file);
    const form = /(?:^|\/)tests\/checks\.json$/.test(relative) ? boundFree(content.toString('utf8'), { fixtures: false }) : null;
    return [`${relative}\n${digest(form ?? content)}`];
  });
  return digest([...own, ...kit.verifier.map((line) => `kit/verifier/${line}`)].join('\n'));
}

// The code patch of a fixture, which a code test must fail on: the path
// fixture.patch gives, under tests/fixtures/, or tests/fixtures/NAME.patch,
// or tests/fixtures/NAME/code.patch; null when there is none.
export function fixturePatch(directory, fixture) {
  const base = path.join(directory, 'tests/fixtures');
  const candidates = [
    ...(nonempty(fixture?.patch) ? [path.resolve(directory, fixture.patch)] : []),
    path.join(base, `${fixture?.name}.patch`),
    path.join(base, String(fixture?.name), 'code.patch'),
  ];
  return candidates.find((file) => within(base, file) && isFile(file)) ?? null;
}

// What one fixture is: its script, its code patch, the scripts of its steps
// under tests/fixtures/NAME/, the results it expects and its kind. Its proof
// holds while this and the probe digest of the package stay as they were, so
// a fixture added or changed since, such as a reviewer's counterexample, runs
// alone. The case summary lists it by fixture (fixture_digests).
export function fixtureDigest(directory, fixture) {
  const base = path.join(directory, 'tests/fixtures');
  const read = (file) => { try { return digest(readFileSync(file)); } catch { return null; } };
  const script = read(path.join(base, `${fixture.name}.sh`));
  const patch = read(nonempty(fixture.patch) ? path.resolve(directory, fixture.patch) : path.join(base, `${fixture.name}.patch`));
  let steps = [];
  try {
    steps = readdirSync(path.join(base, fixture.name)).sort().map((file) => {
      try { return `${file}\n${digest(readFileSync(path.join(base, fixture.name, file)))}`; } catch { return file; }
    });
  } catch { /* one script for the package */ }
  const expect = Object.fromEntries(Object.entries(fixture.expect ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return digest(JSON.stringify({ script, patch, steps, expect, kind: fixture.kind ?? null }));
}

// Whether the last `eval check` of a package proved its fixtures for the
// package as it is: by the proof digest when both sides have one, else by the
// task digest, which covers every file. item is the package as eval validate
// lists it.
export const fixturesProvedFor = (last, item) => (nonempty(last?.proof_digest) && nonempty(item?.proof_digest)
  ? last.proof_digest === item.proof_digest : Boolean(last) && last.task_digest === item?.task_digest);

// What a run executes of the evals: every file of each package and of the
// kit by its digest, and each package's task digest and run digest, the ones
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
    run_digest: Object.fromEntries(items.map((item) => [item.id, runDigest(item.directory, kit)])),
    // What each package checks (checkDigest), which a reviewer's verdicts rest on.
    check_digest: Object.fromEntries(items.map((item) => [item.id, checkDigest(item.directory, kit)])),
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
// The formats of a confirmation entry this release reads. 1.1 adds the tier
// of the run plan and a budget in run minutes; a 1.0 entry is of the full
// tier and keeps its wall-clock minutes.
const CONFIRMATION_VERSIONS = ['1.0', '1.1'];
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
  const unreadable = (why) => ({ ...none, gap: gapOf('confirmation_unreadable', 'confirmation', 'agent', 'artifact',
    `${shown} cannot be read (${why}). It holds the user's checks confirmation, which Git keeps.`, { path: shown }) });
  let stored;
  try { stored = readJSON(file); } catch (error) { return unreadable(error.message); }
  if (!record(stored)) return unreadable('it is not a JSON object');
  const { earlier, ...top } = stored;
  const entries = [top, ...[...(Array.isArray(earlier) ? earlier : [])].reverse()];
  // An entry of a format this release does not know was written by a newer
  // one, whose rules may be stricter: it is neither read nor rewritten.
  const unknown = entries.find((entry) => record(entry) && !CONFIRMATION_VERSIONS.includes(entry.schema_version));
  if (unknown) {
    return { ...none, gap: gapOf('confirmation_newer', 'confirmation', 'agent', 'technical',
      `${shown} holds a confirmation with schema_version ${JSON.stringify(unknown.schema_version ?? null)}, which this release of genesis-edd does not know: a newer release wrote it. This release neither reads nor rewrites the file.`,
      { path: shown, schema_version: unknown.schema_version ?? null }) };
  }
  const broken = entries.find((entry) => !record(entry) || entry.id !== confirmationId(entry));
  return { file, record: stored, entries,
    gap: broken === undefined ? null : gapOf('confirmation_invalid', 'confirmation', 'agent', 'artifact',
      `${shown} was edited by hand: the id of the entry of ${record(broken) ? broken.confirmed?.at ?? 'unknown date' : 'unknown date'} no longer matches its content.`, { path: shown }) };
}

// The newest confirmation of a Spec export, or null.
export const latestConfirmation = (entries, spec) => entries.find((entry) => entry?.spec?.sha256 === spec) ?? null;

// Whether the packages of a confirmation entry are those of a record that
// keeps its digests by package: the same ids, each the same package
// (samePackage).
const samePackages = (packages, holder) => {
  const ids = Object.keys(packages ?? {});
  return ids.length === Object.keys(holder?.task_digest ?? {}).length
    && ids.every((id) => Object.hasOwn(holder.task_digest, id) && samePackage({ task: packages[id]?.task_digest ?? null, run: packages[id]?.run_digest ?? null }, digestsAt(holder, id)));
};

// The newest confirmation of a Spec export whose packages are those of a
// record that keeps its digests by package, such as a run, or null.
export const confirmationOf = (entries, spec, holder) => entries.find((entry) => entry?.spec?.sha256 === spec && samePackages(entry.packages, holder)) ?? null;

// The confirmation entry with this id, or null.
export const confirmationById = (entries, id) => (id ? entries.find((entry) => entry?.id === id) ?? null : null);

// How the packages as an eval snapshot has them differ from a confirmation:
// { matches, spec_differs, packages: [{ id, change: changed, added or removed,
// files }], kit: [files] }. matches is true when the confirmation is of this
// Spec export and every package is the one confirmed (samePackage): a
// fixture added since keeps it.
export function confirmationMatch(entry, snapshot, spec) {
  const confirmed = { packages: Object.fromEntries(Object.entries(entry?.packages ?? {}).map(([id, item]) => [id, item?.files ?? {}])), kit: entry?.kit?.files ?? {} };
  const files = evalFilesChanged(confirmed, snapshot);
  const ids = [...new Set([...Object.keys(entry?.packages ?? {}), ...Object.keys(snapshot.task_digest)])].sort();
  const packages = ids.flatMap((id) => {
    const was = entry?.packages?.[id];
    const now = snapshot.task_digest[id];
    if (was && now !== undefined && samePackage({ task: was.task_digest ?? null, run: was.run_digest ?? null }, digestsAt(snapshot, id))) return [];
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
// no confirmation of this Spec export covers the packages as they are, or
// null. The user's decision; name, when given, adds the file's path.
export function unconfirmedGap(entries, spec, snapshot, { name = null } = {}) {
  const where = name ? { path: `.genesis/edd/${name}/confirmed.json` } : {};
  const gap = (message, facts = {}) => gapOf('checks_unconfirmed', 'confirmation', 'user', 'business', message, { ...where, ...facts });
  const latest = latestConfirmation(entries, spec);
  if (!latest) {
    return entries.length
      ? gap(`The latest checks confirmation is of another Spec export (${short(entries[0]?.spec?.sha256)}); none is of this one (${short(spec)}). Only the user confirms the checks.`, { confirmed_spec: entries[0]?.spec?.sha256 ?? null })
      : gap('The user has not confirmed the checks of this Spec export. Only the user confirms them; a loop runs only on checks the user confirmed.');
  }
  const match = confirmationMatch(latest, snapshot, spec);
  if (match.matches) return null;
  const ids = match.packages.map((entry) => entry.id);
  return gap(`${ids.join(', ')} changed since the user confirmed the checks (${named(matchFiles(match))}). A loop runs only on the checks the user confirmed, so the revision is the user's to confirm.`,
    { cases: ids, files: matchFiles(match) });
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
  return { ...read, snapshot, latest, match, current: match?.matches ? latest : null, unconfirmed: read.gap ? null : unconfirmedGap(read.entries, spec, snapshot, { name }) };
}

// The folder under checks/<case>/ that holds the probe of `eval check`. A
// fixture's name is kebab-case, so it never takes this one.
export const PROBE_FOLDER = '_probe';

// The last `eval check` record of a package, checks/<case>/check.json, or null.
export function readCheckRecord(repo, name, id) {
  try {
    const last = readJSON(path.join(eddDirectory(repo, name), 'checks', id, 'check.json'));
    return record(last) ? last : null;
  } catch { return null; }
}

// Whether every fixture of a check record got the result it expects.
const fixturesPassed = (last) => (Array.isArray(last?.fixtures) ? last.fixtures.every((entry) => entry?.ok === true) : last?.passed === true);

// Why the fixtures of the last `eval check` do not prove a package as it is,
// or null: they are proved by proof digest, which covers every file but the
// adapter (fixturesProvedFor), or, for a record written before it, by task
// digest.
function fixtureStale(last, item) {
  if (!last) return 'it has not run';
  if (!fixturesProvedFor(last, item)) return fixturesMoved(last, item) ?? 'the package or the kit changed since it last ran';
  return fixturesPassed(last) ? null : `its last run did not prove ${(last.fixtures ?? []).filter((entry) => !entry?.ok).map((entry) => entry?.name).join(', ')}`;
}

// Why the fixtures do not prove a package when only fixtures moved since the
// last `eval check`, or null: the package without its fixtures is the one
// that check proved (probe digest), so `eval check` keeps every fixture that
// passed with its own digest unchanged and runs only the others.
function fixturesMoved(last, item) {
  const probe = item?.probe_digest;
  const was = Array.isArray(last?.fixtures) ? last.fixtures.filter(record) : null;
  if (!nonempty(probe) || !was || was.some((entry) => !nonempty(entry.fixture_digest))
    || !(last.probe?.probe_digest === probe || was.some((entry) => entry.package_digest === probe))) return null;
  const digests = record(item.fixture_digests) ? item.fixture_digests : {};
  const same = (fixture) => was.find((entry) => entry.name === fixture && entry.fixture_digest === digests[fixture]);
  const fresh = Object.keys(digests).filter((fixture) => !same(fixture));
  const failed = Object.keys(digests).filter((fixture) => same(fixture) && same(fixture).ok !== true);
  // A fixture kept as it was, but proved for another version of the package,
  // runs again for more than the fixtures.
  if (Object.keys(digests).some((fixture) => same(fixture) && same(fixture).package_digest !== probe)) return null;
  const gone = was.map((entry) => entry.name).filter((fixture) => !Object.hasOwn(digests, fixture));
  const names = (list, one, many) => `${list.length === 1 ? 'fixture' : 'fixtures'} ${list.join(', ')} ${list.length === 1 ? one : many}`;
  const parts = [...(fresh.length ? [`${names(fresh, 'was', 'were')} added or changed since it last ran`] : []),
    ...(gone.length ? [`${names(gone, 'was', 'were')} removed since it last ran`] : []),
    ...(failed.length ? [`${names(failed, 'did', 'did')} not get ${failed.length === 1 ? 'its' : 'their'} expected results when it last ran`] : [])];
  // Otherwise only a fixture's note, origin or then, or a file under
  // tests/fixtures/ that no fixture names, changed.
  if (!parts.length) parts.push('only fixture entries of checks.json or files under tests/fixtures/ changed since it last ran, none that a fixture\'s results rest on');
  const rerun = fresh.length + failed.length;
  // The probe has its own reason (probeStale) when it runs again too.
  return `${parts.join('; ')}. The rest of the package and the kit are as they were then, and of the fixtures \`eval check\` runs ${rerun ? `only ${rerun === 1 ? 'that one' : 'those'}` : 'none again'}`;
}

// Whether the probe of a check record still proves the package as it runs:
// the run digest it ran is the package's, or only harness.json, the adapter
// modules or the package's binding to a Spec changed since (probeDigest), and
// every gating check came out unknown in an attempt that completed. item is
// the package as eval validate lists it.
export const probeHolds = (last, item) => record(last?.probe) && last.probe.ok === true
  && (last.probe.run_digest === item?.run_digest || (nonempty(last.probe.probe_digest) && last.probe.probe_digest === item?.probe_digest));

// Why the probe does not prove a package as it runs, or null.
function probeStale(last, item) {
  if (probeHolds(last, item)) return null;
  const probe = record(last?.probe) ? last.probe : null;
  if (!probe) return 'the probe, a run with Harbor\'s nop agent in which every gating check but a code test must come out unknown, has not run';
  if (probe.run_digest !== item?.run_digest && !(nonempty(probe.probe_digest) && probe.probe_digest === item?.probe_digest)) return 'the package or the kit changed since the probe ran';
  if (probe.execution?.status !== 'completed') return `the probe did not complete (${probe.execution?.reason ?? 'no reason recorded'})`;
  return `the probe judged a result when nothing was done: ${(probe.unexpected ?? []).map((entry) => `${entry.check} ${entry.result}`).join(', ')}. Every gating check but a code test must come out unknown when the evaluated agent does nothing`;
}

// Whether a path is the folder or inside it.
const within = (folder, file) => {
  const relative = path.relative(folder, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// A path an environment file gives, with the variables Genesis sets during a
// trial (GENESIS_EDD_REPO, GENESIS_EDD_HARNESS), HOME and a leading ~
// resolved, or null when it names any other variable, whose value cannot be
// told here.
function resolveVariables(value, repo, kit) {
  const known = { GENESIS_EDD_REPO: repo, GENESIS_EDD_HARNESS: kit, HOME: os.homedir() };
  let unresolved = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?-][^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const variable = braced ?? bare;
    if (Object.hasOwn(known, variable)) return known[variable];
    unresolved = true;
    return match;
  });
  if (unresolved || out.includes('$')) return null;
  return out.replace(/^~(?=\/|$)/, os.homedir());
}

const remoteSource = (value) => /^[a-z][a-z0-9+.-]*:\/\/|^git@/i.test(value);
const isDockerfile = (file) => /^(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$|\.(?:dockerfile|Dockerfile|containerfile)$/.test(path.basename(file));

// What a Compose file hands its containers from the host, read as Compose
// reads it during a trial: merge keys, the variables Genesis sets, and
// relative paths from the file's folder, the project directory Harbor
// passes. { error, entries, builds, include, extended, mainBuild }. entries
// are [{ kind (context, additional_context, volume, config or secret),
// service, value, target }], target the resolved host path or null when a
// variable cannot be resolved; remote build contexts are left out. builds
// are [{ service, context, dockerfile, inline }], context null when it is
// remote or cannot be resolved. Compose's own tags, such as !reset, are not
// YAML's, so the parser's warnings about them are not shown.
function composeOf(file, text, repo, kit) {
  const empty = { error: null, entries: [], builds: [], include: false, extended: [], mainBuild: false };
  let compose;
  try { compose = parse(text, { merge: true, logLevel: 'error' }); } catch (error) { return { ...empty, error: error.message.split('\n')[0] }; }
  if (!record(compose)) return empty;
  const folder = path.dirname(file);
  const resolve = (value) => {
    const resolved = resolveVariables(value, repo, kit);
    return resolved === null ? null : path.resolve(folder, resolved);
  };
  const entries = [];
  const builds = [];
  const extended = [];
  const add = (kind, service, value) => {
    if (typeof value !== 'string' || remoteSource(value)) return;
    entries.push({ kind, service, value, target: resolve(value) });
  };
  const services = record(compose.services) ? compose.services : {};
  for (const [id, service] of Object.entries(services)) {
    if (!record(service)) continue;
    if (record(service.extends) && typeof service.extends.file === 'string') extended.push({ service: id, file: service.extends.file });
    const { build } = service;
    if (typeof build === 'string' || record(build)) {
      const value = typeof build === 'string' ? build : (build.context ?? '.');
      add('context', id, value);
      const context = typeof value === 'string' && !remoteSource(value) ? resolve(value) : null;
      if (record(build)) {
        const extra = build.additional_contexts;
        const values = record(extra) ? Object.values(extra) : Array.isArray(extra) ? extra.map((entry) => (typeof entry === 'string' ? entry.replace(/^[^=]+=/, '') : entry)) : [];
        // An image, an OCI layout or another service's build is no host path.
        for (const entry of values) if (typeof entry === 'string' && !/^(?:docker-image|oci-layout|service|target):/i.test(entry)) add('additional_context', id, entry);
      }
      const inline = record(build) && typeof build.dockerfile_inline === 'string' ? build.dockerfile_inline : null;
      const given = record(build) && typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile';
      const resolved = resolveVariables(given, repo, kit);
      builds.push({ service: id, context, dockerfile: inline === null && context !== null && resolved !== null ? path.resolve(context, resolved) : null, inline });
    }
    for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
      if (typeof volume === 'string') {
        // SOURCE:TARGET[:MODE]; a named volume's source holds no path.
        const parts = volume.split(':');
        if (parts.length > 1 && /^[./~$]/.test(parts[0])) add('volume', id, parts[0]);
      } else if (record(volume) && typeof volume.source === 'string' && (volume.type === 'bind' || (volume.type === undefined && /^[./~$]/.test(volume.source)))) {
        add('volume', id, volume.source);
      }
    }
  }
  for (const [kind, key] of [['config', 'configs'], ['secret', 'secrets']]) {
    for (const [id, entry] of Object.entries(record(compose[key]) ? compose[key] : {})) {
      if (record(entry) && typeof entry.file === 'string') add(kind, id, entry.file);
    }
  }
  return { error: null, entries, builds, include: compose.include !== undefined, extended,
    mainBuild: record(services.main) && services.main.build !== undefined && services.main.build !== null };
}

// The sources a Dockerfile copies from its build context: what COPY and ADD
// name, but those of another stage or image (--from) and URLs, and the
// sources RUN --mount binds from the context. Each as written.
function copySources(text) {
  const sources = [];
  for (const raw of text.replace(/\\[ \t]*\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.trim();
    const instruction = line.match(/^(COPY|ADD|RUN)\s+(.*)$/i);
    if (!instruction) continue;
    const word = instruction[1].toUpperCase();
    let rest = instruction[2];
    if (word === 'RUN') {
      for (const mount of rest.matchAll(/--mount=(\S+)/g)) {
        const options = Object.fromEntries(mount[1].split(',').map((part) => {
          const at = part.indexOf('=');
          return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
        }));
        if ((options.type ?? 'bind') !== 'bind' || options.from) continue;
        sources.push(options.source ?? options.src ?? '.');
      }
      continue;
    }
    const flags = [];
    while (/^--\S+/.test(rest)) {
      const [flag] = rest.match(/^--\S+/);
      flags.push(flag);
      rest = rest.slice(flag.length).trimStart();
    }
    if (flags.some((flag) => /^--from=/i.test(flag)) || rest.startsWith('<<')) continue;
    let args = [];
    if (rest.startsWith('[')) {
      try { const list = JSON.parse(rest); if (Array.isArray(list)) args = list.map(String); } catch { args = []; }
    } else args = rest.split(/\s+/).filter(Boolean);
    if (args.length < 2) continue;
    for (const source of args.slice(0, -1)) if (!remoteSource(source)) sources.push(source);
  }
  return sources;
}

// A COPY source pattern as a regular expression over paths relative to the
// context: * and ? stay within one folder, ** spans any number of folders,
// none included.
function globRegex(pattern) {
  const parts = pattern.split('/');
  const text = parts.map((segment, index) => {
    const last = index === parts.length - 1;
    if (segment === '**') return last ? '.*' : '(?:.*/)?';
    const shaped = segment.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\[!/g, '[^').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return last ? shaped : `${shaped}/`;
  }).join('');
  return new RegExp(`^${text}$`);
}

// A COPY source as written, without a leading ./ and a trailing /.
const cleanSource = (source) => source.replace(/^\.\/+/, '').replace(/\/+$/, '');

// Whether a COPY source, against its build context base, takes the file or
// folder target into the image: the source names it, a folder that holds it,
// or a pattern that matches it or a folder above it. A source with a
// variable is taken to copy the whole context.
function copyTakes(base, source, target) {
  if (!within(base, target)) return false;
  const clean = cleanSource(source);
  if (clean.includes('$') || !clean || clean === '.') return true;
  if (/[*?[]/.test(clean)) {
    const regex = globRegex(clean);
    const segments = relativeOf(base, target).split('/');
    return segments.some((_, index) => regex.test(segments.slice(0, index + 1).join('/')));
  }
  return within(path.resolve(base, clean), target);
}

// Whether a COPY source, against its build context base, takes anything of
// folder into the image: the whole context when it lies inside folder, a
// source that names folder, a folder above it or anything in it, or a
// pattern that can match one of those. A pattern with a wildcard before its
// last part, such as **, is taken to reach everything in the context.
function copyReaches(base, source, folder) {
  if (within(folder, base)) return true;
  if (!within(base, folder)) return false;
  const clean = cleanSource(source);
  if (clean.includes('$') || !clean || clean === '.') return true;
  const parts = clean.split('/');
  if (!/[*?[]/.test(clean)) {
    const resolved = path.resolve(base, clean);
    return within(resolved, folder) || within(folder, resolved);
  }
  if (parts.slice(0, -1).some((part) => /[*?[]/.test(part))) return true;
  const prefix = parts.slice(0, -1).join('/');
  if (prefix && within(folder, path.resolve(base, prefix))) return true;
  return copyTakes(base, source, folder);
}

// The Dockerfiles a package's environment builds, each with its context:
// [{ file (or null for an inline one), text, context }]. A build Compose
// gives, from the package's environment files and the kit's, and the
// package's own environment/Dockerfile when its docker-compose.yaml gives
// main no build, which Harbor then builds from environment/.
function buildsOf(composes, directory) {
  const found = [];
  for (const { builds } of composes) {
    for (const build of builds) {
      if (build.inline !== null) found.push({ file: null, text: build.inline, context: build.context });
      else if (build.dockerfile && isFile(build.dockerfile)) {
        try { found.push({ file: build.dockerfile, text: readFileSync(build.dockerfile, 'utf8'), context: build.context }); } catch { /* unreadable */ }
      }
    }
  }
  const own = path.join(directory, 'environment/Dockerfile');
  const mainBuilt = composes.some((entry) => entry.own && entry.mainBuild);
  if (!mainBuilt && isFile(own)) {
    try { found.push({ file: own, text: readFileSync(own, 'utf8'), context: path.dirname(own) }); } catch { /* unreadable */ }
  }
  return found;
}

// The environment files of a package and of the kit, parsed: [{ file, own,
// text, yaml, compose }], own for the package's own files.
function environmentFiles(repo, kit, directory) {
  return [...listFiles(path.join(directory, 'environment')).map((file) => ({ file, own: true })), ...kit.environment.map((file) => ({ file, own: false }))]
    .flatMap(({ file, own }) => {
      const yaml = /\.ya?ml$/.test(file);
      if (!yaml && !isDockerfile(file)) return [];
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { return []; }
      return [{ file, own, text, yaml, compose: yaml ? composeOf(file, text, repo, kit.directory) : null }];
    });
}

// Whether the project's .dockerignore keeps .genesis out of a build from the
// project root.
const ignoresGenesis = (dockerignore) => /^\/?\.genesis\/?\s*$/m.test(dockerignore);

// What the evaluated program must never read: every change's records and
// packages under .genesis/edd/, and the kit's verifier/ folder. The rest of
// the kit, such as its environment/ folder, harness.json and the adapter, is
// not among them.
function protectedRoots(repo, kit) {
  const edd = path.join(repo, '.genesis', 'edd');
  let entries = [];
  try { entries = readdirSync(edd).filter((entry) => path.join(edd, entry) !== kit); } catch { /* no records yet */ }
  return [...entries.map((entry) => path.join(edd, entry)), path.join(kit, 'verifier')];
}

// The kit's root modules that the environment of a package reaches: copied
// into an image by a Dockerfile it builds, or handed to a container as a
// mount, a config, a secret or an additional build context. A stand-in may
// run such a module, so the package's proofs rest on it. When a path cannot
// be resolved, every root module is kept. A set of file names.
function environmentKeeps(repo, kit, directory, dockerignore) {
  const roots = ownFiles(kit.directory).filter((file) => path.dirname(file) === kit.directory && file.endsWith('.py'));
  if (!roots.length) return new Set();
  const files = environmentFiles(repo, kit, directory);
  const composes = files.filter((entry) => entry.yaml && entry.compose && !entry.compose.error).map((entry) => ({ ...entry.compose, own: entry.own }));
  const unresolved = composes.some((compose) => compose.entries.some((entry) => entry.target === null));
  if (unresolved) return new Set(roots.map((file) => path.basename(file)));
  const handed = composes.flatMap((compose) => compose.entries.filter((entry) => entry.kind !== 'context').map((entry) => entry.target));
  const ignores = ignoresGenesis(dockerignore);
  const builds = buildsOf(composes, directory);
  const kept = new Set();
  for (const file of roots) {
    if (handed.some((target) => within(target, file))) { kept.add(path.basename(file)); continue; }
    for (const { text, context } of builds) {
      if (context === null) continue;
      // A build from the project root whose .dockerignore keeps .genesis out copies nothing of the kit.
      if (context === repo && ignores) continue;
      if (copySources(text).some((source) => copyTakes(context, source, file))) { kept.add(path.basename(file)); break; }
    }
  }
  return kept;
}

// Where the environment of a package could hand the evaluated program, or a
// stand-in that could pass it on, what decides its result: a build context,
// an additional build context, a bind mount in the short or the long syntax,
// a config or a secret that holds the project root, a folder above it or
// .genesis/edd, or names checks.json; a path given by a variable that cannot
// be resolved; a COPY that takes .genesis/edd or the kit's verifier/ into an
// image; a text that names checks.json, ../tests or ../solution. A build from
// the project root counts unless its .dockerignore keeps .genesis out, and a
// build from the kit's root only by what it copies. [{ file, message,
// service?, source? }], file relative to the project. Read-only.
function environmentExposures(context, directory) {
  const { repo, kit, dockerignore } = context;
  const roots = context.protected;
  const ignores = ignoresGenesis(dockerignore);
  const ownEnvironment = path.join(directory, 'environment');
  const shown = (file) => relativeOf(repo, file);
  const reaches = (target) => roots.some((root) => within(root, target) || within(target, root));
  const found = [];
  const files = environmentFiles(repo, kit, directory);
  for (const { file, own, text, yaml, compose } of files) {
    if (/checks\.json|(?:^|[\s"'/])(?:\.\.\/)+(?:tests|solution)\b/m.test(text)) {
      found.push({ file: shown(file), message: `${shown(file)} names checks.json, ../tests or ../solution: expected results and the reference solution stay out of the evaluated program's reach.` });
    }
    if (!yaml) continue;
    if (compose.error) {
      if (own) found.push({ file: shown(file), message: `${shown(file)} cannot be parsed (${compose.error}), so what it hands the containers cannot be read.` });
      continue;
    }
    if (compose.include) found.push({ file: shown(file), message: `${shown(file)} includes other Compose files, whose mounts and build contexts are not read here.` });
    for (const entry of compose.extended) {
      found.push({ file: shown(file), service: entry.service, message: `${shown(file)}: service ${entry.service} extends a service of ${entry.file}, whose mounts and build contexts are not read here.` });
    }
    for (const entry of compose.entries) {
      const what = { context: 'builds from', additional_context: 'has the additional build context', volume: 'mounts', config: 'hands as a config', secret: 'hands as a secret' }[entry.kind];
      const where = `${shown(file)}: ${entry.kind === 'config' || entry.kind === 'secret' ? `${entry.kind} ${entry.service}` : `service ${entry.service}`} ${what} ${entry.value}`;
      const report = (why) => found.push({ file: shown(file), service: entry.service, source: entry.value, message: `${where}, ${why}.` });
      const { target } = entry;
      if (target === null) { report('a path with a variable this cannot resolve, so whether it reaches the project root, .genesis or a package\'s tests cannot be told'); continue; }
      if (entry.kind === 'volume' && path.basename(target) === 'docker.sock') { report('the host\'s Docker socket, through which a container can mount any host path, the project included'); continue; }
      if (target !== repo && within(target, repo)) { report('which holds the whole project, .genesis included'); continue; }
      if (target === repo) {
        if (entry.kind === 'context') { if (!ignores) report('the project root, and the project\'s .dockerignore has no .genesis rule, so every package\'s tests and the user\'s records would be in the image'); }
        else report(`the project root, which holds .genesis; ${entry.kind === 'additional_context' ? 'an additional build context is not read with the project\'s .dockerignore here' : 'a mount is not filtered by .dockerignore'}`);
        continue;
      }
      if (within(ownEnvironment, target) || (entry.kind === 'context' && target === kit.directory)) continue;
      if (reaches(target)) { report('which reaches .genesis/edd, where the packages\' tests, the kit\'s verifier code and the user\'s records are'); continue; }
      if (path.basename(target) === 'checks.json') report('a checks.json');
    }
  }
  const composes = files.filter((entry) => entry.yaml && entry.compose && !entry.compose.error).map((entry) => ({ ...entry.compose, own: entry.own }));
  for (const build of buildsOf(composes, directory)) {
    const { context } = build;
    // A build from the project root is judged by its .dockerignore above, one
    // from the package's own environment/ cannot reach anything else, and one
    // from inside .genesis/edd is named above already.
    if (context === null || within(context, repo) || within(ownEnvironment, context) || roots.some((root) => within(root, context))) continue;
    const label = build.file ? shown(build.file) : 'an inline Dockerfile';
    for (const source of copySources(build.text)) {
      const taken = roots.filter((root) => copyReaches(context, source, root));
      if (taken.length) {
        found.push({ file: build.file ? shown(build.file) : shown(context), source, message: `${label} copies ${source} from ${shown(context) || '.'}, which takes ${taken.map(shown).join(', ')} into the image, where the evaluated program can read it.` });
      }
    }
  }
  return found;
}

// The places the environments of these packages and of the kit read the
// project directory from by a path of their own, not through
// ${GENESIS_EDD_REPO}: a build context, an additional build context, a bind
// mount, a config or a secret that resolves into the project outside
// .genesis/. A baseline on the rebuilt start code points ${GENESIS_EDD_REPO}
// at that code, so such a place would read the working directory instead. A
// path given by another variable cannot be resolved here and is named too.
// [{ file, path }], file relative to the project. Read-only.
export function projectReads(repo, name, ids) {
  const kit = kitDirectory(repo);
  const genesis = path.join(repo, '.genesis');
  const files = [...ids.flatMap((id) => listFiles(path.join(eddDirectory(repo, name), 'evals', id, 'environment'))), ...listFiles(path.join(kit, 'environment'))]
    .filter((file) => /\.ya?ml$/.test(file));
  const found = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const { entries } = composeOf(file, text, repo, kit);
    const shown = relativeOf(repo, file);
    for (const entry of entries) {
      if (/\$\{?GENESIS_EDD_REPO\b/.test(entry.value)) continue;
      if (entry.target === null || (within(repo, entry.target) && !within(genesis, entry.target))) found.push({ file: shown, path: entry.value });
    }
  }
  return found;
}

// What a package's Task.md records: whether it is written, and the technical
// choices the Spec does not state, from its "Choices made here" section, one
// entry per line or list item.
function taskNotes(directory) {
  const file = path.join(directory, 'Task.md');
  if (!filled(file)) return { written: false, choices: [] };
  const choices = [];
  let inside = false;
  for (const line of readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) { inside = /^choices made here\b/i.test(heading[1].trim()); continue; }
    const entry = inside ? line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim() : '';
    if (entry) choices.push(entry);
  }
  return { written: true, choices };
}

// What a fixture is made of: { patch, problems }. patch says it is a code
// patch, which a code test must fail on; problems what is wrong with its
// files. A package of one step gives a fixture a script at
// tests/fixtures/NAME.sh; a package with steps gives it one script per step,
// tests/fixtures/NAME/STEP.sh, and a step without one does nothing. A code
// patch is at the path fixture.patch gives, or tests/fixtures/NAME.patch, or
// tests/fixtures/NAME/code.patch. A fixture is a script or a patch: with
// both, kind says which.
function fixtureForm(directory, fixture, steps) {
  const base = path.join(directory, 'tests/fixtures');
  const folder = path.join(base, fixture.name);
  const inFolder = isDirectory(folder) ? ownFiles(folder).map((file) => relativeOf(folder, file)) : [];
  const single = isFile(path.join(base, `${fixture.name}.sh`));
  const patchFile = fixturePatch(directory, fixture);
  const stepScripts = inFolder.filter((file) => file.endsWith('.sh') && steps.includes(file.slice(0, -3)));
  const problems = [];
  const stray = inFolder.filter((file) => file !== 'code.patch' && !stepScripts.includes(file));
  if (stray.length) {
    problems.push(`tests/fixtures/${fixture.name}/ holds ${stray.join(', ')}, which ${steps.length
      ? `${stray.length === 1 ? 'is' : 'are'} neither code.patch nor STEP.sh for a step of this package (${steps.join(', ')})`
      : `${stray.length === 1 ? 'is' : 'are'} not code.patch; a package of one step keeps a fixture's script at tests/fixtures/${fixture.name}.sh`}`);
  }
  if (steps.length && single) problems.push(`a package with steps gives a fixture one script per step, tests/fixtures/${fixture.name}/STEP.sh, so tests/fixtures/${fixture.name}.sh never runs`);
  const script = steps.length ? stepScripts.length > 0 : single;
  if (fixture.kind === 'code_patch' && !patchFile) problems.push(`kind is code_patch, and there is no patch at tests/fixtures/${fixture.name}.patch or tests/fixtures/${fixture.name}/code.patch`);
  if (fixture.kind === 'script' && !script) problems.push(`kind is script, and there is no script${steps.length ? ` for a step at tests/fixtures/${fixture.name}/STEP.sh` : ` at tests/fixtures/${fixture.name}.sh`}`);
  if (fixture.kind === undefined && script && patchFile) problems.push('it has both a script and a code patch: a fixture stands in for the evaluated agent with a script or changes the application code with a patch, and kind says which');
  if (!script && !patchFile) {
    problems.push(steps.length ? `it has no script at tests/fixtures/${fixture.name}/STEP.sh for any step and no code patch`
      : `it has no script at tests/fixtures/${fixture.name}.sh and no code patch at tests/fixtures/${fixture.name}.patch`);
  }
  return { patch: fixture.kind === 'code_patch' || (fixture.kind !== 'script' && Boolean(patchFile) && !script), problems };
}

// A leading keyword of the Spec's Markdown left in a then; it names which.
const KEYWORD = /^\s*(?:-\s*)?(?:\*\*)?(THEN|AND|GIVEN|WHEN)(?:\*\*)?(?![A-Za-z0-9_])/i;
// A list of lines for a message.
const quoted = (texts) => texts.map((text) => `"${text}"`).join(', ');
// Harbor 0.27.0 copies what the adapter saved into main at /logs/agent before
// the verifier runs, and the evaluated program can write there too. The files
// that name it, relative to directory.
const AGENT_LOGS = /\/logs\/agent(?![A-Za-z0-9_-])/;
const AGENT_LOGS_TEXT = '/logs/agent. Harbor copies what the adapter saved there before the verifier runs, and the evaluated program can write there too, so it is no evidence. Read the evidence from where the program cannot reach it.';
const namesAgentLogs = (directory, files) => files.filter((file) => {
  try { return AGENT_LOGS.test(readFileSync(file, 'utf8')); } catch { return false; }
}).map((file) => relativeOf(directory, file));

// The helper's calls in a test.sh that record a check: [{ fn, id, program, seconds }].
const helperCalls = (text) => [...text.matchAll(/^[ \t]*(gate|note|gate_code|note_code|judge)[ \t]+["']?([A-Za-z0-9_-]+)["']?(?:[ \t]+["']?([^\s"']+)["']?)?(?:[ \t]+["']?(\d+)["']?)?/gm)]
  .map((match) => ({ fn: match[1], id: match[2], program: match[3] ?? null, seconds: match[4] === undefined ? null : Number(match[4]) }));

function validateCase(context, item, fail, warn, issue) {
  const { repo, handoff, name, dockerignore, kit, source } = context;
  const { directory, checks } = item;
  const has = (relative) => existsSync(path.join(directory, relative));
  const read = (relative) => { try { return readFileSync(path.join(directory, relative), 'utf8'); } catch { return ''; } };
  const folders = stepFolders(directory);
  const declaredSteps = tomlSteps(read('task.toml'));
  const steps = declaredSteps.filter(Boolean).length ? [...new Set(declaredSteps.filter(Boolean))] : folders;
  const adapter = packageAdapter(repo, directory, kit, fail);
  const kept = environmentKeeps(repo, kit, directory, dockerignore);
  const notes = taskNotes(directory);
  const ref = record(checks?.spec_ref) ? checks.spec_ref : null;
  // lines holds one row per THEN or AND line of the scenario, for validateEval;
  // it is not part of the summary eval validate returns.
  // sealed says whether the program and its stand-in services reach no
  // outside network, as Harbor runs the package.
  // task_digest covers every file of the package and the kit; run_digest
  // leaves the fixtures out, as a run never executes them. proof_digest and
  // probe_digest are those two without harness.json, the adapter modules at
  // the kit's root and the binding to a Spec, which `eval check` never runs:
  // its proofs rest on them. fixture_digests holds each fixture's own digest.
  // steps are in the order Harbor runs them, and check_at gives, in a
  // package with steps, the step each check is recorded at, by check id.
  const summary = { id: item.id, path: path.relative(path.dirname(path.dirname(directory)), directory), schema_version: null, status: null, scenario: null,
    integration: null, checks: 0, gating: 0, manual: 0, steps, check_at: {}, live: false, sealed: sealedOf(directory),
    adapter, dependencies: [], choices: notes.choices, task_md: notes.written,
    code_tests: [], judges: [], then_groups: [], fixture_digests: {}, code_patches: [],
    bound_to: ref ? { sha256: nonempty(ref.sha256) ? ref.sha256 : null, ...(ref.draft === true ? { draft: true } : {}) } : null,
    draft_bound: Boolean(ref && source && ref.sha256 === source.id && (source.draft || ref.draft === true)),
    rebound: Array.isArray(checks?.rebound) ? checks.rebound : [],
    task_digest: taskDigest(directory, kit), run_digest: runDigest(directory, kit),
    proof_digest: proofDigest(directory, kit, kept), probe_digest: probeDigest(directory, kit, kept), lines: [] };
  if (summary.sealed.warning) warn(`${item.id}: ${summary.sealed.warning}.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) fail('Case folder must be lowercase kebab-case.');
  // Steps: Harbor runs those task.toml declares, in its order, and reads
  // each one's instruction and tests from its folder under steps/.
  if (folders.length || declaredSteps.length) {
    const named = declaredSteps.filter(Boolean);
    if (!declaredSteps.length) {
      fail(`steps/ holds ${folders.join(', ')}, but task.toml declares no [[steps]], so Harbor runs the package as a single step and never reads steps/. A step is declared as [[steps]] with its name, in the order the steps run.`);
    } else {
      if (named.length < declaredSteps.length) fail('Every [[steps]] entry in task.toml needs a name: the folder of that step under steps/.');
      const doubled = [...new Set(named.filter((step, index) => named.indexOf(step) !== index))];
      if (doubled.length) fail(`task.toml declares step ${doubled.join(', ')} more than once.`);
      const absent = named.filter((step) => !folders.includes(step));
      if (absent.length) fail(`task.toml declares ${absent.join(', ')}, which ${absent.length === 1 ? 'has' : 'have'} no folder under steps/.`);
      const extra = folders.filter((step) => !named.includes(step));
      if (extra.length) fail(`steps/ holds ${extra.join(', ')}, which task.toml does not declare, so Harbor never runs ${extra.length === 1 ? 'it' : 'them'}.`);
      for (const step of named) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(step)) fail(`Step name ${step} must be a plain folder name: letters, digits, dots, dashes and underscores.`);
    }
  }
  // Where the environment could hand the evaluated program what decides its result.
  for (const entry of environmentExposures(context, directory)) {
    issue('expected_results_exposed', entry.message, { path: entry.file, ...(entry.service ? { service: entry.service } : {}), ...(entry.source ? { source: entry.source } : {}) });
  }
  if (!record(checks)) { fail(`tests/checks.json is missing or not a JSON object${item.unreadable ? `: ${item.unreadable}` : '.'}`); return summary; }
  if (!VERSIONS.includes(checks.schema_version)) fail('schema_version must be "1.0" or "1.1".');
  summary.schema_version = checks.schema_version ?? null;
  // A 1.0 package is read under the rules it was written for.
  const current = checks.schema_version === '1.1';
  const list = (value) => (Array.isArray(value) ? value : []);
  const NEW_CHECK_FIELDS = ['then', 'then_group', 'kind', 'command', 'program', 'timeout_sec', 'absence'];
  if (checks.schema_version === '1.0' && (list(checks.checks).some((check) => record(check) && NEW_CHECK_FIELDS.some((key) => check[key] !== undefined))
    || (record(checks.scenario) && checks.scenario.manual !== undefined)
    || list(checks.fixtures).some((fixture) => record(fixture) && ['origin', 'note', 'then', 'kind', 'patch'].some((key) => fixture[key] !== undefined)))) {
    fail(`${NEW_CHECK_FIELDS.join(', ')} of a check, scenario.manual, and origin, note, then, kind and patch of a fixture belong to checks.json 1.1. Set schema_version to "1.1", or remove them.`);
  }
  if (!['draft', 'confirmed'].includes(checks.status)) fail('status must be draft or confirmed.');
  summary.status = checks.status ?? null;
  if (!ref || ref.id !== name || !nonempty(ref.sha256)) {
    fail(`spec_ref needs id "${name}" and the sha256 of the Spec handoff the package is written for.`);
  } else if ((ref.draft !== undefined && typeof ref.draft !== 'boolean') || (ref.scenario_sha256 !== undefined && !nonempty(ref.scenario_sha256))) {
    fail('spec_ref.draft is true or false, and spec_ref.scenario_sha256 is the digest of the scenario the package was written for.');
  }
  if (checks.rebound !== undefined && (!Array.isArray(checks.rebound)
    || checks.rebound.some((entry) => !record(entry) || !record(entry.from) || !nonempty(entry.to) || !nonempty(entry.at)))) {
    fail('rebound lists the package\'s earlier bindings, each { from, to, at }, as `eval rebind` writes them.');
  }
  const requirements = new Map(handoff.requirements.map((requirement) => [requirement.id, requirement]));
  const scenario = checks.scenario;
  const target = record(scenario) ? requirements.get(scenario.requirement)?.scenarios.find((entry) => entry.name === scenario.name) : undefined;
  if (!target) {
    // A requirement the Spec leaves out, proposed or held by an open
    // question, never becomes a check.
    const left = record(scenario) ? (Array.isArray(handoff.excluded) ? handoff.excluded : []).find((entry) => entry?.requirement === scenario.requirement) : undefined;
    fail(left
      ? `scenario names ${left.requirement}, which the ${source?.draft ? 'Spec draft' : 'exported Spec'} leaves out (${left.reason === 'open_question' ? 'an open question holds it' : 'it is proposed'}): a requirement left out of the Spec is not checked.`
      : `scenario must name a requirement and one of its scenarios in the ${source?.draft ? 'Spec draft' : 'exported Spec'}.`);
  } else summary.scenario = { requirement: scenario.requirement, name: scenario.name };
  // The scenario's THEN and AND lines by their key, each with its first text:
  // a line written twice in the Spec is one line.
  const lineTexts = new Map();
  for (const text of target?.then ?? []) if (!lineTexts.has(thenKey(text))) lineTexts.set(thenKey(text), text);
  const setup = new Set([...(target?.given ?? []), ...(target?.when ?? [])].map(thenKey));
  if (current && target && !lineTexts.size) fail(`Scenario "${target.name}" has no THEN line, so there is nothing to check.`);
  // The key of the line a then names, or null when it names none.
  const bind = (label, value) => {
    if (Array.isArray(value)) {
      fail(`${label}: then is one line, not a list. A check verifies one THEN or AND line, or names in then_group a few lines that can only fail together.`);
      return null;
    }
    if (!nonempty(value)) { fail(`${label}: then must be one THEN or AND line of the scenario.`); return null; }
    if (!target) return null;
    const key = thenKey(value);
    if (lineTexts.has(key)) return key;
    const bare = thenKey(value.replace(KEYWORD, ''));
    // The keyword hint names only the keywords a THEN or AND line carries.
    const word = value.match(KEYWORD)?.[1].toUpperCase();
    const hint = (word === 'THEN' || word === 'AND') && lineTexts.has(bare) ? ' The THEN or AND keyword is not part of the line.'
      : setup.has(key) || setup.has(bare) ? ' That is a GIVEN or WHEN line, which sets the scenario up; a check verifies a THEN or AND line.' : '';
    fail(`${label}: then "${value}" is not a THEN or AND line of scenario "${target.name}".${hint} Its lines, exactly: ${quoted([...lineTexts.values()])}.`);
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
      if (manual.has(key)) fail(`${label}: "${lineTexts.get(key)}" is in scenario.manual more than once.`);
      else manual.set(key, nonempty(entry.reason) ? entry.reason.trim() : null);
    }
  }
  // The checks that verify each line, the diagnostic ones that cite it, and
  // the judges of the lines the user judges.
  const bound = new Map();
  const cited = new Map();
  const judgedBy = new Map();
  const add = (map, key, entry) => map.set(key, [...(map.get(key) ?? []), entry]);
  if (checks.integration !== undefined) fail('Remove integration from checks.json: whether a package can run is worked out from its files and its last `eval check`.');
  if (!Array.isArray(checks.dependencies) || checks.dependencies.some((entry) => !record(entry) || !nonempty(entry.name) || !MODES.includes(entry.mode)
    || (entry.stand_in !== undefined && !nonempty(entry.stand_in)))) {
    fail(`dependencies must list each external dependency with name and mode (${MODES.join(', ')}), and stand_in, when given, is a sentence saying what replaces it; use [] when there is none.`);
  }
  summary.dependencies = list(checks.dependencies).filter((entry) => record(entry) && nonempty(entry.name) && MODES.includes(entry.mode))
    .map((entry) => ({ name: entry.name, mode: entry.mode, stand_in: nonempty(entry.stand_in) ? entry.stand_in : null }));
  const standless = summary.dependencies.filter((entry) => entry.mode !== 'live' && !entry.stand_in).map((entry) => entry.name);
  if (standless.length) warn(`${item.id}: ${standless.join(', ')} ${standless.length === 1 ? 'is' : 'are'} ${standless.length === 1 ? 'a simulated or frozen dependency' : 'simulated or frozen dependencies'} with no stand_in in tests/checks.json, so what replaces ${standless.length === 1 ? 'it' : 'them'} is not on record for the review.`);
  // Not part of the task digest: it is read from checks.json, which is.
  summary.live = isLive(checks.dependencies);
  const ids = new Set();
  // The helper calls each code test and judge needs in its test.sh.
  const calls = [];
  // A 1.1 package whose every line the user judges has no check.
  if (current ? !Array.isArray(checks.checks) : !Array.isArray(checks.checks) || !checks.checks.length) {
    fail(current ? 'checks must be a list.' : 'checks must be a non-empty list.');
  }
  const scriptOf = (at) => (steps.length && nonempty(at) ? `steps/${at}/tests/test.sh` : 'tests/test.sh');
  // A program a code test or a judge runs: its path under tests/, or null.
  const programOf = (label, field, value, at, prefixes) => {
    const places = prefixes.map((prefix) => `tests/${prefix}`).join(' or ');
    if (!nonempty(value)) { fail(`${label} needs ${field}: the path, under tests/, of the program it runs, in ${places}.`); return null; }
    const clean = path.posix.normalize(value.trim().replace(/^\.\/+/, ''));
    if (clean.startsWith('/') || clean.startsWith('..') || !prefixes.some((prefix) => clean.startsWith(prefix))) {
      fail(`${label}: ${field} ${value} is not a path in ${places}.`);
      return null;
    }
    const where = [`tests/${clean}`, ...(steps.length && nonempty(at) ? [`steps/${at}/tests/${clean}`] : [])];
    if (!where.some((relative) => isFile(path.join(directory, relative)))) { fail(`${label}: ${field} ${where.join(' or ')} is missing.`); return null; }
    return clean;
  };
  const secondsOf = (label, check) => {
    if (check.timeout_sec === undefined) return PROGRAM_SECONDS;
    if (!Number.isInteger(check.timeout_sec) || check.timeout_sec < 1) { fail(`${label}: timeout_sec is a whole number of seconds above zero.`); return PROGRAM_SECONDS; }
    return check.timeout_sec;
  };
  for (const check of list(checks.checks)) {
    const label = `check ${record(check) && nonempty(check.id) ? check.id : '?'}`;
    if (!record(check) || !/^[A-Za-z0-9_-]+$/.test(check.id ?? '') || !nonempty(check.expect) || !['gating', 'diagnostic'].includes(check.role)) {
      fail(`${label} needs id, expect and role (gating or diagnostic).`);
      continue;
    }
    if (ids.has(check.id)) fail(`Duplicate check id: ${check.id}`);
    ids.add(check.id);
    if (check.kind !== undefined && !KINDS.includes(check.kind)) fail(`${label}: kind must be ${KINDS.join(', ')}; a check without kind is a verifier check.`);
    const kind = check.kind ?? 'verifier';
    // absence marks a check that passes when something is not found, such as
    // "no success notice was sent".
    if (check.absence !== undefined && typeof check.absence !== 'boolean') fail(`${label}: absence is true for a check that passes when something is not found, such as "no notice was sent", or false.`);
    if (check.absence === true && kind !== 'verifier') fail(`${label}: absence belongs to a verifier check; a ${kind} check cannot carry it.`);
    if (current && check.role === 'gating') {
      // A gating check verifies one line of its own scenario, or a few that can only fail together.
      if (summary.scenario && check.intent !== summary.scenario.requirement) {
        fail(`${label} is gating, so its intent must be ${summary.scenario.requirement}, the requirement of its scenario; it cites ${check.intent ?? 'no requirement'}. A check of another requirement can only be diagnostic.`);
      } else if (!summary.scenario && !requirements.has(check.intent)) {
        fail(`${label} cites ${check.intent ?? 'no requirement'}, which is not in the Spec. Every check needs a source.`);
      }
      if (kind === JUDGE) fail(`${label} is a judge, so its role is diagnostic: the user makes the line it judges gating when confirming the checks.`);
      let group = null;
      if (check.then_group !== undefined) {
        if (!Array.isArray(check.then_group) || check.then_group.length < 2 || check.then_group.length > GROUP_LIMIT) {
          fail(`${label}: then_group lists 2 to ${GROUP_LIMIT} THEN or AND lines of its scenario that can only fail together.`);
        } else {
          const keys = check.then_group.map((value, index) => bind(`${label} then_group entry ${index + 1}`, value));
          if (keys.every((key) => key !== null)) {
            if (new Set(keys).size !== keys.length) fail(`${label}: then_group names a line more than once.`);
            else group = keys;
          }
        }
      }
      const codeKind = kind === CODE_TEST ? { kind: CODE_TEST } : {};
      if (check.then === undefined && check.then_group === undefined) fail(`${label} is gating, so it needs then: the THEN or AND line of its scenario it verifies.`);
      else if (check.then !== undefined) {
        const key = bind(label, check.then);
        if (key !== null && group && !group.includes(key)) fail(`${label}: then "${check.then}" is not one of its then_group lines.`);
        else if (key !== null && !group) add(bound, key, { check: check.id, expect: check.expect, ...codeKind });
      }
      if (group) {
        const texts = group.map((key) => lineTexts.get(key));
        for (const key of group) add(bound, key, { check: check.id, expect: check.expect, group: texts, ...codeKind });
        summary.then_groups.push({ check: check.id, lines: texts });
      }
    } else {
      if (!requirements.has(check.intent)) fail(`${label} cites ${check.intent ?? 'no requirement'}, which is not in the Spec. Every check needs a source.`);
      if (current && check.then_group !== undefined) fail(`${label}: then_group belongs to a gating check; a diagnostic check covers no line.`);
      // A diagnostic check may cite a line, but it covers none. A judge's line is the user's.
      if (current && check.then !== undefined && kind !== JUDGE) {
        const key = bind(label, check.then);
        if (key !== null) add(cited, key, { check: check.id, expect: check.expect });
      }
      if (!current && check.role === 'gating' && summary.scenario && requirements.has(check.intent) && check.intent !== summary.scenario.requirement) {
        warn(`${item.id}: gating check ${check.id} cites ${check.intent}, not ${summary.scenario.requirement}, the requirement of its scenario. checks.json 1.1 refuses that: a gating check verifies a line of its own scenario.`);
      }
    }
    if (current && kind === CODE_TEST) {
      const command = programOf(label, 'command', check.command, check.at, ['code/']);
      const seconds = secondsOf(label, check);
      if (command) {
        summary.code_tests.push({ check: check.id, role: check.role, command, timeout_sec: seconds, ...(nonempty(check.at) ? { at: check.at } : {}) });
        calls.push({ check, fn: check.role === 'gating' ? 'gate_code' : 'note_code', program: command, seconds });
      }
    }
    if (current && kind === JUDGE) {
      const program = programOf(label, 'program', check.program, check.at, ['judges/', 'shared/judges/']);
      const seconds = secondsOf(label, check);
      let key = null;
      if (check.then === undefined) fail(`${label} is a judge, so it needs then: the line of scenario.manual it judges.`);
      else {
        key = bind(label, check.then);
        if (key !== null && !manual.has(key)) fail(`${label} is a judge, so then names a line the user judges, and "${lineTexts.get(key)}" is not in scenario.manual.`);
      }
      if (key !== null && manual.has(key)) add(judgedBy, key, { check: check.id, ...(program ? { program } : {}) });
      if (program) {
        summary.judges.push({ case: item.id, check: check.id, then: key !== null ? lineTexts.get(key) : check.then ?? null, program, timeout_sec: seconds, ...(nonempty(check.at) ? { at: check.at } : {}) });
        calls.push({ check, fn: 'judge', program, seconds });
      }
    }
    if (steps.length ? !steps.includes(check.at) : check.at !== undefined) {
      fail(steps.length ? `${label} needs at: one of ${steps.join(', ')}.` : `${label} has at, but the package has no steps.`);
    } else if (steps.length) summary.check_at[check.id] = check.at;
    summary.checks += 1;
    if (check.role === 'gating') summary.gating += 1;
  }
  for (const [key, entries] of bound) {
    if (manual.has(key)) {
      fail(`"${lineTexts.get(key)}" is in scenario.manual and verified by gating check ${entries.map((entry) => entry.check).join(', ')}. A line is judged by a check or by the user, not both.`);
    }
  }
  // Each code test and judge runs only through its line in the test.sh of its step.
  for (const call of calls) {
    const script = scriptOf(call.check.at);
    if (!filled(path.join(directory, script))) continue;
    const found = helperCalls(read(script)).filter((entry) => entry.id === call.check.id && entry.fn === call.fn
      && path.posix.normalize(String(entry.program ?? '').replace(/^\.\/+/, '')) === call.program);
    if (!found.length) fail(`check ${call.check.id}: ${script} has no line \`${call.fn} ${call.check.id} ${call.program}${call.seconds === PROGRAM_SECONDS ? '' : ` ${call.seconds}`}\`, so the helper never runs it.`);
    else if (found.some((entry) => (entry.seconds ?? PROGRAM_SECONDS) !== call.seconds)) fail(`check ${call.check.id}: ${script} runs ${call.program} with another timeout than its timeout_sec, ${call.seconds} seconds.`);
  }
  // A check of one step is recorded by that step's test.sh only.
  if (steps.length) {
    const at = new Map(list(checks.checks).filter((check) => record(check) && nonempty(check.id)).map((check) => [check.id, check.at]));
    for (const step of steps) {
      const elsewhere = [...new Set(helperCalls(read(`steps/${step}/tests/test.sh`)).map((entry) => entry.id).filter((id) => at.has(id) && at.get(id) !== step))];
      if (elsewhere.length) fail(`steps/${step}/tests/test.sh records ${elsewhere.join(', ')}, whose at is another step. Each step's test.sh records only the checks at that step.`);
    }
  }
  summary.manual = manual.size;
  const keyed = [...lineTexts].map(([key, text]) => {
    const status = !current ? 'unbound' : bound.has(key) ? 'gating' : manual.has(key) ? 'manual' : 'uncovered';
    return [key, { then: text, status, gating: bound.get(key) ?? [], diagnostic: cited.get(key) ?? [], judges: judgedBy.get(key) ?? [],
      ...(status === 'manual' && manual.get(key) ? { reason: manual.get(key) } : {}) }];
  });
  summary.lines = keyed.map(([, row]) => row);
  const allManual = lineTexts.size > 0 && [...lineTexts.keys()].every((key) => manual.has(key));
  if (!summary.gating && !(current && allManual)) {
    fail(current ? 'At least one gating check is required, unless scenario.manual lists every THEN and AND line of the scenario.' : 'At least one gating check is required.');
  }
  // A fixture replaces the agent with a script, or the code with a patch, so
  // the real verifier can be shown to tell a right result, a wrong one and
  // missing evidence apart.
  const produced = new Map([...ids].map((id) => [id, new Set()]));
  const names = new Set();
  // The fixtures a reviewer wrote, as candidates for counterexamples.
  const reviewed = [];
  const fixturesRoot = path.join(directory, 'tests/fixtures');
  if (!Array.isArray(checks.fixtures)) fail('fixtures must be a list; use [] until the verifier is written.');
  for (const fixture of list(checks.fixtures)) {
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
    if (fixture.kind !== undefined && !FIXTURE_KINDS.includes(fixture.kind)) fail(`${label}: kind must be ${FIXTURE_KINDS.join(' or ')}.`);
    if (fixture.patch !== undefined && (!nonempty(fixture.patch) || !within(fixturesRoot, path.resolve(directory, fixture.patch)))) {
      fail(`${label}: patch is a path, from the package's folder, under tests/fixtures/.`);
    }
    // The line a counterexample breaks, when it names one.
    const line = current && fixture.then !== undefined ? bind(label, fixture.then) : null;
    if (names.has(fixture.name)) fail(`Duplicate fixture name: ${fixture.name}`);
    names.add(fixture.name);
    const form = fixtureForm(directory, fixture, steps);
    for (const problem of form.problems) fail(`${label}: ${problem}.`);
    summary.fixture_digests[fixture.name] = fixtureDigest(directory, fixture);
    if (form.patch) summary.code_patches.push(fixture.name);
    for (const [id, result] of Object.entries(fixture.expect)) produced.get(id).add(result);
    if (current && REVIEWERS.includes(fixture.origin)) reviewed.push({ ...fixture, line, patch: form.patch });
  }
  // A counterexample of a line is a reviewer's fixture that fails only that
  // line: every gating check bound to it fails, and every other gating check
  // of the package passes or cannot tell. It names every gating check, so it
  // says what it expects of each, but a script may leave out a code test of
  // another line, whose result rests on the code, not on the script. A line
  // a then_group check shares with others needs a counterexample of its own
  // that names it in then. A line a code test checks needs a code patch.
  const gatingChecks = list(checks.checks).filter((check) => record(check) && check.role === 'gating' && ids.has(check.id));
  const gatingIds = gatingChecks.map((check) => check.id);
  const codeIds = new Set(gatingChecks.filter((check) => check.kind === CODE_TEST).map((check) => check.id));
  for (const [key, row] of keyed) {
    if (row.status !== 'gating') { row.counterexamples = []; continue; }
    const own = new Set(row.gating.map((entry) => entry.check));
    const grouped = row.gating.some((entry) => entry.group);
    const code = row.gating.some((entry) => entry.kind === CODE_TEST);
    row.counterexamples = reviewed.filter((fixture) => (fixture.line === null ? fixture.then === undefined && !grouped : fixture.line === key)
      && (!code || fixture.patch)
      && gatingIds.every((id) => (own.has(id) ? fixture.expect[id] === 'fail'
        : codeIds.has(id) && !fixture.patch && fixture.expect[id] === undefined ? true : ['pass', 'unknown'].includes(fixture.expect[id]))))
      .map((fixture) => ({ fixture: fixture.name, origin: fixture.origin, ...(fixture.patch ? { code_patch: true } : {}) }));
    if (grouped) row.grouped = true;
    if (code) row.code_test = true;
  }
  if (!has('task.toml')) fail('task.toml is missing.');
  // Whether the package can run is worked out here, never declared by its author.
  const missing = [];
  const detail = [];
  const lack = (what, why) => { missing.push(what); detail.push(`${what}: ${why}`); };
  const written = (file) => filled(path.join(directory, file));
  const inputs = steps.length ? steps.map((step) => `steps/${step}/instruction.md`) : ['instruction.md'];
  const unwritten = inputs.filter((file) => !written(file));
  if (unwritten.length) lack('instruction', `${unwritten.join(', ')} ${unwritten.length === 1 ? 'is' : 'are'} missing or still the template: the exact input the evaluated agent receives`);
  // The sealed docker-compose.yaml `eval new` writes builds nothing by itself.
  const composeBuilds = () => {
    const { compose } = readCompose(path.join(directory, 'environment/docker-compose.yaml'));
    return record(compose?.services) && Object.values(compose.services).some((service) => record(service) && service.build !== undefined && service.build !== null);
  };
  if (!has('environment/Dockerfile') && !(has('environment/docker-compose.yaml') && composeBuilds())) {
    lack('environment', has('environment/docker-compose.yaml')
      ? 'environment/docker-compose.yaml builds no service and there is no environment/Dockerfile'
      : 'there is no environment/Dockerfile or docker-compose.yaml');
  }
  const scripts = steps.length ? steps.map((step) => `steps/${step}/tests/test.sh`) : ['tests/test.sh'];
  const unscripted = scripts.filter((file) => !written(file));
  if (unscripted.length) lack('verifier', `${unscripted.join(', ')} ${unscripted.length === 1 ? 'is' : 'are'} missing or still the template checks`);
  // The verifier's own files, but the fixtures and the copy of the kit's
  // verifier/, which validateEval reads once from the kit.
  const verifierFiles = executed(directory, 'Task.md').filter((file) => {
    const relative = relativeOf(directory, file);
    return /^(?:steps\/[^/]+\/)?tests\//.test(relative) && !/^(?:steps\/[^/]+\/)?tests\/(?:fixtures|shared)\//.test(relative);
  });
  const agentLogs = namesAgentLogs(directory, verifierFiles);
  if (agentLogs.length) warn(`${item.id}: ${agentLogs.join(', ')} ${agentLogs.length === 1 ? 'names' : 'name'} ${AGENT_LOGS_TEXT}`);
  if (!adapter) lack('kit', 'no adapter: neither the kit\'s harness.json nor the package\'s names an agent');
  // The results a fixture proves of each gating check, but of a code test,
  // whose results rest on the code: a baseline failure or a code patch proves
  // it can fail, and an accepted run that it passes.
  const uncovered = [...produced].filter(([id]) => gatingIds.includes(id) && !codeIds.has(id))
    .flatMap(([id, results]) => RESULTS.filter((result) => !results.has(result)).map((result) => `${id} ${result}`));
  // In checks.json 1.1 the full tier asks a fixture of one kind only: an
  // unknown, with the scenario run but its evidence missing, for each gating
  // check that asserts absence and for each gating check of a live package.
  // Harbor's nop agent never runs the scenario, so the probe cannot show what
  // such a check does when the evidence cannot be read, and "none were sent"
  // passes on missing evidence.
  const triggered = current ? gatingChecks.filter((check) => check.kind !== CODE_TEST && (check.absence === true || summary.live))
    .filter((check) => !produced.get(check.id)?.has('unknown')).map((check) => `${check.id}${check.absence === true ? ' (asserts absence)' : ' (live package)'}`) : [];
  const unreviewed = summary.lines.filter((row) => row.status === 'gating' && !row.counterexamples.length);
  // What the tier decides is left to finishCase, once the tier of the whole
  // change is known.
  summary.pending = { missing, detail, current, uncovered, triggered, unreviewed, last: readCheckRecord(repo, name, item.id) };
  return summary;
}

// Whether a package can run, by the tier whose rules the change is held to.
// Both tiers prove "cannot tell when nothing happened" by the probe of
// `eval check`: every gating check but a code test came out unknown when
// Harbor's nop agent did nothing, with the package as it runs. Pass is
// proved by the accepted run. In the full tier every line a program checks
// also needs a reviewer's counterexample, and each gating check that asserts
// absence, or belongs to a live package, a fixture that leaves it unknown
// with the scenario run (triggered). In the light tier, which holds only for
// code whose result is fixed, each line's proof that its checks can fail is
// asked for when the user confirms the checks (line_unproven), and again at
// acceptance. Fixtures written anyway are still proved. Task.md and the
// kit's PROJECT.md are notes, never a condition. A package in checks.json
// 1.0 is held to the full tier of 0.2.0: a fixture for each result of every
// gating check but a code test, and a counterexample for every line.
function finishCase(summary, tier) {
  const pending = summary.pending;
  delete summary.pending;
  if (!pending) return;
  const missing = [...pending.missing];
  const detail = [...pending.detail];
  const lack = (what, why) => { missing.push(what); detail.push(`${what}: ${why}`); };
  const light = tier === 'light' && pending.current;
  if (!light) {
    if (!pending.current && pending.uncovered.length) lack('fixtures', `no fixture expects ${pending.uncovered.join(', ')}`);
    if (pending.current && pending.triggered.length) {
      lack('fixtures', `no fixture leaves ${pending.triggered.join(', ')} unknown with the scenario run and its evidence missing; the probe never runs the scenario, so it cannot show this`);
    }
    // Every line a program checks needs a counterexample from a reviewer, which
    // eval check then proves the verifier rejects.
    if (pending.unreviewed.length) missing.push('review');
    for (const row of pending.unreviewed) {
      detail.push(`review: no reviewer counterexample fails only "${row.then}"${row.code_test ? ', as a code patch the line\'s code tests fail on' : ''}${row.grouped ? ', naming the line in its then, since a then_group check shares it' : ''}`);
    }
  }
  if (!missing.length) {
    const stale = [...new Set([fixtureStale(pending.last, summary), ...(pending.current ? [probeStale(pending.last, summary)] : [])].filter(Boolean))];
    if (stale.length) lack('check', `\`eval check\` has not proved the package as it is: ${stale.join('; ')}`);
  }
  summary.integration = { state: missing.length ? 'awaiting_integration' : 'ready', missing, detail };
}

// Read-only. Structure and sources are checked here; whether an expectation is
// faithful to the Spec and whether a verifier is sound stay with the author.
// The packages are read against the current export, or, when the Spec
// validates and is not exported, against its draft (draft): a package bound
// to the draft is draft_bound. Coverage is worked out per scenario, across
// every package of it.
export function validateEval(repo, name) {
  const root = path.join(eddDirectory(repo, name), 'evals');
  const frozen = frozenSpec(repo, name);
  const gaps = frozen.gaps.map((gap) => passedOn(gap));
  const draft = frozen.handoff ? null : draftHandoff(repo, name, frozen);
  const source = frozen.handoff ? { id: frozen.handoff.id, handoff: frozen.handoff.handoff, draft: false } : draft;
  const warnings = [];
  const ignored = ignoredArtifacts(repo, name).warning;
  if (ignored) warnings.push(ignored);
  // One row per THEN or AND line of each package's scenario.
  const thenLines = [];
  // The tier the change qualifies for with the model harness.json names; a
  // checks confirmation adds the model of its run plan. readiness is the tier
  // whose rules decide which packages are ready (finishCase).
  const kitModel = harnessSettings(kitDirectory(repo)).model;
  const report = (cases = [], coverage = null, tier = null) => {
    const structural = gaps.filter((gap) => gap.kind !== 'business' && !['integration_pending', 'draft_bound'].includes(gap.code));
    const runnable = cases.filter((item) => item.integration?.state === 'ready' && item.status === 'confirmed' && !item.errors.length && !item.draft_bound);
    return {
      change: name, valid: structural.length === 0,
      business_ready: gaps.every((gap) => gap.code === 'integration_pending'),
      ready_for_run: structural.length === 0 && runnable.length > 0 && gaps.every((gap) => gap.code === 'integration_pending'),
      spec: frozen.handoff ? frozen.handoff.id : null,
      draft: draft ? { id: draft.id } : null,
      map: source?.handoff.context?.map?.status === 'available' ? source.handoff.context.map : null,
      tier: tier ?? { ...changeTier(repo, cases, kitModel), readiness: 'full' },
      cases, coverage, then_lines: thenLines, gaps, warnings,
    };
  };
  if (!source) return report();
  if (draft) warnings.push(`The Spec is not exported: the packages are read against its draft (${short(draft.id)}), and a package bound to the draft can be validated and proved, never confirmed, baselined or run.`);
  const scenarios = scenariosOf(source.handoff);
  const items = readCases(root);
  const evalsPath = `.genesis/edd/${name}/evals`;
  if (!items.length) {
    gaps.push(gapOf('cases_missing', 'package', 'agent', 'artifact', 'No eval packages yet: each scenario of the Spec needs one.', { path: evalsPath }));
    return report();
  }
  const kit = readKit(repo);
  const ignoreFile = localPath(repo, '.dockerignore');
  const dockerignore = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
  const resolved = path.resolve(repo);
  const context = { repo: resolved, handoff: source.handoff, name, dockerignore, kit, source, protected: protectedRoots(resolved, kit.directory) };
  const cases = [];
  const gated = new Set();
  const seen = new Set();
  const legacy = [];
  // Every package is read first: which packages are ready depends on the tier
  // of the whole change, and a line's coverage on every package of its scenario.
  const validated = items.map((item) => {
    const errors = [];
    const issues = [];
    const summary = validateCase(context, item, (message) => errors.push(message), (message) => warnings.push(message),
      (code, message, facts) => issues.push({ code, message, facts }));
    return { item, summary, errors, issues };
  });
  const tier = changeTier(repo, validated.map((entry) => entry.summary), kitModel, { name, spec: source.id });
  const readiness = readinessTier(repo, name, source.id, validated.map((entry) => entry.summary), tier.eligible);
  const mismatches = sharedCodeMismatches(repo, name, items.map((item) => item.id));
  // The packages bound to the Spec read here, by scenario, with their rows.
  const perScenario = new Map();
  const counted = [];
  for (const { item, summary, errors, issues } of validated) {
    finishCase(summary, readiness);
    const { lines: rows, ...shown } = summary;
    cases.push({ ...shown, errors: [...errors, ...issues.map((entry) => entry.message)] });
    const where = `${evalsPath}/${item.id}`;
    for (const message of errors) {
      gaps.push(gapOf('case_invalid', 'package', 'agent', 'technical', `${item.id}: ${message}`, { case: item.id, path: where }));
    }
    for (const entry of issues) {
      gaps.push(gapOf(entry.code, 'package', 'agent', 'technical', `${item.id}: ${entry.message}`, { case: item.id, ...entry.facts, path: entry.facts?.path ?? where }));
    }
    const own = mismatches.filter((entry) => entry.case === item.id);
    if (own.length) {
      gaps.push(gapOf('shared_code_mismatch', 'package', 'agent', 'artifact',
        `${item.id}: ${own.map((entry) => entry.file).join(', ')} ${own.length === 1 ? 'differs' : 'differ'} from the shipped helper and the kit's verifier/ folder, so the package would not run the shared verifier code a review reads. Shared verifier code is edited in the kit; \`eval sync\` writes it into the package.`,
        { case: item.id, path: where, files: own.map((entry) => entry.file), mismatches: own }));
    }
    if (!record(item.checks)) continue;
    const bound = item.checks.spec_ref?.sha256;
    if (nonempty(bound) && bound !== source.id) {
      gaps.push(gapOf('case_stale', 'package', 'agent', 'technical',
        `${item.id} is bound to another Spec (${short(bound)}${item.checks.spec_ref?.draft === true ? ', a draft' : ''}) than the one read here (${short(source.id)}${source.draft ? ', the draft' : ''}). Its old expectations do not carry over by themselves: each then and scenario.manual entry is checked again against the current scenario.`,
        { case: item.id, path: `${where}/tests/checks.json`, bound_to: summary.bound_to, current: source.id }));
      continue;
    }
    if (summary.draft_bound) {
      gaps.push(gapOf('draft_bound', 'package', 'agent', 'artifact',
        `${item.id} is bound to a Spec draft (${short(bound)}), not to an export: it can be validated and proved, and nothing confirms, baselines or runs it until it is bound to an export.`,
        { case: item.id, path: `${where}/tests/checks.json`, draft: bound }));
    }
    if (summary.scenario) {
      const key = scenarioKey(summary.scenario);
      const group = perScenario.get(key) ?? { requirement: summary.scenario.requirement, scenario: summary.scenario.name, packages: [] };
      group.packages.push({ id: item.id, rows });
      perScenario.set(key, group);
      counted.push({ id: item.id, key, rows });
      seen.add(key);
    }
    if (summary.schema_version === '1.0') legacy.push(item.id);
    for (const check of Array.isArray(item.checks.checks) ? item.checks.checks : []) if (check?.role === 'gating') gated.add(check.intent);
    if (item.checks.status === 'draft') {
      gaps.push(gapOf('case_draft', 'spec', 'user', 'business',
        `${item.id} holds an expectation the Spec does not state (status draft in tests/checks.json). Whether the business accepts it is the user's decision, settled in the Spec.`,
        { case: item.id, path: `${where}/tests/checks.json` }));
    }
    if (summary.integration?.state === 'awaiting_integration') {
      const kitOnly = summary.integration.missing.every((entry) => entry === 'kit');
      gaps.push(gapOf('integration_pending', kitOnly ? 'kit' : 'package', 'agent', 'artifact', `${item.id} is not runnable yet. ${summary.integration.detail.join('; ')}.`,
        { case: item.id, path: where, missing: summary.integration.missing }));
    }
  }
  // Coverage across the packages of each scenario: a line is checked when a
  // gating check of any of them verifies it, and judged by the user when one
  // of them lists it in scenario.manual; never both.
  const lineStates = new Map();
  for (const [key, group] of perScenario) {
    const states = new Map();
    for (const pkg of group.packages) {
      for (const row of pkg.rows) {
        const line = thenKey(row.then);
        const state = states.get(line) ?? { text: row.then, gating: [], manual: [], open: [], unbound: [] };
        if (row.status === 'gating') state.gating.push(pkg.id);
        else if (row.status === 'manual') state.manual.push(pkg.id);
        else if (row.status === 'uncovered') state.open.push(pkg.id);
        else if (row.status === 'unbound') state.unbound.push(pkg.id);
        states.set(line, state);
      }
    }
    lineStates.set(key, states);
    for (const state of states.values()) {
      if (state.gating.length && state.manual.length) {
        gaps.push(gapOf('then_conflict', 'package', 'agent', 'technical',
          `"${state.text}" of scenario "${group.scenario}" is verified by a gating check of ${state.gating.join(', ')} and listed in scenario.manual of ${state.manual.join(', ')}. A line is judged by a check or by the user, not both.`,
          { case: state.gating[0], cases: [...state.gating, ...state.manual], requirement_id: group.requirement, scenario: group.scenario, then: state.text }));
      }
      if (!state.gating.length && !state.manual.length && state.open.length) {
        gaps.push(gapOf('then_uncovered', 'package', 'agent', 'artifact',
          `No gating check of a package of scenario "${group.scenario}" verifies "${state.text}", and none lists it in scenario.manual. A diagnostic check covers no line.`,
          { case: state.open[0], cases: state.open, path: `${evalsPath}/${state.open[0]}/tests/checks.json`, requirement_id: group.requirement, scenario: group.scenario, then: state.text }));
      }
    }
  }
  for (const { id, key, rows } of counted) {
    const group = perScenario.get(key);
    const states = lineStates.get(key);
    for (const row of rows) {
      const state = states.get(thenKey(row.then));
      const elsewhere = row.status === 'uncovered' && (state.gating.length || state.manual.length);
      thenLines.push({ case: id, requirement: group.requirement, scenario: group.scenario, ...row,
        ...(elsewhere ? { status: 'elsewhere', covered_by: [...state.gating, ...state.manual] } : {}) });
    }
  }
  // One count per line of a scenario, across its packages.
  const unique = [...lineStates.values()].flatMap((states) => [...states.values()]);
  const statusOf = (state) => (state.gating.length ? 'gating' : state.manual.length ? 'manual' : state.open.length ? 'uncovered' : 'unbound');
  // Requirements with a scenario whose every line is the user's to judge.
  const judged = new Set();
  for (const [key, states] of lineStates) {
    const all = [...states.values()];
    if (all.length && all.every((state) => statusOf(state) === 'manual')) judged.add(perScenario.get(key).requirement);
  }
  if (legacy.length) {
    const one = legacy.length === 1;
    warnings.push(`${legacy.join(', ')} ${one ? 'uses' : 'use'} checks.json 1.0: ${one ? 'its' : 'their'} checks do not name the THEN lines they verify, so whether every line is checked is not known, and ${one ? 'it has' : 'they have'} no reviewer counterexamples. \`eval confirm\` needs 1.1, and \`loop start\` refuses 1.0 packages. Upgrading changes ${one ? 'the package' : 'each package'}, so a baseline recorded before it compares nothing with ${one ? 'it' : 'them'}.`);
  }
  const manual = thenLines.filter((row) => row.status === 'manual');
  if (manual.length) {
    const one = manual.length === 1;
    warnings.push(`The user judges ${one ? 'this THEN line' : 'these THEN lines'} at acceptance, since no check verifies ${one ? 'it' : 'them'}: ${manual.map((row) => `"${row.then}" in ${row.case} (${row.reason})${row.judges?.length ? `, with judge ${row.judges.map((entry) => entry.check).join(', ')} recorded for diagnosis` : ''}`).join('; ')}.`);
  }
  // Checks bind the text, so a line written twice in a scenario is one line.
  for (const item of scenarios) {
    const counts = new Map();
    for (const text of item.then) counts.set(thenKey(text), [...(counts.get(thenKey(text)) ?? []), text]);
    for (const [, texts] of counts) {
      if (texts.length > 1) warnings.push(`Scenario "${item.name}" of ${item.requirement} lists "${texts[0]}" more than once. Checks bind the text, so the copies count as one line.`);
    }
  }
  if (!gated.size && judged.size) {
    warnings.push('No package of this change has a gating check: the user judges every THEN line. A run passes only on gating checks, so no run of this change can pass, and `loop start` refuses it (gating_missing).');
  }
  const untold = cases.filter((item) => !item.task_md && item.dependencies.length).map((item) => item.id);
  if (untold.length) {
    warnings.push(`${untold.join(', ')} ${untold.length === 1 ? 'declares dependencies and has' : 'declare dependencies and have'} no Task.md, so how the environment differs from production and the choices the Spec does not state are not on record. Its headings: ${TASK_HEADINGS.join('; ')}.`);
  }
  if (!kit.notes) warnings.push('The kit\'s PROJECT.md is missing or still the template: nothing records how the program is started, its dependencies or the known traps for the next package.');
  const kitVerifier = path.join(kit.directory, 'verifier');
  const kitAgentLogs = namesAgentLogs(kitVerifier, ownFiles(kitVerifier).filter((file) => !file.split(path.sep).includes('__pycache__')));
  if (kitAgentLogs.length) warnings.push(`The kit's ${kitAgentLogs.map((file) => `verifier/${file}`).join(', ')} ${kitAgentLogs.length === 1 ? 'names' : 'name'} ${AGENT_LOGS_TEXT}`);
  const uncovered = scenarios.filter((item) => !seen.has(scenarioKey(item)));
  for (const item of uncovered) {
    gaps.push(gapOf('scenario_uncovered', 'package', 'agent', 'artifact', `No package for scenario "${item.name}" of ${item.requirement}.`,
      { requirement_id: item.requirement, scenario: item.name, path: evalsPath }));
  }
  // A requirement whose 1.1 packages leave every line to the user needs no gating check.
  const ungated = source.handoff.requirements.filter((requirement) => !gated.has(requirement.id) && !judged.has(requirement.id)).map((requirement) => requirement.id);
  for (const id of ungated) {
    gaps.push(gapOf('requirement_uncovered', 'package', 'agent', 'artifact', `${id} has no gating check. Every accepted requirement needs one before the change can pass.`,
      { requirement_id: id, path: evalsPath }));
  }
  const count = (status) => unique.filter((state) => statusOf(state) === status).length;
  return report(cases, { scenarios: scenarios.length, covered: scenarios.length - uncovered.length, requirements_without_gating_check: ungated,
    lines: { total: unique.length, gating: count('gating'), manual: count('manual'), uncovered: count('uncovered'), unbound: count('unbound') } },
  { ...tier, readiness });
}
