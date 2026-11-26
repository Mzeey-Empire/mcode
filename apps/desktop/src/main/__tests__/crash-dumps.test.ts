import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crashDumpOptions, crashDumpsTotalBytes, deleteCrashDumps } from "../crash-dumps";

describe("crashDumpOptions", () => {
  it("keeps local dumps with uploads off in development builds even when the setting is off", () => {
    expect(crashDumpOptions(false, false)).toEqual({ uploadToServer: false });
  });

  it("keeps local dumps in packaged builds only with an explicit opt-in", () => {
    expect(crashDumpOptions(true, false)).toBeNull();
    expect(crashDumpOptions(true, null)).toBeNull();
    expect(crashDumpOptions(true, true)).toEqual({ uploadToServer: false });
  });
});

describe("local dump files", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-crash-dumps-"));
  });

  afterEach(async () => {
    await NodeFSPromises.rm(directory, { recursive: true, force: true });
  });

  it("counts and deletes only minidumps in nested folders", async () => {
    const pending = NodePath.join(directory, "pending");
    const completed = NodePath.join(directory, "completed");
    await NodeFSPromises.mkdir(pending);
    await NodeFSPromises.mkdir(completed);
    await NodeFSPromises.writeFile(NodePath.join(pending, "first.dmp"), "abc");
    await NodeFSPromises.writeFile(NodePath.join(completed, "second.dmp"), "defgh");
    await NodeFSPromises.writeFile(NodePath.join(completed, "metadata"), "keep");
    await NodeFSPromises.writeFile(NodePath.join(directory, "settings.dat"), "settings");

    expect(await crashDumpsTotalBytes(directory)).toBe(8);
    await deleteCrashDumps(directory);
    expect(await NodeFSPromises.readdir(pending)).toEqual([]);
    expect(await NodeFSPromises.readdir(completed)).toEqual(["metadata"]);
    expect(await NodeFSPromises.readFile(NodePath.join(directory, "settings.dat"), "utf8")).toBe("settings");
  });

  it("reports zero bytes and does nothing when the dump directory is missing", async () => {
    const missing = NodePath.join(directory, "missing");
    expect(await crashDumpsTotalBytes(missing)).toBe(0);
    await deleteCrashDumps(missing);
    expect(await NodeFSPromises.readdir(directory)).toEqual([]);
  });
});
