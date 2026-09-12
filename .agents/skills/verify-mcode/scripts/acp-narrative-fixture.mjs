#!/usr/bin/env node
/**
 * Controlled ACP agent fixture for narrative-ordering desktop verification.
 * Stands in for `cursor-agent acp` (or `devin acp`) so the production adapter,
 * server pipeline, and renderer see a deterministic thought/tool sequence.
 */
import * as NodeReadline from "node:readline";

export const FIXTURE_VERSION = "99.0.0";
export const FIXTURE_SESSION_ID = "fixture-acp-session";
export const FIXTURE_ASSISTANT_TEXT = "ACP fixture turn complete.";
export const FIXTURE_THOUGHT_TEXTS = Object.freeze([
  "Considering the request.",
  "Planning three tool calls before the final answer.",
]);
export const FIXTURE_MODELS_OUTPUT = `Available models

fixture-model - Fixture Model (current, default)
`;
export const UPDATE_INTERVAL_MS = 120;

/**
 * The deterministic narrative sequence: two reasoning chunks, three lifecycle
 * markers in invocation order, one mid-stream input merge, one data-less
 * progress update, then completions out of invocation order (search, bash,
 * read). Read input arrives only on its terminal update.
 */
export function fixtureTurnUpdates(sessionId = FIXTURE_SESSION_ID) {
  const update = (body) => ({ method: "session/update", params: { sessionId, update: body } });
  return [
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: FIXTURE_THOUGHT_TEXTS[0] } }),
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: FIXTURE_THOUGHT_TEXTS[1] } }),
    update({ sessionUpdate: "tool_call", toolCallId: "fx-read", title: "Read File", kind: "read", status: "in_progress" }),
    update({ sessionUpdate: "tool_call", toolCallId: "fx-search", title: "Search", kind: "search", status: "in_progress" }),
    update({ sessionUpdate: "tool_call", toolCallId: "fx-bash", title: "Terminal", kind: "execute", status: "in_progress" }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "fx-search", status: "in_progress", rawInput: { pattern: "fixture-needle" } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "fx-read", status: "in_progress" }),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working through the checks. " } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "fx-search", status: "completed", rawOutput: { content: "2 matches" } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "fx-bash", status: "completed", rawInput: { command: "bun --version" }, rawOutput: { output: "bun 1.3.0" } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "fx-read", status: "completed", rawOutput: { path: "src/fixture.ts", content: "export const ok = true;" } }),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: FIXTURE_ASSISTANT_TEXT } }),
  ];
}

/** Parses the small CLI contract used by the generated Windows wrapper. */
export function parseFixtureArguments(argv) {
  if (argv.length === 1 && ["--version", "version"].includes(argv[0])) return { command: "version" };
  if (argv[0] === "models") return { command: "models" };
  if (argv[0] === "about") return { command: "about" };
  if (argv[0] === "acp") return { command: "acp" };
  throw new Error("Usage: acp-narrative-fixture.mjs <acp ...|models|about --format json|--version>");
}

/** Runs the narrow ACP JSON-RPC surface that the production adapters need. */
export function runFixtureAgent({ input = process.stdin, output = process.stdout, intervalMs = UPDATE_INTERVAL_MS } = {}) {
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || typeof message.method !== "string") return;
    if (message.id === undefined) return; // client notifications need no response
    handleRequest(message, respond, notify, intervalMs);
  });
}

function handleRequest(message, respond, notify, intervalMs) {
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: typeof params?.protocolVersion === "number" ? params.protocolVersion : 1,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    });
    return;
  }
  if (method === "session/new") {
    respond(id, { sessionId: FIXTURE_SESSION_ID });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : FIXTURE_SESSION_ID;
    emitTurnSequence(sessionId, notify, intervalMs).then(() => respond(id, { stopReason: "end_turn" }));
    return;
  }
  // authenticate, session/set_config_option, unstable_setSessionModel, and
  // other configuration calls succeed with an empty result.
  respond(id, {});
}

async function emitTurnSequence(sessionId, notify, intervalMs) {
  for (const entry of fixtureTurnUpdates(sessionId)) {
    notify(entry.method, entry.params);
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function main() {
  const parsed = parseFixtureArguments(process.argv.slice(2));
  if (parsed.command === "version") {
    process.stdout.write(`${FIXTURE_VERSION}\n`);
    return;
  }
  if (parsed.command === "models") {
    process.stdout.write(FIXTURE_MODELS_OUTPUT);
    return;
  }
  if (parsed.command === "about") {
    process.stdout.write(`${JSON.stringify({ email: "acp-fixture@example.com" })}\n`);
    return;
  }
  runFixtureAgent();
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
