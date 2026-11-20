import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SCHEMA = 'genesis-spec';
// Exact files shipped before the public skill was renamed to agent-spec.
const LEGACY_SCHEMA_HASH = 'sha256:a9390e43cec50f174f66d045c5c9c4e5515287e5e55d4ed1efdf26ef21d2b016';
const LEGACY_SKILL_HASHES = {
  'SKILL.md': 'sha256:f9e1f45e779069c9d74459b5df4dcf6e3ccac756e3a5424fc4171ce716cf6ffb',
  'agents/openai.yaml': 'sha256:52b4b1a715ed8689382c0a6dd79c4d036b819e46c8b3e9e30934c168111b1047',
  'references/spec-format.md': 'sha256:b0945ecd8c3ed0d0f7ddcfd13a0ce69433ed2a6f741981e7c3a1c46e8ff063a1',
  'scripts/run.mjs': 'sha256:881a4b48652d858fa99c6cccacd9549910b64631152884beef6bb88a70fc1e9a',
  'scripts/.gitignore': 'sha256:141fc8419b0378e8ff6d3161f01cb89a1165dc7b7230df4448f63bb3797d2735',
};
export const SKILLS = ['agent-spec', 'write-eval', 'run-eval', 'loop-and-implement'];
// Earlier shipped versions of skill and schema files. init updates an untouched
// copy and still refuses to replace an edited one. Add the outgoing hash here
// whenever a shipped file changes.
const PREVIOUS_SCHEMA_HASHES = [LEGACY_SCHEMA_HASH, 'sha256:196585c6747f342958a2ebf70b2e29b312664302c0d79e6b15f658b549a2371b',
  'sha256:2ca194edb19cc4fc87b9d6ef6c58b31f9b75ce49bdde17b970697182d70f89fc'];
const PREVIOUS_SKILL_HASHES = {
  'agent-spec/SKILL.md': [
    'sha256:125c0caf12be5e2e0dac8bb9758105173260d842e9cfe144f3b4d38a1ebc7871',
    'sha256:3cf1a64417fefb329d1a099070c461172a6ae2d7d495fa1a1f1cfdb6aaad9fb5',
    'sha256:f75b8f0f8992fdeb62442b8b3c0cbac772c783a4069d9072a43722e0b307c2a5',
    'sha256:33663ac9eb83b705a9cfd2fcc11fe78805082404804fed590f163d91e1f0ba09',
    'sha256:9d037e3bc2c705df8abf1ecc8a64d9bd56397b9aeca081ffe34f1017932d5993',
  ],
  'agent-spec/scripts/run.mjs': ['sha256:881a4b48652d858fa99c6cccacd9549910b64631152884beef6bb88a70fc1e9a'],
  'write-eval/SKILL.md': ['sha256:390f4c0a47e84b7d73a6317dbf9ed054d1879944fcfa38bd94016fd171bf889d'],
  'run-eval/SKILL.md': [
    'sha256:ffb9e10f3f25bffc007ed9381df23cb3d1e31b64dc8088352302158215f75ba7',
    'sha256:0f46f119fcc49a84dff2fd55274aee5ae5c80c9b4c7c99b5d3bc4999d01bded8',
  ],
  'agent-spec/references/spec-format.md': [
    'sha256:b0945ecd8c3ed0d0f7ddcfd13a0ce69433ed2a6f741981e7c3a1c46e8ff063a1',
    'sha256:99a3389ea7a87d2c61077a5f81252d39f594d6e86d5ad21f939c779020b56619',
  ],
};
// Files Genesis itself writes are not changes to the application.
const GENERATED = ['openspec/', '.genesis/', ...SKILLS.flatMap((skill) => [`.agents/skills/${skill}/`, `.claude/skills/${skill}/`])];
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
  const legacySkills = [];
  const add = (relative, content, previousHash) => writes.push({ file: localPath(repo, relative), content, previousHash });
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
    const relative = path.relative(schemaRoot, file);
    add(`openspec/schemas/${SCHEMA}/${relative}`, readFileSync(file, 'utf8'), relative === 'schema.yaml' ? PREVIOUS_SCHEMA_HASHES : undefined);
  }
  const agentDirs = agent === 'both' ? ['.agents', '.claude'] : agent === 'none' ? [] : [agent === 'codex' ? '.agents' : '.claude'];
  const runtime = `${JSON.stringify({ cli: path.join(ROOT, 'bin/genesis-edd.js') }, null, 2)}\n`;
  for (const directory of agentDirs) {
    const legacy = localPath(repo, `${directory}/skills/genesis-spec`);
    if (existsSync(legacy)) {
      const expected = { ...LEGACY_SKILL_HASHES, 'scripts/runtime.json': digest(runtime) };
      const files = listFiles(legacy);
      if (files.length !== Object.keys(expected).length || files.some((file) =>
        digest(readFileSync(file, 'utf8')) !== expected[path.relative(legacy, file).split(path.sep).join('/')])) {
        throw new Error(`Legacy skill differs; left unchanged. Review it before installing agent-spec: ${legacy}`);
      }
      legacySkills.push(legacy);
    }
    for (const skill of SKILLS) {
      const skillRoot = path.join(ROOT, 'skills', skill);
      for (const file of listFiles(skillRoot)) {
        const target = path.relative(skillRoot, file).split(path.sep).join('/');
        add(`${directory}/skills/${skill}/${target}`, readFileSync(file, 'utf8'), PREVIOUS_SKILL_HASHES[`${skill}/${target}`]);
      }
    }
    // Every skill starts the CLI through the one launcher in agent-spec.
    add(`${directory}/skills/agent-spec/scripts/runtime.json`, runtime);
  }
  // Check the entire install before writing anything; never replace custom files.
  for (const write of writes) {
    if (existsSync(write.file)) {
      const current = readFileSync(write.file, 'utf8');
      if (current !== write.content) {
        if (![write.previousHash].flat().includes(digest(current))) throw new Error(`Existing file differs; left unchanged: ${write.file}`);
        write.update = true;
      }
    }
  }
  const created = [];
  const updated = [];
  for (const { file, content, update } of writes) {
    if (update) {
      writeFileSync(file, content);
      updated.push(path.relative(repo, file));
      continue;
    }
    if (existsSync(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx' });
    created.push(path.relative(repo, file));
  }
  for (const legacy of legacySkills) rmSync(legacy, { recursive: true });
  for (const directory of ['openspec/specs', 'openspec/changes']) {
    mkdirSync(localPath(repo, directory), { recursive: true });
  }
  return { repo, mode, agent, created, updated, migrated: legacySkills.map((file) => path.relative(repo, file)), schema: openspec(repo, ['schema', 'validate', SCHEMA, '--json']).data };
}

export function changeDirectory(repo, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name === 'archive') {
    throw new Error('Change name must be lowercase kebab-case and cannot be archive.');
  }
  return localPath(repo, `openspec/changes/${name}`);
}

// Commit and application files changed since it; null where Git cannot say.
export function codeState(repo) {
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const status = git(['-c', 'core.quotepath=off', 'status', '--porcelain', '--untracked-files=all']);
  const changed = status === null ? null : status.split('\n')
    .map((line) => line.trimStart().replace(/^\S{1,2}\s+/, '').split(' -> ').pop().replace(/^"/, '').replace(/"$/, ''))
    .filter((file) => file && !GENERATED.some((prefix) => file.startsWith(prefix)));
  return { head: git(['rev-parse', '--verify', 'HEAD']), changed, git };
}

export function captureContext(repo, mode, mapFile) {
  const { head, changed } = codeState(repo);
  const workingTree = changed === null ? null : changed.join('\n');
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
