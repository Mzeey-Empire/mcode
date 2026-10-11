import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import which from "which";

/** What one CLI status command did. `failed` covers a missing binary, timeout, crash, or rejected path. */
export type CliStatusOutcome =
  | { kind: "exited"; code: number; output: string }
  | { kind: "failed" };

/** Runs one fixed status command against a provider CLI. Tests replace it with a stub. */
export type CliStatusRunner = (binary: string, args: readonly string[]) => Promise<CliStatusOutcome>;

/** Options for {@link createCliStatusRunner}. */
export interface CliStatusRunnerOptions {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SHELL_METACHAR_RE = /[;&|`$(){}!<>"'%^\n\r]/;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * Creates a runner that resolves the binary on PATH and runs it without a
 * shell, a short timeout, and bounded output. Output never leaves the
 * process except as the parsed sign-in state, because it can hold emails.
 */
export function createCliStatusRunner(options: CliStatusRunnerOptions): CliStatusRunner {
  return async (binary, args) => {
    const resolved = await resolveBinary(binary, options.env);
    if (!resolved) return { kind: "failed" };
    const shell = needsWindowsShim(resolved, options.platform);
    if (shell && SHELL_METACHAR_RE.test(resolved)) return { kind: "failed" };
    if (!shell) return await execStatus(resolved, args, false, options);
    // One prebuilt command line, because Node deprecates passing args alongside `shell: true` (DEP0190).
    return await execStatus([`"${resolved}"`, ...args].join(" "), [], true, options);
  };
}

async function resolveBinary(
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (NodePath.isAbsolute(binary)) return binary;
  const path = env.PATH ?? env.Path;
  return await which(binary, { nothrow: true, ...(path ? { path } : {}) });
}

/**
 * npm installs Windows CLIs as `.cmd` shims, which Node can only start through
 * cmd.exe. The arguments are fixed adapter constants and the path is rejected
 * when it holds shell metacharacters, so the shell sees no caller input. The
 * path is quoted so installs under "Program Files" still start.
 */
function needsWindowsShim(resolved: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
}

function execStatus(
  file: string,
  args: readonly string[],
  shell: boolean,
  options: CliStatusRunnerOptions,
): Promise<CliStatusOutcome> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      {
        env: { ...options.env },
        shell,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve(toOutcome(error, `${stdout}\n${stderr}`));
      },
    );
  });
}

function toOutcome(error: NodeChildProcess.ExecFileException | null, output: string): CliStatusOutcome {
  const text = output.replace(ANSI_ESCAPE_RE, "");
  if (!error) return { kind: "exited", code: 0, output: text };
  // A numeric code is a normal non-zero exit; a string code (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER)
  // or a signal means the command never gave a usable answer.
  if (typeof error.code === "number" && !error.killed && !error.signal) {
    return { kind: "exited", code: error.code, output: text };
  }
  return { kind: "failed" };
}
