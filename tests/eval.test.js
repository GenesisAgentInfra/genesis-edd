import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, listFiles, readJSON } from '../src/project.js';
import { exportSpec, specRequirements } from '../src/spec.js';
import { evalSnapshot, isLive, kitSettings, legacyPackages, manualLines, newEval, thenKey, validateEval } from '../src/eval.js';
import { checkEval, startRun } from '../src/run.js';
import { workflowStatus } from '../src/workflow.js';
import {
  CHANGE, FIXTURES, SPECS, actionOf, assertGapShape, assertNoRoutes, cli, confirmChecks, dropCheck, editChecks, legacyWarning, readyProject, toLegacy,
  writeExpectations, writeFixtureScripts, writeSpec,
} from './helpers/edd.js';

const FAILURE = 'submit-failure-s1';
const SUCCESS = 'submit-success-s1';

const codes = (gaps) => gaps.map((gap) => gap.code);
const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const gapsOf = (repo, code) => validateEval(repo, CHANGE).gaps.filter((gap) => gap.code === code);
const invalid = (repo) => gapsOf(repo, 'case_invalid').map((gap) => gap.message);
const folders = (root) => readdirSync(path.join(root, 'evals')).sort();

// SPECS.two at revision 2 with a scenario inserted before the first scenario of
// REQ-submit-failure. Its package is the one eval new still has to write.
const INSERTED = SPECS.two.replace('revision: 1', 'revision: 2').replace('#### Scenario: 提交失败', `#### Scenario: 提交超时

- **WHEN** 报告提交超时
- **THEN** 本次提交发送的成功通知数量为零

#### Scenario: 提交失败`);

// Points every package at the export spec, as an agent does once it has
// reviewed them against it.
function restamp(root, spec) {
  for (const id of folders(root)) {
    const file = path.join(root, 'evals', id, 'tests/checks.json');
    const declared = readJSON(file);
    declared.spec_ref.sha256 = spec;
    writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  }
}

test('eval new writes a sealed package for a scenario inserted before another under the next free number, and keeps only folders that exist', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  const before = readFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), 'utf8');
  writeSpec(repo, INSERTED);
  const exported = exportSpec(repo, CHANGE);
  // The folder the new scenario would take holds the package of the scenario
  // after it, which keeps its folder.
  let workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual(workflow.layers.packages.unpackaged_scenarios, [{ requirement: 'REQ-submit-failure', name: '提交超时' }]);
  const writing = actionOf(workflow, 'eval', 'new');
  assert.deepEqual([writing.command, writing.allowed, writing.scenarios], [['eval', 'new', CHANGE, '--repo', repo], true, 1]);

  const written = newEval(repo, CHANGE);
  assert.deepEqual(written.created, ['submit-failure-s2']);
  assert.deepEqual(written.kept, [FAILURE, SUCCESS]);
  assert.deepEqual([written.skipped, written.unreadable], [[], []]);
  assert.ok([...written.created, ...written.kept].every((id) => existsSync(path.join(root, 'evals', id))));
  assert.deepEqual(folders(root), [FAILURE, 'submit-failure-s2', SUCCESS]);
  assert.equal(readFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), 'utf8'), before);
  const declared = readJSON(path.join(root, 'evals/submit-failure-s2/tests/checks.json'));
  assert.deepEqual(declared.scenario, { requirement: 'REQ-submit-failure', name: '提交超时', manual: [] });
  assert.equal(declared.spec_ref.sha256, exported.id);
  assert.deepEqual(declared.checks.map((check) => check.expect), ['本次提交发送的成功通知数量为零']);
  assert.match(readFileSync(path.join(root, 'evals/submit-failure-s2/task.toml'), 'utf8'), /name = "genesis-edd\/report-notifications--submit-failure-s2"/);
  // A new package is sealed: its program runs without network access.
  assert.match(readFileSync(path.join(root, 'evals/submit-failure-s2/environment/docker-compose.yaml'), 'utf8'), /^ {4}network_mode: none$/m);
  assert.equal(validateEval(repo, CHANGE).cases.find((item) => item.id === 'submit-failure-s2').sealed.value, true);

  // Every scenario has a package now. Those written for the earlier export
  // cover their scenarios once reviewed against this one.
  assert.deepEqual(gapsOf(repo, 'case_stale').map((gap) => gap.case), [FAILURE, SUCCESS]);
  assert.deepEqual(gapsOf(repo, 'scenario_uncovered').map((gap) => gap.message), [
    'No package for scenario "提交失败" of REQ-submit-failure.', 'No package for scenario "提交成功" of REQ-submit-success.']);
  restamp(root, exported.id);
  assert.deepEqual(gapsOf(repo, 'case_stale'), []);
  assert.deepEqual(gapsOf(repo, 'scenario_uncovered'), []);
  const again = newEval(repo, CHANGE);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.kept, ['submit-failure-s2', FAILURE, SUCCESS]);

  // Nothing is left for eval new: workflow status lists no such action, and
  // the finished packages wait for eval check.
  workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual(workflow.layers.packages.unpackaged_scenarios, []);
  assert.equal(actionOf(workflow, 'eval', 'new'), undefined);
  assert.deepEqual(actionOf(workflow, 'eval', 'check').cases, [FAILURE, SUCCESS]);
  assertNoRoutes(workflow.gaps, 'gaps');
});

// A folder under evals/ whose checks.json cannot be read or names no scenario
// may be the package of any scenario of the requirement its name starts
// with, so eval new writes no package for those scenarios and never guesses.
const UNNAMED = (ids) => {
  const one = ids.length === 1;
  return `${ids.join(', ')}: tests/checks.json cannot be read or names no scenario, so which scenario ${one ? 'this folder was' : 'these folders were'} written for cannot be told, and \`eval new\` writes no package for a scenario of the same requirement, which could duplicate ${one ? 'it' : 'one'}.`;
};

test('eval new writes no package for a requirement one of whose folders has a checks.json that cannot be read, writes those of the others, and workflow status names the folder', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  writeFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), '{ not json');
  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  const written = newEval(repo, CHANGE);
  // 提交失败 may be the scenario of the folder that cannot be read; 提交成功 is another requirement's.
  assert.deepEqual(written.created, [SUCCESS]);
  assert.deepEqual(written.skipped, [{ requirement: 'REQ-submit-failure', name: '提交失败', folders: [FAILURE] }]);
  assert.deepEqual(written.unreadable, [FAILURE]);
  assert.deepEqual(folders(root), [FAILURE, SUCCESS]);
  assert.match(invalid(repo).join('\n'), /submit-failure-s1: tests\/checks\.json is missing or not a JSON object/);
  const workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual(workflow.layers.packages.unnamed_folders, [FAILURE]);
  assert.equal(workflow.layers.packages.unnamed_note, UNNAMED([FAILURE]));
  assertGapShape(workflow.gaps.find((gap) => gap.code === 'case_invalid' && gap.case === FAILURE), { owner: 'agent', layer: 'package' });
  // Another call skips it again and writes nothing.
  assert.deepEqual(newEval(repo, CHANGE).created, []);
  assert.deepEqual(folders(root), [FAILURE, SUCCESS]);
});

test('eval new writes nothing while a folder under evals/ is not a package and every scenario has a package that names it, and names the folder', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  mkdirSync(path.join(root, 'evals', 'old-notes'));
  writeFileSync(path.join(root, 'evals', 'old-notes', 'notes.md'), 'Notes from an earlier try.\n');
  const snapshot = () => listFiles(path.join(repo, '.genesis/edd')).map((entry) => `${entry}\n${readFileSync(entry, 'utf8')}`);
  const before = snapshot();
  const written = newEval(repo, CHANGE);
  assert.deepEqual([written.created, written.skipped, written.unreadable], [[], [], ['old-notes']]);
  assert.deepEqual(snapshot(), before);
  const workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual(workflow.layers.packages.unnamed_folders, ['old-notes']);
  assert.equal(workflow.layers.packages.unnamed_note, UNNAMED(['old-notes']));
  rmSync(path.join(root, 'evals', 'old-notes'), { recursive: true });
  assert.deepEqual(newEval(repo, CHANGE).unreadable, []);
});

test('eval new writes nothing for a requirement while a checks.json of it cannot be read or names no scenario after a scenario was inserted, and names every such folder', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  writeSpec(repo, INSERTED);
  exportSpec(repo, CHANGE);
  const file = path.join(root, 'evals', FAILURE, 'tests/checks.json');
  const original = readFileSync(file, 'utf8');
  const { scenario, ...unnamed } = readJSON(file);
  const snapshot = () => listFiles(path.join(repo, '.genesis/edd')).map((entry) => `${entry}\n${readFileSync(entry, 'utf8')}`);
  // The package was written for 提交失败, whose place 提交超时 now holds, so
  // its folder no longer says which scenario it covers.
  const named = (value) => `${JSON.stringify({ ...unnamed, scenario: value }, null, 2)}\n`;
  for (const broken of ['{ not json', `${JSON.stringify(unnamed, null, 2)}\n`, named({}), named({ requirement: 'REQ-submit-failure' }),
    named({ requirement: 'REQ-submit-failure', name: '' }), named({ requirement: ['REQ-submit-failure'], name: '提交失败' })]) {
    writeFileSync(file, broken);
    const before = snapshot();
    const written = newEval(repo, CHANGE);
    assert.deepEqual(written.created, [], broken);
    assert.deepEqual(written.skipped.map((entry) => [entry.name, entry.folders]), [['提交超时', [FAILURE]], ['提交失败', [FAILURE]]], broken);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(folders(root), [FAILURE, SUCCESS]);
    assert.deepEqual(workflowStatus(repo, CHANGE).layers.packages.unnamed_folders, [FAILURE], broken);
  }
  assert.deepEqual(scenario, { requirement: 'REQ-submit-failure', name: '提交失败', manual: [] });

  // A folder that is not a package at all is named too, beside a broken one.
  mkdirSync(path.join(root, 'evals', 'old-notes'));
  writeFileSync(path.join(root, 'evals', 'old-notes', 'notes.md'), 'Notes from an earlier try.\n');
  assert.deepEqual(newEval(repo, CHANGE).unreadable, ['old-notes', FAILURE]);
  assert.equal(workflowStatus(repo, CHANGE).layers.packages.unnamed_note, UNNAMED(['old-notes', FAILURE]));
  assert.deepEqual(gapsOf(repo, 'case_invalid').map((gap) => gap.case), ['old-notes', FAILURE]);

  // Once repaired, the package keeps its scenario and the new one gets its own.
  rmSync(path.join(root, 'evals', 'old-notes'), { recursive: true });
  writeFileSync(file, original);
  assert.equal(actionOf(workflowStatus(repo, CHANGE), 'eval', 'new').allowed, true);
  const written = newEval(repo, CHANGE);
  assert.deepEqual(written.created, ['submit-failure-s2']);
  assert.deepEqual(written.kept, [FAILURE, SUCCESS]);
  assert.deepEqual(readJSON(path.join(root, 'evals/submit-failure-s2/tests/checks.json')).scenario, { requirement: 'REQ-submit-failure', name: '提交超时', manual: [] });
});

test('workflow status lists eval new while a scenario has no package', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  assert.equal(actionOf(workflowStatus(repo, CHANGE), 'eval', 'new'), undefined);
  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  const workflow = workflowStatus(repo, CHANGE);
  assert.deepEqual(workflow.layers.packages.unpackaged_scenarios, [{ requirement: 'REQ-submit-success', name: '提交成功' }]);
  assert.equal(actionOf(workflow, 'eval', 'new').allowed, true);
  assert.deepEqual(newEval(repo, CHANGE).created, [SUCCESS]);
  assert.equal(actionOf(workflowStatus(repo, CHANGE), 'eval', 'new'), undefined);
});

test('eval check is refused while Docker is down, with a gap of the machine layer, and goes on package by package while a scenario has no package', (t) => {
  const { repo, root, tools } = readyProject(t);
  // A finished package to prove again while Docker is down.
  const file = path.join(root, 'evals', FAILURE, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  tools.docker(false);
  assert.throws(() => checkEval(repo, CHANGE), (error) => {
    assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
    assertGapShape(error.gaps.find((gap) => gap.code === 'docker_unavailable'), { layer: 'machine' });
    assertNoRoutes(error);
    return true;
  });
  const down = cli(['eval', 'check', CHANGE, '--repo', repo]);
  assert.equal(down.status, 1);
  assert.ok(codes(down.json.gaps).includes('docker_unavailable'), JSON.stringify(down.json));
  assertNoRoutes(down.json);
  tools.docker(true);

  // A scenario without a package holds back no other package.
  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  assert.deepEqual(gapsOf(repo, 'scenario_uncovered').map((gap) => gap.scenario), ['提交成功']);
  const checked = checkEval(repo, CHANGE);
  assert.equal(checked.passed, true);
  assert.deepEqual(checked.proved, [FAILURE]);
  const shown = cli(['eval', 'check', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.json.already_proved, [FAILURE]);
});

// Coverage and drift gaps of eval validate.

test('eval validate reports packages written for an earlier export as case_stale, and they cover nothing until reviewed', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  assert.deepEqual(validateEval(repo, CHANGE).gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace('本次提交发送的成功通知数量为一', '本次提交只发送一条成功通知'));
  const exported = exportSpec(repo, CHANGE);
  const result = validateEval(repo, CHANGE);
  assert.equal(result.valid, false);
  assert.equal(result.spec, exported.id);
  const stale = result.gaps.filter((gap) => gap.code === 'case_stale');
  for (const [index, id] of [FAILURE, SUCCESS].entries()) {
    assertGapShape(stale[index], { case: id, owner: 'agent', layer: 'package', path: `.genesis/edd/${CHANGE}/evals/${id}/tests/checks.json`, current: exported.id });
  }
  assert.match(stale[0].message, /is bound to another Spec \(\w{12}\) than the one read here \(\w{12}\)\. Its old expectations do not carry over by themselves/);
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 0, requirements_without_gating_check: ['REQ-submit-failure', 'REQ-submit-success'],
    lines: { total: 0, gating: 0, manual: 0, uncovered: 0, unbound: 0 } });
  assert.deepEqual(result.then_lines, []);
  assert.deepEqual(gapsOf(repo, 'then_uncovered'), []);
  assert.match(stale[0].message, /each then and scenario\.manual entry is checked again against the current scenario\.$/);
  // eval new rewrites nothing a package owns: the old expectation stays until reviewed.
  assert.deepEqual(newEval(repo, CHANGE).created, []);
  assert.deepEqual(readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json')).checks[0].expect, '本次提交发送的成功通知数量为一');
  restamp(root, exported.id);
  // Its check still names the line of the earlier export.
  assert.deepEqual(codes(validateEval(repo, CHANGE).gaps).filter((code) => code !== 'integration_pending'), ['case_invalid', 'then_uncovered']);
  assert.match(invalid(repo)[0], /^submit-success-s1: check c1: then "本次提交发送的成功通知数量为一" is not a THEN or AND line of scenario "提交成功"\. Its lines, exactly: "本次提交只发送一条成功通知"/);
  editChecks(repo, SUCCESS, (declared) => { declared.checks[0].then = '本次提交只发送一条成功通知'; });
  assert.deepEqual(codes(validateEval(repo, CHANGE).gaps).filter((code) => code !== 'integration_pending'), []);
});

test('eval validate reports a scenario without a package, and a requirement without a gating check', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  // In checks.json 1.0, a check that cites another requirement leaves
  // REQ-submit-success ungated while the package itself stays valid.
  const file = path.join(root, 'evals', SUCCESS, 'tests/checks.json');
  const declared = toLegacy(readJSON(file));
  for (const check of declared.checks) check.intent = 'REQ-submit-failure';
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  let result = validateEval(repo, CHANGE);
  assert.deepEqual(codes(result.gaps).filter((code) => code !== 'integration_pending'), ['requirement_uncovered']);
  assert.deepEqual(result.gaps.find((gap) => gap.code === 'requirement_uncovered'), {
    code: 'requirement_uncovered', kind: 'artifact', owner: 'agent', layer: 'package', requirement_id: 'REQ-submit-success', path: `.genesis/edd/${CHANGE}/evals`,
    message: 'REQ-submit-success has no gating check. Every accepted requirement needs one before the change can pass.' });
  assert.equal(result.valid, false);
  assert.ok(result.warnings.includes(legacyWarning([SUCCESS])), JSON.stringify(result.warnings));
  assert.ok(result.warnings.includes(`${SUCCESS}: gating check c1 cites REQ-submit-failure, not REQ-submit-success, the requirement of its scenario. checks.json 1.1 refuses that: a gating check verifies a line of its own scenario.`), JSON.stringify(result.warnings));
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 2, requirements_without_gating_check: ['REQ-submit-success'],
    lines: { total: 3, gating: 1, manual: 0, uncovered: 0, unbound: 2 } });

  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  result = validateEval(repo, CHANGE);
  assert.deepEqual(codes(result.gaps).filter((code) => code !== 'integration_pending'), ['scenario_uncovered', 'requirement_uncovered']);
  assert.deepEqual(result.gaps.find((gap) => gap.code === 'scenario_uncovered'), {
    code: 'scenario_uncovered', kind: 'artifact', owner: 'agent', layer: 'package', requirement_id: 'REQ-submit-success', scenario: '提交成功',
    path: `.genesis/edd/${CHANGE}/evals`, message: 'No package for scenario "提交成功" of REQ-submit-success.' });
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 1, requirements_without_gating_check: ['REQ-submit-success'],
    lines: { total: 1, gating: 1, manual: 0, uncovered: 0, unbound: 0 } });
});

// Line coverage: checks.json 1.1 binds each check to the THEN or AND line it verifies.

const LINE_FAILURE = '本次提交发送的成功通知数量为零';
const LINE_ONE = '本次提交发送的成功通知数量为一';
const LINE_NONE = '本次提交发送的失败通知数量为零';
const rowsOf = (result) => result.then_lines.map((row) => [row.case, row.then, row.status]);
const uncoveredMessage = (line, scenario) => `No gating check of a package of scenario "${scenario}" verifies "${line}", and none lists it in scenario.manual. A diagnostic check covers no line.`;
const NOT_A_LINE = (value, hint = '') => `${SUCCESS}: check c2: then "${value}" is not a THEN or AND line of scenario "提交成功".${hint} Its lines, exactly: "${LINE_ONE}", "${LINE_NONE}".`;
const manualWarning = (entries) => `The user judges ${entries.length === 1 ? 'this THEN line' : 'these THEN lines'} at acceptance, since no check verifies ${entries.length === 1 ? 'it' : 'them'}: ${entries.map(([id, line, reason]) => `"${line}" in ${id} (${reason})`).join('; ')}.`;
const NO_GATING = 'No package of this change has a gating check: the user judges every THEN line. A run passes only on gating checks, so no run of this change can pass, and `loop start` refuses it (gating_missing).';
// A row of eval validate's then_lines, with what checks the line.
const row = (id, requirement, scenario, then, status, fields = {}) => ({ case: id, requirement, scenario, then, status, gating: [], diagnostic: [], judges: [], ...fields });

test('eval new writes checks.json 1.1: one gating check per THEN or AND line, whose then is the line and whose expect starts as it', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  const declared = readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json'));
  assert.equal(declared.schema_version, '1.1');
  assert.deepEqual(declared.scenario, { requirement: 'REQ-submit-success', name: '提交成功', manual: [] });
  assert.deepEqual(declared.checks, [
    { id: 'c1', intent: 'REQ-submit-success', then: LINE_ONE, expect: LINE_ONE, role: 'gating' },
    { id: 'c2', intent: 'REQ-submit-success', then: LINE_NONE, expect: LINE_NONE, role: 'gating' },
  ]);
  const result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 3, manual: 0, uncovered: 0, unbound: 0 });
  assert.deepEqual(result.then_lines, [
    row(FAILURE, 'REQ-submit-failure', '提交失败', LINE_FAILURE, 'gating', { gating: [{ check: 'c1', expect: LINE_FAILURE }], counterexamples: [{ fixture: 'review-c1', origin: 'review' }] }),
    row(SUCCESS, 'REQ-submit-success', '提交成功', LINE_ONE, 'gating', { gating: [{ check: 'c1', expect: LINE_ONE }], counterexamples: [{ fixture: 'review-c1', origin: 'review' }] }),
    row(SUCCESS, 'REQ-submit-success', '提交成功', LINE_NONE, 'gating', { gating: [{ check: 'c2', expect: LINE_NONE }], counterexamples: [{ fixture: 'review-c2', origin: 'review' }] }),
  ]);
  assert.deepEqual(result.cases.map((item) => [item.id, item.schema_version, item.manual, 'lines' in item]), [[FAILURE, '1.1', 0, false], [SUCCESS, '1.1', 0, false]]);
  assert.deepEqual([legacyPackages(result), manualLines(result)], [[], []]);
  // What eval new says is a fact about what it wrote, with eval validate as its suggestion.
  const written = newEval(repo, CHANGE);
  assert.match(written.note, /^Each new package has one gating check per THEN or AND line, whose then names the line and whose expect starts as its text\./);
  assert.deepEqual(written.suggestion.command, ['eval', 'validate', CHANGE, '--repo', repo]);
});

test('a then that is not a THEN or AND line of its scenario is case_invalid, lists the lines to copy and leaves its line uncovered', (t) => {
  const { repo } = readyProject(t, { check: false });
  const setThen = (value) => editChecks(repo, SUCCESS, (declared) => { declared.checks[1].then = value; });
  setThen('失败通知数量为零');
  assert.deepEqual(invalid(repo), [NOT_A_LINE('失败通知数量为零')]);
  assert.deepEqual(gapsOf(repo, 'then_uncovered').map((gap) => [gap.case, gap.then]), [[SUCCESS, LINE_NONE]]);
  // The keyword of the Spec's Markdown left in.
  for (const value of [`THEN ${LINE_NONE}`, `AND ${LINE_NONE}`, `THEN${LINE_NONE}`, `**THEN** ${LINE_NONE}`, `- **AND** ${LINE_NONE}`]) {
    setThen(value);
    assert.deepEqual(invalid(repo), [NOT_A_LINE(value, ' The THEN or AND keyword is not part of the line.')], value);
  }
  // A GIVEN or WHEN keyword before a THEN line gets no keyword hint.
  for (const value of [`GIVEN ${LINE_NONE}`, `WHEN ${LINE_NONE}`]) {
    setThen(value);
    assert.deepEqual(invalid(repo), [NOT_A_LINE(value)], value);
  }
  // A line that sets the scenario up.
  for (const value of ['报告提交返回成功', 'WHEN 报告提交返回成功']) {
    setThen(value);
    assert.deepEqual(invalid(repo), [NOT_A_LINE(value, ' That is a GIVEN or WHEN line, which sets the scenario up; a check verifies a THEN or AND line.')], value);
  }
  // A line of another scenario is no line of this one.
  setThen(LINE_FAILURE);
  assert.deepEqual(invalid(repo), [NOT_A_LINE(LINE_FAILURE)]);
});

test('a then binds with whitespace folded: extra spaces, a full-width space, a no-break space or a trailing newline', (t) => {
  const { repo } = readyProject(t, { check: false });
  assert.equal(thenKey(' a 　\n\t b  '), 'a b');
  for (const value of [`  ${LINE_NONE}   `, `${LINE_NONE}\n`, `　${LINE_NONE}　`, ` ${LINE_NONE}`]) {
    editChecks(repo, SUCCESS, (declared) => { declared.checks[1].then = value; });
    const result = validateEval(repo, CHANGE);
    assert.deepEqual(invalid(repo), [], JSON.stringify(value));
    // The row shows the line as the Spec has it.
    assert.deepEqual(result.then_lines.find((row) => row.case === SUCCESS && row.then === LINE_NONE).gating, [{ check: 'c2', expect: LINE_NONE }], JSON.stringify(value));
  }
});

test('a gating check needs then, and then is one line', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => { delete declared.checks[1].then; });
  assert.deepEqual(invalid(repo), [`${SUCCESS}: check c2 is gating, so it needs then: the THEN or AND line of its scenario it verifies.`]);
  assert.deepEqual(gapsOf(repo, 'then_uncovered').map((gap) => gap.then), [LINE_NONE]);
  editChecks(repo, SUCCESS, (declared) => { declared.checks[1].then = [LINE_ONE, LINE_NONE]; });
  assert.deepEqual(invalid(repo), [`${SUCCESS}: check c2: then is one line, not a list. A check verifies one THEN or AND line, or names in then_group a few lines that can only fail together.`]);
  for (const value of ['', '  ', 3]) {
    editChecks(repo, SUCCESS, (declared) => { declared.checks[1].then = value; });
    assert.deepEqual(invalid(repo), [`${SUCCESS}: check c2: then must be one THEN or AND line of the scenario.`], JSON.stringify(value));
  }
});

test('deleting the only gating check of a line leaves it uncovered, which blocks eval validate, eval confirm and run start, while eval check still proves the package', (t) => {
  const project = readyProject(t);
  const { repo } = project;
  editChecks(repo, SUCCESS, (declared) => dropCheck(declared, 'c2'));
  const result = validateEval(repo, CHANGE);
  assert.equal(result.valid, false);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), [{
    code: 'then_uncovered', kind: 'artifact', owner: 'agent', layer: 'package', case: SUCCESS, cases: [SUCCESS],
    path: `.genesis/edd/${CHANGE}/evals/${SUCCESS}/tests/checks.json`, requirement_id: 'REQ-submit-success',
    scenario: '提交成功', then: LINE_NONE, message: uncoveredMessage(LINE_NONE, '提交成功') }]);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 2, manual: 0, uncovered: 1, unbound: 0 });
  assert.deepEqual(result.then_lines.at(-1), row(SUCCESS, 'REQ-submit-success', '提交成功', LINE_NONE, 'uncovered', { counterexamples: [] }));
  // Coverage is the change's: eval check proves each package as it is.
  assert.deepEqual(checkEval(repo, CHANGE).proved, [SUCCESS]);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), (error) => {
    assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
    assert.deepEqual(codes(error.gaps), ['then_uncovered']);
    return true;
  });
  assert.throws(() => confirmChecks(project, { reason: 'A check was dropped.' }), (error) => {
    assert.equal(error.code, 'CONFIRM_INPUT_BLOCKED', error.message);
    assert.deepEqual(codes(error.gaps), ['then_uncovered']);
    return true;
  });
  const shown = cli(['eval', 'validate', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 1);
  assert.deepEqual(codes(shown.json.gaps).filter((code) => code !== 'integration_pending'), ['then_uncovered']);
  const workflow = workflowStatus(repo, CHANGE);
  assert.ok(codes(workflow.gaps).includes('then_uncovered'), JSON.stringify(workflow.gaps));
  assert.ok(actionOf(workflow, 'run', 'start', '--baseline').blocked_by.includes('then_uncovered'));
  assert.ok(actionOf(workflow, 'eval', 'confirm').blocked_by.includes('then_uncovered'));
});

test('a diagnostic check that cites a line covers nothing, and two gating checks may verify one line', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => { declared.checks[1].role = 'diagnostic'; });
  let result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending').map((gap) => [gap.code, gap.then]), [['then_uncovered', LINE_NONE]]);
  assert.deepEqual(result.then_lines.at(-1), row(SUCCESS, 'REQ-submit-success', '提交成功', LINE_NONE, 'uncovered', {
    diagnostic: [{ check: 'c2', expect: LINE_NONE }], counterexamples: [] }));

  editChecks(repo, SUCCESS, (declared) => {
    declared.checks[1].role = 'gating';
    declared.checks.push({ id: 'c3', intent: 'REQ-submit-success', then: LINE_NONE, expect: '本次提交没有发出失败通知', role: 'gating' });
    // c3 verifies the line c2 verifies, so a counterexample of that line fails both.
    for (const fixture of declared.fixtures) fixture.expect.c3 = FIXTURES.includes(fixture.name) ? fixture.name : fixture.expect.c2;
  });
  result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(result.then_lines.at(-1).gating, [{ check: 'c2', expect: LINE_NONE }, { check: 'c3', expect: '本次提交没有发出失败通知' }]);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 3, manual: 0, uncovered: 0, unbound: 0 });
});

test('a gating check of checks.json 1.1 cites the requirement of its scenario; a diagnostic one may cite another', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => { declared.checks[1].intent = 'REQ-submit-failure'; });
  assert.deepEqual(invalid(repo), [`${SUCCESS}: check c2 is gating, so its intent must be REQ-submit-success, the requirement of its scenario; it cites REQ-submit-failure. A check of another requirement can only be diagnostic.`]);
  editChecks(repo, SUCCESS, (declared) => {
    declared.checks[1].intent = 'REQ-submit-success';
    declared.checks.push({ id: 'c3', intent: 'REQ-submit-failure', then: LINE_NONE, expect: '本次提交没有发出失败通知', role: 'diagnostic' });
  });
  const result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(result.then_lines.at(-1).diagnostic, [{ check: 'c3', expect: '本次提交没有发出失败通知' }]);
  editChecks(repo, SUCCESS, (declared) => { declared.checks[2].intent = 'REQ-unknown'; });
  assert.deepEqual(invalid(repo), [`${SUCCESS}: check c3 cites REQ-unknown, which is not in the Spec. Every check needs a source.`]);
});

test('a line no program can judge is listed in scenario.manual with the reason instead of a check, and the user is told', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => {
    dropCheck(declared, 'c2');
    declared.scenario.manual = [{ then: LINE_NONE, reason: 'synthetic: judged by a person' }];
  });
  const result = validateEval(repo, CHANGE);
  assert.equal(result.valid, true);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(result.then_lines.at(-1), row(SUCCESS, 'REQ-submit-success', '提交成功', LINE_NONE, 'manual', {
    reason: 'synthetic: judged by a person', counterexamples: [] }));
  assert.deepEqual(manualLines(result).map((row) => row.then), [LINE_NONE]);
  assert.equal(result.cases.find((item) => item.id === SUCCESS).manual, 1);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 2, manual: 1, uncovered: 0, unbound: 0 });
  assert.ok(result.warnings.includes(manualWarning([[SUCCESS, LINE_NONE, 'synthetic: judged by a person']])), JSON.stringify(result.warnings));
  assert.equal(checkEval(repo, CHANGE).passed, true);
});

test('scenario.manual lists lines of the scenario, each once with its reason, and none a gating check verifies', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  const original = readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json'));
  // Each time from the package as eval new wrote it: with c2, or without it.
  const setManual = (manual, keep = false) => editChecks(repo, SUCCESS, () => {
    const declared = structuredClone(original);
    if (!keep) dropCheck(declared, 'c2');
    declared.scenario.manual = manual;
    return declared;
  });
  setManual([{ then: '失败通知数量为零', reason: 'synthetic' }]);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: scenario.manual entry 1: then "失败通知数量为零" is not a THEN or AND line of scenario "提交成功". Its lines, exactly: "${LINE_ONE}", "${LINE_NONE}".`]);
  setManual([{ then: LINE_NONE }], true);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: scenario.manual entry 1 needs reason: why no program can judge the line.`, `${SUCCESS}: "${LINE_NONE}" is in scenario.manual and verified by gating check c2. A line is judged by a check or by the user, not both.`]);
  setManual([{ then: LINE_NONE, reason: 'synthetic' }, { then: ` ${LINE_NONE}`, reason: 'again' }], true);
  assert.ok(invalid(repo).includes(`${SUCCESS}: scenario.manual entry 2: "${LINE_NONE}" is in scenario.manual more than once.`), invalid(repo).join('\n'));
  setManual([{ then: LINE_NONE, reason: 'synthetic' }], true);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: "${LINE_NONE}" is in scenario.manual and verified by gating check c2. A line is judged by a check or by the user, not both.`]);
  setManual({ then: LINE_NONE, reason: 'synthetic' }, true);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: scenario.manual must be a list of {then, reason}; use [] when a gating check verifies every line.`]);
  setManual([LINE_NONE], true);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: scenario.manual entry 1 needs then, the line, and reason, why no program can judge it.`]);
});

test('a package whose every line is in scenario.manual needs no check, and no requirement_uncovered; with no gating check anywhere, the user is told no run can pass', (t) => {
  const { repo } = readyProject(t, { check: false });
  const allManual = (lines) => (declared) => ({ ...declared, checks: [], fixtures: [], scenario: { ...declared.scenario, manual: lines.map((then) => ({ then, reason: 'synthetic' })) } });
  editChecks(repo, SUCCESS, allManual([LINE_ONE, LINE_NONE]));
  let result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(result.coverage.requirements_without_gating_check, []);
  assert.ok(!result.warnings.includes(NO_GATING), JSON.stringify(result.warnings));
  assert.deepEqual(result.cases.find((item) => item.id === SUCCESS).gating, 0);

  editChecks(repo, FAILURE, allManual([LINE_FAILURE]));
  result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 0, manual: 3, uncovered: 0, unbound: 0 });
  assert.ok(result.warnings.includes(NO_GATING), JSON.stringify(result.warnings));
  assert.ok(result.warnings.includes(manualWarning([[FAILURE, LINE_FAILURE, 'synthetic'], [SUCCESS, LINE_ONE, 'synthetic'], [SUCCESS, LINE_NONE, 'synthetic']])), JSON.stringify(result.warnings));

  // A line left out of scenario.manual with no check is uncovered, and the
  // package needs a gating check again.
  editChecks(repo, SUCCESS, allManual([LINE_ONE]));
  assert.deepEqual(invalid(repo), [`${SUCCESS}: At least one gating check is required, unless scenario.manual lists every THEN and AND line of the scenario.`]);
  assert.deepEqual(gapsOf(repo, 'then_uncovered').map((gap) => [gap.case, gap.then]), [[SUCCESS, LINE_NONE]]);
});

test('a package rewritten to checks.json 1.0 is read under its old rules with a warning, and its lines show as unbound', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, toLegacy);
  assert.equal(checkEval(repo, CHANGE).passed, true);
  const result = validateEval(repo, CHANGE);
  assert.equal(result.valid, true);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), []);
  assert.deepEqual(legacyPackages(result), [SUCCESS]);
  assert.deepEqual(result.warnings, [legacyWarning([SUCCESS])]);
  assert.deepEqual(rowsOf(result), [[FAILURE, LINE_FAILURE, 'gating'], [SUCCESS, LINE_ONE, 'unbound'], [SUCCESS, LINE_NONE, 'unbound']]);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 1, manual: 0, uncovered: 0, unbound: 2 });
  assert.equal(result.cases.find((item) => item.id === SUCCESS).schema_version, '1.0');
  // The baseline runs on it.
  const base = startRun(repo, CHANGE, { baseline: true, expect: writeExpectations(repo, { [`${FAILURE}/c1`]: 'fail', [`${SUCCESS}/c1`]: 'pass', [`${SUCCESS}/c2`]: 'pass' }) });
  assert.equal(base.is_baseline, true);
  assert.ok(base.warnings.includes(legacyWarning([SUCCESS])), JSON.stringify(base.warnings));
  // Two packages in 1.0 are named in one warning.
  editChecks(repo, FAILURE, toLegacy);
  assert.deepEqual(validateEval(repo, CHANGE).warnings, [legacyWarning([FAILURE, SUCCESS])]);
});

test('checks.json 1.0 carries none of the 1.1 fields, and no other version is read', (t) => {
  const { repo } = readyProject(t, { check: false });
  const BELONG = `${SUCCESS}: then, then_group, kind, command, program, timeout_sec, absence of a check, scenario.manual, and origin, note, then, kind and patch of a fixture belong to checks.json 1.1. Set schema_version to "1.1", or remove them.`;
  for (const change of [
    (declared) => ({ ...declared, schema_version: '1.0' }),
    (declared) => ({ ...toLegacy(declared), scenario: { ...declared.scenario, manual: [] } }),
    (declared) => { const legacy = toLegacy(declared); legacy.fixtures[0].origin = 'author'; return legacy; },
    (declared) => { const legacy = toLegacy(declared); legacy.fixtures[0].note = '报告提交成功，只发出一条成功通知'; return legacy; },
  ]) {
    const before = readJSON(path.join(repo, '.genesis/edd', CHANGE, 'evals', SUCCESS, 'tests/checks.json'));
    editChecks(repo, SUCCESS, change);
    assert.deepEqual(invalid(repo), [BELONG]);
    editChecks(repo, SUCCESS, () => before);
  }
  editChecks(repo, SUCCESS, (declared) => ({ ...declared, schema_version: '2.0' }));
  assert.deepEqual(invalid(repo), [`${SUCCESS}: schema_version must be "1.0" or "1.1".`]);
});

test('a fixture of checks.json 1.1 says who wrote it with origin and what its script leaves with note', (t) => {
  const { repo } = readyProject(t, { check: false });
  const setFixture = (fields) => editChecks(repo, SUCCESS, (declared) => {
    for (const key of ['origin', 'note']) delete declared.fixtures[0][key];
    Object.assign(declared.fixtures[0], fields);
  });
  for (const origin of ['author', 'review', 'self-review', undefined]) {
    setFixture(origin ? { origin, note: '报告提交成功，只发出一条成功通知' } : {});
    assert.deepEqual(invalid(repo), [], origin);
  }
  setFixture({ origin: 'reviewer' });
  assert.deepEqual(invalid(repo), [`${SUCCESS}: fixture pass: origin must be author, review or self-review.`]);
  setFixture({ origin: 'author', note: ' ' });
  assert.deepEqual(invalid(repo), [`${SUCCESS}: fixture pass: note must be a sentence saying, in the words of the business, what result the script leaves.`]);
});

test('in the full tier a line a program checks needs a reviewer counterexample before its package is ready, and eval check proves the one a reviewer adds', (t) => {
  const { repo } = readyProject(t, { tier: 'full' });
  editChecks(repo, FAILURE, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.origin !== 'review'); });
  let result = validateEval(repo, CHANGE);
  assert.equal(result.tier.readiness, 'full');
  const failure = result.cases.find((item) => item.id === FAILURE);
  assert.equal(failure.integration.state, 'awaiting_integration');
  assert.deepEqual(failure.integration.missing, ['review']);
  assert.deepEqual(failure.integration.detail, [`review: no reviewer counterexample fails only "${LINE_FAILURE}"`]);
  assert.deepEqual(result.then_lines[0].counterexamples, []);
  assertGapShape(gapsOf(repo, 'integration_pending')[0], { case: FAILURE, missing: ['review'], layer: 'package', owner: 'agent' });
  // eval check proves what it can of the package; it stays waiting for the reviewer.
  const waiting = checkEval(repo, CHANGE);
  assert.deepEqual([waiting.passed, waiting.proved], [true, [FAILURE]]);
  assert.deepEqual(validateEval(repo, CHANGE).cases.find((item) => item.id === FAILURE).integration.missing, ['review']);

  editChecks(repo, FAILURE, (declared) => {
    declared.fixtures.push({ name: 'reviewed-notice', origin: 'review', note: '提交失败，却发出了一条成功通知', expect: { c1: 'fail' } });
  });
  writeFixtureScripts(repo, FAILURE, ['reviewed-notice']);
  result = validateEval(repo, CHANGE);
  assert.deepEqual(result.then_lines[0].counterexamples, [{ fixture: 'reviewed-notice', origin: 'review' }]);
  assert.deepEqual(result.cases.find((item) => item.id === FAILURE).integration.missing, ['check']);
  const proved = checkEval(repo, CHANGE);
  assert.equal(proved.passed, true);
  assert.deepEqual(proved.cases.map((item) => item.case), [FAILURE]);
  assert.ok(proved.cases[0].fixtures.some((fixture) => fixture.name === 'reviewed-notice' && fixture.ok));
  assert.equal(validateEval(repo, CHANGE).cases.find((item) => item.id === FAILURE).integration.state, 'ready');
});

test('a counterexample fails only its own line: it names every gating check, fails those of its line and no other, and a reviewer wrote it', (t) => {
  // The full tier asks for a counterexample before a package is ready.
  const { repo, root } = readyProject(t, { tier: 'full' });
  const original = readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json'));
  const lineOne = (fixture) => editChecks(repo, SUCCESS, () => {
    const declared = structuredClone(original);
    declared.fixtures = [...declared.fixtures.filter((entry) => entry.name !== 'review-c1'), fixture];
    return declared;
  });
  writeFixtureScripts(repo, SUCCESS, ['line-one']);
  const row = () => validateEval(repo, CHANGE).then_lines.find((entry) => entry.case === SUCCESS && entry.then === LINE_ONE);
  const missing = () => validateEval(repo, CHANGE).cases.find((item) => item.id === SUCCESS).integration.missing;
  for (const fixture of [
    // It also fails the other line.
    { name: 'line-one', origin: 'review', note: '只发出了失败通知', expect: { c1: 'fail', c2: 'fail' } },
    // The author wrote it, said so or not.
    { name: 'line-one', origin: 'author', note: '没有发出成功通知', expect: { c1: 'fail', c2: 'pass' } },
    { name: 'line-one', note: '没有发出成功通知', expect: { c1: 'fail', c2: 'pass' } },
    // It says nothing of the other gating check.
    { name: 'line-one', origin: 'review', note: '没有发出成功通知', expect: { c1: 'fail' } },
  ]) {
    lineOne(fixture);
    assert.deepEqual(row().counterexamples, [], JSON.stringify(fixture));
    assert.ok(missing().includes('review'), JSON.stringify(fixture));
  }
  for (const [origin, other] of [['self-review', 'pass'], ['review', 'unknown']]) {
    lineOne({ name: 'line-one', origin, note: '没有发出成功通知', expect: { c1: 'fail', c2: other } });
    assert.deepEqual(row().counterexamples, [{ fixture: 'line-one', origin }], origin);
    assert.ok(!missing().includes('review'), origin);
  }
});

test('a package whose every line the user judges needs no counterexample, nor does a 1.0 package, which is told eval confirm needs 1.1', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => ({ ...declared, checks: [], fixtures: [],
    scenario: { ...declared.scenario, manual: [LINE_ONE, LINE_NONE].map((then) => ({ then, reason: 'synthetic' })) } }));
  editChecks(repo, FAILURE, (declared) => toLegacy({ ...declared, fixtures: declared.fixtures.filter((fixture) => FIXTURES.includes(fixture.name)) }));
  const result = validateEval(repo, CHANGE);
  for (const id of [FAILURE, SUCCESS]) assert.deepEqual(result.cases.find((item) => item.id === id).integration.missing, ['check'], id);
  assert.deepEqual(result.then_lines.map((row) => [row.case, row.status, row.counterexamples]), [[FAILURE, 'unbound', []], [SUCCESS, 'manual', []], [SUCCESS, 'manual', []]]);
  assert.ok(result.warnings.includes(legacyWarning([FAILURE])), JSON.stringify(result.warnings));
  assert.ok(legacyWarning([FAILURE]).includes('and it has no reviewer counterexamples. `eval confirm` needs 1.1'));
});

test('a line written twice in a scenario gets a check each from eval new, counts as one line, and is reported', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  writeSpec(repo, SPECS.two.replace('revision: 1', 'revision: 2').replace(`- **AND** ${LINE_NONE}`, `- **AND** ${LINE_NONE}\n- **AND** ${LINE_NONE}`));
  exportSpec(repo, CHANGE);
  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  restamp(root, exportSpec(repo, CHANGE).id);
  assert.deepEqual(newEval(repo, CHANGE).created, [SUCCESS]);
  const declared = readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json'));
  assert.deepEqual(declared.checks.map((check) => [check.id, check.then]), [['c1', LINE_ONE], ['c2', LINE_NONE], ['c3', LINE_NONE]]);
  const result = validateEval(repo, CHANGE);
  assert.deepEqual(result.then_lines.filter((row) => row.case === SUCCESS).map((row) => [row.then, row.gating.map((entry) => entry.check)]), [[LINE_ONE, ['c1']], [LINE_NONE, ['c2', 'c3']]]);
  assert.ok(result.warnings.includes(`Scenario "提交成功" of REQ-submit-success lists "${LINE_NONE}" more than once. Checks bind the text, so the copies count as one line.`), JSON.stringify(result.warnings));
});

test('the example packages are checks.json 1.1: each then is a THEN line of the example Spec, and each fixture has origin and note', () => {
  const example = path.join(ROOT, 'skills/write-eval/examples/reportbot');
  const file = path.join(example, 'openspec/changes/report-submission-notifications/specs/submission-notifications/spec.md');
  const requirements = specRequirements([{ path: file, content: readFileSync(file, 'utf8') }]);
  const evals = path.join(example, '.genesis/edd/report-submission-notifications/evals');
  const ids = readdirSync(evals).sort();
  assert.deepEqual(ids, [FAILURE, SUCCESS]);
  for (const id of ids) {
    const declared = readJSON(path.join(evals, id, 'tests/checks.json'));
    assert.equal(declared.schema_version, '1.1', id);
    assert.deepEqual(declared.scenario.manual, [], id);
    const scenario = requirements.find((requirement) => requirement.id === declared.scenario.requirement).scenarios.find((entry) => entry.name === declared.scenario.name);
    const gating = declared.checks.filter((check) => check.role === 'gating');
    assert.deepEqual(gating.map((check) => check.then).sort(), [...scenario.then].sort(), id);
    assert.ok(gating.every((check) => check.intent === declared.scenario.requirement), id);
    assert.ok(declared.fixtures.length > 0 && declared.fixtures.every((fixture) => fixture.origin === 'author' && typeof fixture.note === 'string' && fixture.note.trim()), id);
  }
});

// Expected results must stay out of the agent's image.

// Each place where an environment hands the evaluated program what decides
// its result is an expected_results_exposed gap of its package, which no
// confirmation or run takes.
const exposed = (repo) => gapsOf(repo, 'expected_results_exposed').map((gap) => gap.message);
const evalsOf = (id) => `.genesis/edd/${CHANGE}/evals/${id}`;
const ROOT_BUILD = (id, file, source) => `${id}: ${file}: service main builds from ${source}, the project root, and the project's .dockerignore has no .genesis rule, so every package's tests and the user's records would be in the image.`;
const OWN_COMPOSE = (id) => `${evalsOf(id)}/environment/docker-compose.yaml`;
const NAMES_RESULTS = (id, file) => `${id}: ${file} names checks.json, ../tests or ../solution: expected results and the reference solution stay out of the evaluated program's reach.`;
const compose = (context) => `services:
  main:
    build:
      context: ${context}
      dockerfile: .genesis/edd/harness/environment/Dockerfile
    depends_on:
      api:
        condition: service_healthy
  api:
    image: python:3.12-slim
    configs:
      - source: simulator
        target: /opt/simulator.py
configs:
  simulator:
    file: \${GENESIS_EDD_HARNESS}/environment/simulator.py
`;
// The same build kept in an x- fragment that the service takes in through a
// merge key, as Compose allows, beside one of Compose's own tags.
const merged = (context) => `x-build: &build
  build:
    context: ${context}
    dockerfile: .genesis/edd/harness/environment/Dockerfile
services:
  main:
    <<: *build
    ports: !reset []
`;

// readyProject with the documented layout: the kit's Dockerfile, a stand-in in
// the kit, and each package's compose file building from the project root.
function documentedProject(t, dockerignore = '**\n!app/\n.genesis\n') {
  const project = readyProject(t, { check: false });
  const kit = path.join(project.repo, '.genesis/edd/harness/environment');
  mkdirSync(kit, { recursive: true });
  writeFileSync(path.join(kit, 'Dockerfile'), 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\n');
  writeFileSync(path.join(kit, 'simulator.py'), 'print("tests/checks.json is read by the verifier, not here")\n');
  for (const id of [FAILURE, SUCCESS]) {
    const environment = path.join(project.root, 'evals', id, 'environment');
    rmSync(path.join(environment, 'Dockerfile'));
    writeFileSync(path.join(environment, 'docker-compose.yaml'), compose('${GENESIS_EDD_REPO}'));
  }
  if (dockerignore !== null) writeFileSync(path.join(project.repo, '.dockerignore'), dockerignore);
  return { ...project, kit, setCompose: (id, context, write = compose) => writeFileSync(path.join(project.root, 'evals', id, 'environment/docker-compose.yaml'), write(context)) };
}

test('the documented environment, which builds from the project root with .genesis in .dockerignore, passes the leak checks', (t) => {
  const { repo } = documentedProject(t);
  assert.deepEqual([invalid(repo), exposed(repo)], [[], []]);
  assert.equal(validateEval(repo, CHANGE).valid, true);
  for (const ignore of ['.genesis/\n', '/.genesis\n']) {
    writeFileSync(path.join(repo, '.dockerignore'), ignore);
    assert.deepEqual([invalid(repo), exposed(repo)], [[], []], ignore);
  }
});

test('a build from the project root without .genesis in .dockerignore exposes the expected results, by variable or by a relative path', (t) => {
  const { repo, setCompose } = documentedProject(t, null);
  assert.deepEqual(exposed(repo), [ROOT_BUILD(FAILURE, OWN_COMPOSE(FAILURE), '${GENESIS_EDD_REPO}'), ROOT_BUILD(SUCCESS, OWN_COMPOSE(SUCCESS), '${GENESIS_EDD_REPO}')]);
  const result = validateEval(repo, CHANGE);
  assert.equal(result.valid, false);
  assertGapShape(result.gaps.find((gap) => gap.code === 'expected_results_exposed'), { case: FAILURE, owner: 'agent', layer: 'package', path: OWN_COMPOSE(FAILURE),
    service: 'main', source: '${GENESIS_EDD_REPO}' });
  writeFileSync(path.join(repo, '.dockerignore'), '**\n!app/\n');
  // Harbor runs Compose from the package's environment/ folder, six levels below the project.
  for (const write of [compose, merged]) {
    setCompose(FAILURE, '../../../../../..', write);
    setCompose(SUCCESS, '${GENESIS_EDD_HARNESS}/../../..', write);
    assert.deepEqual(exposed(repo), [ROOT_BUILD(FAILURE, OWN_COMPOSE(FAILURE), '../../../../../..'), ROOT_BUILD(SUCCESS, OWN_COMPOSE(SUCCESS), '${GENESIS_EDD_HARNESS}/../../..')], write.name);
  }
  writeFileSync(path.join(repo, '.dockerignore'), '**\n!app/\n.genesis\n');
  assert.deepEqual(exposed(repo), []);
});

test('a build context that holds the package other than the project root exposes the expected results whatever .dockerignore says', (t) => {
  const { repo, setCompose } = documentedProject(t);
  // Compose's own tags are read without a warning from the YAML parser.
  const warnings = t.mock.method(process, 'emitWarning', () => {});
  const reaches = (id, source) => `${id}: ${OWN_COMPOSE(id)}: service main builds from ${source}, which reaches .genesis/edd, where the packages' tests, the kit's verifier code and the user's records are.`;
  for (const write of [compose, merged]) {
    setCompose(FAILURE, '..', write);
    setCompose(SUCCESS, '${GENESIS_EDD_HARNESS}/..', write);
    assert.deepEqual(exposed(repo), [reaches(FAILURE, '..'), reaches(SUCCESS, '${GENESIS_EDD_HARNESS}/..')], write.name);
    // The kit, or the package's own environment/, holds no expected results.
    setCompose(FAILURE, '${GENESIS_EDD_HARNESS}', write);
    setCompose(SUCCESS, '.', write);
    assert.deepEqual(exposed(repo), [], write.name);
  }
  assert.equal(warnings.mock.callCount(), 0, JSON.stringify(warnings.mock.calls.map((call) => String(call.arguments[0]))));
});

test('a package or kit environment file that names tests/, solution/ or checks.json exposes the expected results', (t) => {
  const { repo, root, kit } = documentedProject(t);
  const dockerfile = path.join(root, 'evals', FAILURE, 'environment/Dockerfile');
  writeFileSync(dockerfile, 'FROM alpine:3.20\nCOPY ../tests /opt/tests\n');
  assert.deepEqual(exposed(repo), [NAMES_RESULTS(FAILURE, `${evalsOf(FAILURE)}/environment/Dockerfile`)]);
  writeFileSync(dockerfile, 'FROM alpine:3.20\nCOPY ../../solution /opt/solution\n');
  assert.deepEqual(exposed(repo), [NAMES_RESULTS(FAILURE, `${evalsOf(FAILURE)}/environment/Dockerfile`)]);
  rmSync(dockerfile);

  // The kit's environment is shared, so every package that builds with it is named.
  writeFileSync(path.join(kit, 'Dockerfile'), 'FROM python:3.12-slim\nCOPY .genesis/edd/report-notifications/evals/submit-failure-s1/tests/checks.json /opt/\n');
  assert.deepEqual(exposed(repo), [NAMES_RESULTS(FAILURE, '.genesis/edd/harness/environment/Dockerfile'), NAMES_RESULTS(SUCCESS, '.genesis/edd/harness/environment/Dockerfile')]);
  assert.deepEqual(gapsOf(repo, 'expected_results_exposed').map((gap) => [gap.case, gap.path]),
    [[FAILURE, '.genesis/edd/harness/environment/Dockerfile'], [SUCCESS, '.genesis/edd/harness/environment/Dockerfile']]);
});

test('a Compose file in the kit that builds from the project root needs .genesis in .dockerignore too', (t) => {
  const { repo, kit } = documentedProject(t);
  const base = '.genesis/edd/harness/environment/docker-compose.base.yaml';
  writeFileSync(path.join(kit, 'docker-compose.base.yaml'), compose('../../../..'));
  assert.deepEqual(exposed(repo), []);
  writeFileSync(path.join(repo, '.dockerignore'), '**\n!app/\n');
  // Each package's own compose file and the kit's are named.
  assert.deepEqual(exposed(repo), [ROOT_BUILD(FAILURE, OWN_COMPOSE(FAILURE), '${GENESIS_EDD_REPO}'), ROOT_BUILD(FAILURE, base, '../../../..'),
    ROOT_BUILD(SUCCESS, OWN_COMPOSE(SUCCESS), '${GENESIS_EDD_REPO}'), ROOT_BUILD(SUCCESS, base, '../../../..')]);
});

// Package identity.

test('files the OS or an editor leaves in a package or the kit change no task_digest, and the last eval check still counts', (t) => {
  const { repo, root } = readyProject(t);
  const digests = () => Object.fromEntries(validateEval(repo, CHANGE).cases.map((item) => [item.id, item.task_digest]));
  const before = digests();
  const recorded = Object.fromEntries([FAILURE, SUCCESS].map((id) => [id, readJSON(path.join(root, 'checks', id, 'check.json')).task_digest]));
  assert.deepEqual(before, recorded);
  const kit = path.join(repo, '.genesis/edd/harness');
  const leftovers = [
    path.join(kit, '.DS_Store'), path.join(kit, 'verifier/Thumbs.db'), path.join(kit, 'harness.json~'),
    path.join(root, 'evals', FAILURE, '.DS_Store'), path.join(root, 'evals', FAILURE, 'tests/.test.sh.swp'),
    path.join(root, 'evals', FAILURE, 'tests/shared/.DS_Store'), path.join(root, 'evals', SUCCESS, 'environment/Dockerfile~'),
    path.join(root, 'evals', SUCCESS, 'tests/checks.json.swo'),
  ];
  for (const file of leftovers) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'left by an editor\n');
  }
  assert.deepEqual(digests(), before);
  const result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps, []);
  assert.ok(result.cases.every((item) => item.integration.state === 'ready'), JSON.stringify(result.cases));
  assert.deepEqual(newEval(repo, CHANGE).out_of_line, []);
  assert.deepEqual(checkEval(repo, CHANGE).already_proved, [FAILURE, SUCCESS]);

  // A file that does take part in a run still changes the digest.
  writeFileSync(path.join(root, 'evals', SUCCESS, 'environment/seed.txt'), 'seed\n');
  assert.notEqual(digests()[SUCCESS], before[SUCCESS]);
  assert.equal(digests()[FAILURE], before[FAILURE]);
});

test('the eval snapshot lists every file a run executes of each package and the kit, with the task digest eval validate reports', (t) => {
  const { repo, root } = readyProject(t);
  const snapshot = evalSnapshot(repo, CHANGE);
  assert.deepEqual(snapshot.task_digest, Object.fromEntries(validateEval(repo, CHANGE).cases.map((item) => [item.id, item.task_digest])));
  assert.deepEqual(Object.keys(snapshot.packages), [FAILURE, SUCCESS]);
  for (const id of [FAILURE, SUCCESS]) {
    const files = Object.keys(snapshot.packages[id]);
    for (const file of ['task.toml', 'instruction.md', 'tests/checks.json', 'tests/test.sh', 'tests/genesis.sh', 'tests/fixtures/pass.sh',
      'tests/fixtures/fail.sh', 'tests/fixtures/unknown.sh', 'environment/Dockerfile']) assert.ok(files.includes(file), `${id}: ${file} in ${files}`);
    assert.ok(!files.includes('Task.md'), files.join(', '));
    assert.ok(Object.values(snapshot.packages[id]).every((value) => /^sha256:[0-9a-f]{64}$/.test(value)), JSON.stringify(snapshot.packages[id]));
  }
  assert.deepEqual(snapshot.packages[SUCCESS]['environment/Dockerfile'], sha256(readFileSync(path.join(root, 'evals', SUCCESS, 'environment/Dockerfile'))));
  assert.ok('harness.json' in snapshot.kit, JSON.stringify(snapshot.kit));
  assert.ok(!('PROJECT.md' in snapshot.kit), JSON.stringify(snapshot.kit));
  assert.ok(Object.keys(snapshot.kit).every((file) => !file.startsWith('kit/')), JSON.stringify(snapshot.kit));

  // Leftovers and Python caches are no part of a run.
  const kit = path.join(repo, '.genesis/edd/harness');
  for (const file of [path.join(kit, '.DS_Store'), path.join(kit, 'verifier/__pycache__/shared.cpython-312.pyc'),
    path.join(root, 'evals', FAILURE, '.DS_Store'), path.join(root, 'evals', SUCCESS, 'tests/__pycache__/check.cpython-312.pyc')]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'not part of a run\n');
  }
  // What each package checks is the next test's.
  const { check_digest: checked, ...rest } = evalSnapshot(repo, CHANGE);
  const { check_digest: before, ...was } = snapshot;
  assert.deepEqual(rest, was);
  assert.deepEqual(Object.keys(checked), Object.keys(before));
});

// What a package checks (check_digest), which a reviewer's verdicts carry
// over on, leaves out Python caches as every other digest of the package does.
test('the check digest of a package leaves out Python caches in the kit\'s verifier/', (t) => {
  const { repo } = readyProject(t);
  const before = evalSnapshot(repo, CHANGE).check_digest;
  const file = path.join(repo, '.genesis/edd/harness/verifier/__pycache__/shared.cpython-312.pyc');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'not part of a run\n');
  assert.deepEqual(evalSnapshot(repo, CHANGE).check_digest, before);
});

test('eval validate marks a package live only when it declares a live dependency, and the kit settings name its agent and model', (t) => {
  const { repo, root } = readyProject(t, { live: ['submit-success-s1'], model: 'synthetic/model-1', check: false });
  assert.deepEqual(validateEval(repo, CHANGE).cases.map((item) => [item.id, item.live]), [['submit-failure-s1', false], ['submit-success-s1', true]]);
  const file = path.join(root, 'evals', 'submit-failure-s1', 'tests/checks.json');
  const declared = readJSON(file);
  declared.dependencies = [{ name: 'documents', mode: 'frozen' }, { name: 'tickets', mode: 'simulated' }];
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  assert.equal(validateEval(repo, CHANGE).cases.find((item) => item.id === 'submit-failure-s1').live, false);
  assert.deepEqual([isLive([{ name: 'model', mode: 'live' }]), isLive([]), isLive(undefined)], [true, false, false]);
  assert.deepEqual(kitSettings(repo), { agent: 'app_agent:AppAgent', model: 'synthetic/model-1' });
  writeFileSync(path.join(repo, '.genesis/edd/harness/harness.json'), '{');
  assert.deepEqual(kitSettings(repo), { agent: null, model: null });
});
