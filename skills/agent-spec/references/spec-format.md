# Genesis Spec format v0.1

OpenSpec owns change directories and the syntax of requirements and
scenarios. Genesis adds YAML frontmatter for provenance and readiness. One
capability file is normally enough for a small request. OpenSpec's English
headings are structural. Write the requirement text and the scenarios in the
user's language, and keep SHALL or MUST.

```markdown
---
genesis_spec: 1
revision: 1
sources:
  request:
    kind: user
    ref: conversation:actual-message-reference
    quote: 报告提交失败时，不要发送成功通知。
requirements:
  REQ-submit-failure:
    source: request
    state: explicit
open_questions: []
---

# 报告提交通知

## Purpose

让报告提交的通知准确反映实际提交结果，避免用户在提交失败时收到误导性的成功通知，并为后续开发提供可重复验证的业务验收依据。

## ADDED Requirements

### Requirement: REQ-submit-failure 提交失败时不发送成功通知

系统 MUST 在报告提交失败时不发送成功通知。

#### Scenario: 提交失败

- **WHEN** 报告提交返回失败
- **THEN** 本次提交发送的成功通知数量为零
```

Do not infer "success must notify", a retry policy or a notification channel
from that request. Include them only if the user or an accepted existing rule
supplies them. A check that nothing was sent also needs, in the future eval
package, a positive failure trigger and complete observations of the
notifications: no activity is not proof.

## Provenance

Every requirement heading starts with a stable `REQ-...` ID and a short name.
Frontmatter `requirements` holds exactly those IDs. IDs are unique within a
change. Keep IDs across revisions, and do not reuse one for an unrelated
behavior.

`sources` maps source IDs to `kind`, `ref` and `quote`:

- `user`: an actual user request, issue, PRD or business decision.
- `accepted_spec`: an already accepted, versioned rule with its concrete
  reference.
- `agent`: a suggestion, not authority. Quote the suggestion and label it as
  such.

`state` is `explicit`, `confirmed` or `proposed`:

- `explicit`: the quoted words of a user source or an accepted Spec state this
  requirement's trigger and outcome. An agent source cannot be explicit. Do
  not use it for an assumption drawn from code, a Map or an ambiguous request,
  or for a rule the words only imply: the converse of a permission, who is
  refused, a limit, a side effect that must not happen.
- `confirmed`: an interpretation or suggestion the user actually accepted. Add
  `confirmation: {by: "actual actor", ref: "actual confirmation reference"}`.
  A confirmation covers what the user was shown and accepted, nothing added
  later.
- `proposed`: not accepted. The export leaves it out and lists it under
  `excluded` with reason `proposed`. It never becomes a check. Do not put
  speculative scenarios inside an explicit requirement to get around this.

"Users can cancel their own orders" states that an owner can cancel. Refusing
a different user's attempt is a reading of that sentence, however natural.
Leave it out by default and mention it as not included. If the user asks for
it, it is a separate requirement, `proposed` until they accept it.

Scenarios share the state of their requirement. Under an `explicit` or
`confirmed` requirement, each GIVEN, WHEN or THEN line restates, in observable
terms, what the quote or confirmation covers. A concrete example value is
fine; a new outcome is not. If the user confirmed "shipped orders cannot be
cancelled", a line "a repeated cancel issues no second refund" adds a rule
nobody accepted. Remove it. If the user wants it, it needs its own
requirement.

The validator checks these fields and one consequence of them. A quote cannot
back more `explicit` requirements than it has sentence-level statements
(`explicit_exceeds_quote`, counted by sentence, a heuristic). When one message
states several rules, give each requirement its own source that quotes its own
words. The validator does not check that a quotation is true, who the actor
is, or whether a line is faithful to its source. Those stay with the author
and the reader. `spec export` returns `review` and `must_show` to make that
reading quick. The CLI never fabricates a transcript.

## Open questions

`open_questions` is a list. Each entry is one of these:

- a string;
- `{ question, requirements: [REQ-...] }`;
- `{ question, requirement: REQ-... }`.

A question holds back the requirements it lists and the ones whose IDs its
text names. Those requirements are left out of the export and listed under
`excluded` with reason `open_question` and the questions. A question that
names no requirement holds back the whole export (`business_question`,
owner user). When every requirement is proposed or held back, nothing can be
exported (`requirements_all_excluded`, owner user). A question that names an
ID the change does not have is invalid.

Findings about a requirement that no export holds are warnings, not errors:
the requirement is left out either way.

## Scenarios and steps

Each requirement has at least one `#### Scenario:`. Each scenario has a GIVEN
or WHEN step and a THEN step. Every step is a list item written exactly
`- **GIVEN** text`, `- **WHEN** text`, `- **THEN** text` or `- **AND** text`.
An AND step continues the step before it. Genesis reads the scenarios itself,
with the same boundaries as the export:

- a line that reads as a step in any other form is `step_malformed`, because
  it would be left out of the export unnoticed. Examples: `- THEN x`,
  `**THEN** x` outside a list, `Then: x` inside a scenario.
- an AND before any other step, a step outside every scenario and a step with
  no text are `step_malformed` too.
- a scenario without a trigger or without an outcome is
  `scenario_incomplete`; a requirement without a scenario is
  `scenario_missing`.

Text inside fenced code blocks is not read as steps.

Each THEN or AND line states one observable result. An eval check verifies
lines, so a line with two results cannot tell which one failed: split it. Two
lines that can only fail together state one result, so write them as one when
you can. A line about tone or answer quality is fine to write. No program
judges it, so the user does at acceptance.

## Updates and limits

Use `ADDED Requirements` for a new rule. Use `MODIFIED Requirements` to change
an existing accepted rule: copy its entire block with the exact existing
heading, then apply the user's change. Include every scenario that stays
valid. REMOVED and RENAMED deltas are refused (`spec_invalid`), and merging
into `openspec/specs` is not implemented. Do not use OpenSpec archive or sync:
Genesis provenance would have to be merged too, and archive moves the change
folder that `genesis.json` and the EDD records name. Read earlier changes and
their handoffs, as well as any documents already in `openspec/specs`.

When a file's meaning changes, raise its `revision`. A file that changed since
the current export with the same revision gives a warning.

OpenSpec strict validation runs on every `spec validate` and `spec export`. A
finding is blocking (`spec_format_invalid`) when it changes what is read as
requirements, scenarios or steps:

- errors other than a delta spec file outside a capability folder;
- a section that is not a delta section and so is ignored;
- a missing scenario;
- a delta without requirements.

Everything else is a warning, for example a short Purpose, a missing SHALL or
an overlong requirement. A finding that names only requirements no export
holds is a warning too. The raw OpenSpec output is under `openspec` in the
JSON result.

Genesis reads the text between the frontmatter and the first `## ` section
itself. Only one `# ` title line, HTML comments and blank lines may sit there.
Anything else is `spec_format_invalid`, with its line and text: it belongs to
no requirement, so it never becomes a check, and archive would drop it. Move
it into a requirement, or into `proposal.md` or `design.md`.

OpenSpec counts the Genesis frontmatter itself as text above the first
section that archive would drop. Genesis keeps the frontmatter in the handoff,
so this is a warning and nothing needs moving. Because of it, the raw OpenSpec
result shows `valid: false` and `failed: 1` for any change with a Genesis spec
file.

## genesis.json and the Map

`genesis.json` beside the specs is written by `spec new` (or `spec new
--adopt`, or `spec remap` for its Map record) and never by hand. It holds:

- the project mode;
- the code as it was: base commit, whether the tree was dirty, and a
  `snapshot` with the changed files and the content digest a run would record
  for the same code;
- the Map record, or why there is none;
- a baseline `not_run`.

A run's code is later compared with this snapshot. A baseline on other code
is listed for the user: the application code changed before the baseline.
`adopted` lists what an adopted change held.

With `--map`, `spec new` copies the Map byte for byte into the change folder
as `business-map.json`, and `genesis.json` points at that copy. The copy is
committed and reviewed with the Spec. Genesis's own output under
`.genesis/out` stays out of Git. A change made before copies existed records
a path under `.genesis/out`. Once a copy with the recorded digest is in its
change folder, the copy decides, as it does on every clone. The checks warn
when the Map file is ignored by Git, or untracked while `genesis.json` is
tracked.

The CLI reads these fields from the Map copy itself at `spec new`,
`spec remap`, `spec validate` and `spec export`, and never takes them from
`genesis.json`: `snapshot_id`, `analysis_status`, `mode`, `freshness`,
`coverage` and `coverage_scope`. A value in `genesis.json` that differs gives
a warning. The Map decides, and the export records what it gives.

- `mode` is `map` for a full map and `change` for the Map of a Genesis change
  review. A change-review Map is recognized by its `mode` or by
  `change-report.json` beside it, and is recorded with
  `coverage_scope: partial`: it covers only what that review analyzed. A Map
  from a Genesis before commit `9c0c914` says neither, and is `unknown`.
- `freshness` compares the digests Genesis records under the Map's `source`
  with the same files at the commit checked out now, as Git stores them.
  - `verified`: a Map read without uncommitted changes and without files left
    out, whose every file is unchanged.
  - `stale`: a file changed or is gone.
  - `unverified`: the Map has no `source` (a Genesis before `9c0c914`), was
    read with uncommitted changes, left files out, or there is no commit to
    compare with.
  A file added after the Map is not listed, so `verified` does not cover new
  files. Uncommitted edits are not compared either: `spec new` names the files
  the Map was read from that have them, because impact evidence is read from
  the working tree.
- `analysis_status: complete` means the flows Genesis planned are finished,
  not that the whole project is mapped. `coverage` counts the entries Genesis
  found and how many were planned, skipped or not handled. The checks warn
  when entries lie outside the planned flows.
- Steps of flows Genesis has not described yet are named from source code.
  The checks warn with their count, because that code goes into Git with the
  copy.

`spec remap <change> --map <file>` replaces the copy and the Map record while
the change has never been exported. A Map must be a Genesis
`business-map.json` with `snapshot_id` and an `analysis_status` of `complete`
or `partial`, and its `mode`, when it has one, is `map` or `change`.

## Impact

In an existing project, `impact.md` beside `genesis.json` records which
entries the request touches. YAML frontmatter carries the checked part. Any
text below it is for the reader.

```markdown
---
genesis_impact: 1
entries:
  - flow: flow_0123456789ab
    entry: POST /reports
    effect: changes
    evidence: app/reports.py:42
    note: Stop the success notification when submission fails
---
```

The fields of an entry:

- `entry` names the route, command or tool.
- `effect` is `changes` for behavior the request alters, and `may_affect` for
  neighbors worth a regression check.
- `evidence` is a file in the project, optionally with a line, that you read.
- `flow` is optional. Use the flow ID from the recorded Map, and leave it out
  when the Map does not cover the entry or no Map is recorded.

The checks compare flow IDs with the recorded Map and evidence with the
working tree. Anything that does not check out is a warning, the entry is
left out when it lacks a field, and the export records the problems under
`impact.problems`. Without a Map, flow IDs cannot be checked and give a
warning. The CLI cannot tell whether the list is complete. A missing
`impact.md` in an existing project is a warning.

## Handoff

`spec export` writes a content-addressed JSON handoff to
`handoffs/<hex>.json` and appends a line `{ at, id, source, previous }` to
`exports.jsonl`, whose last line names the current export. A handoff is never
rewritten. Its fields are these:

- `format: "genesis.spec-handoff"` and `version: 2`, plus `change` and `id`.
- `context`: the context of `genesis.json`, with the Map fields worked out at
  export.
- `specs`: each file's path, digest, revision and content.
- `requirements`, the accepted ones only. Each has `id`, `name`, `path`,
  `state`, `basis` (`source`, `kind`, `ref`, `quote`), `confirmation` when
  confirmed, `statement`, and `scenarios` (`name`, with `given`, `when` and
  `then` as lists of lines).
- `impact`: the checked entries and their problems.
- `excluded`: each left-out requirement with its reason and questions.
- for an import, `source: "import"` and `imported` (the file and its digest).

Markdown is read with LF line ends, so a checkout that converts line ends,
such as Git's `core.autocrlf`, keeps the identity of the Spec, its handoff
and its Map copy. Later stages read the requirements and verify digests. They
do not parse the Markdown, so its layout can change without breaking them.

A change exported before `exports.jsonl` existed has no log. Its current
export is the handoff whose Spec files, `impact.md` and `genesis.json` match
the change folder now.

An export means there is enough accepted business information to design
evals. It does not mean an executable task package exists.

## Import format

`spec import <change> --handoff <file>` reads a JSON object of this shape:

- `format: "genesis.spec-handoff"` and `version: 2`. `change`, when present,
  must be this change.
- `requirements`, a non-empty list in the shape above. Each needs:
  - an `id` that starts with `REQ-`, a `name` and a `statement`;
  - a `state`, and a `basis` with `source`, `kind`, `ref` and `quote`;
  - `confirmation` with `by` and `ref` when the state is `confirmed`;
  - at least one scenario with a unique `name` and `given`, `when` and `then`
    lists. Each scenario has a GIVEN or WHEN step and a THEN step, and no step
    is empty.
- Optional `specs` (`path`, `content`, optional `sha256` and `revision`),
  `impact` (`entries`) and `open_questions`, read as above.

An imported `context` is ignored. The import records `genesis.json` of the
change when there is one, with its Map checked; otherwise the code as it is
now. Importing the same file again changes nothing.
