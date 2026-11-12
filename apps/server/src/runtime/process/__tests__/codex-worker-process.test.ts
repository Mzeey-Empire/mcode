import * as NodeEvents from "node:events";
import { describe, expect, it } from "vitest";
import { createWorkerCodexProcessLauncher } from "../../../../../../packages/providers/src/private/codex/codex-worker-process.js";
import { CodexAppServer } from "../../../../../../packages/providers/src/private/codex/codex-app-server.js";
import { ProcessStartWorkerClient } from "../process-start-worker-client.js";

describe("worker-backed Codex process", () => {
  it("delivers spawn before output, echoes stdin, streams stderr, and exits on terminate", async () => {
    const launch = createWorkerCodexProcessLauncher(new ProcessStartWorkerClient().open);
    const child = launch(process.execPath, ["-e", "process.stderr.write('diagnostic\\n');process.stdin.on('data', c => process.stdout.write(c))"], {});
    const events: string[] = [];
    child.on("spawn", () => events.push("spawn"));
    child.stdout.on("data", () => events.push("stdout"));
    child.stderr.on("data", () => events.push("stderr"));
    const stderr = NodeEvents.once(child.stderr, "data");
    const stdout = NodeEvents.once(child.stdout, "data");
    try {
      await NodeEvents.once(child, "spawn");
      expect(process.kill(child.pid!, 0)).toBe(true);
      child.stdin.write("hello worker\n");
      expect(String((await stdout)[0])).toBe("hello worker\n");
      expect(String((await stderr)[0])).toBe("diagnostic\n");
      expect(events[0]).toBe("spawn");
    } finally {
      const exit = NodeEvents.once(child, "exit");
      await child.terminate!();
      const [code, signal] = await exit;
      expect(code !== null || signal !== null).toBe(true);
    }
  });

  it("completes a catalog-only handshake through worker-backed stdio", async () => {
    const methods: string[] = [];
    const script = "const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line', line=>{const r=JSON.parse(line);process.stderr.write(r.method+'\\n');if(r.id!==undefined)console.log(JSON.stringify({id:r.id,result:{}}));});";
    const workerLaunch = createWorkerCodexProcessLauncher(new ProcessStartWorkerClient().open);
    const server = new CodexAppServer({
      cliPath: process.execPath, workingDirectory: process.cwd(), platform: process.platform,
      catalogOnly: true,
      processLauncher: (_command, _args, options) => {
        const child = workerLaunch(process.execPath, ["-e", script], options);
        child.stderr.on("data", (chunk) => methods.push(...String(chunk).trim().split("\n")));
        return child;
      },
    });
    try {
      await server.start();
      expect(server.isAlive).toBe(true);
      expect(methods).toContain("initialize");
      expect(methods).not.toContain("thread/start");
    } finally {
      await server.kill();
    }
  });
});
