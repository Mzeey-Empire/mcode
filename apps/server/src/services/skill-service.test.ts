import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillService } from "./skill-service.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "skill-svc-"));
}

function writeMd(path: string, frontmatter: Record<string, string>, body = "") {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(path, `---\n${fm}\n---\n${body}`);
}

describe("SkillService", () => {
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = tmp();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // Windows
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("scans commands/*.md as command-kind entries", () => {
    const cmdDir = join(fakeHome, ".claude", "plugins", "cache", "mp", "superpowers", "5.0.7", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeMd(join(cmdDir, "brainstorm.md"), { description: "Brainstorm an idea" });

    const svc = new SkillService();
    const items = svc.list();

    const brainstorm = items.find((i) => i.name === "superpowers:brainstorm");
    expect(brainstorm).toBeDefined();
    expect(brainstorm!.kind).toBe("command");
    expect(brainstorm!.description).toBe("Brainstorm an idea");
    expect(brainstorm!.source).toBe("plugin");
  });

  it("scans plugin skills nested under <version>/.claude/skills", () => {
    const skillDir = join(fakeHome, ".claude", "plugins", "cache", "mp", "impeccable", "2.1.1", ".claude", "skills", "audit");
    mkdirSync(skillDir, { recursive: true });
    writeMd(join(skillDir, "SKILL.md"), { description: "Run audit checks" });

    const items = new SkillService().list();
    expect(items.find((i) => i.name === "impeccable:audit")).toMatchObject({
      kind: "skill",
      description: "Run audit checks",
    });
  });

  it("scans project-level <cwd>/.claude/commands/*.md", () => {
    const cwd = tmp();
    const cmdDir = join(cwd, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeMd(join(cmdDir, "deploy.md"), { description: "Deploy to staging" });

    const items = new SkillService().list(cwd);
    const deploy = items.find((i) => i.name === "deploy");
    expect(deploy).toMatchObject({
      kind: "command",
      source: "project",
      description: "Deploy to staging",
    });

    rmSync(cwd, { recursive: true, force: true });
  });

  it("dedupes by name with priority user > project > agent > plugin", () => {
    const userDir = join(fakeHome, ".claude", "skills", "shared");
    const pluginDir = join(fakeHome, ".claude", "plugins", "cache", "mp", "p", "1.0.0", "skills", "shared");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeMd(join(userDir, "SKILL.md"), { description: "User wins" });
    writeMd(join(pluginDir, "SKILL.md"), { description: "Plugin loses" });

    const items = new SkillService().list();
    const shared = items.find((i) => i.name === "shared");
    expect(shared!.description).toBe("User wins");
    expect(shared!.source).toBe("user");
  });

  it("skips skill subdirs that lack SKILL.md", () => {
    // Two siblings under the user skills root: one is a real skill, the
    // other is a helper folder (e.g., shared utilities, scaffolding scripts).
    // Without the SKILL.md guard, the helper would surface as an empty
    // command in the popup.
    const realDir = join(fakeHome, ".claude", "skills", "real-skill");
    const helperDir = join(fakeHome, ".claude", "skills", "_helpers");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(helperDir, { recursive: true });
    writeMd(join(realDir, "SKILL.md"), { description: "A real skill" });
    // helperDir intentionally has no SKILL.md.

    const items = new SkillService().list();
    expect(items.find((i) => i.name === "real-skill")).toBeDefined();
    expect(items.find((i) => i.name === "_helpers")).toBeUndefined();
  });

  it("returns empty diagnostics with no error when paths are missing", () => {
    const diag = new SkillService().diagnose();
    expect(diag.errors).toEqual([]);
    expect(diag.scanned.every((s) => s.existed === false || s.entries >= 0)).toBe(true);
  });

  it("invokes subscribers on invalidate() and stops after unsubscribe", () => {
    const svc = new SkillService();
    let calls = 0;
    const unsub = svc.subscribe(() => {
      calls++;
    });

    svc.invalidate();
    expect(calls).toBe(1);

    svc.invalidate();
    expect(calls).toBe(2);

    unsub();
    svc.invalidate();
    expect(calls).toBe(2); // unchanged after unsubscribe
  });

  it("isolates subscriber errors so later subscribers still fire", () => {
    const svc = new SkillService();
    let secondFired = false;
    svc.subscribe(() => {
      throw new Error("first subscriber boom");
    });
    svc.subscribe(() => {
      secondFired = true;
    });

    expect(() => svc.invalidate()).not.toThrow();
    expect(secondFired).toBe(true);
  });
});
