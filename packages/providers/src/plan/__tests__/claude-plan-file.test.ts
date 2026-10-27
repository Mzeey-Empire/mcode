import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_MAX_CONTENT_CHARS } from "@mcode/contracts/models/plan";
import { type NativePlanFileRef } from "@mcode/contracts/providers/interfaces";
import { captureClaudePlanFileRef, isWritableClaudePlanPath, syncClaudePlanFile } from "../claude-plan-file.js";

let directory: string;
let root: string;
let path: string;
const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ref = (): NativePlanFileRef => ({ path, sessionId: "session", root, sha256 });
const sync = (nativePlanFile: NativePlanFileRef | null = ref(), markdown = "# Edited\n") =>
  syncClaudePlanFile({ nativePlanFile, markdown });

beforeEach(async () => {
  const scratch = NodePath.resolve(import.meta.dirname, "../../../../../.dev/claude-plan-tests");
  await NodeFSPromises.mkdir(scratch, { recursive: true });
  directory = await NodeFSPromises.mkdtemp(NodePath.join(scratch, "case-"));
  root = NodePath.join(directory, "plans");
  await NodeFSPromises.mkdir(root);
  path = NodePath.join(root, "plan.md");
  await NodeFSPromises.writeFile(path, "abc");
});
afterEach(async () => { await NodeFSPromises.rm(directory, { recursive: true, force: true }); });

describe("native plan file validation and reconciliation", () => {
  it("captures the SHA-256 of the exact bytes and atomically replaces the file", async () => {
    expect(await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] })).toEqual(ref());
    const original = await NodeFSPromises.stat(path);
    expect(await sync()).toEqual({ outcome: "synced" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("# Edited\n");
    expect((await NodeFSPromises.stat(path)).ino).not.toBe(original.ino);
    expect(await NodeFSPromises.readdir(root)).toEqual(["plan.md"]);
  });

  it("captures and syncs a plan through a linked root parent", async () => {
    const realRoot = root;
    const realPath = path;
    const linkedParent = NodePath.join(directory, "linked-parent");
    await NodeFSPromises.symlink(directory, linkedParent, "junction");
    root = NodePath.join(linkedParent, "plans");
    path = NodePath.join(root, "plan.md");

    const captured = await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] });
    expect(captured).toEqual(ref());
    expect(await sync(captured)).toEqual({ outcome: "synced" });
    expect(await NodeFSPromises.readFile(realPath, "utf8")).toBe("# Edited\n");
    expect(await NodeFSPromises.readdir(realRoot)).toEqual(["plan.md"]);
  });

  it("leaves a file edited after capture untouched", async () => {
    await NodeFSPromises.writeFile(path, "someone else's edit");
    expect(await sync()).toEqual({ outcome: "skipped", reason: "changed" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("someone else's edit");
    expect(await NodeFSPromises.readdir(root)).toEqual(["plan.md"]);
  });

  it("does nothing without a proved reference", async () => {
    expect(await sync(null)).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it.each(["relative", "outside", "sibling-prefix"])("refuses a %s path", async kind => {
    if (kind === "relative") path = "plans/plan.md";
    else {
      const parent = kind === "outside" ? directory : `${root}-other`;
      await NodeFSPromises.mkdir(parent, { recursive: true });
      path = NodePath.join(parent, "unowned.md");
      await NodeFSPromises.writeFile(path, "abc");
    }
    expect(await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] })).toBeUndefined();
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    if (kind !== "relative") expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("refuses a symlink substituted after capture even when its target is in the root", async () => {
    const target = NodePath.join(root, "target.md");
    await NodeFSPromises.rename(path, target);
    await NodeFSPromises.symlink(target, path, "file");
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] })).toBeUndefined();
    expect(await NodeFSPromises.readFile(target, "utf8")).toBe("abc");
    expect((await NodeFSPromises.lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("refuses a parent directory link that escapes the declared root", async () => {
    const outside = NodePath.join(directory, "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.writeFile(NodePath.join(outside, "plan.md"), "abc");
    await NodeFSPromises.symlink(outside, NodePath.join(root, "linked"), "junction");
    path = NodePath.join(root, "linked", "plan.md");
    expect(await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] })).toBeUndefined();
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("bounds captured bytes and refuses oversized replacement content", async () => {
    await NodeFSPromises.writeFile(path, "x".repeat(PLAN_MAX_CONTENT_CHARS));
    expect(await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] })).toMatchObject({ path, sessionId: "session" });
    await NodeFSPromises.appendFile(path, "x");
    expect(await captureClaudePlanFileRef({ path, sessionId: "session", roots: [root] })).toBeUndefined();
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    await NodeFSPromises.writeFile(path, "abc");
    expect(await sync(ref(), "é".repeat(PLAN_MAX_CONTENT_CHARS))).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("reports missing files and refuses directories without throwing", async () => {
    await NodeFSPromises.unlink(path);
    expect(await sync()).toEqual({ outcome: "skipped", reason: "no-file" });
    await NodeFSPromises.mkdir(path);
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
  });

  it("syncs from the root recorded in the ref without any session state", async () => {
    const stored = JSON.parse(JSON.stringify(ref())) as NativePlanFileRef;
    expect(await syncClaudePlanFile({ nativePlanFile: stored, markdown: "# After restart\n" })).toEqual({ outcome: "synced" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("# After restart\n");
  });

  it("treats a ref without a recorded root as unproven", async () => {
    const { root: _omitted, ...withoutRoot } = ref();
    expect(await sync(withoutRoot)).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("refuses a ref whose recorded root is not a plans directory", async () => {
    const forged = { ...ref(), root: directory };
    expect(await sync(forged)).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });
});

describe("plan-turn write permission", () => {
  const writable = (candidate: string) => isWritableClaudePlanPath(candidate, [root], NodePath.join(directory, "unrelated-project"));

  it("allows a new or existing markdown file inside the root", async () => {
    expect(await writable(path)).toBe(true);
    expect(await writable(NodePath.join(root, "fresh-plan.md"))).toBe(true);
  });

  it("refuses non-markdown files, the root itself and paths outside it", async () => {
    expect(await writable(NodePath.join(root, "script.sh"))).toBe(false);
    expect(await writable(root)).toBe(false);
    expect(await writable(NodePath.join(directory, "elsewhere.md"))).toBe(false);
  });

  it("refuses a directory link that carries a new file out of the root", async () => {
    const outside = NodePath.join(directory, "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.symlink(outside, NodePath.join(root, "linked"), "junction");
    expect(await writable(NodePath.join(root, "linked", "new.md"))).toBe(false);
  });

  it("refuses a project plan root that links out of the project but allows a linked config-home root", async () => {
    const project = NodePath.join(directory, "project");
    const outside = NodePath.join(directory, "outside-root");
    await NodeFSPromises.mkdir(NodePath.join(project, ".claude"), { recursive: true });
    await NodeFSPromises.mkdir(outside);
    const projectRoot = NodePath.join(project, ".claude", "plans");
    await NodeFSPromises.symlink(outside, projectRoot, "junction");
    expect(await isWritableClaudePlanPath(NodePath.join(projectRoot, "new.md"), [projectRoot], project)).toBe(false);
    expect(await isWritableClaudePlanPath(NodePath.join(projectRoot, "new.md"), [projectRoot], NodePath.join(directory, "other"))).toBe(true);
  });

  it("refuses a project .claude directory that links to the repository root", async () => {
    const project = NodePath.join(directory, "project");
    const elsewhere = NodePath.join(directory, "elsewhere");
    await NodeFSPromises.mkdir(NodePath.join(elsewhere, "plans"), { recursive: true });
    await NodeFSPromises.mkdir(project);
    await NodeFSPromises.symlink(elsewhere, NodePath.join(project, ".claude"), "junction");
    const projectRoot = NodePath.join(project, ".claude", "plans");
    expect(await isWritableClaudePlanPath(NodePath.join(projectRoot, "new.md"), [projectRoot], project)).toBe(false);
  });

  it("refuses a dangling file symlink that would create its target outside the root", async () => {
    const link = NodePath.join(root, "dangling.md");
    await NodeFSPromises.symlink(NodePath.join(directory, "created-outside.md"), link, "file");
    expect(await writable(link)).toBe(false);
  });
});
