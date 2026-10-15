import * as NodeFSPromises from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_MAX_CONTENT_CHARS } from "@mcode/contracts";
import { captureOwnedPlanFile, deleteOwnedPlanFile } from "../owned-plan-file.js";

const helloHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("native plan files", () => {
  let directory: string;
  let planRoot: string;
  let path: string;

  beforeEach(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-plan-"));
    planRoot = NodePath.join(directory, "plans");
    await NodeFSPromises.mkdir(planRoot);
    path = NodePath.join(planRoot, "session.md");
    await NodeFSPromises.writeFile(path, "hello");
  });

  afterEach(async () => { await NodeFSPromises.rm(directory, { recursive: true, force: true }); });

  function capture(filePath = path) {
    return captureOwnedPlanFile({ path: filePath, planRoot, sessionId: "session" });
  }

  function remove(filePath = path, sessionId = "session") {
    return deleteOwnedPlanFile({ planRoot, sessionId: "session",
      nativePlanFile: { path: filePath, sessionId, sha256: helloHash } });
  }

  it("captures the markdown and SHA-256 of the bytes actually read", async () => {
    expect(await capture()).toEqual({ outcome: "captured", markdown: "hello",
      nativePlanFile: { path, sessionId: "session", sha256: helloHash } });
  });

  it.each([
    { name: "relative", path: () => "session.md" },
    { name: "outside", path: () => NodePath.join(directory, "outside.md") },
    { name: "prefix", path: () => NodePath.join(directory, "plans-other", "session.md") },
    { name: "traversal", path: () => `${planRoot}${NodePath.sep}..${NodePath.sep}outside.md` },
  ])("refuses $name paths", async (test) => {
    const candidate = test.path();
    expect(await capture(candidate)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await remove(candidate)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("hello");
  });

  it("refuses file symlinks and preserves their targets", async () => {
    const link = NodePath.join(planRoot, "link.md");
    await NodeFSPromises.symlink(path, link, "file");
    expect(await capture(link)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await remove(link)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(link, "utf8")).toBe("hello");
    expect((await NodeFSPromises.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("refuses a regular file reached through a directory link outside the root", async () => {
    const outside = NodePath.join(directory, "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.writeFile(NodePath.join(outside, "session.md"), "hello");
    const link = NodePath.join(planRoot, "linked");
    await NodeFSPromises.symlink(outside, link, "junction");
    const candidate = NodePath.join(link, "session.md");
    expect(await capture(candidate)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await remove(candidate)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(candidate, "utf8")).toBe("hello");
  });

  it("captures a plan reached through a linked project directory", async () => {
    const project = NodePath.join(directory, "project");
    await NodeFSPromises.mkdir(project);
    await NodeFSPromises.rename(planRoot, NodePath.join(project, "plans"));
    const link = NodePath.join(directory, "linked-project");
    await NodeFSPromises.symlink(project, link, "junction");
    planRoot = NodePath.join(link, "plans");
    path = NodePath.join(planRoot, "session.md");

    expect(await capture()).toEqual({
      outcome: "captured",
      markdown: "hello",
      nativePlanFile: { path, sessionId: "session", sha256: helloHash },
    });
    expect(await remove()).toEqual({ outcome: "deleted" });
  });

  it("refuses directories", async () => {
    const candidate = NodePath.join(planRoot, "folder.md");
    await NodeFSPromises.mkdir(candidate);
    expect(await capture(candidate)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await remove(candidate)).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect((await NodeFSPromises.stat(candidate)).isDirectory()).toBe(true);
  });

  it("accepts the byte limit and refuses larger files, including multibyte text", async () => {
    await NodeFSPromises.writeFile(path, "x".repeat(PLAN_MAX_CONTENT_CHARS));
    expect(await capture()).toMatchObject({ outcome: "captured", markdown: "x".repeat(PLAN_MAX_CONTENT_CHARS) });
    for (const text of ["x".repeat(PLAN_MAX_CONTENT_CHARS + 1), "é".repeat(PLAN_MAX_CONTENT_CHARS)]) {
      await NodeFSPromises.writeFile(path, text);
      expect(await capture()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
      expect(await remove()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
      expect(await NodeFSPromises.readFile(path, "utf8")).toBe(text);
    }
  });

  it("deletes only matching bytes and leaves the plan directory", async () => {
    expect(await remove()).toEqual({ outcome: "deleted" });
    await expect(NodeFSPromises.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await NodeFSPromises.stat(planRoot)).isDirectory()).toBe(true);
    expect(await remove()).toEqual({ outcome: "skipped", reason: "no-file" });
    expect(await capture()).toEqual({ outcome: "skipped", reason: "no-file" });
  });

  it("preserves changed bytes even when the length is unchanged", async () => {
    await NodeFSPromises.writeFile(path, "HELLO");
    expect(await remove()).toEqual({ outcome: "skipped", reason: "changed" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("HELLO");
  });

  it("refuses missing or mismatched session proof", async () => {
    expect(await remove(path, "other")).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await captureOwnedPlanFile({ path, planRoot, sessionId: "" })).toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("hello");
  });
});
