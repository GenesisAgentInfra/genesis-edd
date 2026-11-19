import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

try {
  const { cli } = JSON.parse(readFileSync(new URL('./runtime.json', import.meta.url), 'utf8'));
  if (typeof cli !== 'string' || !existsSync(cli)) throw new Error('CLI checkout is unavailable.');
  const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Genesis EDD skill environment is unavailable: ${error.message} Re-run genesis-edd init from the installed checkout.`);
  process.exitCode = 1;
}
