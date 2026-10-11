import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { createCliStatusRunner, readCliStatusVersion } from "../cli-status-runner.js";

const run = createCliStatusRunner({ platform: process.platform, env: process.env, timeoutMs: 2_000 });

describe("createCliStatusRunner", () => {
  it.each([
    ["2.1.0 (Claude Code)", "2.1.0"],
    ["1.0.0-beta.1", "1.0.0-beta.1"],
    ["unknown version", null],
    ["1.2.3.4", null],
  ])("reads the adapter version from %s", async (output, expected) => {
    expect(await readCliStatusVersion(async (_binary, args) => {
      expect(args).toEqual(["--version"]);
      return { kind: "exited", code: 0, output };
    }, "provider")).toBe(expected);
  });

  it("does not treat version output from a failed probe as installed", async () => {
    expect(await readCliStatusVersion(async () => ({ kind: "exited", code: 1, output: "1.2.3" }), "provider")).toBeNull();
  });
  it("keeps the output of a non-zero exit and strips ANSI colour", async () => {
    const script = "process.stdout.write('\\u001b[90mNot logged in\\u001b[0m'); process.exit(1)";
    const outcome = await run(process.execPath, ["-e", script]);
    expect(outcome).toEqual({ kind: "exited", code: 1, output: expect.stringContaining("Not logged in") });
    expect(outcome.kind === "exited" && outcome.output.includes("\u001b")).toBe(false);
  });

  it("reports a timeout as failed", async () => {
    const quick = createCliStatusRunner({ platform: process.platform, env: process.env, timeoutMs: 200 });
    await expect(quick(process.execPath, ["-e", "setTimeout(() => {}, 5000)"])).resolves.toEqual({ kind: "failed" });
  });

  it.runIf(process.platform === "win32")("runs a .cmd shim installed under a path with spaces", async () => {
    const dir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode status shim "));
    try {
      const shim = NodePath.join(dir, "fake-cli.cmd");
      await NodeFSPromises.writeFile(shim, "@echo off\r\necho Not logged in %1\r\nexit /b 1\r\n");
      await expect(run(shim, ["status"])).resolves.toEqual({
        kind: "exited",
        code: 1,
        output: expect.stringContaining("Not logged in status"),
      });
    } finally {
      await NodeFSPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing binary as failed", async () => {
    await expect(run("mcode-no-such-status-binary", ["status"])).resolves.toEqual({ kind: "failed" });
    await expect(run(NodePath.join(process.cwd(), "no-such-binary"), ["status"])).resolves.toEqual({ kind: "failed" });
  });
});
