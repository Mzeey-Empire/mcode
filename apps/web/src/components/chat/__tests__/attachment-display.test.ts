import { describe, it, expect } from "vitest";
import { attachmentIconKindFromMime } from "../attachment-display";

describe("attachmentIconKindFromMime", () => {
  it("normalizes case and strips MIME parameters for PDF", () => {
    expect(attachmentIconKindFromMime("Application/PDF")).toBe("pdf");
    expect(attachmentIconKindFromMime("application/pdf; charset=binary")).toBe("pdf");
  });

  it("classifies Office types after normalization", () => {
    expect(
      attachmentIconKindFromMime(
        "Application/vnd.openxmlformats-officedocument.wordprocessingml.document; name=a.docx",
      ),
    ).toBe("office");
  });
});
