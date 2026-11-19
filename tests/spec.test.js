import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, initProject, projectRoot, readJSON } from '../src/project.js';
import { exportSpec, newSpec, specInstructions, specStatus, validateSpec } from '../src/spec.js';

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

test('installed skill runs the pinned CLI and its local runtime is ignored by Git', (t) => {
  const repo = project(t, 'new', 'both');
  for (const directory of ['.agents', '.claude']) {
    const scripts = path.join(repo, directory, 'skills/genesis-spec/scripts');
    const result = spawnSync(process.execPath, [path.join(scripts, 'run.mjs'), '--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).openspec, '2.1.0');
    assert.match(readFileSync(path.join(scripts, '.gitignore'), 'utf8'), /runtime.json/);
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
