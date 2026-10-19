import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  STARTUP_FAILURE_EXIT_CODE,
  STARTUP_FAILURE_FILE_NAME,
  type StartupFailureFile,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { DatabaseStartupRefusal, rootCauseMessage } from "../../runtime/persistence/sqlite/startup-refusal.js";

/** Where and for whom a failed start is recorded. */
export interface StartupFailureTarget {
  readonly dataDir: string;
  /** The `MCODE_STARTUP_ID` the desktop spawned this process with; absent for CLI and dev starts. */
  readonly startupId: string | undefined;
}

/** What `runStartupOrExit` needs besides the work itself. `exit` is injectable so tests do not end the test process. */
export interface StartupFailureOptions extends StartupFailureTarget {
  readonly exit?: (code: number) => never;
}

/** The failure target for this process: the data directory, and the id the desktop gave this spawn, if any. */
export function startupFailureTarget(dataDir: string, env: NodeJS.ProcessEnv = process.env): StartupFailureTarget {
  return { dataDir, startupId: env.MCODE_STARTUP_ID || undefined };
}

/** Path of the failure record inside a data directory. */
export function startupFailurePath(dataDir: string): string {
  return NodePath.join(dataDir, STARTUP_FAILURE_FILE_NAME);
}

/** `setupContainer` wraps the open failure in an `AggregateError` when closing the writer also fails. */
function findRefusal(error: unknown): DatabaseStartupRefusal | undefined {
  if (error instanceof DatabaseStartupRefusal) return error;
  if (!(error instanceof AggregateError)) return undefined;
  return error.errors.find((member): member is DatabaseStartupRefusal => member instanceof DatabaseStartupRefusal);
}

function buildStartupFailureFile(error: unknown, startupId: string): StartupFailureFile {
  const refusal = findRefusal(error);
  return refusal
    ? { version: 1, startupId, refusal: refusal.refusal }
    : { version: 1, startupId, unexpected: { message: rootCauseMessage(error) } };
}

/** Temp file then rename, so the desktop never reads half a record. */
function writeStartupFailureFile(dataDir: string, file: StartupFailureFile): void {
  const target = startupFailurePath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  NodeFS.mkdirSync(dataDir, { recursive: true });
  NodeFS.writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 });
  NodeFS.renameSync(temporary, target);
}

function recordStartupFailure(error: unknown, target: StartupFailureTarget): void {
  const refusal = findRefusal(error);
  // A refusal is an expected outcome the message explains. Anything else is a bug that needs its stack.
  logger.error("Server startup failed", {
    kind: refusal ? refusal.refusal.kind : "unexpected",
    error: rootCauseMessage(error),
    ...(!refusal && error instanceof Error ? { stack: error.stack } : {}),
  });
  if (!target.startupId) return;
  try {
    writeStartupFailureFile(target.dataDir, buildStartupFailureFile(error, target.startupId));
  } catch (writeError) {
    logger.error("Could not write startup-failure.json", { error: rootCauseMessage(writeError) });
  }
}

/**
 * Runs startup work. If it fails, records why and exits 78 so the desktop can read the record.
 * A success leaves any earlier record alone: the data directory is shared by channels, and the
 * desktop trusts a record only when its `startupId` matches the spawn it just made. Without a
 * startup id (CLI, dev) the failure is logged and rethrown, which keeps the exit behaviour those
 * starts have always had.
 */
export async function runStartupOrExit<T>(work: () => Promise<T>, options: StartupFailureOptions): Promise<T> {
  try {
    return await work();
  } catch (error) {
    recordStartupFailure(error, options);
    if (!options.startupId) throw error;
    return (options.exit ?? process.exit)(STARTUP_FAILURE_EXIT_CODE);
  }
}
