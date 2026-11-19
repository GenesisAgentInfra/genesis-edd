import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  SCHEMA, captureContext, changeDirectory, digest, listFiles, localPath,
  openspec, readJSON, requireProject, writeJSON,
} from './project.js';

export function newSpec(repo, name, options = {}) {
  const project = requireProject(repo);
  const directory = changeDirectory(repo, name);
  if (existsSync(directory)) throw new Error('Change already exists; edit it or choose a new change name.');
  const mode = options.mode ?? project.mode;
  if (!['new', 'existing'].includes(mode)) throw new Error('--mode must be new or existing.');
  const context = captureContext(repo, mode, options.map);
  const result = openspec(repo, ['new', 'change', name, '--schema', SCHEMA, '--json']);
  writeJSON(path.join(directory, 'genesis.json'), context);
  return { change: name, directory, context, openspec: result.data, instructions: specInstructions(repo, name) };
}

function requireChange(repo, name) {
  requireProject(repo);
  const directory = changeDirectory(repo, name);
  const metadata = parse(readFileSync(path.join(directory, '.openspec.yaml'), 'utf8'));
  if (metadata?.schema !== SCHEMA || metadata?.skip_specs) {
    throw new Error(`Expected a ${SCHEMA} change with specs enabled.`);
  }
  return directory;
}

export function specInstructions(repo, name) {
  requireChange(repo, name);
  return openspec(repo, ['instructions', 'specs', '--change', name, '--json']).data;
}

export function specStatus(repo, name) {
  const directory = requireChange(repo, name);
  return {
    change: name, context: readJSON(path.join(directory, 'genesis.json')),
    openspec: openspec(repo, ['status', '--change', name, '--json']).data,
    note: 'Artifact completion is not business approval or evaluation readiness; run spec validate.',
  };
}

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSpec(repo, name) {
  const directory = requireChange(repo, name);
  const errors = [];
  const blockers = [];
  const warnings = [];
  const specs = [];
  const ids = new Set();
  const frontmatterOnlyPreambles = new Set();
  const context = readJSON(path.join(directory, 'genesis.json'));
  if (context.version !== 1 || !['new', 'existing'].includes(context.project_mode) || !record(context.map) || !record(context.baseline) || !record(context.code)) {
    errors.push('Invalid change context in genesis.json.');
  }
  if (context.baseline?.status !== 'not_run' || !['no_implementation', 'unknown'].includes(context.baseline?.availability)) {
    errors.push('The spec stage can only record an unexecuted baseline with no_implementation or unknown availability.');
  }
  if (!['available', 'missing', 'not_applicable'].includes(context.map?.status)) errors.push('Invalid Map status.');
  if (context.map?.status === 'available') {
    try {
      const mapContent = readFileSync(path.resolve(repo, context.map.path), 'utf8');
      if (digest(mapContent) !== context.map.sha256) errors.push('Referenced Map changed; create a new change with the updated Map.');
    } catch { errors.push('Referenced Map is unavailable; restore its snapshot before export.'); }
    warnings.push('Map freshness against the current code is not automatically verified.');
  } else if (context.project_mode === 'existing') {
    warnings.push('No Map supplied for an existing project; use repository facts and record coverage limits.');
  }
  const specRoot = localPath(repo, `openspec/changes/${name}/specs`);
  for (const file of listFiles(specRoot).filter((file) => file.endsWith('.md'))) {
    const relative = path.relative(directory, file);
    const content = readFileSync(file, 'utf8');
    const fail = (message) => errors.push(`${relative}: ${message}`);
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
    if (!match) { fail('Missing Genesis YAML frontmatter.'); continue; }
    let metadata;
    try { metadata = parse(match[1]); } catch (error) { fail(`Invalid YAML: ${error.message}`); continue; }
    if (!record(metadata)) { fail('Frontmatter must be an object.'); continue; }
    if (metadata.genesis_spec !== 1) fail('genesis_spec must be 1.');
    if (!Number.isInteger(metadata.revision) || metadata.revision < 1) fail('revision must be a positive integer.');
    if (!record(metadata.sources) || !Object.keys(metadata.sources).length) fail('At least one source is required.');
    for (const [id, source] of Object.entries(metadata.sources ?? {})) {
      if (!record(source) || !['user', 'accepted_spec', 'agent'].includes(source.kind) || !nonempty(source.ref) || !nonempty(source.quote)) {
        fail(`Source ${id} needs kind (user/accepted_spec/agent), ref and quote.`);
      }
    }
    if (!record(metadata.requirements)) fail('requirements must map stable IDs to provenance.');
    if (!Array.isArray(metadata.open_questions) || metadata.open_questions.some((q) => !nonempty(q))) {
      fail('open_questions must be an array of nonempty strings.');
    } else if (metadata.open_questions.length) {
      blockers.push(...metadata.open_questions.map((q) => `${relative}: ${q}`));
    }
    const body = content.slice(match[0].length);
    // OpenSpec warns that archive drops frontmatter. Genesis preserves it in the
    // handoff and does not expose archive; no other prose may use this exception.
    const preamble = body.split(/^## /m)[0];
    if (/^\s*(?:# [^\n]+\s*)?$/.test(preamble)) {
      frontmatterOnlyPreambles.add(path.relative(specRoot, file).split(path.sep).join('/'));
    }
    if (/^## (REMOVED|RENAMED) Requirements\s*$/m.test(body)) {
      fail('Removal and rename deltas are not supported by the v0.1 handoff contract.');
    }
    const headings = [...body.matchAll(/^### Requirement:\s*(.+)$/gm)];
    const seen = new Set();
    if (!headings.length) fail('At least one requirement is required.');
    for (const heading of headings) {
      const identity = /^(REQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s+\S/.exec(heading[1]);
      if (!identity) { fail(`Requirement needs a stable REQ- ID followed by its name: ${heading[1]}`); continue; }
      const id = identity[1];
      if (ids.has(id)) fail(`Duplicate requirement ID: ${id}`);
      ids.add(id);
      seen.add(id);
      const provenance = metadata.requirements?.[id];
      if (!record(provenance)) { fail(`Missing provenance for ${id}.`); continue; }
      const source = metadata.sources?.[provenance.source];
      if (!source) fail(`${id} references an unknown source.`);
      if (!['explicit', 'confirmed', 'proposed'].includes(provenance.state)) fail(`${id} has an invalid state.`);
      if (provenance.state === 'explicit' && !['user', 'accepted_spec'].includes(source?.kind)) {
        fail(`${id}: an agent suggestion cannot be an explicit user requirement.`);
      }
      if (provenance.state === 'confirmed' && (!nonempty(provenance.confirmation?.by) || !nonempty(provenance.confirmation?.ref))) {
        fail(`${id}: confirmed requires confirmation.by and confirmation.ref.`);
      }
      if (provenance.state === 'proposed') blockers.push(`${id} is proposed, not an accepted requirement.`);
    }
    for (const id of Object.keys(metadata.requirements ?? {})) {
      if (!seen.has(id)) fail(`Provenance ${id} has no requirement block.`);
    }
    specs.push({ path: relative, sha256: digest(content), revision: metadata.revision, content });
  }
  if (!specs.length) errors.push('No spec documents found.');
  const upstream = openspec(repo, ['validate', name, '--type', 'change', '--strict', '--json', '--no-interactive'], { allowFailure: true });
  const archiveWarning = 'Text above the first "## " section is not carried into the main spec by archive. Move it into a requirement, or into proposal.md or design.md.';
  const waived = [];
  const blockingIssues = [];
  for (const item of upstream.data.items ?? []) {
    for (const issue of item.issues ?? []) {
      if (issue.level === 'WARNING' && issue.message === archiveWarning && issue.line === 1 && frontmatterOnlyPreambles.has(issue.path)) {
        waived.push(issue);
      } else if (issue.level !== 'INFO') blockingIssues.push(issue);
    }
  }
  if (waived.length) warnings.push('Genesis preserves YAML provenance in exported handoffs. The OpenSpec archive-frontmatter warning is advisory here; automatic archive/sync is unsupported.');
  if (!upstream.ok && (blockingIssues.length || !waived.length)) errors.push('OpenSpec strict validation failed; see openspec diagnostics.');
  return {
    change: name, valid: errors.length === 0, ready_for_eval_design: errors.length === 0 && blockers.length === 0,
    errors, blockers, warnings, context, specs, openspec: upstream.data, openspec_advisory_issues: waived,
  };
}

export function exportSpec(repo, name) {
  const result = validateSpec(repo, name);
  if (!result.ready_for_eval_design) {
    throw new Error(`Spec is not ready for Eval design: ${[...result.errors, ...result.blockers].join('; ')}`);
  }
  const payload = {
    format: 'genesis.spec-handoff', version: 1, change: name,
    context: result.context, specs: result.specs,
  };
  const id = digest(JSON.stringify(payload));
  const directory = localPath(repo, `openspec/changes/${name}/handoffs`);
  const file = path.join(directory, `${id.slice(7)}.json`);
  const handoff = { ...payload, id };
  if (existsSync(file)) {
    if (JSON.stringify(readJSON(file)) !== JSON.stringify(handoff)) throw new Error('Existing handoff has been modified.');
  } else {
    mkdirSync(directory, { recursive: true });
    writeJSON(file, handoff);
  }
  return {
    id, file, ready_for_eval_design: true, warnings: result.warnings,
    next: 'write-eval (planned): derive cases and execution bindings from this frozen spec handoff.',
  };
}
