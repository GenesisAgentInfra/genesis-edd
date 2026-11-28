import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  MAP_COMPUTED, SCHEMA, captureContext, changeDirectory, codeNamedSteps, digest, listFiles, localPath,
  mapCopy, mapFacts, openspec, outsideFlows, readJSON, readMap, requireProject, writeJSON,
} from './project.js';
import { readDecisions } from './records.js';

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const short = (id) => (typeof id === 'string' ? id.replace(/^sha256:/, '').slice(0, 12) : String(id));
const posix = (file) => String(file).replaceAll('\\', '/');
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const STATES = ['explicit', 'confirmed', 'proposed'];
const KINDS = ['user', 'accepted_spec', 'agent'];

// A gap of the Spec layer. Gaps name the fact, the file and whose decision
// it is; they never name a skill or a recovery path.
const gapOf = (code, kind, owner, message, details = {}) => ({ code, kind, owner, layer: 'spec', message, ...details });
// Refusals carry their gaps, as every module's do.
const refuse = (message, gaps, code = 'SPEC_INPUT_BLOCKED') => Object.assign(new Error(message), { code, gaps });

// Specs and impact.md are read with LF line ends, so a checkout that turns
// them into CRLF, such as Git's core.autocrlf on Windows, keeps the identity
// of the Spec and its export.
const lf = (text) => text.replace(/\r\n/g, '\n');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const REQUIREMENT_ID = /^(REQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s+(.+)$/;
const REQUIREMENT_ONLY = /^REQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const REQUIREMENT_MENTION = /REQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
const REQUIREMENT_SPLIT = /^### Requirement:\s*/m;
// The one form of a scenario step that reaches the export.
const STEP = /^\s*-\s*\*\*(GIVEN|WHEN|THEN|AND)\*\*\s*(.+)$/;
const KEYWORDS = ['GIVEN', 'WHEN', 'THEN', 'AND'];
// The source of the requirements of a spec file that has no Genesis
// frontmatter, as in an adopted OpenSpec change: the agent's, never accepted.
const ADOPTED = 'adopted';

export function newSpec(repo, name, options = {}) {
  const project = requireProject(repo);
  const directory = changeDirectory(repo, name);
  const mode = options.mode ?? project.mode;
  if (!['new', 'existing'].includes(mode)) throw new Error('--mode must be new or existing.');
  if (options.adopt) return adoptChange(repo, name, mode, options);
  if (existsSync(directory)) {
    const unfinished = unfinishedChange(repo, name);
    const message = unfinished ?? `openspec/changes/${name}/ already exists. \`spec new --adopt\` adds the Genesis record to it and leaves its files as they are.`;
    throw refuse(message, [gapOf(unfinished ? 'change_unfinished' : 'change_exists', 'artifact', 'agent', message, { path: `openspec/changes/${name}/` })], 'SPEC_CHANGE_EXISTS');
  }
  // The Map is checked before anything is created.
  const map = options.map ? readMap(repo, options.map, name) : null;
  const context = captureContext(repo, mode, map?.record);
  const result = openspec(repo, ['new', 'change', name, '--schema', SCHEMA, '--json']);
  // Written before genesis.json, which points at it.
  if (map) writeFileSync(localPath(repo, map.record.path), map.bytes, { flag: 'wx' });
  writeJSON(path.join(directory, 'genesis.json'), context);
  const warnings = [...(map?.warnings ?? []), ...dockerignoreWarning(repo)];
  return { change: name, directory, context, warnings, openspec: result.data, instructions: specInstructions(repo, name) };
}

// The code `spec new` records includes the project's .dockerignore, which
// decides what goes into an image. An eval package that builds from the
// project root needs a .genesis line there; added later, it shows as a code
// change before the baseline.
function dockerignoreWarning(repo) {
  let text = '';
  try { text = readFileSync(path.join(repo, '.dockerignore'), 'utf8'); } catch { /* no .dockerignore */ }
  const rule = text.split(/\r?\n/).map((line) => line.trim()).some((line) => /^\/?\.genesis(\/(\*\*)?)?$/.test(line));
  if (rule) return [];
  return ['The code recorded for this change includes .dockerignore, and it has no .genesis line. An eval package that builds from the project root needs one, so expected results stay out of the image; added after this point, it shows at confirmation as a code change before the baseline. Its other lines are the user\'s call.'];
}

// spec new --adopt: an OpenSpec change that exists already gets the Genesis
// record, genesis.json, and nothing of it is rewritten. A spec file without
// Genesis frontmatter is read as the agent's: its requirements have source
// kind agent and state proposed, so no export holds them until their sources
// and states are written. genesis.json lists what the change held when it was
// adopted, by digest and requirement heading.
function adoptChange(repo, name, mode, options) {
  const directory = changeDirectory(repo, name);
  const folder = `openspec/changes/${name}/`;
  const fail = (code, message) => refuse(message, [gapOf(code, 'artifact', 'agent', message, { path: folder })], 'SPEC_ADOPT_BLOCKED');
  if (!existsSync(directory)) throw fail('change_missing', `${folder} does not exist, so there is no change to adopt.`);
  const metadataFile = path.join(directory, '.openspec.yaml');
  if (!existsSync(metadataFile)) throw fail('change_invalid', `${folder} has no .openspec.yaml, so it is not an OpenSpec change. \`spec import\` takes requirements written in another form.`);
  let metadata;
  try { metadata = parse(readFileSync(metadataFile, 'utf8')); } catch (cause) { throw fail('change_invalid', `${folder}.openspec.yaml cannot be read: ${cause.message}`); }
  if (metadata?.skip_specs) throw fail('change_invalid', `${folder}.openspec.yaml sets skip_specs: the change declares no requirements.`);
  const contextFile = path.join(directory, 'genesis.json');
  if (existsSync(contextFile)) throw fail('change_adopted', `${folder}genesis.json exists: the change already has its Genesis record.`);
  // A Map given now, else the copy a spec new that stopped early left behind.
  const copy = localPath(repo, mapCopy(name));
  let map = null;
  if (options.map) {
    map = readMap(repo, options.map, name);
    if (existsSync(copy) && digest(readFileSync(copy)) !== map.record.sha256) {
      throw fail('map_exists', `${mapCopy(name)} already holds another Map, and adopting changes no file of the change. Once the change is adopted, \`spec remap\` replaces it until the first export.`);
    }
  } else if (existsSync(copy)) map = readMap(repo, mapCopy(name), name);
  let files;
  try { files = listFiles(path.join(directory, 'specs')).filter((file) => file.endsWith('.md')); } catch (cause) { throw fail('spec_unreadable', cause.message); }
  const adopted = files.map((file) => {
    const content = lf(readFileSync(file, 'utf8'));
    const relative = path.relative(directory, file);
    const requirements = content.split(REQUIREMENT_SPLIT).slice(1).map((block) => block.split('\n')[0].trim());
    return { path: relative, sha256: digest(content), genesis: FRONTMATTER.test(content), requirements };
  });
  const context = { ...captureContext(repo, mode, map?.record), adopted: { at: new Date().toISOString(), schema: metadata?.schema ?? null, files: adopted } };
  if (map && !existsSync(copy)) writeFileSync(copy, map.bytes, { flag: 'wx' });
  writeJSON(contextFile, context);
  const warnings = [...(map?.warnings ?? [])];
  const bare = adopted.filter((file) => !file.genesis);
  if (bare.length) {
    warnings.push(`${bare.map((file) => file.path).join(', ')} ${bare.length === 1 ? 'has' : 'have'} no Genesis frontmatter, so ${bare.length === 1 ? 'its' : 'their'} requirements are read as the agent's proposals (source kind agent, state proposed). No export holds them until their sources and states are written.`);
  }
  if (metadata?.schema !== SCHEMA) {
    warnings.push(`The change uses the OpenSpec schema ${JSON.stringify(metadata?.schema ?? null)}, not ${SCHEMA}. Its files stay as they are; OpenSpec findings that do not change what Genesis reads are warnings.`);
  }
  if (!files.length) warnings.push(`${folder}specs/ holds no spec file yet.`);
  let instructions = null;
  try { instructions = specInstructions(repo, name); } catch (cause) { warnings.push(`OpenSpec gives no Spec instructions for this change: ${cause.message}`); }
  return { change: name, directory, adopted: true, context, files: adopted, warnings, instructions };
}

// A change folder that `spec new` created and did not finish: OpenSpec made it,
// and genesis.json was never written. It holds only what spec new writes, and
// none of it is in Git, so deleting it loses nothing. Returns what happened, or
// null for any other folder.
function unfinishedChange(repo, name) {
  const directory = changeDirectory(repo, name);
  if (!existsSync(directory) || existsSync(path.join(directory, 'genesis.json'))) return null;
  let files;
  try { files = listFiles(directory).map((file) => path.relative(directory, file).split(path.sep).join('/')); } catch { return null; }
  if (files.some((file) => !['.openspec.yaml', 'business-map.json'].includes(file))) return null;
  const folder = `openspec/changes/${name}/`;
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000 });
  const inGit = git('rev-parse', '--is-inside-work-tree').status === 0;
  if (inGit) {
    const tracked = git('ls-files', '-z', '--', folder);
    if (tracked.status !== 0 || tracked.stdout) return null;
  }
  return `${folder} has no genesis.json${inGit ? ' and nothing in it is in Git' : ''}: an earlier \`spec new\` stopped before it finished, so no code or Map context was recorded. The folder holds only what spec new writes, so deleting it loses nothing; \`spec new --adopt\` records the context for it instead.`;
}

// Whether Git keeps the Map a Spec depends on: null when it does or when this
// is not a Git checkout, otherwise why other clones will not have it.
function mapInGit(repo, file, genesisFile) {
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000 }).status === 0;
  if (!git('rev-parse', '--is-inside-work-tree')) return null;
  if (git('check-ignore', '-q', '--', file)) return 'is ignored by Git';
  const tracked = (target) => git('ls-files', '--error-unmatch', '--', target);
  return tracked(path.relative(repo, genesisFile)) && !tracked(file) ? 'is not in Git, though genesis.json is' : null;
}

// Whether genesis.json marks the change as adopted from an OpenSpec change.
function adoptedChange(directory) {
  try { return record(readJSON(path.join(directory, 'genesis.json')).adopted); } catch { return false; }
}

function requireChange(repo, name) {
  requireProject(repo);
  const directory = changeDirectory(repo, name);
  const metadata = parse(readFileSync(path.join(directory, '.openspec.yaml'), 'utf8'));
  if (metadata?.skip_specs) throw new Error('The change sets skip_specs in .openspec.yaml, so it declares no requirements.');
  if (metadata?.schema !== SCHEMA && !adoptedChange(directory)) {
    throw new Error(`Expected a ${SCHEMA} change; this one uses ${JSON.stringify(metadata?.schema ?? null)}. \`spec new --adopt\` adds the Genesis record to a change of another schema.`);
  }
  return directory;
}

export function specInstructions(repo, name) {
  requireChange(repo, name);
  return openspec(repo, ['instructions', 'specs', '--change', name, '--json']).data;
}

// The change as OpenSpec sees it, with its current export. A change that
// only holds an import has no OpenSpec files.
export function specStatus(repo, name) {
  requireProject(repo);
  const directory = changeDirectory(repo, name);
  const current = currentExport(repo, name);
  const exported = current.id ? { id: current.id, file: current.file, source: current.source, at: current.at } : null;
  const note = 'Artifact completion is not business approval or evaluation readiness.';
  if (!existsSync(path.join(directory, '.openspec.yaml')) && exported) {
    return { change: name, context: current.handoff?.context ?? null, openspec: null, export: exported, export_gaps: current.gaps, note };
  }
  requireChange(repo, name);
  let context = null;
  try { context = readJSON(path.join(directory, 'genesis.json')); } catch { /* spec validate names it */ }
  return {
    change: name, context, openspec: openspec(repo, ['status', '--change', name, '--json']).data,
    export: exported, export_gaps: current.gaps, note,
  };
}

// Sentence-level statements in a quotation. Commas do not split: clauses of one
// sentence usually qualify each other rather than state separate rules.
const statementCount = (quote) => Math.max(1,
  quote.split(/[。！？；!?;\n]+|\.(?=\s|$)/).filter((part) => part.trim()).length);

// The ID and name of a requirement heading. A spec file without Genesis
// frontmatter may have headings without a REQ- ID; each gets one from its
// file and its place there, so the same file always gives the same IDs.
function headingOf(file, text, genesis, position) {
  const heading = text.trim();
  const named = REQUIREMENT_ID.exec(heading);
  if (named) return { id: named[1], name: named[2].trim() };
  if (genesis) return null;
  return { id: `REQ-ADOPTED-${digest(posix(file)).slice(7, 15)}-${position}`, name: heading };
}

// The frontmatter and body of a spec file. A file without Genesis frontmatter
// reads as written by the agent: every requirement proposed, from one source
// of kind agent.
function specDocument(file, content) {
  const match = FRONTMATTER.exec(content);
  if (match) return { genesis: true, metadata: parse(match[1]), body: content.slice(match[0].length) };
  const requirements = {};
  content.split(REQUIREMENT_SPLIT).slice(1).forEach((block, index) => {
    const identity = headingOf(file, block.split(/\r?\n/)[0], false, index + 1);
    requirements[identity.id] = { source: ADOPTED, state: 'proposed' };
  });
  return {
    genesis: false, body: content,
    metadata: {
      genesis_spec: 1, revision: 1, requirements, open_questions: [],
      sources: { [ADOPTED]: { kind: 'agent', ref: posix(file), quote: 'Written in the change before Genesis recorded it; no source is recorded.' } },
    },
  };
}

// The structured form of every requirement. Later stages read this from the
// handoff, so they never depend on how the Markdown is laid out. A step that
// is not written `- **THEN** text` is not read here; validation reports it.
export function specRequirements(specs) {
  const requirements = [];
  for (const { path: file, content } of specs) {
    const { metadata, body, genesis } = specDocument(file, content);
    body.split(REQUIREMENT_SPLIT).slice(1).forEach((block, position) => {
      const [heading, ...rest] = block.split(/\r?\n/);
      const { id, name } = headingOf(file, heading, genesis, position + 1) ?? { id: heading.trim(), name: heading.trim() };
      const [intro, ...parts] = rest.join('\n').split(/^## /m)[0].split(/^#### Scenario:\s*(.*)$/m);
      const scenarios = [];
      for (let index = 0; index < parts.length; index += 2) {
        const scenario = { name: parts[index].trim(), given: [], when: [], then: [] };
        let step;
        for (const line of parts[index + 1].split('\n')) {
          const clause = STEP.exec(line);
          if (!clause) continue;
          if (clause[1] !== 'AND') step = clause[1].toLowerCase();
          if (step) scenario[step].push(clause[2].trim());
        }
        scenarios.push(scenario);
      }
      const provenance = metadata?.requirements?.[id];
      const source = metadata?.sources?.[provenance?.source];
      requirements.push({
        id, name, path: file, state: provenance?.state,
        basis: { source: provenance?.source, kind: source?.kind, ref: source?.ref, quote: source?.quote },
        ...(provenance?.confirmation ? { confirmation: provenance.confirmation } : {}),
        statement: intro.split('\n').map((line) => line.trim()).filter(Boolean).join(' '),
        scenarios,
      });
    });
  }
  return requirements;
}

// Each requirement beside the words it rests on, for the user to read, with
// every scenario's GIVEN, WHEN and THEN lines: a boundary can sit in the setup
// as well as in the outcome. The CLI cannot judge whether a quote really
// states a requirement; a person can.
const reviewOf = (requirements) => requirements.map(({ id, basis, scenarios, ...rest }) => ({
  requirement: id, ...rest, basis: { source: basis.source, kind: basis.kind, quote: basis.quote },
  outcomes: scenarios.flatMap((scenario) => scenario.then),
  scenarios: scenarios.map(({ name, given, when, then }) => ({ name, given, when, then })),
}));
export const specReview = (specs, excluded = []) => reviewOf(specRequirements(specs).filter((requirement) => !excluded.includes(requirement.id)));

// The first word of a line as a reader takes it, with list markers, emphasis,
// backticks and a trailing colon left out, when that word is GIVEN, WHEN,
// THEN or AND in any case: the step it reads as, or null. Inside a scenario a
// list item is a step to its reader whatever the case; elsewhere, and for
// text that is not a list item, only a word set apart by emphasis, a colon or
// capitals is.
function stepWord(line, inScenario) {
  const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
  const text = (item ? item[1] : line).trim();
  const lead = /^[*_`~\s]*/.exec(text)[0];
  const word = /^[A-Za-z]+/.exec(text.slice(lead.length))?.[0];
  if (!word || !KEYWORDS.includes(word.toUpperCase())) return null;
  const after = text.slice(lead.length + word.length);
  const marked = lead.length > 0 || /^[*_`~]*:/.test(after) || word === word.toUpperCase();
  return (item && inScenario) || marked ? word.toUpperCase() : null;
}

// Genesis's own reading of the scenarios of one spec file, with the same
// boundaries specRequirements uses: every requirement has a scenario, every
// scenario a GIVEN or WHEN step and a THEN step, and no line that reads as a
// step is left out of the export unnoticed. Returns findings, each with the
// line in the file and the requirement it belongs to (null outside one).
function scanScenarios(content, idOf) {
  const findings = [];
  const lines = content.split('\n');
  const match = FRONTMATTER.exec(content);
  let requirement = null;
  let scenario = null;
  let fenced = false;
  let position = 0;
  const finding = (code, line, message, extra = {}) => findings.push({ code, line, message, requirement: requirement?.id ?? null, ...extra });
  const closeScenario = () => {
    if (!scenario) return;
    const missing = [!scenario.trigger && 'a GIVEN or WHEN step', !scenario.outcome && 'a THEN step'].filter(Boolean);
    if (missing.length) finding('scenario_incomplete', scenario.line, `scenario "${scenario.name}" of ${requirement.id} lacks ${missing.join(' and ')}`, { scenario: scenario.name });
    scenario = null;
  };
  const closeRequirement = () => {
    closeScenario();
    if (requirement && !requirement.scenarios) finding('scenario_missing', requirement.line, `${requirement.id} has no scenario`);
    requirement = null;
  };
  for (let index = match ? match[0].split('\n').length - 1 : 0; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    if (/^### Requirement:/.test(line)) {
      closeRequirement();
      position += 1;
      requirement = { id: idOf(line.replace(/^### Requirement:\s*/, ''), position), line: number, scenarios: 0 };
      fenced = false;
      continue;
    }
    if (/^## /.test(line)) { closeRequirement(); fenced = false; continue; }
    if (requirement && /^#### Scenario:/.test(line)) {
      closeScenario();
      requirement.scenarios += 1;
      scenario = { name: line.replace(/^#### Scenario:\s*/, '').trim(), line: number, trigger: false, outcome: false, step: null };
      fenced = false;
      continue;
    }
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const quoted = line.trim().length > 80 ? `${line.trim().slice(0, 77)}...` : line.trim();
    const clause = STEP.exec(line);
    if (clause) {
      if (!scenario) { finding('step_malformed', number, `"${quoted}" is a ${clause[1]} step outside any scenario, so no scenario holds it`); continue; }
      if (clause[1] === 'AND' && !scenario.step) { finding('step_malformed', number, `"${quoted}" is an AND step before any GIVEN, WHEN or THEN step, so it belongs to none`, { scenario: scenario.name }); continue; }
      if (clause[1] !== 'AND') scenario.step = clause[1];
      if (!clause[2].trim()) { finding('step_malformed', number, `a ${clause[1]} step of scenario "${scenario.name}" has no text`, { scenario: scenario.name }); continue; }
      if (scenario.step === 'THEN') scenario.outcome = true;
      else scenario.trigger = true;
      continue;
    }
    if (fenced) continue;
    const word = stepWord(line, Boolean(scenario));
    if (word) {
      finding('step_malformed', number, `"${quoted}" reads as a ${word} step but is not written \`- **${word}** text\`, so it is not part of ${scenario ? `scenario "${scenario.name}"` : 'any scenario'}`,
        scenario ? { scenario: scenario.name } : {});
    }
  }
  closeRequirement();
  return findings;
}

// An open question of a spec file: a string, or { question, requirements }
// naming the requirements it holds back. A string holds back the requirements
// whose IDs it names. null when it is neither.
function questionOf(item) {
  if (nonempty(item)) return { question: item.trim(), requirements: [] };
  if (!record(item) || !nonempty(item.question)) return null;
  const listed = item.requirements ?? (item.requirement !== undefined ? [item.requirement] : []);
  if (!Array.isArray(listed) || listed.some((id) => !nonempty(id))) return null;
  return { question: item.question.trim(), requirements: listed.map((id) => id.trim()) };
}
const mentioned = (text, ids) => [...text.matchAll(REQUIREMENT_MENTION)].map(([id]) => id).filter((id) => ids.has(id));

// Which entries and flows a request touches, written by the agent for an
// existing project. Flow IDs and evidence are checked against the Map and
// repo; what does not check out is reported, and never stops an export.
function readImpact(repo, file, mapFlows, report) {
  const content = lf(readFileSync(file, 'utf8'));
  const sha256 = digest(content);
  const problems = [];
  const fail = (message) => { problems.push(message); report(message); };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let metadata;
  try { metadata = match && parse(match[1]); } catch (cause) {
    fail(`Invalid YAML: ${cause.message}`);
    return { path: 'impact.md', sha256, entries: [], problems };
  }
  if (!record(metadata) || metadata.genesis_impact !== 1 || !Array.isArray(metadata.entries) || !metadata.entries.length) {
    fail('Needs YAML frontmatter with genesis_impact: 1 and a non-empty entries list.');
    return { path: 'impact.md', sha256, entries: [], problems };
  }
  const entries = [];
  metadata.entries.forEach((item, index) => {
    const label = `entries[${index}]`;
    if (!record(item) || !nonempty(item.entry) || !['changes', 'may_affect'].includes(item.effect) || !nonempty(item.evidence)) {
      fail(`${label} needs entry, effect (changes or may_affect) and evidence (path or path:line); it is left out.`);
      return;
    }
    const [, target, line] = /^(.*?)(?::(\d+))?$/.exec(item.evidence.trim());
    const source = path.resolve(repo, target);
    let lines = null;
    // Evidence is read from the working tree, as it is when the Spec is checked.
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
  return { path: 'impact.md', sha256, entries, ...(problems.length ? { problems } : {}) };
}

// What the Map record says, worked out again from the Map, for the warnings
// of every check that reads the change. `flows` are those of the Map.
function mapNotes(map, flows, freshness) {
  const notes = [];
  const at = freshness?.commit ? ` of commit ${freshness.commit.slice(0, 7)}` : '';
  if (map.freshness === 'verified') notes.push(`The Map was verified against the code${at}.`);
  else if (freshness?.warning) notes.push(freshness.warning);
  if (map.mode === 'change') notes.push('This Map comes from a Genesis change review: it covers only what that review analyzed (coverage_scope partial), and a Genesis review started from it covers only those flows.');
  else if (map.mode === 'unknown') notes.push('This Map does not say whether it maps the whole project or a change review (mode unknown).');
  if (map.analysis_status === 'partial') notes.push('This Map is partial: some flows are not described yet or leave code unaccounted for, or files were left out.');
  const coverage = map.coverage;
  if (Number.isInteger(coverage?.entries_planned) && Number.isInteger(coverage?.entries_total) && coverage.entries_planned < coverage.entries_total) {
    notes.push(outsideFlows(coverage));
  }
  const { coded, total } = codeNamedSteps(flows);
  if (coded) notes.push(`${coded} of the ${total} steps in this Map belong to flows Genesis has not described yet and are named from the source code, which goes into Git with the Map copy.`);
  return notes;
}

// The Map a change records, checked against its copy, with the fields the
// CLI works out again from the Map itself instead of taking them from
// genesis.json. Returns { map, flows, problems, warnings, differs }: map is
// the record with the fields worked out now, when the copy could be read.
function checkedMap(repo, name, directory, context) {
  const problems = [];
  const warnings = [];
  const problem = (code, message, details = {}) => problems.push({ code, message, ...details });
  let flows = null;
  let differs = [];
  let map = context.map;
  const recorded = typeof context.map.path === 'string' ? context.map.path.replaceAll('\\', '/') : null;
  const copy = mapCopy(name);
  // Changes made before the Map was copied record it under .genesis/out,
  // which other clones do not have. A copy in the change folder decides for
  // them, as it does on every clone; genesis.json stays as it was exported.
  const full = (file) => path.resolve(repo, file);
  const linked = (file) => { try { return lstatSync(full(file)).isSymbolicLink(); } catch { return false; } };
  const chosen = recorded !== copy && (existsSync(full(copy)) || linked(copy)) ? copy
    : recorded && (existsSync(full(recorded)) || linked(recorded)) ? recorded : null;
  const legacy = recorded !== copy;
  const earlier = 'Genesis rewrites .genesis/out/latest/ on every run; the .genesis/out/<session>/ folders keep earlier Maps.';
  let bytes = null;
  if (chosen && linked(chosen)) {
    problem('map_unavailable', `The Map ${chosen} is a symbolic link, which other clones cannot follow; the recorded Map is a file with digest ${context.map.sha256}.`, { path: chosen, digest: context.map.sha256 });
  } else if (!chosen) {
    problem('map_unavailable', !legacy
      ? `The Map copy ${copy} is missing. It is committed with the Spec, with digest ${context.map.sha256}.`
      : `genesis.json records the Map at ${recorded ?? 'no path'}, which this checkout does not have${recorded?.startsWith('.genesis/') ? ' (Genesis keeps its output out of Git)' : ''}, and ${copy} is missing too. A clone reads the Map from ${copy}; its digest is ${context.map.sha256}. ${earlier}`,
    { path: copy, digest: context.map.sha256 });
  } else {
    try { bytes = readFileSync(full(chosen)); } catch { bytes = null; }
    // A checkout that converts the copy's line ends between LF and CRLF does
    // not change the Map: the recorded digest may be of either form.
    const matches = (content) => {
      const unix = lf(content.toString('latin1'));
      return [content, Buffer.from(unix, 'latin1'), Buffer.from(unix.replace(/\n/g, '\r\n'), 'latin1')]
        .some((form) => digest(form) === context.map.sha256);
    };
    if (bytes === null || !matches(bytes)) {
      problem('map_changed', `The Map ${chosen} no longer has the digest genesis.json records, ${context.map.sha256}.${legacy ? ` ${earlier}` : ''} Until the change is first exported, \`spec remap\` records another Map.`,
        { path: chosen, digest: context.map.sha256 });
      bytes = null;
    }
  }
  if (bytes !== null) {
    let document = null;
    try { document = JSON.parse(bytes.toString('utf8')); } catch { problem('map_unavailable', `The Map ${chosen} is not valid JSON.`, { path: chosen }); }
    if (document) {
      flows = new Map((Array.isArray(document.flows) ? document.flows : []).map((flow) => [flow?.flow_id, flow?.name]));
      if (legacy && chosen === copy) warnings.push(`genesis.json records the Map at ${recorded ?? 'no path'}; ${copy} has the recorded digest and is used, as on other clones.`);
      const kept = mapInGit(repo, chosen, path.join(directory, 'genesis.json'));
      if (kept) warnings.push(`${chosen} ${kept}, so other clones cannot check this Spec against its Map.${chosen === copy ? '' : ` A clone reads the copy at ${copy}.`}`);
      const facts = mapFacts(repo, document, { changeReport: existsSync(path.join(path.dirname(full(chosen)), 'change-report.json')), recorded: context.map });
      map = { ...omit(context.map, MAP_COMPUTED), ...facts.fields };
      const shown = (value) => (value === null || value === undefined ? 'nothing' : typeof value === 'string' ? value : JSON.stringify(value));
      differs = MAP_COMPUTED.filter((key) => JSON.stringify(context.map[key] ?? null) !== JSON.stringify(map[key] ?? null))
        .map((key) => ({ field: key, recorded: context.map[key] ?? null, computed: map[key] ?? null }));
      if (differs.length) {
        warnings.push(`genesis.json records the Map differently from what the Map gives now: ${differs.map((entry) => `${entry.field} ${shown(entry.recorded)} there, ${shown(entry.computed)} from the Map`).join('; ')}. The Map decides, and an export records what it gives.`);
      }
      warnings.push(...mapNotes(map, document.flows, facts.freshness));
    }
  }
  return { map, flows, problems, warnings, differs };
}

// The OpenSpec strict findings that change what Genesis reads as
// requirements, scenarios or steps. Every other finding, such as a short
// Purpose, a missing SHALL, an overlong requirement, text archive would not
// carry, or a spec file outside a capability folder, is a warning.
const ADVISORY_ERRORS = [/^Delta spec found at specs\//];
const STRUCTURAL_WARNINGS = [/is not a delta section, so it is ignored/, /: scenario ".*" is missing /, /Requirement must have at least one scenario/, /Delta should include requirements/];
// OpenSpec reports only the first line of text above a file's first "## "
// section. In a file with Genesis frontmatter that is always line 1, the
// frontmatter, so Genesis reads the rest of that preamble itself.
const PREAMBLE_FINDING = /^Text above the first "## " section /;

// The first line between a Genesis spec file's frontmatter and its first
// "## " section that is not blank, inside an HTML comment or the one "# "
// title: { line, text }, with the line counted in the whole file, or null.
function preambleText(content, body) {
  const start = content.slice(0, content.length - body.length).split('\n').length;
  const lines = body.split(/^## /m)[0].replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, '')).split('\n');
  let titled = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (!titled && /^#[ \t]+\S/.test(line)) { titled = true; continue; }
    return { line: start + index, text: line.trim() };
  }
  return null;
}

export function validateSpec(repo, name) {
  const directory = changeDirectory(repo, name);
  const errors = [];
  const blockers = [];
  const gaps = [];
  const warnings = [];
  const specs = [];
  const excluded = [];
  const advisory = [];
  let context = null;
  let mapFlows = null;
  let mapDiffers = [];
  let impact = null;
  const report = (upstream = {}) => ({
    change: name, valid: errors.length === 0, ready_for_eval_design: errors.length === 0 && blockers.length === 0,
    errors, blockers, gaps, warnings, context, specs, impact, excluded, map_differs: mapDiffers,
    openspec: upstream, openspec_advisory_issues: advisory,
  });
  const error = (code, message, { kind = 'technical', ...details } = {}) => {
    errors.push(message);
    gaps.push(gapOf(code, kind, 'agent', message, details));
  };
  const business = (code, message, details = {}) => {
    blockers.push(message);
    gaps.push(gapOf(code, 'business', 'user', message, details));
  };
  if (!existsSync(localPath(repo, 'openspec/config.yaml')) || !existsSync(localPath(repo, 'openspec/genesis.json'))) {
    error('project_missing', 'Genesis EDD is not initialized here: openspec/config.yaml or openspec/genesis.json is missing.', { kind: 'artifact' });
    return report();
  }
  try { requireProject(repo); } catch (cause) {
    if (cause.code === 'RUNTIME_INSIDE_PROJECT') throw cause;
    error('project_invalid', cause.message);
    return report();
  }
  if (!existsSync(directory)) {
    error('change_missing', `openspec/changes/${name}/ does not exist.`, { kind: 'artifact', path: `openspec/changes/${name}/` });
    return report();
  }
  try { requireChange(repo, name); } catch (cause) {
    error('change_invalid', `openspec/changes/${name}/ is not a change Genesis can read: ${cause.message}`, { path: `openspec/changes/${name}/.openspec.yaml` });
    return report();
  }
  try { context = readJSON(localPath(repo, `openspec/changes/${name}/genesis.json`)); } catch (cause) {
    error('context_unavailable', unfinishedChange(repo, name) ?? `genesis.json of the change cannot be read (${cause.message}). It records the code and the Map the Spec was written against, which only spec new records.`,
      { path: `openspec/changes/${name}/genesis.json` });
    return report();
  }
  if (!record(context)) {
    error('context_invalid', 'genesis.json of the change must be an object.', { path: `openspec/changes/${name}/genesis.json` });
    context = null;
    return report();
  }
  if (context.version !== 1 || !['new', 'existing'].includes(context.project_mode) || !record(context.map) || !record(context.baseline) || !record(context.code)) {
    error('context_invalid', 'Invalid change context in genesis.json.', { path: `openspec/changes/${name}/genesis.json` });
  }
  if (context.baseline?.status !== 'not_run' || !['no_implementation', 'unknown'].includes(context.baseline?.availability)) {
    error('baseline_invalid', 'The spec stage can only record an unexecuted baseline with no_implementation or unknown availability.', { path: `openspec/changes/${name}/genesis.json` });
  }
  if (!['available', 'missing', 'not_applicable'].includes(context.map?.status)) error('map_invalid', 'Invalid Map status.', { path: `openspec/changes/${name}/genesis.json` });
  if (context.map?.status === 'available') {
    const checked = checkedMap(repo, name, directory, context);
    for (const entry of checked.problems) error(entry.code, entry.message, omit(entry, ['code', 'message']));
    warnings.push(...checked.warnings);
    mapFlows = checked.flows;
    mapDiffers = checked.differs;
    context = { ...context, map: checked.map };
  } else if (context.project_mode === 'existing') {
    warnings.push('No Map supplied for an existing project; its coverage limits come from repository facts.');
  }
  const specRoot = localPath(repo, `openspec/changes/${name}/specs`);
  let files;
  try { files = listFiles(specRoot).filter((file) => file.endsWith('.md')); } catch (cause) {
    error('spec_unreadable', cause.message, { path: `openspec/changes/${name}/specs/` });
    return report();
  }
  if (!files.length) {
    error('spec_missing', `openspec/changes/${name}/specs/ holds no spec file.`, { kind: 'artifact', path: `openspec/changes/${name}/specs/` });
    return report();
  }
  const adopted = record(context.adopted);
  // The current export, to compare each file's revision with.
  const current = currentExport(repo, name);
  const exportedSpecs = new Map((current.source === 'export' ? current.handoff?.specs ?? [] : []).map((spec) => [posix(spec.path), spec]));
  const ids = new Set();
  const states = new Map();
  const questions = [];
  const findings = [];
  // Each Genesis spec file by its path under specs/, as OpenSpec names it,
  // with the text Genesis found above its first "## " section (extra).
  const preambles = new Map();
  for (const file of files) {
    const relative = path.relative(directory, file);
    const fail = (message) => error('spec_invalid', `${relative}: ${message}`, { path: relative });
    let content;
    try { content = lf(readFileSync(file, 'utf8')); } catch (cause) { fail(cause.message); continue; }
    let document;
    try { document = specDocument(relative, content); } catch (cause) { fail(`Invalid YAML: ${cause.message}`); continue; }
    if (!document.genesis && !adopted) { fail('Missing Genesis YAML frontmatter.'); continue; }
    if (!document.genesis) {
      warnings.push(`${relative} has no Genesis frontmatter: its requirements are read as the agent's proposals (source kind agent, state proposed), which no export holds.`);
    }
    const { metadata, body } = document;
    if (!record(metadata)) { fail('Frontmatter must be an object.'); continue; }
    if (metadata.genesis_spec !== 1) fail('genesis_spec must be 1.');
    if (!Number.isInteger(metadata.revision) || metadata.revision < 1) {
      warnings.push(`${relative}: revision is not a positive whole number (${JSON.stringify(metadata.revision ?? null)}).`);
    } else {
      const before = exportedSpecs.get(posix(relative));
      if (before && before.sha256 !== digest(content) && Number.isInteger(before.revision) && metadata.revision <= before.revision) {
        warnings.push(`${relative} changed since export ${short(current.id)}, and its revision is still ${metadata.revision}.`);
      }
    }
    if (!record(metadata.sources) || !Object.keys(metadata.sources).length) fail('At least one source is required.');
    for (const [id, source] of Object.entries(metadata.sources ?? {})) {
      if (!record(source) || !KINDS.includes(source.kind) || !nonempty(source.ref) || !nonempty(source.quote)) {
        fail(`Source ${id} needs kind (user/accepted_spec/agent), ref and quote.`);
      }
    }
    if (!record(metadata.requirements)) fail('requirements must map stable IDs to provenance.');
    if (!Array.isArray(metadata.open_questions)) {
      fail('open_questions must be a list.');
    } else {
      metadata.open_questions.forEach((item, index) => {
        const question = questionOf(item);
        if (!question) fail(`open_questions[${index}] must be a nonempty string, or an object with a question and the requirements it holds back.`);
        else questions.push({ path: relative, ...question });
      });
    }
    if (document.genesis) {
      const extra = preambleText(content, body);
      preambles.set(posix(path.relative(specRoot, file)), { path: relative, extra });
      if (extra) {
        error('spec_format_invalid', `${relative}:${extra.line}: text between the frontmatter and the first "## " section belongs to no requirement, so it never becomes a check, and archive would drop it: ${JSON.stringify(extra.text)}. Move it into a requirement, or into proposal.md or design.md.`,
          { path: relative, line: extra.line, text: extra.text });
      }
    }
    if (/^## (REMOVED|RENAMED) Requirements\s*$/m.test(body)) {
      fail('Removal and rename deltas are not supported by the handoff contract.');
    }
    const headings = body.split(REQUIREMENT_SPLIT).slice(1).map((block) => block.split('\n')[0]);
    const seen = new Set();
    if (!headings.length && document.genesis) fail('At least one requirement is required.');
    headings.forEach((heading, index) => {
      const identity = headingOf(relative, heading, document.genesis, index + 1);
      if (!identity) { fail(`Requirement needs a stable REQ- ID followed by its name: ${heading.trim()}`); return; }
      const { id } = identity;
      if (ids.has(id)) fail(`Duplicate requirement ID: ${id}`);
      ids.add(id);
      seen.add(id);
      const provenance = metadata.requirements?.[id];
      if (!record(provenance)) { fail(`Missing provenance for ${id}.`); return; }
      const source = metadata.sources?.[provenance.source];
      if (!source) fail(`${id} references an unknown source.`);
      if (!STATES.includes(provenance.state)) fail(`${id} has an invalid state.`);
      if (provenance.state === 'explicit' && !['user', 'accepted_spec'].includes(source?.kind)) {
        fail(`${id}: an agent suggestion cannot be an explicit user requirement.`);
      }
      if (provenance.state === 'confirmed' && (!nonempty(provenance.confirmation?.by) || !nonempty(provenance.confirmation?.ref))) {
        fail(`${id}: confirmed requires confirmation.by and confirmation.ref.`);
      }
      states.set(id, { name: identity.name, path: relative, state: provenance.state, genesis: document.genesis });
    });
    for (const id of Object.keys(metadata.requirements ?? {})) {
      if (!seen.has(id)) fail(`Provenance ${id} has no requirement block.`);
    }
    // Explicit means the quoted words state the requirement, so one quote cannot
    // back more explicit requirements than it has statements. This catches a
    // derived rule filed under the sentence it was derived from. Statements are
    // counted by sentence, which is a heuristic.
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
        error('explicit_exceeds_quote', `${relative}: ${cited.join(', ')} are ${cited.length} explicit requirements resting on one quote that makes ${stated} statement${stated === 1 ? '' : 's'}, counted by sentence (a heuristic). Each explicit requirement needs the words that state it as its own source; a rule the user did not state is not explicit.`, { path: relative, requirement_ids: cited });
      }
    }
    for (const entry of scanScenarios(content, (text, position) => headingOf(relative, text, document.genesis, position)?.id ?? text.trim())) {
      findings.push({ ...entry, path: relative, genesis: document.genesis });
    }
    specs.push({ path: relative, sha256: digest(content), revision: metadata.revision, content });
  }
  // A requirement that is proposed, or that an open question holds back, is
  // left out of the export and listed; it never becomes a check. An open
  // question that holds back no requirement holds back the export.
  const held = new Map();
  for (const question of questions) {
    const unknown = question.requirements.filter((id) => !states.has(id));
    if (unknown.length) error('spec_invalid', `${question.path}: an open question names requirements the change does not have: ${unknown.join(', ')}.`, { path: question.path, requirement_ids: unknown });
    const named = [...new Set([...question.requirements.filter((id) => states.has(id)), ...mentioned(question.question, states)])];
    if (!named.length) business('business_question', `${question.path}: ${question.question}`, { path: question.path, question: question.question });
    for (const id of named) held.set(id, [...(held.get(id) ?? []), question.question]);
  }
  for (const [id, entry] of states) {
    if (entry.state !== 'proposed' && !held.has(id)) continue;
    excluded.push({
      requirement: id, name: entry.name, path: entry.path, state: entry.state ?? null,
      reason: entry.state === 'proposed' ? 'proposed' : 'open_question',
      ...(held.has(id) ? { questions: held.get(id) } : {}),
    });
  }
  const excludedIds = new Set(excluded.map((entry) => entry.requirement));
  for (const entry of findings) {
    const message = `${entry.path}:${entry.line}: ${entry.message}.`;
    const details = { path: entry.path, line: entry.line, ...(entry.requirement ? { requirement_id: entry.requirement } : {}), ...(entry.scenario !== undefined ? { scenario: entry.scenario } : {}) };
    // What no export holds is a warning: a requirement left out, or a file read
    // as the agent's.
    if ((entry.requirement && excludedIds.has(entry.requirement)) || !entry.genesis) warnings.push(message);
    else error(entry.code, message, details);
  }
  if (!states.size && !errors.length) {
    error('requirements_missing', `The spec files of openspec/changes/${name}/ hold no requirement.`, { kind: 'artifact', path: `openspec/changes/${name}/specs/` });
  } else if (states.size && excluded.length === states.size) {
    business('requirements_all_excluded', `Every requirement of the change is proposed or held back by an open question (${excluded.map((entry) => entry.requirement).join(', ')}), so an export would hold none.`,
      { requirement_ids: excluded.map((entry) => entry.requirement) });
  }
  const impactFile = localPath(repo, `openspec/changes/${name}/impact.md`);
  if (existsSync(impactFile)) {
    impact = readImpact(repo, impactFile, mapFlows, (message) => warnings.push(`impact.md: ${message}`));
    const unchecked = context.map?.status === 'available' ? [] : [...new Set((impact?.entries ?? []).map((entry) => entry.flow).filter(Boolean))];
    if (unchecked.length) {
      warnings.push(`impact.md names flow IDs (${unchecked.join(', ')}), but no Map is recorded, so they could not be checked. A flow ID comes from the recorded Map.`);
    }
  } else if (context.project_mode === 'existing') {
    warnings.push('No impact.md for an existing project: the entries and flows this request touches are not recorded.');
  }
  let upstream;
  try {
    upstream = openspec(repo, ['validate', name, '--type', 'change', '--strict', '--json', '--no-interactive'], { allowFailure: true });
  } catch (cause) {
    error('validator_unavailable', `OpenSpec could not validate the change: ${cause.message}`, { layer: 'machine' });
    return report();
  }
  const blocking = [];
  const listed = [];
  const frontmatter = [];
  const covered = [];
  for (const item of upstream.data.items ?? []) {
    for (const issue of item.issues ?? []) {
      if (issue.level === 'INFO') continue;
      const message = String(issue.message ?? '');
      // OpenSpec's preamble finding on a Genesis file is about the frontmatter
      // when Genesis found nothing else there. Otherwise Genesis's own
      // spec_format_invalid finding, with the real line, already covers it.
      const preamble = issue.level === 'WARNING' && issue.line === 1 && PREAMBLE_FINDING.test(message) ? preambles.get(posix(issue.path ?? '')) : undefined;
      if (preamble?.extra) { covered.push(issue); continue; }
      if (preamble) { frontmatter.push(preamble.path); advisory.push(issue); continue; }
      const structural = issue.level === 'ERROR' ? !ADVISORY_ERRORS.some((pattern) => pattern.test(message)) : STRUCTURAL_WARNINGS.some((pattern) => pattern.test(message));
      // A finding about requirements no export holds changes nothing exported.
      const named = [...message.matchAll(REQUIREMENT_MENTION)].map(([id]) => id);
      const heldBack = named.length > 0 && named.every((id) => excludedIds.has(id));
      if (structural && !heldBack) blocking.push(issue);
      else { advisory.push(issue); listed.push(issue); }
    }
  }
  const where = (issue) => `${issue.message}${issue.path ? ` (${issue.path}${issue.line ? `:${issue.line}` : ''})` : ''}`;
  if (frontmatter.length) {
    warnings.push(`OpenSpec strict counts the Genesis frontmatter on line 1 of ${frontmatter.join(', ')} as text above the first "## " section, which archive would drop. Genesis keeps the frontmatter in the handoff, so the raw OpenSpec result under openspec shows valid: false and failed: 1 for any change with a Genesis spec file. Nothing needs moving.`);
  }
  if (listed.length) {
    warnings.push(`OpenSpec strict reports ${listed.length === 1 ? 'a finding that does' : `${listed.length} findings that do`} not change what Genesis reads: ${listed.map(where).join('; ')}`);
  }
  if (blocking.length) {
    error('spec_format_invalid', `OpenSpec strict reports problems that change what is read as requirements, scenarios or steps: ${blocking.map(where).join('; ')}`, { issues: blocking });
  } else if (!upstream.ok && !advisory.length && !covered.length) {
    error('spec_format_invalid', 'OpenSpec strict validation failed without naming a finding; its output is under openspec.');
  }
  return report(upstream.data);
}

// The handoff an export of this validation writes. Requirements that are
// proposed or held back by an open question are left out and listed under
// excluded; the Spec files stay whole, with their digests.
export function specHandoff(repo, name, result) {
  const held = new Set((result.excluded ?? []).map((entry) => entry.requirement));
  const payload = {
    format: 'genesis.spec-handoff', version: 2, change: name,
    context: result.context, specs: result.specs,
    requirements: specRequirements(result.specs).filter((requirement) => !held.has(requirement.id)), impact: result.impact,
    ...(result.excluded?.length ? { excluded: result.excluded } : {}),
  };
  return addressed(repo, name, payload);
}

// A handoff payload with its content address, and where it is kept.
function addressed(repo, name, payload) {
  const id = digest(JSON.stringify(payload));
  const directory = localPath(repo, `openspec/changes/${name}/handoffs`);
  const file = handoffPath(repo, name, id);
  return { id, directory, file, handoff: { ...payload, id } };
}

const handoffPath = (repo, name, id) => localPath(repo, `openspec/changes/${name}/handoffs/${id.slice(7)}.json`);

export function handoffStatus({ file, handoff }) {
  if (!existsSync(file)) return 'missing';
  try { return JSON.stringify(readJSON(file)) === JSON.stringify(handoff) ? 'valid' : 'invalid'; }
  catch { return 'invalid'; }
}

// Every export and import of a change, oldest first, one JSON line each,
// beside the handoffs, so it is committed with the Spec. Its last line names
// the current export. A change exported before this file existed has none:
// its current export is the handoff that matches its Spec files, impact.md and
// genesis.json as they are.
const EXPORT_LOG = 'exports.jsonl';
const exportLogFile = (repo, name) => localPath(repo, `openspec/changes/${name}/${EXPORT_LOG}`);

function readExportLog(repo, name) {
  const file = exportLogFile(repo, name);
  if (!existsSync(file)) return { entries: [], broken: [] };
  const entries = [];
  const broken = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (record(value) && SHA256.test(value.id ?? '')) entries.push(value);
      else broken.push(index + 1);
    } catch { broken.push(index + 1); }
  });
  return { entries, broken };
}

function appendExport(repo, name, entry) {
  const file = exportLogFile(repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// A handoff file as it is, checked against its content address only.
// Returns { handoff } or { problem }.
function readHandoff(file, id) {
  let value;
  try { value = readJSON(file); } catch (cause) { return { problem: `cannot be read (${cause.message})` }; }
  if (!record(value)) return { problem: 'is not a JSON object' };
  const { id: named, ...payload } = value;
  if (named !== id) return { problem: `names the id ${named}, not the ${id} of its file name` };
  if (digest(JSON.stringify(payload)) !== id) return { problem: 'no longer has the content its address names' };
  return { handoff: value };
}

// Whether a handoff holds together without reading anything else: each Spec
// file it holds has the digest it records, its requirements are those its
// Spec files state, less the ones it lists as excluded, and none of them is
// proposed. An import, which holds no Spec files of the change, is checked
// with Genesis's own rules for requirements instead. No OpenSpec is run.
function handoffProblems(handoff) {
  const problems = [];
  if (handoff.format !== 'genesis.spec-handoff' || handoff.version !== 2) problems.push('is not a genesis.spec-handoff of version 2');
  if (!Array.isArray(handoff.requirements) || !Array.isArray(handoff.specs ?? [])) return [...problems, 'has no requirements list'];
  const excludedIds = new Set((Array.isArray(handoff.excluded) ? handoff.excluded : []).map((entry) => entry?.requirement));
  if (handoff.source === 'import') {
    problems.push(...requirementProblems(handoff.requirements).map((entry) => entry.message));
    for (const spec of handoff.specs ?? []) {
      if (!record(spec) || typeof spec.content !== 'string' || digest(spec.content) !== spec.sha256) problems.push(`holds a document ${spec?.path ?? ''} whose digest is not the one it records`);
    }
  } else {
    for (const spec of handoff.specs) {
      if (!record(spec) || typeof spec.content !== 'string' || digest(spec.content) !== spec.sha256) problems.push(`holds ${spec?.path ?? 'a Spec file'} with another digest than the one it records`);
    }
    let derived = null;
    try { derived = specRequirements(handoff.specs); } catch { problems.push('holds Spec files that cannot be read as requirements'); }
    if (derived) {
      const kept = derived.filter((requirement) => !excludedIds.has(requirement.id));
      if (JSON.stringify(kept) !== JSON.stringify(handoff.requirements)) problems.push('holds requirements that are not the ones its Spec files state');
    }
  }
  if (handoff.requirements.some((requirement) => requirement?.state === 'proposed')) problems.push('holds a proposed requirement');
  return problems;
}

// The Spec files of a change folder as they are now: [{ path, sha256 }].
function draftSpecs(repo, name) {
  const directory = changeDirectory(repo, name);
  return listFiles(localPath(repo, `openspec/changes/${name}/specs`)).filter((file) => file.endsWith('.md'))
    .map((file) => ({ path: path.relative(directory, file), sha256: digest(lf(readFileSync(file, 'utf8'))) }));
}
const specsKey = (specs) => JSON.stringify((specs ?? []).map((spec) => [posix(spec.path), spec.sha256]).sort(([a], [b]) => a.localeCompare(b)));

// The current export of a change exported before the export log: the handoff
// whose Spec files, impact.md and context are those of the change folder now.
function legacyExport(repo, name) {
  const root = localPath(repo, `openspec/changes/${name}/handoffs`);
  let names;
  try { names = readdirSync(root).filter((file) => /^[0-9a-f]{64}\.json$/.test(file)).sort(); } catch { return { count: 0 }; }
  if (!names.length) return { count: 0 };
  let key;
  let context;
  try {
    key = specsKey(draftSpecs(repo, name));
    context = JSON.stringify(readJSON(localPath(repo, `openspec/changes/${name}/genesis.json`)));
  } catch { return { count: names.length }; }
  const impactFile = localPath(repo, `openspec/changes/${name}/impact.md`);
  const impact = existsSync(impactFile) ? digest(lf(readFileSync(impactFile, 'utf8'))) : null;
  for (const file of names) {
    const id = `sha256:${file.slice(0, 64)}`;
    const { handoff } = readHandoff(path.join(root, file), id);
    if (!handoff || handoff.source === 'import') continue;
    if (specsKey(handoff.specs) !== key || JSON.stringify(handoff.context) !== context || (handoff.impact?.sha256 ?? null) !== impact) continue;
    return { id, file: path.join(root, file), handoff, at: null, count: names.length };
  }
  return { count: names.length };
}

// The current export of a change, checked by digest only: the handoff file
// against its content address, its requirements against the Spec files it
// holds, and the Spec files of the change folder against the digests it
// records. A change to impact.md or genesis.json after the export is a
// warning: later stages read the export. Returns { id, file, handoff, source,
// at, entry, drift, gaps, warnings }.
function currentExport(repo, name) {
  const folder = `openspec/changes/${name}/`;
  const result = { id: null, file: null, handoff: null, source: null, at: null, entry: null, drift: null, gaps: [], warnings: [] };
  const missing = (code, message, details = {}) => result.gaps.push(gapOf(code, 'artifact', 'agent', message, details));
  const invalid = (message, details = {}) => result.gaps.push(gapOf('handoff_invalid', 'technical', 'agent', message, details));
  let directory;
  try {
    requireProject(repo);
    directory = changeDirectory(repo, name);
  } catch (cause) {
    if (cause.code === 'RUNTIME_INSIDE_PROJECT') throw cause;
    result.gaps.push(gapOf('project_invalid', 'technical', 'agent', cause.message));
    return result;
  }
  if (!existsSync(directory)) { missing('change_missing', `${folder} does not exist.`, { path: folder }); return result; }
  const log = readExportLog(repo, name);
  if (log.broken.length) result.warnings.push(`${folder}${EXPORT_LOG} has lines that cannot be read (${log.broken.join(', ')}); they name no export.`);
  const entry = log.entries.at(-1) ?? null;
  if (entry) {
    const file = handoffPath(repo, name, entry.id);
    const where = posix(path.relative(repo, file));
    Object.assign(result, { id: entry.id, file, entry, at: entry.at ?? null, source: entry.source === 'import' ? 'import' : 'export' });
    if (!existsSync(file)) {
      missing('handoff_missing', `${folder}${EXPORT_LOG} names export ${short(entry.id)} as the current one, and its handoff ${where} is missing.`, { path: where, digest: entry.id });
      return result;
    }
    const read = readHandoff(file, entry.id);
    if (!read.handoff) { invalid(`The handoff ${where} of export ${short(entry.id)} ${read.problem}. A handoff is never rewritten.`, { path: where, digest: entry.id }); return result; }
    result.handoff = read.handoff;
  } else {
    const found = legacyExport(repo, name);
    if (!found.handoff) {
      missing('handoff_missing', found.count
        ? `The Spec files, impact.md or genesis.json of ${folder} differ from each of its ${found.count} export${found.count === 1 ? '' : 's'} in handoffs/, so the draft is not exported.`
        : `${folder} has no export yet.`, { path: folder });
      return result;
    }
    Object.assign(result, { id: found.id, file: found.file, handoff: found.handoff, source: 'export' });
  }
  const where = posix(path.relative(repo, result.file));
  const problems = handoffProblems(result.handoff);
  if (problems.length) {
    invalid(`The handoff ${where} of export ${short(result.id)} ${problems.join('; ')}. A handoff is never rewritten.`, { path: where, digest: result.id });
    result.handoff = null;
    return result;
  }
  let draft;
  try { draft = draftSpecs(repo, name); } catch (cause) {
    result.gaps.push(gapOf('spec_unreadable', 'technical', 'agent', `${folder}specs/ cannot be read: ${cause.message}`, { path: `${folder}specs/` }));
    return result;
  }
  if (result.source === 'import') {
    if (draft.length) result.warnings.push(`${folder}specs/ holds a draft that is not exported; later stages read the imported export ${short(result.id)}.`);
    return result;
  }
  const frozen = new Map(result.handoff.specs.map((spec) => [posix(spec.path), spec.sha256]));
  const disk = new Map(draft.map((spec) => [posix(spec.path), spec.sha256]));
  const changed = [...frozen].filter(([file, sha]) => disk.has(file) && disk.get(file) !== sha).map(([file]) => file);
  const removed = [...frozen.keys()].filter((file) => !disk.has(file));
  const added = [...disk.keys()].filter((file) => !frozen.has(file));
  if (changed.length || removed.length || added.length) {
    result.drift = { changed, added, removed };
    const parts = [changed.length && `changed ${changed.join(', ')}`, added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean);
    missing('handoff_missing', `The Spec files of ${folder} differ from its current export ${short(result.id)}: ${parts.join('; ')}. Later stages read an export, and the draft is not exported.`,
      { path: `${folder}specs/`, digest: result.id, changed, added, removed });
  }
  const impactFile = localPath(repo, `openspec/changes/${name}/impact.md`);
  const impact = existsSync(impactFile) ? digest(lf(readFileSync(impactFile, 'utf8'))) : null;
  if (impact !== (result.handoff.impact?.sha256 ?? null)) {
    result.warnings.push(`impact.md differs from the one export ${short(result.id)} holds; later stages read the export's.`);
  }
  return result;
}

// The current export of a change without its payload, as a status reads it:
// { id, file, source, at, drift, requirements, excluded, gaps, warnings }.
// id is set whenever the export log or a matching handoff names one, even
// when the Spec files have moved on from it (drift). Read-only.
export function exportFacts(repo, name) {
  const current = currentExport(repo, name);
  return { id: current.id, file: current.file, source: current.source, at: current.at, drift: current.drift,
    requirements: Array.isArray(current.handoff?.requirements) ? current.handoff.requirements.map((requirement) => requirement.id) : null,
    excluded: Array.isArray(current.handoff?.excluded) ? current.handoff.excluded : [], gaps: current.gaps, warnings: current.warnings };
}

// The context of a handoff and the one a validation reads now, without the
// Map fields the CLI works out again each time.
const contextKey = (context) => JSON.stringify(record(context) && record(context.map) ? { ...context, map: omit(context.map, MAP_COMPUTED) } : context);

// Whether the current export already holds the draft as validated now: the
// same Spec files, the same impact.md and the same context.
const coversDraft = (handoff, validation) => specsKey(handoff.specs) === specsKey(validation.specs)
  && (handoff.impact?.sha256 ?? null) === (validation.impact?.sha256 ?? null)
  && contextKey(handoff.context) === contextKey(validation.context);

// The Spec as later stages may read it: its current export, checked by digest
// only (currentExport), with no OpenSpec run. Anything short of that comes back
// as gaps. With validate (the default when exported is false) the draft is
// validated too, OpenSpec included, and its gaps are returned instead; the
// export is returned only while it holds the draft.
export function frozenSpec(repo, name, { exported = true, validate = !exported } = {}) {
  const current = currentExport(repo, name);
  const found = current.handoff ? { id: current.id, directory: path.dirname(current.file), file: current.file, handoff: current.handoff } : null;
  if (validate) {
    const validation = validateSpec(repo, name);
    const gaps = [...validation.gaps, ...current.gaps.filter((gap) => exported || gap.code === 'handoff_invalid')];
    validation.warnings.push(...current.warnings);
    return { validation, gaps, handoff: current.gaps.length ? undefined : found ?? undefined, moved_evidence: [], source: current.source, exported_at: current.at };
  }
  const gaps = [...current.gaps];
  const handoff = gaps.length ? undefined : found ?? undefined;
  const validation = {
    change: name, valid: gaps.every((gap) => gap.kind === 'business'), ready_for_eval_design: Boolean(handoff),
    errors: gaps.filter((gap) => gap.kind !== 'business').map((gap) => gap.message), blockers: gaps.filter((gap) => gap.kind === 'business').map((gap) => gap.message),
    gaps, warnings: current.warnings, context: current.handoff?.context ?? null, specs: current.handoff?.specs ?? [], impact: current.handoff?.impact ?? null,
    excluded: current.handoff?.excluded ?? [], openspec: null, openspec_advisory_issues: [], checked: 'digest',
  };
  return { validation, gaps, handoff, moved_evidence: [], source: current.source, exported_at: current.at };
}

// The code recorded when the requirements of an export were first written
// down (spec new, spec new --adopt or the import), in the form a run records
// its code: { commit, changed_files, digest, digest_of?, captured_at }, or
// null. A change made before the content digest was recorded has the commit
// alone, with changed_files null when the working tree was dirty.
export function recordedCode(handoff) {
  const code = (handoff?.handoff ?? handoff)?.context?.code;
  if (!record(code)) return null;
  const snapshot = record(code.snapshot) ? code.snapshot : null;
  return {
    commit: snapshot ? snapshot.commit ?? null : code.base_commit ?? null,
    changed_files: snapshot ? snapshot.changed_files ?? null : code.working_tree_dirty === false ? [] : null,
    digest: snapshot?.digest ?? null, ...(snapshot?.digest_of ? { digest_of: snapshot.digest_of } : {}),
    captured_at: code.captured_at ?? null,
  };
}

// Whether a new export ends a loop of the change that is still running and
// not accepted. Read from the files themselves, so the Spec module does not
// load the loop module. phase is the loop's phase as loop status reports it
// ('live', 'closing', 'ended' or 'done'), null when the change has no loop,
// and undefined when it could not be read. With a phase, a loop ends only
// while it is live or closing, not accepted, and of another export than this
// one that no earlier export replaced; an ended or accepted loop, or one an
// earlier export ended, is not ended again, and its facts say which.
// Without one, loop.json must name a loop of the export this one replaces,
// which no ending decision, record of its end or acceptance covers; a loop
// that loop status reports as stopped then still counts as running.
const ENDING = ['loop_end', 'loop_decline', 'change_abandon'];
const RUNNING = ['live', 'closing'];

// How a loop ended, from loop.json or an ending decision recorded since it
// started, or null.
function loopEnd(edd, loop) {
  const ended = record(loop.ended) ? loop.ended : record(loop.closed) ? { reason: loop.closed.kind ?? 'loop_end', at: loop.closed.at ?? null }
    : nonempty(loop.ended_at) ? { at: loop.ended_at } : null;
  if (ended) return ended;
  let decisions = [];
  try { decisions = readDecisions(edd).entries; } catch { /* none readable */ }
  const decision = decisions.find((entry) => ENDING.includes(entry.type) && typeof entry.at === 'string' && entry.at >= loop.started_at);
  return decision ? { reason: decision.type, at: decision.at } : null;
}

// Whether accepted.json records the acceptance of this loop.
function loopAccepted(edd, loop) {
  try {
    const acceptance = readJSON(path.join(edd, 'accepted.json'));
    return acceptance?.spec?.sha256 === loop.spec && (acceptance.loop_started_at ? acceptance.loop_started_at === loop.started_at : true);
  } catch { return false; }
}

function loopEndedBy(repo, name, id, previous, phase) {
  const none = { ends_loop: false, loop: null };
  if (phase === null) return none;
  let edd = null;
  let loop = null;
  try {
    edd = localPath(repo, `.genesis/edd/${name}`);
    loop = readJSON(path.join(edd, 'loop.json'));
  } catch { if (phase === undefined) return none; }
  const known = record(loop) && nonempty(loop.spec) && nonempty(loop.started_at);
  // The export this one replaces is not the loop's own: an earlier export
  // ended the loop, and this one does not end it again.
  const earlier = known && loop.spec !== id && nonempty(previous) && loop.spec !== previous;
  const byEarlier = { reason: 'spec_exported', by: 'an earlier export' };
  if (phase !== undefined) {
    // loop.json may be gone while loop status still knows the loop: its
    // start and export are then unknown here.
    const facts = { started_at: known ? loop.started_at : null, export: known ? loop.spec : null, phase };
    const accepted = phase === 'done' || (known && loopAccepted(edd, loop));
    const recorded = known && (phase === 'ended' || earlier) ? loopEnd(edd, loop) : null;
    const ended = recorded ?? (earlier ? byEarlier : phase === 'ended' ? { reason: null, at: null } : null);
    return { ends_loop: RUNNING.includes(phase) && !earlier && !accepted && facts.export !== id, loop: { ...facts, accepted, ...(ended ? { ended } : {}) } };
  }
  if (!known) return none;
  const facts = { started_at: loop.started_at, export: loop.spec };
  if (loop.spec === id) return { ends_loop: false, loop: facts };
  if (earlier) return { ends_loop: false, loop: { ...facts, ended: byEarlier } };
  const ended = loopEnd(edd, loop);
  const accepted = loopAccepted(edd, loop);
  return { ends_loop: !ended && !accepted, loop: { ...facts, accepted, ...(ended ? { ended } : {}) } };
}

// What spec export and spec import return, and what the agent puts in front
// of the user (must_show): each requirement with its state, the words it
// rests on, its outcomes and its scenarios, what was left out and why, the
// warnings, the Map's facts when they limit it, and the loop this export ends.
function exportResult({ name, id, file, handoff, source, unchanged, previous, warnings, ends }) {
  const excluded = Array.isArray(handoff.excluded) ? handoff.excluded : [];
  const review = reviewOf(handoff.requirements);
  const adoptedFiles = Array.isArray(handoff.context?.adopted?.files) ? handoff.context.adopted.files : [];
  // A requirement that was in the change, without Genesis state, when it was adopted.
  const adopted = (requirement) => adoptedFiles.some((entry) => !entry?.genesis && posix(entry.path) === posix(requirement.path)
    && (entry.requirements ?? []).some((heading) => heading === `${requirement.requirement} ${requirement.name}` || heading === requirement.name));
  const map = handoff.context?.map;
  const mapShown = map?.status === 'available' && (map.freshness !== 'verified' || map.mode !== 'map' || map.analysis_status === 'partial');
  const must = {
    requirements: review.map((requirement) => ({
      requirement: requirement.requirement, name: requirement.name, state: requirement.state,
      kind: requirement.basis.kind, source: requirement.basis.source, quote: requirement.basis.quote,
      ...(requirement.confirmation ? { confirmation: requirement.confirmation } : {}),
      statement: requirement.statement, outcomes: requirement.outcomes, scenarios: requirement.scenarios,
      ...(adopted(requirement) ? { adopted_without_state: true } : {}),
    })),
    excluded: excluded.map((entry) => ({ ...entry })),
    warnings: [...warnings],
    ...(mapShown ? { map: [{ freshness: map.freshness ?? null, mode: map.mode ?? null, analysis_status: map.analysis_status ?? null, ...(map.coverage_scope ? { coverage_scope: map.coverage_scope } : {}) }] } : {}),
    ...(ends.ends_loop ? { loop_ended: [{ started_at: ends.loop.started_at, export: ends.loop.export }] } : {}),
  };
  return {
    change: name, id, file, source, exported: !unchanged, unchanged, previous: previous ?? null,
    ready_for_eval_design: true, warnings, review, excluded, impact: handoff.impact?.entries ?? null,
    map: map ?? null, ends_loop: ends.ends_loop, loop: ends.loop, must_show: must,
  };
}

// spec export. options.loopPhase is the phase loop status reports for the
// change's loop, null when it has none; it decides whether this export ends
// that loop (loopEndedBy).
export function exportSpec(repo, name, options = {}) {
  const validation = validateSpec(repo, name);
  const current = currentExport(repo, name);
  // The draft is already the current export: exporting again changes nothing,
  // whatever has moved in the code since.
  if (current.handoff && current.source === 'export' && !current.drift && validation.specs.length && coversDraft(current.handoff, validation)) {
    const warnings = [...current.warnings, ...validation.warnings];
    const findings = [...validation.errors, ...validation.blockers];
    if (findings.length) warnings.push(`The Spec files are those of the current export ${short(current.id)}, which stays as it is. Checked now, they also show: ${findings.join(' ')}`);
    return exportResult({ name, id: current.id, file: current.file, handoff: current.handoff, source: 'export', unchanged: true, previous: current.id, warnings, ends: { ends_loop: false, loop: null } });
  }
  if (!validation.ready_for_eval_design) {
    throw refuse(`The Spec cannot be exported: ${[...validation.errors, ...validation.blockers].join(' ')}`, validation.gaps);
  }
  const { id, directory, file, handoff } = specHandoff(repo, name, validation);
  const status = handoffStatus({ file, handoff });
  if (status === 'invalid') {
    const where = posix(path.relative(repo, file));
    const message = `${where} exists with other content than the export it is named for (${short(id)}). A handoff is never rewritten.`;
    throw refuse(message, [gapOf('handoff_invalid', 'technical', 'agent', message, { path: where, digest: id })], 'HANDOFF_INVALID');
  }
  if (status === 'missing') {
    mkdirSync(directory, { recursive: true });
    writeJSON(file, handoff);
  }
  const previous = current.id;
  if (current.entry?.id !== id) appendExport(repo, name, { id, source: 'export', previous: previous ?? null });
  const ends = loopEndedBy(repo, name, id, previous, options.loopPhase);
  return exportResult({ name, id, file, handoff, source: 'export', unchanged: false, previous, warnings: [...current.warnings, ...validation.warnings], ends });
}

// Genesis's own rules for requirements in the shape a handoff holds them,
// for an import and for an imported export: a stable unique ID, a name and
// statement, a state, a source with kind, ref and quote, explicit resting on
// the user's or an accepted spec's words, confirmed naming who confirmed it
// and where, and at least one scenario, each with a GIVEN or WHEN step, a
// THEN step and no empty step. One quote backs no more explicit requirements
// than the statements it makes (a heuristic). [{ code, message, requirement }].
function requirementProblems(requirements) {
  const problems = [];
  const add = (code, message, requirement = null) => problems.push({ code, message, requirement });
  if (!Array.isArray(requirements) || !requirements.length) {
    add('requirements_missing', 'requirements must be a non-empty list.');
    return problems;
  }
  const ids = new Set();
  const byQuote = new Map();
  requirements.forEach((requirement, index) => {
    const label = record(requirement) && nonempty(requirement.id) ? requirement.id : `requirements[${index}]`;
    if (!record(requirement)) { add('requirement_invalid', `${label} must be an object.`); return; }
    const id = requirement.id;
    if (!REQUIREMENT_ONLY.test(id ?? '')) add('requirement_invalid', `${label} needs a stable id that starts with REQ-.`, id ?? null);
    else if (ids.has(id)) add('requirement_invalid', `Duplicate requirement ID: ${id}.`, id);
    ids.add(id);
    if (!nonempty(requirement.name)) add('requirement_invalid', `${label} needs a name.`, id);
    if (!nonempty(requirement.statement)) add('requirement_invalid', `${label} needs a statement: the requirement in words.`, id);
    if (!STATES.includes(requirement.state)) add('state_invalid', `${label} needs a state: explicit, confirmed or proposed.`, id);
    const basis = requirement.basis;
    if (!record(basis) || !nonempty(basis.source) || !KINDS.includes(basis.kind) || !nonempty(basis.ref) || !nonempty(basis.quote)) {
      add('source_invalid', `${label} needs basis with source, kind (user, accepted_spec or agent), ref and quote.`, id);
    } else if (requirement.state === 'explicit' && !['user', 'accepted_spec'].includes(basis.kind)) {
      add('source_invalid', `${label}: an agent suggestion cannot be an explicit user requirement.`, id);
    }
    if (requirement.state === 'confirmed' && (!nonempty(requirement.confirmation?.by) || !nonempty(requirement.confirmation?.ref))) {
      add('confirmation_missing', `${label}: confirmed requires confirmation.by and confirmation.ref.`, id);
    }
    if (requirement.state === 'explicit' && record(basis) && nonempty(basis.quote)) {
      const key = basis.quote.replace(/\s+/g, ' ').trim();
      byQuote.set(key, [...(byQuote.get(key) ?? []), label]);
    }
    if (!Array.isArray(requirement.scenarios) || !requirement.scenarios.length) { add('scenario_missing', `${label} has no scenario.`, id); return; }
    const names = new Set();
    requirement.scenarios.forEach((scenario, position) => {
      const where = `${label} scenario ${position + 1}`;
      if (!record(scenario)) { add('scenario_invalid', `${where} must be an object.`, id); return; }
      if (!nonempty(scenario.name)) add('scenario_invalid', `${where} needs a name.`, id);
      else if (names.has(scenario.name.trim())) add('scenario_invalid', `${label} has two scenarios named "${scenario.name.trim()}".`, id);
      else names.add(scenario.name.trim());
      const steps = ['given', 'when', 'then'];
      if (steps.some((step) => !Array.isArray(scenario[step]))) { add('scenario_invalid', `${where} needs given, when and then lists.`, id); return; }
      if (steps.some((step) => scenario[step].some((text) => !nonempty(text)))) add('step_malformed', `${where} has an empty step.`, id);
      const missing = [!scenario.given.length && !scenario.when.length && 'a GIVEN or WHEN step', !scenario.then.length && 'a THEN step'].filter(Boolean);
      if (missing.length) add('scenario_incomplete', `${where} lacks ${missing.join(' and ')}.`, id);
    });
  });
  for (const [quote, cited] of byQuote) {
    const stated = statementCount(quote);
    if (cited.length > stated) {
      add('explicit_exceeds_quote', `${cited.join(', ')} are ${cited.length} explicit requirements resting on one quote that makes ${stated} statement${stated === 1 ? '' : 's'}, counted by sentence (a heuristic).`);
    }
  }
  return problems;
}

// A requirement of an import in the shape spec export writes it.
const importedRequirement = (requirement, file) => ({
  id: requirement.id.trim(), name: requirement.name.trim(), path: nonempty(requirement.path) ? requirement.path.trim() : file, state: requirement.state,
  basis: { source: requirement.basis.source.trim(), kind: requirement.basis.kind, ref: requirement.basis.ref.trim(), quote: requirement.basis.quote.trim() },
  ...(record(requirement.confirmation) ? { confirmation: { by: String(requirement.confirmation.by).trim(), ref: String(requirement.confirmation.ref).trim() } } : {}),
  statement: requirement.statement.trim(),
  scenarios: requirement.scenarios.map((scenario) => ({
    name: scenario.name.trim(), given: scenario.given.map((text) => text.trim()), when: scenario.when.map((text) => text.trim()), then: scenario.then.map((text) => text.trim()),
  })),
});

// spec import: requirements written somewhere else, such as an issue, a PRD
// or a team's own format, turned into a handoff in the shape spec export
// writes, checked with Genesis's own rules (requirementProblems) and kept
// content-addressed like an export, with source import. Its context is the
// one Genesis EDD reads from the project: genesis.json of the change when
// spec new recorded one, else the code as it is now. Proposed requirements and
// those an open question holds back are left out and listed; an open question
// that holds back none stops the import. options.loopPhase is read as by spec
// export.
export function importSpec(repo, name, options = {}) {
  const project = requireProject(repo);
  const directory = changeDirectory(repo, name);
  const folder = `openspec/changes/${name}/`;
  if (!nonempty(options.handoff)) throw new Error('--handoff names the JSON file to import.');
  const sourceFile = path.resolve(repo, options.handoff);
  let bytes;
  try { bytes = readFileSync(sourceFile); } catch (cause) { throw new Error(`--handoff ${options.handoff} cannot be read: ${cause.message}`); }
  const within = path.relative(repo, sourceFile);
  const shownFile = within && !within.startsWith('..') && !path.isAbsolute(within) ? posix(within) : path.basename(sourceFile);
  const imported = { file: shownFile, sha256: digest(bytes) };
  const current = currentExport(repo, name);
  // The same file imported again is the current export already.
  if (current.handoff && current.source === 'import' && current.handoff.imported?.sha256 === imported.sha256) {
    return exportResult({ name, id: current.id, file: current.file, handoff: current.handoff, source: 'import', unchanged: true, previous: current.id, warnings: [...current.warnings], ends: { ends_loop: false, loop: null } });
  }
  const gaps = [];
  const warnings = [];
  const fail = (code, message, details = {}) => gaps.push(gapOf(code, 'technical', 'agent', message, { path: shownFile, ...details }));
  const ask = (code, message, details = {}) => gaps.push(gapOf(code, 'business', 'user', message, { path: shownFile, ...details }));
  let given = null;
  try { given = JSON.parse(bytes.toString('utf8')); } catch (cause) { fail('import_invalid', `${shownFile} is not JSON: ${cause.message}`); }
  let requirements = [];
  let specs = [];
  let impact = null;
  const excluded = [];
  if (given !== null && (!record(given) || given.format !== 'genesis.spec-handoff' || given.version !== 2)) {
    fail('import_invalid', `${shownFile} is not a genesis.spec-handoff of version 2, the shape spec export writes.`);
  } else if (given !== null) {
    if (given.change !== undefined && given.change !== name) fail('import_invalid', `${shownFile} is for the change ${JSON.stringify(given.change)}, not ${name}.`);
    const problems = requirementProblems(given.requirements);
    for (const entry of problems) fail(entry.code, `${shownFile}: ${entry.message}`, entry.requirement ? { requirement_id: entry.requirement } : {});
    if (!problems.length) requirements = given.requirements.map((requirement) => importedRequirement(requirement, shownFile));
    if (given.specs !== undefined) {
      if (!Array.isArray(given.specs)) fail('import_invalid', `${shownFile}: specs must be a list of documents with path and content.`);
      else {
        given.specs.forEach((spec, index) => {
          if (!record(spec) || !nonempty(spec.path) || typeof spec.content !== 'string') { fail('import_invalid', `${shownFile}: specs[${index}] needs path and content.`); return; }
          const sha256 = digest(spec.content);
          if (spec.sha256 !== undefined && spec.sha256 !== sha256) { fail('import_invalid', `${shownFile}: specs[${index}] (${spec.path}) records sha256 ${spec.sha256}, and its content has ${sha256}.`); return; }
          specs.push({ path: spec.path.trim(), sha256, revision: Number.isInteger(spec.revision) && spec.revision > 0 ? spec.revision : null, content: spec.content });
        });
      }
    }
    if (given.impact !== undefined && given.impact !== null) {
      if (!record(given.impact) || !Array.isArray(given.impact.entries)) warnings.push(`${shownFile}: impact needs an entries list; it is left out.`);
      else {
        const entries = given.impact.entries.filter((item, index) => {
          const ok = record(item) && nonempty(item.entry) && ['changes', 'may_affect'].includes(item.effect) && nonempty(item.evidence);
          if (!ok) warnings.push(`${shownFile}: impact.entries[${index}] needs entry, effect (changes or may_affect) and evidence; it is left out.`);
          return ok;
        }).map((item) => ({
          ...(nonempty(item.flow) ? { flow: item.flow.trim() } : {}), entry: item.entry.trim(), effect: item.effect, evidence: item.evidence.trim(),
          ...(nonempty(item.note) ? { note: item.note.trim() } : {}),
        }));
        impact = { path: nonempty(given.impact.path) ? given.impact.path.trim() : shownFile, ...(SHA256.test(given.impact.sha256 ?? '') ? { sha256: given.impact.sha256 } : {}), entries };
      }
    }
    if (given.context !== undefined) warnings.push(`${shownFile} carries a context; the import records the one Genesis EDD reads from the project instead.`);
    // Open questions, in the forms a spec file takes them.
    const ids = new Set(requirements.map((requirement) => requirement.id));
    const held = new Map();
    if (given.open_questions !== undefined && !problems.length) {
      if (!Array.isArray(given.open_questions)) fail('import_invalid', `${shownFile}: open_questions must be a list.`);
      else {
        given.open_questions.forEach((item, index) => {
          const question = questionOf(item);
          if (!question) { fail('import_invalid', `${shownFile}: open_questions[${index}] must be a nonempty string, or an object with a question and the requirements it holds back.`); return; }
          const unknown = question.requirements.filter((id) => !ids.has(id));
          if (unknown.length) fail('import_invalid', `${shownFile}: an open question names requirements the import does not have: ${unknown.join(', ')}.`);
          const named = [...new Set([...question.requirements.filter((id) => ids.has(id)), ...mentioned(question.question, ids)])];
          if (!named.length) ask('business_question', `${shownFile}: ${question.question}`, { question: question.question });
          for (const id of named) held.set(id, [...(held.get(id) ?? []), question.question]);
        });
      }
    }
    for (const requirement of requirements) {
      if (requirement.state !== 'proposed' && !held.has(requirement.id)) continue;
      excluded.push({
        requirement: requirement.id, name: requirement.name, path: requirement.path, state: requirement.state,
        reason: requirement.state === 'proposed' ? 'proposed' : 'open_question', ...(held.has(requirement.id) ? { questions: held.get(requirement.id) } : {}),
      });
    }
    if (requirements.length && excluded.length === requirements.length) {
      ask('requirements_all_excluded', `Every requirement of ${shownFile} is proposed or held back by an open question, so the import would hold none.`, { requirement_ids: excluded.map((entry) => entry.requirement) });
    }
  }
  // The context: genesis.json of the change when there is one, its Map
  // checked and worked out again; otherwise the project as it is now.
  let context = null;
  const contextFile = path.join(directory, 'genesis.json');
  if (existsSync(contextFile)) {
    try { context = readJSON(contextFile); } catch (cause) { fail('context_unavailable', `${folder}genesis.json cannot be read: ${cause.message}`, { path: `${folder}genesis.json` }); }
    if (context !== null && !record(context)) { fail('context_invalid', `${folder}genesis.json must be an object.`, { path: `${folder}genesis.json` }); context = null; }
    if (record(context) && context.map?.status === 'available') {
      const checked = checkedMap(repo, name, directory, context);
      for (const entry of checked.problems) fail(entry.code, entry.message, omit(entry, ['code', 'message']));
      warnings.push(...checked.warnings);
      context = { ...context, map: checked.map };
    }
  } else context = captureContext(repo, project.mode);
  if (gaps.length) {
    throw refuse(`${shownFile} cannot be imported: ${gaps.map((gap) => gap.message).join(' ')}`, gaps, 'SPEC_IMPORT_BLOCKED');
  }
  const held = new Set(excluded.map((entry) => entry.requirement));
  const payload = {
    format: 'genesis.spec-handoff', version: 2, change: name, context, specs,
    requirements: requirements.filter((requirement) => !held.has(requirement.id)), impact,
    ...(excluded.length ? { excluded } : {}), source: 'import', imported,
  };
  const { id, directory: handoffs, file, handoff } = addressed(repo, name, payload);
  const status = handoffStatus({ file, handoff });
  if (status === 'invalid') {
    const where = posix(path.relative(repo, file));
    const message = `${where} exists with other content than the export it is named for (${short(id)}). A handoff is never rewritten.`;
    throw refuse(message, [gapOf('handoff_invalid', 'technical', 'agent', message, { path: where, digest: id })], 'HANDOFF_INVALID');
  }
  if (status === 'missing') {
    mkdirSync(handoffs, { recursive: true });
    writeJSON(file, handoff);
  }
  const previous = current.id;
  if (current.entry?.id !== id) appendExport(repo, name, { id, source: 'import', previous: previous ?? null, imported });
  const ends = loopEndedBy(repo, name, id, previous, options.loopPhase);
  return exportResult({ name, id, file, handoff, source: 'import', unchanged: false, previous, warnings: [...current.warnings, ...warnings], ends });
}

// spec remap: another Map for a change that was never exported. The copy in
// the change folder and the Map record in genesis.json are replaced, with
// freshness and the other fields worked out from the new Map. Once any export
// or import exists, the Map is part of it and stays.
export function remapSpec(repo, name, options = {}) {
  const directory = changeDirectory(repo, name);
  requireProject(repo);
  const folder = `openspec/changes/${name}/`;
  if (!nonempty(options.map)) throw new Error('--map names the business-map.json to record.');
  const contextFile = path.join(directory, 'genesis.json');
  let context;
  try { context = readJSON(contextFile); } catch (cause) {
    const message = `${folder}genesis.json cannot be read (${cause.message}), so there is no Map record to replace.`;
    throw refuse(message, [gapOf('context_unavailable', 'artifact', 'agent', message, { path: `${folder}genesis.json` })], 'SPEC_REMAP_BLOCKED');
  }
  if (!record(context)) {
    const message = `${folder}genesis.json must be an object.`;
    throw refuse(message, [gapOf('context_invalid', 'technical', 'agent', message, { path: `${folder}genesis.json` })], 'SPEC_REMAP_BLOCKED');
  }
  let handoffs = [];
  try { handoffs = readdirSync(localPath(repo, `${folder}handoffs`)).filter((file) => /^[0-9a-f]{64}\.json$/.test(file)); } catch { /* none */ }
  const logged = readExportLog(repo, name).entries;
  if (handoffs.length || logged.length) {
    const latest = logged.at(-1)?.id ?? `sha256:${handoffs.sort().at(-1)?.slice(0, 64)}`;
    const message = `${name} was exported (${handoffs.length || logged.length} export${(handoffs.length || logged.length) === 1 ? '' : 's'}, the latest ${short(latest)}), and an export holds the Map it was written against, so the Map stays. Another Map belongs to another change.`;
    throw refuse(message, [gapOf('spec_exported', 'artifact', 'agent', message, { path: `${folder}handoffs/`, digest: latest })], 'SPEC_REMAP_BLOCKED');
  }
  const map = readMap(repo, options.map, name);
  // The copy first: genesis.json points at it.
  writeFileSync(localPath(repo, mapCopy(name)), map.bytes);
  const previous = context.map ?? null;
  writeFileSync(contextFile, `${JSON.stringify({ ...context, map: map.record }, null, 2)}\n`);
  return { change: name, map: map.record, previous, warnings: map.warnings };
}
