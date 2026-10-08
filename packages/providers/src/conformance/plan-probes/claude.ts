import * as NodePath from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import which from "which";
import { commandOutput, installedSdkVersion, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

/** Capture SDK callbacks and native messages while denying implementation. */
export async function probeClaude(context: ProbeContext): Promise<ProbeEnd> {
  const cli = which.sync("claude");
  const version = await commandOutput(context, cli, ["--version"]);
  context.version({ cliVersion: version.split(" ")[0] ?? version, protocolVersion: "claude-sdk-unversioned", sdk: { name: "@anthropic-ai/claude-agent-sdk", version: installedSdkVersion("@anthropic-ai/claude-agent-sdk") } });
  const options = { permissionMode: "plan", persistSession: false, plansDirectory: NodePath.join(context.providerHome, "plans") };
  context.record({ kind: "request", direction: "sent", operation: "sdk/query", exchange: "query", payload: options });
  const stream = query({ prompt: promptFor(context), options: {
    cwd: context.fixtureRepo, pathToClaudeCodeExecutable: cli, permissionMode: "plan", persistSession: false,
    settingSources: [], settings: { plansDirectory: options.plansDirectory },
    tools: ["Read", "Write", "ExitPlanMode", "AskUserQuestion"],
    maxTurns: 6, env: { ...process.env, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_SAFE_MODE: "1" },
    canUseTool: async (toolName, input, invocation) => {
      context.record({ kind: "request", direction: "received", operation: "sdk/canUseTool", exchange: invocation.toolUseID, payload: { toolName, input } });
      if (toolName === "ExitPlanMode") context.record({ kind: "event", direction: "received", operation: "probe/exit-plan", payload: { hasPlan: typeof input.plan === "string", nonemptyPlan: typeof input.plan === "string" && input.plan.length > 0 } });
      const result = { behavior: "deny", message: "Captured for research. Do not implement or retry. End the turn." } satisfies { behavior: "deny"; message: string };
      context.record({ kind: "reply", direction: "sent", operation: "sdk/canUseTool", exchange: invocation.toolUseID, payload: result });
      return result;
    },
    hooks: { PreToolUse: [{ hooks: [async (input) => {
      context.record({ kind: "event", direction: "received", operation: "sdk/preToolUse", payload: input });
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Write") return {};
      const target = input.tool_input;
      const allowed = typeof target === "object" && target !== null && "file_path" in target && typeof target.file_path === "string" && context.mayWrite(target.file_path);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "deny", permissionDecisionReason: "Probe plan-directory boundary" } };
    }] }] },
  } });
  const abort = () => stream.close();
  context.onCleanup(async () => { stream.close(); });
  context.signal.addEventListener("abort", abort, { once: true });
  let text = "";
  let resultError = false;
  try {
    for await (const message of stream) {
      context.record({ kind: "event", direction: "received", operation: "sdk/message", payload: message });
      if (message.type === "assistant") text += message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
      if (message.type === "result") resultError = message.is_error;
    }
    context.record({ kind: "reply", direction: "received", operation: "sdk/query", exchange: "query", payload: { completed: !resultError } });
    if (context.scenario === "fence") recordFence(context, text);
    return { kind: resultError ? "blocked" : "completed" };
  } finally { context.signal.removeEventListener("abort", abort); stream.close(); }
}
