#!/usr/bin/env bun
/**
 * Safely reset the checkout's dev state directory (`<repo>/.dev`).
 * Deletes and recreates it. Run `bun run agent:setup` afterwards to restore the fixture
 * repository and the seeded database.
 */
import * as NodePath from 'node:path';
import * as NodeFS from 'node:fs';
import * as NodeReadline from 'node:readline';
import { getRuntimePaths } from './agent/runtime-contract.mjs';
import { scriptRoot } from './utils.mjs';

/**
 * Returns the directory `state:reset` may delete: exactly `<repoRoot>/.dev`.
 * `MCODE_DATA_DIR` is honoured only when it names that same directory, so a stray value
 * can never point the reset at `~/.mcode`, a subdirectory, or anything else.
 *
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveResetTarget(repoRoot, env = process.env) {
  const { devDir } = getRuntimePaths(repoRoot);
  const target = NodePath.resolve(env.MCODE_DATA_DIR ?? devDir);
  if (NodePath.relative(devDir, target) !== '') {
    throw new Error(`Refusing to reset ${target}: state:reset only deletes ${devDir}.`);
  }
  return devDir;
}

function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: state:reset refuses to run in production.');
    process.exit(1);
  }

  let dataDir;
  try {
    dataDir = resolveResetTarget(scriptRoot);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (!NodeFS.existsSync(dataDir)) {
    console.log(`Nothing to reset — ${dataDir} does not exist.`);
    process.exit(0);
  }

  console.log('WARNING: This will delete all contents of:');
  console.log(`  ${dataDir}`);
  console.log('This includes the database, logs, fixture repository, and all app state.\n');

  const rl = NodeReadline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Type "y" to confirm: ', answer => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
    NodeFS.mkdirSync(dataDir, { recursive: true });
    console.log(`\n✓ Reset complete. ${dataDir} is now empty.`);
    console.log('  Run `bun run agent:setup` to restore the fixture repository and seeded database.');
  });
}

if (import.meta.main) main();
