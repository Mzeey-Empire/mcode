import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { captureNativePlanFile, rewriteNativePlanFile } from "../native-plan-file.js";

describe("native plan file ownership", () => {
  let directory: string;
  let planRoot: string;
  let path: string;
  beforeEach(async () => {
    directory = await NodeFSPromises.realpath(await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-plan-")));
    planRoot = NodePath.join(directory, "session");
    await NodeFSPromises.mkdir(planRoot);
    path = NodePath.join(planRoot, "plan.md");
    await NodeFSPromises.writeFile(path, "abc");
  });
  afterEach(async () => { await NodeFSPromises.rm(directory, { recursive: true, force: true }); });

  async function capture() {
    const ref = await captureNativePlanFile({ path, planRoot, sessionId: "session" });
    if (!ref) throw new Error("Expected a captured file");
    return ref;
  }

  it("hashes the exact bytes and atomically rewrites an unchanged captured file", async () => {
    const nativePlanFile = await capture();
    expect(nativePlanFile).toEqual({ path, sessionId: "session", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    const originalFile = NodePath.join(directory, "original.md");
    await NodeFSPromises.link(path, originalFile);
    await NodeFSPromises.writeFile(NodePath.join(planRoot, "other-plan.md"), "keep");
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile, markdown: "# Edited plan\n" })).toEqual({ outcome: "synced" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("# Edited plan\n");
    expect(await NodeFSPromises.readFile(originalFile, "utf8")).toBe("abc");
    expect(await NodeFSPromises.readFile(NodePath.join(planRoot, "other-plan.md"), "utf8")).toBe("keep");
    expect((await NodeFSPromises.readdir(planRoot)).sort()).toEqual(["other-plan.md", "plan.md"]);
  });

  it("does not overwrite changed bytes or touch neighboring files", async () => {
    const nativePlanFile = await capture();
    await NodeFSPromises.writeFile(path, "provider revision");
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile, markdown: "user revision" })).toEqual({ outcome: "skipped", reason: "changed" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("provider revision");
    expect(await NodeFSPromises.readdir(planRoot)).toEqual(["plan.md"]);
  });

  it("refuses a different session and a missing reference", async () => {
    const nativePlanFile = await capture();
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "other", nativePlanFile, markdown: "edit" })).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile: null, markdown: "edit" })).toEqual({ outcome: "skipped", reason: "no-file" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("does not recreate a file removed after capture", async () => {
    const nativePlanFile = await capture();
    await NodeFSPromises.unlink(path);
    expect(await captureNativePlanFile({ path, planRoot, sessionId: "session" })).toBeNull();
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile, markdown: "edit" })).toEqual({ outcome: "skipped", reason: "no-file" });
    expect(await NodeFSPromises.readdir(planRoot)).toEqual([]);
  });

  it.each(["relative", "sibling", "directory"])("refuses a %s path at capture and rewrite", async (kind) => {
    const nativePlanFile = await capture();
    const unsafePath = kind === "relative" ? "plan.md" : kind === "directory" ? NodePath.join(planRoot, "directory") : NodePath.join(directory, "session-other", "plan.md");
    if (kind === "directory") await NodeFSPromises.mkdir(unsafePath);
    if (kind === "sibling") {
      await NodeFSPromises.mkdir(NodePath.join(directory, "session-other"));
      await NodeFSPromises.writeFile(unsafePath, "abc");
    }
    expect(await captureNativePlanFile({ path: unsafePath, planRoot, sessionId: "session" })).toBeNull();
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile: { ...nativePlanFile, path: unsafePath }, markdown: "edit" })).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
    if (kind === "sibling") expect(await NodeFSPromises.readFile(unsafePath, "utf8")).toBe("abc");
  });

  it.each(["file", "ancestor", "root"])("refuses a symlinked %s and preserves its target", async (kind) => {
    const nativePlanFile = await capture();
    const outside = NodePath.join(directory, "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.writeFile(NodePath.join(outside, "plan.md"), "abc");
    let linkedPath = path;
    if (kind === "file") {
      await NodeFSPromises.unlink(path);
      await NodeFSPromises.symlink(NodePath.join(outside, "plan.md"), path, "file");
    } else if (kind === "ancestor") {
      await NodeFSPromises.symlink(outside, NodePath.join(planRoot, "link"), "junction");
      linkedPath = NodePath.join(planRoot, "link", "plan.md");
    } else {
      await NodeFSPromises.rm(planRoot, { recursive: true });
      await NodeFSPromises.symlink(outside, planRoot, "junction");
    }
    expect(await captureNativePlanFile({ path: linkedPath, planRoot, sessionId: "session" })).toBeNull();
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile: { ...nativePlanFile, path: linkedPath }, markdown: "edit" })).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(NodePath.join(outside, "plan.md"), "utf8")).toBe("abc");
  });

  it("bounds capture and replacement bytes, including the exact limit", async () => {
    await NodeFSPromises.writeFile(path, "x".repeat(65_536));
    const nativePlanFile = await capture();
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile, markdown: "y".repeat(65_537) })).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("x".repeat(65_536));
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile, markdown: "y".repeat(65_536) })).toEqual({ outcome: "synced" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("y".repeat(65_536));
    await NodeFSPromises.writeFile(path, "x".repeat(65_537));
    expect(await captureNativePlanFile({ path, planRoot, sessionId: "session" })).toBeNull();
    expect(await rewriteNativePlanFile({ planRoot, sessionId: "session", nativePlanFile, markdown: "edit" })).toEqual({ outcome: "skipped", reason: "unproven" });
  });
});
