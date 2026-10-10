import { describe, expect, it } from "vitest";
import { formatUsageResetShort, formatUsageResetText } from "./usage-reset-format";

describe("formatUsageResetText", () => {
  const now = new Date("2026-07-03T12:00:00.000Z");

  it("formats relative and compact exact reset text", () => {
    expect(formatUsageResetText("2026-07-03T14:14:00.000Z", now)).toContain(
      "Resets in 2h 14m ·",
    );
    expect(formatUsageResetText("2026-07-03T14:14:00.000Z", now)).toContain("Jul 3");
  });

  it("formats day and hour resets", () => {
    expect(formatUsageResetText("2026-07-05T15:00:00.000Z", now)).toContain(
      "Resets in 2d 3h ·",
    );
  });

  it("rejects expired timestamps", () => {
    expect(formatUsageResetText("2026-07-03T11:59:59.000Z", now)).toBeNull();
  });

  it("rejects invalid timestamps", () => {
    expect(formatUsageResetText("not-a-date", now)).toBeNull();
  });

  it("rejects missing timestamps", () => {
    expect(formatUsageResetText(undefined, now)).toBeNull();
    expect(formatUsageResetText(null, now)).toBeNull();
  });
});

describe("formatUsageResetShort", () => {
  const now = new Date("2026-07-03T12:00:00.000Z");

  it("shows the clock time for a reset within a day", () => {
    expect(formatUsageResetShort("2026-07-03T16:00:00.000Z", now, "UTC")).toBe("resets 16:00");
    expect(formatUsageResetShort("2026-07-04T11:59:00.000Z", now, "UTC")).toBe("resets 11:59");
  });

  it("shows the weekday for a reset within a week, then the date", () => {
    expect(formatUsageResetShort("2026-07-04T12:00:00.000Z", now, "UTC")).toBe("resets Sat");
    expect(formatUsageResetShort("2026-07-10T11:59:00.000Z", now, "UTC")).toBe("resets Fri");
    expect(formatUsageResetShort("2026-07-10T12:00:00.000Z", now, "UTC")).toBe("resets Jul 10");
  });

  it("rejects expired, invalid, and missing timestamps", () => {
    expect(formatUsageResetShort("2026-07-03T12:00:00.000Z", now)).toBeNull();
    expect(formatUsageResetShort("not-a-date", now)).toBeNull();
    expect(formatUsageResetShort(null, now)).toBeNull();
  });
});
