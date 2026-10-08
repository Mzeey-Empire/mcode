import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { z } from "zod";
import { openRpc } from "./rpc.js";
import { commandOutput, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

const chunkSchema = z.object({ update: z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: z.object({ text: z.string() }) }) });
const sessionSchema = z.object({ sessionId: z.string(), models: z.object({ availableModels: z.array(z.object({ modelId: z.string() })) }) });

/** Run ACP with normal sign-in and deny implementation through client replies. */
export async function probeCursor(context: ProbeContext): Promise<ProbeEnd> {
  const directory = NodePath.join(NodeOS.homedir(), "AppData/Local/cursor-agent/versions");
  const versions = NodeFS.readdirSync(directory).filter((name) => /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/.test(name)).sort().reverse();
  const version = versions[0];
  if (!version) throw new Error("Cursor CLI not runnable in the permitted discovery directory");
  const cli = NodePath.join(directory, version);
  const env = { NODE_COMPILE_CACHE: NodePath.join(context.providerHome, "cache"), CURSOR_CONFIG_DIR: NodePath.join(context.providerHome, "config"), CURSOR_DATA_DIR: NodePath.join(context.providerHome, "data") };
  const child = context.spawn(NodePath.join(cli, "node.exe"), [NodePath.join(cli, "index.js"), "--help"], env);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Cursor help exited ${code}`))); });
  NodeFS.writeFileSync(NodePath.join(context.rawDirectory, "help.txt"), Buffer.concat(output));
  const exact = await commandOutput(context, NodePath.join(cli, "node.exe"), [NodePath.join(cli, "index.js"), "--version"]);
  context.version({ cliVersion: exact, protocolVersion: "acp-1", sdk: null });
  const rpc = openRpc(context, context.spawn(NodePath.join(cli, "node.exe"), [NodePath.join(cli, "index.js"), "acp"], env));
  let text = "";
  rpc.onEvent((method, params) => {
    const chunk = chunkSchema.safeParse(params);
    if (method === "session/update" && chunk.success) text += chunk.data.update.content.text;
  });
  rpc.onRequest(async (method, _params, id) => {
    if (method === "cursor/create_plan") rpc.reply(id, { outcome: { outcome: context.scenario === "plan-rejected" ? "rejected" : context.scenario === "plan-feedback" ? "feedback" : "cancelled", feedback: "Keep this plan for review. Do not implement." } });
    else if (method === "cursor/ask_question") rpc.reply(id, { outcome: { outcome: "skipped", reason: "Research probe; end the turn." } });
    else if (method === "session/request_permission") rpc.reply(id, { outcome: { outcome: "cancelled" } });
    else rpc.reply(id, { code: -32601, message: "Probe denied request" }, true);
  });
  await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "mcode-plan-probe", version: "1.0.0" } });
  const session = sessionSchema.parse(await rpc.request("session/new", { cwd: context.fixtureRepo, mcpServers: [] }));
  if (context.scenario === "questions") {
    const model = session.models.availableModels.find((entry) => entry.modelId.startsWith("composer-2.5["));
    if (!model) throw new Error("Cursor account catalog has no Composer 2.5 question-probe model");
    await rpc.request("session/set_model", { sessionId: session.sessionId, modelId: model.modelId });
  }
  await rpc.request("session/set_mode", { sessionId: session.sessionId, modeId: "plan" });
  await rpc.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: promptFor(context) }] });
  if (context.scenario === "fence") recordFence(context, text);
  return { kind: "completed" };
}
