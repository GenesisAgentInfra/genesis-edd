import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listFiles, readJSON } from '../src/project.js';
import { exportSpec } from '../src/spec.js';
import { newEval, validateEval } from '../src/eval.js';
import { checkEval } from '../src/run.js';
import { checkWorkflow } from '../src/workflow.js';
import { CHANGE, SPECS, cli, readyProject, writeSpec } from './helpers/edd.js';

const FAILURE = 'submit-failure-s1';
const SUCCESS = 'submit-success-s1';

const codes = (gaps) => gaps.map((gap) => gap.code);
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
  assert.deepEqual(declared.scenario, { requirement: 'REQ-submit-failure', name: '提交超时' });
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
  assert.deepEqual(scenario, { requirement: 'REQ-submit-failure', name: '提交失败' });

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
  assert.deepEqual(readJSON(path.join(root, 'evals/submit-failure-s2/tests/checks.json')).scenario, { requirement: 'REQ-submit-failure', name: '提交超时' });
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
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 0, requirements_without_gating_check: ['REQ-submit-failure', 'REQ-submit-success'] });
  // eval new rewrites nothing a package owns: the old expectation stays until reviewed.
  assert.deepEqual(newEval(repo, CHANGE).created, []);
  assert.deepEqual(readJSON(path.join(root, 'evals', SUCCESS, 'tests/checks.json')).checks[0].expect, '本次提交发送的成功通知数量为一');
  restamp(root, exported.id);
  assert.deepEqual(codes(validateEval(repo, CHANGE).gaps).filter((code) => code !== 'integration_pending'), []);
});

test('eval validate reports a scenario without a package, and a requirement without a gating check', (t) => {
  const { repo, root } = readyProject(t, { check: false });
  // A check that cites another requirement leaves REQ-submit-success ungated
  // while the package itself stays valid.
  const file = path.join(root, 'evals', SUCCESS, 'tests/checks.json');
  const declared = readJSON(file);
  for (const check of declared.checks) check.intent = 'REQ-submit-failure';
  writeFileSync(file, `${JSON.stringify(declared, null, 2)}\n`);
  let result = validateEval(repo, CHANGE);
  assert.deepEqual(codes(result.gaps).filter((code) => code !== 'integration_pending'), ['requirement_uncovered']);
  assert.deepEqual(result.gaps.find((gap) => gap.code === 'requirement_uncovered'), {
    code: 'requirement_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: 'REQ-submit-success',
    message: 'REQ-submit-success has no gating check. Every accepted requirement needs one before the change can pass.' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 2, requirements_without_gating_check: ['REQ-submit-success'] });

  rmSync(path.join(root, 'evals', SUCCESS), { recursive: true });
  result = validateEval(repo, CHANGE);
  assert.deepEqual(codes(result.gaps).filter((code) => code !== 'integration_pending'), ['scenario_uncovered', 'requirement_uncovered']);
  assert.deepEqual(result.gaps.find((gap) => gap.code === 'scenario_uncovered'), {
    code: 'scenario_uncovered', kind: 'artifact', owner: 'agent', route: 'write-eval', requirement_id: 'REQ-submit-success',
    message: 'No package for scenario "提交成功" of REQ-submit-success.' });
  assert.deepEqual(result.coverage, { scenarios: 2, covered: 1, requirements_without_gating_check: ['REQ-submit-success'] });
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
