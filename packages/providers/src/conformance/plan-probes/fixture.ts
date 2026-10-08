import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { z } from "zod";
import { providerFixtureSourceHash } from "../fixture-safety.js";
import { containedPath, providerSchema, scenarioSchema } from "./runtime.js";

type Rule = { at: string; kind: "shape" | "identity" | "path" | "literal"; values?: readonly (string | boolean | number | null)[] };
const shape = (...paths: string[]): Rule[] => paths.map((at) => ({ at, kind: "shape" }));
const identity = (...paths: string[]): Rule[] => paths.map((at) => ({ at, kind: "identity" }));
const literal = (at: string, ...values: NonNullable<Rule["values"]>): Rule => ({ at, kind: "literal", values });
const bool = (...paths: string[]): Rule[] => paths.map((at) => literal(at, true, false));
const pathRule = (at: string): Rule => ({ at, kind: "path" });
const retainedCopilotEvents = ["assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete", "session.mode_changed", "session.idle", "user_input.requested", "user_input.completed", "permission.requested", "permission.completed"];
const omittedCopilotEvents = new Set(["assistant.idle", "assistant.intent", "assistant.message_start", "assistant.reasoning", "assistant.reasoning_delta", "assistant.streaming_delta", "assistant.tool_call_delta", "assistant.turn_end", "assistant.turn_start", "assistant.usage", "model.call_finished", "model.call_start", "model.captured_assignment_context", "model.message", "model.messages_snapshot", "model.model_call_started", "model.model_call_success", "model.response", "model.tool_execution", "model.turn_ended", "model.turn_started", "pending_messages.modified", "session.info", "session.managed_settings_resolved", "session.mcp_server_status_changed", "session.mcp_servers_loaded", "session.shutdown", "session.start", "session.title_changed", "session.todos_changed", "session.tools_updated", "session.usage_checkpoint", "session.usage_info", "system.message", "user.message", "prompt_cache_break", "hook.end", "hook.start", "session.skills_loaded"]);
const planItem = [literal("item.type", "plan", "agentMessage", "reasoning", "userMessage", "commandExecution", "mcpToolCall"), ...shape("item.text", "item.content", "item.summary"), ...identity("item.id", "threadId", "turnId")];
const common: Record<string, Rule[]> = {
  "probe/fence": bool("exact", "openerExact", "nestedFenceIntact", "closerExact"),
  "probe/questions": bool("observed"),
  "probe/process-exit": [...shape("code", "signal")],
  "probe/file": [pathRule("path"), ...identity("sessionId"), ...bool("exists", "insideRun", "sessionDirectoryMatches")],
};
const acp: Record<string, Rule[]> = {
  initialize: [...shape("clientCapabilities", "agentCapabilities", "authMethods"), literal("protocolVersion", 1), ...shape("agentInfo.version")],
  "session/new": [...identity("sessionId"), ...shape("configOptions", "modes", "models")],
  "session/set_config_option": [...identity("sessionId"), literal("configId", "mode"), literal("value", "plan"), ...shape("configOptions"), literal("configOptions.0.id", "mode"), literal("configOptions.0.currentValue", "plan")],
  "session/prompt": [...identity("sessionId"), ...shape("prompt.[].text"), literal("stopReason", "end_turn", "cancelled", "max_tokens", "refusal")],
  "session/update": [...identity("sessionId", "update.toolCallId"), literal("update.sessionUpdate", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "current_mode_update", "config_option_update", "usage_update", "available_commands_update", "session_info_update"), ...shape("update.content", "update.content.text", "update.rawInput", "update.rawOutput", "update.title", "update.entries"), literal("update.status", "pending", "in_progress", "completed", "failed")],
  "session/request_permission": [...identity("sessionId", "toolCall.toolCallId"), ...shape("toolCall", "options"), literal("outcome.outcome", "cancelled", "selected")],
  "_cognition.ai/mcp/serversChanged": [], "_cognition.ai/output": [], "_cognition.ai/thinking_complete": [], "_cognition.ai/agent_stopped": [], "_cognition.ai/turn_stats": [],
};
const rules: Record<z.infer<typeof providerSchema>, Record<string, Rule[]>> = {
  codex: {
    "model/list": [...shape("data.[].model"), ...bool("data.[].isDefault")],
    "account/updated": [], "mcpServer/startupStatus/updated": [], "remoteControl/status/changed": [], "thread/settings/updated": [], warning: [],
    "serverRequest/resolved": [...identity("threadId", "requestId")],
    initialize: [...shape("capabilities.experimentalApi", "userAgent", "platformFamily", "platformOs")], initialized: [],
    "thread/start": [...shape("cwd", "config", "thread", "sandbox"), ...bool("ephemeral"), literal("sandbox.type", "readOnly"), literal("approvalPolicy", "never"), ...identity("thread.id")],
    "thread/started": identity("thread.id"),
    "turn/start": [...identity("threadId", "turn.id"), ...shape("input.[].text", "collaborationMode", "collaborationMode.settings", "collaborationMode.settings.model", "additionalContext"), literal("collaborationMode.mode", "plan", "default"), literal("collaborationMode.settings.developer_instructions", null), literal("collaborationMode.settings.reasoning_effort", "low"), literal("turn.status", "inProgress", "completed")],
    "turn/started": [...identity("threadId", "turn.id"), literal("turn.status", "inProgress")],
    "turn/completed": [...identity("threadId", "turn.id"), literal("turn.status", "completed", "interrupted", "failed"), ...shape("turn.error", "turn.items")],
    "turn/interrupt": identity("threadId", "turnId"),
    "item/started": planItem, "item/completed": planItem,
    "item/plan/delta": [...identity("threadId", "turnId", "itemId"), ...shape("delta")],
    "item/agentMessage/delta": [...identity("threadId", "turnId", "itemId"), ...shape("delta")],
    "item/reasoning/summaryTextDelta": shape("delta"), "item/reasoning/summaryPartAdded": [],
    "thread/tokenUsage/updated": [], "thread/status/changed": [], "account/rateLimits/updated": [],
    "item/tool/requestUserInput": [...identity("threadId", "turnId", "itemId", "questions.[].id"), ...shape("questions", "questions.[].header", "questions.[].question", "questions.[].options", "questions.[].options.[].label", "questions.[].options.[].description", "answers", "answers.{}.answers", "answers.{}.answers.[]", "error"), literal("error.code", -32800), ...bool("questions.[].isOther", "questions.[].isSecret", "isBlocking")],
    error: [...shape("message", "codexErrorInfo"), ...bool("willRetry")],
  },
  claude: {
    "sdk/query": [literal("permissionMode", "plan"), ...bool("persistSession", "completed"), pathRule("plansDirectory")],
    "sdk/message": [literal("type", "system", "assistant", "user", "result", "stream_event", "tool_progress", "tool_use_summary", "rate_limit_event"), ...shape("subtype", "message.content.[].text", "message.content.[].input", "result"), ...identity("session_id", "message.content.[].id"), literal("message.content.[].type", "text", "tool_use", "tool_result", "thinking"), literal("message.content.[].name", "ExitPlanMode", "AskUserQuestion", "Read", "Write"), ...shape("message.content.[].input.plan"), pathRule("message.content.[].input.file_path"), ...bool("is_error")],
    "sdk/preToolUse": [literal("tool_name", "Write", "Read", "ExitPlanMode", "AskUserQuestion"), ...identity("session_id", "tool_use_id"), pathRule("tool_input.file_path"), ...shape("tool_input.plan", "tool_input.questions", "tool_input.content")],
    "sdk/canUseTool": [literal("toolName", "Write", "Read", "ExitPlanMode", "AskUserQuestion"), ...shape("input.plan", "input.questions", "input.questions.[].question", "input.questions.[].options", "message"), literal("behavior", "deny", "allow"), pathRule("input.file_path"), pathRule("input.planFilePath")],
    "probe/exit-plan": bool("hasPlan", "nonemptyPlan", "matchesWrittenPlan"),
  },
  copilot: {
    "sdk/status": [...shape("version"), literal("protocolVersion", 3)],
    "sdk/session.create": [pathRule("configDir"), pathRule("workingDirectory"), ...identity("sessionId")],
    "sdk/mode.set": [literal("mode", "plan")],
    "sdk/permission": [literal("kind", "read", "write", "shell", "mcp", "url", "custom-tool", "approved", "denied-interactively-by-user"), ...identity("sessionId", "toolCallId"), pathRule("path"), pathRule("fileName"), ...shape("intention")],
    "sdk/question": [...identity("sessionId"), ...shape("question", "choices", "answer"), ...bool("allowFreeform", "wasFreeform")],
    "sdk/event": [literal("type", ...retainedCopilotEvents), ...shape("data.content", "data.deltaContent", "data.arguments", "data.result"), ...identity("data.toolCallId"), literal("data.newMode", "plan"), literal("data.previousMode", "interactive"), literal("data.toolName", "create", "edit", "view", "ask_user", "report_intent", "update_plan", "write_plan", "sql")],
    "sdk/plan.read": [...identity("sessionId"), ...bool("exists"), ...shape("content"), pathRule("path")],
  },
  devin: acp,
  cursor: {
    ...acp,
    "session/set_mode": [...identity("sessionId"), literal("modeId", "plan")],
    "session/set_model": [...identity("sessionId"), ...shape("modelId")],
    "cursor/create_plan": [...identity("toolCallId"), ...shape("plan", "markdown", "name", "overview", "todos", "phases", "outcome.feedback"), pathRule("path"), pathRule("planPath"), literal("outcome.outcome", "cancelled", "rejected", "feedback")],
    "cursor/ask_question": [...identity("toolCallId", "questions.[].id"), ...shape("questions", "questions.[].prompt", "questions.[].options", "questions.[].options.[].id", "questions.[].options.[].label", "outcome.reason"), ...bool("questions.[].allowMultiple"), literal("outcome.outcome", "skipped")],
  },
  opencode: {
    "http/health": [literal("status", 200), ...bool("data.healthy"), ...shape("data.version")],
    "http/session.create": [literal("status", 200), ...identity("data.id"), ...shape("data.directory")],
    "http/prompt_async": [literal("status", 204), literal("agent", "plan"), ...shape("parts.[].text")],
    "http/session.messages": [literal("status", 200), ...identity("data.[].info.sessionID", "data.[].info.id"), literal("data.[].info.agent", "plan"), literal("data.[].info.role", "user", "assistant"), ...shape("data.[].parts.[].type", "data.[].parts.[].text", "data.[].parts.[].tool", "data.[].parts.[].state.input", "data.[].parts.[].state.output")],
    "http/event": [literal("type", "catalog.updated", "integration.updated", "message.part.delta", "message.part.updated", "message.updated", "plugin.added", "question.asked", "question.replied", "reference.updated", "server.connected", "server.heartbeat", "session.diff", "session.idle", "session.status", "session.updated", "permission.asked", "permission.replied", "session.error"), ...shape("properties.part.type", "properties.part.text", "properties.part.tool", "properties.part.state.input", "properties.part.state.output", "properties.error", "properties.questions", "properties.questions.[].header", "properties.questions.[].question", "properties.questions.[].options.[].label", "properties.questions.[].options.[].description"), ...identity("properties.sessionID", "properties.id", "properties.part.sessionID"), ...bool("properties.questions.[].multiple", "properties.questions.[].custom")],
    "http/question.reply": [literal("status", 200), ...bool("data"), ...shape("answers", "answers.[].[]")],
    "http/permission.reply": [literal("status", 200), literal("reply", "reject"), ...bool("data")],
  },
};

const jsonTypeSchema = z.enum(["object", "array", "string", "number", "boolean", "null"]);
const aliasSchema = z.string().regex(/^ID_[1-9]\d{0,5}$/);
const fieldSchema = z.discriminatedUnion("kind", [
  z.object({ at: z.string().max(240), kind: z.literal("shape"), jsonType: jsonTypeSchema }).strict(),
  z.object({ at: z.string().max(240), kind: z.literal("literal"), value: z.union([z.string().max(80), z.boolean(), z.number(), z.null()]) }).strict(),
  z.object({ at: z.string().max(240), kind: z.literal("identity"), jsonType: z.enum(["string", "number"]), alias: aliasSchema }).strict(),
  z.object({ at: z.string().max(240), kind: z.literal("path"), value: z.string().regex(/^\{(?:providerHome|fixtureRepo|userHome)\}\/ID_[1-9]\d{0,5}$/) }).strict(),
]);
const messageBase = { sequence: z.number().int().positive(), operation: z.string().max(100), direction: z.enum(["sent", "received"]), fields: z.array(fieldSchema).max(512) };
const messageSchema = z.discriminatedUnion("kind", [z.object({ ...messageBase, kind: z.literal("event") }).strict(), z.object({ ...messageBase, kind: z.literal("request"), exchange: aliasSchema }).strict(), z.object({ ...messageBase, kind: z.literal("reply"), exchange: aliasSchema }).strict()]);
const endSchema = z.union([z.object({ kind: z.enum(["completed", "interrupted", "timeout", "blocked"]) }).strict(), z.object({ kind: z.literal("process-exit"), code: z.number().int().nullable(), signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).nullable() }).strict()]);
const versionSchema = z.string().regex(/^(?:\d+\.\d+\.\d+(?:-[a-z0-9]+)?|unknown)$/).max(60);
const fixtureSchema = z.object({
  format: z.literal("plan-protocol"), contractVersion: z.literal(1), providerId: providerSchema,
  cliVersion: versionSchema, protocolVersion: z.enum(["app-server-unversioned", "claude-sdk-unversioned", "copilot-sdk-unversioned", "copilot-rpc-3", "acp-1", "opencode-http-unversioned", "unmeasured"]),
  sdk: z.object({ name: z.enum(["@anthropic-ai/claude-agent-sdk", "@github/copilot-sdk"]), version: versionSchema }).strict().nullable(),
  provenance: z.literal("captured"), scenario: scenarioSchema, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  redaction: z.object({ reviewed: z.literal(true), removedFields: z.tuple([z.literal("private-text"), z.literal("credentials"), z.literal("native-identifiers"), z.literal("machine-paths"), z.literal("unlisted-fields")]) }).strict(),
  input: z.object({ messages: z.array(messageSchema).min(1).max(10000), end: endSchema }).strict(),
}).strict();
/** Sanitized observations deliberately do not implement the factory fixture contract. */
export type PlanProtocolFixture = z.infer<typeof fixtureSchema>;
type Field = z.infer<typeof fieldSchema>;
type Message = z.infer<typeof messageSchema>;
const rawSchema = z.object({ kind: z.enum(["request", "reply", "event"]), direction: z.enum(["sent", "received"]), operation: z.string().max(100), exchange: z.union([z.string(), z.number()]).optional(), payload: z.unknown() }).strict();
const rootsSchema = z.object({ providerHome: z.string(), fixtureRepo: z.string(), userHome: z.string() }).strict();
const metadataSchema = fixtureSchema.pick({ providerId: true, cliVersion: true, protocolVersion: true, sdk: true, scenario: true }).extend({ end: endSchema, roots: rootsSchema, capturedAt: z.string().datetime() }).strict();

function operationRules(provider: PlanProtocolFixture["providerId"], operation: string): Rule[] {
  const result = rules[provider][operation] ?? common[operation];
  if (!result) throw new TypeError(`Unreviewed operation: ${provider}/${operation}`);
  return result;
}
function matches(at: string, template: string): boolean {
  const actual = at.split(".");
  const expected = template.split(".");
  return actual.length === expected.length && expected.every((part, i) => part === "[]" ? /^(?:0|[1-9]\d?)$/.test(actual[i] ?? "") : part === "{}" ? /^ID_[1-9]\d*$/.test(actual[i] ?? "") : part === actual[i]);
}
function validateField(field: Field, declaration: Rule[]): void {
  const rule = declaration.find((item) => matches(field.at, item.at));
  if (!rule || rule.kind !== field.kind) throw new TypeError("Field outside projection policy");
  if (field.kind === "literal" && !rule.values?.includes(field.value)) throw new TypeError("Unreviewed control literal");
}
function validateMessages(fixture: PlanProtocolFixture): void {
  const requests = new Map<string, Message>();
  const answered = new Set<string>();
  fixture.input.messages.forEach((message, index) => {
    if (message.sequence !== index + 1) throw new TypeError("Noncontiguous messages");
    for (const field of message.fields) validateField(field, operationRules(fixture.providerId, message.operation));
    operationRules(fixture.providerId, message.operation);
    if (message.kind === "request") {
      if (requests.has(message.exchange)) throw new TypeError("Duplicate exchange");
      requests.set(message.exchange, message);
    } else if (message.kind === "reply") {
      const request = requests.get(message.exchange);
      if (!request || answered.has(message.exchange) || request.operation !== message.operation || request.direction === message.direction) throw new TypeError("Invalid reply correlation");
      answered.add(message.exchange);
    }
  });
}

/** Strictly parse a fixture, its provider-specific projection, order, and input hash. */
export function parsePlanProtocolFixture(value: unknown): PlanProtocolFixture {
  const fixture = fixtureSchema.parse(value);
  validateMessages(fixture);
  if (providerFixtureSourceHash(fixture.input) !== fixture.sourceHash) throw new TypeError("Input hash mismatch");
  if (fixture.cliVersion === "unknown" || fixture.protocolVersion === "unmeasured") throw new TypeError("Capture lacks exact version evidence");
  validateSdk(fixture);
  return fixture;
}
function validateSdk(fixture: PlanProtocolFixture): void {
  const expected = { claude: "@anthropic-ai/claude-agent-sdk", copilot: "@github/copilot-sdk", codex: null, cursor: null, devin: null, opencode: null };
  if ((fixture.sdk?.name ?? null) !== expected[fixture.providerId] || fixture.sdk?.version === "unknown") throw new TypeError("SDK metadata does not match the provider");
}
/** Read bounded committed evidence; discovery uses this same boundary. */
export function loadPlanProtocolFixture(file: string): PlanProtocolFixture {
  return parsePlanProtocolFixture(readJson(file));
}
function readJson(file: string): unknown {
  if (NodeFS.statSync(file).size > 8_000_000) throw new TypeError("Fixture exceeds byte limit");
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}
function jsonType(value: unknown): z.infer<typeof jsonTypeSchema> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return jsonTypeSchema.parse(typeof value);
}
function lookup(value: unknown, remaining: string[], at: string[], alias: (domain: string, value: unknown) => string): Array<{ at: string; value: unknown }> {
  const [key, ...tail] = remaining;
  if (!key) return [{ at: at.join("."), value }];
  if (key === "[]") {
    if (!Array.isArray(value)) return [];
    if (value.length > 100) throw new TypeError("Array projection exceeds bound");
    return value.flatMap((item, index) => lookup(item, tail, [...at, String(index)], alias));
  }
  if (typeof value !== "object" || value === null) return [];
  if (key === "{}") return Object.entries(value).flatMap(([name, item]) => lookup(item, tail, [...at, alias("question", name)], alias));
  const child = Object.getOwnPropertyDescriptor(value, key)?.value;
  return child === undefined ? [] : lookup(child, tail, [...at, key], alias);
}
function projectField(rule: Rule, at: string, value: unknown, alias: (domain: string, value: unknown) => string, roots: z.infer<typeof rootsSchema>): Field | null {
  if (rule.kind === "shape") return { at, kind: "shape", jsonType: jsonType(value) };
  if (rule.kind === "literal") {
    const safe = rule.values?.find((item) => item === value);
    if (safe === undefined) throw new TypeError(`Unreviewed literal at ${at}`);
    return { at, kind: "literal", value: safe };
  }
  if (rule.kind === "identity") {
    if (typeof value !== "string" && typeof value !== "number") throw new TypeError("Invalid identity");
    return { at, kind: "identity", jsonType: typeof value === "string" ? "string" : "number", alias: alias(identityDomain(at), value) };
  }
  return projectPath(at, value, alias, roots);
}
function identityDomain(at: string): string {
  if (/questions/.test(at)) return "question";
  if (/session/i.test(at)) return "session";
  if (/thread/i.test(at)) return "thread";
  if (/turn/i.test(at)) return "turn";
  return /item|tool|content/i.test(at) ? "item" : "event";
}
function projectPath(at: string, value: unknown, alias: (domain: string, value: unknown) => string, roots: z.infer<typeof rootsSchema>): Field | null {
  if (value === null) return null;
  if (typeof value !== "string" || !NodePath.isAbsolute(value)) throw new TypeError("Invalid observed path");
  const binding = Object.entries(roots).sort((a, b) => b[1].length - a[1].length).find(([, root]) => { const relative = NodePath.relative(root, value); return !relative.startsWith("..") && !NodePath.isAbsolute(relative); });
  if (!binding) throw new TypeError("Observed path outside known roots");
  return { at, kind: "path", value: `{${binding[0]}}/${alias("path", NodePath.normalize(value))}` };
}

function checkRawBounds(value: unknown, depth = 0): void {
  if (depth > 16) throw new TypeError("Raw nesting limit exceeded");
  if (typeof value !== "object" || value === null) return;
  const children = Object.values(value);
  if (children.length > 10000) throw new TypeError("Raw collection limit exceeded");
  for (const child of children) checkRawBounds(child, depth + 1);
}

function omittedEvent(message: z.infer<typeof rawSchema>, declaration: Rule[]): boolean {
  if (message.kind !== "event") return false;
  if (declaration.length === 0) return true;
  if (message.operation !== "sdk/event") return false;
  const type = Object.getOwnPropertyDescriptor(message.payload, "type")?.value;
  return typeof type === "string" && omittedCopilotEvents.has(type);
}
function collapseRepeatedEvents(messages: Message[]): Message[] {
  const result: Message[] = [];
  let previous = "";
  for (const message of messages) {
    const signature = JSON.stringify({ ...message, sequence: 0 });
    if (message.kind !== "event" || signature !== previous) result.push({ ...message, sequence: result.length + 1 });
    previous = signature;
  }
  return result;
}

/** Project authored test exchanges or actual raw captures without copying arbitrary keys or text. */
export function projectPlanProtocolCapture(metadata: unknown, raw: unknown[]): PlanProtocolFixture {
  const meta = metadataSchema.parse(metadata);
  if (raw.length > 10000) throw new TypeError("Message limit exceeded");
  for (const value of raw) checkRawBounds(value);
  const aliases = new Map<string, string>();
  function alias(domain: string, value: unknown): string {
    const key = `${domain}:${JSON.stringify(value)}`;
    let result = aliases.get(key);
    if (!result) { result = `ID_${aliases.size + 1}`; aliases.set(key, result); }
    return result;
  }
  const messages = raw.flatMap((value, index): Message[] => {
    const message = rawSchema.parse(value);
    const declaration = operationRules(meta.providerId, message.operation);
    if (omittedEvent(message, declaration)) return [];
    const fields = declaration.flatMap((rule) => lookup(message.payload, rule.at.split("."), [], alias).flatMap((found) => {
      const field = projectField(rule, found.at, found.value, alias, meta.roots);
      return field ? [field] : [];
    }));
    const base = { sequence: index + 1, operation: message.operation, direction: message.direction, fields };
    if (message.kind === "event") return [{ ...base, kind: "event" }];
    if (message.exchange === undefined) throw new TypeError("Missing exchange");
    const requestDirection = message.kind === "request" ? message.direction : message.direction === "sent" ? "received" : "sent";
    return [{ ...base, kind: message.kind, exchange: alias(`exchange-${requestDirection}`, message.exchange) }];
  });
  const input = { messages: collapseRepeatedEvents(messages), end: meta.end };
  return parsePlanProtocolFixture({ format: "plan-protocol", contractVersion: 1, providerId: meta.providerId, cliVersion: meta.cliVersion, protocolVersion: meta.protocolVersion, sdk: meta.sdk, provenance: "captured", scenario: meta.scenario, sourceHash: providerFixtureSourceHash(input), redaction: { reviewed: true, removedFields: ["private-text", "credentials", "native-identifiers", "machine-paths", "unlisted-fields"] }, input });
}

/** Write reviewed evidence exclusively; both raw and output parents must stay inside the package. */
export function sanitizePlanProtocolCapture(options: { runDirectory: string; outputDirectory: string; reviewed: true }): string {
  if (options.reviewed !== true) throw new TypeError("Review required");
  const packageRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
  for (const path of [options.runDirectory, options.outputDirectory]) if (!containedPath(packageRoot, path)) throw new TypeError("Capture path escapes package");
  const rawFile = NodePath.join(options.runDirectory, "messages.jsonl");
  for (const file of [rawFile, NodePath.join(options.runDirectory, "metadata.json")]) if (!containedPath(packageRoot, file)) throw new TypeError("Raw file escapes package");
  if (NodeFS.statSync(rawFile).size > 32_000_000) throw new TypeError("Capture exceeds byte limit");
  const raw = NodeFS.readFileSync(rawFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const fixture = projectPlanProtocolCapture(readJson(NodePath.join(options.runDirectory, "metadata.json")), raw);
  NodeFS.mkdirSync(options.outputDirectory, { recursive: true });
  const output = NodePath.join(options.outputDirectory, `${NodePath.basename(options.runDirectory)}.captured.json`);
  NodeFS.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { flag: "wx" });
  return output;
}
