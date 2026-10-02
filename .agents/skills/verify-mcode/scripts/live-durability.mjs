#!/usr/bin/env bun
/** Public import surface and offline check command for fixture-driven live durability proof. */
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';
import * as NodeChildProcess from 'node:child_process';

export * from './live-durability/proof.mjs';
export { readElectronRuntimeIdentity } from './live-durability/runtime-identity.mjs';

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '../../../..');
const HELP = `Verify Mcode live durability

Usage:
  bun .agents/skills/verify-mcode/scripts/live-durability.mjs check

check runs focused verifier contracts, fresh scratch SQLite fault checks, and
native ACP Devin/Codex fixture checks. It never connects to an app or account.

For real UI proof, import this module in the owned Electron Playwright session.
Read references/features/provider-events-and-durability.md for the journey,
explicit runtime/database identity, result conditions, and cleanup.
Evidence stays under this worktree's .dev/verification/live-durability/.`;

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error('Offline verification stopped: ' + signal)) : resolve(code ?? 1));
  });
}

if (typeof process !== 'undefined' && process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(HELP);
    else if (args.length === 1 && args[0] === 'check') {
      process.exitCode = await run('node', [ '--test', NodePath.join(root, '.agents/skills/verify-mcode/scripts/live-durability/contracts.test.mjs'), NodePath.join(root, '.agents/skills/verify-mcode/scripts/live-durability/native-child.test.mjs') ]);
      if (process.exitCode === 0) process.exitCode = await run(process.execPath, [NodePath.join(root, '.agents/skills/verify-mcode/scripts/live-durability/self-check.mjs')]);
    } else throw new Error('Use live-durability.mjs check or --help');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
