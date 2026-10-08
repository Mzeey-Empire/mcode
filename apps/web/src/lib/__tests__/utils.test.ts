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
});
