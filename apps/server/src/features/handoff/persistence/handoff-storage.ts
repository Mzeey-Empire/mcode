import * as NodeFSPromises from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { injectable } from "tsyringe";
import { parseDocument } from "yaml";
import { HandoffAuditMetadataSchema, type HandoffAuditMetadata } from "@mcode/contracts";
import {
  getMcodeDir,
  resolveHandoffDir,
  resolveThreadHandoffsDir,
} from "@mcode/shared";

/** The selected history and provenance saved after a switch, fork, or recovery. */
export type HandoffAudit = Omit<HandoffAuditMetadata, "schemaVersion" | "coveredSequences" | "omittedSequences" | "droppedOptions"> & {
  readonly coveredSequences: readonly number[];
  readonly omittedSequences: readonly number[];
  readonly droppedOptions: readonly HandoffAuditMetadata["droppedOptions"][number][];
  /** The rendered history exactly as the target received it. */
  readonly history: string;
};

/** Persists inline handoff audits and removes thread-owned files on deletion. */
@injectable()
export class HandoffStorage {
  private mcodeDirFn: () => string = getMcodeDir;

  /** Uses a fixture directory without changing the process-wide data directory. */
  static forTesting(overrides: { mcodeDirFn: () => string }): HandoffStorage {
    const storage = new HandoffStorage();
    storage.mcodeDirFn = overrides.mcodeDirFn;
    return storage;
  }

  /** Returns the requested v2 audit and its exact replay history, or null for invalid or missing artifacts. */
  async read(threadId: string, handoffId: string): Promise<{ meta: HandoffAuditMetadata; history: string } | null> {
    let dir: string;
    try {
      dir = resolveHandoffDir(this.mcodeDirFn(), threadId, handoffId);
    } catch {
      return null;
    }
    let markdown: string;
    try {
      markdown = await NodeFSPromises.readFile(NodePath.join(dir, "handoff.md"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const meta = readAuditMetadata(markdown);
    if (!meta) return null;
    const history = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/, "").replace(/\n$/, "");
    return { meta, history };
  }

  /** Returns the newest v2 audit, ignoring older artifact formats on disk. */
  async readLatest(threadId: string): Promise<{ markdown: string; meta: HandoffAuditMetadata } | null> {
    const handoffsRoot = resolveThreadHandoffsDir(this.mcodeDirFn(), threadId);
    if (!NodeFS.existsSync(handoffsRoot)) return null;
    const entries = await NodeFSPromises.readdir(handoffsRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const entry of directories) {
      const dir = NodePath.join(handoffsRoot, entry);
      // Pre-v2 artifacts have separate JSON metadata and must not enter the v2 wire contract.
      if (NodeFS.existsSync(NodePath.join(dir, "handoff.json"))) continue;
      const markdown = await NodeFSPromises.readFile(NodePath.join(dir, "handoff.md"), "utf8");
      const meta = readAuditMetadata(markdown);
      if (meta) return { markdown, meta };
    }
    return null;
  }

  /** Persists the audit copy of an inline handoff as schemaVersion 2 handoff.md. */
  async writeHandoffAudit(threadId: string, ulid: string, audit: HandoffAudit): Promise<string> {
    const handoffDir = resolveHandoffDir(this.mcodeDirFn(), threadId, ulid);
    await NodeFSPromises.mkdir(handoffDir, { recursive: true });
    const frontmatter = [
      "schemaVersion: 2",
      `kind: ${audit.kind}`,
      `fromProvider: ${JSON.stringify(audit.fromProvider)}`,
      `toProvider: ${JSON.stringify(audit.toProvider)}`,
      `coveredSequences: ${JSON.stringify(audit.coveredSequences)}`,
      `omittedSequences: ${JSON.stringify(audit.omittedSequences)}`,
      `budgetBytes: ${audit.budgetBytes}`,
      `droppedOptions: ${JSON.stringify(audit.droppedOptions)}`,
    ].join("\n");
    await NodeFSPromises.writeFile(NodePath.join(handoffDir, "handoff.md"), `---\n${frontmatter}\n---\n\n${audit.history}\n`, "utf8");
    return ulid;
  }

  /** The newest v2 audit's markdown, or null when the thread has none. */
  async readLatestHandoffAudit(threadId: string): Promise<string | null> {
    return (await this.readLatest(threadId))?.markdown ?? null;
  }

  /** Removes the thread subtree when the owning thread is permanently deleted. */
  async deleteThreadFiles(threadId: string): Promise<void> {
    const threadRoot = NodePath.dirname(resolveThreadHandoffsDir(this.mcodeDirFn(), threadId));
    await NodeFSPromises.rm(threadRoot, { recursive: true, force: true });
  }
}

function readAuditMetadata(markdown: string): HandoffAuditMetadata | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (!frontmatter) return null;
  const document = parseDocument(frontmatter);
  if (document.errors.length > 0) return null;
  const parsed = HandoffAuditMetadataSchema().safeParse(document.toJS());
  return parsed.success ? parsed.data : null;
}
