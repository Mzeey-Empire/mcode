import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { createCliStatusRunner } from "../cli-status-runner.js";

const run = createCliStatusRunner({ platform: process.platform, env: process.env, timeoutMs: 2_000 });

describe("createCliStatusRunner", () => {
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

  it("reports a missing binary as failed", async () => {
    await expect(run("mcode-no-such-status-binary", ["status"])).resolves.toEqual({ kind: "failed" });
    await expect(run(NodePath.join(process.cwd(), "no-such-binary"), ["status"])).resolves.toEqual({ kind: "failed" });
  });
});
