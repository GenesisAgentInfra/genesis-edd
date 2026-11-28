import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, SCHEMA, initProject, openspec, projectRoot, readJSON } from '../src/project.js';
import { exportFacts, exportSpec, frozenSpec, newSpec, specInstructions, specStatus, validateSpec } from '../src/spec.js';
import { checkWorkflow, workflowStatus } from '../src/workflow.js';
import { actionOf, assertGapShape, assertNoRoutes, useFakeTools } from './helpers/edd.js';

const fixture = readFileSync(path.join(ROOT, 'examples/report-notifications/spec.md'), 'utf8');
const NAME = 'report-notifications';
const CLI = path.join(ROOT, 'bin/genesis-edd.js');
const gapOf = (gaps, code) => (gaps ?? []).find((gap) => gap.code === code);
// workflow status reads Docker and Harbor too: here the fake ones, so nothing
// real runs. The Spec layer is what this file is about.
function statusOf(t, repo, name = NAME) {
  useFakeTools(t);
  return workflowStatus(repo, name);
}
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
  // Every export is one line of exports.jsonl, which names the one before it.
  const log = readFileSync(path.join(repo, 'openspec/changes/report-notifications/exports.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(log.map((entry) => [entry.id, entry.source, entry.previous]), [[first.id, 'export', null], [second.id, 'export', first.id]]);
  // A handoff whose content no longer matches its address is never rewritten.
  writeFileSync(second.file, '{}');
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => {
    assert.equal(error.code, 'HANDOFF_INVALID');
    assert.match(error.message, /exists with other content than the export it is named for .*A handoff is never rewritten\./);
    assertGapShape(error.gaps[0], { code: 'handoff_invalid', owner: 'agent', layer: 'spec', digest: second.id });
    return true;
  });
  assert.equal(readFileSync(second.file, 'utf8'), '{}');
});

test('a proposed requirement is a draft: the export leaves it out and lists it, and drafts alone cannot be exported', (t) => {
  const { repo, file } = authored(t, fixture.replace('state: explicit', 'state: proposed'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.ready_for_eval_design, false);
  const excluded = { requirement: 'REQ-submit-failure', name: '提交失败时不发送成功通知', path: 'specs/notifications/spec.md', state: 'proposed', reason: 'proposed' };
  assert.deepEqual(result.excluded, [excluded]);
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => {
    assert.equal(error.code, 'SPEC_INPUT_BLOCKED');
    // Accepting a requirement is the user's decision.
    assertGapShape(gapOf(error.gaps, 'requirements_all_excluded'), { owner: 'user', kind: 'business', layer: 'spec', requirement_ids: ['REQ-submit-failure'] });
    return true;
  });
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);

  // Beside an accepted requirement, a proposed one is left out of the handoff
  // and never becomes a check; the export lists it, and so does what the user is shown.
  writeFileSync(file, twoExplicit.replace(second, second.replace('explicit', 'proposed')));
  const exported = exportSpec(repo, 'report-notifications');
  const handoff = readJSON(exported.file);
  assert.deepEqual(handoff.requirements.map((requirement) => requirement.id), ['REQ-submit-failure']);
  const left = { requirement: 'REQ-submit-success', name: '提交成功时发送成功通知', path: 'specs/notifications/spec.md', state: 'proposed', reason: 'proposed' };
  assert.deepEqual(handoff.excluded, [left]);
  assert.deepEqual(exported.excluded, [left]);
  assert.deepEqual(exported.must_show.excluded, [left]);
  assert.deepEqual(exported.must_show.requirements.map((requirement) => requirement.requirement), ['REQ-submit-failure']);
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

  // A derived rule is a valid draft once it is labelled as a proposal: the
  // stated requirement can be exported, and the proposal is left out of it.
  writeFileSync(file, twoExplicit.replace(second, second.replace('explicit', 'proposed')));
  const draft = validateSpec(repo, 'report-notifications');
  assert.equal(draft.valid, true, JSON.stringify(draft.errors));
  assert.equal(draft.ready_for_eval_design, true);
  assert.deepEqual(draft.excluded.map((entry) => [entry.requirement, entry.reason]), [['REQ-submit-success', 'proposed']]);

  // Two requirements are explicit when the quoted words state both.
  writeFileSync(file, twoExplicit.replace('不要发送成功通知。"', '不要发送成功通知。提交成功时发送成功通知。"'));
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
});

test('export lists each requirement beside the words, outcomes and scenarios it rests on', (t) => {
  const { repo } = authored(t, twoExplicit.replace('不要发送成功通知。"', '不要发送成功通知。提交成功时发送成功通知。"')
    .replace(second, `${second.replace('explicit', 'confirmed')}\n    confirmation:\n      by: Example user\n      ref: example:approval-message`));
  const quote = '报告提交失败时，不要发送成功通知。提交成功时发送成功通知。';
  assert.deepEqual(exportSpec(repo, 'report-notifications').review, [
    {
      requirement: 'REQ-submit-failure', name: '提交失败时不发送成功通知', path: 'specs/notifications/spec.md', state: 'explicit',
      basis: { source: 'request', kind: 'user', quote },
      statement: '系统 MUST 在报告提交失败时不发送成功通知。', outcomes: ['本次提交发送的成功通知数量为零'],
      scenarios: [{ name: '提交失败', given: [], when: ['报告提交返回失败'], then: ['本次提交发送的成功通知数量为零'] }],
    },
    {
      requirement: 'REQ-submit-success', name: '提交成功时发送成功通知', path: 'specs/notifications/spec.md', state: 'confirmed',
      basis: { source: 'request', kind: 'user', quote },
      confirmation: { by: 'Example user', ref: 'example:approval-message' },
      statement: '系统 MUST 在报告提交成功时发送成功通知。', outcomes: ['本次提交发送的成功通知数量为一', '不发送失败通知'],
      scenarios: [{ name: '提交成功', given: ['报告内容完整', '提交服务可用'], when: ['报告提交返回成功'], then: ['本次提交发送的成功通知数量为一', '不发送失败通知'] }],
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

test('impact records touched flows and evidence, checked against the Map and the project; what does not check out is a warning the export records', (t) => {
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

  // Impact describes what the request touches; it holds back no export. An
  // entry without the fields it needs is left out; any other entry stays.
  for (const [entries, pattern, kept] of [
    ['  - flow: flow_unknown\n    entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:1', /entries\[0\] flow is not in the recorded Map: flow_unknown/, 1],
    ['  - entry: POST /reports\n    effect: changes\n    evidence: app/missing.py:1', /entries\[0\] evidence does not point to a file in the project: app\/missing\.py:1/, 1],
    ['  - entry: POST /reports\n    effect: changes\n    evidence: ../outside.py', /entries\[0\] evidence does not point to a file in the project: \.\.\/outside\.py/, 1],
    ['  - entry: POST /reports\n    effect: changes\n    evidence: app/notify.py:99', /entries\[0\] evidence line is outside the file: app\/notify\.py:99/, 1],
    ['  - entry: POST /reports\n    effect: rewrites\n    evidence: app/notify.py', /entries\[0\] needs entry, effect \(changes or may_affect\) and evidence \(path or path:line\); it is left out\./, 0],
  ]) {
    impact(entries);
    const result = validateSpec(repo, 'report-notifications');
    assert.equal(result.ready_for_eval_design, true, `${entries}\n${result.errors.join('\n')}`);
    assert.match(result.warnings.filter((warning) => warning.startsWith('impact.md: ')).join('\n'), pattern, entries);
    assert.equal(gapOf(result.gaps, 'impact_invalid'), undefined);
    assert.equal(result.impact.entries.length, kept, entries);
    assert.match(result.impact.problems.join('\n'), pattern);
  }
  // The export records the entries with the problems found in them.
  const recorded = readJSON(exportSpec(repo, 'report-notifications').file).impact;
  assert.deepEqual(recorded.entries, []);
  assert.match(recorded.problems.join('\n'), /it is left out/);
  writeFileSync(impactFile, 'No frontmatter here.\n');
  const bare = validateSpec(repo, 'report-notifications');
  assert.equal(bare.ready_for_eval_design, true);
  assert.match(bare.warnings.join('\n'), /impact\.md: Needs YAML frontmatter with genesis_impact: 1 and a non-empty entries list\./);
});

test('code that moves impact evidence after export keeps that export usable, not a new one', (t) => {
  useFakeTools(t);
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

  for (const [move, pattern] of [[() => writeFileSync(source, 'pass'), /evidence line is outside the file: app\/notify\.py:2/], [() => rmSync(source), /evidence does not point to a file in the project: app\/notify\.py:2/]]) {
    move();
    // Checked now, the evidence no longer holds: a warning.
    const now = validateSpec(repo, 'report-notifications');
    assert.equal(now.ready_for_eval_design, true, JSON.stringify(now.errors));
    assert.match(now.warnings.join('\n'), pattern);
    // Later stages read the export by digest, which still holds.
    const frozen = frozenSpec(repo, 'report-notifications');
    assert.deepEqual(frozen.gaps, []);
    assert.equal(frozen.handoff.id, exported.id);
    // Exporting the same draft again writes nothing.
    const again = exportSpec(repo, 'report-notifications');
    assert.equal(again.id, exported.id);
    assert.equal(again.unchanged, true);
  }
  const status = workflowStatus(repo, 'report-notifications');
  assert.equal(status.layers.spec.export_holds, true, JSON.stringify(status.layers.spec.gaps));
  assert.equal(status.layers.spec.export.id, exported.id);

  // A changed impact.md is a new export. Until then later stages read the
  // export's impact; the new export records the evidence that does not check out.
  writeFileSync(impactFile, impact.replace('effect: changes', 'effect: may_affect'));
  const frozen = frozenSpec(repo, 'report-notifications');
  assert.equal(frozen.handoff.id, exported.id);
  assert.match(frozen.validation.warnings.join('\n'), /impact\.md differs from the one export .* holds; later stages read the export's\./);
  const changed = exportSpec(repo, 'report-notifications');
  assert.notEqual(changed.id, exported.id);
  assert.deepEqual(readJSON(changed.file).impact.problems, ['entries[0] evidence does not point to a file in the project: app/notify.py:2']);

  // Any other problem blocks a new export, and later stages see the draft as
  // not exported.
  writeFileSync(impactFile, impact);
  writeSpec(repo, fixture.replace('source: request', 'source: unknown'));
  assert.throws(() => exportSpec(repo, 'report-notifications'), /references an unknown source/);
  assertGapShape(frozenSpec(repo, 'report-notifications').gaps[0], { code: 'handoff_missing', owner: 'agent', layer: 'spec', changed: ['specs/notifications/spec.md'] });
});

test('confirmed interpretations need an actor and actual confirmation reference', (t) => {
  const { repo, file } = authored(t, fixture.replace('state: explicit', 'state: confirmed'));
  assert.equal(validateSpec(repo, 'report-notifications').valid, false);
  writeFileSync(file, fixture.replace('state: explicit', 'state: confirmed\n    confirmation:\n      by: Example user\n      ref: example:approval-message'));
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
});

test('missing outcomes are rejected by Genesis\'s own reading of the scenarios and by the real OpenSpec strict validator', (t) => {
  // The AND continues the WHEN step, so the scenario has no THEN step.
  const { repo } = authored(t, fixture.replace('- **THEN** 本次提交发送的成功通知数量为零', '- **AND** 不发送通知'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, false);
  assertGapShape(gapOf(result.gaps, 'scenario_incomplete'), {
    owner: 'agent', layer: 'spec', path: 'specs/notifications/spec.md', line: 28, requirement_id: 'REQ-submit-failure', scenario: '提交失败',
    message: 'specs/notifications/spec.md:28: scenario "提交失败" of REQ-submit-failure lacks a THEN step.',
  });
  assert.match(gapOf(result.gaps, 'spec_format_invalid').message, /^OpenSpec strict reports problems that change what is read as requirements, scenarios or steps: .*scenario "提交失败" is missing a THEN step/);
  assert.throws(() => exportSpec(repo, 'report-notifications'), /lacks a THEN step/);
});

test('archive warning exception never hides extra requirements in the preamble', (t) => {
  const { repo } = authored(t, fixture.replace('## Purpose', 'The system MUST additionally email every administrator.\n\n## Purpose'));
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, false);
  assert.equal(result.openspec_advisory_issues.length, 0);
  assertGapShape(gapOf(result.gaps, 'spec_format_invalid'), { owner: 'agent', layer: 'spec', path: 'specs/notifications/spec.md', line: 18, text: 'The system MUST additionally email every administrator.' });
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
  // freshness is left unchecked. (The other warning is about .dockerignore.)
  const mapWarnings = created.warnings.filter((warning) => !/\.dockerignore/.test(warning));
  assert.equal(mapWarnings.length, 1, JSON.stringify(created.warnings));
  assert.match(mapWarnings[0], /^Whether this Map still matches the code was not checked: it does not record the code it was read from/);
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
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => {
    assertGapShape(gapOf(error.gaps, 'map_changed'), {
      owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/business-map.json', digest: created.context.map.sha256,
    });
    assert.match(error.message, /The Map openspec\/changes\/report-notifications\/business-map\.json no longer has the digest genesis\.json records/);
    return true;
  });
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
  const status = statusOf(t, repo);
  assert.equal(status.layers.spec.map, null);
  assert.equal(status.layers.spec.draft.ready_for_export, true, JSON.stringify(status.layers.spec.draft.gaps));
  assert.match(status.layers.spec.draft.warnings.join('\n'), /No Map supplied/);
  assert.equal(actionOf(status, 'spec', 'export').allowed, true);
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
  assert.ok(result.warnings.includes('impact.md names flow IDs (flow_doesnotexist), but no Map is recorded, so they could not be checked. A flow ID comes from the recorded Map.'), JSON.stringify(result.warnings));
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
  assert.equal(again.warnings[0], 'Git still tracks skill folders an earlier install committed: .claude/skills/agent-spec, .claude/skills/write-eval. They point at this machine\'s checkout, and their .gitignore does not untrack them; `git rm -r --cached` of those folders takes them out of Git and leaves the files on disk.');
  assert.doesNotMatch(again.warnings[0], /run-eval|loop-and-implement/);
});

test('the Map of a Genesis change review is accepted and recorded as covering only what that review analyzed', (t) => {
  const repo = project(t, 'existing');
  const review = path.join(repo, '.genesis/out/latest');
  mkdirSync(review, { recursive: true });
  writeFileSync(path.join(review, 'business-map.json'), JSON.stringify({ snapshot_id: 'sha256:review', analysis_status: 'complete' }));
  writeFileSync(path.join(review, 'change-report.json'), '{}');
  // change-report.json beside it marks a change review, whatever the Map says.
  const created = newSpec(repo, 'after-review', { map: path.join(review, 'business-map.json') });
  assert.equal(created.context.map.status, 'available');
  assert.equal(created.context.map.path, 'openspec/changes/after-review/business-map.json');
  assert.equal(created.context.map.mode, 'change');
  assert.equal(created.context.map.coverage_scope, 'partial');
  assert.ok(created.warnings.includes('This Map comes from a Genesis change review (change-report.json is beside it): it covers only what that review analyzed, not the whole project. It is recorded with coverage_scope partial, and a Genesis review that starts from it covers only those flows.'), JSON.stringify(created.warnings));
  // Every check repeats that limit, and the export records it and shows it to the user.
  writeSpec(repo, fixture, 'after-review');
  const result = validateSpec(repo, 'after-review');
  assert.equal(result.ready_for_eval_design, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.includes('This Map comes from a Genesis change review: it covers only what that review analyzed (coverage_scope partial), and a Genesis review started from it covers only those flows.'), JSON.stringify(result.warnings));
  const exported = exportSpec(repo, 'after-review');
  assert.equal(readJSON(exported.file).context.map.coverage_scope, 'partial');
  assert.deepEqual(exported.must_show.map, [{ freshness: 'unverified', mode: 'change', analysis_status: 'complete', coverage_scope: 'partial' }]);
  // Without the report beside it, the same Map is of unknown mode.
  rmSync(path.join(review, 'change-report.json'));
  const created2 = newSpec(repo, 'after-map', { map: path.join(review, 'business-map.json') });
  assert.equal(created2.context.map.mode, 'unknown');
  assert.equal('coverage_scope' in created2.context.map, false);
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

test('a Map whose mode is change is recorded as partial coverage, one of a mode Genesis does not know is refused, and one without a mode is used as unknown, never as map', (t) => {
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
  const review = newSpec(repo, 'from-review', { map: write('review.json', { ...base, mode: 'change' }) });
  assert.equal(review.context.map.mode, 'change');
  assert.equal(review.context.map.coverage_scope, 'partial');
  assert.match(review.warnings.join('\n'), /comes from a Genesis change review \(its mode is change\): it covers only what that review analyzed, not the whole project\. It is recorded with coverage_scope partial/);
  assert.throws(() => newSpec(repo, 'odd-mode', { map: write('odd.json', { ...base, mode: 'diff' }) }), /mode Genesis EDD does not know: "diff"/);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/odd-mode')), false);

  const full = newSpec(repo, 'from-map', { map: write('map.json', { ...base, mode: 'map' }) });
  assert.equal(full.context.map.mode, 'map');
  assert.equal('coverage_scope' in full.context.map, false);
  assert.doesNotMatch(full.warnings.join('\n'), /does not say whether|change review/);
  // A Map from Genesis before mode existed may be either kind.
  for (const [change, value] of [['from-older', base], ['null-mode', { ...base, mode: null }]]) {
    const older = newSpec(repo, change, { map: write(`${change}.json`, value) });
    assert.equal(older.context.map.mode, 'unknown');
    assert.ok(older.warnings.includes('This Map does not say whether it maps the whole project or a change review: Genesis before 9c0c914 wrote no mode, and nothing beside it marks a review, so it is recorded with mode unknown.'), JSON.stringify(older.warnings));
  }
  // change-report.json beside a Map still marks a review, whatever its mode says.
  const latest = write('latest/business-map.json', { ...base, mode: 'map' });
  writeFileSync(path.join(path.dirname(latest), 'change-report.json'), '{}');
  const beside = newSpec(repo, 'beside-report', { map: latest });
  assert.equal(beside.context.map.mode, 'change');
  assert.equal(beside.context.map.coverage_scope, 'partial');
  assert.match(beside.warnings.join('\n'), /comes from a Genesis change review \(change-report\.json is beside it\)/);
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
    `1 of the files this Map was read from has uncommitted edits (app/notify.py). Its freshness compares commit ${head}, not those edits, while impact.md evidence is read from the working tree, so the Map and that evidence may describe different code.`,
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
  assert.match(stale.warnings.join('\n'), new RegExp(`This Map no longer matches the code of commit ${head.slice(0, 7)}: 2 of the 3 files it was read from changed or are gone since Genesis read them \\(app/notify\\.py, docs/报告 notes\\.md\\)\\. Its flows may describe code that is not there anymore\\. Until the change is first exported, \`spec remap\` can replace it with a Map of this code\\.`));
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

test('validate and export work the Map\'s facts out again from its copy, against the commit checked out now, whatever genesis.json says', (t) => {
  const { repo, git } = committedProject(t, APP);
  const head = git('rev-parse', 'HEAD').slice(0, 7);
  const source = sourceOf(git('rev-parse', 'HEAD'), APP);
  const notes = (change) => validateSpec(repo, change).warnings.filter((warning) => /Map/.test(warning));
  newSpec(repo, 'fresh', { map: sourcedMap(t, source) });
  writeSpec(repo, fixture, 'fresh');
  const verified = [`The Map was verified against the code of commit ${head}.`];
  assert.deepEqual(notes('fresh'), verified);
  const exported = exportSpec(repo, 'fresh');
  assert.deepEqual(exported.warnings.filter((warning) => /Map/.test(warning)), verified);
  assert.equal(readJSON(exported.file).context.map.freshness, 'verified');
  // A verified Map of the whole project limits nothing the user must hear about.
  assert.equal('map' in exported.must_show, false);

  // After a commit that changes a file the Map read, the same Map is stale
  // when checked now. The export made before keeps what it recorded.
  writeFiles(repo, { 'app/notify.py': 'def notify(report):\n    return "queued"\n' });
  git('commit', '-q', '-am', 'Queue notices');
  const later = git('rev-parse', 'HEAD').slice(0, 7);
  const stale = `This Map no longer matches the code of commit ${later}: 1 of the 3 files it was read from changed or are gone since Genesis read them (app/notify.py). Its flows may describe code that is not there anymore. Until the change is first exported, \`spec remap\` can replace it with a Map of this code.`;
  const differs = 'genesis.json records the Map differently from what the Map gives now: freshness verified there, stale from the Map. The Map decides, and an export records what it gives.';
  assert.deepEqual(notes('fresh'), [differs, stale]);
  assert.deepEqual(validateSpec(repo, 'fresh').map_differs, [{ field: 'freshness', recorded: 'verified', computed: 'stale' }]);
  assert.equal(readJSON(exported.file).context.map.freshness, 'verified');

  // genesis.json edited to call a stale Map verified changes nothing: the
  // export records what the Map gives, and shows the user that it is stale.
  newSpec(repo, 'stale', { map: sourcedMap(t, source) });
  writeSpec(repo, fixture, 'stale');
  assert.deepEqual(notes('stale'), [stale]);
  const contextFile = path.join(repo, 'openspec/changes/stale/genesis.json');
  const context = readJSON(contextFile);
  assert.equal(context.map.freshness, 'stale');
  writeFileSync(contextFile, `${JSON.stringify({ ...context, map: { ...context.map, freshness: 'verified' } }, null, 2)}\n`);
  const edited = validateSpec(repo, 'stale');
  assert.equal(edited.ready_for_eval_design, true, JSON.stringify(edited.errors));
  assert.deepEqual(edited.map_differs, [{ field: 'freshness', recorded: 'verified', computed: 'stale' }]);
  assert.deepEqual(edited.warnings.filter((warning) => /Map/.test(warning)), [differs, stale]);
  // workflow status shows the draft with the same warnings.
  const draft = statusOf(t, repo, 'stale').layers.spec.draft;
  assert.deepEqual(draft.map_differs, edited.map_differs);
  assert.ok(draft.warnings.includes(stale), JSON.stringify(draft.warnings));
  const staleExport = exportSpec(repo, 'stale');
  assert.equal(readJSON(staleExport.file).context.map.freshness, 'stale');
  assert.equal(staleExport.map.freshness, 'stale');
  assert.deepEqual(staleExport.must_show.map, [{ freshness: 'stale', mode: 'map', analysis_status: 'complete' }]);

  // A Map without source or mode, partial, with steps named from code.
  const older = path.join(repo, 'older.json');
  writeFileSync(older, JSON.stringify({ snapshot_id: 'sha256:older', analysis_status: 'partial', flows: [
    { flow_id: 'flow_a', name: 'Described', steps: [{ support: 'agent_synthesis' }] },
    { flow_id: 'flow_b', name: 'POST /refunds', steps: [{ support: 'static_fact' }, { support: 'static_fact' }] },
  ] }));
  newSpec(repo, 'older', { map: older });
  writeSpec(repo, fixture, 'older');
  assert.deepEqual(notes('older'), [
    'Whether this Map still matches the code was not checked: it does not record the code it was read from, which Genesis before 9c0c914 did not do. A Map from Genesis 9c0c914 or later can be checked.',
    'This Map does not say whether it maps the whole project or a change review (mode unknown).',
    'This Map is partial: some flows are not described yet or leave code unaccounted for, or files were left out.',
    '2 of the 3 steps in this Map belong to flows Genesis has not described yet and are named from the source code, which goes into Git with the Map copy.',
  ]);
  assert.deepEqual(exportSpec(repo, 'older').must_show.map, [{ freshness: 'unverified', mode: 'unknown', analysis_status: 'partial' }]);

  // A genesis.json without freshness or mode, as spec new wrote before it
  // recorded them: the Map gives both.
  const freshContext = path.join(repo, 'openspec/changes/fresh/genesis.json');
  const recorded = readJSON(freshContext);
  delete recorded.map.freshness;
  delete recorded.map.mode;
  writeFileSync(freshContext, `${JSON.stringify(recorded, null, 2)}\n`);
  assert.deepEqual(notes('fresh'), [
    'genesis.json records the Map differently from what the Map gives now: mode nothing there, map from the Map; freshness nothing there, stale from the Map. The Map decides, and an export records what it gives.',
    stale,
  ]);
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
  assert.deepEqual(outside(created.warnings), ['This Map\'s planned flows cover 1 of the 4 entries Genesis found: 1 skipped (1 budget) and 2 not handled. Its analysis_status says whether those flows are finished, not whether the whole project is mapped, so an entry outside them is not described by the Map.']);
  writeSpec(repo, fixture, 'some');
  assert.deepEqual(outside(validateSpec(repo, 'some').warnings), ['This Map\'s planned flows cover 1 of the 4 entries Genesis found: 1 skipped and 2 not handled. Its analysis_status says whether those flows are finished, not whether the whole project is mapped, so an entry outside them is not described by the Map.']);
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
  const created = newSpec(repo, 'report-notifications', { map: original });
  writeSpec(repo);
  const before = validateSpec(repo, 'report-notifications');
  assert.equal(before.ready_for_eval_design, true, JSON.stringify(before.errors));
  assert.doesNotMatch(before.warnings.join('\n'), /Git/);
  // An ignore rule that would keep the copy out is named before the first commit.
  writeFileSync(path.join(repo, '.gitignore'), 'business-map.json\n');
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /openspec\/changes\/report-notifications\/business-map\.json is ignored by Git, so other clones cannot check this Spec against its Map\./);
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
  const status = statusOf(t, clone);
  assert.equal(status.layers.spec.export_holds, true, JSON.stringify(status.layers.spec.gaps));
  assert.equal(status.layers.spec.export.id, exported.id);
  // A missing copy is the Spec checks' finding, with the digest to restore
  // it by. The export later stages read is checked by its digest and holds.
  const cloned = path.join(clone, 'openspec/changes/report-notifications/business-map.json');
  const kept = readFileSync(cloned);
  rmSync(cloned);
  assertGapShape(gapOf(validateSpec(clone, 'report-notifications').gaps, 'map_unavailable'), {
    owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/business-map.json', digest: created.context.map.sha256,
    message: `The Map copy openspec/changes/report-notifications/business-map.json is missing. It is committed with the Spec, with digest ${created.context.map.sha256}.`,
  });
  assert.equal(frozenSpec(clone, 'report-notifications').handoff.id, exported.id);
  // A link to it would dangle on other clones.
  writeFileSync(path.join(clone, 'map-elsewhere.json'), kept);
  symlinkSync('../../../map-elsewhere.json', cloned);
  assert.match(validateSpec(clone, 'report-notifications').errors.join('\n'), /business-map\.json is a symbolic link, which other clones cannot follow/);

  // genesis.json committed without the copy beside it.
  const copy = 'openspec/changes/report-notifications/business-map.json';
  git(repo, ['rm', '-q', '--cached', copy]);
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /business-map\.json is not in Git, though genesis\.json is, so other clones cannot check this Spec against its Map\./);
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
  const status = statusOf(t, clone);
  assert.equal(status.layers.spec.export_holds, true, JSON.stringify(status.layers.spec.gaps));
  assert.equal(status.layers.spec.export.id, exported.id);
  assert.deepEqual(status.layers.spec.gaps, []);
  const checked = validateSpec(clone, 'report-notifications');
  assert.equal(checked.ready_for_eval_design, true, JSON.stringify(checked.errors));
  const again = exportSpec(clone, 'report-notifications');
  assert.equal(again.id, exported.id);
  assert.equal(again.unchanged, true);
  // A Map copy with other content still fails, whatever its line ends.
  writeFileSync(path.join(clone, 'openspec/changes/report-notifications/business-map.json'), '{\r\n  "snapshot_id": "sha256:other"\r\n}\r\n');
  assertGapShape(gapOf(validateSpec(clone, 'report-notifications').gaps, 'map_changed'), { owner: 'agent', layer: 'spec' });
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
  assert.equal(validateSpec(repo, 'report-notifications').ready_for_eval_design, true);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Spec']);

  const clone = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-lf-')));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(os.tmpdir(), ['clone', '-q', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', repo, clone]);
  const copy = path.join(clone, 'openspec/changes/report-notifications/business-map.json');
  assert.doesNotMatch(readFileSync(copy, 'utf8'), /\r\n/);
  const checked = validateSpec(clone, 'report-notifications');
  assert.equal(checked.ready_for_eval_design, true, JSON.stringify(checked.errors));
  const status = statusOf(t, clone);
  assert.equal(status.layers.spec.export_holds, true, JSON.stringify(status.layers.spec.gaps));
  assert.equal(status.layers.spec.export.id, exported.id);
  assert.equal(exportSpec(clone, 'report-notifications').id, exported.id);
  // A Map copy with other content still fails, whatever its line ends.
  writeFileSync(copy, '{\n  "snapshot_id": "sha256:other"\n}\n');
  assertGapShape(gapOf(validateSpec(clone, 'report-notifications').gaps, 'map_changed'), { owner: 'agent', layer: 'spec' });
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
  const rewritten = gapOf(validateSpec(repo, 'report-notifications').gaps, 'map_changed');
  assertGapShape(rewritten, { owner: 'agent', layer: 'spec', path: '.genesis/out/ses_1/business-map.json', digest: context.map.sha256 });
  assert.match(rewritten.message, /^The Map \.genesis\/out\/ses_1\/business-map\.json no longer has the digest genesis\.json records, sha256:[0-9a-f]{64}\. Genesis rewrites \.genesis\/out\/latest\/ on every run; the \.genesis\/out\/<session>\/ folders keep earlier Maps\./);
  writeFileSync(path.join(change, 'business-map.json'), bytes);
  const restored = validateSpec(repo, 'report-notifications');
  assert.equal(restored.ready_for_eval_design, true, JSON.stringify(restored.errors));
  assert.equal(frozenSpec(repo, 'report-notifications').handoff.id, exported.id);
  assert.equal(exportSpec(repo, 'report-notifications').id, exported.id);
  const impactFile = path.join(change, 'impact.md');
  const impact = (flow) => writeFileSync(impactFile, `---\ngenesis_impact: 1\nentries:\n  - flow: ${flow}\n    entry: POST /reports\n    effect: changes\n    evidence: openspec/changes/report-notifications/genesis.json\n---\n`);
  impact('flow_unknown');
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /impact\.md: entries\[0\] flow is not in the recorded Map: flow_unknown/);
  impact('flow_submit');
  assert.doesNotMatch(validateSpec(repo, 'report-notifications').warnings.join('\n'), /not in the recorded Map/);
  rmSync(impactFile);
  rmSync(path.join(change, 'business-map.json'));

  // Another clone: Genesis's output is not there.
  rmSync(path.join(repo, '.genesis/out'), { recursive: true });
  const missing = gapOf(validateSpec(repo, 'report-notifications').gaps, 'map_unavailable');
  assertGapShape(missing, { owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/business-map.json', digest: context.map.sha256 });
  assert.match(missing.message, /^genesis\.json records the Map at \.genesis\/out\/ses_1\/business-map\.json, which this checkout does not have \(Genesis keeps its output out of Git\), and openspec\/changes\/report-notifications\/business-map\.json is missing too\. A clone reads the Map from openspec\/changes\/report-notifications\/business-map\.json; its digest is sha256:/);

  // The copy stands in without touching genesis.json, so the export still matches.
  writeFileSync(path.join(change, 'business-map.json'), bytes);
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.ready_for_eval_design, true, JSON.stringify(result.errors));
  assert.equal(exportSpec(repo, 'report-notifications').id, exported.id);
  assert.match(result.warnings.join('\n'), /genesis\.json records the Map at \.genesis\/out\/ses_1\/business-map\.json; openspec\/changes\/report-notifications\/business-map\.json has the recorded digest and is used, as on other clones\./);
  writeFileSync(path.join(change, 'business-map.json'), '{}');
  assert.ok(gapOf(validateSpec(repo, 'report-notifications').gaps, 'map_changed'));
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

test('legacy migration keeps an edited legacy skill or destination as it is and lists it, and a differing schema stops init before it writes', (t) => {
  const files = {
    skill: '.claude/skills/genesis-spec/SKILL.md',
    extra: '.claude/skills/genesis-spec/custom.md',
    destination: '.claude/skills/agent-spec/SKILL.md',
  };
  for (const target of Object.keys(files)) {
    const { repo } = legacyInstallation(t);
    const custom = path.join(repo, files[target]);
    mkdirSync(path.dirname(custom), { recursive: true });
    writeFileSync(custom, 'User customization\n');
    const result = initProject(repo, 'new', 'both');
    assert.equal(readFileSync(custom, 'utf8'), 'User customization\n', target);
    const conflict = result.conflicts.find((entry) => entry.file === files[target]);
    assert.ok(conflict, `${target}: ${JSON.stringify(result.conflicts)}`);
    assert.equal(conflict.installed, sha256('User customization\n'));
    assert.match(result.warnings.join('\n'), new RegExp(`left as (it is|they are): .*${files[target].replaceAll('.', '\\.')}`), target);
    // The untouched installation is migrated; the edited one is not.
    assert.equal(existsSync(path.join(repo, '.agents/skills/genesis-spec')), false, target);
    assert.equal(existsSync(path.join(repo, '.agents/skills/agent-spec/SKILL.md')), true, target);
    assert.deepEqual(result.migrated, target === 'destination' ? ['.agents/skills/genesis-spec', '.claude/skills/genesis-spec'] : ['.agents/skills/genesis-spec'], target);
    assert.equal(existsSync(path.join(repo, '.claude/skills/genesis-spec/SKILL.md')), target !== 'destination', target);
  }
  // A file that is not a skill file, such as the schema, still stops init
  // before anything is written.
  const { repo, schema } = legacyInstallation(t);
  writeFileSync(schema, 'User customization\n');
  assert.throws(() => initProject(repo, 'new', 'both'), /Existing file differs; left unchanged/);
  assert.equal(readFileSync(schema, 'utf8'), 'User customization\n');
  assert.equal(existsSync(path.join(repo, '.agents/skills/agent-spec')), false);
  assert.equal(existsSync(path.join(repo, '.agents/skills/genesis-spec/SKILL.md')), true);
  assert.equal(existsSync(path.join(repo, '.claude/skills/genesis-spec/SKILL.md')), true);
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
  assert.deepEqual(result.conflicts, []);
  assert.equal(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), readFileSync(path.join(ROOT, 'skills/agent-spec/SKILL.md'), 'utf8'));
  assert.deepEqual(initProject(repo, 'new', 'claude').updated, []);
  // An edited skill file stays as the project left it, and init lists it with
  // both digests while it installs everything else.
  const edited = `${previous}\nTeam note\n`;
  writeFileSync(path.join(skill, 'SKILL.md'), edited);
  rmSync(path.join(skill, 'references/spec-format.md'));
  const again = initProject(repo, 'new', 'claude');
  assert.deepEqual(again.conflicts, [{
    file: '.claude/skills/agent-spec/SKILL.md', installed: sha256(edited), shipped: sha256(readFileSync(path.join(ROOT, 'skills/agent-spec/SKILL.md'), 'utf8')), skill: 'agent-spec',
  }]);
  assert.deepEqual(again.created, ['.claude/skills/agent-spec/references/spec-format.md']);
  assert.match(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /Team note/);
  assert.ok(again.warnings.includes('An installed skill file differs from what this release ships and was left as it is: .claude/skills/agent-spec/SKILL.md. Every other file is installed. A skill\'s LOCAL.md is the project\'s own place for additions; init never writes it.'), JSON.stringify(again.warnings));
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

test('spec validate and spec export do not touch .genesis, so a symlinked .genesis does not block them', (t) => {
  const repo = project(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(repo, '.genesis'), 'dir');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  const result = validateSpec(repo, 'report-notifications');
  assert.equal(result.ready_for_eval_design, true, JSON.stringify(result.errors));
  // The CLI reads the loop's phase before an export; no loop is not a refusal.
  const response = spawnSync(process.execPath, [CLI, 'spec', 'export', 'report-notifications', '--repo', repo], { encoding: 'utf8' });
  assert.equal(response.status, 0, response.stderr);
  const exported = JSON.parse(response.stdout);
  assert.equal(exported.ends_loop, false);
  assert.equal(frozenSpec(repo, 'report-notifications').handoff.id, exported.id);
  assert.deepEqual(readdirSync(outside), []);
});

test('workflow status reports a symlinked .genesis as a gap and still gives the Spec layer', (t) => {
  useFakeTools(t);
  const repo = project(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(repo, '.genesis'), 'dir');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  // workflow status is read-only and always exits 0.
  const response = spawnSync(process.execPath, [CLI, 'workflow', 'status', 'report-notifications', '--repo', repo], { encoding: 'utf8' });
  assert.equal(response.status, 0, response.stderr);
  const status = JSON.parse(response.stdout);
  assert.equal(status.layers.spec.draft.ready_for_export, true);
  assert.ok(status.gaps.some((gap) => /symbolic link|symlink/.test(gap.message)), JSON.stringify(status.gaps));
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

test('workflow status names what is missing, layer by layer, without creating it or asking the user for a decision', (t) => {
  useFakeTools(t);
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-inputs-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  let result = workflowStatus(repo, 'report-notifications');
  assertGapShape(result.gaps[0], { code: 'project_uninitialized', owner: 'agent', layer: 'machine' });
  assert.deepEqual(result.actions.map((entry) => entry.command[0]), ['init']);
  assert.equal(existsSync(path.join(repo, 'openspec')), false);
  initProject(repo, 'new', 'none');
  result = workflowStatus(repo, 'report-notifications');
  assertGapShape(result.layers.spec.gaps[0], { code: 'change_missing', owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/' });
  assert.equal(actionOf(result, 'spec', 'new').allowed, true);
  assert.equal(actionOf(result, 'spec', 'import', '--handoff').allowed, true);
  assert.equal(actionOf(result, 'spec', 'export'), undefined);
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications')), false);
  newSpec(repo, 'report-notifications');
  result = workflowStatus(repo, 'report-notifications');
  assertGapShape(gapOf(result.layers.spec.gaps, 'spec_missing'), { kind: 'artifact', owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/specs/' });
  assert.deepEqual(actionOf(result, 'spec', 'export').blocked_by, ['spec_missing']);
  writeSpec(repo);
  result = workflowStatus(repo, 'report-notifications');
  // Not exported yet is the only Spec gap left, and the export is allowed.
  assert.deepEqual(result.layers.spec.gaps.map((gap) => gap.code), ['handoff_missing']);
  assert.equal(result.layers.spec.draft.ready_for_export, true);
  assert.equal(actionOf(result, 'spec', 'export').allowed, true);
  // Nothing here is the user's to decide.
  assert.ok(result.layers.spec.gaps.every((gap) => gap.owner === 'agent'));
  for (const gap of result.gaps) assertGapShape(gap);
  assertNoRoutes(result.gaps, 'gaps');
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
});

test('business blockers name the requirements and questions and are the user\'s; technical problems are the agent\'s; no file is edited', (t) => {
  useFakeTools(t);
  const content = fixture.replace('state: explicit', 'state: proposed')
    .replace('open_questions: []', 'open_questions: ["Should a successful retry send a notification?"]');
  const { repo, file } = authored(t, content);
  let result = validateSpec(repo, 'report-notifications');
  assert.equal(result.valid, true);
  assert.equal(result.ready_for_eval_design, false);
  assertGapShape(gapOf(result.gaps, 'requirements_all_excluded'), { kind: 'business', owner: 'user', layer: 'spec', requirement_ids: ['REQ-submit-failure'] });
  // A question that names no requirement holds back the whole export.
  assertGapShape(gapOf(result.gaps, 'business_question'), { kind: 'business', owner: 'user', layer: 'spec', question: 'Should a successful retry send a notification?' });
  assert.deepEqual(result.excluded.map((entry) => [entry.requirement, entry.reason]), [['REQ-submit-failure', 'proposed']]);
  writeFileSync(file, content.replace('source: request', 'source: missing'));
  result = validateSpec(repo, 'report-notifications');
  assertGapShape(result.gaps.find((gap) => gap.kind === 'technical'), { code: 'spec_invalid', owner: 'agent', layer: 'spec' });
  assert.ok(result.gaps.filter((gap) => gap.kind === 'business').every((gap) => gap.owner === 'user'));
  assert.ok(result.gaps.some((gap) => gap.kind === 'business'));
  // workflow status lists every gap that refuses the export; which to take
  // first is the agent's choice.
  const blocked = actionOf(workflowStatus(repo, 'report-notifications'), 'spec', 'export');
  assert.equal(blocked.allowed, false);
  assert.deepEqual([...blocked.blocked_by].sort(), ['business_question', 'requirements_all_excluded', 'spec_invalid']);
  assert.equal(readFileSync(file, 'utf8'), content.replace('source: request', 'source: missing'));
});

test('export checks the draft again and refuses with the gaps validation gives, so an earlier check is not a permit', (t) => {
  useFakeTools(t);
  const { repo, file } = authored(t);
  assert.equal(actionOf(workflowStatus(repo, 'report-notifications'), 'spec', 'export').allowed, true);
  writeFileSync(file, fixture.replace('state: explicit', 'state: proposed'));
  const gate = validateSpec(repo, 'report-notifications');
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => {
    assert.equal(error.code, 'SPEC_INPUT_BLOCKED');
    assert.deepEqual(error.gaps, gate.gaps);
    assert.equal('resume' in error, false);
    for (const gap of error.gaps) assertGapShape(gap, { layer: 'spec' });
    return true;
  });
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
});

test('later stages read only the current export: none before the first, the edited draft is drift until exported again, and older exports stay', (t) => {
  const { repo, file } = authored(t);
  let frozen = frozenSpec(repo, 'report-notifications');
  assert.equal(frozen.handoff, undefined);
  assertGapShape(frozen.gaps[0], { code: 'handoff_missing', owner: 'agent', layer: 'spec' });
  const first = exportSpec(repo, 'report-notifications');
  const original = readFileSync(first.file, 'utf8');
  frozen = frozenSpec(repo, 'report-notifications');
  assert.deepEqual(frozen.gaps, []);
  assert.equal(frozen.handoff.id, first.id);
  assert.equal(frozen.source, 'export');
  writeFileSync(file, fixture.replace('revision: 1', 'revision: 2').replace('数量为零', '数量必须为零'));
  frozen = frozenSpec(repo, 'report-notifications');
  assert.equal(frozen.handoff, undefined);
  assertGapShape(frozen.gaps[0], { code: 'handoff_missing', owner: 'agent', layer: 'spec', digest: first.id, changed: ['specs/notifications/spec.md'], added: [], removed: [] });
  assert.deepEqual(exportFacts(repo, 'report-notifications').drift, { changed: ['specs/notifications/spec.md'], added: [], removed: [] });
  assert.equal(readFileSync(first.file, 'utf8'), original);
  const second = exportSpec(repo, 'report-notifications');
  assert.equal(second.previous, first.id);
  assert.equal(frozenSpec(repo, 'report-notifications').handoff.id, second.id);
  assert.equal(specStatus(repo, 'report-notifications').export.id, second.id);
  assert.equal(readFileSync(first.file, 'utf8'), original);
});

test('tampered handoffs and manually supplied readiness flags cannot pass the gate', (t) => {
  const { repo } = authored(t);
  const handoff = exportSpec(repo, 'report-notifications');
  const tampered = { ...readJSON(handoff.file), ready_for_eval_design: true, status: 'completed', specs: [] };
  writeFileSync(handoff.file, JSON.stringify(tampered));
  const frozen = frozenSpec(repo, 'report-notifications');
  assert.equal(frozen.handoff, undefined);
  assertGapShape(frozen.gaps[0], { code: 'handoff_invalid', owner: 'agent', layer: 'spec', digest: handoff.id });
  const status = statusOf(t, repo);
  assert.equal(status.layers.spec.export_holds, false);
  assert.ok(gapOf(status.layers.spec.gaps, 'handoff_invalid'), JSON.stringify(status.layers.spec.gaps));
  assert.throws(() => exportSpec(repo, 'report-notifications'), (error) => error.code === 'HANDOFF_INVALID');
  assert.deepEqual(readJSON(handoff.file), tampered);
});

test('broken context and changed Map snapshots are technical gaps of the agent, never questions for the user', (t) => {
  const repo = project(t, 'existing');
  const map = path.join(repo, 'map.json');
  writeFileSync(map, JSON.stringify({ snapshot_id: 'original', analysis_status: 'partial' }));
  newSpec(repo, 'report-notifications', { map });
  writeSpec(repo);
  writeFileSync(path.join(repo, 'openspec/changes/report-notifications/business-map.json'), JSON.stringify({ snapshot_id: 'changed', analysis_status: 'complete' }));
  let result = validateSpec(repo, 'report-notifications');
  assertGapShape(gapOf(result.gaps, 'map_changed'), { kind: 'technical', owner: 'agent', layer: 'spec' });
  assert.ok(result.gaps.every((gap) => gap.owner === 'agent'), JSON.stringify(result.gaps));
  const context = path.join(repo, 'openspec/changes/report-notifications/genesis.json');
  for (const [content, code] of [['{broken', 'context_unavailable'], ['null', 'context_invalid']]) {
    writeFileSync(context, content);
    result = validateSpec(repo, 'report-notifications');
    assertGapShape(result.gaps[0], { code, kind: 'technical', owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/genesis.json' });
    assert.equal(result.blockers.length, 0);
  }
});

test('a change folder spec new left unfinished is named as such, never deleted, and can be adopted instead', (t) => {
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
  const advice = (name) => `openspec/changes/${name}/ has no genesis.json and nothing in it is in Git: an earlier \`spec new\` stopped before it finished, so no code or Map context was recorded. The folder holds only what spec new writes, so deleting it loses nothing; \`spec new --adopt\` records the context for it instead.`;
  const folder = interrupted('report-notifications', true);
  assert.throws(() => newSpec(repo, 'report-notifications'), (error) => {
    assert.equal(error.message, advice('report-notifications'));
    assert.equal(error.code, 'SPEC_CHANGE_EXISTS');
    assertGapShape(error.gaps[0], { code: 'change_unfinished', owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/' });
    return true;
  });
  const check = validateSpec(repo, 'report-notifications');
  assertGapShape(check.gaps[0], { code: 'context_unavailable', owner: 'agent', layer: 'spec', message: advice('report-notifications') });
  assert.ok(existsSync(path.join(folder, '.openspec.yaml')));
  rmSync(folder, { recursive: true });
  assert.equal(newSpec(repo, 'report-notifications').context.map.status, 'missing');
  // Adopting such a folder records the context and keeps what OpenSpec wrote.
  const later = interrupted('later');
  const metadata = readFileSync(path.join(later, '.openspec.yaml'), 'utf8');
  const adopted = newSpec(repo, 'later', { adopt: true });
  assert.equal(adopted.adopted, true);
  assert.equal(readJSON(path.join(later, 'genesis.json')).project_mode, 'existing');
  assert.equal(readFileSync(path.join(later, '.openspec.yaml'), 'utf8'), metadata);

  // Anything committed, or authored, is not an unfinished spec new.
  const exists = (name) => (error) => {
    assert.equal(error.code, 'SPEC_CHANGE_EXISTS');
    assert.equal(error.message, `openspec/changes/${name}/ already exists. \`spec new --adopt\` adds the Genesis record to it and leaves its files as they are.`);
    assertGapShape(error.gaps[0], { code: 'change_exists', owner: 'agent', layer: 'spec' });
    return true;
  };
  const committed = interrupted('committed');
  git('add', '--', 'openspec/changes/committed');
  git('commit', '-q', '-m', 'Half a change');
  assert.throws(() => newSpec(repo, 'committed'), exists('committed'));
  assert.match(validateSpec(repo, 'committed').gaps[0].message, /^genesis\.json of the change cannot be read \(.*\)\. It records the code and the Map the Spec was written against, which only spec new records\.$/);
  const authored = interrupted('authored');
  writeSpec(repo, fixture, 'authored');
  assert.throws(() => newSpec(repo, 'authored'), exists('authored'));
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
  assert.match(validateSpec(repo, 'report-notifications').warnings.join('\n'), /\.genesis\/out\/ses_1\/business-map\.json is ignored by Git, so other clones cannot check this Spec against its Map\. A clone reads the copy at openspec\/changes\/report-notifications\/business-map\.json\./);

  // A committed copy clears it.
  const copy = path.join(change, 'business-map.json');
  writeFileSync(copy, readFileSync(original));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Commit the Map copy']);
  const fixed = validateSpec(repo, 'report-notifications');
  assert.equal(fixed.ready_for_eval_design, true, JSON.stringify(fixed.errors));
  assert.doesNotMatch(fixed.warnings.join('\n'), /Git/);
  assert.equal(frozenSpec(repo, 'report-notifications').handoff.id, exported.id);

  // A wrong copy fails here as it would on any clone, though the recorded file still matches.
  writeFileSync(copy, JSON.stringify({ snapshot_id: 'sha256:later', analysis_status: 'complete' }));
  const wrong = gapOf(validateSpec(repo, 'report-notifications').gaps, 'map_changed');
  assertGapShape(wrong, { owner: 'agent', layer: 'spec', path: 'openspec/changes/report-notifications/business-map.json' });
  assert.match(wrong.message, /^The Map openspec\/changes\/report-notifications\/business-map\.json no longer has the digest genesis\.json records, sha256:[0-9a-f]{64}\./);
});

test('CLI: workflow status exits 0 and names the user\'s decision; once the user decides, the export it lists succeeds', (t) => {
  useFakeTools(t);
  const proposed = fixture.replace('state: explicit', 'state: proposed');
  const { repo, file } = authored(t, proposed);
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let response = run(['workflow', 'status', 'report-notifications', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const blocked = JSON.parse(response.stdout);
  assertGapShape(gapOf(blocked.layers.spec.gaps, 'requirements_all_excluded'), { owner: 'user', layer: 'spec' });
  assert.deepEqual(actionOf(blocked, 'spec', 'export').blocked_by, ['requirements_all_excluded']);
  // The earlier stage form reads the same status; the stage does nothing.
  response = run(['workflow', 'check', 'spec-export', 'report-notifications', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const staged = JSON.parse(response.stdout);
  assert.equal(staged.stage_ignored, 'spec-export');
  assert.deepEqual(staged.gaps, blocked.gaps);
  // The user's decision is recorded in the Spec, with who and where.
  const confirmed = fixture.replace('state: explicit', 'state: confirmed\n    confirmation:\n      by: Example user\n      ref: example:approval-message');
  writeFileSync(file, confirmed);
  response = run(['workflow', 'status', 'report-notifications', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const action = actionOf(JSON.parse(response.stdout), 'spec', 'export');
  assert.equal(action.allowed, true);
  response = run(action.command);
  assert.equal(response.status, 0, response.stderr);
  const exported = JSON.parse(response.stdout);
  assert.equal(readJSON(exported.file).specs[0].content, confirmed);
  assert.deepEqual(exported.must_show.requirements[0].confirmation, { by: 'Example user', ref: 'example:approval-message' });
  writeFileSync(file, proposed);
  response = run(action.command);
  assert.equal(response.status, 1);
  const refusal = JSON.parse(response.stderr);
  assert.equal(refusal.code, 'SPEC_INPUT_BLOCKED');
  assert.equal(refusal.gaps[0].code, 'requirements_all_excluded');
});

test('the stage commands of earlier releases read the workflow status, exit 0 and run nothing', (t) => {
  useFakeTools(t);
  const { repo } = authored(t);
  for (const stage of ['write-eval', 'loop-and-implement']) {
    const result = checkWorkflow(repo, stage, 'report-notifications');
    assert.equal(result.stage_ignored, stage);
    assert.equal(result.schema, 'genesis-edd.workflow-status/1');
    const response = spawnSync(process.execPath, [CLI, stage, 'report-notifications', '--repo', repo], { encoding: 'utf8' });
    assert.equal(response.status, 0, response.stderr);
    const diagnostic = JSON.parse(response.stdout);
    assert.equal(diagnostic.stage_ignored, stage);
    assert.deepEqual(diagnostic.gaps, result.gaps);
    assert.deepEqual(diagnostic.actions, result.actions);
    assertNoRoutes(diagnostic.gaps, 'gaps');
  }
  assert.equal(existsSync(path.join(repo, 'openspec/changes/report-notifications/handoffs')), false);
  // A stage name is no longer read, so an unknown one is ignored too.
  assert.equal(checkWorkflow(repo, 'unknown', 'report-notifications').stage_ignored, 'unknown');
  assert.throws(() => checkWorkflow(repo, 'spec-export', '../escape'), /kebab-case/);
});

test('a project whose Spec schema is missing, as in a clone committed without openspec/schemas/, is told that init writes it again, which restores it', (t) => {
  const repo = project(t, 'existing');
  newSpec(repo, 'report-notifications');
  writeSpec(repo);
  rmSync(path.join(repo, 'openspec/schemas'), { recursive: true, force: true });
  const gap = gapOf(validateSpec(repo, 'report-notifications').gaps, 'project_invalid');
  assertGapShape(gap, { owner: 'agent', layer: 'spec' });
  assert.ok(gap.message.startsWith(`openspec/schemas/${SCHEMA}/ is missing, so OpenSpec cannot read this project's Specs. \`init --mode existing --agent none\` writes the schema again without changing other files or installing skills`), gap.message);
  const status = statusOf(t, repo);
  assert.equal(status.gaps[0].message, gap.message);
  assert.deepEqual(status.actions.map((entry) => entry.command[0]), ['init']);
  assert.throws(() => newSpec(repo, 'another-change'), /openspec\/schemas\/genesis-spec\/ is missing/);

  initProject(repo, 'existing', 'none');
  assert.ok(existsSync(path.join(repo, `openspec/schemas/${SCHEMA}/schema.yaml`)));
  assert.equal(validateSpec(repo, 'report-notifications').valid, true);
});
