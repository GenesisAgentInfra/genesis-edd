import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A project install records the Genesis EDD checkout in runtime.json. A plugin
// install has no such file: the skills sit inside the package itself.
function locate() {
  const runtime = new URL('./runtime.json', import.meta.url);
  if (existsSync(runtime)) return JSON.parse(readFileSync(runtime, 'utf8')).cli;
  return fileURLToPath(new URL('../../../bin/genesis-edd.js', import.meta.url));
}

// A plugin is fetched without its npm dependencies. Install the pinned ones
// once, inside the package; a later plugin update starts from a fresh folder.
function dependencies(root) {
  if (['yaml', '@fission-ai/openspec'].every((name) => existsSync(path.join(root, 'node_modules', name, 'package.json')))) return;
  const command = 'npm ci --ignore-scripts --omit=dev --no-audit --no-fund';
  console.error(`Genesis EDD: installing its pinned dependencies once, in ${root}`);
  const result = spawnSync(command, { cwd: root, shell: true, stdio: ['ignore', process.stderr, process.stderr] });
  if (result.status !== 0) {
    throw new Error(`Its dependencies are not installed. Run \`${command}\` in ${root}; it needs network access and writes only there. Then retry.`);
  }
}

try {
  const cli = locate();
  if (typeof cli !== 'string' || !existsSync(cli)) throw new Error('The Genesis EDD package is not where the skill expects it. Reinstall the plugin, or re-run genesis-edd init from a checkout.');
  dependencies(path.dirname(path.dirname(cli)));
  const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Genesis EDD skill environment is unavailable: ${error.message}`);
  process.exitCode = 1;
}
