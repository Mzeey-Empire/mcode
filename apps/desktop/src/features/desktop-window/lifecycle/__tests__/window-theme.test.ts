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

  it("completes overlapping writes and keeps the last one", async () => {
    await Promise.all([
      writeWindowThemeHint(hintPath, "light"),
      writeWindowThemeHint(hintPath, "dark"),
      writeWindowThemeHint(hintPath, "system"),
    ]);
    expect(readWindowThemeHint(hintPath)).toBe("system");
    expect(NodeFS.readdirSync(NodePath.dirname(hintPath))).toEqual(["window-theme.json"]);
  });
});
