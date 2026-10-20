import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("logger data directory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("can be imported without a data dir, so tools and tests that never log still load", async () => {
    vi.stubEnv("MCODE_DATA_DIR", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();

    await expect(import("../index.js")).resolves.toHaveProperty("logger");
  });

  it("writes the first log entry under the data dir", async () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-logger-"));
    vi.stubEnv("MCODE_DATA_DIR", dataDir);
    vi.resetModules();
    try {
      const { logger, getLogPath } = await import("../index.js");

      logger.info("first call");

      expect(getLogPath()).toBe(NodePath.join(dataDir, "logs"));
      await vi.waitFor(() => {
        const file = NodeFS.readdirSync(NodePath.join(dataDir, "logs")).find((name) => name.startsWith("mcode.log."));
        expect(NodeFS.readFileSync(NodePath.join(dataDir, "logs", file ?? ""), "utf8")).toContain("first call");
      });
      logger.close();
    } finally {
      NodeFS.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
