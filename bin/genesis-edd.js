#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  const result = main(process.argv.slice(2));
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // A refusal names its gaps, and what the user must be shown when it is
  // theirs to decide.
  console.error(JSON.stringify({ error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.gaps ? { gaps: error.gaps } : {}),
    ...(error.must_show ? { must_show: error.must_show } : {}),
  }, null, 2));
  process.exitCode = 1;
}
