import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AttachmentService } from "../services/attachment-service.js";
import {
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  type AttachmentMeta,
} from "@mcode/contracts";

describe("AttachmentService.persist virtual browser context", () => {
  it("records stored metadata without copying a file", async () => {
    const svc = new AttachmentService();
    const att: AttachmentMeta = {
      id: "ctx-virtual-001",
      name: "Page context",
      mimeType: MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
      sizeBytes: 0,
      sourcePath: "",
    };
    const { stored, persisted } = await svc.persist("thread-unit-test-virtual", [att]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.mimeType).toBe(MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME);
    expect(stored[0]?.sizeBytes).toBe(0);
    expect(persisted).toHaveLength(0);
  });
});
