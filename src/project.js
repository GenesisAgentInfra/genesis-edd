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
    'sha256:469c2182dfc7f4e4b5c2252a28891379daaa7b4f873da1a149035aaea1e5d171',
  ],
  'agent-spec/scripts/run.mjs': ['sha256:881a4b48652d858fa99c6cccacd9549910b64631152884beef6bb88a70fc1e9a'],
  'write-eval/SKILL.md': [
    'sha256:390f4c0a47e84b7d73a6317dbf9ed054d1879944fcfa38bd94016fd171bf889d',
    'sha256:51b2afec0e56f6e2cac81c2392a56917b356e44635ff4dbda80350c0daa93e12',
  ],
  'run-eval/SKILL.md': [
    'sha256:ffb9e10f3f25bffc007ed9381df23cb3d1e31b64dc8088352302158215f75ba7',
    'sha256:0f46f119fcc49a84dff2fd55274aee5ae5c80c9b4c7c99b5d3bc4999d01bded8',
    'sha256:8559cf63ec10a5d6323d1e620ab163f6c0619018536ec5653efb4507c070d021',
    'sha256:296897d67a464063536748a9365e914689072f50cf7b0decd3aceb929bc5b7e3',
  ],
  'run-eval/references/run-records.md': [
    'sha256:0f2bafd0cf20299e5ab7d0f28ffbdbc657450d986d56cd708352ec1e761c5c61',
    'sha256:389a8ae7e97bd9e0ef6716f17c15fbddaf193a27f65bd4799cd825ef5ecd3024',
    'sha256:c187814a77aa95d7a820159ac7475d86fca61b492ac6e025494a2c443b846998',
  ],
  'write-eval/references/harbor.md': ['sha256:560385a1e4ac0c91e0a1699c52b15ef5038181ec6cc9cf3e47bedaedebbabbfa'],
  'write-eval/references/environment.md': ['sha256:50b827232d9df5f55ed603fc8d670440f5cd877b33f581b82aa7ee0768aaa964'],
  'loop-and-implement/SKILL.md': [
    'sha256:02d47d51ad3bcb6f8899622e70526fbf750a5047ce98661fd4df55e034356921',
    'sha256:1a71597ec5058d525133aec2936dec054800dc665d2769c9b1736417bce7ff9d',
  ],
  'agent-spec/references/spec-format.md': [
    'sha256:b0945ecd8c3ed0d0f7ddcfd13a0ce69433ed2a6f741981e7c3a1c46e8ff063a1',
    'sha256:99a3389ea7a87d2c61077a5f81252d39f594d6e86d5ad21f939c779020b56619',
    'sha256:7fc70e45daeb8334e30c2c40d0dd18de1f8593f3987bbc4275fba63de4af8a58',
  ],
};
// Files Genesis itself writes are not changes to the application.
const GENERATED = ['openspec/', '.genesis/', ...SKILLS.flatMap((skill) => [`.agents/skills/${skill}/`, `.claude/skills/${skill}/`])];
export const isGenerated = (file) => GENERATED.some((prefix) => file.startsWith(prefix));
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
  const add = (relative, content, previousHash, keep = false) => writes.push({ file: localPath(repo, relative), content, previousHash, keep });
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
    // The installed skills run this machine's checkout, so another clone
    // cannot use them: each one stays out of Git and every clone runs init.
    // A .gitignore of the user's own there is theirs to keep.
    for (const skill of SKILLS) add(`${directory}/skills/${skill}/.gitignore`, '*\n', undefined, true);
  }
  // Check the entire install before writing anything; never replace custom files.
  for (const write of writes) {
    if (existsSync(write.file)) {
      const current = readFileSync(write.file, 'utf8');
      if (current !== write.content && !write.keep) {
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
  // A .gitignore does not untrack files: skill folders an earlier install
  // committed stay in Git until they are removed from the index.
  const warnings = [];
  const folders = agentDirs.flatMap((directory) => SKILLS.map((skill) => `${directory}/skills/${skill}`));
  const tracked = folders.length ? spawnSync('git', ['-C', repo, 'ls-files', '-z', '--', ...folders], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) : null;
  const committed = tracked?.status === 0 ? folders.filter((folder) => tracked.stdout.split('\0').some((file) => file.startsWith(`${folder}/`))) : [];
  if (committed.length) {
    warnings.push(`Git still tracks skill folders an earlier install committed: ${committed.join(', ')}. They point at this machine's checkout, and their .gitignore does not untrack them. To keep them out of Git, run \`git rm -r --cached ${committed.join(' ')}\` and commit; the files stay on disk.`);
  }
  return { repo, mode, agent, created, updated, migrated: legacySkills.map((file) => path.relative(repo, file)), warnings, schema: openspec(repo, ['schema', 'validate', SCHEMA, '--json']).data };
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
  // -z gives every path as it is, without the quoting Git applies to names
  // with quotes, backslashes or control characters.
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  let changed = null;
  if (status.status === 0) {
    const entries = status.stdout.split('\0');
    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      files.push(entry.slice(3));
      // A rename or copy is followed by its source path. A renamed file is
      // gone from its old place, which is a change too.
      if (/[RC]/.test(code)) {
        index += 1;
        if (code.includes('R') && entries[index]) files.push(entries[index]);
      }
    }
    // Sorted, so the identity of the code does not depend on what is staged.
    changed = [...new Set(files)].filter((file) => !isGenerated(file)).sort();
  }
  return { head: git(['rev-parse', '--verify', 'HEAD']), changed, git };
}

// The Map a Spec is written against is copied into its change folder, so it is
// committed and reviewed with the Spec. Genesis keeps its own output out of Git.
export const mapCopy = (name) => `openspec/changes/${name}/business-map.json`;

// Reads the Map chosen for a new change. Its bytes are copied as they are, so
// the copy keeps the digest of the file Genesis wrote.
export function readMap(repo, mapFile, name) {
  const file = path.resolve(repo, mapFile);
  const bytes = readFileSync(file);
  const document = JSON.parse(bytes.toString('utf8'));
  if (typeof document?.snapshot_id !== 'string' || !document.snapshot_id || !['complete', 'partial'].includes(document.analysis_status)) {
    throw new Error('Map must be a Genesis business-map.json with snapshot_id and analysis_status.');
  }
  // Genesis writes change-report.json beside the Map of a change review,
  // which describes only the flows the change touched.
  if (existsSync(path.join(path.dirname(file), 'change-report.json'))) {
    throw new Error('This Map comes from a Genesis change review (change-report.json is beside it) and covers only the flows that change touched. Pass the business-map.json of a full map: run `/genesis map` first.');
  }
  // Until Genesis describes a flow, its steps are named by lines of source code.
  const steps = (Array.isArray(document.flows) ? document.flows : []).flatMap((flow) => (Array.isArray(flow?.steps) ? flow.steps : []));
  const coded = steps.filter((step) => step?.support === 'static_fact').length;
  return {
    bytes,
    record: {
      status: 'available', path: mapCopy(name), sha256: digest(bytes),
      snapshot_id: document.snapshot_id, analysis_status: document.analysis_status,
      freshness: 'unverified',
    },
    warnings: coded ? [`${coded} of the ${steps.length} steps in this Map belong to flows Genesis has not described yet and are named from the source code: by a line of code, or by the entry point for a flow's trigger. The copy at ${mapCopy(name)} is committed with the Spec, so that code goes into Git too. If it should not, tell the user before anything is committed: describing those flows with \`/genesis map\` replaces those names.`] : [],
  };
}

export function captureContext(repo, mode, map = null) {
  const { head, changed } = codeState(repo);
  const workingTree = changed === null ? null : changed.join('\n');
  return {
    version: 1, project_mode: mode,
    code: { base_commit: head, working_tree_dirty: workingTree === null ? null : workingTree !== '', captured_at: new Date().toISOString() },
    map: map ?? { status: mode === 'new' ? 'not_applicable' : 'missing', reason: mode === 'new' ? 'new_project' : 'not_provided' },
    baseline: { status: 'not_run', availability: mode === 'new' ? 'no_implementation' : 'unknown' },
  };
}
