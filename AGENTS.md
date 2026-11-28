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

Use Node's built-in test runner. Exercise the real pinned OpenSpec CLI in
integration tests. No model credentials, runtime evidence, private project data
or machine-specific paths belong in Git.

While iterating, run `npm run check`, then only the tests of the area you
changed: `node --test tests/<file>.test.js`, or one test with
`node --test --test-name-pattern "<test name>" tests/<file>.test.js`.
`npm run test:quick` runs the files of the main path in about a minute. Run
`npm run check` and the full `npm test`, which takes a few minutes, once before
a commit or a pull request. `tests/README.md` says which file covers what.

Versions follow releases, not commits. Bump the minor version for a change of
behavior or of a file format, and the patch version for a fix. A release that
changes shipped files bumps every manifest together: `package.json`,
`package-lock.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.
`src/cli.js` reads its version from `package.json`.
