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
// Sentence-level statements in a quotation. Commas do not split: clauses of one
// sentence usually qualify each other rather than state separate rules.
const statementCount = (quote) => Math.max(1,
  quote.split(/[。！？；!?;\n]+|\.(?=\s|$)/).filter((part) => part.trim()).length);

// The structured form of every requirement. Later stages read this from the
// handoff, so they never depend on how the Markdown is laid out.
export function specRequirements(specs) {
  const requirements = [];
  for (const { path: file, content } of specs) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
    const metadata = parse(match[1]);
    for (const block of content.slice(match[0].length).split(/^### Requirement:\s*/m).slice(1)) {
      const [heading, ...rest] = block.split(/\r?\n/);
      const [, id, name] = /^(REQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s+(.+)$/.exec(heading.trim());
      const [intro, ...parts] = rest.join('\n').split(/^## /m)[0].split(/^#### Scenario:\s*(.*)$/m);
      const scenarios = [];
      for (let index = 0; index < parts.length; index += 2) {
        const scenario = { name: parts[index].trim(), given: [], when: [], then: [] };
        let step;
        for (const line of parts[index + 1].split('\n')) {
          const clause = /^\s*-\s*\*\*(GIVEN|WHEN|THEN|AND)\*\*\s*(.+)$/.exec(line);
          if (!clause) continue;
          if (clause[1] !== 'AND') step = clause[1].toLowerCase();
          if (step) scenario[step].push(clause[2].trim());
        }
        scenarios.push(scenario);
      }
      const provenance = metadata.requirements[id];
      const source = metadata.sources[provenance.source];
      requirements.push({
        id, name: name.trim(), path: file, state: provenance.state,
        basis: { source: provenance.source, kind: source.kind, ref: source.ref, quote: source.quote },
        ...(provenance.confirmation ? { confirmation: provenance.confirmation } : {}),
        statement: intro.split('\n').map((line) => line.trim()).filter(Boolean).join(' '),
        scenarios,
      });
    }
  }
  return requirements;
}

// Each requirement beside the words it rests on, for the user to read. The CLI
// cannot judge whether a quote really states a requirement; a person can.
export const specReview = (specs) => specRequirements(specs).map(({ id, basis, scenarios, ...rest }) => ({
  requirement: id, ...rest, basis: { source: basis.source, kind: basis.kind, quote: basis.quote },
  outcomes: scenarios.flatMap((scenario) => scenario.then),
}));

// Which entries and flows a request touches, written by the agent for an
// existing project. Flow IDs and evidence are checked against the Map and repo.
function readImpact(repo, file, mapFlows, fail) {
  const content = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let metadata;
  try { metadata = match && parse(match[1]); } catch (cause) { fail(`Invalid YAML: ${cause.message}`); return null; }
  if (!record(metadata) || metadata.genesis_impact !== 1 || !Array.isArray(metadata.entries) || !metadata.entries.length) {
    fail('Needs YAML frontmatter with genesis_impact: 1 and a non-empty entries list.');
    return null;
  }
  const entries = [];
  metadata.entries.forEach((item, index) => {
    const label = `entries[${index}]`;
    if (!record(item) || !nonempty(item.entry) || !['changes', 'may_affect'].includes(item.effect) || !nonempty(item.evidence)) {
      fail(`${label} needs entry, effect (changes or may_affect) and evidence (path or path:line).`);
      return;
    }
    const [, target, line] = /^(.*?)(?::(\d+))?$/.exec(item.evidence.trim());
    const source = path.resolve(repo, target);
    let lines = null;
    try {
      if (!source.startsWith(`${repo}${path.sep}`)) throw new Error('outside the project');
      lines = readFileSync(source, 'utf8').split('\n').length;
    } catch { fail(`${label} evidence does not point to a file in the project: ${item.evidence}`); }
    if (lines !== null && line && (Number(line) < 1 || Number(line) > lines)) fail(`${label} evidence line is outside the file: ${item.evidence}`);
    if (item.flow !== undefined && !nonempty(item.flow)) fail(`${label} flow must be a Map flow ID when given.`);
    else if (nonempty(item.flow) && mapFlows && !mapFlows.has(item.flow)) fail(`${label} flow is not in the recorded Map: ${item.flow}`);
    const flowName = nonempty(item.flow) ? mapFlows?.get(item.flow) : undefined;
    entries.push({
      ...(nonempty(item.flow) ? { flow: item.flow, ...(nonempty(flowName) ? { flow_name: flowName } : {}) } : {}),
      entry: item.entry.trim(), effect: item.effect, evidence: item.evidence.trim(),
      ...(nonempty(item.note) ? { note: item.note.trim() } : {}),
    });
  });
  return { path: 'impact.md', sha256: digest(content), entries };
}

export function validateSpec(repo, name) {
  const directory = changeDirectory(repo, name);
  const errors = [];
  const blockers = [];
  const gaps = [];
  const warnings = [];
  const specs = [];
  const ids = new Set();
  const frontmatterOnlyPreambles = new Set();
  let context = null;
  let mapFlows = null;
  let impact = null;
  const report = (upstream = {}, waived = []) => ({
    change: name, valid: errors.length === 0, ready_for_eval_design: errors.length === 0 && blockers.length === 0,
    errors, blockers, gaps, warnings, context, specs, impact, openspec: upstream, openspec_advisory_issues: waived,
  });
  const error = (code, message, details = {}) => {
    errors.push(message);
    gaps.push({ code, kind: 'technical', owner: 'agent', route: 'agent-spec', message, ...details });
  };
  const business = (code, message, details = {}) => {
    blockers.push(message);
    gaps.push({ code, kind: 'business', owner: 'user', route: 'agent-spec', message, ...details });
  };
  if (!existsSync(localPath(repo, 'openspec/config.yaml')) || !existsSync(localPath(repo, 'openspec/genesis.json'))) {
    error('project_missing', 'Initialize Genesis from the known project mode, or restore the missing project metadata without overwriting existing work.', { kind: 'artifact', route: 'init' });
    return report();
  }
  try { requireProject(repo); } catch (cause) {
    error('project_invalid', cause.message, { route: 'init' });
    return report();
  }
  if (!existsSync(directory)) {
    error('change_missing', 'Create the change and its Spec from the existing request and accepted requirements.', { kind: 'artifact' });
    return report();
  }
  try { requireChange(repo, name); } catch (cause) {
    error('change_invalid', `Restore the change metadata and preserve existing Spec content: ${cause.message}`);
    return report();
  }
  try { context = readJSON(localPath(repo, `openspec/changes/${name}/genesis.json`)); } catch (cause) {
    error('context_unavailable', `Restore the recorded code/Map context; do not invent snapshot identities: ${cause.message}`);
    return report();
  }
  if (!record(context)) {
    error('context_invalid', 'Change context must be an object. Restore its recorded values.');
    return report();
  }
  if (context.version !== 1 || !['new', 'existing'].includes(context.project_mode) || !record(context.map) || !record(context.baseline) || !record(context.code)) {
    error('context_invalid', 'Invalid change context in genesis.json.');
  }
  if (context.baseline?.status !== 'not_run' || !['no_implementation', 'unknown'].includes(context.baseline?.availability)) {
    error('baseline_invalid', 'The spec stage can only record an unexecuted baseline with no_implementation or unknown availability.');
  }
  if (!['available', 'missing', 'not_applicable'].includes(context.map?.status)) error('map_invalid', 'Invalid Map status.');
  if (context.map?.status === 'available') {
    try {
      const mapContent = readFileSync(path.resolve(repo, context.map.path), 'utf8');
      if (digest(mapContent) !== context.map.sha256) error('map_changed', 'Referenced Map changed; restore the recorded snapshot or create a new change with the updated Map.');
      else {
        const flows = JSON.parse(mapContent).flows;
        mapFlows = new Map((Array.isArray(flows) ? flows : []).map((flow) => [flow.flow_id, flow.name]));
      }
    } catch { error('map_unavailable', 'Referenced Map is unavailable; restore its snapshot before export.'); }
    warnings.push('Map freshness against the current code is not automatically verified.');
  } else if (context.project_mode === 'existing') {
    warnings.push('No Map supplied for an existing project; use repository facts and record coverage limits.');
  }
  const specRoot = localPath(repo, `openspec/changes/${name}/specs`);
  let files;
  try { files = listFiles(specRoot).filter((file) => file.endsWith('.md')); } catch (cause) {
    error('spec_unreadable', cause.message);
    return report();
  }
  if (!files.length) {
    error('spec_missing', 'No spec documents found. Author the Spec from the existing request; ask only about unresolved business decisions.', { kind: 'artifact' });
    return report();
  }
  for (const file of files) {
    const relative = path.relative(directory, file);
    const fail = (message) => error('spec_invalid', `${relative}: ${message}`, { path: relative });
    let content;
    try { content = readFileSync(file, 'utf8'); } catch (cause) { fail(cause.message); continue; }
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
      for (const question of metadata.open_questions) {
        business('business_question', `${relative}: ${question}`, { path: relative, question });
      }
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
      if (provenance.state === 'proposed') business('requirement_proposed', `${id} is proposed, not an accepted requirement.`, { path: relative, requirement_id: id });
    }
    for (const id of Object.keys(metadata.requirements ?? {})) {
      if (!seen.has(id)) fail(`Provenance ${id} has no requirement block.`);
    }
    // Explicit means the quoted words state the requirement, so one quote cannot
    // back more explicit requirements than it has statements. This catches a
    // derived rule filed under the sentence it was derived from.
    const byQuote = new Map();
    for (const id of seen) {
      const provenance = metadata.requirements?.[id];
      const quote = metadata.sources?.[provenance?.source]?.quote;
      if (provenance?.state !== 'explicit' || !nonempty(quote)) continue;
      const key = quote.replace(/\s+/g, ' ').trim();
      byQuote.set(key, [...(byQuote.get(key) ?? []), id]);
    }
    for (const [quote, cited] of byQuote) {
      const stated = statementCount(quote);
      if (cited.length > stated) {
        error('explicit_exceeds_quote', `${relative}: ${cited.join(', ')} are ${cited.length} explicit requirements resting on one quote that makes ${stated} statement${stated === 1 ? '' : 's'}. Quote the words that state each requirement as its own source, or remove a rule the user did not state.`, { path: relative, requirement_ids: cited });
      }
    }
    specs.push({ path: relative, sha256: digest(content), revision: metadata.revision, content });
  }
  const impactFile = localPath(repo, `openspec/changes/${name}/impact.md`);
  if (existsSync(impactFile)) {
    impact = readImpact(repo, impactFile, mapFlows, (message) => error('impact_invalid', `impact.md: ${message}`, { path: 'impact.md' }));
  } else if (context.project_mode === 'existing') {
    warnings.push('No impact.md for an existing project: the entries and flows this request touches are not recorded.');
  }
  let upstream;
  try {
    upstream = openspec(repo, ['validate', name, '--type', 'change', '--strict', '--json', '--no-interactive'], { allowFailure: true });
  } catch (cause) {
    error('validator_unavailable', cause.message);
    return report();
  }
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
  if (!upstream.ok && (blockingIssues.length || !waived.length)) error('spec_format_invalid', 'OpenSpec strict validation failed; see openspec diagnostics.');
  return report(upstream.data, waived);
}

export function specHandoff(repo, name, result) {
  const payload = {
    format: 'genesis.spec-handoff', version: 2, change: name,
    context: result.context, specs: result.specs,
    requirements: specRequirements(result.specs), impact: result.impact,
  };
  const id = digest(JSON.stringify(payload));
  const directory = localPath(repo, `openspec/changes/${name}/handoffs`);
  const file = localPath(repo, `openspec/changes/${name}/handoffs/${id.slice(7)}.json`);
  const handoff = { ...payload, id };
  return { id, directory, file, handoff };
}

export function handoffStatus({ file, handoff }) {
  if (!existsSync(file)) return 'missing';
  try { return JSON.stringify(readJSON(file)) === JSON.stringify(handoff) ? 'valid' : 'invalid'; }
  catch { return 'invalid'; }
}

export function exportSpec(repo, name) {
  const result = validateSpec(repo, name);
  if (!result.ready_for_eval_design) {
    throw Object.assign(new Error(`Spec is not ready for Eval design: ${[...result.errors, ...result.blockers].join('; ')}`), {
      code: 'SPEC_INPUT_BLOCKED', gaps: result.gaps,
      resume: { stage: 'spec-export', change: name, command: ['spec', 'export', name, '--repo', repo] },
    });
  }
  const { id, directory, file, handoff } = specHandoff(repo, name, result);
  const status = handoffStatus({ file, handoff });
  if (status === 'invalid') {
    throw Object.assign(new Error('Existing handoff has been modified. Restore its original contents; do not overwrite it.'), {
      code: 'HANDOFF_INVALID',
      gaps: [{ code: 'handoff_invalid', kind: 'technical', owner: 'agent', route: 'spec-export', path: file, message: 'Restore the original frozen handoff before retrying.' }],
      resume: { stage: 'spec-export', change: name, command: ['spec', 'export', name, '--repo', repo] },
    });
  }
  if (status === 'missing') {
    mkdirSync(directory, { recursive: true });
    writeJSON(file, handoff);
  }
  return {
    id, file, ready_for_eval_design: true, warnings: result.warnings,
    review: specReview(result.specs),
    impact: result.impact?.entries ?? null,
    next: 'write-eval (planned): derive cases and execution bindings from this frozen spec handoff.',
  };
}
