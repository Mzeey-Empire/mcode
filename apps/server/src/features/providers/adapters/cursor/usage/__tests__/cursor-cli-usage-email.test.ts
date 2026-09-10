import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import { CursorCliUsageEmailResolver } from "../cursor-cli-usage-email.js";

type ExecFileResult = { stdout: string; stderr: string };

describe("CursorCliUsageEmailResolver", () => {
  const execFileImpl = vi.fn();
  const now = vi.fn();
  let warnMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileImpl.mockReset();
    warnMock = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    now.mockReturnValue(1_000);
  });

  afterEach(() => vi.restoreAllMocks());

  const okAbout = (body: object): ExecFileResult => ({
    stdout: JSON.stringify(body),
    stderr: "",
  });

  it("returns the trimmed userEmail from `about --format json`", async () => {
    execFileImpl.mockResolvedValue(okAbout({ cliVersion: "1.0.0", userEmail: " dev@example.com " }));
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    expect(execFileImpl).toHaveBeenCalledWith(
      "cursor-agent",
      ["about", "--format", "json"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("resolves the CLI path lazily from the configured resolver", async () => {
    execFileImpl.mockResolvedValue(okAbout({ userEmail: "dev@example.com" }));
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: async () => "/opt/cursor/agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    expect(execFileImpl).toHaveBeenCalledWith(
      "/opt/cursor/agent",
      ["about", "--format", "json"],
      expect.anything(),
    );
  });

  it("returns undefined when the CLI path is empty", async () => {
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "  ",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("returns undefined when userEmail is null or empty", async () => {
    execFileImpl.mockResolvedValue(okAbout({ cliVersion: "1.0.0", userEmail: null }));
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
  });

  it("returns undefined when the CLI cannot be spawned or exits non-zero", async () => {
    execFileImpl.mockRejectedValue(new Error("spawn cursor-agent ENOENT"));
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith("Cursor usage email unavailable", {
      reason: "cli_failed",
      error: "Error",
    });
  });

  it("returns undefined when the CLI hangs past the timeout", async () => {
    const timeoutError = new Error("timed out") as Error & { killed?: boolean };
    timeoutError.killed = true;
    execFileImpl.mockRejectedValue(timeoutError);
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith("Cursor usage email unavailable", {
      reason: "cli_failed",
      error: "Error",
    });
  });

  it("returns undefined for invalid JSON output", async () => {
    execFileImpl.mockResolvedValue({ stdout: "not json", stderr: "" });
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith("Cursor usage email unavailable", {
      reason: "invalid_json",
    });
  });

  it("returns undefined for JSON with an unexpected shape", async () => {
    execFileImpl.mockResolvedValue({ stdout: JSON.stringify({ userEmail: 42 }), stderr: "" });
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith("Cursor usage email unavailable", {
      reason: "invalid_shape",
    });
  });

  it("caches the resolved email and re-resolves after the TTL expires", async () => {
    execFileImpl.mockResolvedValue(okAbout({ userEmail: "dev@example.com" }));
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    expect(execFileImpl).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + 15 * 60 * 1000 + 1);
    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the CLI path changes", async () => {
    let cliPath = "cursor-agent";
    execFileImpl.mockResolvedValue(okAbout({ userEmail: "dev@example.com" }));
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: () => cliPath,
      execFileImpl,
      now,
    });

    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    cliPath = "/other/agent";
    await expect(resolver.resolve()).resolves.toBe("dev@example.com");
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl).toHaveBeenLastCalledWith(
      "/other/agent",
      ["about", "--format", "json"],
      expect.anything(),
    );
  });

  it("dedupes concurrent resolutions", async () => {
    let resolveExec: (result: ExecFileResult) => void = () => {};
    execFileImpl.mockReturnValue(
      new Promise<ExecFileResult>((resolve) => {
        resolveExec = resolve;
      }),
    );
    const resolver = new CursorCliUsageEmailResolver({
      cliPath: "cursor-agent",
      execFileImpl,
      now,
    });

    const first = resolver.resolve();
    const second = resolver.resolve();
    resolveExec(okAbout({ userEmail: "dev@example.com" }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      "dev@example.com",
      "dev@example.com",
    ]);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });
});
