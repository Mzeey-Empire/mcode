import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import which from "which";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { createCliStatusRunner, isSemver, type CliStatusOutcome } from "@mcode/providers";

/** The only process boundary used by the updater. Tests supply an in-memory host. */
export interface CliUpdateProcessHost {
  platform: NodeJS.Platform;
  run(args: readonly string[], timeoutMs: number): Promise<CliStatusOutcome>;
}

/** An update has either completed or has a bounded diagnostic suitable for Retry. */
export type CliUpdateResult = { ok: true } | { ok: false; reason: string };

/** Adapter discovery plus a registry-validated, exact version. */
export interface CliUpdateRequest {
  resolvedPath: string;
  npmPackage: string;
  target: string;
}

const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;

/** Installs only CLIs owned by the npm prefix in the server's own environment. */
export class CliUpdateRunner {
  constructor(private readonly host: CliUpdateProcessHost = nodeProcessHost) {}

  /** Checks npm ownership without installing anything. Prefix siblings and relative paths are rejected. */
  async canUpdate(resolvedPath: string): Promise<boolean> {
    const result = await this.host.run(["prefix", "-g"], 5_000);
    if (result.kind !== "exited" || result.code !== 0) return false;
    const path = this.host.platform === "win32" ? NodePath.win32 : NodePath.posix;
    let prefix = result.output.trim();
    let cli = resolvedPath;
    if (!path.isAbsolute(prefix) || !path.isAbsolute(cli)) return false;
    if (this.host.platform === "win32") {
      prefix = prefix.toLowerCase();
      cli = cli.toLowerCase();
    }
    const relative = path.relative(path.normalize(prefix), path.normalize(cli));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  /** Rechecks ownership immediately before installation; no caller can pass arbitrary npm arguments. */
  async update(request: CliUpdateRequest): Promise<CliUpdateResult> {
    if (!isSemver(request.target) || !PACKAGE_NAME.test(request.npmPackage)) {
      return { ok: false, reason: "Invalid package or target version." };
    }
    if (!await this.canUpdate(request.resolvedPath)) {
      return { ok: false, reason: "CLI is outside the server's npm prefix or npm is unavailable." };
    }
    const result = await this.host.run(["install", "-g", `${request.npmPackage}@${request.target}`], 5 * 60 * 1000);
    if (result.kind === "failed") return { ok: false, reason: "npm update could not start or timed out." };
    if (result.code === 0) return { ok: true };
    return { ok: false, reason: (result.output.trim() || `npm exited with code ${result.code}.`).slice(0, 240) };
  }
}

const nodeProcessHost: CliUpdateProcessHost = {
  platform: hostRuntime.platform,
  async run(args, timeoutMs) {
    const env = { ...process.env };
    if (args[0] === "prefix") {
      return createCliStatusRunner({ platform: hostRuntime.platform, env, timeoutMs })("npm", ["prefix", "-g"]);
    }
    const npm = await which("npm", { nothrow: true });
    if (!npm) return { kind: "failed" };
    // npm.cmd cannot be execFile'd. Run its standard JS entry with node so package/version never enter a shell.
    if (hostRuntime.platform === "win32") {
      const node = await which("node", { nothrow: true });
      if (!node) return { kind: "failed" };
      return execNpm(node, [NodePath.join(NodePath.dirname(npm), "node_modules/npm/bin/npm-cli.js"), ...args], env, timeoutMs);
    }
    return execNpm(npm, args, env, timeoutMs);
  },
};

function execNpm(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliStatusOutcome> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(binary, [...args], {
      env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (!error) resolve({ kind: "exited", code: 0, output: stdout });
      else if (typeof error.code === "number") resolve({ kind: "exited", code: error.code, output: stderr || stdout });
      else resolve({ kind: "failed" });
    });
  });
}
