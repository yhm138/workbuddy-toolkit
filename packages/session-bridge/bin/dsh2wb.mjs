#!/usr/bin/env node
import { runCli } from '../src/cli.mjs';

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  if (process.env.DSH2WB_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
