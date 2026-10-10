import type { PlanSaveError, PlanSaveVersion, PlanVersion } from "@mcode/contracts";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { broadcast } from "../../../application/transport/push.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import { mergePlanVersions } from "./merge-plan-versions.js";
import type { PlanFileWriter } from "./plan-file-writer.js";
import { planWriteOperations } from "./persistence/plan-write-operations.js";

/** A rejected plan operation, with the current version for explicit conflict resolution. */
export class PlanServiceError extends Error {
  readonly code: PlanSaveError["code"];
  readonly latestVersion: PlanVersion | null;

  constructor(failure: PlanSaveError) {
    super(failure.code);
    this.code = failure.code;
    this.latestVersion = failure.latestVersion;
  }
}

/** User plan writes bypass canonical ownership and rejoin it only through a cache reload. */
export class PlanService {
  constructor(private readonly writer: ApplicationDatabaseWriter,
    private readonly progress: Pick<CanonicalAcceptedProgress, "reloadPlans" | "waitForTerminalSaves"> | undefined,
    private readonly files: PlanFileWriter) {}

  /** Save or replay one revision-checked draft and publish only after commit. */
  async saveVersion(input: PlanSaveVersion): Promise<PlanVersion> {
    await this.progress?.waitForTerminalSaves(input.threadId);
    const result = await this.writer.execute(planWriteOperations.saveVersion, input);
    if (!result.ok) throw new PlanServiceError(result);
    this.progress?.reloadPlans(input.threadId);
    broadcast("plan.versionUpserted", { threadId: input.threadId, version: result.version });
    await this.files.writeAfterCommit(input.threadId);
    return result.version;
  }

  /** Read a serialized snapshot and preserve any later accepted status in memory. */
  async snapshot(input: { threadId: string }): Promise<{ versions: PlanVersion[] }> {
    const result = await this.writer.execute(planWriteOperations.snapshot, input);
    if (!result.ok) throw new PlanServiceError(result);
    return { versions: mergePlanVersions(result.versions, this.progress?.reloadPlans(input.threadId) ?? result.versions) };
  }
}
