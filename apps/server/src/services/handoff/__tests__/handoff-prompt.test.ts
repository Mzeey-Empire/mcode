import { describe, expect, it } from "vitest";
import { buildHandoffPrompt, pickHandoffMode, computeBudgetChars } from "../handoff-prompt.js";

describe("pickHandoffMode", () => {
  it("returns minimal when child cap < 8000", () => {
    expect(pickHandoffMode(4_000)).toBe("minimal");
    expect(pickHandoffMode(7_999)).toBe("minimal");
  });
  it("returns full at or above 8000", () => {
    expect(pickHandoffMode(8_000)).toBe("full");
    expect(pickHandoffMode(180_000)).toBe("full");
  });
});

describe("computeBudgetChars", () => {
  it("subtracts reserved overhead from cap", () => {
    expect(computeBudgetChars(180_000)).toBeGreaterThan(170_000);
  });
  it("floors at 1000 minimum", () => {
    expect(computeBudgetChars(1_500)).toBe(1_000);
  });
});

describe("buildHandoffPrompt", () => {
  const baseInput = {
    forkAnchorRole: "assistant" as const,
    parentThreadTitle: "Database migration design",
    forkMessageExcerpt: "We should use Postgres because...",
    childProviderId: "claude",
    childMaxInputCharacters: 180_000,
    handoffDocAbsolutePath: "/data/threads/t_child/handoffs/01HX/handoff.md",
  };

  it("full mode mentions all eight sections", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "full" });
    for (const s of ["Goal", "At fork", "Open items", "Decisions made", "Files in play", "Suggested next steps", "Suggested skills", "Attachments"]) {
      expect(p).toContain(s);
    }
  });

  it("minimal mode lists only Goal / At fork / Open items", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "minimal", childMaxInputCharacters: 4000 });
    expect(p).toContain("Goal");
    expect(p).toContain("At fork");
    expect(p).toContain("Open items");
    expect(p).not.toContain("Decisions made");
    expect(p).not.toContain("Suggested skills");
  });

  it("expresses budget in characters not tokens", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "minimal", childMaxInputCharacters: 4000 });
    expect(p.toLowerCase()).toContain("character");
    expect(p.toLowerCase()).not.toContain("token");
  });

  it("frames user-msg fork as retry, assistant-msg fork as continue", () => {
    const userFork = buildHandoffPrompt({ ...baseInput, mode: "full", forkAnchorRole: "user" });
    expect(userFork).toMatch(/retry|redo|same question/i);
    const asstFork = buildHandoffPrompt({ ...baseInput, mode: "full", forkAnchorRole: "assistant" });
    expect(asstFork).toMatch(/continue|new direction|follow.?up/i);
  });

  it("includes the absolute output path", () => {
    const p = buildHandoffPrompt({ ...baseInput, mode: "full" });
    expect(p).toContain("/data/threads/t_child/handoffs/01HX/handoff.md");
  });
});
