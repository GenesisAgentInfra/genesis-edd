# Tests

`npm test` (`node --test`) runs every `*.test.js` file. Node runs the files in
parallel, one process each, and the tests of one file one after another, since
they share `process.env` through `useFakeTools`.

`npm run test:quick` runs only the files of the main path: the harness smoke
test, the Spec, eval packages, runs and the loop (`helpers/harness.smoke.test.js`,
`spec.test.js`, `eval.test.js`, `run.test.js`, `loop.test.js`). Use it while
iterating, and run `npm test` before a commit.

- `loop.test.js` covers the main loop; `loop-<topic>.test.js` cover the rest of
  the loop by topic. Helpers more than one of them use are in `helpers/loop.js`.
- `run.test.js` covers runs and their comparison; `run-code.test.js` the base
  record and the code identity, `run-plan.test.js` the run plan. Shared helpers
  are in `helpers/run.js`.
- `helpers/edd.js` holds the synthetic project, the fake Harbor and the fake
  Docker. `readyProject` builds each distinct set of options once per test
  process and gives every test its own copy of that project.
