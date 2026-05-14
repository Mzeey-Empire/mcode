import { describe, expect, it } from "vitest";
import { PreviewDeviceEmulationConfigSchema } from "../preview-device-emulation.js";

describe("PreviewDeviceEmulationConfigSchema", () => {
  it("accepts off, preset, and custom shapes", () => {
    const schema = PreviewDeviceEmulationConfigSchema();
    expect(schema.parse({ kind: "off" })).toEqual({ kind: "off" });
    expect(
      schema.parse({
        kind: "preset",
        presetId: "iphone-14-pro",
        orientation: "landscape",
      }),
    ).toEqual({
      kind: "preset",
      presetId: "iphone-14-pro",
      orientation: "landscape",
    });
    expect(
      schema.parse({
        kind: "custom",
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
      }),
    ).toEqual({
      kind: "custom",
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
    });
  });

  it("rejects custom dimensions below the minimum", () => {
    const schema = PreviewDeviceEmulationConfigSchema();
    const r = schema.safeParse({ kind: "custom", width: 50, height: 844 });
    expect(r.success).toBe(false);
  });
});
