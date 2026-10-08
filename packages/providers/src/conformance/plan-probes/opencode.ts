import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import which from "which";
import * as NodeReadline from "node:readline";
import { z } from "zod";
import { commandOutput, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

const idSchema = z.object({ id: z.string() });
const messagesSchema = z.array(z.object({ info: z.object({ role: z.string() }), parts: z.array(z.object({ type: z.string(), text: z.string().optional() })) }));
const eventSchema = z.object({ type: z.string(), properties: z.object({ sessionID: z.string().optional() }).passthrough() });
const questionSchema = z.object({ id: z.string(), questions: z.array(z.object({ options: z.array(z.object({ label: z.string() })) })) });

/** Preserve normal credentials; do not relocate the auth-containing data home. */
export async function probeOpencode(context: ProbeContext): Promise<ProbeEnd> {
  const shim = which.sync("opencode");
  const cli = NodePath.join(NodePath.dirname(shim), "node_modules/opencode-ai/bin/opencode.exe");
  const version = await commandOutput(context, cli, ["--version"]);
  context.version({ cliVersion: version, protocolVersion: "opencode-http-unversioned", sdk: null });
  const help = await commandOutput(context, cli, ["serve", "--help"]);
  NodeFS.writeFileSync(NodePath.join(context.rawDirectory, "help.txt"), help);
  const child = context.spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  const base = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`OpenCode server exited ${code}`)));
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      NodeFS.appendFileSync(NodePath.join(context.rawDirectory, "stdout.log"), `${line}\n`);
      const address = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) resolve(address);
    });
  });
  let sequence = 0;
  async function request(operation: string, path: string, body?: unknown): Promise<unknown> {
    const exchange = ++sequence;
    context.record({ kind: "request", direction: "sent", operation, exchange, payload: body ?? {} });
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": context.fixtureRepo }, body: body === undefined ? undefined : JSON.stringify(body), signal: context.signal });
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : null;
    context.record({ kind: "reply", direction: "received", operation, exchange, payload: { status: response.status, data } });
    if (!response.ok) throw new Error(`OpenCode ${operation} returned ${response.status}`);
    return data;
  }
  await request("http/health", "/global/health");
  const session = idSchema.parse(await request("http/session.create", "/session", {}));
  const events = await fetch(`${base}/event`, { headers: { "x-opencode-directory": context.fixtureRepo }, signal: context.signal });
  if (!events.ok || !events.body) throw new Error("OpenCode event stream unavailable");
  const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
  context.onCleanup(async () => {
    try { await reader.cancel(); }
    catch (error) { if (!(error instanceof Error && error.name === "AbortError" && context.signal.aborted)) throw error; }
  });
  const consume = consumeEvents(context, reader, session.id, request);
  await request("http/prompt_async", `/session/${session.id}/prompt_async`, { agent: "plan", parts: [{ type: "text", text: promptFor(context) }] });
  await consume;
  const messages = await request("http/session.messages", `/session/${session.id}/message`);
  if (context.scenario === "fence") {
    const parsed = messagesSchema.parse(messages);
    recordFence(context, parsed.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "")).join(""));
  }
  return { kind: "completed" };
}

function parseEventBlock(block: string): z.infer<typeof eventSchema> | null {
  const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  return data ? eventSchema.parse(JSON.parse(data)) : null;
}

async function consumeEvents(context: ProbeContext, reader: ReadableStreamDefaultReader<string>, sessionId: string, request: (operation: string, path: string, body?: unknown) => Promise<unknown>): Promise<void> {
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("OpenCode event stream ended before session idle");
    buffer += chunk.value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseEventBlock(block);
      if (!event) continue;
      context.record({ kind: "event", direction: "received", operation: "http/event", payload: event });
      if (event.properties.sessionID !== sessionId) continue;
      if (event.type === "question.asked") {
        const question = questionSchema.parse(event.properties);
        await request("http/question.reply", `/question/${question.id}/reply`, { answers: question.questions.map((item) => [item.options[0]?.label ?? "Brief"]) });
      }
      if (event.type === "permission.asked") {
        const permission = idSchema.parse(event.properties);
        await request("http/permission.reply", `/permission/${permission.id}/reply`, { reply: "reject" });
      }
      if (event.type === "session.error") throw new Error("OpenCode session error; inspect raw event");
      if (event.type === "session.idle") return;
    }
  }
}
