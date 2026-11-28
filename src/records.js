import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Append-only records of a change, kept beside its runs. They let the CLI see
// what a run folder or loop.json no longer shows: a run whose folder was
// deleted, or whose run.json cannot be read, is still in runs/index.jsonl, and
// a user's decision is still in decisions.jsonl. Neither file is in Git, so
// both hold for this machine only, at the trust level of the other local
// records.

// One line of JSON per entry, written whole. A line that cannot be parsed is
// kept as broken; nothing is rewritten.
function appendLine(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function readLines(file) {
  if (!existsSync(file)) return { exists: false, entries: [], broken: [] };
  const entries = [];
  const broken = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value);
      else broken.push(index + 1);
    } catch { broken.push(index + 1); }
  });
  return { exists: true, entries, broken };
}

// The run index: runs/index.jsonl beside the run folders. A run appends a
// start entry before Harbor starts and a finish entry after it wrote run.json.
//   start:  { event: 'start', run_id, at, side, scope, role, loop, spec,
//             code, cases, task_digest, run_digest, agent, model, attempts }
//   finish: { event: 'finish', run_id, at, execution_status, verdict,
//             minutes, run_json }  (run_json is the digest of run.json)
export const RUN_INDEX = 'index.jsonl';
export const runIndexFile = (runsDirectory) => path.join(runsDirectory, RUN_INDEX);

export function appendRunIndex(runsDirectory, entry) {
  if (!entry?.event || !entry?.run_id) throw new Error('A run index entry needs event and run_id.');
  appendLine(runIndexFile(runsDirectory), { at: new Date().toISOString(), ...entry });
}

// { exists, broken, runs: Map(run_id -> { start, finish }) }, in index order.
export function readRunIndex(runsDirectory) {
  const { exists, entries, broken } = readLines(runIndexFile(runsDirectory));
  const runs = new Map();
  for (const entry of entries) {
    if (typeof entry.run_id !== 'string') continue;
    const held = runs.get(entry.run_id) ?? { start: null, finish: null };
    if (entry.event === 'start' && !held.start) held.start = entry;
    if (entry.event === 'finish') held.finish = entry;
    runs.set(entry.run_id, held);
  }
  return { exists, broken, runs };
}

// Decisions of a change: decisions.jsonl in the change's .genesis/edd folder.
// Each entry: { type, at, by?, ref?, reason?, ...facts }. Types in use:
// loop_start, loop_end, loop_decline, loop_budget, loop_review, loop_dispute,
// dispute_ruling, loop_tests, change_abandon, cost_approval.
export const decisionsFile = (eddDirectory) => path.join(eddDirectory, 'decisions.jsonl');

export function appendDecision(eddDirectory, entry) {
  if (!entry?.type) throw new Error('A decision needs a type.');
  appendLine(decisionsFile(eddDirectory), { at: new Date().toISOString(), ...entry });
}

// { exists, broken, entries }, oldest first.
export const readDecisions = (eddDirectory) => readLines(decisionsFile(eddDirectory));

// The latest decision of a type, or null.
export const latestDecision = (eddDirectory, type) => readDecisions(eddDirectory).entries.filter((entry) => entry.type === type).at(-1) ?? null;
