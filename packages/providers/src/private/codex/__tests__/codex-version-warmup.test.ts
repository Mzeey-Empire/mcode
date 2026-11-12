import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkCodexVersion, clearVersionCache, currentCodexVersion, warmCodexVersionCache, type CodexVersionRunner } from "../codex-version.js";

describe("Codex version warmup", () => {
  beforeEach(clearVersionCache);

  it("warms the send-path cache from version output on stderr", async () => {
    await warmCodexVersionCache("codex", async () => ({ stdout: "", stderr: "codex-cli 0.118.0" }));

    expect(checkCodexVersion("codex")).toEqual({ ok: true, version: "0.118.0" });
    expect(currentCodexVersion()).toBe("0.118.0");
  });

  it("retries a failed probe and keeps a successful cache entry", async () => {
    const run = vi.fn<CodexVersionRunner>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ stdout: "codex-cli 0.119.0", stderr: "" })
      .mockResolvedValueOnce({ stdout: "codex-cli 0.120.0", stderr: "" });
    await warmCodexVersionCache("codex", run);
    expect(currentCodexVersion()).toBeNull();
    await warmCodexVersionCache("codex", run);
    await warmCodexVersionCache("codex", run);
    expect(checkCodexVersion("codex")).toEqual({ ok: true, version: "0.119.0" });
  });

  it("does not cache output without a version", async () => {
    await warmCodexVersionCache("codex", async () => ({ stdout: "invalid", stderr: "" }));
    expect(currentCodexVersion()).toBeNull();
    await warmCodexVersionCache("codex", async () => ({ stdout: "codex-cli 0.118.0", stderr: "" }));
    expect(currentCodexVersion()).toBe("0.118.0");
  });
});
