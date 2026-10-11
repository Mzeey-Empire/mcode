import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import * as NodeChildProcess from "node:child_process";
import { checkCodexVersion, clearVersionCache } from "../../private/codex/codex-version.js";

const mockSpawnSync = vi.mocked(NodeChildProcess.spawnSync);


describe("checkCodexVersion error messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVersionCache();
  });

  it("default path error contains 'CLI not found'", () => {
    mockSpawnSync.mockReturnValue({
      error: new Error("ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("codex");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("CLI not found");
  });

  it("custom path error contains 'not found at'", () => {
    mockSpawnSync.mockReturnValue({
      error: new Error("ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("/custom/path/codex");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('not found at "/custom/path/codex"');
  });

  it("timeout error contains 'timed out'", () => {
    const timeoutError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    mockSpawnSync.mockReturnValue({
      error: timeoutError,
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("codex");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error.toLowerCase()).toContain("timed out");
  });

  it("returns ok:true and version when CLI succeeds", () => {
    mockSpawnSync.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "codex 0.118.0 (build xyz)",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("codex");

    expect(result.ok).toBe(true);
    expect((result as { ok: true; version: string }).version).toBe("0.118.0");
  });

  it("rejects cliPath with shell metacharacters without calling spawnSync", () => {
    mockSpawnSync.mockClear();

    const dangerous = ["codex; rm -rf /", "`$(rm -rf /)`", "codex'--bad", "path with spaces/codex"];
    for (const cliPath of dangerous) {
      const result = checkCodexVersion(cliPath);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain("invalid characters");
    }
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("preserves prerelease versions and invalidates the installed-version cache", () => {
    mockSpawnSync.mockReturnValue({
      status: 0, stdout: "codex-cli 1.0.0-beta.2", stderr: "", pid: 0, output: [], signal: null,
    });
    expect(checkCodexVersion("codex")).toEqual({ ok: true, version: "1.0.0-beta.2" });
    mockSpawnSync.mockReturnValue({
      status: 0, stdout: "codex-cli 1.0.0", stderr: "", pid: 0, output: [], signal: null,
    });
    expect(checkCodexVersion("codex")).toEqual({ ok: true, version: "1.0.0-beta.2" });
    clearVersionCache();
    expect(checkCodexVersion("codex")).toEqual({ ok: true, version: "1.0.0" });
  });

  it("returns error when CLI exits with non-zero status", () => {
    vi.mocked(NodeChildProcess.spawnSync).mockReturnValueOnce({
      pid: 123,
      status: 1,
      signal: null,
      output: [null, "", ""],
      stdout: "",
      stderr: "unknown error",
      error: undefined,
    });
    const result = checkCodexVersion("codex");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("CLI not found");
  });
});
