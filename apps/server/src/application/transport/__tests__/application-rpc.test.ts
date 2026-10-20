import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../ws-router.js";

async function appStage(): Promise<unknown> {
  const response = await routeMessage(
    JSON.stringify({ id: "stage-1", method: "app.stage", params: {} }),
    {} as RouterDeps,
  );
  return response.result;
}

describe("app.stage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports dev under the agent runtime marker even for a nightly version", async () => {
    vi.stubEnv("MCODE_AGENT_RUNTIME", "1");
    vi.stubEnv("MCODE_VERSION", "0.13.0-nightly.20260815.1");
    expect(await appStage()).toBe("dev");
  });

  it("reports nightly from the version without the marker", async () => {
    vi.stubEnv("MCODE_AGENT_RUNTIME", "");
    vi.stubEnv("MCODE_VERSION", "0.13.0-nightly.20260815.1");
    expect(await appStage()).toBe("nightly");
  });

  it("reports stable for a plain version without the marker", async () => {
    vi.stubEnv("MCODE_AGENT_RUNTIME", "");
    vi.stubEnv("MCODE_VERSION", "0.13.0");
    expect(await appStage()).toBe("stable");
  });
});
