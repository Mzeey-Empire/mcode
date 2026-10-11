import { describe, it, expect } from "vitest";
import { isNewer, isSemver, meetsMinVersion } from "../version-policy.js";

describe("meetsMinVersion", () => {
  it("returns true when version meets minimum", () => {
    expect(meetsMinVersion("0.37.0", "0.37.0")).toBe(true);
  });

  it("returns false when version is below minimum", () => {
    expect(meetsMinVersion("0.36.9", "0.37.0")).toBe(false);
  });

  it("returns true when major version is higher", () => {
    expect(meetsMinVersion("1.0.0", "0.37.0")).toBe(true);
  });

  it("returns true for much higher minor version", () => {
    expect(meetsMinVersion("0.118.0", "0.37.0")).toBe(true);
  });

  it("returns true for patch increment", () => {
    expect(meetsMinVersion("0.37.1", "0.37.0")).toBe(true);
  });

  it("returns false for malformed version string", () => {
    expect(meetsMinVersion("abc", "0.37.0")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(meetsMinVersion("", "0.37.0")).toBe(false);
  });
});

describe("isNewer", () => {
  it.each([
    ["1.0.0", "1.0.0-beta.1", true],
    ["1.0.0-beta.10", "1.0.0-beta.2", true],
    ["1.0.0-beta", "1.0.0-alpha", true],
    ["1.0.0-alpha.1", "1.0.0-alpha", true],
    ["1.0.0-alpha.beta", "1.0.0-alpha.1", true],
    ["1.0.0-beta.1", "1.0.0", false],
    ["1.0.0+build.2", "1.0.0+build.1", false],
    ["1.1.0", "1.0.99", true],
    ["1.0.0", "1.0.0", false],
    ["0.9.9", "1.0.0", false],
    ["garbage", "1.0.0", false],
    ["1.0.0", "", false],
    ["01.0.0", "1.0.0", false],
    ["1.0.0-beta.01", "1.0.0", false],
    ["1.0.0.1", "1.0.0", false],
  ])("%s compared with %s is newer: %s", (latest, installed, expected) => {
    expect(isNewer(latest, installed)).toBe(expected);
  });
  it.each(["latest", "1.0", "1.0.0;echo bad", "1.0.0\\n", "-1.0.0", "1..0", "1.0.0-01"])(
    "rejects invalid npm target %j", (version) => expect(isSemver(version)).toBe(false),
  );
});
