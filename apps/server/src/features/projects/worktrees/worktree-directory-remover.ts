import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";

/**
 * Default hard limit for a recursive worktree directory removal.
 * The bound exists for a wedged filesystem call, not throughput: the
 * platform-native commands below clear large trees in seconds, while the
 * previous Node fs.rm payload needed longer than 30s on big node_modules
 * checkouts and kept timing out mid-delete.
 */
export const DEFAULT_WORKTREE_REMOVAL_TIMEOUT_MS = 120_000;

/** Maximum time allowed for confirming that a timed-out remover was killed. */
const KILL_CONFIRMATION_TIMEOUT_MS = 1_000;

/** Captured child output kept for error messages. */
const OUTPUT_TAIL_LIMIT = 2_000;

const REMOVE_SCRIPT = [
  "require('node:fs/promises').rm(process.argv[1], { recursive: true, force: true })",
  ".catch((error) => { console.error(error); process.exitCode = 1; });",
].join(" ");

/** Dependencies used by the bounded child-process deletion boundary. */
export interface WorktreeDirectoryRemoverDependencies {
  spawn?: typeof NodeChildProcess.spawn;
  killTree?: (child: NodeChildProcess.ChildProcess) => void | Promise<void>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

type RemovalCommand = {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/**
 * Pick the fastest correct removal command for the platform.
 * cmd expands %VAR% even inside quotes, so cmd-hostile paths fall back to the
 * Node fs.rm payload; managed worktree names never contain these characters.
 */
function removalCommand(target: string, platform: NodeJS.Platform): RemovalCommand {
  if (platform === "win32") {
    if (!/[%"\r\n]/.test(target)) {
      return {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", `rmdir /s /q "${target}"`],
        // libuv re-quotes arguments containing spaces in a way cmd cannot parse.
        windowsVerbatimArguments: true,
      };
    }
    return { file: process.execPath, args: ["-e", REMOVE_SCRIPT, target] };
  }
  return { file: "rm", args: ["-rf", "--", target] };
}

/** Removes one validated worktree directory in an isolated child process. */
@injectable()
export class WorktreeDirectoryRemover {
  private readonly dependencies: Omit<Required<WorktreeDirectoryRemoverDependencies>, "platform"> & {
    readonly platform: NodeJS.Platform | undefined;
  };

  constructor(
    @inject("WorktreeDirectoryRemoverDependencies", { isOptional: true })
    dependencies: WorktreeDirectoryRemoverDependencies = {},
  ) {
    this.dependencies = {
      spawn: NodeChildProcess.spawn,
      killTree: (child) => killChildTree(child, this.requirePlatform()),
      platform: dependencies.platform,
      timeoutMs: DEFAULT_WORKTREE_REMOVAL_TIMEOUT_MS,
      ...dependencies,
    };
  }

  /**
   * Remove a directory without allowing recursive filesystem work to block
   * the server event loop indefinitely.
   *
   * @param targetPath Absolute worktree directory path.
   * @param timeoutMs Optional test override for the hard child limit.
   */
  async remove(targetPath: string, timeoutMs = this.dependencies.timeoutMs): Promise<void> {
    const platform = this.requirePlatform();
    const target = validateRemovalTarget(targetPath, platform);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid worktree removal timeout: ${timeoutMs}`);
    }

    const command = removalCommand(target, platform);
    const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
    const child = this.dependencies.spawn(command.file, command.args, {
      cwd: pathApi.parse(target).dir,
      shell: false,
      windowsHide: true,
      detached: platform !== "win32",
      windowsVerbatimArguments: command.windowsVerbatimArguments === true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputTail = captureBoundedOutput(child);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timedOut = false;
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolveClosePromise) => {
        resolveClose = resolveClosePromise;
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void (async () => {
          const timeoutError = new Error(
            `Worktree directory removal timed out after ${timeoutMs}ms: ${target}`,
          );
          try {
            await this.dependencies.killTree(child);
          } catch {
            // The removal already exceeded its deadline. Return the timeout
            // after the kill attempt even if the OS reports a stale PID.
          }
          await Promise.race([
            closePromise,
            new Promise<void>((resolveConfirmation) => {
              setTimeout(resolveConfirmation, KILL_CONFIRMATION_TIMEOUT_MS);
            }),
          ]);
          finish(timeoutError);
        })();
      }, timeoutMs);

      child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      child.once("close", (code, signal) => {
        resolveClose();
        if (timedOut) return;
        if (code === 0) {
          finish();
          return;
        }
        finish(new Error(
          `Worktree directory removal failed${signal ? ` (${signal})` : ` with exit code ${code}`}: ${target}${formatOutputTail(outputTail())}`,
        ));
      });
    });

    // cmd's rmdir can exit 0 while leaving locked entries behind.
    if (NodeFS.existsSync(target)) {
      throw new Error(`Worktree directory removal reported success but path remains: ${target}`);
    }
  }

  private requirePlatform(): NodeJS.Platform {
    if (this.dependencies.platform) return this.dependencies.platform;
    throw new Error("Worktree directory remover platform is required");
  }
}

/** Keep the tail of child output for error messages without unbounded memory. */
function captureBoundedOutput(child: NodeChildProcess.ChildProcess): () => string {
  let tail = "";
  const append = (chunk: unknown) => {
    tail = (tail + String(chunk)).slice(-OUTPUT_TAIL_LIMIT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => tail.trim();
}

function formatOutputTail(tail: string): string {
  return tail ? `; output: ${tail}` : "";
}

/** Validate a child-process deletion target at the filesystem boundary. */
export function validateRemovalTarget(targetPath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  if (typeof targetPath !== "string" || !pathApi.isAbsolute(targetPath)) {
    throw new Error(`Worktree removal target must be absolute: ${targetPath}`);
  }
  const target = pathApi.resolve(targetPath);
  if (target === pathApi.parse(target).root) {
    throw new Error(`Refusing to remove filesystem root: ${target}`);
  }
  const protectedPaths = [
    { path: NodePath.resolve(process.cwd()), label: "server working directory" },
    { path: NodePath.resolve(process.execPath), label: "server executable" },
  ];
  for (const protectedPath of protectedPaths) {
    if (isEqualOrAncestor(target, protectedPath.path, platform)) {
      throw new Error(`Refusing to remove the ${protectedPath.label}: ${target}`);
    }
  }
  return target;
}

/** Terminate the isolated remover and all of its descendants. */
async function killChildTree(child: NodeChildProcess.ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (!child.pid) return;
  if (platform === "win32") {
    await new Promise<void>((resolvePromise) => {
      const killer = NodeChildProcess.spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* already stopped */ }
        resolvePromise();
      }, KILL_CONFIRMATION_TIMEOUT_MS);
      killer.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      killer.once("error", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/** Compare path ancestry with Windows case-insensitive semantics. */
function isEqualOrAncestor(candidate: string, protectedPath: string, platform: NodeJS.Platform): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate, platform);
  const normalizedProtectedPath = normalizePathForComparison(protectedPath, platform);
  if (normalizedCandidate === normalizedProtectedPath) return true;
  const separator = platform === "win32" ? "\\" : "/";
  return normalizedProtectedPath.startsWith(
    normalizedCandidate.endsWith(separator) ? normalizedCandidate : `${normalizedCandidate}${separator}`,
  );
}

/** Normalize path text for lexical ancestry checks. */
function normalizePathForComparison(path: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const normalized = pathApi.resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
