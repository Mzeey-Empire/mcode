import { describe, expect, it } from "vitest";
import { appDisplayName, BuildStageSchema, isNightlyVersion, resolveBuildStage } from "../build-stage.js";

describe("resolveBuildStage", () => {
  it.each([
    { agentRuntime: true, version: "0.13.0", stage: "dev" },
    { agentRuntime: true, version: "0.13.0-nightly.20260815.1", stage: "dev" },
    { agentRuntime: false, version: "0.13.0-nightly.20260815.1", stage: "nightly" },
    { agentRuntime: false, version: "0.13.0", stage: "stable" },
    { agentRuntime: false, version: "1.2.0-nightlyX", stage: "stable" },
    { agentRuntime: false, version: "", stage: "stable" },
  ])("classifies $version (agentRuntime $agentRuntime) as $stage", ({ stage, ...input }) => {
    expect(resolveBuildStage(input)).toBe(stage);
  });
});

describe("isNightlyVersion", () => {
  it("requires the dot after the nightly tag", () => {
    expect(isNightlyVersion("0.13.0-nightly.20260815.1")).toBe(true);
    expect(isNightlyVersion("0.13.0-nightly")).toBe(false);
    expect(isNightlyVersion("0.13.0")).toBe(false);
  });
});

describe("appDisplayName", () => {
  it("labels only non-stable builds", () => {
    expect(appDisplayName("dev")).toBe("Mcode (Dev)");
    expect(appDisplayName("nightly")).toBe("Mcode (Nightly)");
    expect(appDisplayName("stable")).toBe("Mcode");
  });
});

describe("BuildStageSchema", () => {
  it("rejects values outside the three stages", () => {
    expect(BuildStageSchema().safeParse("beta").success).toBe(false);
    expect(BuildStageSchema().safeParse("dev").success).toBe(true);
  });
});
