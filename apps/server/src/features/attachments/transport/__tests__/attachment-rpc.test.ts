import * as NodeFSPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeAttachmentRpc } from "../attachment-rpc.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => NodeFSPromises.rm(path, { force: true })));
});

describe("routeAttachmentRpc", () => {
  it("persists the JSON-RPC clipboard data as a temporary attachment", async () => {
    const result = await routeAttachmentRpc("clipboard.saveFile", {
      data: Buffer.from("clipboard text").toString("base64"),
      fileName: "clipboard.txt",
      mimeType: "text/plain",
    });
    const attachment = result as {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    };
    createdPaths.push(attachment.sourcePath);

    expect(attachment).toMatchObject({
      id: expect.any(String),
      name: "clipboard.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
    });
    expect(attachment.sourcePath).toMatch(/mcode-attachments.*\.txt$/);
    await expect(NodeFSPromises.readFile(attachment.sourcePath, "utf8")).resolves.toBe("clipboard text");
  });

  it("requires data when a client uses the legacy JSON-RPC path", async () => {
    await expect(routeAttachmentRpc("clipboard.saveFile", {
      fileName: "clipboard.txt",
      mimeType: "text/plain",
    })).rejects.toThrow(
      "clipboard.saveFile via JSON-RPC requires the data field; use binary upload instead",
    );
  });

  describe("attachments.stageDraft owner", () => {
    const attachment = { id: "a", name: "page.png", mimeType: "image/png", sizeBytes: 1, sourcePath: "x" };
    const staged = { stagingId: "s", name: "page.png", mimeType: "image/png", sizeBytes: 1 };

    function stageWith(owners: { thread?: { deleted_at: string | null }; workspace?: object }) {
      const stageDraft = vi.fn().mockResolvedValue(staged);
      const deps = {
        attachmentService: { stageDraft },
        threadRepo: { findById: () => owners.thread ?? null },
        workspaceRepo: { findById: () => owners.workspace ?? null },
      } as unknown as Parameters<typeof routeAttachmentRpc>[2];
      return { stageDraft, run: () => routeAttachmentRpc("attachments.stageDraft", { threadId: "owner-1", attachment }, deps) };
    }

    it("stages for a thread", async () => {
      const { run, stageDraft } = stageWith({ thread: { deleted_at: null } });
      await expect(run()).resolves.toEqual(staged);
      expect(stageDraft).toHaveBeenCalledWith("owner-1", attachment);
    });

    it("stages under a workspace id before the new thread exists", async () => {
      const { run, stageDraft } = stageWith({ workspace: {} });
      await expect(run()).resolves.toEqual(staged);
      expect(stageDraft).toHaveBeenCalledOnce();
    });

    it("refuses a deleted thread without falling back to a workspace", async () => {
      const { run, stageDraft } = stageWith({ thread: { deleted_at: "2026-01-01" }, workspace: {} });
      await expect(run()).rejects.toThrow("Draft image owner does not exist");
      expect(stageDraft).not.toHaveBeenCalled();
    });

    it("refuses an id that is neither a thread nor a workspace", async () => {
      const { run } = stageWith({});
      await expect(run()).rejects.toThrow("Draft image owner does not exist");
    });
  });
});
