import { describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { diag, parseDiagLine } from "@mcode/shared/diagnostics";
import { ClaudeOwnedProcess } from "../claude-process.js";
import { CanonicalLiveEventPublisher } from "../../canonical-live-event-publisher.js";
import { ProviderRuntimeEventSchema, providerRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";

describe("ClaudeOwnedProcess diagnostics", () => {
  it("holds the real SDK stdout pipe and drains all 20000 messages in order", async () => {
    const held = Promise.withResolvers<void>();
    let finishedWriting = false;
    let started = false;
    const indices: number[] = [];
    const route = { threadId: "test-thread", turnId: "turn", executionId: "00000000-0000-4000-8000-000000000001", deliveryAttempt: 1 };
    const publisher = new CanonicalLiveEventPublisher("claude", { submit: async (batch) => {
      await held.promise;
      for (const draft of batch.events) {
        if (draft.payload.type !== "item.recorded") throw new Error("Expected saved runtime event");
        const runtime = ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent);
        if (runtime.event.type === "textDelta") indices.push(Number(runtime.event.delta));
      }
      return { commit: { outcome: "accepted", acceptedThrough: 1, eventCount: 1,
        progressPosition: { epoch: route.executionId, sequence: 1 } }, delivery: { ingress: "not-required" } };
    } });
    let pulled = 0;
    const owned = new ClaudeOwnedProcess({ attach: () => undefined, terminateTree: async () => {} },
      "fake CLI", (chunk) => { started ||= chunk.includes("started"); finishedWriting ||= chunk.includes("finished"); },
      undefined, (signal) => publisher.waitForCapacity(route.threadId, signal));
    const script = `const {once}=require('node:events');
      process.stderr.write('started');
      const write=async()=>{ for(let i=0;i<20000;i++) {
        const line=JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:i,delta:{type:'text_delta',text:'x'.repeat(2048)}}})+'\\n';
        if(!process.stdout.write(line)) await once(process.stdout,'drain');
      } process.stderr.write('finished'); };
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line); if(m.type==='control_request') { process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}})+'\\n'); setImmediate(write); }
      });`;
    const sdk = query({ prompt: "test", options: { spawnClaudeCodeProcess: (options) => owned.spawn({ ...options,
      command: process.execPath, args: ["-e", script] }) } });
    const heapBefore = process.memoryUsage().heapUsed;
    const consuming = (async () => {
      for await (const message of sdk) {
        if (message.type !== "stream_event" || message.event.type !== "content_block_delta") continue;
        publisher.publish(route, providerRuntimeEvent({ type: "textDelta", threadId: route.threadId, delta: String(message.event.index) }), []);
        pulled++;
        await publisher.waitForCapacity(route.threadId);
        if (pulled === 20000) break;
      }
    })();
    try {
      await vi.waitFor(() => expect(started && pulled >= 256).toBe(true), { timeout: 10000 });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(finishedWriting).toBe(false);
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(32 * 1024 * 1024);
      held.resolve();
      await consuming;
      await publisher.waitForExecution(route);
      expect(indices).toEqual(Array.from({ length: 20000 }, (_, index) => index));
    } finally {
      held.resolve();
      sdk.close();
      await Promise.allSettled([consuming]);
      await owned.retire();
    }
  }, 20000);
  it.each(["process-thread", undefined])("records the owned lifetime only with a thread id (%s)", async (threadId) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-process-"));
    diag.configure({ dir, enabled: true });
    let child: SpawnedProcess | undefined;
    const owned = new ClaudeOwnedProcess({
      attach: () => undefined,
      terminateTree: async () => {
        if (!child) throw new Error("Expected captured process");
        const exited = NodeEvents.once(child, "exit");
        child.stdin.end();
        await exited;
      },
    }, "test process", () => undefined, threadId);
    try {
      child = owned.spawn({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        cwd: process.cwd(),
        env: process.env,
      });
      const pid = child.pid;
      expect(typeof pid).toBe("number");
      await owned.retire();
      diag.flushSync();
      const files = NodeFS.readdirSync(dir, { recursive: true }).filter((file) => typeof file === "string" && file.endsWith(".jsonl"));
      const rows = files.flatMap((file) => NodeFS.readFileSync(NodePath.join(dir, String(file)), "utf8")
        .split("\n").flatMap((line) => parseDiagLine(line) ?? []))
        .filter((row) => row.ch === "claude.process");
      expect(rows.map((row) => ({ th: row.th, d: row.d }))).toEqual(threadId ? [
        { th: "process-thread", d: { step: "spawned", pid } },
        { th: "process-thread", d: { step: "terminating", pid } },
        { th: "process-thread", d: { step: "exited", pid, code: 0, signal: null } },
        { th: "process-thread", d: { step: "terminated", pid, ok: true } },
      ] : []);
    } finally {
      await owned.retire();
      diag.configure({ enabled: false });
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
