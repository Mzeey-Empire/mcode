/**
 * Attachment persistence service.
 * Handles copying, validating, and storing file attachments for threads.
 * Extracted from the attachment handling in apps/desktop/src/main/app-state.ts.
 */

import { injectable } from "tsyringe";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { getMcodeDir } from "@mcode/shared";
import { DraftImageMissingError } from "./draft-image-missing-error.js";
import type { AttachmentMeta, StoredAttachment, StagedDraftImage } from "@mcode/contracts";
import {
  StagedDraftImageSchema,
  getAttachmentMaxSizeForMime,
  isVirtualBrowserContextAttachment,
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  shouldPersistAttachmentWithoutFile,
  storedAttachmentSuffix,
} from "@mcode/contracts";

const MAX_GENERATED_IMAGE_SIZE = 16 * 1024 * 1024;

/**
 * Pattern matching safe attachment IDs: alphanumerics, hyphens, and underscores only.
 * Prevents path traversal via crafted IDs containing `../` or other special characters.
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export { DraftImageMissingError };

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isMcodeTempFile(sourcePath: string): boolean {
  return [
    NodePath.join(getMcodeDir(), "temp", "attachments"),
    NodePath.join(NodeOS.tmpdir(), "mcode-attachments"),
  ].some((directory) => {
    const relative = NodePath.relative(directory, NodePath.resolve(sourcePath));
    return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
  });
}

/** Return the stored MIME type for supported image file extensions. */
export function imageMimeTypeFromPath(filePath: string): string | null {
  const ext = NodePath.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return null;
}

/** Resolve the base directory for attachment storage. */
function getAttachmentsDir(): string {
  return NodePath.join(getMcodeDir(), "attachments");
}

function assertSafeId(kind: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${kind}: ${value}. Only alphanumerics, hyphens, and underscores are allowed.`,
    );
  }
}

function resolveStoredAttachmentPath(baseDir: string, id: string, mimeType: string): string {
  const ext = storedAttachmentSuffix(mimeType);
  if (!ext) throw new Error(`Unsupported attachment MIME type: ${mimeType}`);
  const destPath = NodePath.resolve(baseDir, `${id}${ext}`);
  const rel = NodePath.relative(baseDir, destPath);
  if (rel.startsWith("..") || NodePath.resolve(baseDir, rel) !== destPath) {
    throw new Error(`Attachment path escapes thread directory: ${id}`);
  }
  return destPath;
}

function displayNameFromPath(filePath: string): string {
  const name = NodePath.basename(filePath).replace(/[\x00-\x1f\x7f]/g, "").trim();
  return name.length > 0 ? name : "generated-image";
}

/** Persists and reads file attachments for agent threads. */
@injectable()
export class AttachmentService {
  private readonly draftLeases = new Map<string, number>();

  /** Copy an image into durable draft storage, preserving its metadata across restarts. */
  async stageDraft(threadId: string, attachment: AttachmentMeta): Promise<StagedDraftImage> {
    assertSafeId("thread ID", threadId);
    const stagingId = NodeCrypto.randomUUID();
    const directory = NodePath.join(getAttachmentsDir(), threadId, "draft");
    const destination = resolveStoredAttachmentPath(directory, stagingId, attachment.mimeType);
    if (!imageMimeTypeFromPath(destination)) throw new Error("Draft attachments must be images");
    const stat = await NodeFSPromises.stat(attachment.sourcePath);
    if (!stat.isFile()) throw new Error("Draft image source is not a file");
    if (stat.size > getAttachmentMaxSizeForMime(attachment.mimeType)) throw new Error("Draft image exceeds attachment size limit");
    const image: StagedDraftImage = { stagingId, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: stat.size };
    await NodeFSPromises.mkdir(directory, { recursive: true });
    try {
      await NodeFSPromises.copyFile(attachment.sourcePath, destination);
      // Retention ages a staged file from staging time; copyFile keeps the source mtime on some platforms.
      const stagedAt = new Date();
      await NodeFSPromises.utimes(destination, stagedAt, stagedAt);
      await NodeFSPromises.writeFile(NodePath.join(directory, `${stagingId}.json`), JSON.stringify(image));
    } catch (error) {
      await NodeFSPromises.rm(destination, { force: true });
      await NodeFSPromises.rm(NodePath.join(directory, `${stagingId}.json`), { force: true });
      throw error;
    }
    if (isMcodeTempFile(attachment.sourcePath)) {
      await NodeFSPromises.rm(attachment.sourcePath, { force: true });
    }
    return image;
  }

  /** Lease images before admission reads them. Releasing a lease never removes files. */
  leaseDraftImages(threadId: string, stagingIds: readonly string[]): () => void {
    assertSafeId("thread ID", threadId);
    for (const id of stagingIds) assertSafeId("staging ID", id);
    const keys = [...new Set(stagingIds)].map((id) => `${threadId}/${id}`);
    for (const key of keys) this.draftLeases.set(key, (this.draftLeases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const remaining = (this.draftLeases.get(key) ?? 1) - 1;
        if (remaining === 0) this.draftLeases.delete(key);
        else this.draftLeases.set(key, remaining);
      }
    };
  }

  /** Copy leased draft images to fresh message attachments, rolling back partial copies. */
  async persistDraftImages(threadId: string, stagingIds: readonly string[]): Promise<Awaited<ReturnType<AttachmentService["persist"]>>> {
    const stored: StoredAttachment[] = [];
    const persisted: AttachmentMeta[] = [];
    try {
      for (const stagingId of new Set(stagingIds)) {
        assertSafeId("staging ID", stagingId);
        if (!this.draftLeases.has(`${threadId}/${stagingId}`)) throw new Error("Draft image must be leased before reading");
        const attachment = await this.readDraftImage(threadId, stagingId);
        const result = await this.persist(threadId, [attachment]).catch(async (error: unknown) => {
          await this.removeStoredAttachments(threadId, [attachment]);
          if (!NodeFS.existsSync(attachment.sourcePath)) throw new DraftImageMissingError(stagingId);
          throw error;
        });
        stored.push(...result.stored);
        persisted.push(...result.persisted);
      }
      return { stored, persisted };
    } catch (error) {
      await this.removeStoredAttachments(threadId, stored);
      throw error;
    }
  }

  private async readDraftImage(threadId: string, stagingId: string): Promise<AttachmentMeta> {
    const directory = NodePath.join(getAttachmentsDir(), threadId, "draft");
    try {
      const image = StagedDraftImageSchema().parse(JSON.parse(await NodeFSPromises.readFile(NodePath.join(directory, `${stagingId}.json`), "utf8")));
      const sourcePath = resolveStoredAttachmentPath(directory, stagingId, image.mimeType);
      await NodeFSPromises.access(sourcePath);
      return { id: NodeCrypto.randomUUID(), name: image.name, mimeType: image.mimeType, sizeBytes: image.sizeBytes, sourcePath };
    } catch (error) {
      if (isMissingFile(error)) throw new DraftImageMissingError(stagingId);
      throw error;
    }
  }

  /** Remove draft files older than thirty days, without racing an admission lease. */
  removeExpiredDraftImages(now: () => number = Date.now): number {
    const root = getAttachmentsDir();
    if (!NodeFS.existsSync(root)) return 0;
    const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const thread of NodeFS.readdirSync(root, { withFileTypes: true })) {
      if (!thread.isDirectory()) continue;
      removed += this.sweepDraftDirectory(thread.name, cutoff);
    }
    return removed;
  }

  private sweepDraftDirectory(threadId: string, cutoff: number): number {
    const directory = NodePath.join(getAttachmentsDir(), threadId, "draft");
    if (!NodeFS.existsSync(directory) || NodeFS.lstatSync(directory).isSymbolicLink()) return 0;
    let removed = 0;
    for (const file of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const stagingId = NodePath.parse(file.name).name;
      if (this.draftLeases.has(`${threadId}/${stagingId}`)) continue;
      const path = NodePath.join(directory, file.name);
      if (NodeFS.statSync(path).mtimeMs >= cutoff) continue;
      NodeFS.unlinkSync(path);
      if (!file.name.endsWith(".json")) removed++;
    }
    return removed;
  }

  /** Rebuild outbound attachment metadata from Mcode-owned stored files for an explicit Retry. */
  prepareRetryAttachments(
    threadId: string,
    attachments: readonly StoredAttachment[],
  ): AttachmentMeta[] {
    assertSafeId("thread ID", threadId);
    const baseDir = NodePath.join(getAttachmentsDir(), threadId);
    return attachments.map((attachment) => {
      assertSafeId("attachment ID", attachment.id);
      if (shouldPersistAttachmentWithoutFile({ ...attachment, sourcePath: "" })) {
        return { ...attachment, id: NodeCrypto.randomUUID(), sourcePath: "" };
      }
      const sourcePath = resolveStoredAttachmentPath(baseDir, attachment.id, attachment.mimeType);
      if (!NodeFS.existsSync(sourcePath) || !NodeFS.statSync(sourcePath).isFile()) {
        throw new Error(`Stored attachment file not found: ${attachment.id}`);
      }
      return { ...attachment, id: NodeCrypto.randomUUID(), sourcePath };
    });
  }

  /**
   * Copy and validate attachments for a thread.
   * Returns both stored metadata (for DB) and persisted metadata (with new paths).
   */
  async persist(
    threadId: string,
    attachments: AttachmentMeta[],
  ): Promise<{
    stored: StoredAttachment[];
    persisted: AttachmentMeta[];
  }> {
    if (attachments.length === 0) return { stored: [], persisted: [] };
    assertSafeId("thread ID", threadId);

    const baseDir = NodePath.join(getAttachmentsDir(), threadId);
    await NodeFSPromises.mkdir(baseDir, { recursive: true });

    const results = await Promise.all(
      attachments.map(async (att) => {
        if (shouldPersistAttachmentWithoutFile(att)) {
          if (!SAFE_ID_PATTERN.test(att.id)) {
            throw new Error(
              `Invalid attachment ID: ${att.id}. Only alphanumerics, hyphens, and underscores are allowed.`,
            );
          }
          const mime = isVirtualBrowserContextAttachment(att.mimeType)
            ? att.mimeType.trim()
            : MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME;
          return {
            stored: {
              id: att.id,
              name: att.name,
              mimeType: mime,
              sizeBytes: 0,
            } as StoredAttachment,
            persisted: null as AttachmentMeta | null,
          };
        }

        if (!NodeFS.existsSync(att.sourcePath)) {
          throw new Error(`Attachment file not found: ${att.sourcePath}`);
        }

        const actualSize = NodeFS.statSync(att.sourcePath).size;
        const maxSize = getAttachmentMaxSizeForMime(att.mimeType);
        if (actualSize > maxSize) {
          throw new Error(
            `Attachment "${att.name}" exceeds ${maxSize} byte limit (actual: ${actualSize})`,
          );
        }

        // Validate attachment ID to prevent path traversal
        assertSafeId("attachment ID", att.id);
        const destPath = resolveStoredAttachmentPath(baseDir, att.id, att.mimeType);

        await NodeFSPromises.copyFile(att.sourcePath, destPath);

        // Clean up temp file if it came from a known temp location
        const tempDir = NodePath.resolve(getMcodeDir(), "temp", "attachments");
        const resolvedSource = NodePath.resolve(att.sourcePath);
        const tempRel = NodePath.relative(tempDir, resolvedSource);
        if (!tempRel.startsWith("..") && !NodePath.resolve(tempDir, tempRel).includes("..")) {
          try {
            await NodeFSPromises.unlink(att.sourcePath);
          } catch {
            /* non-fatal */
          }
        }

        return {
          stored: {
            id: att.id,
            name: att.name,
            mimeType: att.mimeType,
            sizeBytes: actualSize,
          } as StoredAttachment,
          persisted: {
            ...att,
            sourcePath: destPath,
            sizeBytes: actualSize,
          } as AttachmentMeta,
        };
      }),
    );

    return {
      stored: results.map((r) => r.stored),
      persisted: results.map((r) => r.persisted).filter((p): p is AttachmentMeta => p != null),
    };
  }

  /** Remove only the Mcode-owned files for the specified stored attachments. */
  async removeStoredAttachments(threadId: string, attachments: readonly StoredAttachment[]): Promise<void> {
    assertSafeId("thread ID", threadId);
    const baseDir = NodePath.join(getAttachmentsDir(), threadId);
    await Promise.all(attachments.map(async (attachment) => {
      assertSafeId("attachment ID", attachment.id);
      if (shouldPersistAttachmentWithoutFile({ ...attachment, sourcePath: "" })) return;
      const storedPath = resolveStoredAttachmentPath(baseDir, attachment.id, attachment.mimeType);
      try {
        await NodeFSPromises.unlink(storedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }));
  }

  /** Copy a Codex-generated image into Mcode-managed attachment storage. */
  persistGeneratedImageFromPath(threadId: string, sourcePath: string): StoredAttachment {
    assertSafeId("thread ID", threadId);

    const mimeType = imageMimeTypeFromPath(sourcePath);
    if (!mimeType) {
      throw new Error("Generated image has an unsupported file extension");
    }
    if (!NodeFS.existsSync(sourcePath)) {
      throw new Error("Generated image file not found");
    }

    const stat = NodeFS.statSync(sourcePath);
    if (!stat.isFile()) {
      throw new Error("Generated image source is not a file");
    }
    if (stat.size > MAX_GENERATED_IMAGE_SIZE) {
      throw new Error(
        `Generated image exceeds ${MAX_GENERATED_IMAGE_SIZE} byte limit (actual: ${stat.size})`,
      );
    }

    const id = NodeCrypto.randomUUID();
    const baseDir = NodePath.join(getAttachmentsDir(), threadId);
    NodeFS.mkdirSync(baseDir, { recursive: true });
    const destPath = resolveStoredAttachmentPath(baseDir, id, mimeType);
    NodeFS.copyFileSync(sourcePath, destPath);

    return {
      id,
      name: displayNameFromPath(sourcePath),
      mimeType,
      sizeBytes: stat.size,
    };
  }

  /** Remove all attachments for a thread from disk. */
  removeForThread(threadId: string): void {
    // Validate threadId to prevent path traversal via crafted IDs like "../"
    if (!SAFE_ID_PATTERN.test(threadId)) {
      throw new Error(
        `Invalid thread ID: ${threadId}. Only alphanumerics, hyphens, and underscores are allowed.`,
      );
    }

    const attachmentsBase = getAttachmentsDir();
    const dir = NodePath.resolve(attachmentsBase, threadId);

    // Verify the resolved path stays within the attachments directory
    const rel = NodePath.relative(attachmentsBase, dir);
    if (rel.startsWith("..") || NodePath.resolve(attachmentsBase, rel) !== dir) {
      throw new Error(`Thread attachment path escapes attachments directory: ${threadId}`);
    }

    if (NodeFS.existsSync(dir)) {
      try {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }
}
