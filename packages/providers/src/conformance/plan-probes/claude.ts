import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import which from "which";
import { commandOutput, containedPath, installedSdkVersion, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

/** Capture SDK callbacks and native messages while denying implementation. */
export async function probeClaude(context: ProbeContext): Promise<ProbeEnd> {
  const cli = which.sync("claude");
  const version = await commandOutput(context, cli, ["--version"]);
  context.version({ cliVersion: version.split(" ")[0] ?? version, protocolVersion: "claude-sdk-unversioned", sdk: { name: "@anthropic-ai/claude-agent-sdk", version: installedSdkVersion("@anthropic-ai/claude-agent-sdk") } });
  // This CLI rejects plansDirectory outside cwd, including the sibling provider home.
  const options = { permissionMode: "plan", persistSession: false, plansDirectory: NodePath.join(context.fixtureRepo, ".claude/plans", NodePath.basename(context.providerHome)) };
  NodeFS.mkdirSync(options.plansDirectory, { recursive: true });
  const writtenPlans = new Map<string, string>();
  const settingsFile = NodePath.join(context.providerHome, "settings.json");
  NodeFS.writeFileSync(settingsFile, JSON.stringify({ plansDirectory: NodePath.relative(context.fixtureRepo, options.plansDirectory).replaceAll("\\", "/") }));
  const allowedWrite = (input: unknown): boolean => typeof input === "object" && input !== null && "file_path" in input && typeof input.file_path === "string" && containedPath(options.plansDirectory, input.file_path);
  context.record({ kind: "request", direction: "sent", operation: "sdk/query", exchange: "query", payload: options });
  const prompt = promptFor(context).replace(context.providerHome, options.plansDirectory);
  const stream = query({ prompt, options: {
    cwd: context.fixtureRepo, pathToClaudeCodeExecutable: cli, permissionMode: "plan", persistSession: false,
    settings: settingsFile,
    debugFile: NodePath.join(context.rawDirectory, "claude-debug.log"),
    tools: ["Read", "Write", "ExitPlanMode", "AskUserQuestion"],
    maxTurns: 6, env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
    spawnClaudeCodeProcess: (spawnOptions) => context.spawn(spawnOptions.command, spawnOptions.args, spawnOptions.env),
    canUseTool: async (toolName, input, invocation) => {
      context.record({ kind: "request", direction: "received", operation: "sdk/canUseTool", exchange: invocation.toolUseID, payload: { toolName, input } });
      if (toolName === "Write" && allowedWrite(input)) {
        const result = { behavior: "allow", updatedInput: input } satisfies { behavior: "allow"; updatedInput: typeof input };
        context.record({ kind: "reply", direction: "sent", operation: "sdk/canUseTool", exchange: invocation.toolUseID, payload: result });
        return result;
      }
      if (toolName === "ExitPlanMode") {
        const file = typeof input.planFilePath === "string" && containedPath(options.plansDirectory, input.planFilePath) && NodeFS.existsSync(input.planFilePath) ? input.planFilePath : null;
        context.record({ kind: "event", direction: "received", operation: "probe/exit-plan", payload: { hasPlan: typeof input.plan === "string", nonemptyPlan: typeof input.plan === "string" && input.plan.length > 0, matchesWrittenPlan: file !== null && input.plan === NodeFS.readFileSync(file, "utf8") } });
      }
      const result = { behavior: "deny", message: "Captured for research. Do not implement or retry. End the turn." } satisfies { behavior: "deny"; message: string };
      context.record({ kind: "reply", direction: "sent", operation: "sdk/canUseTool", exchange: invocation.toolUseID, payload: result });
      return result;
    },
    hooks: { PreToolUse: [{ hooks: [async (input) => {
      context.record({ kind: "event", direction: "received", operation: "sdk/preToolUse", payload: input });
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Write") return {};
      const allowed = allowedWrite(input.tool_input);
      if (allowed && typeof input.tool_input === "object" && input.tool_input !== null && "file_path" in input.tool_input && typeof input.tool_input.file_path === "string") writtenPlans.set(input.tool_input.file_path, input.session_id);
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
    for (const [path, sessionId] of writtenPlans) context.record({ kind: "event", direction: "received", operation: "probe/file", payload: { path, sessionId, exists: NodeFS.existsSync(path), insideRun: containedPath(options.plansDirectory, path) } });
    if (context.scenario === "fence") recordFence(context, text);
    return { kind: resultError ? "blocked" : "completed" };
  } finally { context.signal.removeEventListener("abort", abort); stream.close(); }
}
