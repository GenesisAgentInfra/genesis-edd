# Genesis EDD

Internal architecture, product plans and development notes live only in Notion.
Do not commit them, local copies, or private Notion links to this public repository.
Keep public documentation limited to installation, usage, supported behavior,
contribution instructions and resources required by the shipped skills.

This repository owns requirements and the evaluation-driven development loop.
Genesis Map is a separate tool, not a dependency: EDD uses a Map when one
exists and works without it. OpenSpec is a pinned dependency; do not vendor or
modify its source.

Keep the user interaction short. Ask only about ambiguity that changes business
acceptance. Existing code and maps describe facts, not requirements. Preserve the
source and status of every requirement; agent suggestions are not user decisions.

Spec authoring, eval packages, eval runs and the implementation loop are
implemented; prepare is planned. Do not present a planned command as working
functionality. Harbor and Docker are separate tools that run-eval needs; do not
vendor Harbor. Keep baseline unavailability and blocked execution distinct from
a failing business check.

Use Node's built-in test runner. Run `npm run check` and `npm test` after changes.
Exercise the real pinned OpenSpec CLI in integration tests. No model credentials,
runtime evidence, private project data or machine-specific paths belong in Git.
