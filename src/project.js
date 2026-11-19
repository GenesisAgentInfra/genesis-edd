import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SCHEMA = 'genesis-spec';
export const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function writeJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

export function projectRoot(repo) {
  const root = realpathSync(path.resolve(repo));
  if (!lstatSync(root).isDirectory()) throw new Error('Project path must be a directory.');
  return root;
}

// Generated files stay in the selected project, including on repeated installs.
export function localPath(repo, relative) {
  const target = path.resolve(repo, relative);
  if (!target.startsWith(`${repo}${path.sep}`)) throw new Error('Path escapes the project.');
  let current = target;
  while (current !== repo) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing generated path through a symlink: ${current}`);
    }
    current = path.dirname(current);
  }
  return target;
}

export function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not a spec artifact: ${file}`);
      return entry.isDirectory() ? listFiles(file) : [file];
    });
}

export function openspec(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules/@fission-ai/openspec/bin/openspec.js'), ...args,
  ], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`OpenSpec failed: ${result.stderr || result.stdout}`);
  }
  let data;
  try { data = JSON.parse(result.stdout); } catch {
    throw new Error(`OpenSpec did not return JSON: ${result.stderr || result.stdout}`);
  }
  return { ok: result.status === 0, data };
}

export function requireProject(repo) {
  const configFile = localPath(repo, 'openspec/config.yaml');
  if (!existsSync(configFile)) throw new Error('Run genesis-edd init first.');
  const config = parse(readFileSync(configFile, 'utf8'));
  if (config?.store) throw new Error('Genesis EDD v0.1 requires project-local OpenSpec artifacts; external stores are not supported.');
  const file = localPath(repo, 'openspec/genesis.json');
  const project = readJSON(file);
  if (project.version !== 1 || !['new', 'existing'].includes(project.mode)) {
    throw new Error('Invalid openspec/genesis.json.');
  }
  return project;
}

export function initProject(repo, mode, agent) {
  if (!['new', 'existing'].includes(mode)) throw new Error('--mode must be new or existing.');
  if (!['codex', 'claude', 'both', 'none'].includes(agent)) throw new Error('--agent must be codex, claude, both or none.');
  const writes = [];
  const add = (relative, content) => writes.push({ file: localPath(repo, relative), content });
  const configFile = localPath(repo, 'openspec/config.yaml');
  if (existsSync(configFile)) {
    const config = parse(readFileSync(configFile, 'utf8'));
    if (!config || typeof config !== 'object' || config.store) {
      throw new Error('Expected project-local OpenSpec config without a store pointer.');
    }
  } else add('openspec/config.yaml', `schema: ${SCHEMA}\n`);
  add('openspec/genesis.json', `${JSON.stringify({ version: 1, mode }, null, 2)}\n`);
  const schemaRoot = path.join(ROOT, 'schemas', SCHEMA);
  for (const file of listFiles(schemaRoot)) {
    add(`openspec/schemas/${SCHEMA}/${path.relative(schemaRoot, file)}`, readFileSync(file, 'utf8'));
  }
  const agentDirs = agent === 'both' ? ['.agents', '.claude'] : agent === 'none' ? [] : [agent === 'codex' ? '.agents' : '.claude'];
  const skillRoot = path.join(ROOT, 'skills/genesis-spec');
  for (const directory of agentDirs) {
    for (const file of listFiles(skillRoot)) {
      add(`${directory}/skills/genesis-spec/${path.relative(skillRoot, file)}`, readFileSync(file, 'utf8'));
    }
    add(`${directory}/skills/genesis-spec/scripts/runtime.json`, `${JSON.stringify({ cli: path.join(ROOT, 'bin/genesis-edd.js') }, null, 2)}\n`);
  }
  // Check the entire install before writing anything; never replace custom files.
  for (const { file, content } of writes) {
    if (existsSync(file) && readFileSync(file, 'utf8') !== content) {
      throw new Error(`Existing file differs; left unchanged: ${file}`);
    }
  }
  const created = [];
  for (const { file, content } of writes) {
    if (existsSync(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx' });
    created.push(path.relative(repo, file));
  }
  for (const directory of ['openspec/specs', 'openspec/changes']) {
    mkdirSync(localPath(repo, directory), { recursive: true });
  }
  return { repo, mode, agent, created, schema: openspec(repo, ['schema', 'validate', SCHEMA, '--json']).data };
}

export function changeDirectory(repo, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name === 'archive') {
    throw new Error('Change name must be lowercase kebab-case and cannot be archive.');
  }
  return localPath(repo, `openspec/changes/${name}`);
}

export function captureContext(repo, mode, mapFile) {
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const head = git(['rev-parse', '--verify', 'HEAD']);
  const workingTree = git(['status', '--porcelain']);
  let map = { status: mode === 'new' ? 'not_applicable' : 'missing', reason: mode === 'new' ? 'new_project' : 'not_provided' };
  if (mapFile) {
    const file = path.resolve(repo, mapFile);
    const content = readFileSync(file, 'utf8');
    const document = JSON.parse(content);
    if (typeof document.snapshot_id !== 'string' || !document.snapshot_id || !['complete', 'partial'].includes(document.analysis_status)) {
      throw new Error('Map must be a Genesis business-map.json with snapshot_id and analysis_status.');
    }
    map = {
      status: 'available', path: path.relative(repo, file), sha256: digest(content),
      snapshot_id: document.snapshot_id, analysis_status: document.analysis_status,
      freshness: 'unverified',
    };
  }
  return {
    version: 1, project_mode: mode,
    code: { base_commit: head, working_tree_dirty: workingTree === null ? null : workingTree !== '', captured_at: new Date().toISOString() },
    map,
    baseline: { status: 'not_run', availability: mode === 'new' ? 'no_implementation' : 'unknown' },
  };
}
