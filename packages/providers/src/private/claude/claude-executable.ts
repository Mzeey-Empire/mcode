import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import which from "which";
import sdkMetadata from "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" };
import { meetsMinVersion } from "../../version-policy.js";
import { readCliStatusVersion, type CliStatusRunner } from "../status/cli-status-runner.js";

/** Resolves the installed CLI, mapping Windows launchers to entries the SDK can spawn. */
export function resolveClaudeExecutable(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const path = env.PATH ?? env.Path;
  const resolved = NodePath.isAbsolute(command) ? command : which.sync(command, { nothrow: true, ...(path !== undefined ? { path } : {}) });
  if (!resolved || !NodeFS.existsSync(resolved)) throw new Error("Claude Code is not installed. Install Claude Code or configure its CLI path.");
  if (platform !== "win32" || !/\.(cmd|bat|ps1)$/i.test(resolved)) return resolved;
  return resolveWindowsClaudeEntry(resolved);
}

function resolveWindowsClaudeEntry(resolved: string): string {
  // The SDK spawns without a shell, so npm and WinGet launcher scripts cannot be passed directly.
  const directory = NodePath.dirname(resolved);
  for (const entry of [
    "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    "node_modules/@anthropic-ai/claude-code/cli.js",
    "../Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe",
  ]) {
    const candidate = NodePath.resolve(directory, entry);
    if (NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()) return candidate;
  }
  throw new Error("Claude Code launcher has no supported executable. Reinstall Claude Code or point its CLI path at claude.exe or the claude binary.");
}

/** Checks the installed version against the CLI version required by the current SDK. */
export async function checkClaudeVersion(run: CliStatusRunner, executable: string): Promise<{ installed: string | null; warning?: string }> {
  const probe: CliStatusRunner = executable.endsWith(".js")
    ? (_binary, args) => run("node", [executable, ...args])
    : run;
  const installed = await readCliStatusVersion(probe, executable);
  if (!installed) return { installed, warning: "Could not check Claude Code version. Reinstall Claude Code or configure its CLI path." };
  if (!meetsMinVersion(installed, sdkMetadata.claudeCodeVersion)) {
    return { installed, warning: `Update Claude Code to ${sdkMetadata.claudeCodeVersion} or later (installed ${installed}).` };
  }
  return { installed };
}
