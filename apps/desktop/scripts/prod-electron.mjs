#!/usr/bin/env bun
/**
 * Launches the built desktop app with Electron in production mode.
 *
 * ELECTRON_RUN_AS_NODE must be removed from the env. Terminals inside
 * Electron-based apps (Mcode, VS Code, Claude Code) inherit it, and it makes
 * Electron run as plain Node.js, so `require("electron").app` is undefined
 * and main crashes on startup. Bun's shell cannot unset a variable, and an
 * empty value still counts as set on POSIX, so this needs a script.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const projectRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const electronBin = NodeModule.createRequire(NodePath.join(projectRoot, "package.json"))("electron");
const { ELECTRON_RUN_AS_NODE: _inheritedRunAsNode, ...parentEnv } = process.env;

const electron = NodeChildProcess.spawn(electronBin, ["."], {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...parentEnv, NODE_ENV: "production" },
});
electron.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
