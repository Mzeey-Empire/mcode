import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

const ACT_WARNING_TEXT = "not wrapped in act(";

function runFixture(fixtureCase: "one" | "flood" | "after-all") {
  const vitestBin = NodePath.join(
    NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [vitestBin, "run", "--project", "dom", "--reporter", "default", "src/__tests__/fixtures/act-outside.fixture.test.tsx"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, MCODE_ACT_GUARD_FIXTURE: fixtureCase },
    },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("act() warning guard", () => {
  it("fails a test that updates React state outside act()", () => {
    const { status, output } = runFixture("one");

    expect(output).toContain("updates React state outside act()");
    expect(status, output).toBe(1);
    expect(output).toContain("call cleanup() before flushing timers, or wrap the update in act().");
  }, 60_000);

  it("fails a flooding test but prints only the first 10 warnings", () => {
    const { status, output } = runFixture("flood");

    expect(status, output).toBe(1);
    expect(output).toContain("500 React act() warning(s)");
    expect(output).toContain("490 more were suppressed");
    const printed = output.split(ACT_WARNING_TEXT).length - 1;
    expect(printed).toBeGreaterThan(0);
    expect(printed).toBeLessThanOrEqual(10);
  }, 60_000);

  it("fails the run when a warning arrives in afterAll, after the last test's check", () => {
    const { status, output } = runFixture("after-all");

    expect(status, output).toBe(1);
    expect(output).toContain("after its last test");
  }, 60_000);
});
