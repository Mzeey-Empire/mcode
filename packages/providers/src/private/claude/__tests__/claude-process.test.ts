import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { diag, parseDiagLine } from "@mcode/shared/diagnostics";
import { ClaudeOwnedProcess } from "../claude-process.js";

describe("ClaudeOwnedProcess diagnostics", () => {
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
