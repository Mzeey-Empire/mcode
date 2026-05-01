import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mergeCursorWorkspaceAgentMarkdown,
  formatCursorSkillsAndCommandsForPrompt,
} from "../cursor-agent-guidance.js";

describe("mergeCursorWorkspaceAgentMarkdown", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "cursor-guide-proj-"));
  });

  it("merges repo root AGENTS.md and .cursor/AGENTS.md in order", () => {
    writeFileSync(join(project, "AGENTS.md"), "REPO");
    mkdirSync(join(project, ".cursor"), { recursive: true });
    writeFileSync(join(project, ".cursor", "AGENTS.md"), "PROJ");
    const out = mergeCursorWorkspaceAgentMarkdown(project);
    expect(out).toBe("REPO\n\n---\n\nPROJ");
  });

  it("returns undefined when no workspace instruction files exist", () => {
    expect(mergeCursorWorkspaceAgentMarkdown(project)).toBeUndefined();
  });
});

describe("formatCursorSkillsAndCommandsForPrompt", () => {
  it("returns undefined for empty list", () => {
    expect(formatCursorSkillsAndCommandsForPrompt([])).toBeUndefined();
  });

  it("lists skills and commands", () => {
    const text = formatCursorSkillsAndCommandsForPrompt([
      {
        name: "deploy",
        description: "Ship it",
        kind: "skill",
        source: "user",
        providers: ["cursor"],
      },
      {
        name: "lint",
        description: "Run lint",
        kind: "command",
        source: "project",
        providers: ["cursor"],
      },
    ]);
    expect(text).toContain("[skill] deploy");
    expect(text).toContain("[command] lint");
  });
});
