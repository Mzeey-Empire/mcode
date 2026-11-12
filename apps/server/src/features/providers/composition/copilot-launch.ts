import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { CopilotProviderPorts, ProviderHostPorts } from "@mcode/providers";
import { clearResolutionCache, createNodeResolverIO, resolveCopilotCli } from "../adapters/copilot/copilot-cli-resolver.js";
import { serverModuleUrl } from "../../../runtime/environment/server-module-url.js";
import { sharedProcessStartWorkerClient } from "../../../runtime/process/process-start-worker-client.js";
import type { ProcessStartRunner } from "../../../runtime/process/process-start.js";

/** Normalizes SDK launch configuration while CLI discovery remains server-owned. */
export function createCopilotLaunchPort(settings: { get(): { provider: { cli: { copilot?: string } } } }, host: ProviderHostPorts, runProcess: ProcessStartRunner = sharedProcessStartWorkerClient().run): CopilotProviderPorts["launch"] {
  return { resolve: async () => {
    const env = { ...host.environment.snapshot() };
    let cliPath = settings.get().provider.cli.copilot?.trim() || bundledCliPath(host.runtime);
    const compatible = await resolveCopilotCli({ configuredPath: cliPath }, createNodeResolverIO(env, host.runtime.platform, runProcess));
    if (compatible.source === "not-found") throw new Error(compatible.message);
    cliPath = compatible.entry;
    let githubToken: string | undefined;
    try { githubToken = (await runProcess({ command: "gh", args: ["auth", "token"], timeout: 5_000, env })).stdout.trim() || undefined; }
    catch { /* The SDK's native authentication remains available without GitHub CLI auth. */ }
    return { cliPath, env, ...(githubToken ? { githubToken } : {}) };
  },
  describeCli: async () => {
    const configured = settings.get().provider.cli.copilot?.trim();
    const resolution = await resolveCopilotCli(
      { configuredPath: configured || bundledCliPath(host.runtime) },
      createNodeResolverIO({ ...host.environment.snapshot() }, host.runtime.platform, runProcess),
    );
    return {
      installed: resolution.version,
      managedBy: !configured && resolution.source === "configured" ? "mcode" : "user",
      resolvedPath: resolution.entry,
      npmPackage: resolution.source === "npm-global" ? "@github/copilot" : null,
    };
  },
  clearCliVersionCache: clearResolutionCache,
  };
}

function bundledCliPath(runtime: ProviderHostPorts["runtime"]): string {
  const platform = runtime.platform;
  const packageName = `@github/copilot-${platform}-${runtime.architecture}`;
  const binary = platform === "win32" ? "copilot.exe" : "copilot";
  const staged = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(serverModuleUrl(import.meta.url))), "node_modules", "@github", packageName.slice("@github/".length), binary);
  if (NodeFS.existsSync(staged)) return staged;
  const sourceRequire = NodeModule.createRequire(import.meta.url);
  const providerRequire = NodeModule.createRequire(sourceRequire.resolve("@mcode/providers"));
  const sdkRequire = NodeModule.createRequire(providerRequire.resolve("@github/copilot-sdk"));
  return NodePath.join(NodePath.dirname(sdkRequire.resolve(packageName)), binary);
}
