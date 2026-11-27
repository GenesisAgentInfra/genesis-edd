import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, listFiles, readJSON } from '../src/project.js';
import { exportSpec, specRequirements } from '../src/spec.js';
import { evalSnapshot, isLive, kitSettings, legacyPackages, manualLines, newEval, thenKey, validateEval } from '../src/eval.js';
import { checkEval, startRun } from '../src/run.js';
import { checkWorkflow } from '../src/workflow.js';
import {
  CHANGE, FIXTURES, SPECS, cli, dropCheck, editChecks, legacyWarning, readyProject, toLegacy, writeExpectations, writeFixtureScripts, writeSpec,
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

test('eval new writes a package for a scenario inserted before another under the next free number, and keeps only folders that exist', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  const before = readFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), 'utf8');
  writeSpec(repo, INSERTED);
  const exported = exportSpec(repo, CHANGE);
  // The folder the new scenario would take holds the package of the scenario
  // after it, which keeps its folder.
  let workflow = checkWorkflow(repo, 'write-eval', CHANGE);
  assert.equal(workflow.next.action, 'write_eval');
  assert.deepEqual(workflow.next.command, ['eval', 'new', CHANGE, '--repo', repo]);

  const written = newEval(repo, CHANGE);
  assert.deepEqual(written.created, ['submit-failure-s2']);
  assert.deepEqual(written.kept, [FAILURE, SUCCESS]);
  assert.ok([...written.created, ...written.kept].every((id) => existsSync(path.join(root, 'evals', id))));
  assert.deepEqual(folders(root), [FAILURE, 'submit-failure-s2', SUCCESS]);
  assert.equal(readFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), 'utf8'), before);
  const declared = readJSON(path.join(root, 'evals/submit-failure-s2/tests/checks.json'));
  assert.deepEqual(declared.scenario, { requirement: 'REQ-submit-failure', name: '提交超时', manual: [] });
  assert.equal(declared.spec_ref.sha256, exported.id);
  assert.deepEqual(declared.checks.map((check) => check.expect), ['本次提交发送的成功通知数量为零']);
  assert.match(readFileSync(path.join(root, 'evals/submit-failure-s2/task.toml'), 'utf8'), /name = "genesis-edd\/report-notifications--submit-failure-s2"/);

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

  // Nothing is left for eval new: workflow check points at eval validate.
  workflow = checkWorkflow(repo, 'write-eval', CHANGE);
  assert.equal(workflow.status, 'ready');
  assert.equal(workflow.next.action, 'finish_evals');
  assert.deepEqual(workflow.next.command, ['eval', 'validate', CHANGE, '--repo', repo]);
  assert.match(workflow.next.note, /`eval check` proves the finished ones/);
});

// Why eval new writes nothing, and workflow check write-eval sends the agent
// to eval validate, while folders under evals/ name no scenario.
const PROBLEM = `${FAILURE}: tests/checks.json cannot be read or names no scenario, so \`eval new\` cannot tell which scenario this folder was written for, and a new package could duplicate it.`;
const REPAIR = 'Repair its tests/checks.json, or delete the folder if it is not a package; `eval validate` reports it as case_invalid and says what is wrong.';
const REFUSAL = `${PROBLEM} Nothing was written. ${REPAIR} Then run \`eval new\` again.`;

// eval new refuses whenever such a folder exists, also when every scenario has
// a package, so it never guesses which scenario a folder was written for.
test('eval new writes nothing while a checks.json cannot be read, even when nothing was inserted before that package, and workflow check sends the agent to eval validate', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  writeFileSync(path.join(root, 'evals', FAILURE, 'tests/checks.json'), '{ not json');
  assert.throws(() => newEval(repo, CHANGE), { message: REFUSAL });
  assert.deepEqual(folders(root), [FAILURE, SUCCESS]);
  assert.match(invalid(repo).join('\n'), /submit-failure-s1: tests\/checks\.json is missing or not a JSON object/);
  const workflow = checkWorkflow(repo, 'write-eval', CHANGE);
  assert.equal(workflow.status, 'ready');
  assert.equal(workflow.next.action, 'finish_evals');
  assert.deepEqual(workflow.next.command, ['eval', 'validate', CHANGE, '--repo', repo]);
  assert.equal(workflow.next.note, `${PROBLEM} ${REPAIR} \`eval new\` writes nothing until then.`);
});

test('eval new writes nothing while a folder under evals/ is not a package, even when every scenario has a package that names it', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  mkdirSync(path.join(root, 'evals', 'old-notes'));
  writeFileSync(path.join(root, 'evals', 'old-notes', 'notes.md'), 'Notes from an earlier try.\n');
  const snapshot = () => listFiles(path.join(repo, '.genesis/edd')).map((entry) => `${entry}\n${readFileSync(entry, 'utf8')}`);
  const before = snapshot();
  const problem = PROBLEM.replace(FAILURE, 'old-notes');
  assert.throws(() => newEval(repo, CHANGE), { message: `${problem} Nothing was written. ${REPAIR} Then run \`eval new\` again.` });
  assert.deepEqual(snapshot(), before);
  const workflow = checkWorkflow(repo, 'write-eval', CHANGE);
  assert.equal(workflow.next.action, 'finish_evals');
  assert.equal(workflow.next.note, `${problem} ${REPAIR} \`eval new\` writes nothing until then.`);
  rmSync(path.join(root, 'evals', 'old-notes'), { recursive: true });
  assert.deepEqual(newEval(repo, CHANGE).created, []);
});

test('eval new writes nothing while a checks.json cannot be read or names no scenario after a scenario was inserted, and names every such folder', (t) => {
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
    assert.throws(() => newEval(repo, CHANGE), { message: REFUSAL }, broken);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(folders(root), [FAILURE, SUCCESS]);
    assert.equal(checkWorkflow(repo, 'write-eval', CHANGE).next.action, 'finish_evals', broken);
  }
  assert.deepEqual(scenario, { requirement: 'REQ-submit-failure', name: '提交失败', manual: [] });

  // A folder that is not a package at all is named too, beside a broken one.
  mkdirSync(path.join(root, 'evals', 'old-notes'));
  writeFileSync(path.join(root, 'evals', 'old-notes', 'notes.md'), 'Notes from an earlier try.\n');
  const several = `old-notes, ${FAILURE}: tests/checks.json cannot be read or names no scenario, so \`eval new\` cannot tell which scenario these folders were written for, and a new package could duplicate one.`;
  const each = 'Repair each tests/checks.json, or delete a folder that is not a package; `eval validate` reports them as case_invalid and says what is wrong.';
  assert.throws(() => newEval(repo, CHANGE), { message: `${several} Nothing was written. ${each} Then run \`eval new\` again.` });
  assert.equal(checkWorkflow(repo, 'write-eval', CHANGE).next.note, `${several} ${each} \`eval new\` writes nothing until then.`);
  assert.deepEqual(gapsOf(repo, 'case_invalid').map((gap) => gap.case), ['old-notes', FAILURE]);

  // Once repaired, the package keeps its scenario and the new one gets its own.
  rmSync(path.join(root, 'evals', 'old-notes'), { recursive: true });
  writeFileSync(file, original);
  assert.equal(checkWorkflow(repo, 'write-eval', CHANGE).next.action, 'write_eval');
  const written = newEval(repo, CHANGE);
  assert.deepEqual(written.created, ['submit-failure-s2']);
  assert.deepEqual(written.kept, [FAILURE, SUCCESS]);
  assert.deepEqual(readJSON(path.join(root, 'evals/submit-failure-s2/tests/checks.json')).scenario, { requirement: 'REQ-submit-failure', name: '提交超时', manual: [] });
});

test('workflow check write-eval proposes eval new until every scenario has a package', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  assert.equal(checkWorkflow(repo, 'write-eval', CHANGE).next.action, 'finish_evals');
  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  const workflow = checkWorkflow(repo, 'write-eval', CHANGE);
  assert.equal(workflow.next.action, 'write_eval');
  assert.deepEqual(newEval(repo, CHANGE).created, [SUCCESS]);
  assert.equal(checkWorkflow(repo, 'write-eval', CHANGE).next.action, 'finish_evals');
});

test('eval check refused for missing tools or for its packages resumes at write-eval', (t) => {
  const { repo, root, tools } = readyProject(t);
  const resume = { stage: 'write-eval', change: CHANGE, command: ['workflow', 'check', 'write-eval', CHANGE, '--repo', repo] };
  const refused = (code) => (error) => {
    assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
    assert.ok(codes(error.gaps).includes(code), JSON.stringify(error.gaps));
    assert.deepEqual(error.resume, resume);
    return true;
  };
  // A finished package to prove again while Docker is down.
  const file = path.join(root, 'evals', FAILURE, 'environment/Dockerfile');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RUN true\n`);
  tools.docker(false);
  assert.throws(() => checkEval(repo, CHANGE), refused('docker_unavailable'));
  tools.docker(true);

  // A scenario without a package.
  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  assert.throws(() => checkEval(repo, CHANGE), refused('scenario_uncovered'));
  const shown = cli(['eval', 'check', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 1);
  assert.deepEqual(shown.json.resume, resume);
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
  assert.deepEqual(stale.map((gap) => [gap.case, gap.route, gap.owner]), [[FAILURE, 'write-eval', 'agent'], [SUCCESS, 'write-eval', 'agent']]);
  assert.match(stale[0].message, /was written for another Spec export\. Review it against the current requirements, then update spec_ref/);
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 0, requirements_without_gating_check: ['REQ-submit-failure', 'REQ-submit-success'],
    lines: { total: 0, gating: 0, manual: 0, uncovered: 0, unbound: 0 } });
  assert.deepEqual(result.then_lines, []);
  assert.deepEqual(gapsOf(repo, 'then_uncovered'), []);
  assert.match(stale[0].message, /Check that each then and scenario\.manual entry still names a line of the current scenario\.$/);
  // eval new rewrites nothing a package owns: the old expectation stays until reviewed.
  assert.deepEqual(newEval(repo, CHANGE).created, []);
  assert.deepEqual(readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json')).checks[0].expect, '本次提交发送的成功通知数量为一');
  restamp(root, exported.id);
  // Its check still names the line of the earlier export.
  assert.deepEqual(codes(validateEval(repo, CHANGE).gaps).filter((code) => code !== 'integration_pending'), ['case_invalid', 'then_uncovered']);
  assert.match(invalid(repo)[0], /^submit-success-s1: check c1: then "本次提交发送的成功通知数量为一" is not a THEN or AND line of scenario "提交成功"\. Copy one of its lines exactly: "本次提交只发送一条成功通知"/);
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
    code: 'requirement_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: 'REQ-submit-success',
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
    code: 'scenario_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: 'REQ-submit-success',
    message: 'No package for scenario "提交成功" of REQ-submit-success.' });
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 1, requirements_without_gating_check: ['REQ-submit-success'],
    lines: { total: 1, gating: 1, manual: 0, uncovered: 0, unbound: 0 } });
});

// Line coverage: checks.json 1.1 binds each check to the THEN or AND line it verifies.

const LINE_FAILURE = '本次提交发送的成功通知数量为零';
const LINE_ONE = '本次提交发送的成功通知数量为一';
const LINE_NONE = '本次提交发送的失败通知数量为零';
const rowsOf = (result) => result.then_lines.map((row) => [row.case, row.then, row.status]);
const uncoveredMessage = (id, line, scenario) => `${id}: no gating check verifies "${line}" of scenario "${scenario}". Add a gating check with this line as its then. If no program can judge the line, such as tone or the quality of an answer, list it in scenario.manual with the reason. A diagnostic check does not cover a line.`;
const NOT_A_LINE = (value, hint = '') => `${SUCCESS}: check c2: then "${value}" is not a THEN or AND line of scenario "提交成功".${hint} Copy one of its lines exactly: "${LINE_ONE}", "${LINE_NONE}".`;
const manualWarning = (entries) => `The user judges ${entries.length === 1 ? 'this THEN line' : 'these THEN lines'} at acceptance, since no check verifies ${entries.length === 1 ? 'it' : 'them'}: ${entries.map(([id, line, reason]) => `"${line}" in ${id} (${reason})`).join('; ')}. Tell the user before the baseline. A line a program can judge needs a gating check instead.`;
const NO_GATING = 'No package of this change has a gating check: the user judges every THEN line. A run passes only on gating checks, so no run of this change can pass, and `loop start` refuses it (gating_missing). Tell the user.';

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
    { case: FAILURE, requirement: 'REQ-submit-failure', scenario: '提交失败', then: LINE_FAILURE, status: 'gating', gating: [{ check: 'c1', expect: LINE_FAILURE }], diagnostic: [],
      counterexamples: [{ fixture: 'review-c1', origin: 'review' }] },
    { case: SUCCESS, requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_ONE, status: 'gating', gating: [{ check: 'c1', expect: LINE_ONE }], diagnostic: [],
      counterexamples: [{ fixture: 'review-c1', origin: 'review' }] },
    { case: SUCCESS, requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_NONE, status: 'gating', gating: [{ check: 'c2', expect: LINE_NONE }], diagnostic: [],
      counterexamples: [{ fixture: 'review-c2', origin: 'review' }] },
  ]);
  assert.deepEqual(result.cases.map((item) => [item.id, item.schema_version, item.manual, 'lines' in item]), [[FAILURE, '1.1', 0, false], [SUCCESS, '1.1', 0, false]]);
  assert.deepEqual([legacyPackages(result), manualLines(result)], [[], []]);
  assert.equal(newEval(repo, CHANGE).note, 'Each check names the THEN or AND line it verifies in then, and its expect starts as that line. Make expect concrete and keep then. A line no program can judge goes into scenario.manual with the reason. Build the project kit first, then each package; a package can run once `eval check` has proved its verifier.');
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
    assert.deepEqual(invalid(repo), [NOT_A_LINE(value, ' Leave out the THEN or AND keyword.')], value);
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
  assert.deepEqual(invalid(repo), [`${SUCCESS}: check c2: then is one line, not a list. A check verifies exactly one THEN or AND line: split it into one check per line, or, when the lines can only fail together, merge them into one line in the Spec with agent-spec.`]);
  for (const value of ['', '  ', 3]) {
    editChecks(repo, SUCCESS, (declared) => { declared.checks[1].then = value; });
    assert.deepEqual(invalid(repo), [`${SUCCESS}: check c2: then must be one THEN or AND line of the scenario.`], JSON.stringify(value));
  }
});

test('deleting the only gating check of a line leaves it uncovered, which blocks eval validate, eval check and run start', (t) => {
  const { repo } = readyProject(t);
  editChecks(repo, SUCCESS, (declared) => dropCheck(declared, 'c2'));
  const result = validateEval(repo, CHANGE);
  assert.equal(result.valid, false);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending'), [{
    code: 'then_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', case: SUCCESS, requirement_id: 'REQ-submit-success',
    scenario: '提交成功', then: LINE_NONE, message: uncoveredMessage(SUCCESS, LINE_NONE, '提交成功') }]);
  assert.deepEqual(result.coverage.lines, { total: 3, gating: 2, manual: 0, uncovered: 1, unbound: 0 });
  assert.deepEqual(result.then_lines.at(-1), { case: SUCCESS, requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_NONE, status: 'uncovered', gating: [], diagnostic: [],
    counterexamples: [] });
  const refused = (error) => {
    assert.equal(error.code, 'RUN_INPUT_BLOCKED', error.message);
    assert.deepEqual(codes(error.gaps), ['then_uncovered']);
    return true;
  };
  assert.throws(() => checkEval(repo, CHANGE), refused);
  assert.throws(() => startRun(repo, CHANGE, { baseline: true }), refused);
  const shown = cli(['eval', 'validate', CHANGE, '--repo', repo]);
  assert.equal(shown.status, 1);
  assert.deepEqual(codes(shown.json.gaps).filter((code) => code !== 'integration_pending'), ['then_uncovered']);
  const workflow = checkWorkflow(repo, 'run-eval', CHANGE);
  assert.equal(workflow.status, 'blocked');
  assert.deepEqual(codes(workflow.gaps), ['then_uncovered']);
});

test('a diagnostic check that cites a line covers nothing, and two gating checks may verify one line', (t) => {
  const { repo } = readyProject(t, { check: false });
  editChecks(repo, SUCCESS, (declared) => { declared.checks[1].role = 'diagnostic'; });
  let result = validateEval(repo, CHANGE);
  assert.deepEqual(result.gaps.filter((gap) => gap.code !== 'integration_pending').map((gap) => [gap.code, gap.then]), [['then_uncovered', LINE_NONE]]);
  assert.deepEqual(result.then_lines.at(-1), { case: SUCCESS, requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_NONE, status: 'uncovered', gating: [],
    diagnostic: [{ check: 'c2', expect: LINE_NONE }], counterexamples: [] });

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
  assert.deepEqual(invalid(repo), [`${SUCCESS}: check c3 cites REQ-unknown, which is not in the exported Spec. Every check needs a source.`]);
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
  assert.deepEqual(result.then_lines.at(-1), { case: SUCCESS, requirement: 'REQ-submit-success', scenario: '提交成功', then: LINE_NONE, status: 'manual',
    gating: [], diagnostic: [], reason: 'synthetic: judged by a person', counterexamples: [] });
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
  assert.deepEqual(invalid(repo), [`${SUCCESS}: scenario.manual entry 1: then "失败通知数量为零" is not a THEN or AND line of scenario "提交成功". Copy one of its lines exactly: "${LINE_ONE}", "${LINE_NONE}".`]);
  setManual([{ then: LINE_NONE }], true);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: scenario.manual entry 1 needs reason: why no program can judge the line.`, `${SUCCESS}: "${LINE_NONE}" is in scenario.manual and verified by gating check c2. A line is judged by a check or by the user, not both: keep one.`]);
  setManual([{ then: LINE_NONE, reason: 'synthetic' }, { then: ` ${LINE_NONE}`, reason: 'again' }], true);
  assert.ok(invalid(repo).includes(`${SUCCESS}: scenario.manual entry 2: "${LINE_NONE}" is in scenario.manual more than once. List each line once.`), invalid(repo).join('\n'));
  setManual([{ then: LINE_NONE, reason: 'synthetic' }], true);
  assert.deepEqual(invalid(repo), [`${SUCCESS}: "${LINE_NONE}" is in scenario.manual and verified by gating check c2. A line is judged by a check or by the user, not both: keep one.`]);
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
  const BELONG = `${SUCCESS}: then, scenario.manual and fixtures[].origin and note belong to checks.json 1.1. Set schema_version to "1.1", or remove them.`;
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

test('a line a program checks needs a reviewer counterexample before its package is ready, and eval check proves the one a reviewer adds', (t) => {
  const { repo } = readyProject(t, { confirm: false });
  editChecks(repo, FAILURE, (declared) => { declared.fixtures = declared.fixtures.filter((fixture) => fixture.origin !== 'review'); });
  let result = validateEval(repo, CHANGE);
  const failure = result.cases.find((item) => item.id === FAILURE);
  assert.equal(failure.integration.state, 'awaiting_integration');
  assert.deepEqual(failure.integration.missing, ['review']);
  assert.deepEqual(failure.integration.detail, [`review: no reviewer counterexample fails only "${LINE_FAILURE}": a reviewer writes a fixture with origin review that fails this line's gating checks and no other`]);
  assert.deepEqual(result.then_lines[0].counterexamples, []);
  assert.deepEqual(gapsOf(repo, 'integration_pending').map((gap) => [gap.case, gap.missing]), [[FAILURE, ['review']]]);
  // eval check leaves it for the reviewer.
  const waiting = checkEval(repo, CHANGE);
  assert.deepEqual(waiting.skipped.map((item) => [item.case, item.missing]), [[FAILURE, ['review']]]);

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
  const { repo, root } = readyProject(t, { check: false });
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
  assert.ok(legacyWarning([FAILURE]).includes('and it has no reviewer counterexamples; `eval confirm` needs 1.1.'));
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
  assert.ok(result.warnings.includes(`Scenario "提交成功" of REQ-submit-success lists "${LINE_NONE}" more than once. Checks bind the text, so the copies count as one line. Ask for them to be merged in the Spec with agent-spec.`), JSON.stringify(result.warnings));
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

const LEAK = /reaches tests\/ or solution\//;
const ROOT_BUILD = /builds from the application root\. Add \.genesis to the project's \.dockerignore/;
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
  assert.deepEqual(invalid(repo), []);
  assert.equal(validateEval(repo, CHANGE).valid, true);
  for (const ignore of ['.genesis/\n', '/.genesis\n']) {
    writeFileSync(path.join(repo, '.dockerignore'), ignore);
    assert.deepEqual(invalid(repo), [], ignore);
  }
});

test('a build from the project root without .genesis in .dockerignore is rejected, by variable or by a relative path', (t) => {
  const { repo, setCompose } = documentedProject(t, null);
  assert.deepEqual(invalid(repo), [
    `${FAILURE}: environment/docker-compose.yaml builds from the application root. Add .genesis to the project's .dockerignore so expected results stay out of the image.`,
    `${SUCCESS}: environment/docker-compose.yaml builds from the application root. Add .genesis to the project's .dockerignore so expected results stay out of the image.`,
  ]);
  writeFileSync(path.join(repo, '.dockerignore'), '**\n!app/\n');
  // Harbor runs Compose from the package's environment/ folder, six levels below the project.
  for (const write of [compose, merged]) {
    setCompose(FAILURE, '../../../../../..', write);
    setCompose(SUCCESS, '${GENESIS_EDD_HARNESS}/../../..', write);
    const messages = invalid(repo);
    assert.equal(messages.length, 2, messages.join('\n'));
    assert.ok(messages.every((message) => ROOT_BUILD.test(message)), messages.join('\n'));
  }
  writeFileSync(path.join(repo, '.dockerignore'), '**\n!app/\n.genesis\n');
  assert.deepEqual(invalid(repo), []);
});

test('a build context that holds the package other than the project root is rejected whatever .dockerignore says', (t) => {
  const { repo, setCompose } = documentedProject(t);
  // Compose's own tags are read without a warning from the YAML parser.
  const warnings = t.mock.method(process, 'emitWarning', () => {});
  for (const write of [compose, merged]) {
    setCompose(FAILURE, '..', write);
    setCompose(SUCCESS, '${GENESIS_EDD_HARNESS}/..', write);
    assert.deepEqual(invalid(repo), [
      `${FAILURE}: environment/docker-compose.yaml builds from .genesis/edd/report-notifications/evals/${FAILURE}, which holds this package's tests/. Build from \${GENESIS_EDD_REPO} with .genesis in .dockerignore, or from the kit, so expected results stay out of the image.`,
      `${SUCCESS}: environment/docker-compose.yaml builds from .genesis/edd, which holds this package's tests/. Build from \${GENESIS_EDD_REPO} with .genesis in .dockerignore, or from the kit, so expected results stay out of the image.`,
    ], write.name);
    // The kit, or the package's own environment/, holds no expected results.
    setCompose(FAILURE, '${GENESIS_EDD_HARNESS}', write);
    setCompose(SUCCESS, '.', write);
    assert.deepEqual(invalid(repo), [], write.name);
  }
  assert.equal(warnings.mock.callCount(), 0, JSON.stringify(warnings.mock.calls.map((call) => String(call.arguments[0]))));
});

test('a package or kit environment file that names tests/, solution/ or checks.json is rejected', (t) => {
  const { repo, root, kit } = documentedProject(t);
  const dockerfile = path.join(root, 'evals', FAILURE, 'environment/Dockerfile');
  writeFileSync(dockerfile, 'FROM alpine:3.20\nCOPY ../tests /opt/tests\n');
  assert.deepEqual(invalid(repo).filter((message) => LEAK.test(message)), [
    `${FAILURE}: environment/Dockerfile reaches tests/ or solution/. Expected results and the reference path must stay out of the agent's image.`]);
  writeFileSync(dockerfile, 'FROM alpine:3.20\nCOPY ../../solution /opt/solution\n');
  assert.equal(invalid(repo).filter((message) => LEAK.test(message)).length, 1);
  rmSync(dockerfile);

  // The kit's environment is shared, so every package that builds with it is rejected.
  writeFileSync(path.join(kit, 'Dockerfile'), 'FROM python:3.12-slim\nCOPY .genesis/edd/report-notifications/evals/submit-failure-s1/tests/checks.json /opt/\n');
  assert.deepEqual(invalid(repo), [
    `${FAILURE}: .genesis/edd/harness/environment/Dockerfile reaches tests/ or solution/. Expected results and the reference path must stay out of the agent's image.`,
    `${SUCCESS}: .genesis/edd/harness/environment/Dockerfile reaches tests/ or solution/. Expected results and the reference path must stay out of the agent's image.`,
  ]);
});

test('a Compose file in the kit that builds from the project root needs .genesis in .dockerignore too', (t) => {
  const { repo, kit } = documentedProject(t);
  writeFileSync(path.join(kit, 'docker-compose.base.yaml'), compose('../../../..'));
  assert.deepEqual(invalid(repo), []);
  writeFileSync(path.join(repo, '.dockerignore'), '**\n!app/\n');
  const messages = invalid(repo);
  // Each package's own compose file and the kit's are named.
  assert.ok(messages.includes(`${FAILURE}: .genesis/edd/harness/environment/docker-compose.base.yaml builds from the application root. Add .genesis to the project's .dockerignore so expected results stay out of the image.`), messages.join('\n'));
  assert.equal(messages.filter((message) => ROOT_BUILD.test(message)).length, 4, messages.join('\n'));
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
  assert.deepEqual(newEval(repo, CHANGE).synced, []);
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
  assert.deepEqual(evalSnapshot(repo, CHANGE), snapshot);
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
