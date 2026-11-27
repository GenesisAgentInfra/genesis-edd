import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, SCHEMA, initProject, openspec, projectRoot, readJSON } from '../src/project.js';
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

const second = '  REQ-submit-success:\n    source: request\n    state: explicit';
const twoExplicit = `${fixture.replace('    state: explicit', `    state: explicit\n${second}`)}
### Requirement: REQ-submit-success 提交成功时发送成功通知

系统 MUST 在报告提交成功时发送成功通知。

#### Scenario: 提交成功

- **GIVEN** 报告内容完整
- **AND** 提交服务可用
- **WHEN** 报告提交返回成功
- **THEN** 本次提交发送的成功通知数量为一
- **AND** 不发送失败通知
`;

test('a quote cannot back more explicit requirements than it states', (t) => {
  const { repo, file } = authored(t, twoExplicit);
  const derived = validateSpec(repo, 'report-notifications');
  assert.equal(derived.valid, false);
  const gap = derived.gaps.find((item) => item.code === 'explicit_exceeds_quote');
  assert.deepEqual(gap.requirement_ids, ['REQ-submit-failure', 'REQ-submit-success']);
  assert.equal(gap.owner, 'agent');
  assert.throws(() => exportSpec(repo, 'report-notifications'), /resting on one quote/);

  // Repeating the same words under another source ID does not add a statement.
  writeFileSync(file, twoExplicit
    .replace('requirements:', '  again:\n    kind: user\n    ref: "example:report-notifications/request"\n    quote: "报告提交失败时，不要发送成功通知。"\nrequirements:')
    .replace(second, second.replace('source: request', 'source: again')));
  assert.equal(validateSpec(repo, 'report-notifications').valid, false);

  // A derived rule is a valid draft once it is labelled as a proposal.
  writeFileSync(file, twoExplicit.replace(second, second.replace('explicit', 'proposed')));
  const draft = validateSpec(repo, 'report-notifications');
  assert.equal(draft.valid, true, JSON.stringify(draft.errors));
  assert.equal(draft.ready_for_eval_design, false);

  // Two requirements are explicit when the quoted words state both.
  writeFileSync(file, twoExplicit.replace('不要发送成功通知。"', '不要发送成功通知。提交成功时发送成功通知。"'));
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
});

test('export lists each requirement beside the words and outcomes it rests on', (t) => {
  const { repo } = authored(t, twoExplicit.replace('不要发送成功通知。"', '不要发送成功通知。提交成功时发送成功通知。"')
    .replace(second, `${second.replace('explicit', 'confirmed')}\n    confirmation:\n      by: Example user\n      ref: example:approval-message`));
  const quote = '报告提交失败时，不要发送成功通知。提交成功时发送成功通知。';
  assert.deepEqual(exportSpec(repo, 'report-notifications').review, [
    {
      requirement: 'REQ-submit-failure', name: '提交失败时不发送成功通知', path: 'specs/notifications/spec.md', state: 'explicit',
      basis: { source: 'request', kind: 'user', quote },
      statement: '系统 MUST 在报告提交失败时不发送成功通知。', outcomes: ['本次提交发送的成功通知数量为零'],
    },
    {
      requirement: 'REQ-submit-success', name: '提交成功时发送成功通知', path: 'specs/notifications/spec.md', state: 'confirmed',
      basis: { source: 'request', kind: 'user', quote },
      confirmation: { by: 'Example user', ref: 'example:approval-message' },
      statement: '系统 MUST 在报告提交成功时发送成功通知。', outcomes: ['本次提交发送的成功通知数量为一', '不发送失败通知'],
    },
  ]);
});

test('handoffs carry structured requirements so later stages need not parse Markdown', (t) => {
  const { repo } = authored(t, twoExplicit.replace('不要发送成功通知。"', '不要发送成功通知。提交成功时发送成功通知。"'));
  assert.doesNotMatch(validateSpec(repo, 'report-notifications').warnings.join('\n'), /impact/);
  const handoff = readJSON(exportSpec(repo, 'report-notifications').file);
  assert.equal(handoff.format, 'genesis.spec-handoff');
  assert.equal(handoff.version, 2);
  assert.equal(handoff.impact, null);
  assert.deepEqual(handoff.requirements.map((item) => [item.id, item.state, item.basis.kind]), [
    ['REQ-submit-failure', 'explicit', 'user'], ['REQ-submit-success', 'explicit', 'user'],
  ]);
  const success = handoff.requirements[1];
  assert.equal(success.basis.ref, 'example:report-notifications/request');
  assert.equal(success.statement, '系统 MUST 在报告提交成功时发送成功通知。');
  assert.deepEqual(success.scenarios, [{
    name: '提交成功', given: ['报告内容完整', '提交服务可用'], when: ['报告提交返回成功'],
    then: ['本次提交发送的成功通知数量为一', '不发送失败通知'],
  }]);
});

test('impact records touched flows and evidence, checked against the Map and the project', (t) => {
  const repo = project(t, 'existing');
  mkdirSync(path.join(repo, 'app'));
  writeFileSync(path.join(repo, 'app/notify.py'), 'def notify():\n    return True\n');
  const mapFile = path.join(repo, 'map.json');
  writeFileSync(mapFile, JSON.stringify({
    snapshot_id: 'sha256:example', analysis_status: 'partial', flows: [{ flow_id: 'flow_submit', name: 'Submit a report' }],
  }));
  newSpec(repo, 'report-notifications', { map: mapFile });
  writeSpec(repo);
  const unrecorded = validateSpec(repo, 'report-notifications');
  assert.equal(unrecorded.ready_for_eval_design, true);
  assert.match(unrecorded.warnings.join('\n'), /No impact\.md/);

  const impactFile = path.join(repo, 'openspec/changes/report-notifications/impact.md');
  const impact = (entries) => writeFileSync(impactFile, `---\ngenesis_impact: 1\nentries:\n${entries}\n---\n\nNotes for the reader.\n`);
  impact('  - flow: flow_submit\n    entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:2\n    note: Stop the success notification on failure\n'
    + '  - entry: notify()\n    effect: may_affect\n    evidence: app/notify.py');
  const exported = exportSpec(repo, 'report-notifications');
  assert.deepEqual(exported.impact, [
    { flow: 'flow_submit', flow_name: 'Submit a report', entry: 'POST /reports', effect: 'changes', evidence: 'app/notify.py:2', note: 'Stop the success notification on failure' },
    { entry: 'notify()', effect: 'may_affect', evidence: 'app/notify.py' },
  ]);
  assert.deepEqual(readJSON(exported.file).impact.entries, exported.impact);

  for (const [entries, pattern] of [
    ['  - flow: flow_unknown\n    entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:1', /not in the recorded Map/],
    ['  - entry: POST /reports\n    effect: changes\n    evidence: app/missing.py:1', /does not point to a file/],
    ['  - entry: POST /reports\n    effect: changes\n    evidence: ../outside.py', /does not point to a file/],
    ['  - entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:99', /line is outside the file/],
    ['  - entry: POST /reports\n    effect: rewrites\n    evidence: app/notify.py', /needs entry, effect/],
  ]) {
    impact(entries);
    const result = validateSpec(repo, 'report-notifications');
    assert.equal(result.valid, false, entries);
    assert.match(result.errors.join('\n'), pattern);
    assert.equal(result.gaps.find((gap) => gap.code === 'impact_invalid').owner, 'agent');
  }
  writeFileSync(impactFile, 'No frontmatter here.\n');
  assert.match(validateSpec(repo, 'report-notifications').errors.join('\n'), /genesis_impact: 1/);
});

test('code that moves impact evidence after export keeps that export usable, not a new one', (t) => {
  const repo = project(t, 'existing');
  mkdirSync(path.join(repo, 'app'));
  const source = path.join(repo, 'app/notify.py');
  writeFileSync(source, 'def notify():\n    return True\n');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  const impactFile = path.join(repo, 'openspec/changes/report-notifications/impact.md');
  const impact = '---\ngenesis_impact: 1\nentries:\n  - entry: notify()\n    effect: changes\n    evidence: app/notify.py:2\n---\n';
  writeFileSync(impactFile, impact);
  const exported = exportSpec(repo, 'report-notifications');

  for (const move of [() => writeFileSync(source, 'pass'), () => rmSync(source)]) {
    move();
    const strict = validateSpec(repo, 'report-notifications');
    assert.equal(strict.valid, false);
    assert.equal(strict.gaps.find((gap) => gap.code === 'impact_invalid').working_tree, true);
    const check = checkWorkflow(repo, 'write-eval', 'report-notifications');
    assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
    assert.equal(check.handoff.id, exported.id);
    assert.match(check.warnings.join('\n'), /moved since the Spec was exported/);
    assert.equal(exportSpec(repo, 'report-notifications').id, exported.id);
  }

  // A changed impact.md is a new export, and a new export needs current evidence.
  writeFileSync(impactFile, impact.replace('effect: changes', 'effect: may_affect'));
  const check = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(check.status, 'blocked');
  assert.ok(check.gaps.some((gap) => gap.code === 'impact_invalid'));
  assert.throws(() => exportSpec(repo, 'report-notifications'), /does not point to a file/);

  // Any other problem keeps the export blocked even when evidence also moved.
  writeFileSync(impactFile, impact);
  writeSpec(repo, fixture.replace('source: request', 'source: unknown'));
  assert.equal(checkWorkflow(repo, 'write-eval', 'report-notifications').status, 'blocked');
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
  writeFileSync(mapFile, JSON.stringify({ snapshot_id: 'sha256:example', analysis_status: 'partial', mode: 'map' }));
  const created = newSpec(repo, 'report-notifications', { map: mapFile });
  // Partial, but no step is named from code. Without a source, only its
  // freshness is left unchecked.
  assert.equal(created.warnings.length, 1);
  assert.match(created.warnings[0], /^Whether this Map still matches the code was not checked: it does not record the code it was read from/);
  assert.equal(created.context.code.base_commit, git(['rev-parse', 'HEAD']));
  assert.equal(created.context.map.status, 'available');
  assert.equal(created.context.map.analysis_status, 'partial');
  assert.equal(created.context.map.mode, 'map');
  assert.equal(created.context.map.freshness, 'unverified');
  // The Map is copied into the change folder and recorded there.
  const copy = path.join(repo, 'openspec/changes/report-notifications/business-map.json');
  assert.equal(created.context.map.path, 'openspec/changes/report-notifications/business-map.json');
  assert.deepEqual(readFileSync(copy), readFileSync(mapFile));
  writeSpec(repo);
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
  // The original no longer matters; the copy does.
  writeFileSync(mapFile, JSON.stringify({ snapshot_id: 'sha256:changed', analysis_status: 'complete' }));
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
  writeFileSync(copy, JSON.stringify({ snapshot_id: 'sha256:changed', analysis_status: 'complete' }));
  assert.throws(() => exportSpec(repo, 'report-notifications'), /Referenced Map changed/);
});

test('files Genesis writes do not make the application working tree dirty', (t) => {
  const repo = project(t, 'existing', 'both');
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-b', 'main']);
  writeFileSync(path.join(repo, 'app.py'), 'answer = 1\n');
  git(['add', 'app.py']);
  git(['commit', '-m', 'Add application code']);
  mkdirSync(path.join(repo, '.genesis/out/latest'), { recursive: true });
  writeFileSync(path.join(repo, '.genesis/out/latest/business-map.json'), '{}');
  // openspec/, .genesis/ and both installed skills are untracked here.
  assert.equal(newSpec(repo, 'first').context.code.working_tree_dirty, false);
  writeFileSync(path.join(repo, 'app.py'), 'answer = 2\n');
  assert.equal(newSpec(repo, 'second').context.code.working_tree_dirty, true);
  git(['checkout', '--', 'app.py']);
  writeFileSync(path.join(repo, 'notes.txt'), 'untracked application file\n');
  assert.equal(newSpec(repo, 'third').context.code.working_tree_dirty, true);
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

test('without a recorded Map, impact.md flow IDs are left unchecked and validation says so', (t) => {
  const repo = project(t, 'existing');
  mkdirSync(path.join(repo, 'app'));
  writeFileSync(path.join(repo, 'app/notify.py'), 'def notify():\n    return True\n');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  const impactFile = path.join(repo, 'openspec/changes/report-notifications/impact.md');
  writeFileSync(impactFile, '---\ngenesis_impact: 1\nentries:\n  - flow: flow_doesnotexist\n    entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:2\n---\n');
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.ready_for_eval_design, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.includes('impact.md names flow IDs (flow_doesnotexist), but no Map is recorded, so they could not be checked. A flow ID comes from the recorded Map; without one, leave `flow` out.'), JSON.stringify(result.warnings));
  writeFileSync(impactFile, '---\ngenesis_impact: 1\nentries:\n  - entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:2\n---\n');
  assert.doesNotMatch(validateSpec(repo, 'report-notifications').warnings.join('\n'), /flow IDs/);
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

test('init keeps a .gitignore of the user\'s own in a skill folder and names skill folders an earlier install committed', (t) => {
  const repo = project(t, 'new', 'none');
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['init', '-b', 'main']);
  const own = path.join(repo, '.claude/skills/run-eval/.gitignore');
  mkdirSync(path.dirname(own), { recursive: true });
  writeFileSync(own, 'local-notes.md\n');
  const first = initProject(repo, 'new', 'claude');
  assert.equal(readFileSync(own, 'utf8'), 'local-notes.md\n');
  assert.ok(!first.created.includes('.claude/skills/run-eval/.gitignore'));
  assert.ok(first.created.includes('.claude/skills/write-eval/.gitignore'));
  assert.deepEqual(first.warnings, []);

  // An earlier install whose folders were committed stays tracked: init says so.
  git(['add', '-f', '.claude/skills/agent-spec', '.claude/skills/write-eval']);
  git(['commit', '-q', '-m', 'Commit installed skills']);
  const again = initProject(repo, 'new', 'claude');
  assert.equal(again.warnings.length, 1);
  assert.match(again.warnings[0], /git rm -r --cached \.claude\/skills\/agent-spec \.claude\/skills\/write-eval`/);
  assert.doesNotMatch(again.warnings[0], /run-eval|loop-and-implement/);
});

test('the Map of a Genesis change review is refused: it covers only the flows that change touched', (t) => {
  const repo = project(t, 'existing');
  const review = path.join(repo, '.genesis/out/latest');
  mkdirSync(review, { recursive: true });
  writeFileSync(path.join(review, 'business-map.json'), JSON.stringify({ snapshot_id: 'sha256:review', analysis_status: 'complete' }));
  writeFileSync(path.join(review, 'change-report.json'), '{}');
  assert.throws(() => newSpec(repo, 'after-review', { map: path.join(review, 'business-map.json') }), /change review/);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/after-review')), false);
  rmSync(path.join(review, 'change-report.json'));
  const created = newSpec(repo, 'after-map', { map: path.join(review, 'business-map.json') });
  assert.equal(created.context.map.status, 'available');
  assert.equal(created.context.map.path, 'openspec/changes/after-map/business-map.json');
  assert.ok(existsSync(path.join(repo, 'openspec/changes/after-map/business-map.json')));
});

test('the Map is copied byte for byte, from anywhere, and a partial Map with code-named steps is flagged', (t) => {
  const repo = project(t, 'existing');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-map-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  // Non-ASCII text, Windows line ends and no final newline survive as they are.
  const bytes = Buffer.from('{"snapshot_id":"sha256:outside","analysis_status":"complete","mode":"map",\r\n"flows":[{"flow_id":"flow_refund","name":"退款审核","steps":[{"support":"agent_synthesis"}]}]}', 'utf8');
  const complete = path.join(outside, 'business-map.json');
  writeFileSync(complete, bytes);
  const created = newSpec(repo, 'from-outside', { map: complete });
  assert.equal(created.context.map.path, 'openspec/changes/from-outside/business-map.json');
  assert.deepEqual(readFileSync(path.join(repo, created.context.map.path)), bytes);
  assert.equal(created.context.map.sha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  const named = (result) => result.warnings.filter((warning) => /named from the source code/.test(warning));
  assert.deepEqual(named(created), []);

  const partial = path.join(outside, 'partial.json');
  writeFileSync(partial, JSON.stringify({ snapshot_id: 'sha256:partial', analysis_status: 'partial', flows: [
    { flow_id: 'flow_a', name: 'Described', steps: [{ support: 'agent_synthesis' }] },
    { flow_id: 'flow_b', name: 'POST /refunds · refund', steps: [{ support: 'static_fact', name: 'if amount > 100:' }, { support: 'static_fact', name: 'return deny()' }] },
  ] }));
  const flagged = newSpec(repo, 'from-partial', { map: partial });
  assert.equal(named(flagged).length, 1);
  assert.match(named(flagged)[0], /^2 of the 3 steps in this Map belong to flows Genesis has not described yet and are named from the source code/);
  assert.match(named(flagged)[0], /openspec\/changes\/from-partial\/business-map\.json is committed with the Spec/);
  // Nothing is copied where there is no Map.
  newSpec(repo, 'no-map');
  assert.equal(existsSync(path.join(repo, 'openspec/changes/no-map/business-map.json')), false);
});

test('a Map whose mode is change is refused, and one without a mode is used as unknown, never as map', (t) => {
  const repo = project(t, 'existing');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-map-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(outside, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const base = { snapshot_id: 'sha256:modes', analysis_status: 'complete' };
  assert.throws(() => newSpec(repo, 'from-review', { map: write('review.json', { ...base, mode: 'change' }) }),
    /comes from a Genesis change review \(its mode is change\) and covers only what that review analyzed/);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/from-review')), false);
  assert.throws(() => newSpec(repo, 'odd-mode', { map: write('odd.json', { ...base, mode: 'diff' }) }), /mode Genesis EDD does not know: "diff"/);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/odd-mode')), false);

  const full = newSpec(repo, 'from-map', { map: write('map.json', { ...base, mode: 'map' }) });
  assert.equal(full.context.map.mode, 'map');
  assert.doesNotMatch(full.warnings.join('\n'), /does not say whether/);
  // A Map from Genesis before mode existed may be either kind.
  for (const [change, value] of [['from-older', base], ['null-mode', { ...base, mode: null }]]) {
    const older = newSpec(repo, change, { map: write(`${change}.json`, value) });
    assert.equal(older.context.map.mode, 'unknown');
    assert.match(older.warnings.join('\n'), /does not say whether it maps the whole project or a change review: Genesis before 9c0c914 wrote no mode\. Nothing beside it marks a review, so it is used and recorded with mode unknown\./);
  }
  // change-report.json beside a Map still marks a review, whatever its mode says.
  const latest = write('latest/business-map.json', { ...base, mode: 'map' });
  writeFileSync(path.join(path.dirname(latest), 'change-report.json'), '{}');
  assert.throws(() => newSpec(repo, 'beside-report', { map: latest }), /change-report\.json is beside it/);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/beside-report')), false);
});

// A Git project with the given application files committed.
function committedProject(t, files) {
  const repo = project(t, 'existing');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFiles(repo, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'Add application code');
  return { repo, git };
}
function writeFiles(repo, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  }
}
const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
// The `source` Genesis records for a clean read of these files at revision.
const sourceOf = (revision, files, extra = {}) => ({ revision, worktree_dirty: false, integrity_status: 'complete',
  files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, sha256(content)])), ...extra });
// A full Map with that source, written outside the project.
function sourcedMap(t, source) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-map-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'business-map.json');
  writeFileSync(file, JSON.stringify({ snapshot_id: 'sha256:sourced', analysis_status: 'complete', mode: 'map', ...(source === undefined ? {} : { source }) }));
  return file;
}
const FRESHNESS = /still matches the code|no longer matches the code/;
const APP = {
  'app/submit.py': 'def submit(report):\n    return notify(report)\n',
  'app/notify.py': 'def notify(report):\n    return "sent"\n',
  'docs/报告 notes.md': '# 报告\n',
};

test('a clean, complete Map is verified while every file it read is unchanged at the commit, as Git stores it', (t) => {
  const { repo, git } = committedProject(t, APP);
  const source = sourceOf(git('rev-parse', 'HEAD'), APP);
  const created = newSpec(repo, 'fresh', { map: sourcedMap(t, source) });
  assert.equal(created.context.map.freshness, 'verified');
  assert.doesNotMatch(created.warnings.join('\n'), FRESHNESS);
  assert.doesNotMatch(created.warnings.join('\n'), /uncommitted edits/);

  // A later commit that leaves those files alone, and a checkout that converts
  // their line ends: the commit still stores the bytes Genesis hashed.
  writeFileSync(path.join(repo, '.gitattributes'), '*.py text eol=crlf\n');
  writeFiles(repo, { 'app/extra.py': 'added = True\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'Add a file the Map does not list');
  rmSync(path.join(repo, 'app/submit.py'));
  git('checkout', '--', 'app/submit.py');
  assert.match(readFileSync(path.join(repo, 'app/submit.py'), 'utf8'), /\r\n/);
  assert.equal(newSpec(repo, 'converted', { map: sourcedMap(t, source) }).context.map.freshness, 'verified');
  // The commit is compared, not the working tree, which genesis.json records apart.
  writeFileSync(path.join(repo, 'app/notify.py'), 'def notify(report):\n    return "queued"\n');
  const edited = newSpec(repo, 'edited', { map: sourcedMap(t, source) });
  assert.equal(edited.context.map.freshness, 'verified');
  assert.equal(edited.context.code.working_tree_dirty, true);
  // Those edits are named, since impact.md evidence is read from them.
  const head = git('rev-parse', 'HEAD').slice(0, 7);
  assert.deepEqual(edited.warnings.filter((warning) => /uncommitted edits/.test(warning)), [
    `1 of the files this Map was read from has uncommitted edits (app/notify.py). Its freshness compares commit ${head}, not those edits, while impact.md evidence is read from the working tree. If the edits are not part of this request, the Map and that evidence may describe different code: tell the user.`,
  ]);
  // Edits to files the Map did not read are not named.
  git('checkout', '--', 'app/notify.py');
  writeFiles(repo, { 'app/extra.py': 'added = False\n', 'app/new.py': 'new = True\n' });
  assert.doesNotMatch(newSpec(repo, 'elsewhere', { map: sourcedMap(t, source) }).warnings.join('\n'), /uncommitted edits/);
});

test('a Map is stale once a file it read changed or is gone; a dirty or partial one is only unverified', (t) => {
  const { repo, git } = committedProject(t, APP);
  const source = sourceOf(git('rev-parse', 'HEAD'), APP);
  writeFiles(repo, { 'app/notify.py': 'def notify(report):\n    return "queued"\n' });
  git('rm', '-q', 'docs/报告 notes.md');
  git('add', '-A');
  git('commit', '-q', '-m', 'Queue notices and drop the notes');
  const head = git('rev-parse', 'HEAD');

  const stale = newSpec(repo, 'stale', { map: sourcedMap(t, source) });
  assert.equal(stale.context.map.freshness, 'stale');
  assert.match(stale.warnings.join('\n'), new RegExp(`This Map no longer matches the code of commit ${head.slice(0, 7)}: 2 of the 3 files it was read from changed or are gone since Genesis read them \\(app/notify\\.py, docs/报告 notes\\.md\\)\\. .*map the project again with \`/genesis map\`, remove the change folder \`spec new\` just created`));
  // Files left out do not hide a file that changed.
  assert.equal(newSpec(repo, 'stale-partial', { map: sourcedMap(t, { ...source, integrity_status: 'partial' }) }).context.map.freshness, 'stale');
  // Read with uncommitted changes, a digest may be of code no commit holds.
  const dirty = newSpec(repo, 'dirty', { map: sourcedMap(t, { ...source, worktree_dirty: true }) });
  assert.equal(dirty.context.map.freshness, 'unverified');
  assert.match(dirty.warnings.join('\n'), /not checked: Genesis read the code with uncommitted changes/);
  // Every file read is unchanged, but some were left out.
  const partial = newSpec(repo, 'partial', { map: sourcedMap(t, sourceOf(source.revision, { 'app/submit.py': APP['app/submit.py'] }, { integrity_status: 'partial' })) });
  assert.equal(partial.context.map.freshness, 'unverified');
  assert.match(partial.warnings.join('\n'), new RegExp(`its integrity_status is partial\\)\\. The one file it read is unchanged at ${head.slice(0, 7)}\\.`));
});

test('freshness is unverified without a source, with one Genesis would not write, or without a commit', (t) => {
  const { repo, git } = committedProject(t, APP);
  const source = sourceOf(git('rev-parse', 'HEAD'), APP);
  const none = newSpec(repo, 'no-source', { map: sourcedMap(t, undefined) });
  assert.equal(none.context.map.freshness, 'unverified');
  assert.match(none.warnings.join('\n'), /it does not record the code it was read from, which Genesis before 9c0c914 did not do/);
  for (const [change, broken] of [
    ['short-revision', { ...source, revision: source.revision.slice(0, 7) }],
    ['bad-digest', { ...source, files: { 'app/submit.py': 'md5:abc' } }],
    ['outside-path', { ...source, files: { '../secret.py': sha256('x') } }],
    ['no-files', { ...source, files: {} }],
    ['no-flag', { ...source, worktree_dirty: 'no' }],
  ]) {
    const result = newSpec(repo, change, { map: sourcedMap(t, broken) });
    assert.equal(result.context.map.freshness, 'unverified', change);
    assert.match(result.warnings.join('\n'), /its source is not in the form Genesis writes/, change);
  }
  const uncommitted = project(t, 'existing');
  const result = newSpec(uncommitted, 'no-commit', { map: sourcedMap(t, source) });
  assert.equal(result.context.map.freshness, 'unverified');
  assert.match(result.warnings.join('\n'), /the project has no commit to compare it with/);
});

test('freshness reads every listed file as stored, binary content and more than one batch of Git output included', (t) => {
  const files = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`src/m${index}.py`, `value = ${index}\n`]));
  files['assets/logo.bin'] = Buffer.from([0, 10, 255, 10, 0, 13, 10]);
  const { repo, git } = committedProject(t, files);
  const source = sourceOf(git('rev-parse', 'HEAD'), files);
  assert.equal(newSpec(repo, 'many', { map: sourcedMap(t, source) }).context.map.freshness, 'verified');
  writeFiles(repo, { 'src/m650.py': 'value = -1\n' });
  git('commit', '-q', '-am', 'Change one file in the second batch');
  const stale = newSpec(repo, 'many-stale', { map: sourcedMap(t, source) });
  assert.equal(stale.context.map.freshness, 'stale');
  assert.match(stale.warnings.join('\n'), /1 of the 701 files it was read from changed or are gone since Genesis read them \(src\/m650\.py\)/);
});

test('validate, export and workflow check repeat what genesis.json recorded about the Map', (t) => {
  const { repo, git } = committedProject(t, APP);
  const head = git('rev-parse', 'HEAD').slice(0, 7);
  const source = sourceOf(git('rev-parse', 'HEAD'), APP);
  const notes = (change) => validateSpec(repo, change).warnings.filter((warning) => /Map/.test(warning));
  newSpec(repo, 'fresh', { map: sourcedMap(t, source) });
  writeSpec(repo, fixture, 'fresh');
  const verified = [`The Map was verified against the code of base commit ${head}.`];
  assert.deepEqual(notes('fresh'), verified);
  const check = checkWorkflow(repo, 'spec-export', 'fresh');
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.deepEqual(check.warnings.filter((warning) => /Map/.test(warning)), verified);
  assert.deepEqual(exportSpec(repo, 'fresh').warnings.filter((warning) => /Map/.test(warning)), verified);
  assert.deepEqual(checkWorkflow(repo, 'write-eval', 'fresh').warnings.filter((warning) => /Map/.test(warning)), verified);

  // A stale Map stays usable, and every check says so, not only spec new.
  writeFiles(repo, { 'app/notify.py': 'def notify(report):\n    return "queued"\n' });
  git('commit', '-q', '-am', 'Queue notices');
  const later = git('rev-parse', 'HEAD').slice(0, 7);
  newSpec(repo, 'stale', { map: sourcedMap(t, source) });
  writeSpec(repo, fixture, 'stale');
  const stale = [`This Map no longer matched the code of base commit ${later} when \`spec new\` checked it (freshness stale): its flows may describe code that is not there anymore. Tell the user. To write the Spec against the code as it is, map the project again with \`/genesis map\` and create a new change with the new Map; do not edit genesis.json.`];
  assert.deepEqual(notes('stale'), stale);
  const staleCheck = checkWorkflow(repo, 'spec-export', 'stale');
  assert.equal(staleCheck.status, 'ready');
  assert.deepEqual(staleCheck.warnings.filter((warning) => /Map/.test(warning)), stale);

  // A Map without source or mode, partial, with steps named from code.
  const older = path.join(repo, 'older.json');
  writeFileSync(older, JSON.stringify({ snapshot_id: 'sha256:older', analysis_status: 'partial', flows: [
    { flow_id: 'flow_a', name: 'Described', steps: [{ support: 'agent_synthesis' }] },
    { flow_id: 'flow_b', name: 'POST /refunds', steps: [{ support: 'static_fact' }, { support: 'static_fact' }] },
  ] }));
  newSpec(repo, 'older', { map: older });
  writeSpec(repo, fixture, 'older');
  assert.deepEqual(notes('older'), [
    `Whether this Map still matched the code of base commit ${later} was not checked (freshness unverified): when \`spec new\` recorded it, the Map had no source, had been read with uncommitted changes or had left files out, or there was no commit to compare it with.`,
    'This Map does not say whether it maps the whole project or a change review (mode unknown). Make sure it is a full map: the Map of a `/genesis review` covers only what that review analyzed.',
    'This Map is partial: some flows are not described yet or leave code unaccounted for, or files were left out. Record that limit; do not call its coverage complete.',
    '2 of the 3 steps in this Map belong to flows Genesis has not described yet and are named from the source code. That code goes into Git with the Map copy: tell the user before it is committed.',
  ]);

  // A change made before spec new recorded freshness says only that.
  const contextFile = path.join(repo, 'openspec/changes/fresh/genesis.json');
  const context = readJSON(contextFile);
  delete context.map.freshness;
  delete context.map.mode;
  writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`);
  assert.deepEqual(notes('fresh'), ['Whether this Map matches the code was not checked: the change was made before `spec new` recorded freshness.']);
  assert.doesNotMatch(validateSpec(repo, 'fresh').warnings.join('\n'), /not automatically verified/);
});

test('a complete Map records its entry coverage and warns about entries outside its planned flows', (t) => {
  const repo = project(t, 'existing');
  const write = (name, coverage) => {
    const file = path.join(repo, name);
    writeFileSync(file, JSON.stringify({ snapshot_id: `sha256:${name}`, analysis_status: 'complete', mode: 'map', flows: [], ...(coverage ? { coverage } : {}) }));
    return file;
  };
  const counts = { entries_total: 4, entries_planned: 1, entries_skipped: 1, entries_unhandled: 2 };
  const created = newSpec(repo, 'some', { map: write('some.json', {
    scope: '1 planned flow covering 1 of 4 entries.', ...counts,
    skipped_entries: [{ entry_id: 'entry_a', symbol_id: 'app.jobs:run', reason: 'budget' }], tasks_total: 1, tasks_validated: 1, tasks_pending: 0,
  }) });
  assert.equal(created.context.map.analysis_status, 'complete');
  assert.deepEqual(created.context.map.coverage, counts);
  const outside = (warnings) => warnings.filter((warning) => /planned flows/.test(warning));
  assert.deepEqual(outside(created.warnings), ['This Map\'s planned flows cover 1 of the 4 entries Genesis found: 1 skipped (1 budget) and 2 not handled. Its analysis_status says whether those flows are finished, not whether the whole project is mapped. If the request touches an entry outside them, read its code, or map it with `/genesis map`.']);
  writeSpec(repo, fixture, 'some');
  assert.deepEqual(outside(validateSpec(repo, 'some').warnings), ['This Map\'s planned flows cover 1 of the 4 entries Genesis found: 1 skipped and 2 not handled. Its analysis_status says whether those flows are finished, not whether the whole project is mapped. If the request touches an entry outside them, read its code, or map it with `/genesis map`.']);
  assert.equal(readJSON(exportSpec(repo, 'some').file).context.map.coverage.entries_unhandled, 2);

  // Every entry planned: recorded, no warning. No coverage: nothing recorded.
  const all = newSpec(repo, 'all', { map: write('all.json', { entries_total: 3, entries_planned: 3, entries_skipped: 0, entries_unhandled: 0 }) });
  assert.deepEqual(all.context.map.coverage, { entries_total: 3, entries_planned: 3, entries_skipped: 0, entries_unhandled: 0 });
  assert.deepEqual(outside(all.warnings), []);
  const none = newSpec(repo, 'none', { map: write('none.json', null) });
  assert.equal('coverage' in none.context.map, false);
  assert.deepEqual(outside(none.warnings), []);
});

test('a committed Spec and its Map copy check out on another clone; Git gaps are named', (t) => {
  const repo = project(t, 'existing');
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(repo, ['init', '-q', '-b', 'main']);
  // Genesis keeps its own output out of Git.
  mkdirSync(path.join(repo, '.genesis/out/ses_1'), { recursive: true });
  writeFileSync(path.join(repo, '.genesis/.gitignore'), 'sessions/\nout/\n');
  const original = path.join(repo, '.genesis/out/ses_1/business-map.json');
  writeFileSync(original, JSON.stringify({ snapshot_id: 'sha256:one', analysis_status: 'complete', flows: [{ flow_id: 'flow_submit', name: 'Submit a report' }] }));
  newSpec(repo, 'report-notifications', { map: original });
  writeSpec(repo);
  const before = validateSpec(repo, 'report-notifications');
  assert.equal(before.ready_for_eval_design, true, JSON.stringify(before.errors));
  assert.doesNotMatch(before.warnings.join('\n'), /Git/);
  // An ignore rule that would keep the copy out is named before the first commit.
  writeFileSync(path.join(repo, '.gitignore'), 'business-map.json\n');
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /openspec\/changes\/report-notifications\/business-map\.json is ignored by Git, so other clones cannot check this Spec against its Map\. Commit it with the Spec\./);
  rmSync(path.join(repo, '.gitignore'));
  const exported = exportSpec(repo, 'report-notifications');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Spec']);
  assert.doesNotMatch(validateSpec(repo, 'report-notifications').warnings.join('\n'), /Git/);

  const clone = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-clone-')));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(os.tmpdir(), ['clone', '-q', repo, clone]);
  assert.equal(existsSync(path.join(clone, '.genesis/out')), false);
  const there = validateSpec(clone, 'report-notifications');
  assert.equal(there.ready_for_eval_design, true, JSON.stringify(there.errors));
  assert.doesNotMatch(there.warnings.join('\n'), /Git/);
  assert.equal(checkWorkflow(clone, 'write-eval', 'report-notifications').handoff.id, exported.id);
  // A missing copy is restored from Git; a link to it would dangle elsewhere.
  const cloned = path.join(clone, 'openspec/changes/report-notifications/business-map.json');
  const kept = readFileSync(cloned);
  rmSync(cloned);
  const gone = checkWorkflow(clone, 'write-eval', 'report-notifications');
  assert.equal(gone.gaps[0].code, 'map_unavailable');
  assert.equal(gone.next.owner, 'agent');
  assert.equal(gone.gaps[0].message, 'Referenced Map is unavailable: openspec/changes/report-notifications/business-map.json is missing. It is committed with the Spec, so restore it from Git. Do not edit genesis.json.');
  writeFileSync(path.join(clone, 'map-elsewhere.json'), kept);
  symlinkSync('../../../map-elsewhere.json', cloned);
  assert.match(validateSpec(clone, 'report-notifications').errors.join('\n'), /business-map\.json is a symbolic link, which other clones cannot follow/);

  // genesis.json committed without the copy beside it.
  const copy = 'openspec/changes/report-notifications/business-map.json';
  git(repo, ['rm', '-q', '--cached', copy]);
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /business-map\.json is not in Git, though genesis\.json is, so other clones cannot check this Spec against its Map\. Commit it with the Spec\./);
  writeFileSync(path.join(repo, '.gitignore'), 'business-map.json\n');
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /business-map\.json is ignored by Git/);
});

test('a checkout with CRLF line ends keeps the identity of the Spec, its export and its Map', (t) => {
  const repo = project(t, 'existing');
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(repo, ['init', '-q', '-b', 'main']);
  writeFiles(repo, { 'app/notify.py': 'def notify():\n    return True\n' });
  // Genesis writes its Map indented, one value per line.
  const mapFile = path.join(repo, 'map.json');
  writeFileSync(mapFile, `${JSON.stringify({ snapshot_id: 'sha256:lines', analysis_status: 'complete', mode: 'map', flows: [{ flow_id: 'flow_submit', name: 'Submit a report' }] }, null, 2)}\n`);
  newSpec(repo, 'report-notifications', { map: mapFile });
  const specFile = writeSpec(repo);
  const impactFile = path.join(repo, 'openspec/changes/report-notifications/impact.md');
  writeFileSync(impactFile, '---\ngenesis_impact: 1\nentries:\n  - flow: flow_submit\n    entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:2\n---\n');
  const exported = exportSpec(repo, 'report-notifications');
  // An LF Spec keeps the digest of its bytes, as before.
  const handoff = readJSON(exported.file);
  assert.equal(handoff.specs[0].sha256, sha256(readFileSync(specFile)));
  assert.equal(handoff.impact.sha256, sha256(readFileSync(impactFile)));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Spec']);

  // Git for Windows converts text files to CRLF on checkout by default.
  const clone = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-crlf-')));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(os.tmpdir(), ['clone', '-q', '-c', 'core.autocrlf=true', repo, clone]);
  for (const file of ['specs/notifications/spec.md', 'impact.md', 'business-map.json']) {
    assert.match(readFileSync(path.join(clone, 'openspec/changes/report-notifications', file), 'utf8'), /\r\n/, file);
  }
  const check = checkWorkflow(clone, 'write-eval', 'report-notifications');
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.equal(check.handoff.id, exported.id);
  assert.equal(exportSpec(clone, 'report-notifications').id, exported.id);
  // A Map copy with other content still fails, whatever its line ends.
  writeFileSync(path.join(clone, 'openspec/changes/report-notifications/business-map.json'), '{\r\n  "snapshot_id": "sha256:other"\r\n}\r\n');
  assert.equal(checkWorkflow(clone, 'write-eval', 'report-notifications').gaps[0].code, 'map_changed');
});

test('a Map written with CRLF line ends keeps its identity in a checkout with LF line ends', (t) => {
  const repo = project(t, 'existing');
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(repo, ['init', '-q', '-b', 'main']);
  // Git stores text files with LF line ends, whatever the working tree has.
  writeFiles(repo, { '.gitattributes': '* text=auto\n', 'app/notify.py': 'def notify():\n    return True\n' });
  // Genesis on Windows writes its Map with CRLF line ends.
  const mapFile = path.join(repo, 'map.json');
  writeFileSync(mapFile, `${JSON.stringify({ snapshot_id: 'sha256:lines', analysis_status: 'complete', mode: 'map', flows: [{ flow_id: 'flow_submit', name: 'Submit a report' }] }, null, 2)}\n`.replace(/\n/g, '\r\n'));
  newSpec(repo, 'report-notifications', { map: mapFile });
  writeSpec(repo);
  const exported = exportSpec(repo, 'report-notifications');
  assert.equal(checkWorkflow(repo, 'write-eval', 'report-notifications').status, 'ready');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Spec']);

  const clone = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-lf-')));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(os.tmpdir(), ['clone', '-q', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', repo, clone]);
  const copy = path.join(clone, 'openspec/changes/report-notifications/business-map.json');
  assert.doesNotMatch(readFileSync(copy, 'utf8'), /\r\n/);
  const check = checkWorkflow(clone, 'write-eval', 'report-notifications');
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.equal(check.handoff.id, exported.id);
  // A Map copy with other content still fails, whatever its line ends.
  writeFileSync(copy, '{\n  "snapshot_id": "sha256:other"\n}\n');
  assert.equal(checkWorkflow(clone, 'write-eval', 'report-notifications').gaps[0].code, 'map_changed');
});

test('a change made before the Map was copied keeps its genesis.json; a copy with the recorded digest stands in', (t) => {
  const repo = project(t, 'existing');
  const original = path.join(repo, '.genesis/out/ses_1/business-map.json');
  mkdirSync(path.dirname(original), { recursive: true });
  writeFileSync(original, JSON.stringify({ snapshot_id: 'sha256:one', analysis_status: 'complete', flows: [{ flow_id: 'flow_submit', name: 'Submit a report' }] }));
  newSpec(repo, 'report-notifications', { map: original });
  // What spec new recorded before: the path of Genesis's own output, no copy.
  const change = path.join(repo, 'openspec/changes/report-notifications');
  const contextFile = path.join(change, 'genesis.json');
  const context = readJSON(contextFile);
  writeFileSync(contextFile, `${JSON.stringify({ ...context, map: { ...context.map, path: '.genesis/out/ses_1/business-map.json' } }, null, 2)}\n`);
  rmSync(path.join(change, 'business-map.json'));
  writeSpec(repo);
  const exported = exportSpec(repo, 'report-notifications');
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
  // A path written on Windows still resolves.
  const exportedContext = readFileSync(contextFile);
  writeFileSync(contextFile, `${JSON.stringify({ ...context, map: { ...context.map, path: '.genesis\\out\\ses_1\\business-map.json' } }, null, 2)}\n`);
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
  writeFileSync(contextFile, exportedContext);

  // Genesis rewrote its output: the recorded file changed. A copy with the
  // recorded digest decides, and impact is still checked against it.
  const bytes = readFileSync(original);
  writeFileSync(original, '{}');
  assert.equal(checkWorkflow(repo, 'write-eval', 'report-notifications').gaps[0].code, 'map_changed');
  assert.match(checkWorkflow(repo, 'write-eval', 'report-notifications').gaps[0].message, /Genesis rewrites \.genesis\/out\/latest\/ on every run, so look in the \.genesis\/out\/<session>\/ folders\. Copy it to openspec\/changes\/report-notifications\/business-map\.json/);
  writeFileSync(path.join(change, 'business-map.json'), bytes);
  let changed = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(changed.status, 'ready', JSON.stringify(changed.gaps));
  assert.equal(changed.handoff.id, exported.id);
  const impactFile = path.join(change, 'impact.md');
  writeFileSync(impactFile, '---\ngenesis_impact: 1\nentries:\n  - flow: flow_unknown\n    entry: POST /reports\n    effect: changes\n    evidence: openspec/changes/report-notifications/genesis.json\n---\n');
  assert.match(validateSpec(repo, 'report-notifications').errors.join('\n'), /not in the recorded Map: flow_unknown/);
  rmSync(impactFile);
  rmSync(path.join(change, 'business-map.json'));

  // Another clone: Genesis's output is not there.
  rmSync(path.join(repo, '.genesis/out'), { recursive: true });
  let result = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(result.gaps[0].code, 'map_unavailable');
  assert.match(result.gaps[0].message, /genesis\.json records \.genesis\/out\/ses_1\/business-map\.json, which this checkout does not have \(Genesis keeps its output out of Git\)\. Copy that file .* to openspec\/changes\/report-notifications\/business-map\.json/);

  // The copy stands in without touching genesis.json, so the export still matches.
  writeFileSync(path.join(change, 'business-map.json'), bytes);
  result = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(result.status, 'ready', JSON.stringify(result.gaps));
  assert.equal(result.handoff.id, exported.id);
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /genesis\.json records the Map at \.genesis\/out\/ses_1\/business-map\.json; openspec\/changes\/report-notifications\/business-map\.json has the recorded digest and is used, as on other clones\./);
  writeFileSync(path.join(change, 'business-map.json'), '{}');
  assert.equal(checkWorkflow(repo, 'write-eval', 'report-notifications').gaps[0].code, 'map_changed');
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

test('the plugin manifests, the lock file and the CLI carry the package version, so a plugin update reaches its users', () => {
  // A plugin manager keeps users on the cached copy until the manifest version changes.
  const { version } = readJSON(path.join(ROOT, 'package.json'));
  assert.equal(readJSON(path.join(ROOT, '.claude-plugin/plugin.json')).version, version);
  assert.equal(readJSON(path.join(ROOT, '.codex-plugin/plugin.json')).version, version);
  const lock = readJSON(path.join(ROOT, 'package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], [version, version]);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, version);
  const help = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), '--help'], { encoding: 'utf8' });
  assert.ok(help.stdout.startsWith(`Genesis EDD ${version} `), help.stdout.slice(0, 80));
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
    // The installed skills point at this machine's checkout and stay out of Git.
    for (const skill of ['agent-spec', 'write-eval', 'run-eval', 'loop-and-implement']) {
      assert.equal(readFileSync(path.join(repo, directory, 'skills', skill, '.gitignore'), 'utf8'), '*\n');
    }
  }
  assert.deepEqual(initProject(repo, 'new', 'both').created, []);
});

// The exact files shipped before the skill was renamed. They are fixtures, not
// derived from the current skill, so editing the skill text cannot change them.
const legacyFixture = path.join(ROOT, 'tests/fixtures/legacy');
function legacyInstallation(t) {
  const repo = project(t, 'new', 'both');
  for (const directory of ['.agents', '.claude']) {
    const current = path.join(repo, directory, 'skills/agent-spec');
    const legacy = path.join(repo, directory, 'skills/genesis-spec');
    cpSync(path.join(legacyFixture, 'skill'), legacy, { recursive: true });
    renameSync(path.join(current, 'scripts/runtime.json'), path.join(legacy, 'scripts/runtime.json'));
    rmSync(current, { recursive: true });
  }
  const schema = path.join(repo, 'openspec/schemas/genesis-spec/schema.yaml');
  writeFileSync(schema, readFileSync(path.join(legacyFixture, 'schema.yaml'), 'utf8'));
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

test('init updates an untouched earlier agent-spec and leaves an edited one alone', (t) => {
  const repo = project(t, 'new', 'claude');
  const skill = path.join(repo, '.claude/skills/agent-spec');
  // The release before the skill text changed: the legacy files under the new name.
  const previous = readFileSync(path.join(legacyFixture, 'skill/SKILL.md'), 'utf8')
    .replace('name: genesis-spec', 'name: agent-spec').replace('# Genesis Spec', '# Agent Spec');
  writeFileSync(path.join(skill, 'SKILL.md'), previous);
  writeFileSync(path.join(skill, 'references/spec-format.md'), readFileSync(path.join(legacyFixture, 'skill/references/spec-format.md'), 'utf8'));
  const result = initProject(repo, 'new', 'claude');
  assert.deepEqual([...result.updated].sort(), ['.claude/skills/agent-spec/SKILL.md', '.claude/skills/agent-spec/references/spec-format.md']);
  assert.equal(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), readFileSync(path.join(ROOT, 'skills/agent-spec/SKILL.md'), 'utf8'));
  assert.deepEqual(initProject(repo, 'new', 'claude').updated, []);
  writeFileSync(path.join(skill, 'SKILL.md'), `${previous}\nTeam note\n`);
  assert.throws(() => initProject(repo, 'new', 'claude'), /differs; left unchanged/);
  assert.match(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /Team note/);
});

test('init updates the released skills, their references and example files included, when they are untouched', (t) => {
  const repo = project(t, 'new', 'claude');
  // The files as the last release shipped them.
  const previous = path.join(ROOT, 'tests/fixtures/previous-skills');
  const example = 'write-eval/examples/reportbot/.genesis/edd/report-submission-notifications/evals';
  const files = ['agent-spec/SKILL.md', 'agent-spec/references/spec-format.md', 'loop-and-implement/SKILL.md', 'loop-and-implement/references/causes.md', 'run-eval/SKILL.md',
    'run-eval/references/run-records.md', 'write-eval/SKILL.md', 'write-eval/references/task-package.md', 'write-eval/references/verifier.md', 'write-eval/references/environment.md',
    'write-eval/references/harbor.md', 'write-eval/examples/reportbot/README.md', `${example}/submit-failure-s1/tests/checks.json`,
    `${example}/submit-success-s1/tests/checks.json`];
  for (const file of files) {
    assert.notEqual(readFileSync(path.join(previous, file), 'utf8'), readFileSync(path.join(ROOT, 'skills', file), 'utf8'), file);
    writeFileSync(path.join(repo, '.claude/skills', file), readFileSync(path.join(previous, file)));
  }
  const result = initProject(repo, 'new', 'claude');
  assert.deepEqual([...result.updated].sort(), files.map((file) => `.claude/skills/${file}`).sort());
  for (const file of files) assert.equal(readFileSync(path.join(repo, '.claude/skills', file), 'utf8'), readFileSync(path.join(ROOT, 'skills', file), 'utf8'), file);
  assert.deepEqual(initProject(repo, 'new', 'claude').updated, []);
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

test('workflow check of the Spec stage does not touch .genesis, so a symlinked .genesis does not block it', (t) => {
  const repo = project(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(repo, '.genesis'), 'dir');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  const check = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(check.status, 'ready', JSON.stringify(check.gaps));
  assert.equal(check.next.action, 'export_spec');
  assert.deepEqual(readdirSync(outside), []);
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
  assert.equal(result.status, 'ready');
  assert.equal(result.handoff.id, first.id);
  assert.equal(result.next.owner, 'agent');
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
  writeFileSync(path.join(repo, 'openspec/changes/report-notifications/business-map.json'), JSON.stringify({ snapshot_id: 'changed', analysis_status: 'complete' }));
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

test('a change folder spec new left unfinished is named for deletion, never deleted', (t) => {
  const repo = project(t, 'existing');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'main');
  // OpenSpec created the folder; spec new stopped before it wrote genesis.json.
  const interrupted = (name, map = false) => {
    openspec(repo, ['new', 'change', name, '--schema', SCHEMA, '--json']);
    if (map) writeFileSync(path.join(repo, 'openspec/changes', name, 'business-map.json'), '{}');
    return path.join(repo, 'openspec/changes', name);
  };
  const advice = (name) => `openspec/changes/${name}/ has no genesis.json and nothing in it is in Git: an earlier \`spec new\` stopped before it finished, so there is no recorded context to restore. Delete that folder and run \`spec new\` again.`;
  const folder = interrupted('report-notifications', true);
  assert.throws(() => newSpec(repo, 'report-notifications'), (error) => error.message === advice('report-notifications'));
  const check = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(check.gaps[0].code, 'context_unavailable');
  assert.equal(check.gaps[0].message, advice('report-notifications'));
  assert.equal(check.next.owner, 'agent');
  assert.ok(existsSync(path.join(folder, '.openspec.yaml')));
  rmSync(folder, { recursive: true });
  assert.equal(newSpec(repo, 'report-notifications').context.map.status, 'missing');

  // Anything committed, or authored, is not an unfinished spec new.
  const committed = interrupted('committed');
  git('add', '--', 'openspec/changes/committed');
  git('commit', '-q', '-m', 'Half a change');
  assert.throws(() => newSpec(repo, 'committed'), /^Error: Change already exists/);
  assert.match(checkWorkflow(repo, 'spec-export', 'committed').gaps[0].message, /^Restore the recorded code\/Map context/);
  const authored = interrupted('authored');
  writeSpec(repo, fixture, 'authored');
  assert.throws(() => newSpec(repo, 'authored'), /^Error: Change already exists/);
  assert.ok(existsSync(committed) && existsSync(authored));

  // Without Git there is nothing to be committed.
  const plain = project(t, 'existing');
  openspec(plain, ['new', 'change', 'plain', '--schema', SCHEMA, '--json']);
  assert.throws(() => newSpec(plain, 'plain'), /^Error: openspec\/changes\/plain\/ has no genesis\.json: an earlier `spec new` stopped before it finished/);
});

test('in Git, a committed copy decides for a change made before the Map was copied, on this machine too', (t) => {
  const repo = project(t, 'existing');
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '-b', 'main']);
  const original = path.join(repo, '.genesis/out/ses_1/business-map.json');
  mkdirSync(path.dirname(original), { recursive: true });
  writeFileSync(path.join(repo, '.genesis/.gitignore'), 'sessions/\nout/\n');
  writeFileSync(original, JSON.stringify({ snapshot_id: 'sha256:one', analysis_status: 'complete', flows: [] }));
  newSpec(repo, 'report-notifications', { map: original });
  const change = path.join(repo, 'openspec/changes/report-notifications');
  const contextFile = path.join(change, 'genesis.json');
  const context = readJSON(contextFile);
  writeFileSync(contextFile, `${JSON.stringify({ ...context, map: { ...context.map, path: '.genesis/out/ses_1/business-map.json' } }, null, 2)}\n`);
  rmSync(path.join(change, 'business-map.json'));
  writeSpec(repo);
  const exported = exportSpec(repo, 'report-notifications');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Spec made before the copy']);
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /\.genesis\/out\/ses_1\/business-map\.json is ignored by Git, so other clones cannot check this Spec against its Map\. Copy it to openspec\/changes\/report-notifications\/business-map\.json and commit it with the Spec; do not edit genesis\.json\./);

  // Following that advice clears it.
  const copy = path.join(change, 'business-map.json');
  writeFileSync(copy, readFileSync(original));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Commit the Map copy']);
  const fixed = validateSpec(repo, 'report-notifications');
  assert.equal(fixed.ready_for_eval_design, true, JSON.stringify(fixed.errors));
  assert.doesNotMatch(fixed.warnings.join('\n'), /Git/);
  assert.equal(checkWorkflow(repo, 'write-eval', 'report-notifications').handoff.id, exported.id);

  // A wrong copy fails here as it would on any clone, though the recorded file still matches.
  writeFileSync(copy, JSON.stringify({ snapshot_id: 'sha256:later', analysis_status: 'complete' }));
  const wrong = checkWorkflow(repo, 'write-eval', 'report-notifications');
  assert.equal(wrong.gaps[0].code, 'map_changed');
  assert.match(wrong.gaps[0].message, /^Referenced Map changed: openspec\/changes\/report-notifications\/business-map\.json no longer has the digest recorded in genesis\.json\. Other clones read this copy, so it must be the recorded Map\./);
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

test('later stage entries return diagnostics without claiming readiness or running a stage', (t) => {
  const { repo } = authored(t);
  for (const stage of ['loop-and-implement']) {
    const result = checkWorkflow(repo, stage, 'report-notifications');
    assert.equal(result.status, 'blocked');
    assert.equal(result.inputs_ready, false);
    const response = spawnSync(process.execPath, [path.join(ROOT, 'bin/genesis-edd.js'), stage, 'report-notifications', '--repo', repo], { encoding: 'utf8' });
    assert.equal(response.status, 1);
    const diagnostic = JSON.parse(response.stdout);
    assert.equal(diagnostic.inputs_ready, result.inputs_ready);
    assert.equal(diagnostic.status, result.status);
    assert.deepEqual(diagnostic.gaps, result.gaps);
    assert.deepEqual(diagnostic.resume, result.resume);
  }
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
  assert.throws(() => checkWorkflow(repo, 'unknown', 'report-notifications'), /Unknown stage/);
  assert.throws(() => checkWorkflow(repo, 'spec-export', '../escape'), /kebab-case/);
});

test('a project whose Spec schema is missing, as in a clone committed without openspec/schemas/, is told to run init again, which restores it', (t) => {
  const repo = project(t, 'existing');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  rmSync(path.join(repo, 'openspec/schemas'), { recursive: true, force: true });
  const check = checkWorkflow(repo, 'spec-export', 'report-notifications');
  assert.equal(check.status, 'blocked');
  const gap = check.gaps.find((entry) => entry.code === 'project_invalid');
  assert.ok(gap, JSON.stringify(check.gaps));
  assert.equal(gap.route, 'init');
  assert.ok(gap.message.startsWith(`openspec/schemas/${SCHEMA}/ is missing, so OpenSpec cannot read this project's Specs. Run \`init --repo <app> --mode existing --agent none\``), gap.message);
  assert.throws(() => newSpec(repo, 'another-change'), /openspec\/schemas\/genesis-spec\/ is missing/);

  initProject(repo, 'existing', 'none');
  assert.ok(existsSync(path.join(repo, `openspec/schemas/${SCHEMA}/schema.yaml`)));
  assert.equal(validateSpec(repo, 'report-notifications').valid, true);
});
