import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, initProject, projectRoot, readJSON } from '../src/project.js';
import { exportSpec, newSpec, specInstructions, specStatus, validateSpec } from '../src/spec.js';
import { checkWorkflow } from '../src/workflow.js';

const fixture = readFileSync(path.join(ROOT, 'examples/report-notifications/spec.md'), 'utf8');
function project(t, mode = 'new', agent = 'none') {
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  initProject(repo, mode, agent);
  return repo;
}
function writeSpec(repo, content = fixture, change = 'report-notifications', capability = 'notifications') {
  const file = path.join(repo, 'openspec/changes', change, 'specs', capability, 'spec.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
function authored(t, content = fixture) {
  const repo = project(t);
  newSpec(repo, 'report-notifications');
  const file = writeSpec(repo, content);
  return { repo, file };
}

test('empty project works without Git, a Map or an invented baseline', (t) => {
  const repo = project(t);
  const created = newSpec(repo, 'report-notifications');
  assert.equal(created.context.code.base_commit, null);
  assert.equal(created.context.code.working_tree_dirty, null);
  assert.equal(created.context.map.status, 'not_applicable');
  assert.deepEqual(created.context.baseline, { status: 'not_run', availability: 'no_implementation' });
  assert.equal(created.instructions.artifactId, 'specs');
  assert.deepEqual(created.instructions.dependencies, []);
  writeSpec(repo);
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.ready_for_eval_design, true);
  const handoff = exportSpec(repo, 'report-notifications');
  assert.equal(readJSON(handoff.file).specs[0].content, fixture);
  assert.equal(exportSpec(repo, 'report-notifications').id, handoff.id);
});

test('exports freeze expectations and revisions have distinct identities', (t) => {
  const { repo, file } = authored(t);
  const first = exportSpec(repo, 'report-notifications');
  const original = readFileSync(first.file, 'utf8');
  writeFileSync(file, fixture.replace('revision: 1', 'revision: 2').replace('数量为零', '数量必须为零'));
  const second = exportSpec(repo, 'report-notifications');
  assert.notEqual(first.id, second.id);
  assert.equal(readFileSync(first.file, 'utf8'), original);
  writeFileSync(second.file, '{}');
  assert.throws(() => exportSpec(repo, 'report-notifications'), /modified/);
});

test('valid proposed requirements are drafts and cannot be exported', (t) => {
  const { repo } = authored(t, fixture.replace('state: explicit', 'state: proposed'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.ready_for_eval_design, false);
  assert.throws(() => exportSpec(repo, 'report-notifications'), /not an accepted requirement/);
});

test('open business questions prevent handoff even if OpenSpec artifacts are complete', (t) => {
  const { repo } = authored(t, fixture.replace('open_questions: []', 'open_questions: ["Does a successful retry count as success?"]'));
  assert.equal(specStatus(repo, 'report-notifications').openspec.isComplete, true);
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, false);
  assert.throws(() => exportSpec(repo, 'report-notifications'), /successful retry/);
});

test('agent assumptions cannot be relabeled as explicit user requirements', (t) => {
  const { repo } = authored(t, fixture.replace('kind: user', 'kind: agent'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /agent suggestion/);
});

test('confirmed interpretations need an actor and actual confirmation reference', (t) => {
  const { repo, file } = authored(t, fixture.replace('state: explicit', 'state: confirmed'));
  assert.equal(validateSpec(repo, 'report-notifications').valid, false);
  writeFileSync(file, fixture.replace('state: explicit', 'state: confirmed\n    confirmation:\n      by: Example user\n      ref: example:approval-message'));
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
});

test('missing outcomes are rejected by the real OpenSpec strict validator', (t) => {
  const { repo } = authored(t, fixture.replace('- **THEN** 本次提交发送的成功通知数量为零', '- **AND** 不发送通知'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /OpenSpec strict validation failed/);
});

test('archive warning exception never hides extra requirements in the preamble', (t) => {
  const { repo } = authored(t, fixture.replace('## Purpose', 'The system MUST additionally email every administrator.\n\n## Purpose'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, false);
  assert.equal(result.openspec_advisory_issues.length, 0);
});

test('unknown sources, orphan provenance and duplicate stable IDs are rejected', (t) => {
  const { repo, file } = authored(t, fixture.replace('source: request', 'source: unknown'));
  assert.match(validateSpec(repo, 'report-notifications').errors.join('\n'), /unknown source/);
  writeFileSync(file, fixture.replace('  REQ-submit-failure:', '  REQ-orphan:'));
  assert.match(validateSpec(repo, 'report-notifications').errors.join('\n'), /no requirement block/);
  writeFileSync(file, fixture);
  writeSpec(repo, fixture, 'report-notifications', 'other');
  assert.match(validateSpec(repo, 'report-notifications').errors.join('\n'), /Duplicate requirement ID/);
});

test('existing project records real Git base and Map identity; stale contents block export', (t) => {
  const repo = project(t, 'existing');
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial base']);
  const mapFile = path.join(repo, 'map.json');
  writeFileSync(mapFile, JSON.stringify({ snapshot_id: 'sha256:example', analysis_status: 'partial' }));
  const created = newSpec(repo, 'report-notifications', { map: mapFile });
  assert.equal(created.context.code.base_commit, git(['rev-parse', 'HEAD']));
  assert.equal(created.context.map.status, 'available');
  assert.equal(created.context.map.analysis_status, 'partial');
  assert.equal(created.context.map.freshness, 'unverified');
  writeSpec(repo);
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
  writeFileSync(mapFile, JSON.stringify({ snapshot_id: 'sha256:changed', analysis_status: 'complete' }));
  assert.throws(() => exportSpec(repo, 'report-notifications'), /Referenced Map changed/);
});

test('existing projects without a Map remain usable with an explicit limitation', (t) => {
  const repo = project(t, 'existing');
  const created = newSpec(repo, 'report-notifications');
  assert.equal(created.context.map.status, 'missing');
  writeSpec(repo);
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.ready_for_eval_design, true);
  assert.match(result.warnings.join('\n'), /No Map supplied/);
  assert.equal(checkWorkflow(repo, 'spec-export', 'report-notifications').status, 'ready');
});

test('incremental requirements reuse the accepted capability and stable identity', (t) => {
  const repo = project(t, 'existing');
  const mainFile = path.join(repo, 'openspec/specs/notifications/spec.md');
  mkdirSync(path.dirname(mainFile), { recursive: true });
  const body = fixture.replace(/^---\n[\s\S]*?\n---\n/, '');
  writeFileSync(mainFile, body.replace('## ADDED Requirements', '## Requirements'));
  const original = readFileSync(mainFile, 'utf8');
  newSpec(repo, 'report-notifications');
  writeSpec(repo, fixture.replace(/## Purpose\n[\s\S]*?(?=## ADDED Requirements)/, '').replace('## ADDED Requirements', '## MODIFIED Requirements'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.ready_for_eval_design, true, JSON.stringify(result));
  exportSpec(repo, 'report-notifications');
  assert.equal(readFileSync(mainFile, 'utf8'), original);
});

test('later iterations can override onboarding mode and invalid maps leave no change', (t) => {
  const repo = project(t);
  assert.equal(newSpec(repo, 'second-feature', { mode: 'existing' }).context.project_mode, 'existing');
  const invalid = path.join(repo, 'invalid.json');
  writeFileSync(invalid, '{}');
  assert.throws(() => newSpec(repo, 'invalid-map', { map: invalid }), /business-map.json/);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/invalid-map')), false);
});

test('init is idempotent, preserves existing config and preflights conflicts', (t) => {
  const repo = project(t);
  assert.deepEqual(initProject(repo, 'new', 'none').created, []);
  const config = path.join(repo, 'openspec/config.yaml');
  const original = 'schema: spec-driven\ncontext: Existing project conventions\n';
  writeFileSync(config, original);
  initProject(repo, 'new', 'none');
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.throws(() => initProject(repo, 'existing', 'both'), /Existing file differs/);
  assert.equal(existsSync(path.join(repo, '.agents')), false);
  newSpec(repo, 'report-notifications');
  assert.equal(specInstructions(repo, 'report-notifications').schemaName, 'genesis-spec');
  writeFileSync(config, 'store: external-team\n');
  assert.throws(() => newSpec(repo, 'external-change'), /external stores/);
});

test('agent-spec installs for both agents and runs the pinned CLI', (t) => {
  const repo = project(t, 'new', 'both');
  for (const directory of ['.agents', '.claude']) {
    const scripts = path.join(repo, directory, 'skills/agent-spec/scripts');
    const result = spawnSync(process.execPath, [path.join(scripts, 'run.mjs'), '--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).openspec, '2.1.0');
    assert.match(readFileSync(path.join(scripts, '.gitignore'), 'utf8'), /runtime.json/);
    assert.equal(existsSync(path.join(repo, directory, 'skills/genesis-spec')), false);
  }
  assert.deepEqual(initProject(repo, 'new', 'both').created, []);
});

function legacyInstallation(t) {
  const repo = project(t, 'new', 'both');
  for (const directory of ['.agents', '.claude']) {
    const legacy = path.join(repo, directory, 'skills/genesis-spec');
    renameSync(path.join(repo, directory, 'skills/agent-spec'), legacy);
    const skill = path.join(legacy, 'SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8').replace('name: agent-spec', 'name: genesis-spec').replace('# Agent Spec', '# Genesis Spec'));
    const metadata = path.join(legacy, 'agents/openai.yaml');
    writeFileSync(metadata, readFileSync(metadata, 'utf8').replace('Agent Spec', 'Genesis Spec').replace('$agent-spec', '$genesis-spec'));
  }
  const schema = path.join(repo, 'openspec/schemas/genesis-spec/schema.yaml');
  writeFileSync(schema, readFileSync(schema, 'utf8').replace('Use the agent-spec skill', 'Use the genesis-spec skill'));
  return { repo, schema };
}

test('init renames the unmodified legacy skill without changing specs or handoffs', (t) => {
  const { repo } = legacyInstallation(t);
  newSpec(repo, 'report-notifications');
  const spec = writeSpec(repo);
  const handoff = exportSpec(repo, 'report-notifications');
  const frozen = readFileSync(handoff.file, 'utf8');
  const result = initProject(repo, 'new', 'both');
  assert.deepEqual(result.migrated, ['.agents/skills/genesis-spec', '.claude/skills/genesis-spec']);
  assert.deepEqual(result.updated, ['openspec/schemas/genesis-spec/schema.yaml']);
  for (const directory of ['.agents', '.claude']) {
    assert.equal(existsSync(path.join(repo, directory, 'skills/genesis-spec')), false);
    const launcher = path.join(repo, directory, 'skills/agent-spec/scripts/run.mjs');
    const run = spawnSync(process.execPath, [launcher, 'spec', 'validate', 'report-notifications', '--repo', repo], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).ready_for_eval_design, true);
  }
  assert.equal(readFileSync(spec, 'utf8'), fixture);
  assert.equal(readFileSync(handoff.file, 'utf8'), frozen);
  assert.equal(exportSpec(repo, 'report-notifications').id, handoff.id);
  const repeated = initProject(repo, 'new', 'both');
  assert.deepEqual(repeated.created, []);
  assert.deepEqual(repeated.updated, []);
  assert.deepEqual(repeated.migrated, []);
});

test('legacy migration preserves custom files and preflights all destinations', (t) => {
  for (const target of ['skill', 'extra', 'schema', 'destination']) {
    const { repo, schema } = legacyInstallation(t);
    const oldSchema = readFileSync(schema, 'utf8');
    const files = {
      skill: '.claude/skills/genesis-spec/SKILL.md',
      extra: '.claude/skills/genesis-spec/custom.md',
      schema: 'openspec/schemas/genesis-spec/schema.yaml',
      destination: '.claude/skills/agent-spec/SKILL.md',
    };
    const custom = path.join(repo, files[target]);
    mkdirSync(path.dirname(custom), { recursive: true });
    writeFileSync(custom, 'User customization\n');
    assert.throws(() => initProject(repo, 'new', 'both'), /differs; left unchanged/);
    assert.equal(readFileSync(custom, 'utf8'), 'User customization\n');
    assert.equal(existsSync(path.join(repo, '.agents/skills/agent-spec')), false);
    assert.equal(existsSync(path.join(repo, '.agents/skills/genesis-spec/SKILL.md')), true);
    assert.equal(existsSync(path.join(repo, '.claude/skills/genesis-spec/SKILL.md')), true);
    if (target !== 'schema') assert.equal(readFileSync(schema, 'utf8'), oldSchema);
  }
});

test('bad names and symlink destinations cannot escape the selected project', (t) => {
  const repo = project(t);
  assert.throws(() => newSpec(repo, '../escape'), /kebab-case/);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(repo, '.agents'), 'dir');
  assert.throws(() => initProject(repo, 'new', 'codex'), /symlink/);
  assert.equal(existsSync(path.join(outside, 'skills')), false);
});

test('CLI reports invalid specs and deferred commands with nonzero exit codes', (t) => {
  const repo = project(t);
  newSpec(repo, 'report-notifications');
  for (const args of [['spec', 'validate', 'report-notifications', '--repo', repo], ['write-eval']]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.doesNotThrow(() => JSON.parse(result.stdout || result.stderr));
  }
});

test('input checks route missing artifacts without creating them or requesting business decisions', (t) => {
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-inputs-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  let result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.status, 'blocked');
  assert.equal(result.gaps[0].code, 'project_missing');
  assert.equal(result.next.owner, 'agent');
  assert.equal(result.next.route, 'init');
  assert.equal(existsSync(path.join(repo, 'openspec')), false);
  initProject(repo, 'new', 'none');
  result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.gaps[0].code, 'change_missing');
  assert.equal(result.next.route, 'agent-spec');
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications')), false);
  newSpec(repo, 'report-notifications');
  result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.gaps[0].code, 'spec_missing');
  assert.equal(result.gaps[0].kind, 'artifact');
  assert.equal(result.next.owner, 'agent');
  writeSpec(repo);
  result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.gaps, []);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
});

test('business blockers identify requirements and questions; technical repair takes precedence', (t) => {
  const content = fixture.replace('state: explicit', 'state: proposed')
    .replace('open_questions: []', 'open_questions: ["Should a successful retry send a notification?"]');
  const { repo, file } = authored(t, content);
  let result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.status, 'blocked');
  assert.equal(result.next.owner, 'user');
  assert.equal(result.gaps.find((gap) => gap.code === 'requirement_proposed').requirement_id, 'REQ-submit-failure');
  assert.equal(result.gaps.find((gap) => gap.code === 'business_question').question, 'Should a successful retry send a notification?');
  writeFileSync(file, content.replace('source: request', 'source: missing'));
  result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.next.owner, 'agent');
  assert.ok(result.gaps.some((gap) => gap.kind === 'technical'));
  assert.ok(result.gaps.some((gap) => gap.kind === 'business'));
  assert.equal(readFileSync(file, 'utf8'), content.replace('source: request', 'source: missing'));
});

test('export rechecks changed inputs and reports the same classified blockers without a preflight', (t) => {
  const { repo, file } = authored(t);
  assert.equal(checkWorkflow(repo, 'spec-export', 'report-notifications').status, 'ready');
  writeFileSync(file, fixture.replace('state: explicit', 'state: proposed'));
  const gate = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => {
    assert.equal(error.code, 'SPEC_INPUT_BLOCKED');
    assert.deepEqual(error.gaps, gate.gaps);
    assert.deepEqual(error.resume.command, ['spec', 'export', 'report-notifications', '--repo', repo]);
    return true;
  });
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
});

test('write-eval input check requires the current frozen Spec and preserves older exports', (t) => {
  const { repo, file } = authored(t);
  let result = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(result.inputs_ready, false);
  assert.equal(result.next.route, 'spec-export');
  assert.equal(result.gaps[0].code, 'handoff_missing');
  assert.equal(result.resume.stage, 'write-eval');
  const first = exportSpec(repo, 'report-notifications');
  const original = readFileSync(first.file, 'utf8');
  result = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(result.inputs_ready, true);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.implemented, false);
  assert.equal(result.handoff.id, first.id);
  assert.equal(result.next.owner, 'framework');
  writeFileSync(file, fixture.replace('revision: 1', 'revision: 2').replace('数量为零', '数量必须为零'));
  result = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(result.inputs_ready, false);
  assert.equal(result.gaps[0].code, 'handoff_missing');
  assert.equal(readFileSync(first.file, 'utf8'), original);
  const second = exportSpec(repo, 'report-notifications');
  assert.equal(checkWorkflow(repo, 'write-eval', 'report-notifications').handoff.id, second.id);
});

test('tampered handoffs and manually supplied readiness flags cannot pass the gate', (t) => {
  const { repo } = authored(t);
  const handoff = exportSpec(repo, 'report-notifications');
  const tampered = { ...readJSON(handoff.file), ready_for_eval_design: true, status: 'completed', specs: [] };
  writeFileSync(handoff.file, JSON.stringify(tampered));
  for (const stage of ['spec-export', 'write-eval']) {
    const result = checkWorkflow(repo, stage, 'report-notifications');
    assert.equal(result.status, 'blocked');
    assert.equal(result.gaps[0].code, 'handoff_invalid');
    assert.equal(result.next.owner, 'agent');
  }
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => error.code === 'HANDOFF_INVALID');
  assert.deepEqual(readJSON(handoff.file), tampered);
});

test('broken context and changed Map snapshots route to technical recovery without asking business questions', (t) => {
  const repo = project(t, 'existing');
  const map = path.join(repo, 'map.json');
  writeFileSync(map, JSON.stringify({ snapshot_id: 'original', analysis_status: 'partial' }));
  newSpec(repo, 'report-notifications', { map });
  writeSpec(repo);
  writeFileSync(map, JSON.stringify({ snapshot_id: 'changed', analysis_status: 'complete' }));
  let result = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(result.gaps[0].code, 'map_changed');
  assert.equal(result.next.owner, 'agent');
  const context = path.join(repo, 'openspec/changes/report-notifications/genesis.json');
  for (const [content, code] of [['{broken', 'context_unavailable'], ['null', 'context_invalid']]) {
    writeFileSync(context, content);
    result = checkWorkflow(repo, 'spec-export', 'report-notifications');
    assert.equal(result.gaps[0].code, code);
    assert.equal(result.gaps[0].kind, 'technical');
    assert.equal(result.next.owner, 'agent');
  }
});

test('CLI recovery resumes the original stage after a business decision is supplied', (t) => {
  const { repo, file } = authored(t, fixture.replace('state: explicit', 'state: proposed'));
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), ...args], { encoding: 'utf8' });
  let response = run(['workflow', 'check', 'spec-export', 'report-notifications', '--repo', repo]);
  assert.equal(response.status, 1);
  const blocked = JSON.parse(response.stdout);
  assert.equal(blocked.next.owner, 'user');
  const confirmed = fixture.replace('state: explicit', 'state: confirmed\n    confirmation:\n      by: Example user\n      ref: example:approval-message');
  writeFileSync(file, confirmed);
  response = run(blocked.resume.command);
  assert.equal(response.status, 0, response.stderr);
  const ready = JSON.parse(response.stdout);
  assert.equal(ready.status, 'ready');
  response = run(ready.next.command);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(readJSON(JSON.parse(response.stdout).file).specs[0].content, confirmed);
  writeFileSync(file, fixture.replace('state: explicit', 'state: proposed'));
  response = run(ready.next.command);
  assert.equal(response.status, 1);
  assert.equal(JSON.parse(response.stderr).gaps[0].code, 'requirement_proposed');
});

test('unimplemented stage entries return diagnostics without claiming readiness or running a stage', (t) => {
  const { repo } = authored(t);
  for (const stage of ['write-eval', 'run-eval', 'loop-and-implement']) {
    const result = checkWorkflow(repo, stage, 'report-notifications');
    assert.equal(result.implemented, false);
    assert.ok(result.gaps.some((gap) => gap.code === 'stage_unavailable' && gap.owner === 'framework'));
    if (stage !== 'write-eval') assert.equal(result.inputs_ready, null);
    const response = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), stage, 'report-notifications', '--repo', repo], { encoding: 'utf8' });
    assert.equal(response.status, 1);
    const diagnostic = JSON.parse(response.stdout);
    assert.equal(diagnostic.implemented, false);
    assert.equal(diagnostic.inputs_ready, result.inputs_ready);
    assert.equal(diagnostic.status, result.status);
    assert.deepEqual(diagnostic.gaps, result.gaps);
    assert.deepEqual(diagnostic.resume, result.resume);
  }
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
  assert.throws(() => checkWorkflow(repo, 'unknown', 'report-notifications'), /Unknown stage/);
  assert.throws(() => checkWorkflow(repo, 'spec-export', '../escape'), /kebab-case/);
});
