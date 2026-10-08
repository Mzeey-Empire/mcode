import * as NodePath from "node:path";
import which from "which";
import { z } from "zod";
import { openRpc } from "./rpc.js";
import { commandOutput, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

const sessionSchema = z.object({ sessionId: z.string() });
const chunkSchema = z.object({ update: z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: z.object({ text: z.string() }) }) });

/** ACP mode changes are captured separately from what the model subsequently does. */
export async function probeDevin(context: ProbeContext): Promise<ProbeEnd> {
  const cli = which.sync("devin");
  const version = await commandOutput(context, cli, ["--version"]);
  context.version({ cliVersion: version.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown", protocolVersion: "acp-1", sdk: null });
  const rpc = openRpc(context, context.spawn(cli, ["acp"], { XDG_DATA_HOME: NodePath.join(context.providerHome, "data"), XDG_STATE_HOME: NodePath.join(context.providerHome, "state"), XDG_CACHE_HOME: NodePath.join(context.providerHome, "cache") }));
  let text = "";
  rpc.onEvent((method, params) => {
    if (method !== "session/update") return;
    const chunk = chunkSchema.safeParse(params);
    if (chunk.success) text += chunk.data.update.content.text;
  });
  await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "mcode-plan-probe", version: "1.0.0" } });
  const session = sessionSchema.parse(await rpc.request("session/new", { cwd: context.fixtureRepo, mcpServers: [] }));
  rpc.onRequest(async (method, _params, id) => { if (method === "session/request_permission") rpc.reply(id, { outcome: { outcome: "cancelled" } }); else rpc.reply(id, { code: -32601, message: "Probe denied request" }, true); });
  await rpc.request("session/set_config_option", { sessionId: session.sessionId, configId: "mode", value: "plan" });
  await rpc.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: promptFor(context) }] });
  if (context.scenario === "fence") recordFence(context, text);
  return { kind: "completed" };
}
