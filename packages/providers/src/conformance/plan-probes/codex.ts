import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import which from "which";
import { z } from "zod";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { openRpc } from "./rpc.js";
import { commandOutput, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

const threadSchema = z.object({ thread: z.object({ id: z.string() }) });
const modelsSchema = z.object({ data: z.array(z.object({ model: z.string(), isDefault: z.boolean() })) });
const turnSchema = z.object({ turn: z.object({ id: z.string() }) });
const questionSchema = z.object({ threadId: z.string(), turnId: z.string(), questions: z.array(z.object({ id: z.string(), options: z.array(z.object({ label: z.string() })).nullable().optional() })) });
const completedSchema = z.object({ turn: z.object({ status: z.string(), items: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional() }) });
const itemSchema = z.object({ item: z.object({ type: z.enum(["plan", "agentMessage"]), text: z.string() }) });

/** Drive the installed app-server without persisting a thread or changing global config. */
export async function probeCodex(context: ProbeContext): Promise<ProbeEnd> {
  const shim = which.sync("codex");
  const wrapper = NodePath.join(NodePath.dirname(shim), "node_modules/@openai/codex/bin/codex.js");
  const command = hostRuntime.platform === "win32" ? NodePath.join(NodePath.dirname(NodeModule.createRequire(wrapper).resolve("@openai/codex-win32-x64/package.json")), "vendor/x86_64-pc-windows-msvc/bin/codex.exe") : shim;
  const version = await commandOutput(context, command, ["--version"]);
  context.version({ cliVersion: version.replace(/^codex-cli /, ""), protocolVersion: "app-server-unversioned", sdk: null });
  const state = context.providerHome.replaceAll("\\", "/");
  const rpc = openRpc(context, context.spawn(command, ["app-server", "--stdio", "-c", `log_dir="${state}/logs"`, "-c", "web_search=\"disabled\""], { RUST_LOG: "info" }));
  await rpc.request("initialize", { clientInfo: { name: "mcode-plan-probe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {});
  const models = modelsSchema.parse(await rpc.request("model/list", {}));
  const model = models.data.find((entry) => entry.isDefault)?.model;
  if (!model) throw new Error("Account model catalog has no default model");
  const thread = threadSchema.parse(await rpc.request("thread/start", { cwd: context.fixtureRepo, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", model, config: { windows: { sandbox: "unelevated" } } }));
  let questionSeen = false;
  let processExit = false;
  let text = "";
  rpc.onEvent((method, params) => {
    if (method !== "item/completed") return;
    const item = itemSchema.safeParse(params);
    if (item.success) text += item.data.item.text;
  });
  rpc.onRequest(async (method, params, id) => {
    if (method !== "item/tool/requestUserInput") { rpc.reply(id, { code: -32601, message: "Probe denied request" }, true); return; }
    questionSeen = true;
    const question = questionSchema.parse(params);
    if (context.scenario === "questions-process-exit") { processExit = true; rpc.child.kill(); return; }
    if (context.scenario === "questions-interrupt") { await rpc.request("turn/interrupt", { threadId: question.threadId, turnId: question.turnId }); return; }
    if (context.scenario === "questions-cancel") { rpc.reply(id, { code: -32800, message: "Probe cancelled" }, true); return; }
    const answers = Object.fromEntries(question.questions.map((item) => [item.id, { answers: context.scenario === "questions-decline" ? [] : [context.scenario === "questions-free-text" ? "Use a cheerful greeting." : item.options?.[0]?.label ?? "Brief"] }]));
    rpc.reply(id, { answers });
  });
  const result = await rpc.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: promptFor(context), text_elements: [] }], collaborationMode: { mode: "plan", settings: { model, reasoning_effort: "low", developer_instructions: null } }, additionalContext: {} });
  turnSchema.parse(result);
  let completed: z.infer<typeof completedSchema>;
  try { completed = completedSchema.parse(await rpc.event("turn/completed")); }
  catch (error) {
    if (processExit) return { kind: "process-exit", code: rpc.child.exitCode, signal: rpc.child.signalCode };
    throw error;
  }
  if (context.scenario === "fence") recordFence(context, text);
  context.record({ kind: "event", direction: "received", operation: "probe/questions", payload: { observed: questionSeen } });
  return { kind: completed.turn.status === "interrupted" ? "interrupted" : "completed" };
}
