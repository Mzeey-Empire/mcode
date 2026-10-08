import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button";

describe("buttonVariants", () => {
  it("maps the three text sizes to Paper's 32, 40 and 48 control heights", () => {
    expect(buttonVariants({ size: "compact" })).toContain("h-8");
    expect(buttonVariants({ size: "default" })).toContain("h-10");
    expect(buttonVariants({ size: "comfortable" })).toContain("h-12");
  });

  it("keeps the call-site default at compact for dense chrome", () => {
    expect(buttonVariants()).toBe(buttonVariants({ size: "compact" }));
  });

  it("maps icon-only and inline sizes to square boxes", () => {
    expect(buttonVariants({ size: "icon-compact" })).toContain("size-8");
    expect(buttonVariants({ size: "icon-default" })).toContain("size-10");
    expect(buttonVariants({ size: "icon-comfortable" })).toContain("size-12");
    expect(buttonVariants({ size: "icon-inline" })).toContain("size-7");
    expect(buttonVariants({ size: "icon-inline-sm" })).toContain("size-6");
  });

  it("fills the destructive variant instead of tinting it", () => {
    const destructive = buttonVariants({ variant: "destructive" });
    expect(destructive).toContain("bg-destructive");
    expect(destructive).toContain("text-destructive-ink");
    expect(destructive).not.toContain("bg-destructive/10");
  });

  it("presses with an inset ring and focuses with an offset ring, never a translation", () => {
    const primary = buttonVariants();
    expect(primary).toContain("active:inset-ring-2");
    expect(primary).toContain("focus-visible:outline-offset-2");
    expect(primary).not.toContain("translate-y-px");
  });
});
