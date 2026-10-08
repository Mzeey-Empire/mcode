import { describe, expect, it } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
  it("keeps the text colour beside a Paper type role", () => {
    expect(cn("text-muted", "text-caption")).toBe("text-muted text-caption");
  });

  it("lets a later type role replace an earlier font size", () => {
    expect(cn("text-sm text-ink", "text-body-small")).toBe("text-ink text-body-small");
  });

  it("lets type-link replace an earlier font size and keep the link colour", () => {
    expect(cn("text-sm text-link", "type-link")).toBe("text-link type-link");
  });

  it("treats font-code as a font family", () => {
    expect(cn("font-mono", "font-code")).toBe("font-code");
  });

  it("keeps the text fade beside a font size and a text colour", () => {
    expect(cn("text-fade", "text-xs", "text-muted")).toBe("text-fade text-xs text-muted");
    expect(cn("text-fade-lines-2 text-sm", "text-ink")).toBe("text-fade-lines-2 text-sm text-ink");
  });

  it("lets a later line clamp replace an earlier one", () => {
    expect(cn("text-fade-lines-2", "text-fade-lines-3")).toBe("text-fade-lines-3");
  });

  it("lets a later radius replace an earlier radius role", () => {
    expect(cn("rounded-menu", "rounded-lg")).toBe("rounded-lg");
    expect(cn("rounded-md", "rounded-dialog")).toBe("rounded-dialog");
  });
});
