import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_MAX_CONTENT_CHARS, type NativePlanFileRef } from "@mcode/contracts";
import { captureNativePlanFile, syncNativePlanFile } from "../native-plan-file.js";

let directory: string;
let root: string;
let path: string;
const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ref = (): NativePlanFileRef => ({ path, sessionId: "session", sha256 });
const sync = (nativePlanFile: NativePlanFileRef | null = ref(), markdown = "# Edited\n") =>
  syncNativePlanFile({ nativePlanFile, roots: [root], markdown });

beforeEach(async () => {
  const scratch = NodePath.resolve(import.meta.dirname, "../../../../../.dev/native-plan-tests");
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
    expect(await captureNativePlanFile({ path, sessionId: "session", roots: [root] })).toEqual(ref());
    const original = await NodeFSPromises.stat(path);
    expect(await sync()).toEqual({ outcome: "synced" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("# Edited\n");
    expect((await NodeFSPromises.stat(path)).ino).not.toBe(original.ino);
    expect(await NodeFSPromises.readdir(root)).toEqual(["plan.md"]);
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
    expect(await captureNativePlanFile({ path, sessionId: "session", roots: [root] })).toBeUndefined();
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    if (kind !== "relative") expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("refuses a symlink substituted after capture even when its target is in the root", async () => {
    const target = NodePath.join(root, "target.md");
    await NodeFSPromises.rename(path, target);
    await NodeFSPromises.symlink(target, path, "file");
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await captureNativePlanFile({ path, sessionId: "session", roots: [root] })).toBeUndefined();
    expect(await NodeFSPromises.readFile(target, "utf8")).toBe("abc");
    expect((await NodeFSPromises.lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("refuses a parent directory link that escapes the declared root", async () => {
    const outside = NodePath.join(directory, "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.writeFile(NodePath.join(outside, "plan.md"), "abc");
    await NodeFSPromises.symlink(outside, NodePath.join(root, "linked"), "junction");
    path = NodePath.join(root, "linked", "plan.md");
    expect(await sync()).toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
  });

  it("bounds captured bytes and refuses oversized replacement content", async () => {
    await NodeFSPromises.writeFile(path, "x".repeat(PLAN_MAX_CONTENT_CHARS));
    expect(await captureNativePlanFile({ path, sessionId: "session", roots: [root] })).toMatchObject({ path, sessionId: "session" });
    await NodeFSPromises.appendFile(path, "x");
    expect(await captureNativePlanFile({ path, sessionId: "session", roots: [root] })).toBeUndefined();
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
});
