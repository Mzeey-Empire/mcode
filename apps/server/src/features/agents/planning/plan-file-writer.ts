import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { getMcodeDir, resolveThreadPlanFile } from "@mcode/shared";
import type { PlanVersion } from "@mcode/contracts";

/** Serializes atomic file projections and reads the latest row when each write starts. */
export class PlanFileWriter {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly readPlans: (threadId: string) => readonly PlanVersion[],
    private readonly mcodeDir: () => string = getMcodeDir) {}

  /** Mirror the latest non-superseded committed version, preserving its exact text. */
  write(threadId: string): Promise<void> {
    const preceding = this.pending.get(threadId) ?? Promise.resolve();
    const next = preceding.then(() => this.project(threadId), () => this.project(threadId));
    this.pending.set(threadId, next);
    const settled = () => { if (this.pending.get(threadId) === next) this.pending.delete(threadId); };
    void next.then(settled, settled);
    return next;
  }

  private async project(threadId: string): Promise<void> {
    const latest = this.readPlans(threadId).filter((plan) => plan.status !== "superseded")
      .sort((a, b) => b.version - a.version)[0];
    if (!latest) return;
    const destination = resolveThreadPlanFile(this.mcodeDir(), threadId);
    await NodeFSPromises.mkdir(NodePath.dirname(destination), { recursive: true });
    const temporary = `${destination}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSPromises.writeFile(temporary, latest.contentMd, { encoding: "utf8", flag: "wx" });
      await NodeFSPromises.rename(temporary, destination);
    } finally { await NodeFSPromises.rm(temporary, { force: true }); }
  }
}
