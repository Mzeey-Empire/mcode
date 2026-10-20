import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMcodeDir } from "../index.js";

describe("getMcodeDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns MCODE_DATA_DIR when the launcher provides it", () => {
    vi.stubEnv("MCODE_DATA_DIR", NodePath.join("work", "tree", ".dev"));
    vi.stubEnv("NODE_ENV", "development");

    expect(getMcodeDir()).toBe(NodePath.join("work", "tree", ".dev"));
  });

  it("uses ~/.mcode in production when no data dir is provided", () => {
    vi.stubEnv("MCODE_DATA_DIR", "");
    vi.stubEnv("NODE_ENV", "production");

    expect(getMcodeDir()).toBe(NodePath.join(NodeOS.homedir(), ".mcode"));
  });

  it("refuses to guess a data dir outside production and names the supported launchers", () => {
    vi.stubEnv("MCODE_DATA_DIR", "");
    vi.stubEnv("NODE_ENV", "development");

    expect(() => getMcodeDir()).toThrow(/bun run dev/);
    expect(() => getMcodeDir()).toThrow(/dev:desktop/);
    expect(() => getMcodeDir()).toThrow(/agent:up/);
  });
});
