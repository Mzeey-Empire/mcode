import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

describe("act() warning guard", () => {
  it("fails a test that updates React state outside act()", () => {
    const webRoot = process.cwd();
    const vitestBin = NodePath.join(
      NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("vitest/package.json")),
      "vitest.mjs",
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [vitestBin, "run", "--project", "dom", "--reporter", "default", "src/__tests__/fixtures/act-outside.fixture.test.tsx"],
      {
        cwd: webRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, MCODE_ACT_GUARD_FIXTURE: "1" },
      },
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain("updates React state outside act()");
    expect(result.status, output).toBe(1);
    expect(output).toContain("call cleanup() before flushing timers, or wrap the update in act().");
  }, 60_000);
});
