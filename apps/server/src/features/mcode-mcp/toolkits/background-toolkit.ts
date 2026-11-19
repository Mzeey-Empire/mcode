import { z } from "zod";
import { ToolCallStatusSchema } from "@mcode/contracts/models/tool-call-record";
import type { BackgroundCommandStore } from "../../agents/background/background-command-store.js";
import type { McodeSession } from "../mcode-session-authority.js";
import { defineToolkit, type McodeToolkit } from "../mcode-toolkit.js";
import { listedSchema, parseInput, structuredResult, toToolResult } from "./thread-control-toolkit.js";

const inputSchema = z.object({
  taskIds: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
  waiting: z.boolean().default(true),
}).strict();

const outputSchema = z.object({
  matched: z.array(z.object({ taskId: z.string(), label: z.string(), status: ToolCallStatusSchema, awaited: z.boolean() })),
  unmatched: z.array(z.string()),
});

const DESCRIPTION = [
  "Tell Mcode which background commands you are waiting for, so the Thread shows Waiting instead of Finished until they end.",
  "Pass the background task ids your shell tool returned. Mark work whose result you need: a build, a test run, a migration.",
  "Do not mark a process you leave running, such as a dev server or a file watcher: it never ends, so the Thread would never finish.",
  "waiting: false clears the mark. Marking does not block, stop, or time out a command. Settled commands are reported with their status.",
].join("\n");

/** Providers whose shell launches expose native background command ids. */
export function providerReportsBackgroundCommands(providerId: string): boolean {
  return providerId === "claude" || providerId === "codex";
}

/** Offer wait marks scoped to the authenticated provider session's thread. */
export function createBackgroundToolkit(
  commands: Pick<BackgroundCommandStore, "resolve" | "setAwaited">,
  waitForSaved: (threadId: string) => Promise<void>,
): McodeToolkit {
  return defineToolkit<McodeSession>({
    name: "background",
    grant: (session) => providerReportsBackgroundCommands(session.providerId) ? session : null,
    tools: [{
      name: "background_wait",
      description: DESCRIPTION,
      inputSchema: listedSchema(inputSchema, "input") ?? { type: "object", properties: {} },
      outputSchema: listedSchema(outputSchema, "output"),
      call: (args, { threadId }, { signal }) => toToolResult(async () => {
        const { taskIds, waiting } = await parseInput("background_wait", inputSchema, args);
        // The agent can call this before its shell launch has drained to SQLite.
        await waitForSaved(threadId);
        signal.throwIfAborted();
        const { matched } = commands.resolve(threadId, taskIds);
        await commands.setAwaited(threadId, matched.filter(({ status }) => status === "running").map(({ toolCallId }) => toolCallId), waiting);
        const updated = commands.resolve(threadId, taskIds);
        return structuredResult(outputSchema.parse({
          matched: updated.matched.map(({ taskId, toolCallId, label, status, awaited }) => ({ taskId: taskId ?? toolCallId, label, status, awaited })),
          unmatched: updated.unmatched,
        }));
      }),
    }],
  });
}
