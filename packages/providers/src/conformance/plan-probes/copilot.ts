import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { CopilotClient } from "@github/copilot-sdk";
import which from "which";
import { commandOutput, installedSdkVersion, promptFor, recordFence, type ProbeContext, type ProbeEnd } from "./runtime.js";

/** SDK-level exchanges use probe correlation ids around the actual promise or callback. */
export async function probeCopilot(context: ProbeContext): Promise<ProbeEnd> {
  const shim = which.sync("copilot");
  const cli = NodePath.join(NodePath.dirname(shim), "node_modules/@github/copilot/npm-loader.js");
  const version = await commandOutput(context, "node", [cli, "--version"]);
  context.version({ cliVersion: version.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown", protocolVersion: "copilot-sdk-unversioned", sdk: { name: "@github/copilot-sdk", version: installedSdkVersion("@github/copilot-sdk") } });
  const client = new CopilotClient({ cliPath: cli, cwd: context.fixtureRepo, cliArgs: ["--no-auto-update", "--disable-builtin-mcps", "--log-dir", NodePath.join(context.providerHome, "logs")] });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.stop().then((errors) => { if (errors.length) throw new AggregateError(errors, "SDK cleanup failed"); });
  const abort = () => { void close(); };
  context.onCleanup(close);
  context.signal.addEventListener("abort", abort, { once: true });
  let callback = 0;
  try {
    await client.start();
    context.record({ kind: "request", direction: "sent", operation: "sdk/status", exchange: "status", payload: {} });
    const status = await client.getStatus();
    context.record({ kind: "reply", direction: "received", operation: "sdk/status", exchange: "status", payload: status });
    context.version({ cliVersion: status.version, protocolVersion: `copilot-rpc-${status.protocolVersion}`, sdk: { name: "@github/copilot-sdk", version: installedSdkVersion("@github/copilot-sdk") } });
    context.record({ kind: "request", direction: "sent", operation: "sdk/session.create", exchange: "create", payload: { configDir: context.providerHome, workingDirectory: context.fixtureRepo } });
    const session = await client.createSession({
      configDir: context.providerHome, workingDirectory: context.fixtureRepo, model: "gpt-5-mini", streaming: true,
      onPermissionRequest: (request, invocation) => {
        const exchange = `permission-${++callback}`;
        context.record({ kind: "request", direction: "received", operation: "sdk/permission", exchange, payload: { ...request, sessionId: invocation.sessionId } });
        const path = request.fileName;
        const allowed = request.kind === "read" || (request.kind === "write" && typeof path === "string" && context.mayWrite(path));
        const result = allowed ? { kind: "approved" } satisfies { kind: "approved" } : { kind: "denied-interactively-by-user" } satisfies { kind: "denied-interactively-by-user" };
        context.record({ kind: "reply", direction: "sent", operation: "sdk/permission", exchange, payload: result });
        return result;
      },
      onUserInputRequest: (request, invocation) => {
        const exchange = `question-${++callback}`;
        context.record({ kind: "request", direction: "received", operation: "sdk/question", exchange, payload: { ...request, sessionId: invocation.sessionId } });
        const result = { answer: "Brief", wasFreeform: true };
        context.record({ kind: "reply", direction: "sent", operation: "sdk/question", exchange, payload: result });
        return result;
      },
    });
    context.record({ kind: "reply", direction: "received", operation: "sdk/session.create", exchange: "create", payload: { sessionId: session.sessionId } });
    session.on((event) => context.record({ kind: "event", direction: "received", operation: "sdk/event", payload: event }));
    context.record({ kind: "request", direction: "sent", operation: "sdk/mode.set", exchange: "mode", payload: { mode: "plan" } });
    const mode = await session.rpc.mode.set({ mode: "plan" });
    context.record({ kind: "reply", direction: "received", operation: "sdk/mode.set", exchange: "mode", payload: mode });
    const response = await session.sendAndWait({ prompt: promptFor(context) }, 110000);
    context.record({ kind: "request", direction: "sent", operation: "sdk/plan.read", exchange: "read", payload: { sessionId: session.sessionId } });
    const plan = await session.rpc.plan.read();
    context.record({ kind: "reply", direction: "received", operation: "sdk/plan.read", exchange: "read", payload: { ...plan, sessionId: session.sessionId } });
    if (plan.path && NodeFS.existsSync(plan.path)) context.record({ kind: "event", direction: "received", operation: "probe/file", payload: { path: plan.path, sessionId: session.sessionId, exists: true, insideRun: context.mayWrite(plan.path), sessionDirectoryMatches: NodePath.basename(NodePath.dirname(plan.path)) === session.sessionId } });
    if (context.scenario === "fence") recordFence(context, response?.data.content ?? "");
    return { kind: "completed" };
  } finally { context.signal.removeEventListener("abort", abort); await close(); }
}
