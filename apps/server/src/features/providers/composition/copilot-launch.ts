import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type { CopilotProviderPorts, ProviderHostPorts } from "@mcode/providers";
import { createNodeResolverIO, resolveCopilotCli } from "../adapters/copilot/copilot-cli-resolver.js";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** Normalizes SDK launch configuration while CLI discovery remains server-owned. */
export function createCopilotLaunchPort(settings: { get(): { provider: { cli: { copilot?: string } } } }, host: ProviderHostPorts): CopilotProviderPorts["launch"] {
  return { resolve: async () => {
    const env = { ...host.environment.snapshot() };
    let cliPath = settings.get().provider.cli.copilot?.trim() || bundledCliPath(host.runtime);
    const compatible = resolveCopilotCli({ configuredPath: cliPath }, createNodeResolverIO(env, host.runtime.platform));
    if (compatible.source === "not-found") throw new Error(compatible.message);
    cliPath = compatible.entry;
    let githubToken: string | undefined;
    try { githubToken = (await execFileAsync("gh", ["auth", "token"], { timeout: 5_000, windowsHide: true, env })).stdout.trim() || undefined; }
    catch { /* The SDK's native authentication remains available without GitHub CLI auth. */ }
    return { cliPath, env, ...(githubToken ? { githubToken } : {}) };
  } };
}

function bundledCliPath(runtime: ProviderHostPorts["runtime"]): string {
  const platform = runtime.platform;
  const packageName = `@github/copilot-${platform}-${runtime.architecture}`;
  const binary = platform === "win32" ? "copilot.exe" : "copilot";
  const staged = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "node_modules", "@github", packageName.slice("@github/".length), binary);
  if (NodeFS.existsSync(staged)) return staged;
  const sourceRequire = NodeModule.createRequire(import.meta.url);
  const providerRequire = NodeModule.createRequire(sourceRequire.resolve("@mcode/providers"));
  const sdkRequire = NodeModule.createRequire(providerRequire.resolve("@github/copilot-sdk"));
  return NodePath.join(NodePath.dirname(sdkRequire.resolve(packageName)), binary);
}
