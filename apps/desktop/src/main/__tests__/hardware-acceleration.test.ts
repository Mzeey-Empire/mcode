import { describe, expect, it } from "vitest";
import { resolveHardwareAccelerationMode } from "../hardware-acceleration";

const performanceRun = (mode: string) => ({
  MCODE_FRONTEND_PERFORMANCE_MODE: "production",
  MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: mode,
});

describe("resolveHardwareAccelerationMode", () => {
  it("enables acceleration when the saved setting is on", () => {
    expect(resolveHardwareAccelerationMode({}, true)).toBe("default");
  });

  it("disables acceleration when the saved setting is off or unreadable", () => {
    expect(resolveHardwareAccelerationMode({}, false)).toBe("disabled");
    expect(resolveHardwareAccelerationMode({}, null)).toBe("disabled");
  });

  it("lets the performance runner override the saved setting", () => {
    expect(resolveHardwareAccelerationMode(performanceRun("disabled"), true)).toBe("disabled");
    expect(resolveHardwareAccelerationMode(performanceRun("default"), false)).toBe("default");
  });

  it("ignores the runner's acceleration mode outside a production performance run", () => {
    expect(resolveHardwareAccelerationMode(
      { MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: "default" },
      false,
    )).toBe("disabled");
  });

  it("rejects an unknown performance runner mode", () => {
    expect(() => resolveHardwareAccelerationMode(performanceRun("fast"), true)).toThrow(/disabled or default/);
  });
});
