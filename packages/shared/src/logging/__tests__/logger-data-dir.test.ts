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

  it("appends a synchronous entry to the file the logger rotates into today", async () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-logger-"));
    vi.stubEnv("MCODE_DATA_DIR", dataDir);
    vi.resetModules();
    try {
      const { logger, appendLogSync } = await import("../index.js");
      const logDir = NodePath.join(dataDir, "logs");

      appendLogSync("Launch record", { launchId: "launch-1" });
      const [file] = NodeFS.readdirSync(logDir);
      expect(JSON.parse(NodeFS.readFileSync(NodePath.join(logDir, file ?? ""), "utf8"))).toMatchObject({
        level: "info", message: "Launch record", launchId: "launch-1",
      });
      logger.info("streamed entry");
      await vi.waitFor(() => expect(NodeFS.readFileSync(NodePath.join(logDir, file ?? ""), "utf8")).toContain("streamed entry"));
      expect(NodeFS.readdirSync(logDir).filter((name) => name.startsWith("mcode.log."))).toEqual([file]);
      logger.close();
    } finally {
      NodeFS.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
