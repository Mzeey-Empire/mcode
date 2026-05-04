/**
 * Resolves the user's current environment from a login shell (Unix) or the
 * Windows registry machine + user hives, for passing to child processes.
 */

import { execFileSync } from "node:child_process";
import { injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { flattenProcessEnv, parseNullDelimitedEnv } from "./shell-env-utils.js";

const RESOLVE_TIMEOUT_MS = 5000;
const MAX_ENV_BUFFER_BYTES = 32 * 1024 * 1024;

// Re-export for call sites that only need helpers without pulling tsyringe metadata.
export { flattenProcessEnv, parseNullDelimitedEnv } from "./shell-env-utils.js";

/**
 * Platform-specific env resolution with a retained last-good fallback.
 */
@injectable()
export class ShellEnvResolver {
  private lastSuccess: Record<string, string> | null = null;
  private readonly bootEnv: Record<string, string>;

  constructor() {
    this.bootEnv = flattenProcessEnv(process.env);
  }

  /**
   * Attempts a fresh resolution; on failure logs and returns the last successful
   * map, or the boot-time process env if none.
   */
  resolveFresh(): Record<string, string> {
    try {
      const resolved =
        process.platform === "win32" ? this.resolveWindows() : this.resolveUnix();
      if (Object.keys(resolved).length === 0) {
        throw new Error("resolved env empty");
      }
      this.lastSuccess = resolved;
      return resolved;
    } catch (err) {
      logger.warn("ShellEnvResolver: fresh resolution failed; using fallback env", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.lastSuccess ?? { ...this.bootEnv };
    }
  }

  private resolveUnix(): Record<string, string> {
    const shell = process.env.SHELL ?? "/bin/bash";
    const buf = execFileSync(shell, ["-ilc", "env -0"], {
      encoding: "buffer",
      timeout: RESOLVE_TIMEOUT_MS,
      maxBuffer: MAX_ENV_BUFFER_BYTES,
      windowsHide: true,
    }) as Buffer;
    return parseNullDelimitedEnv(buf);
  }

  private resolveWindows(): Record<string, string> {
    // Base64 wraps UTF-8 NUL-delimited pairs so we do not depend on the console
    // code page (raw Write would often emit UTF-16 on Windows).
    const script = [
      "$m = [Environment]::GetEnvironmentVariables('Machine')",
      "$u = [Environment]::GetEnvironmentVariables('User')",
      "$r = @{}",
      "foreach ($k in $m.Keys) { $r[$k] = $m[$k] }",
      "foreach ($k in $u.Keys) {",
      "  if ($k -eq 'Path') { $r[$k] = $m[$k] + ';' + $u[$k] }",
      "  else { $r[$k] = $u[$k] }",
      "}",
      "$sb = New-Object System.Text.StringBuilder",
      "foreach ($k in $r.Keys) {",
      "  [void]$sb.Append($k).Append('=').Append($r[$k]).Append([char]0)",
      "}",
      "$bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())",
      "[Console]::Out.Write([Convert]::ToBase64String($bytes))",
    ].join("; ");

    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        timeout: RESOLVE_TIMEOUT_MS,
        maxBuffer: MAX_ENV_BUFFER_BYTES,
        windowsHide: true,
      },
    ).trim();
    const buf = Buffer.from(out, "base64");
    return parseNullDelimitedEnv(buf);
  }
}
