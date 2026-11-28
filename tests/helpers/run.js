// Helpers the run test files (run.test.js, run-code.test.js, run-plan.test.js)
// share. They were the local helpers of run.test.js before it was split.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJSON } from '../../src/project.js';
import { validateEval } from '../../src/eval.js';
import { checkEval, codeSnapshot, readCounts, runTools, sameCode, savePatch, startRun } from '../../src/run.js';
import { loopStatus, startLoop } from '../../src/loop.js';
import { checkWorkflow } from '../../src/workflow.js';
import {
  AFTER, AGENT, BEFORE, CHANGE, FAKE_HARBOR_VERSION, LIVE_DEPENDENCY, cli, commit, confirmChecks, connect, dropCheck, editChecks, git, harborThen, readRecord,
  readyProject, setResults, writeExpectations,
} from './edd.js';

// The consent of the user and startLoop with it (see edd.js), so a run test
// file imports them from here with the rest.
export { APPROVAL, APPROVAL_FLAGS, CONSENT, CONSENT_FLAGS, LAYERS, REF, USER, actionOf, allowedActions, assertGapShape, assertNoRoutes, assertSuggestion, startLoop } from './edd.js';

export const FAILURE = 'submit-failure-s1';
export const SUCCESS = 'submit-success-s1';

// Run folders under runs/, in name order. None when runs/ does not exist yet.
export const runIds = (runs) => (existsSync(runs)
  ? readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []);
// compare.json as [case, check, before, after, verdict] rows.
export const rows = (compare) => compare.results.map(({ case: id, check, before, after, verdict }) => [id, check, before, after, verdict]);
export const find = (compare, id, check) => compare.results.find((entry) => entry.case === id && entry.check === check);
export const tally = (counts) => ({ holds: 0, violated: 0, base_mismatch: 0, head_only: 0, unverified: 0, ...counts });
export const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
export const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

// assert.throws validator for a run that was refused with exactly these gaps.
export const refused = (...codes) => (error) => {
  assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
  assert.deepEqual(error.gaps.map((gap) => gap.code), codes);
  return true;
};

export function scratch(t, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Every file under directory with its bytes, keyed by its path relative to directory.
export function tree(directory, base = directory) {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(tree(file, base))
      : [[path.relative(base, file).split(path.sep).join('/'), readFileSync(file).toString('base64')]];
  }));
}

export const loopFile = (root) => path.join(root, 'loop.json');
