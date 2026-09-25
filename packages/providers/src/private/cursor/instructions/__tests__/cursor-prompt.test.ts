import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  buildCursorPrompt,
  readCursorUserInstructions,
  rewriteCursorCommandMentionsAsLinks,
} from "../cursor-prompt.js";

describe("cursor-prompt", () => {
  describe("readCursorUserInstructions", () => {
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;
    let fakeHome: string;

    beforeEach(() => {
      fakeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cursor-prompt-"));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
    });

    afterEach(() => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      NodeFS.rmSync(fakeHome, { recursive: true, force: true });
    });

    it("returns undefined when ~/.cursor/AGENTS.md is absent", () => {
      expect(readCursorUserInstructions()).toBeUndefined();
    });

    it("returns trimmed contents when ~/.cursor/AGENTS.md exists", () => {
      const agentsPath = NodePath.join(fakeHome, ".cursor", "AGENTS.md");
      NodeFS.mkdirSync(NodePath.join(fakeHome, ".cursor"), { recursive: true });
      NodeFS.writeFileSync(agentsPath, "  Stay concise.\n\n", "utf-8");

      expect(readCursorUserInstructions()).toBe("Stay concise.");
    });

    it("returns undefined when file is whitespace-only", () => {
      const agentsPath = NodePath.join(fakeHome, ".cursor", "AGENTS.md");
      NodeFS.mkdirSync(NodePath.join(fakeHome, ".cursor"), { recursive: true });
      NodeFS.writeFileSync(agentsPath, "   \n\t\n", "utf-8");

      expect(readCursorUserInstructions()).toBeUndefined();
    });
  });

  describe("buildCursorPrompt", () => {
    it("concatenates attachments and message without instructions block when omitted", () => {
      const prompt = buildCursorPrompt("hello", [
        {
          id: "a1",
          name: "x.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          sourcePath: "/tmp/x.txt",
        },
      ]);
      expect(prompt).toBe("[Attached file: x.txt (text/plain)]\n\nhello");
      expect(prompt).not.toContain("<user-instructions>");
    });

    it("prepends user-instructions wrapper when instructions are provided", () => {
      const prompt = buildCursorPrompt("do work", undefined, "Always cite paths.");
      expect(prompt.startsWith("<user-instructions>\nAlways cite paths.\n</user-instructions>")).toBe(
        true,
      );
      expect(prompt.endsWith("\n\ndo work")).toBe(true);
    });
  });

  describe("rewriteCursorCommandMentionsAsLinks", () => {
    const commandMention = (overrides: Record<string, unknown>) => ({
      id: "command:skill:deploy",
      kind: "command" as const,
      label: "deploy",
      namespace: "skill" as const,
      range: { start: 0, end: 7 },
      ...overrides,
    });

    it("links a command mention to its backing file", () => {
      expect(
        rewriteCursorCommandMentionsAsLinks("/deploy now", [
          commandMention({ path: "/x/SKILL.md" }),
        ]),
      ).toBe("[/deploy](/x/SKILL.md) now");
    });

    it("rewrites multiple command mentions without shifting earlier ranges", () => {
      const message = "/build /deploy now";
      expect(
        rewriteCursorCommandMentionsAsLinks(message, [
          commandMention({ label: "build", path: "/x/build/SKILL.md", range: { start: 0, end: 6 } }),
          commandMention({ path: "/x/deploy/SKILL.md", range: { start: 7, end: 14 } }),
        ]),
      ).toBe("[/build](/x/build/SKILL.md) [/deploy](/x/deploy/SKILL.md) now");
    });

    it("leaves command mentions without a path verbatim", () => {
      expect(
        rewriteCursorCommandMentionsAsLinks("/deploy now", [commandMention({})]),
      ).toBe("/deploy now");
    });

    it("leaves a stale range verbatim when the text no longer matches", () => {
      expect(
        rewriteCursorCommandMentionsAsLinks("/deploy now", [
          commandMention({ path: "/x/SKILL.md", range: { start: 1, end: 8 } }),
        ]),
      ).toBe("/deploy now");
    });
  });
});
