import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { isContainedPath } from "../protocol/handler.js";

/** IPC channel that returns the bytes of an image the server staged for a draft. */
export const READ_STAGED_DRAFT_IMAGE_CHANNEL = "read-staged-draft-image";

const SAFE_ID = /^[a-f0-9-]+$/;

/** Reads one staged draft image by thread and staging id. */
export type StagedDraftImageReader = (threadId: unknown, stagingId: unknown) => Promise<Uint8Array | null>;

/**
 * Builds the reader behind {@link READ_STAGED_DRAFT_IMAGE_CHANNEL}. The renderer
 * cannot fetch the custom attachment scheme, and an image drawn from it would
 * taint the canvas that redraws page snapshots, so it asks the main process for
 * bytes. Only ids are accepted, and the resolved file must stay inside the
 * thread's draft directory after symlinks are followed.
 */
export function createStagedDraftImageReader(attachmentsDirectory: string): StagedDraftImageReader {
  return async (threadId, stagingId) => {
    if (typeof threadId !== "string" || typeof stagingId !== "string"
      || !SAFE_ID.test(threadId) || !SAFE_ID.test(stagingId)) {
      throw new Error("Staged draft image ids must be hex identifiers");
    }
    const draftDirectory = NodePath.resolve(attachmentsDirectory, threadId, "draft");
    if (!isContainedPath(NodePath.resolve(attachmentsDirectory), draftDirectory)) return null;
    try {
      const fileName = (await NodeFSPromises.readdir(draftDirectory)).find(
        (name) => name.startsWith(`${stagingId}.`) && !name.endsWith(".json"),
      );
      if (!fileName) return null;
      const [realDirectory, realFile] = await Promise.all([
        NodeFSPromises.realpath(draftDirectory),
        NodeFSPromises.realpath(NodePath.join(draftDirectory, fileName)),
      ]);
      if (!isContainedPath(realDirectory, realFile) || !(await NodeFSPromises.stat(realFile)).isFile()) return null;
      return new Uint8Array(await NodeFSPromises.readFile(realFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}
