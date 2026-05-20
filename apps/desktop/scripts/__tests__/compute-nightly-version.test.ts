import { describe, it, expect } from "vitest";
import { computeNightlyVersion } from "../compute-nightly-version.mjs";

describe("computeNightlyVersion", () => {
  it("bumps minor and resets patch to 0", () => {
    const v = computeNightlyVersion({
      manifest: { ".": "0.11.1" },
      runNumber: 42,
      date: new Date("2026-05-18T06:00:00Z"),
    });
    expect(v).toBe("0.12.0-nightly.20260518.42");
  });

  it("works when last stable patch is already 0", () => {
    const v = computeNightlyVersion({
      manifest: { ".": "0.12.0" },
      runNumber: 1,
      date: new Date("2026-05-19T06:00:00Z"),
    });
    expect(v).toBe("0.13.0-nightly.20260519.1");
  });

  it("works for post-1.0 versions", () => {
    const v = computeNightlyVersion({
      manifest: { ".": "1.4.7" },
      runNumber: 5,
      date: new Date("2026-06-01T06:00:00Z"),
    });
    expect(v).toBe("1.5.0-nightly.20260601.5");
  });

  it("clamps runNumber to 16-bit range for Windows VERSIONINFO", () => {
    const v = computeNightlyVersion({
      manifest: { ".": "0.11.1" },
      runNumber: 70000,
      date: new Date("2026-05-18T06:00:00Z"),
    });
    // 70000 % 65536 = 4464
    expect(v).toBe("0.12.0-nightly.20260518.4464");
  });

  it("zero-pads month and day", () => {
    const v = computeNightlyVersion({
      manifest: { ".": "0.11.1" },
      runNumber: 1,
      date: new Date("2026-01-05T06:00:00Z"),
    });
    expect(v).toBe("0.12.0-nightly.20260105.1");
  });

  it("throws when manifest['.'] is missing", () => {
    expect(() =>
      computeNightlyVersion({
        manifest: {},
        runNumber: 1,
        date: new Date(),
      }),
    ).toThrow(/manifest\["\."\]/);
  });

  it("throws when manifest['.'] is not semver", () => {
    expect(() =>
      computeNightlyVersion({
        manifest: { ".": "not-a-version" },
        runNumber: 1,
        date: new Date(),
      }),
    ).toThrow(/semver/);
  });
});
