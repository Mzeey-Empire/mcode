import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { classifyLaunchBoot } from "../boot-history.js";

let directory: string;
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-boot-history-"));
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

it("classifies launches against the boot time the previous launch stored", async () => {
  const path = NodePath.join(directory, "user-data", "launch-boot.json");
  await expect(classifyLaunchBoot(path, 1_000_000)).resolves.toBeNull();
  await expect(classifyLaunchBoot(path, 1_005_000)).resolves.toBe(false);
  await expect(classifyLaunchBoot(path, 1_010_001)).resolves.toBe(true);
  expect(JSON.parse(NodeFS.readFileSync(path, "utf8"))).toBe(1_010_001);
});

it("treats a torn file as no previous launch and replaces it", async () => {
  const path = NodePath.join(directory, "launch-boot.json");
  NodeFS.writeFileSync(path, "17000");
  NodeFS.appendFileSync(path, "{");
  await expect(classifyLaunchBoot(path, 1_000_000)).resolves.toBeNull();
  await expect(classifyLaunchBoot(path, 1_000_000)).resolves.toBe(false);
});

it("surfaces a read failure other than a missing file", async () => {
  const path = NodePath.join(directory, "launch-boot.json");
  NodeFS.mkdirSync(path);
  await expect(classifyLaunchBoot(path, 1_000_000)).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
});
