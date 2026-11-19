import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { z } from "zod";
import { logger } from "@mcode/shared";
import { resolveDatabasePath } from "../../../../runtime/persistence/sqlite/database.js";

/**
 * Present `stoppedAt` means this stop's interrupted turns have not been listed yet. Startup replaces it with
 * explicit continuations before settlement, so a later crash cannot add work begun after that stop.
 */
const restartSchema = z.object({
  version: z.literal(1),
  stoppedAt: z.string().datetime().optional(),
  resumes: z.array(z.object({ threadId: z.string(), turnId: z.string(), executionId: z.string() })),
  wakes: z.array(z.object({ threadId: z.string(), anchorTurnId: z.string() })),
});

/** Work to continue after a planned stop. */
export type PlannedRestartRecord = z.infer<typeof restartSchema>;

/** Atomic, consume-once storage beside the application database. */
export class PlannedRestartStore {
  readonly filename: string;

  constructor(databasePath = resolveDatabasePath()) {
    this.filename = NodePath.join(NodePath.dirname(databasePath), "planned-restart.json");
  }

  /** Read without consuming: startup may exit before it can dispatch continuations. */
  read(): PlannedRestartRecord | null {
    let raw: string;
    for (let attempt = 1; ; attempt += 1) {
      try {
        raw = NodeFS.readFileSync(this.filename, "utf8");
        break;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ENOENT") return null;
        if (attempt < 3 && ["EBUSY", "EPERM", "EACCES"].includes(String(code))) {
          // Windows indexers can hold the file briefly; startup has not begun listening yet.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          continue;
        }
        logger.warn("Planned restart file could not be read", { error: String(error) });
        return null;
      }
    }
    try {
      return restartSchema.parse(JSON.parse(raw));
    } catch (error) {
      logger.warn("Invalid planned restart file ignored", { error: String(error) });
      return null;
    }
  }

  /** Consume before dispatch so refused continuations are never retried. False when the file is still there. */
  clear(): boolean {
    try {
      NodeFS.unlinkSync(this.filename);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      logger.warn("Planned restart file could not be cleared", { error: String(error) });
      return false;
    }
  }

  /** Replace the record only once its complete contents are on disk. */
  record(record: PlannedRestartRecord): void {
    const temporary = `${this.filename}.tmp`;
    NodeFS.writeFileSync(temporary, JSON.stringify(record));
    NodeFS.renameSync(temporary, this.filename);
  }
}
