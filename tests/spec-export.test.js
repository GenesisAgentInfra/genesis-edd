// The Spec module's newer behaviour: the text Genesis reads between the
// frontmatter and the first section, steps a reader would take as part of a
// scenario, what the user is shown at export, open questions that hold back
// single requirements, the .dockerignore note, spec import, spec new --adopt,
// spec remap, an export that ends a running loop, the skill launchers and
// the CLI's version.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, SKILLS, initProject, openspec, projectRoot, readJSON } from '../src/project.js';
import { exportSpec, frozenSpec, importSpec, newSpec, remapSpec, specStatus, validateSpec } from '../src/spec.js';
import { workflowStatus } from '../src/workflow.js';
import { loopStatus } from '../src/loop.js';
import { SPECS, actionOf, assertGapShape, assertNoRoutes, cli, useFakeTools, writeSpec as writeLoopSpec } from './helpers/edd.js';
import { inLoop } from './helpers/loop.js';

const NAME = 'report-notifications';
const CLI = path.join(ROOT, 'bin/genesis-edd.js');
const { version: VERSION } = readJSON(path.join(ROOT, 'package.json'));
const fixture = readFileSync(path.join(ROOT, 'examples/report-notifications/spec.md'), 'utf8');
const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const gapOf = (gaps, code) => (gaps ?? []).find((gap) => gap.code === code);
const codes = (gaps) => (gaps ?? []).map((gap) => gap.code);

function project(t, mode = 'new', agent = 'none') {
  const repo = projectRoot(mkdtempSync(path.join(os.tmpdir(), 'genesis-edd-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  initProject(repo, mode, agent);
  return repo;
}
function writeSpec(repo, content = fixture, change = NAME, capability = 'notifications') {
  const file = path.join(repo, 'openspec/changes', change, 'specs', capability, 'spec.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
function authored(t, content = fixture) {
  const repo = project(t);
  newSpec(repo, NAME);
  const file = writeSpec(repo, content);
  return { repo, file };
}
function scratch(t, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The example with a second requirement, under its own quoted source, whose
// scenario has GIVEN, WHEN and THEN lines.
const TWO = `${fixture
  .replace('requirements:', '  success:\n    kind: user\n    ref: "example:report-notifications/success"\n    quote: "报告内容完整且提交成功时，发送一条成功通知。"\nrequirements:')
  .replace('    state: explicit', '    state: explicit\n  REQ-submit-success:\n    source: success\n    state: explicit')}
### Requirement: REQ-submit-success 提交成功时发送成功通知

系统 MUST 在报告提交成功时发送成功通知。

#### Scenario: 提交成功

- **GIVEN** 报告内容完整
- **AND** 提交服务可用
- **WHEN** 报告提交返回成功
- **THEN** 本次提交发送的成功通知数量为一
- **AND** 不发送失败通知
`;
const THEN = '- **THEN** 本次提交发送的成功通知数量为零';

test('between the frontmatter and the first section only one title, HTML comments and blank lines may stand; other text there blocks the export with its line and text', (t) => {
  const { repo, file } = authored(t);
  const title = '# 报告提交通知';
  // A title and a comment, even one over several lines, are allowed.
  writeFileSync(file, fixture.replace(title, `${title}\n\n<!-- Written with the user.\nThe system MUST email everyone. -->\n`));
  assert.equal(validateSpec(repo, NAME).valid, true);
  writeFileSync(file, fixture.replace(`${title}\n`, ''));
  assert.equal(validateSpec(repo, NAME).valid, true);
  for (const [label, content, line, text] of [
    ['prose after the title', fixture.replace(title, `${title}\n\nThe system MUST also email every administrator.`), 18, 'The system MUST also email every administrator.'],
    ['prose without a title', fixture.replace(`${title}\n`, 'Some prose.\n'), 16, 'Some prose.'],
    ['a second title', fixture.replace(title, `${title}\n# Another title`), 17, '# Another title'],
  ]) {
    writeFileSync(file, content);
    const result = validateSpec(repo, NAME);
    assert.equal(result.valid, false, label);
    const gap = assertGapShape(gapOf(result.gaps, 'spec_format_invalid'), { owner: 'agent', layer: 'spec', path: 'specs/notifications/spec.md', line, text });
    assert.equal(gap.message, `specs/notifications/spec.md:${line}: text between the frontmatter and the first "## " section belongs to no requirement, so it never becomes a check, and archive would drop it: ${JSON.stringify(text)}. Move it into a requirement, or into proposal.md or design.md.`);
    // Genesis's own finding stands in for OpenSpec's, which names only line 1.
    assert.deepEqual(result.openspec_advisory_issues, [], label);
    assert.doesNotMatch(result.warnings.join('\n'), /frontmatter on line 1/, label);
    assert.throws(() => exportSpec(repo, NAME), (error) => codes(error.gaps).includes('spec_format_invalid'), label);
  }
  assert.equal(existsSync(path.join(repo, 'openspec/changes', NAME, 'handoffs')), false);
});

test('with only the frontmatter above the first section, the raw OpenSpec result fails the change, and Genesis says so in a warning and exports', (t) => {
  const { repo } = authored(t);
  const result = validateSpec(repo, NAME);
  assert.equal(result.valid, true);
  assert.equal(result.ready_for_eval_design, true);
  assert.ok(result.warnings.includes('OpenSpec strict counts the Genesis frontmatter on line 1 of specs/notifications/spec.md as text above the first "## " section, which archive would drop. Genesis keeps the frontmatter in the handoff, so the raw OpenSpec result under openspec shows valid: false and failed: 1 for any change with a Genesis spec file. Nothing needs moving.'), JSON.stringify(result.warnings));
  assert.equal(result.openspec.items[0].valid, false);
  assert.equal(result.openspec.summary.totals.failed, 1);
  assert.deepEqual(result.openspec_advisory_issues.map((issue) => [issue.level, issue.line]), [['WARNING', 1]]);
  assert.deepEqual(codes(result.gaps), []);
  const exported = exportSpec(repo, NAME);
  assert.match(exported.must_show.warnings.join('\n'), /frontmatter on line 1/);
});

test('a line a reader would take as a step is never left out of the export unnoticed', (t) => {
  const { repo, file } = authored(t);
  const where = { owner: 'agent', layer: 'spec', path: 'specs/notifications/spec.md', requirement_id: 'REQ-submit-failure' };
  for (const [label, content, line, message] of [
    ['a list item without bold', fixture.replace(THEN, `${THEN}\n- THEN 不发送失败通知`), 32, '"- THEN 不发送失败通知" reads as a THEN step but is not written `- **THEN** text`, so it is not part of scenario "提交失败"'],
    ['a keyword and a colon', fixture.replace(THEN, `${THEN}\nThen: 不发送失败通知`), 32, '"Then: 不发送失败通知" reads as a THEN step but is not written `- **THEN** text`, so it is not part of scenario "提交失败"'],
    ['bold outside a list', fixture.replace(THEN, `${THEN}\n\n**AND** 不发送失败通知`), 33, '"**AND** 不发送失败通知" reads as a AND step but is not written `- **AND** text`, so it is not part of scenario "提交失败"'],
    ['an AND before any step', fixture.replace('- **WHEN** 报告提交返回失败', '- **AND** 报告已保存\n- **WHEN** 报告提交返回失败'), 30, '"- **AND** 报告已保存" is an AND step before any GIVEN, WHEN or THEN step, so it belongs to none'],
    ['a step outside every scenario', fixture.replace('#### Scenario: 提交失败', '- **THEN** 不发送失败通知\n\n#### Scenario: 提交失败'), 28, '"- **THEN** 不发送失败通知" is a THEN step outside any scenario, so no scenario holds it'],
  ]) {
    writeFileSync(file, content);
    const result = validateSpec(repo, NAME);
    assert.equal(result.valid, false, label);
    const gap = assertGapShape(gapOf(result.gaps, 'step_malformed'), { ...where, line });
    assert.equal(gap.message, `specs/notifications/spec.md:${line}: ${message}.`, label);
    assert.throws(() => exportSpec(repo, NAME), (error) => codes(error.gaps).includes('step_malformed'), label);
  }
  // Text in a fenced block, and prose that only uses the word, are not steps.
  writeFileSync(file, fixture.replace(THEN, `${THEN}\n\n\`\`\`\n- THEN 示例\n\`\`\`\n\nthen the report is kept as it was.`));
  assert.deepEqual(codes(validateSpec(repo, NAME).gaps), []);
  // In a requirement no export holds, the same line is a warning.
  writeFileSync(file, fixture.replace('state: explicit', 'state: proposed').replace(THEN, `${THEN}\n- THEN 不发送失败通知`));
  const draft = validateSpec(repo, NAME);
  assert.equal(gapOf(draft.gaps, 'step_malformed'), undefined);
  assert.match(draft.warnings.join('\n'), /"- THEN 不发送失败通知" reads as a THEN step/);
  // Every step written as one reaches the handoff.
  writeFileSync(file, TWO);
  const handoff = readJSON(exportSpec(repo, NAME).file);
  assert.deepEqual(handoff.requirements.map((requirement) => requirement.scenarios.map(({ given, when, then }) => [given, when, then])), [
    [[[], ['报告提交返回失败'], ['本次提交发送的成功通知数量为零']]],
    [[['报告内容完整', '提交服务可用'], ['报告提交返回成功'], ['本次提交发送的成功通知数量为一', '不发送失败通知']]],
  ]);
});

test('a scenario without a trigger or an outcome, or a requirement without a scenario, is named with what it lacks', (t) => {
  const { repo, file } = authored(t);
  const scenarioAt = { owner: 'agent', layer: 'spec', path: 'specs/notifications/spec.md', line: 28, requirement_id: 'REQ-submit-failure', scenario: '提交失败' };
  for (const [content, lacks] of [
    [fixture.replace('- **WHEN** 报告提交返回失败\n', ''), 'a GIVEN or WHEN step'],
    [fixture.replace(THEN, ''), 'a THEN step'],
    [fixture.replace('- **WHEN** 报告提交返回失败\n', '').replace(THEN, 'Only a note.'), 'a GIVEN or WHEN step and a THEN step'],
  ]) {
    writeFileSync(file, content);
    const gap = assertGapShape(gapOf(validateSpec(repo, NAME).gaps, 'scenario_incomplete'), scenarioAt);
    assert.equal(gap.message, `specs/notifications/spec.md:28: scenario "提交失败" of REQ-submit-failure lacks ${lacks}.`);
  }
  writeFileSync(file, fixture.replace(/#### Scenario:[\s\S]*$/, ''));
  assertGapShape(gapOf(validateSpec(repo, NAME).gaps, 'scenario_missing'), {
    owner: 'agent', layer: 'spec', line: 24, requirement_id: 'REQ-submit-failure', message: 'specs/notifications/spec.md:24: REQ-submit-failure has no scenario.',
  });
  // A GIVEN is a trigger too.
  writeFileSync(file, fixture.replace('- **WHEN** 报告提交返回失败', '- **GIVEN** 报告提交返回失败'));
  assert.equal(validateSpec(repo, NAME).valid, true);
});

test('spec export shows the user each requirement with its source and every scenario\'s name and GIVEN, WHEN and THEN lines', (t) => {
  const { repo, file } = authored(t, TWO.replace('  REQ-submit-success:\n    source: success\n    state: explicit',
    '  REQ-submit-success:\n    source: success\n    state: confirmed\n    confirmation:\n      by: Example user\n      ref: example:approval-message'));
  const exported = exportSpec(repo, NAME);
  const success = {
    requirement: 'REQ-submit-success', name: '提交成功时发送成功通知', state: 'confirmed', kind: 'user', source: 'success',
    quote: '报告内容完整且提交成功时，发送一条成功通知。', confirmation: { by: 'Example user', ref: 'example:approval-message' },
    statement: '系统 MUST 在报告提交成功时发送成功通知。', outcomes: ['本次提交发送的成功通知数量为一', '不发送失败通知'],
    scenarios: [{ name: '提交成功', given: ['报告内容完整', '提交服务可用'], when: ['报告提交返回成功'], then: ['本次提交发送的成功通知数量为一', '不发送失败通知'] }],
  };
  assert.deepEqual(exported.must_show.requirements[1], success);
  assert.deepEqual(exported.must_show.requirements[0].scenarios, [{ name: '提交失败', given: [], when: ['报告提交返回失败'], then: ['本次提交发送的成功通知数量为零'] }]);
  // The scenarios shown are those the handoff holds, and the review lists them too.
  const handoff = readJSON(exported.file);
  assert.deepEqual(exported.must_show.requirements.map((requirement) => requirement.scenarios), handoff.requirements.map((requirement) => requirement.scenarios));
  assert.deepEqual(exported.review.map((requirement) => requirement.scenarios), handoff.requirements.map((requirement) => requirement.scenarios));
  assert.deepEqual(exported.must_show.excluded, []);
  assert.equal('loop_ended' in exported.must_show, false);
  assertNoRoutes(exported);
  // Exporting the same draft again writes nothing and shows the same.
  const again = exportSpec(repo, NAME);
  assert.equal(again.unchanged, true);
  assert.deepEqual(again.must_show.requirements, exported.must_show.requirements);
  assert.equal(readFileSync(file, 'utf8').includes('state: confirmed'), true);
});

test('an open question that names requirements holds back only those, and the export lists them with the questions', (t) => {
  const { repo, file } = authored(t);
  const asked = 'Does a retried submission count as one?';
  for (const questions of [
    `[{ question: "${asked}", requirements: [REQ-submit-success] }]`,
    `[{ question: "${asked}", requirement: REQ-submit-success }]`,
    `["Does REQ-submit-success hold for retries?"]`,
  ]) {
    writeFileSync(file, TWO.replace('open_questions: []', `open_questions: ${questions}`));
    const result = validateSpec(repo, NAME);
    assert.equal(result.ready_for_eval_design, true, JSON.stringify(result.gaps));
    assert.equal(gapOf(result.gaps, 'business_question'), undefined);
    assert.deepEqual(result.excluded.map(({ requirement, state, reason }) => [requirement, state, reason]), [['REQ-submit-success', 'explicit', 'open_question']]);
  }
  const exported = exportSpec(repo, NAME);
  const handoff = readJSON(exported.file);
  assert.deepEqual(handoff.requirements.map((requirement) => requirement.id), ['REQ-submit-failure']);
  assert.deepEqual(handoff.excluded, [{
    requirement: 'REQ-submit-success', name: '提交成功时发送成功通知', path: 'specs/notifications/spec.md', state: 'explicit', reason: 'open_question', questions: ['Does REQ-submit-success hold for retries?'],
  }]);
  assert.deepEqual(exported.must_show.excluded, handoff.excluded);
  // A question that names a requirement the change does not have is invalid.
  writeFileSync(file, TWO.replace('open_questions: []', `open_questions: [{ question: "${asked}", requirements: [REQ-unknown] }]`));
  const unknown = gapOf(validateSpec(repo, NAME).gaps, 'spec_invalid');
  assertGapShape(unknown, { owner: 'agent', layer: 'spec', requirement_ids: ['REQ-unknown'] });
  assert.match(unknown.message, /an open question names requirements the change does not have: REQ-unknown\./);
});

test('spec new warns when .dockerignore has no .genesis line, and not when it has one', (t) => {
  const repo = project(t, 'existing');
  const warning = 'The code recorded for this change includes .dockerignore, and it has no .genesis line. An eval package that builds from the project root needs one, so expected results stay out of the image; added after this point, it shows at confirmation as a code change before the baseline. Its other lines are the user\'s call.';
  const noted = (name) => newSpec(repo, name).warnings.includes(warning);
  assert.equal(noted('no-file'), true);
  for (const [name, content, expected] of [
    ['plain', '.genesis\n', false], ['rooted', 'node_modules\n/.genesis/\n', false], ['all-below', '.genesis/**\n', false], ['crlf', 'dist\r\n.genesis\r\n', false],
    ['similar-name', '.genesis-old\n.git\n', true], ['comment', '# .genesis\n', true],
  ]) {
    writeFileSync(path.join(repo, '.dockerignore'), content);
    assert.equal(noted(name), expected, name);
  }
});

test('spec import makes a handoff written elsewhere the current export, checked with Genesis\'s own rules', (t) => {
  const repo = project(t, 'existing');
  newSpec(repo, NAME);
  const recorded = readJSON(path.join(repo, 'openspec/changes', NAME, 'genesis.json'));
  const given = {
    format: 'genesis.spec-handoff', version: 2, change: NAME,
    context: { invented: true },
    requirements: [
      { id: 'REQ-submit-failure', name: 'No success notice on failure', statement: 'The system MUST NOT send a success notice when a submission fails.', state: 'explicit',
        basis: { source: 'issue', kind: 'user', ref: 'issue:42', quote: 'Do not send a success notice when the submission fails.' },
        scenarios: [{ name: 'Submission fails', given: [], when: ['a submission fails'], then: ['no success notice is sent'] }] },
      { id: 'REQ-retry', name: 'Retries are logged', statement: 'Retries are logged.', state: 'proposed',
        basis: { source: 'reading', kind: 'agent', ref: 'agent:reading', quote: 'The agent\'s reading.' },
        scenarios: [{ name: 'A retry', given: [], when: ['a submission is retried'], then: ['the retry is logged'] }] },
    ],
  };
  const file = path.join(scratch(t, 'genesis-edd-import-'), 'from-issue.json');
  writeFileSync(file, JSON.stringify(given));
  const imported = importSpec(repo, NAME, { handoff: file });
  assert.equal(imported.source, 'import');
  assert.equal(imported.exported, true);
  assert.equal(imported.ends_loop, false);
  const handoff = readJSON(imported.file);
  assert.equal(handoff.source, 'import');
  assert.deepEqual(handoff.imported, { file: 'from-issue.json', sha256: sha256(readFileSync(file)) });
  // Proposed requirements are left out and listed, as an export does.
  assert.deepEqual(handoff.requirements.map((requirement) => requirement.id), ['REQ-submit-failure']);
  assert.deepEqual(handoff.excluded.map(({ requirement, reason }) => [requirement, reason]), [['REQ-retry', 'proposed']]);
  assert.deepEqual(imported.must_show.requirements[0].scenarios, given.requirements[0].scenarios);
  // Its own context is ignored: the import records the one spec new recorded.
  assert.deepEqual(handoff.context, recorded);
  assert.match(imported.warnings.join('\n'), /from-issue\.json carries a context; the import records the one Genesis EDD reads from the project instead\./);
  // Later stages read it as the current export.
  assert.equal(frozenSpec(repo, NAME).handoff.id, imported.id);
  assert.equal(specStatus(repo, NAME).export.source, 'import');
  const log = readFileSync(path.join(repo, 'openspec/changes', NAME, 'exports.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(log.map((entry) => [entry.id, entry.source]), [[imported.id, 'import']]);
  // The same file again changes nothing; through the CLI too.
  assert.equal(importSpec(repo, NAME, { handoff: file }).unchanged, true);
  useFakeTools(t);
  const response = cli(['spec', 'import', NAME, '--handoff', file, '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.json.id, imported.id);
  assert.equal(response.json.unchanged, true);
  // A change with no folder yet takes the context of the project as it is.
  writeFileSync(file, JSON.stringify({ ...given, change: 'from-elsewhere', context: undefined }));
  const fresh = importSpec(repo, 'from-elsewhere', { handoff: file });
  assert.equal(readJSON(fresh.file).context.project_mode, 'existing');
  assert.deepEqual(fresh.warnings, []);
});

test('spec import refuses a handoff that breaks Genesis\'s rules, with the gaps it found, and writes nothing', (t) => {
  const repo = project(t);
  newSpec(repo, NAME);
  const requirement = {
    id: 'REQ-submit-failure', name: 'No success notice on failure', statement: 'The system MUST NOT send a success notice when a submission fails.', state: 'explicit',
    basis: { source: 'issue', kind: 'user', ref: 'issue:42', quote: 'Do not send a success notice when the submission fails.' },
    scenarios: [{ name: 'Submission fails', given: [], when: ['a submission fails'], then: ['no success notice is sent'] }],
  };
  const file = path.join(scratch(t, 'genesis-edd-import-'), 'given.json');
  const refused = (given, code, owner = 'agent') => {
    writeFileSync(file, typeof given === 'string' ? given : JSON.stringify(given));
    let found;
    assert.throws(() => importSpec(repo, NAME, { handoff: file }), (error) => {
      assert.equal(error.code, 'SPEC_IMPORT_BLOCKED', code);
      found = assertGapShape(gapOf(error.gaps, code), { owner, layer: 'spec', path: 'given.json' });
      return true;
    }, code);
    return found;
  };
  const handoff = (requirements, extra = {}) => ({ format: 'genesis.spec-handoff', version: 2, requirements, ...extra });
  refused('not json', 'import_invalid');
  refused({ format: 'something-else', requirements: [requirement] }, 'import_invalid');
  refused(handoff([requirement], { change: 'another-change' }), 'import_invalid');
  const incomplete = refused(handoff([{ ...requirement, scenarios: [{ name: 'Submission fails', given: [], when: [], then: ['no success notice is sent'] }] }]), 'scenario_incomplete');
  assert.equal(incomplete.message, 'given.json: REQ-submit-failure scenario 1 lacks a GIVEN or WHEN step.');
  refused(handoff([{ ...requirement, scenarios: [] }]), 'scenario_missing');
  refused(handoff([{ ...requirement, basis: { ...requirement.basis, kind: 'agent' } }]), 'source_invalid');
  refused(handoff([{ ...requirement, state: 'confirmed' }]), 'confirmation_missing');
  refused(handoff([{ ...requirement, id: 'submit-failure' }]), 'requirement_invalid');
  // An open question that names no requirement holds back the import: the user's to answer.
  refused(handoff([requirement], { open_questions: ['Does a retry count as a submission?'] }), 'business_question', 'user');
  refused(handoff([{ ...requirement, state: 'proposed', basis: { ...requirement.basis, kind: 'agent' } }]), 'requirements_all_excluded', 'user');
  assert.equal(existsSync(path.join(repo, 'openspec/changes', NAME, 'handoffs')), false);
  assert.equal(existsSync(path.join(repo, 'openspec/changes', NAME, 'exports.jsonl')), false);
});

test('spec new --adopt adds the Genesis record to an existing OpenSpec change, rewrites none of its files and reads its requirements as the agent\'s proposals', (t) => {
  const repo = project(t, 'existing');
  openspec(repo, ['new', 'change', 'adopted', '--schema', 'spec-driven', '--json']);
  const folder = path.join(repo, 'openspec/changes/adopted');
  const plain = '## ADDED Requirements\n\n### Requirement: Failed submissions send no success notice\n\nThe system SHALL NOT send a success notice when a submission fails.\n\n#### Scenario: Submission fails\n\n- **WHEN** a submission fails\n- **THEN** no success notice is sent\n';
  const file = writeSpec(repo, plain, 'adopted');
  const metadata = readFileSync(path.join(folder, '.openspec.yaml'), 'utf8');
  // spec new refuses the folder and names --adopt.
  assert.throws(() => newSpec(repo, 'adopted'), (error) => error.code === 'SPEC_CHANGE_EXISTS' && gapOf(error.gaps, 'change_exists') !== undefined);
  useFakeTools(t);
  assert.equal(actionOf(workflowStatus(repo, 'adopted'), 'spec', 'new', '--adopt').allowed, true);

  const adopted = newSpec(repo, 'adopted', { adopt: true });
  assert.equal(adopted.adopted, true);
  assert.deepEqual(adopted.files, [{ path: 'specs/notifications/spec.md', sha256: sha256(plain), genesis: false, requirements: ['Failed submissions send no success notice'] }]);
  assert.deepEqual(adopted.warnings, [
    'specs/notifications/spec.md has no Genesis frontmatter, so its requirements are read as the agent\'s proposals (source kind agent, state proposed). No export holds them until their sources and states are written.',
    'The change uses the OpenSpec schema "spec-driven", not genesis-spec. Its files stay as they are; OpenSpec findings that do not change what Genesis reads are warnings.',
  ]);
  const context = readJSON(path.join(folder, 'genesis.json'));
  assert.equal(context.adopted.schema, 'spec-driven');
  assert.deepEqual(context.adopted.files, adopted.files);
  assert.equal(readFileSync(file, 'utf8'), plain);
  assert.equal(readFileSync(path.join(folder, '.openspec.yaml'), 'utf8'), metadata);
  // Its requirements are proposals: no export holds them until the user accepts them.
  const result = validateSpec(repo, 'adopted');
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.excluded.map(({ name, state, reason }) => [name, state, reason]), [['Failed submissions send no success notice', 'proposed', 'proposed']]);
  assert.throws(() => exportSpec(repo, 'adopted'), (error) => {
    assertGapShape(gapOf(error.gaps, 'requirements_all_excluded'), { owner: 'user', layer: 'spec' });
    return true;
  });
  // Once its source and state are written, the adopted change exports.
  writeFileSync(file, fixture);
  assert.equal(exportSpec(repo, 'adopted').must_show.requirements[0].requirement, 'REQ-submit-failure');

  // Refusals, each with its gap.
  const blocked = (name, code) => (error) => {
    assert.equal(error.code, 'SPEC_ADOPT_BLOCKED', name);
    assertGapShape(error.gaps[0], { code, owner: 'agent', layer: 'spec', path: `openspec/changes/${name}/` });
    return true;
  };
  assert.throws(() => newSpec(repo, 'adopted', { adopt: true }), blocked('adopted', 'change_adopted'));
  assert.throws(() => newSpec(repo, 'nothing-here', { adopt: true }), blocked('nothing-here', 'change_missing'));
  mkdirSync(path.join(repo, 'openspec/changes/no-metadata'), { recursive: true });
  assert.throws(() => newSpec(repo, 'no-metadata', { adopt: true }), blocked('no-metadata', 'change_invalid'));
  assert.equal(existsSync(path.join(repo, 'openspec/changes/no-metadata/genesis.json')), false);
});

test('spec remap replaces the Map of a change until its first export, then refuses', (t) => {
  const repo = project(t, 'existing');
  const maps = scratch(t, 'genesis-edd-map-');
  const write = (name, value) => {
    const file = path.join(maps, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const first = write('first.json', { snapshot_id: 'sha256:first', analysis_status: 'partial', mode: 'map' });
  const created = newSpec(repo, NAME, { map: first });
  const second = write('second.json', { snapshot_id: 'sha256:second', analysis_status: 'complete', mode: 'map' });
  const remapped = remapSpec(repo, NAME, { map: second });
  assert.deepEqual(remapped.previous, created.context.map);
  assert.equal(remapped.map.snapshot_id, 'sha256:second');
  const copy = path.join(repo, 'openspec/changes', NAME, 'business-map.json');
  assert.deepEqual(readFileSync(copy), readFileSync(second));
  assert.deepEqual(readJSON(path.join(repo, 'openspec/changes', NAME, 'genesis.json')).map, remapped.map);
  writeSpec(repo);
  const exported = exportSpec(repo, NAME);
  assert.equal(readJSON(exported.file).context.map.snapshot_id, 'sha256:second');
  // An export holds the Map it was written against.
  assert.throws(() => remapSpec(repo, NAME, { map: first }), (error) => {
    assert.equal(error.code, 'SPEC_REMAP_BLOCKED');
    assertGapShape(error.gaps[0], { code: 'spec_exported', owner: 'agent', layer: 'spec', digest: exported.id });
    return true;
  });
  assert.deepEqual(readFileSync(copy), readFileSync(second));
});

test('spec export says whether it ends a running loop, and shows the user which one', (t) => {
  // No loop: nothing ends.
  const { repo: plain } = authored(t);
  useFakeTools(t);
  const first = cli(['spec', 'export', NAME, '--repo', plain]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.ends_loop, false);
  assert.equal(first.json.loop, null);
  assert.equal('loop_ended' in first.json.must_show, false);

  const { repo, loop } = inLoop(t);
  assert.equal(loopStatus(repo, NAME).phase, 'live');
  // The same draft again is no new export and ends nothing.
  const same = cli(['spec', 'export', NAME, '--repo', repo]);
  assert.equal(same.json.unchanged, true);
  assert.equal(same.json.ends_loop, false);
  // workflow status says beforehand that an export of the edited Spec ends the loop.
  writeLoopSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace('数量为零', '数量必须为零'));
  assert.equal(actionOf(workflowStatus(repo, NAME), 'spec', 'export').effect, 'ends_loop');
  const ending = cli(['spec', 'export', NAME, '--repo', repo]);
  assert.equal(ending.status, 0, ending.stderr);
  assert.equal(ending.json.ends_loop, true);
  assert.deepEqual(ending.json.loop, { started_at: loop.started_at, export: loop.spec, phase: 'live', accepted: false });
  assert.deepEqual(ending.json.must_show.loop_ended, [{ started_at: loop.started_at, export: loop.spec }]);
  const status = loopStatus(repo, NAME);
  assert.equal(status.phase, 'ended');
  assert.equal(status.ended.reason, 'spec_exported');
});

test('an export after the one that ended a loop does not report ending it again', (t) => {
  const { repo, loop } = inLoop(t);
  writeLoopSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace('数量为零', '数量必须为零'));
  assert.equal(cli(['spec', 'export', NAME, '--repo', repo]).json.ends_loop, true);
  assert.equal(loopStatus(repo, NAME).phase, 'ended');
  // The Spec is edited again, and exported: the loop had ended already, so
  // this export ends nothing and shows no loop as ended by it.
  writeLoopSpec(repo, SPECS.two.replace('revision: 1', 'revision: 3').replace('数量为零', '数量仍为零'));
  const again = cli(['spec', 'export', NAME, '--repo', repo]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.ends_loop, false);
  assert.equal('loop_ended' in again.json.must_show, false);
  assert.equal(again.json.loop.export, loop.spec);
  assert.equal(again.json.loop.ended.reason, 'spec_exported');
});

test('each skill\'s launcher answers --help and --version in the folder that holds the CLI, and names the working directory for other commands without --repo', (t) => {
  const repo = project(t);
  newSpec(repo, NAME);
  writeSpec(repo);
  const root = realpathSync(ROOT);
  for (const skill of SKILLS) {
    const launcher = path.join(ROOT, 'skills', skill, 'scripts/run.mjs');
    const run = (...args) => spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', cwd: ROOT });
    const version = run('--version');
    assert.equal(version.status, 0, `${skill}: ${version.stderr}`);
    assert.equal(JSON.parse(version.stdout).version, VERSION);
    const help = run('--help');
    assert.equal(help.status, 0, `${skill}: ${help.stderr}`);
    assert.ok(help.stdout.startsWith(`Genesis EDD ${VERSION} `), skill);
    // Without --repo the project is the working directory, which holds the CLI.
    const refused = run('spec', 'validate', NAME);
    assert.equal(refused.status, 1, skill);
    assert.ok(refused.stderr.includes(`is inside the project ${root}. The CLI that judges a project has to be installed outside it.`), `${skill}: ${refused.stderr}`);
    assert.ok(refused.stderr.includes(`No --repo was given, so the project is the working directory ${root}: pass --repo with the project's folder`), `${skill}: ${refused.stderr}`);
    // With --repo naming the project, the same launcher runs the command.
    const checked = run('spec', 'validate', NAME, '--repo', repo);
    assert.equal(checked.status, 0, `${skill}: ${checked.stderr}`);
    assert.equal(JSON.parse(checked.stdout).ready_for_eval_design, true);
  }
  // The CLI itself refuses the same way, as the user's to fix on this machine.
  const direct = spawnSync(process.execPath, [CLI, 'spec', 'validate', NAME], { encoding: 'utf8', cwd: ROOT });
  assert.equal(direct.status, 1);
  const refusal = JSON.parse(direct.stderr);
  assert.equal(refusal.code, 'RUNTIME_INSIDE_PROJECT');
  assertGapShape(refusal.gaps[0], { code: 'runtime_inside_project', owner: 'user', layer: 'machine' });
  assert.ok(refusal.error.includes(`No --repo was given, so the project is the working directory ${root}`), refusal.error);
});

test('the CLI does not say no --repo was given when --repo names the folder that holds it', () => {
  const direct = spawnSync(process.execPath, [CLI, 'spec', 'validate', NAME, '--repo', '.'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(direct.status, 1);
  const refusal = JSON.parse(direct.stderr);
  assert.equal(refusal.code, 'RUNTIME_INSIDE_PROJECT');
  assert.doesNotMatch(refusal.error, /No --repo was given/);
});

test('the CLI reads its version from package.json', (t) => {
  // A copy of the package with another version number in package.json.
  const copy = scratch(t, 'genesis-edd-version-');
  for (const folder of ['bin', 'src', 'skills']) cpSync(path.join(ROOT, folder), path.join(copy, folder), { recursive: true });
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ ...readJSON(path.join(ROOT, 'package.json')), version: '9.8.7-test' }));
  const version = spawnSync(process.execPath, [path.join(copy, 'bin/genesis-edd.js'), '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).version, '9.8.7-test');
  const help = spawnSync(process.execPath, [path.join(copy, 'bin/genesis-edd.js'), '--help'], { encoding: 'utf8' });
  assert.ok(help.stdout.startsWith('Genesis EDD 9.8.7-test '), help.stdout.slice(0, 80));
});

test('init writes every skill\'s launcher and runtime.json again on each run and never touches a skill\'s LOCAL.md', (t) => {
  const repo = project(t, 'new', 'claude');
  const skills = path.join(repo, '.claude/skills');
  const runtime = { cli: path.join(ROOT, 'bin/genesis-edd.js') };
  for (const skill of SKILLS) {
    assert.deepEqual(readJSON(path.join(skills, skill, 'scripts/runtime.json')), runtime, skill);
    assert.equal(readFileSync(path.join(skills, skill, 'scripts/run.mjs'), 'utf8'), readFileSync(path.join(ROOT, 'skills', skill, 'scripts/run.mjs'), 'utf8'), skill);
  }
  // A launcher and a runtime.json the project changed are written again, as
  // they are not the project's to change; LOCAL.md is the project's own.
  const launcher = path.join(skills, 'write-eval/scripts/run.mjs');
  writeFileSync(launcher, 'console.log(JSON.stringify({ version: "swapped" }));\n');
  writeFileSync(path.join(skills, 'run-eval/scripts/runtime.json'), JSON.stringify({ cli: path.join(repo, 'judge.js') }));
  const local = path.join(skills, 'agent-spec/LOCAL.md');
  writeFileSync(local, 'Team notes for this skill.\n');
  const again = initProject(repo, 'new', 'claude');
  assert.deepEqual([...again.updated].sort(), ['.claude/skills/run-eval/scripts/runtime.json', '.claude/skills/write-eval/scripts/run.mjs']);
  assert.deepEqual(again.conflicts, []);
  assert.equal(readFileSync(local, 'utf8'), 'Team notes for this skill.\n');
  assert.ok(!again.created.includes('.claude/skills/agent-spec/LOCAL.md'));
  assert.deepEqual(readJSON(path.join(skills, 'run-eval/scripts/runtime.json')), runtime);
  // Each skill runs the CLI through its own launcher, without the others.
  rmSync(path.join(skills, 'agent-spec'), { recursive: true });
  const version = spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).version, VERSION);
});

test('a launcher refuses a runtime.json that names a CLI inside the project it would judge', (t) => {
  const repo = project(t, 'new', 'claude');
  newSpec(repo, NAME);
  writeSpec(repo);
  const judge = path.join(repo, 'tools/judge.js');
  mkdirSync(path.dirname(judge), { recursive: true });
  writeFileSync(judge, 'console.log(JSON.stringify({ ready_for_eval_design: true }));\n');
  const scripts = path.join(repo, '.claude/skills/write-eval/scripts');
  writeFileSync(path.join(scripts, 'runtime.json'), JSON.stringify({ cli: judge }));
  const response = spawnSync(process.execPath, [path.join(scripts, 'run.mjs'), 'spec', 'validate', NAME, '--repo', repo], { encoding: 'utf8' });
  assert.equal(response.status, 1);
  assert.ok(response.stderr.includes(`the CLI it would run, ${realpathSync(judge)}, is inside the project ${realpathSync(repo)}.`), response.stderr);
  assert.equal(response.stdout, '');
});
