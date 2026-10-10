import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as NodeModule from "node:module";
import { build } from "esbuild";
import { PtyHostSupervisor } from "../pty-host-supervisor.js";
import { spawnPtyHostChild } from "../pty-host-child.js";
import { InMemoryPtyHostCleanupLedger } from "../../testing/in-memory-pty-host-cleanup-ledger.js";
import { actionTerminalTestFixture, ACTION_TEST_THREAD } from "../../testing/action-terminal-test-fixture.js";

async function createRealHost(root: string): Promise<PtyHostSupervisor> {
  const nativeRequire = NodeModule.createRequire(import.meta.url);
  const desktopRequire = NodeModule.createRequire(NodePath.resolve("../desktop/package.json"));
  const executablePath: unknown = desktopRequire("electron");
  if (typeof executablePath !== "string") throw new Error("Electron host executable is unavailable");
  const entryPath = NodePath.join(root, "pty-host.cjs");
  await build({
    entryPoints: [NodePath.resolve("src/features/terminal/host/pty-host-entry.ts")],
    outfile: entryPath, bundle: true, platform: "node", target: "node22", format: "cjs",
    external: ["node-pty", "koffi"],
    banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
    define: { "import.meta.url": "__importMetaUrl" },
  });
  return new PtyHostSupervisor({
    platform: "windows", cleanupLedger: new InMemoryPtyHostCleanupLedger(),
    startupTimeoutMs: 20000, heartbeatDegradedMs: 5000, heartbeatUnhealthyMs: 10000, operationTimeoutMs: 20000,
    spawnHost: () => spawnPtyHostChild({
      platform: "win32", architecture: process.arch, entryPath, executablePath,
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: ["node-pty", "koffi"]
          .map((name) => NodePath.dirname(NodePath.dirname(nativeRequire.resolve(`${name}/package.json`))))
          .join(NodePath.delimiter),
      },
    }),
  });
}

describe.runIf(process.platform === "win32")("action terminal with a real Windows PTY", () => {
  it("preserves command exit 2 and hands the same terminal to an interactive cmd shell", async () => {
    const fixtureRoot = NodePath.resolve("../..", ".dev/fixture-repo");
    await NodeFSPromises.mkdir(fixtureRoot, { recursive: true });
    const root = await NodeFSPromises.mkdtemp(NodePath.join(fixtureRoot, "action-real-"));
    const host = await createRealHost(root);
    const creates = vi.spyOn(host, "create");
    const fixture = actionTerminalTestFixture(host, root, {
      id: "certified:windows-cmd", name: "Command Prompt", executable: process.env.ComSpec ?? "cmd.exe",
      arguments: ["/Q"], platform: "windows", source: "certified",
    });
    const output: Uint8Array[] = [];
    const sequences: number[] = [];
    fixture.backend.setSender({
      data: (_id, seq, bytes) => { sequences.push(seq); output.push(bytes); }, json: () => undefined,
    });
    try {
      const script = "echo __ACTION_COMMAND__ & exit /b 2";
      const terminal = await fixture.backend.openActionTerminal({
        threadId: ACTION_TEST_THREAD, actionId: "build", launch: { script },
      });
      fixture.backend.resume(terminal.terminalSessionId);
      const commandOutput: Uint8Array[] = [];
      const exits: Array<number | null> = [];
      terminal.onCommandOutput((bytes) => commandOutput.push(bytes));
      terminal.onCommandExit(({ exitCode }) => exits.push(exitCode));
      await vi.waitFor(() => expect(exits).toEqual([2]), { timeout: 10000 });
      await vi.waitFor(() => expect(creates).toHaveBeenCalledTimes(2), { timeout: 10000 });
      const [command, shell] = creates.mock.calls.map(([input]) => input);
      expect(command.sessionId).not.toBe(shell.sessionId);
      expect(command.launch.arguments).toEqual(["/Q", "/d", "/s", "/c", script]);
      expect(shell.launch.arguments).toEqual(["/Q"]);
      expect(shell.cwd).toBe(root);
      await vi.waitFor(() => expect(fixture.backend.listActiveSessions()[0].state).toBe("running"), { timeout: 10000 });
      await fixture.backend.write(terminal.terminalSessionId, "set /a 731+19\r");
      await vi.waitFor(() => expect(Buffer.concat(output).toString()).toContain("750"), { timeout: 10000 });
      expect(Buffer.concat(commandOutput).toString()).toContain("__ACTION_COMMAND__");
      expect(Buffer.concat(commandOutput).toString()).not.toContain("exit /b 2");
      expect(Buffer.concat(commandOutput).toString()).not.toContain("750");
      expect(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1])).toBe(true);
      expect(fixture.backend.listActiveSessions()).toEqual([expect.objectContaining({
        ptyId: terminal.terminalSessionId, kind: "action", actionId: "build", state: "running",
      })]);
    } finally {
      await fixture.terminals.shutdown();
      await NodeFSPromises.rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
