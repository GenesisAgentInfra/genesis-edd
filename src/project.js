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
    'sha256:8778cd7d6dc3c144e96c758f1f149b1ae35c530a3a52df42a5305a832c113142',
    'sha256:5bb03c4d492792be8498845b79b50593f3cac3d191bc0717620b0f913733f872',
  ],
  'agent-spec/scripts/run.mjs': ['sha256:881a4b48652d858fa99c6cccacd9549910b64631152884beef6bb88a70fc1e9a'],
  'write-eval/SKILL.md': [
    'sha256:390f4c0a47e84b7d73a6317dbf9ed054d1879944fcfa38bd94016fd171bf889d',
    'sha256:51b2afec0e56f6e2cac81c2392a56917b356e44635ff4dbda80350c0daa93e12',
    'sha256:fb44a892188d2e01bcbc295d5119edd97bde2c63ce22f8bedb52e2d5f76d339a',
  ],
  'write-eval/references/task-package.md': ['sha256:45ea9802b29191f985ea5b88227ebdd8ba6099355d80e3e90a68d2cdf97791df'],
  'run-eval/SKILL.md': [
    'sha256:ffb9e10f3f25bffc007ed9381df23cb3d1e31b64dc8088352302158215f75ba7',
    'sha256:0f46f119fcc49a84dff2fd55274aee5ae5c80c9b4c7c99b5d3bc4999d01bded8',
    'sha256:8559cf63ec10a5d6323d1e620ab163f6c0619018536ec5653efb4507c070d021',
    'sha256:296897d67a464063536748a9365e914689072f50cf7b0decd3aceb929bc5b7e3',
    'sha256:6d91c065e882409f53dbc19356d718dd8bcb3fbd54f44e439c67d4f17d953b39',
  ],
  'run-eval/references/run-records.md': [
    'sha256:0f2bafd0cf20299e5ab7d0f28ffbdbc657450d986d56cd708352ec1e761c5c61',
    'sha256:389a8ae7e97bd9e0ef6716f17c15fbddaf193a27f65bd4799cd825ef5ecd3024',
    'sha256:c187814a77aa95d7a820159ac7475d86fca61b492ac6e025494a2c443b846998',
    'sha256:c907c59be9416c241534a85affd4475e4848f5ada7213ec5e596365d779c047d',
    'sha256:21a0764116d0cf70248da814001ee1ad252d4f70a620beb37224aef2fcbcdb66',
  ],
  'write-eval/references/harbor.md': [
    'sha256:560385a1e4ac0c91e0a1699c52b15ef5038181ec6cc9cf3e47bedaedebbabbfa',
    'sha256:bd52fadcf7d57fd7312862e0c401172e09ccfdc13fd12fe85331c9d915dd0887',
  ],
  'write-eval/references/environment.md': ['sha256:50b827232d9df5f55ed603fc8d670440f5cd877b33f581b82aa7ee0768aaa964'],
  'loop-and-implement/SKILL.md': [
    'sha256:02d47d51ad3bcb6f8899622e70526fbf750a5047ce98661fd4df55e034356921',
    'sha256:1a71597ec5058d525133aec2936dec054800dc665d2769c9b1736417bce7ff9d',
    'sha256:bfa2ba559def320af39c227eaa3e4356ebeba2434585906c564cabe32f977450',
    'sha256:ea1eb703dbfd3abb9298d0f340a6d417a8c3c726ba2b1f9dbe638d58d100753b',
  ],
  'agent-spec/references/spec-format.md': [
    'sha256:b0945ecd8c3ed0d0f7ddcfd13a0ce69433ed2a6f741981e7c3a1c46e8ff063a1',
    'sha256:99a3389ea7a87d2c61077a5f81252d39f594d6e86d5ad21f939c779020b56619',
    'sha256:7fc70e45daeb8334e30c2c40d0dd18de1f8593f3987bbc4275fba63de4af8a58',
    'sha256:72dcc8e43234509dac8eec197e670fd4dd43a5111deba5a0a8eb4bdd88cb88e4',
    'sha256:6fb88d1b37864df50c624b2b4715edbc22a4f1135ec6c3a17f0fba34be3f2636',
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

// What `git status` lists under the given paths, or everywhere: [{ code, file }]
// with Git's two-letter code ('??' for untracked). Ignored files are not
// listed. untracked 'normal' lists a wholly untracked folder once, as `dir/`.
// null where Git cannot say.
export function gitStatus(repo, paths = [], untracked = 'all') {
  // -z gives every path as it is, without the quoting Git applies to names
  // with quotes, backslashes or control characters.
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain', '-z', `--untracked-files=${untracked}`, ...(paths.length ? ['--', ...paths] : [])],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  if (status.status !== 0) return null;
  const entries = status.stdout.split('\0');
  const listed = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    listed.push({ code, file: entry.slice(3) });
    // A rename or copy is followed by its source path. A renamed file is
    // gone from its old place, which is a change too.
    if (/[RC]/.test(code)) {
      index += 1;
      if (code.includes('R') && entries[index]) listed.push({ code, file: entries[index] });
    }
  }
  return listed;
}

// Commit and application files changed since it; null where Git cannot say.
export function codeState(repo) {
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const listed = gitStatus(repo);
  // Sorted, so the identity of the code does not depend on what is staged.
  const changed = listed === null ? null : [...new Set(listed.map((entry) => entry.file))].filter((file) => !isGenerated(file)).sort();
  return { head: git(['rev-parse', '--verify', 'HEAD']), changed, git };
}

// Files the operating system or an editor leaves beside the real ones: Finder
// and Explorer metadata, swap files and backups. They never take part in a run
// and are not files of a change.
export const isLeftover = (file) => /^(?:\.DS_Store|Thumbs\.db)$|\.sw[op]$|~$/.test(path.basename(file));

// Files of a change that belong in Git, each with what a clone lacks without
// it: the change's Spec folder, the OpenSpec project files, the .gitignore
// that keeps only the run records out, the project kit, and the change's eval
// packages, expected baseline results, reports and acceptance.
const committedArtifacts = (name) => ({
  [`openspec/changes/${name}/`]: 'Spec of this change',
  'openspec/config.yaml': 'OpenSpec project files',
  'openspec/genesis.json': 'OpenSpec project files',
  '.genesis/edd/.gitignore': null,
  '.genesis/edd/harness/': 'project kit',
  [`.genesis/edd/${name}/evals/`]: 'eval packages',
  [`.genesis/edd/${name}/baseline-expectations.json`]: 'expected baseline results',
  [`.genesis/edd/${name}/reports/`]: 'reports',
  [`.genesis/edd/${name}/accepted.json`]: 'acceptance record',
});

const either = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items.join(''));

// How to change one rule that ignores files of the change. A rule that ignores
// a folder keeps out everything in it, and Git cannot take back a file whose
// parent folder is ignored, so only the folder itself can be taken back.
// `.genesis/*` ignores what is in .genesis/, so a later `!.genesis/edd/` takes
// that folder back. `.genesis/**` also ignores each file below it on its own,
// which `!.genesis/edd/` does not take back.
function ruleFix(pattern) {
  const folder = pattern.replace(/^\//, '').replace(/\/$/, '');
  if (folder === '.genesis/*') return `add \`!.genesis/edd/\` after \`${pattern}\`, or ignore only \`.genesis/out/\` instead`;
  if (folder === '.genesis' || folder === '.genesis/**') return `instead of \`${pattern}\`, ignore \`.genesis/*\` and add \`!.genesis/edd/\` after it, or ignore only \`.genesis/out/\``;
  if (folder === 'openspec') return `remove \`${pattern}\`, or add \`!openspec/\` to the project's .gitignore after it`;
  return `narrow \`${pattern}\` so it matches none of these files`;
}

// Which of those files a .gitignore rule keeps out of Git, such as a project
// that ignores all of `.genesis/` or `openspec/`. Files already tracked still
// count: the rule keeps every new package, report or acceptance out.
// Read-only; nothing outside Git is ignored. Returns { paths, warning }: the
// ignored ones, and a warning, or null.
export function ignoredArtifacts(repo, name) {
  const artifacts = committedArtifacts(name);
  // -z gives each match as four fields, source, line, pattern and path, so a
  // source with a colon in it, such as a Windows path with its drive letter,
  // is read as it is. -v also prints a path a `!` rule matched last, which is
  // not ignored.
  const result = spawnSync('git', ['-C', repo, 'check-ignore', '--no-index', '-v', '-z', '--stdin'],
    { input: Object.keys(artifacts).join('\0'), encoding: 'utf8', timeout: 10_000 });
  const fields = [0, 1].includes(result.status) ? result.stdout.split('\0') : [];
  const matches = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, line, pattern, file] = fields.slice(index, index + 4);
    if (!pattern.startsWith('!')) matches.push({ path: file, pattern, rule: `\`${pattern}\` in ${source}:${line}` });
  }
  if (!matches.length) return { paths: [], warning: null };
  const paths = matches.map((entry) => entry.path);
  const rules = [...new Set(matches.map((entry) => entry.rule))];
  const lacks = [...new Set(paths.map((file) => artifacts[file]).filter(Boolean))];
  const fixes = [...new Set(matches.map((entry) => ruleFix(entry.pattern)))];
  return {
    paths,
    warning: `Git ignores files of this change that must be committed: ${paths.join(', ')} (${rules.length === 1 ? 'rule' : 'rules'} ${rules.join(', ')}).${lacks.length ? ` Without them a clone has no ${either(lacks)}.` : ''} Change ${rules.length === 1 ? 'the rule' : 'the rules'} so these files are committed: ${fixes.join('; ')}.`,
  };
}

// Which of the given paths Git ignores and does not hold. Git lists a wholly
// ignored, untracked folder once, even one that holds more than was asked for,
// such as all of `.genesis/` with its run records: the paths asked for inside
// it are named instead. A file deeper inside one of them is named only when a
// rule ignores that folder itself (`ignoredFolders`, which the warning of
// ignoredArtifacts names), as with new packages in a partly tracked folder.
// Under a rule such as `*.log` or `.env` that keeps one file out on its own it
// is not: no warning names that rule, and the file may hold a secret.
function ignoredUntracked(repo, paths, ignoredFolders) {
  const result = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', ...paths],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return [];
  const folders = ignoredFolders.filter((item) => item.endsWith('/'));
  return result.stdout.split('\0').filter(Boolean).flatMap((entry) => {
    if (paths.includes(entry)) return [entry];
    if (folders.some((folder) => entry.startsWith(folder))) return isLeftover(entry) ? [] : [entry];
    return paths.filter((item) => item.startsWith(entry) && existsSync(path.join(repo, item)));
  });
}

// The files of this change that Git does not hold as they are now: its Spec
// folder, the OpenSpec project files, its eval packages, expected baseline
// results, reports and acceptance, the project kit and the .gitignore of the
// run records, including those a .gitignore rule keeps out. Ignored run
// records, other ignored files and leftovers are not listed; a wholly
// untracked folder is listed once, unless it holds only leftovers. null
// without Git.
export function uncommittedArtifacts(repo, name) {
  const listed = gitStatus(repo, [`openspec/changes/${name}/`, 'openspec/config.yaml', 'openspec/genesis.json', `.genesis/edd/${name}/`,
    '.genesis/edd/harness/', '.genesis/edd/.gitignore'], 'normal');
  if (listed === null) return null;
  // Git lists an untracked folder by its name alone, so its files are read.
  const own = (entry) => !isLeftover(entry.file) && !(entry.code === '??' && entry.file.endsWith('/')
    && (gitStatus(repo, [entry.file]) ?? [entry]).every((inside) => isLeftover(inside.file)));
  const ignored = ignoredUntracked(repo, Object.keys(committedArtifacts(name)), ignoredArtifacts(repo, name).paths);
  return [...new Set([...listed.filter(own).map((entry) => entry.file), ...ignored])].sort();
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
  // `mode` says what a Map covers. The Map of a change review covers what
  // that review analyzed, not the project. Genesis before MAP_FIELDS wrote no
  // mode, so such a Map may be either kind.
  const mode = document.mode ?? null;
  if (mode === 'change') {
    throw new Error('This Map comes from a Genesis change review (its mode is change) and covers only what that review analyzed, not the whole project. Pass the business-map.json of a full map: run `/genesis map` first.');
  }
  if (mode !== null && mode !== 'map') {
    throw new Error(`Map has a mode Genesis EDD does not know: ${JSON.stringify(mode)}. Pass the business-map.json of a full Genesis map, whose mode is map.`);
  }
  // Genesis writes change-report.json beside the Map of a change review,
  // which describes only the flows the change touched.
  if (existsSync(path.join(path.dirname(file), 'change-report.json'))) {
    throw new Error('This Map comes from a Genesis change review (change-report.json is beside it) and covers only the flows that change touched. Pass the business-map.json of a full map: run `/genesis map` first.');
  }
  const warnings = [];
  if (mode === null) {
    warnings.push(`This Map does not say whether it maps the whole project or a change review: Genesis before ${MAP_FIELDS} wrote no mode. Nothing beside it marks a review, so it is used and recorded with mode unknown. If it came from \`/genesis review\`, pass the business-map.json of a full map instead. A Map from Genesis ${MAP_FIELDS} or later says which it is.`);
  }
  const freshness = mapFreshness(repo, document.source);
  if (freshness.warning) warnings.push(freshness.warning);
  const edited = editedMapFiles(repo, document.source);
  if (edited) warnings.push(edited);
  const coverage = mapCoverage(document.coverage);
  if (coverage && coverage.entries_planned < coverage.entries_total) warnings.push(outsideFlows(coverage, skipReasons(document.coverage)));
  const { coded, total } = codeNamedSteps(document.flows);
  if (coded) {
    warnings.push(`${coded} of the ${total} steps in this Map belong to flows Genesis has not described yet and are named from the source code: by a line of code, or by the entry point for a flow's trigger. The copy at ${mapCopy(name)} is committed with the Spec, so that code goes into Git too. If it should not, tell the user before anything is committed: describing those flows with \`/genesis map\` replaces those names.`);
  }
  return {
    bytes,
    record: {
      status: 'available', path: mapCopy(name), sha256: digest(bytes),
      snapshot_id: document.snapshot_id, analysis_status: document.analysis_status,
      mode: mode ?? 'unknown', freshness: freshness.status, ...(coverage ? { coverage } : {}),
    },
    warnings,
  };
}

// Until Genesis describes a flow, its steps are named by lines of source code.
export function codeNamedSteps(flows) {
  const steps = (Array.isArray(flows) ? flows : []).flatMap((flow) => (Array.isArray(flow?.steps) ? flow.steps : []));
  return { coded: steps.filter((step) => step?.support === 'static_fact').length, total: steps.length };
}

// The entry counts of a Map's `coverage`, or null when it has none in the form
// Genesis writes. Genesis marks a Map complete once the flows it planned are
// finished, even when entries were left out of them.
const COVERAGE = ['entries_total', 'entries_planned', 'entries_skipped', 'entries_unhandled'];
function mapCoverage(coverage) {
  if (typeof coverage !== 'object' || coverage === null || COVERAGE.some((key) => !Number.isInteger(coverage[key]) || coverage[key] < 0)) return null;
  return Object.fromEntries(COVERAGE.map((key) => [key, coverage[key]]));
}

// How many skipped entries each reason covers, such as `2 budget, 1 test_helper`.
function skipReasons(coverage) {
  const reasons = (Array.isArray(coverage?.skipped_entries) ? coverage.skipped_entries : [])
    .map((entry) => entry?.reason).filter((reason) => typeof reason === 'string' && reason);
  const counts = new Map();
  for (const reason of reasons.sort()) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return counts.size ? [...counts].map(([reason, count]) => `${count} ${reason}`).join(', ') : null;
}

// The warning for entries outside a Map's planned flows, from its recorded
// coverage counts.
export function outsideFlows(coverage, reasons = null) {
  const { entries_total: total, entries_planned: planned, entries_skipped: skipped, entries_unhandled: unhandled } = coverage;
  const parts = [...(skipped ? [`${skipped} skipped${reasons ? ` (${reasons})` : ''}`] : []), ...(unhandled ? [`${unhandled} not handled`] : [])];
  return `This Map's planned flows cover ${planned} of the ${total} entries Genesis found${parts.length ? `: ${parts.join(' and ')}` : ''}. Its analysis_status says whether those flows are finished, not whether the whole project is mapped. If the request touches an entry outside them, read its code, or map it with \`/genesis map\`.`;
}

// Files the Map was read from that have edits not committed yet. Freshness
// compares the commit, while impact.md evidence is read from the working tree.
function editedMapFiles(repo, source) {
  const files = source?.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
  const { head, changed } = codeState(repo);
  if (!head || !changed) return null;
  const edited = changed.filter((file) => Object.hasOwn(files, file));
  if (!edited.length) return null;
  const named = `${edited.slice(0, 5).join(', ')}${edited.length > 5 ? ', …' : ''}`;
  return `${edited.length} of the files this Map was read from ${edited.length === 1 ? 'has' : 'have'} uncommitted edits (${named}). Its freshness compares commit ${short(head)}, not those edits, while impact.md evidence is read from the working tree. If the edits are not part of this request, the Map and that evidence may describe different code: tell the user.`;
}

const short = (commit) => commit.slice(0, 7);
// The Genesis commit from which a Map records `mode` and `source`. Genesis EDD
// does not depend on Genesis: a Map without them is still accepted.
const MAP_FIELDS = '9c0c914';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The path rules of Genesis's own contract: relative, POSIX, no control
// characters, no empty, `.` or `..` segment.
const repoPath = (file) => file.length > 0 && !/[\u0000-\u001f\\]/.test(file) && !file.startsWith('/')
  && !/^[A-Za-z]:/.test(file) && file.split('/').every((segment) => !['', '.', '..'].includes(segment));

// Whether a Map still matches the commit checked out now. Genesis records,
// under `source`, the commit it read (`revision`), whether uncommitted changes
// were read with it, whether files it would have read were left out, and every
// file read with the SHA-256 of its bytes as the commit stores them, which is
// what `git show <revision>:<path>` prints. The same bytes are read here from
// the commit checked out now. A file added since is not listed, so `verified`
// says nothing about new files.
export function mapFreshness(repo, source) {
  const unverified = (reason) => ({ status: 'unverified', warning: `Whether this Map still matches the code was not checked: ${reason}` });
  if (source === undefined || source === null) {
    return unverified(`it does not record the code it was read from, which Genesis before ${MAP_FIELDS} did not do. A Map from Genesis ${MAP_FIELDS} or later can be checked.`);
  }
  const files = source?.files;
  if (typeof source !== 'object' || Array.isArray(source) || !REVISION.test(source.revision ?? '')
    || typeof source.worktree_dirty !== 'boolean' || !['complete', 'partial'].includes(source.integrity_status)
    || typeof files !== 'object' || files === null || Array.isArray(files) || !Object.keys(files).length
    || Object.entries(files).some(([file, sum]) => !repoPath(file) || typeof sum !== 'string' || !SHA256.test(sum))) {
    return unverified('its source is not in the form Genesis writes.');
  }
  if (source.worktree_dirty) {
    return unverified('Genesis read the code with uncommitted changes, so its digests may be of code no commit holds.');
  }
  const head = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { encoding: 'utf8', timeout: 10_000 });
  const commit = head.status === 0 ? head.stdout.trim() : null;
  if (!commit) return unverified('the project has no commit to compare it with.');
  const paths = Object.keys(files).sort();
  const committed = committedDigests(repo, commit, paths);
  if (!committed) return unverified(`Git could not read the files of commit ${short(commit)}.`);
  const changed = paths.filter((file) => committed.get(file) !== files[file]);
  if (changed.length) {
    const named = changed.slice(0, 5).join(', ');
    return { status: 'stale', warning: `This Map no longer matches the code of commit ${short(commit)}: ${changed.length} of the ${paths.length} files it was read from changed or are gone since Genesis read them (${named}${changed.length > 5 ? ', …' : ''}). Its flows may describe code that is not there anymore. Tell the user. To write the Spec against the code as it is, map the project again with \`/genesis map\`, remove the change folder \`spec new\` just created, and run \`spec new\` again with the new Map.` };
  }
  if (source.integrity_status === 'partial') {
    return unverified(`Genesis left out files it would have read, such as one over its size limit (its integrity_status is partial). ${paths.length === 1 ? 'The one file' : `The ${paths.length} files`} it read ${paths.length === 1 ? 'is' : 'are'} unchanged at ${short(commit)}.`);
  }
  return { status: 'verified', warning: null };
}

// The SHA-256 of each path as `commit` stores it, or undefined where the commit
// has no file there; null when Git could not be read. Batches keep the output
// of one Git call bounded.
function committedDigests(repo, commit, paths) {
  const result = new Map();
  for (let start = 0; start < paths.length; start += 500) {
    const chunk = paths.slice(start, start + 500);
    const read = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
      input: chunk.map((file) => `${commit}:${file}\n`).join(''), timeout: 120_000, maxBuffer: 1024 * 1024 * 1024,
    });
    if (read.error || read.status !== 0) return null;
    const out = read.stdout;
    let offset = 0;
    for (const file of chunk) {
      const end = out.indexOf(10, offset);
      if (end < 0) return null;
      // `<object> <type> <size>`, then the content; `<name> missing` when the
      // commit has nothing at that path.
      const header = /^[0-9a-f]{40,64} ([a-z]+) (\d+)$/.exec(out.toString('utf8', offset, end));
      offset = end + 1;
      if (!header) continue;
      const size = Number(header[2]);
      if (offset + size > out.length) return null;
      if (header[1] === 'blob') result.set(file, digest(out.subarray(offset, offset + size)));
      offset += size + 1;
    }
  }
  return result;
}

// A Genesis review of a finished change starts from the Map the Spec was
// written against: it carries that Map's entries and flows, so the change
// lands on the same flows on every clone. Null without a Map or a base commit.
// Genesis leaves untracked files out unless told to include them, so new
// modules the evals ran are reviewed only with --include-untracked. Genesis
// compares the base commit with the working tree, so files that were already
// uncommitted when the loop started are listed: their edits from before the
// loop are not part of the change.
export function genesisReview(repo, name, map, base, { untracked = false, uncommittedAtStart = [] } = {}) {
  if (!map || map.status !== 'available' || !base) return null;
  const copy = mapCopy(name);
  const from = existsSync(path.join(repo, copy)) ? copy : String(map.path).replaceAll('\\', '/');
  return {
    base, entries_from: from, prepare: ['map', 'prepare', '--base', base, '--entries-from', from, ...(untracked ? ['--include-untracked'] : [])],
    ...(uncommittedAtStart.length ? { uncommitted_at_start: uncommittedAtStart } : {}),
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
