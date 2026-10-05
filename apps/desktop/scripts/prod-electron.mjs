#!/usr/bin/env bun
/**
 * Launches the built desktop app with Electron in production mode.
 *
 * ELECTRON_RUN_AS_NODE must be removed from the env. Terminals inside
 * Electron-based apps (Mcode, VS Code, Claude Code) inherit it, and it makes
 * Electron run as plain Node.js, so `require("electron").app` is undefined
 * and main crashes on startup. Bun's shell cannot unset a variable, and an
 * empty value still counts as set on POSIX, so this needs a script.
 *
 * Extra CLI args are forwarded to Electron after the app path.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ensureElectronBinary } from "../../../scripts/ensure-electron.mjs";
import { killProcessTree } from "../../../scripts/kill-process-tree.mjs";

const projectRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
ensureElectronBinary(projectRoot);
const electronBin = NodeModule.createRequire(NodePath.join(projectRoot, "package.json"))("electron");
const { ELECTRON_RUN_AS_NODE: _inheritedRunAsNode, ...parentEnv } = process.env;

// No `shell: true`: spawning the binary directly avoids the console-window
// flash that the cmd.exe wrapper causes on Windows.
const electron = NodeChildProcess.spawn(electronBin, [".", ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...parentEnv, NODE_ENV: "production" },
});
electron.on("error", (error) => {
  console.error(`[prod] Failed to start Electron at ${electronBin}: ${error.message}`);
  process.exit(1);
});
electron.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Killing this Bun parent must not orphan Electron and its server child.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void Promise.resolve(killProcessTree(electron)).finally(() => process.exit(0));
  });
}
