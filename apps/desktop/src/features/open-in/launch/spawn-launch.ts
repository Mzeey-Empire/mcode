/**
 * Shared detection and launch primitives for spawn-based open-in adapters
 * (editors, git GUIs, and future terminal kinds). Each adapter owns its CLI
 * arguments and metadata; the executable resolution and the detached
 * fire-and-forget spawn are identical across them and live here.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const WINDOWS_EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com)$/i;

function resolvePathCommand(cmd: string, platform: NodeJS.Platform): string | null {
  const checkCmd = platform === "win32" ? "where.exe" : "which";
  try {
    const output = NodeChildProcess.execFileSync(checkCmd, [cmd], {
      stdio: "pipe",
      encoding: "utf-8",
      ...(platform === "win32" ? { windowsHide: true } : {}),
    });
    if (platform !== "win32") return cmd;

    return String(output)
      .split(/\r?\n/)
      .map((path) => path.trim())
      .find((path) => WINDOWS_EXECUTABLE_SUFFIX.test(path)) ?? null;
  } catch {
    return null;
  }
}

/** Check whether a CLI command exists on the system PATH. */
export function commandOnPath(cmd: string, platform: NodeJS.Platform): boolean {
  return resolvePathCommand(cmd, platform) !== null;
}

/**
 * Build a memoized resolver for an app's executable: the PATH command when it
 * exists, otherwise the first existing Windows fallback path, or `null` when the
 * app is not installed. The result is cached on first call so detection and a
 * subsequent launch never repeat the PATH lookup.
 */
export function createExecutableResolver(
  command: string,
  platform: NodeJS.Platform,
  windowsPaths?: readonly string[],
): () => string | null {
  // `undefined` = not yet resolved; `null` = resolved as not installed.
  let resolved: string | null | undefined;
  return () => {
    if (resolved !== undefined) return resolved;
    const pathCommand = resolvePathCommand(command, platform);
    if (pathCommand) {
      resolved = pathCommand;
      return resolved;
    }
    if (platform === "win32" && windowsPaths) {
      for (const p of windowsPaths) {
        if (NodeFS.existsSync(p)) {
          resolved = p;
          return resolved;
        }
      }
    }
    resolved = null;
    return resolved;
  };
}

const WINDOWS_COMMAND_SLOT = "MCODE_OPEN_IN_COMMAND";
const WINDOWS_ARGUMENT_SLOT_PREFIX = "MCODE_OPEN_IN_ARG_";

function quoteForWindowsCommand(token: string): string {
  return `"${token}"`;
}

function spawnWindowsCommand(
  cmd: string,
  args: string[],
  spawnProcess: typeof NodeChildProcess.spawn,
): NodeChildProcess.ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [WINDOWS_COMMAND_SLOT]: quoteForWindowsCommand(cmd),
  };
  const commandSlots = args.map((arg, index) => {
    const slot = `${WINDOWS_ARGUMENT_SLOT_PREFIX}${index}`;
    env[slot] = quoteForWindowsCommand(arg);
    return `!${slot}!`;
  });
  const fixedCommand = [`!${WINDOWS_COMMAND_SLOT}!`, ...commandSlots].join(" ");

  return spawnProcess("cmd.exe", ["/d", "/v:on", "/s", "/c", fixedCommand], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsVerbatimArguments: true,
    windowsHide: true,
    env,
  });
}

/**
 * Spawn a detached, fire-and-forget child process and resolve once it has been
 * created.
 *
 * On Windows, an absolute path to an `.exe` is spawned directly. Bare PATH
 * commands and `.cmd`/`.bat` shims run through a fixed `cmd.exe` command while
 * the executable and arguments remain in child environment slots. This keeps
 * shell metacharacters out of the command string.
 *
 * @param platform Platform selected by the owning adapter.
 * @param spawnProcess Injectable process boundary used by focused tests.
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform,
  spawnProcess: typeof NodeChildProcess.spawn = NodeChildProcess.spawn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: NodeChildProcess.ChildProcess;
    if (platform === "win32" && /\.exe$/i.test(cmd)) {
      child = spawnProcess(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    } else if (platform === "win32") {
      child = spawnWindowsCommand(cmd, args, spawnProcess);
    } else {
      child = spawnProcess(cmd, args, { detached: true, stdio: "ignore" });
    }

    child.on("error", (err: Error) => reject(new Error(err.message)));
    // The "spawn" event fires once the child process has been created.
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
