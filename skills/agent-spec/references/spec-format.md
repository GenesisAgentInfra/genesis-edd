# Genesis Spec format v0.1

OpenSpec owns change directories and behavior/scenario syntax. Genesis adds YAML
frontmatter for provenance and readiness. One capability file is normally enough
for a small request. OpenSpec's required English headings are structural; write
the requirement text and scenarios in the user's language and retain SHALL/MUST.

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

Do not infer "success must notify", a retry policy or notification channel from
that request. Include these only if the user or an accepted existing rule supplies
them. A no-notification check also needs a positive failure trigger and complete
notification observations in the future Eval package; no activity is not proof.

## Provenance

Every requirement heading starts with a stable `REQ-...` ID and a short name.
Frontmatter `requirements` contains exactly those IDs. IDs are unique within a
change. Preserve IDs across revisions; do not reuse one for an unrelated behavior.

`sources` maps source IDs to `kind`, `ref` and `quote`:

- `user`: an actual user request, issue, PRD or business decision.
- `accepted_spec`: an already accepted, versioned rule with its concrete reference.
- `agent`: a suggestion, not authority. Quote the suggestion and label it as such.

`state` is `explicit`, `confirmed` or `proposed`:

- `explicit`: the quoted words of a user source or accepted spec state this
  requirement's trigger and outcome. Do not use it for new assumptions inferred
  from code, a Map or an ambiguous request, or for a rule the words only imply:
  the converse of a permission, who is refused, a limit, or a side effect that
  must not happen.
- `confirmed`: an interpretation or suggestion the user actually accepted. Add
  `confirmation: {by: "actual actor", ref: "actual confirmation reference"}`.
  A confirmation covers what the user was shown and accepted, nothing added later.
- `proposed`: not accepted; blocks export for Eval design. Keep unresolved business
  questions in `open_questions`, an array of strings. Do not put speculative
  scenarios inside an explicit requirement to bypass this distinction.

"Users can cancel their own orders" states that an owner can cancel. Refusing a
different user's attempt is a reading of that sentence, however natural. Leave it
out by default and mention it as not included. If the user asks for it, it is a
separate requirement: `proposed` until they accept it.

Scenarios share the state of their requirement. Under an `explicit` or `confirmed`
requirement, each GIVEN/WHEN/THEN line restates in observable terms what the
quote or confirmation covers; a concrete example value is fine, a new outcome is
not. If the user confirmed "shipped orders cannot be cancelled", a scenario line
"a repeated cancel issues no second refund" adds a rule nobody accepted. Remove
it; it needs its own requirement if the user wants it.

The validator checks these fields and one consequence of them: a quote cannot
back more `explicit` requirements than it has sentence-level statements
(`explicit_exceeds_quote`). When one message states several rules, give each
requirement its own source quoting its own words. The validator does not check
the truth of a quotation, the identity of the actor or semantic faithfulness.
The authoring agent and reviewers retain that responsibility; `spec export`
returns a `review` list of every requirement beside its quote and outcomes to
make that reading quick. No interaction transcript is fabricated by the CLI.

## Updates and limits

Use `ADDED Requirements` for a new rule. Use `MODIFIED Requirements` when changing
an existing accepted rule: copy its entire block with the exact existing heading,
then apply the user's delta. Include all scenarios that remain valid. v0.1 accepts
ADDED/MODIFIED only; removal/rename lifecycle and main-spec promotion are deferred.
Do not use automatic OpenSpec archive/sync yet: Genesis provenance metadata must
also be merged, and v0.1 does not implement that integration. Archive also moves
the change folder, which the Map path in genesis.json and the EDD records name. Read prior changes
and handoffs as well as any pre-existing `openspec/specs` documents.

Each requirement has at least one `#### Scenario:` with a WHEN/GIVEN trigger and
THEN outcome. Keep descriptions within OpenSpec's strict limit (500 characters).
New capabilities include a meaningful `## Purpose` (at least 50 characters).
No design or task-list artifact is required.

OpenSpec 2.1.0 strict validation warns that archive drops text before the first
section, including YAML frontmatter. Genesis reports that exact warning as advisory
only when the preamble contains just frontmatter and an optional title: its handoff
preserves both, and archive/sync is unsupported. Every other strict warning or error
still blocks validation. Raw upstream diagnostics remain in the JSON response.

`genesis.json` beside the specs records project mode, base commit if present, the
Map (path, digest, snapshot and analysis status) or an explicit absence, and
baseline `not_run`. It is technical context, not a source of business
requirements. A provided Map may be partial or stale; source identity alone does
not prove coverage or freshness.

With `--map`, `spec new` copies the Map byte for byte into the change folder as
`business-map.json`, and genesis.json points at that copy. Genesis's own output
under `.genesis/out` stays out of Git; the copy is committed and reviewed with
the Spec. Edit neither file: every export records genesis.json, so a change to it
is a different export. A change made before the copy existed records
`.genesis/out/...`. Once a copy is in its change folder, the copy decides, as it
does on other clones, and it must have the recorded digest; until then the
recorded file is read. Checks warn when the Map file is ignored by Git, or
untracked while genesis.json is tracked.

## Impact

In an existing project, `impact.md` beside `genesis.json` records which entries
the request touches. YAML frontmatter carries the checked part; any text below
it is for the reader.

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

`entry` names the route, command or tool. `effect` is `changes` for behavior the
request alters and `may_affect` for neighbours worth a regression check.
`evidence` is a project file, optionally with a line, that you read. `flow` is
optional: use the flow ID from the recorded Map and omit it when the Map does
not cover the entry. The validator rejects a flow ID that is not in the recorded
Map and evidence that is not a file, or a line, in the project. It cannot check
that the list is complete. A missing `impact.md` in an existing project is a
warning, not a blocker.

## Handoff

`spec export` writes a content-addressed JSON handoff under the change's `handoffs/`
directory. It includes the exact Markdown, revisions and context, so edits cannot
silently change an earlier exported expectation. It also carries `requirements`,
each with its ID, state, source, statement and scenarios split into `given`,
`when` and `then`, and the checked `impact`. Later stages read those fields and
verify the digest; they do not parse the Markdown, so its layout can change
without breaking them. Export readiness means enough accepted business
information to design Eval; it does not mean an executable task package exists.
