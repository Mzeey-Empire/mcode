import { describe, expect, it, vi } from "vitest";
import { CliUpdateRunner, type CliUpdateProcessHost } from "../cli-update-runner.js";

function fixture(prefix = "/scratch/npm", platform: NodeJS.Platform = "linux") {
  const run = vi.fn<CliUpdateProcessHost["run"]>(async () => ({ kind: "exited", code: 0, output: prefix }));
  return { run, runner: new CliUpdateRunner({ platform, run }) };
}

describe("CliUpdateRunner", () => {
  it("checks the server prefix, then installs the exact package with fixed argv and a five-minute timeout", async () => {
    const { runner, run } = fixture();
    expect(await runner.update({ resolvedPath: "/scratch/npm/bin/codex", npmPackage: "@openai/codex", target: "1.0.0-beta.1" })).toEqual({ ok: true });
    expect(run.mock.calls).toEqual([
      [["prefix", "-g"], 5_000],
      [["install", "-g", "@openai/codex@1.0.0-beta.1"], 300_000],
    ]);
  });

  it.each(["/usr/bin/codex", "/scratch/npm-other/codex", "/scratch/npm/../other/codex", "codex", "/scratch/npm"])(
    "does not install a CLI outside the detected prefix: %s", async (resolvedPath) => {
      const { runner, run } = fixture();
      expect(await runner.canUpdate(resolvedPath)).toBe(false);
      expect(await runner.update({ resolvedPath, npmPackage: "@openai/codex", target: "1.0.0" })).toEqual({
        ok: false, reason: "CLI is outside the server's npm prefix or npm is unavailable.",
      });
      expect(run.mock.calls).toEqual([[["prefix", "-g"], 5_000], [["prefix", "-g"], 5_000]]);
    },
  );

  it("normalizes Windows case, separators and parent components without accepting prefix siblings", async () => {
    const { runner } = fixture("C:/Scratch/Npm", "win32");
    expect(await runner.canUpdate("c:/scratch/npm/bin/../codex.cmd")).toBe(true);
    expect(await runner.canUpdate("C:/Scratch/Npm-other/codex.cmd")).toBe(false);
    expect(await runner.canUpdate("D:/Scratch/Npm/codex.cmd")).toBe(false);
  });

  it("keeps POSIX ownership case-sensitive", async () => {
    expect(await fixture().runner.canUpdate("/Scratch/npm/bin/codex")).toBe(false);
  });

  it.each(["latest", "1.0", "1.0.0 && echo bad", "1.0.0\n", "--prefix=/other"])(
    "rejects a non-semver target before spawning: %j", async (target) => {
      const { runner, run } = fixture();
      expect(await runner.update({ resolvedPath: "/scratch/npm/codex", npmPackage: "@openai/codex", target })).toEqual({
        ok: false, reason: "Invalid package or target version.",
      });
      expect(run.mock.calls).toEqual([]);
    },
  );

  it("rejects a package that could add arguments", async () => {
    const { runner, run } = fixture();
    expect(await runner.update({ resolvedPath: "/scratch/npm/codex", npmPackage: "codex --prefix=/other", target: "1.0.0" })).toEqual({
      ok: false, reason: "Invalid package or target version.",
    });
    expect(run.mock.calls).toEqual([]);
  });

  it("bounds failed output and reports process timeouts", async () => {
    const { runner, run } = fixture();
    run.mockResolvedValueOnce({ kind: "exited", code: 0, output: "/scratch/npm" });
    run.mockResolvedValueOnce({ kind: "exited", code: 1, output: "  " + "x".repeat(500) });
    expect(await runner.update({ resolvedPath: "/scratch/npm/codex", npmPackage: "@openai/codex", target: "1.0.0" })).toEqual({
      ok: false, reason: "x".repeat(240),
    });
    run.mockResolvedValueOnce({ kind: "exited", code: 0, output: "/scratch/npm" });
    run.mockResolvedValueOnce({ kind: "failed" });
    expect(await runner.update({ resolvedPath: "/scratch/npm/codex", npmPackage: "@openai/codex", target: "1.0.0" })).toEqual({
      ok: false, reason: "npm update could not start or timed out.",
    });
  });

  it("offers no update when npm prefix fails or returns a relative path", async () => {
    const { runner, run } = fixture("npm");
    expect(await runner.canUpdate("/scratch/npm/codex")).toBe(false);
    run.mockResolvedValue({ kind: "failed" });
    expect(await runner.canUpdate("/scratch/npm/codex")).toBe(false);
  });
});
