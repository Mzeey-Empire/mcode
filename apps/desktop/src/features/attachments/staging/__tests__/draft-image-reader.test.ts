import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStagedDraftImageReader } from "../draft-image-reader.js";

const THREAD_ID = "01234567-89ab-cdef-0123-456789abcdef";
const STAGING_ID = "abcdef01-2345-6789-abcd-ef0123456789";
const temporaryDirectories: string[] = [];

async function stagedRoot(): Promise<{ root: string; draftDirectory: string }> {
  const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-draft-reader-"));
  temporaryDirectories.push(root);
  const draftDirectory = NodePath.join(root, THREAD_ID, "draft");
  await NodeFSPromises.mkdir(draftDirectory, { recursive: true });
  return { root, draftDirectory };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => NodeFSPromises.rm(directory, { recursive: true, force: true })));
});

describe("staged draft image reader", () => {
  it("returns the image bytes, not the metadata sidecar", async () => {
    const { root, draftDirectory } = await stagedRoot();
    await NodeFSPromises.writeFile(NodePath.join(draftDirectory, `${STAGING_ID}.png`), Buffer.from([137, 80, 78, 71]));
    await NodeFSPromises.writeFile(NodePath.join(draftDirectory, `${STAGING_ID}.json`), "{}");

    const bytes = await createStagedDraftImageReader(root)(THREAD_ID, STAGING_ID);

    expect(Array.from(bytes ?? [])).toEqual([137, 80, 78, 71]);
  });

  it("returns null once the image is gone", async () => {
    const { root } = await stagedRoot();

    expect(await createStagedDraftImageReader(root)(THREAD_ID, STAGING_ID)).toBeNull();
    expect(await createStagedDraftImageReader(root)("11111111-1111-1111-1111-111111111111", STAGING_ID)).toBeNull();
  });

  it.each([
    ["a traversal thread id", "../outside", STAGING_ID],
    ["a traversal staging id", THREAD_ID, "..\..\secret"],
    ["a non-string id", 42, STAGING_ID],
  ])("rejects %s", async (_label, threadId, stagingId) => {
    const { root } = await stagedRoot();

    await expect(createStagedDraftImageReader(root)(threadId, stagingId)).rejects.toThrow("hex identifiers");
  });

  it("does not follow a staged file that links outside the draft directory", async () => {
    const { root, draftDirectory } = await stagedRoot();
    const secret = NodePath.join(root, "secret.png");
    await NodeFSPromises.writeFile(secret, "secret");
    try {
      await NodeFSPromises.symlink(secret, NodePath.join(draftDirectory, `${STAGING_ID}.png`));
    } catch {
      return;
    }

    expect(await createStagedDraftImageReader(root)(THREAD_ID, STAGING_ID)).toBeNull();
  });
});
