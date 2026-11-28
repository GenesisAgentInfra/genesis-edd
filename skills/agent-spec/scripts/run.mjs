import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every Genesis EDD skill carries this launcher, so none depends on another
// skill being installed. A project install records the absolute path of the
// CLI in runtime.json beside it, and init writes both files again on every
// run. A plugin install has no runtime.json: the skills sit inside the
// package itself. The CLI is never looked up on PATH.
function locate() {
  const runtime = new URL('./runtime.json', import.meta.url);
  if (existsSync(runtime)) return JSON.parse(readFileSync(runtime, 'utf8')).cli;
  return fileURLToPath(new URL('../../../bin/genesis-edd.js', import.meta.url));
}

// The project a command names with --repo, else the working directory (null).
// The last --repo wins, as it does in the CLI.
function projectOf(args) {
  let repo = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--repo' && index + 1 < args.length) repo = args[index + 1];
    else if (args[index].startsWith('--repo=')) repo = args[index].slice('--repo='.length);
  }
  return repo;
}

// Help and the version judge no project, as in the CLI.
const judgesNothing = (args) => !args.length || args.includes('--help') || args.includes('-h') || (args.length === 1 && args[0] === '--version');

// The CLI judges the project, which the agent being judged can edit, so a
// CLI inside the project is refused.
function outside(cli, repo) {
  let file;
  let project;
  try {
    file = realpathSync(cli);
    project = realpathSync(path.resolve(repo ?? '.'));
  } catch { return; }
  const relative = path.relative(project, file);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    const hint = repo === null
      ? ` No --repo was given, so the project is the working directory ${project}: pass --repo with the project's folder, or run from inside the project.`
      : '';
    throw new Error(`the CLI it would run, ${file}, is inside the project ${project}. The CLI that judges a project has to be installed outside it.${hint}`);
  }
}

// A plugin is fetched without its npm dependencies. Install the pinned ones
// once, inside the package; a later plugin update starts from a fresh folder.
function dependencies(root) {
  if (['yaml', '@fission-ai/openspec'].every((name) => existsSync(path.join(root, 'node_modules', name, 'package.json')))) return;
  const command = 'npm ci --ignore-scripts --omit=dev --no-audit --no-fund';
  console.error(`Genesis EDD: installing its pinned dependencies once, in ${root}`);
  const result = spawnSync(command, { cwd: root, shell: true, stdio: ['ignore', process.stderr, process.stderr] });
  if (result.status !== 0) {
    throw new Error(`its dependencies are not installed: \`${command}\` in ${root} failed. It needs network access and writes only there.`);
  }
}

try {
  const cli = locate();
  if (typeof cli !== 'string' || !path.isAbsolute(cli) || !existsSync(cli)) throw new Error('the Genesis EDD package is not where the skill expects it: runtime.json names no CLI that exists, and init writes it again.');
  const args = process.argv.slice(2);
  if (!judgesNothing(args)) outside(cli, projectOf(args));
  dependencies(path.dirname(path.dirname(cli)));
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Genesis EDD skill environment is unavailable: ${error.message}`);
  process.exitCode = 1;
}
