# Genesis EDD

Internal architecture, product plans and development notes live only in Notion.
Do not commit them, local copies, or private Notion links to this public repository.
Keep public documentation limited to installation, usage, supported behavior,
contribution instructions and resources required by the shipped skills.

This repository owns requirements and the planned evaluation-driven development
loop. Genesis Map remains a separate static-analysis dependency. OpenSpec is a
pinned dependency; do not vendor or modify its source.

Keep the user interaction short. Ask only about ambiguity that changes business
acceptance. Existing code and maps describe facts, not requirements. Preserve the
source and status of every requirement; agent suggestions are not user decisions.

Only spec authoring, validation and export are implemented initially. Do not
present planned evaluation or coding-loop commands as working functionality.
Keep baseline unavailability distinct from a failing business check.

Use Node's built-in test runner. Run `npm run check` and `npm test` after changes.
Exercise the real pinned OpenSpec CLI in integration tests. No model credentials,
runtime evidence, private project data or machine-specific paths belong in Git.
