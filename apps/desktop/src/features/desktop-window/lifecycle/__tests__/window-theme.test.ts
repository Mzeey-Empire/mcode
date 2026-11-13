import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWindowThemeHint, writeWindowThemeHint } from "../window-theme.js";

describe("window theme hint", () => {
  let hintPath: string;

  beforeEach(() => {
    hintPath = NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-window-theme-")), "window-theme.json");
  });
  afterEach(() => {
    NodeFS.rmSync(NodePath.dirname(hintPath), { recursive: true, force: true });
  });

  it("completes overlapping writes and leaves a readable hint", async () => {
    await expect(Promise.all([
      writeWindowThemeHint(hintPath, false),
      writeWindowThemeHint(hintPath, true),
      writeWindowThemeHint(hintPath, false),
    ])).resolves.toBeDefined();
    expect(typeof JSON.parse(NodeFS.readFileSync(hintPath, "utf8")).dark).toBe("boolean");
    expect(NodeFS.readdirSync(NodePath.dirname(hintPath))).toEqual(["window-theme.json"]);
  });

  it("reads back the last completed write", async () => {
    await writeWindowThemeHint(hintPath, false);
    expect(readWindowThemeHint(hintPath)).toBe(false);
  });
});
