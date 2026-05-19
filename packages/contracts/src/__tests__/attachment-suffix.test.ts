import { describe, it, expect } from "vitest";
import { storedAttachmentSuffix } from "../models/attachment.js";

describe("storedAttachmentSuffix", () => {
  it("returns expected extensions for images and documents", () => {
    expect(storedAttachmentSuffix("image/jpeg")).toBe(".jpg");
    expect(storedAttachmentSuffix("image/png")).toBe(".png");
    expect(storedAttachmentSuffix("application/pdf")).toBe(".pdf");
    expect(storedAttachmentSuffix("text/plain")).toBe(".txt");
  });

  it("returns empty string for unknown MIME types", () => {
    expect(storedAttachmentSuffix("application/octet-stream")).toBe("");
  });
});
