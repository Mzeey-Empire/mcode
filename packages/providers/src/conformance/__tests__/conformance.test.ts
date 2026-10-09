import { assert, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, PlanCapture } from "@mcode/contracts";
import { createClaudeProvider } from "../../factories.js";
import { fixtureHost } from "../../private/claude/__tests__/helpers/provider-fixture.js";
import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";
import { mapCopilotEvent, type CopilotTurnState } from "../../private/copilot/copilot-event-mapper.js";
import { mapOpenCodeEnvelope } from "../../../../../apps/server/src/features/providers/adapters/opencode/opencode-event-mapper.js";
import { SYNTHETIC_PLAN_MARKDOWN, type SyntheticPlanTrace } from "../synthetic-plan-trace.js";
const planReplay = vi.hoisted(() => ({ requests: [] as Array<{ toolName: string; input: { plan: string } }> }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
  let turn = 0;
  const stream = (async function* () {
    for await (const _input of prompt) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      turn++;
      for (const request of planReplay.requests.splice(0)) {
        if (!options.canUseTool) throw new Error("Missing Claude tool boundary");
        await options.canUseTool(request.toolName, request.input, { signal: new AbortController().signal, toolUseID: "PLAN_1" });
      }
      yield { type: "result", uuid: `RESULT_${turn}`, is_error: false };
    }
  })();
  return Object.assign(stream, { close: () => undefined, setModel: async () => undefined });
} }));
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { loadPlanProtocolFixture, parsePlanProtocolFixture, projectPlanProtocolCapture, sanitizePlanProtocolCapture } from "../plan-probes/fixture.js";
import { providerFixtureSourceHash } from "../fixture-safety.js";
import { containedPath, recordChildStderr } from "../plan-probes/runtime.js";
import type { ProviderEventDraft } from "../../host-ports.js";
import { capturePlanFromAgentText, replayCursorPlanRequest } from "../harness.js";
import {
  DeterministicCanonicalSink,
  ENABLED_PROVIDER_CONFORMANCE,
  createProviderFixtureManifest,
  loadProviderFixtureManifest,
  runFactoryCoreProfile,
  runCursorAcpTraceProfile,
  runMapperProfile,
  sanitizeProviderFixtureFile,
  validateProviderConformanceRegistry,
  validateProviderFixtureManifest,
  type ProviderFixtureManifest,
  type SanitizedTraceEvent,
} from "../index.js";

const planFixtureDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/plan-protocol");
describe("synthetic plan capture conformance", () => {
  it.each(ENABLED_PROVIDER_CONFORMANCE)("captures exactly one plan from replayed $providerId events", async (registration) => {
    const file = registration.fixtureFiles.find((path) => path.endsWith("-core.synthetic.json"));
    if (!file) throw new Error("Missing core synthetic fixture");
    const fixture = loadProviderFixtureManifest(file);
    if (registration.providerId === "cursor") {
      expect((await runCursorAcpTraceProfile(fixture)).planCaptureCount).toBe(1);
      return;
    }
    const trace = fixture.input.planTrace;
    assert(trace);
    if (trace.providerId === "claude") {
      expect(await replayClaudePlan(trace)).toEqual([{ threadId: "THREAD_1", source: "native", markdown: SYNTHETIC_PLAN_MARKDOWN }]);
      return;
    }
    const emitted = replayPlanText(trace);
    const deltas = emitted.flatMap((event) => event.type === "textDelta" ? [event.delta] : []);
    expect(capturePlanFromAgentText(deltas, "THREAD_1")).toEqual([{
      threadId: "THREAD_1", source: "fence",
      markdown: SYNTHETIC_PLAN_MARKDOWN,
    }]);
  });

  it("does not capture prose or an unfinished fence", () => {
    expect(capturePlanFromAgentText(["# Prose\n## Status"], "THREAD_1")).toEqual([]);
    expect(capturePlanFromAgentText(["````mcode-plan\n# Unfinished"], "THREAD_1")).toEqual([]);
  });
});

function replayPlanText(trace: Exclude<SyntheticPlanTrace, { providerId: "claude" }>): AgentEvent[] {
  if (trace.providerId === "codex") {
    const mapper = new CodexEventMapper("THREAD_1", "SESSION_1");
    return trace.events.flatMap((event) => mapper.mapNotification(event).map((runtime) => runtime.event));
  }
  if (trace.providerId === "opencode") {
    const context = { threadId: "THREAD_1", partRole: "assistant", forwardedText: new Map<string, string>() };
    return trace.events.flatMap((event) => mapOpenCodeEnvelope(event, context).events);
  }
  const state: CopilotTurnState = { nativeIdleObserved: false, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
    tools: new Map(), pendingPermissions: new Map(), settle: () => undefined, completed: Promise.resolve() };
  return trace.events.flatMap((event) => mapCopilotEvent(event, "THREAD_1", state));
}

async function replayClaudePlan(trace: Extract<SyntheticPlanTrace, { providerId: "claude" }>): Promise<PlanCapture[]> {
  planReplay.requests.push(...trace.requests);
  const sink = new DeterministicCanonicalSink();
  const provider = createClaudeProvider({ configuration: { cliPath: process.execPath, idleSessionTtlMs: 60_000 },
    host: fixtureHost({ events: sink }), claude: { createForker: () => ({ fork: async () => { throw new Error("Unused fixture fork"); } }) } });
  const captures: PlanCapture[] = [];
  provider.on("plan_captured", (capture) => captures.push(capture));
  provider.setPlanAnswerMode("THREAD_1", true);
  try {
    await provider.sendTurn({ turnId: "TURN_1", turnExecutionId: "00000000-0000-4000-8000-000000000001", deliveryAttempt: 1,
      sessionId: "mcode-THREAD_1", workspaceId: "WORKSPACE_1", threadId: "THREAD_1", message: "fixture", cwd: process.cwd(),
      model: "claude-sonnet-4-6", permissionMode: "full", providerOptions: { contextWindowMode: "auto", thinking: false } });
    await vi.waitFor(() => expect(captures).toHaveLength(1));
    return captures;
  } finally {
    await provider.shutdown();
    planReplay.requests.length = 0;
  }
}
const planMetadata = {
  providerId: "codex", scenario: "questions-free-text", cliVersion: "0.161.0", protocolVersion: "app-server-unversioned", sdk: null,
  end: { kind: "completed" }, capturedAt: "2026-10-08T12:00:00.000Z",
  roots: { providerHome: NodePath.resolve(".dev/provider-homes/test"), fixtureRepo: NodePath.resolve(".dev/fixture-repo"), userHome: NodeOS.homedir() },
};
const privateQuestionExchange = [
  { kind: "request", direction: "received", operation: "item/tool/requestUserInput", exchange: 90, payload: { threadId: "private-thread", questions: [{ id: "private-question", header: "Private header", question: "Private question?", isOther: true, options: [{ label: "Private option", description: "Private explanation" }] }], "sk-private-key": { text: "Private nested text" }, env: { TOKEN: "private-token" } } },
  { kind: "reply", direction: "sent", operation: "item/tool/requestUserInput", exchange: 90, payload: { answers: { "private-question": { answers: ["Private free text"] } } } },
];

describe("Plan protocol research evidence", () => {
  it("replays the captured Cursor create_plan request through the bridge", async () => {
    const fixture = loadProviderFixtureManifest(NodePath.resolve(import.meta.dirname, "../fixtures/cursor-core.synthetic.json"));
    const captured = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "r1-cursor-plan-02.captured.json"));
    const request = captured.input.messages.find((message) => message.kind === "request" && message.operation === "cursor/create_plan");
    assert(request);
    const params: Record<string, string | string[]> = {};
    for (const field of request.fields) {
      if (field.kind === "identity") params[field.at] = field.alias;
      if (field.kind === "shape" && field.jsonType === "string") params[field.at] = `Fixture ${field.at}`;
      if (field.kind === "shape" && field.jsonType === "array") params[field.at] = [];
    }
    expect(await replayCursorPlanRequest(fixture, params)).toEqual([
      { threadId: "CURSOR_TRACE_THREAD", markdown: "Fixture plan", source: "native" },
    ]);
  });

  it("rejects private text, extra fields and wrong provenance in synthetic native plan events", () => {
    const fixture = loadProviderFixtureManifest(NodePath.resolve(import.meta.dirname, "../fixtures/claude-core.synthetic.json"));
    for (const planTrace of [
      { providerId: "claude", requests: [{ toolName: "ExitPlanMode", input: { plan: "Private text" } }] },
      { ...fixture.input.planTrace, privateField: "private" },
    ]) {
      expect(() => validateProviderFixtureManifest({ ...fixture, input: { ...fixture.input, planTrace } })).toThrow();
    }
    expect(() => validateProviderFixtureManifest({ ...fixture, provenance: "captured" })).toThrow();
    expect(() => validateProviderFixtureManifest({ ...fixture, providerId: "codex" })).toThrow();
  });
  it("discovers and validates every committed capture without changing factory coverage", () => {
    const files = NodeFS.readdirSync(planFixtureDirectory);
    expect(files).toContain("s07-devin-01.captured.json");
    expect(files).toContain("r1-codex-plan-02.captured.json");
    for (const file of files) expect(loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, file)).provenance).toBe("captured");
    expect(ENABLED_PROVIDER_CONFORMANCE.map((provider) => provider.providerId).sort()).toEqual(["claude", "codex", "copilot", "cursor", "opencode"]);
  });

  it("retains exact question/reply shapes and aliased correlation while removing private text and keys", () => {
    const fixture = projectPlanProtocolCapture(planMetadata, privateQuestionExchange);
    expect(fixture.input.messages).toEqual([
      { sequence: 1, kind: "request", direction: "received", operation: "item/tool/requestUserInput", exchange: "ID_3", fields: [
        { at: "threadId", kind: "identity", jsonType: "string", alias: "ID_1" },
        { at: "questions.0.id", kind: "identity", jsonType: "string", alias: "ID_2" },
        { at: "questions", kind: "shape", jsonType: "array" },
        { at: "questions.0.header", kind: "shape", jsonType: "string" },
        { at: "questions.0.question", kind: "shape", jsonType: "string" },
        { at: "questions.0.options", kind: "shape", jsonType: "array" },
        { at: "questions.0.options.0.label", kind: "shape", jsonType: "string" },
        { at: "questions.0.options.0.description", kind: "shape", jsonType: "string" },
        { at: "questions.0.isOther", kind: "literal", value: true },
      ] },
      { sequence: 2, kind: "reply", direction: "sent", operation: "item/tool/requestUserInput", exchange: "ID_3", fields: [
        { at: "answers", kind: "shape", jsonType: "object" },
        { at: "answers.ID_2.answers", kind: "shape", jsonType: "array" },
        { at: "answers.ID_2.answers.0", kind: "shape", jsonType: "string" },
      ] },
    ]);
    expect(JSON.stringify(fixture)).not.toMatch(/private-thread|private-question|Private|TOKEN|sk-private/);
  });

  it("retains concurrent pending requests and rejects invalid reply order, reuse, operation and direction", () => {
    const [request, reply] = privateQuestionExchange;
    const concurrent = [request, { ...request, exchange: 91 }, { ...reply, exchange: 91 }, reply];
    expect(projectPlanProtocolCapture(planMetadata, concurrent).input.messages.map((message) => message.kind)).toEqual(["request", "request", "reply", "reply"]);
    for (const invalid of [[reply, request], [request, reply, reply], [request, { ...reply, direction: "received" }], [request, { ...reply, operation: "turn/interrupt" }]]) {
      expect(() => projectPlanProtocolCapture(planMetadata, invalid)).toThrow(TypeError);
    }
    const pending = projectPlanProtocolCapture({ ...planMetadata, end: { kind: "process-exit", code: 1, signal: null } }, [request]);
    expect(pending.input.messages.map((message) => message.kind)).toEqual(["request"]);
    expect(pending.input.end).toEqual({ kind: "process-exit", code: 1, signal: null });
  });

  it("rejects unsafe metadata, unknown operations, wrong-provider paths, extra keys and unreviewed literals", () => {
    const fixture = projectPlanProtocolCapture(planMetadata, privateQuestionExchange);
    const unsafe = [
      { ...fixture, cliVersion: "C:/private/secret" }, { ...fixture, redaction: { ...fixture.redaction, reviewed: false } },
      { ...fixture, providerId: "claude" }, { ...fixture, privateText: "secret" },
    ];
    for (const candidate of unsafe) expect(() => parsePlanProtocolFixture(candidate)).toThrow();
    expect(() => projectPlanProtocolCapture(planMetadata, [{ kind: "event", direction: "received", operation: "private-operation", payload: {} }])).toThrow(TypeError);
    expect(() => projectPlanProtocolCapture(planMetadata, [{ kind: "event", direction: "received", operation: "item/completed", payload: { item: { type: "private-literal" } } }])).toThrow(TypeError);
    const edited = structuredClone(fixture);
    edited.input.messages[0]!.fields.push({ at: "questions.0.question", kind: "literal", value: "private text" });
    edited.sourceHash = providerFixtureSourceHash(edited.input);
    expect(() => parsePlanProtocolFixture(edited)).toThrow(TypeError);
  });

  it("enforces input bounds and detects hash drift without depending on object-key order", () => {
    let deep: unknown = "secret";
    for (let level = 0; level < 18; level++) deep = { child: deep };
    expect(() => projectPlanProtocolCapture(planMetadata, [{ ...privateQuestionExchange[0], payload: deep }])).toThrow(TypeError);
    expect(() => projectPlanProtocolCapture(planMetadata, Array.from({ length: 10001 }, () => privateQuestionExchange[0]))).toThrow(TypeError);
    const fixture = projectPlanProtocolCapture(planMetadata, privateQuestionExchange);
    expect(() => parsePlanProtocolFixture({ ...fixture, input: { ...fixture.input, end: { kind: "timeout" } } })).toThrow(TypeError);
    expect(parsePlanProtocolFixture({ ...fixture, input: { end: fixture.input.end, messages: fixture.input.messages } }).sourceHash).toBe(fixture.sourceHash);
    const reordered = structuredClone(fixture);
    reordered.input.messages[1]!.sequence = 4;
    reordered.sourceHash = providerFixtureSourceHash(reordered.input);
    expect(() => parsePlanProtocolFixture(reordered)).toThrow(TypeError);
  });

  it("writes exclusively and refuses both lexical and symlink escapes", () => {
    const packageRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const rawRoot = NodePath.join(packageRoot, ".conformance-raw");
    NodeFS.mkdirSync(rawRoot, { recursive: true });
    const temporary = NodeFS.mkdtempSync(NodePath.join(rawRoot, "plan-test-"));
    const scratch = NodePath.resolve(packageRoot, "../../.dev/build-ticket");
    NodeFS.mkdirSync(scratch, { recursive: true });
    const outside = NodeFS.mkdtempSync(NodePath.join(scratch, "plan-test-outside-"));
    try {
      NodeFS.writeFileSync(NodePath.join(temporary, "metadata.json"), JSON.stringify(planMetadata));
      NodeFS.writeFileSync(NodePath.join(temporary, "messages.jsonl"), privateQuestionExchange.map((row) => JSON.stringify(row)).join("\n"));
      const outputDirectory = NodePath.join(temporary, "output");
      const options = { runDirectory: temporary, outputDirectory, reviewed: true };
      const file = sanitizePlanProtocolCapture({ ...options, reviewed: true });
      expect(loadPlanProtocolFixture(file).scenario).toBe("questions-free-text");
      expect(() => sanitizePlanProtocolCapture({ ...options, reviewed: true })).toThrow();
      expect(() => sanitizePlanProtocolCapture({ ...options, outputDirectory: outside, reviewed: true })).toThrow(TypeError);
      const link = NodePath.join(temporary, "escaped");
      NodeFS.symlinkSync(outside, link, "junction");
      expect(containedPath(packageRoot, NodePath.join(link, "plan.md"))).toBe(false);
      expect(() => sanitizePlanProtocolCapture({ ...options, outputDirectory: link, reviewed: true })).toThrow(TypeError);
    } finally {
      NodeFS.rmSync(temporary, { recursive: true, force: true });
      NodeFS.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("pins observed Claude exit and question behavior, including the missing plan payload", () => {
    const plan = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-claude-02.captured.json"));
    expect(plan.cliVersion).toBe("2.1.293");
    expect(plan.input.messages.flatMap((message) => message.fields)).toContainEqual({ at: "tool_name", kind: "literal", value: "ExitPlanMode" });
    expect(plan.input.messages.filter((message) => message.operation === "probe/exit-plan").flatMap((message) => message.fields)).toEqual([
      { at: "hasPlan", kind: "literal", value: false }, { at: "nonemptyPlan", kind: "literal", value: false },
    ]);
    const questions = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-claude-01.captured.json"));
    expect(questions.input.messages.flatMap((message) => message.fields)).toContainEqual({ at: "toolName", kind: "literal", value: "AskUserQuestion" });
  });

  it("pins Copilot's session-owned plan path from its API to the filesystem observation", () => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-copilot-03.captured.json"));
    expect(fixture.cliVersion).toBe("1.0.83");
    expect(fixture.sdk).toEqual({ name: "@github/copilot-sdk", version: "0.2.2" });
    expect(fixture.protocolVersion).toBe("copilot-rpc-3");
    expect(fixture.input.messages.find((message) => message.operation === "sdk/status" && message.kind === "reply")!.fields).toContainEqual({ at: "protocolVersion", kind: "literal", value: 3 });
    const file = fixture.input.messages.find((message) => message.operation === "probe/file")!;
    expect(file.fields).toContainEqual({ at: "sessionDirectoryMatches", kind: "literal", value: true });
    expect(file.fields).toContainEqual({ at: "insideRun", kind: "literal", value: true });
    const path = file.fields.find((field) => field.kind === "path");
    expect(path?.kind === "path" && path.value.startsWith("{providerHome}/")).toBe(true);
    const paths = fixture.input.messages.filter((message) => message.operation === "sdk/plan.read" || message.operation === "sdk/permission").flatMap((message) => message.fields).filter((field) => field.kind === "path");
    expect(paths.map((field) => field.value)).toContain(path!.kind === "path" ? path!.value : "missing");
    expect(fixture.input.messages.find((message) => message.operation === "sdk/plan.read" && message.kind === "reply")!.fields).toContainEqual({ at: "exists", kind: "literal", value: true });
  });

  it("ties Claude's full ExitPlanMode payload to the written file and the same session", () => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "r1-claude-file-03.captured.json"));
    const exit = fixture.input.messages.find((message) => message.operation === "sdk/canUseTool" && message.kind === "request" && message.fields.some((field) => field.at === "toolName" && field.kind === "literal" && field.value === "ExitPlanMode"))!;
    expect(exit.fields).toContainEqual({ at: "input.plan", kind: "shape", jsonType: "string" });
    const exitPath = exit.fields.find((field) => field.at === "input.planFilePath");
    const file = fixture.input.messages.find((message) => message.operation === "probe/file")!;
    expect(file.fields).toContainEqual({ at: "exists", kind: "literal", value: true });
    expect(file.fields).toContainEqual({ at: "insideRun", kind: "literal", value: true });
    expect(file.fields.find((field) => field.at === "path")).toEqual({ ...exitPath, at: "path" });
    expect(exitPath?.kind === "path" && exitPath.value.startsWith("{fixtureRepo}/")).toBe(true);
    const write = fixture.input.messages.find((message) => message.operation === "sdk/preToolUse" && message.fields.some((field) => field.kind === "literal" && field.at === "tool_name" && field.value === "Write"))!;
    expect(file.fields.find((field) => field.at === "sessionId")).toEqual({ ...write.fields.find((field) => field.at === "session_id"), at: "sessionId" });
    expect(fixture.input.messages.find((message) => message.operation === "probe/exit-plan")!.fields).toEqual([
      { at: "hasPlan", kind: "literal", value: true }, { at: "nonemptyPlan", kind: "literal", value: true }, { at: "matchesWrittenPlan", kind: "literal", value: true },
    ]);
  });

  it.each(["claude", "copilot", "devin"])("pins %s nested-fence reproduction from its actual response", (provider) => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, `s07-${provider}-fence-01.captured.json`));
    expect(fixture.input.messages.filter((message) => message.operation === "probe/fence").map((message) => message.fields)).toEqual([[
      { at: "exact", kind: "literal", value: true }, { at: "openerExact", kind: "literal", value: true },
      { at: "nestedFenceIntact", kind: "literal", value: true }, { at: "closerExact", kind: "literal", value: true },
    ]]);
  });

  it("pins Copilot native questions and distinguishes the older CLI write permission", () => {
    const questions = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-copilot-questions-01.captured.json"));
    const exchange = questions.input.messages.filter((message) => message.operation === "sdk/question");
    expect(exchange.map((message) => message.kind)).toEqual(["request", "reply"]);
    expect(exchange[0]!.fields).toContainEqual({ at: "question", kind: "shape", jsonType: "string" });
    expect(exchange[1]!.fields).toContainEqual({ at: "wasFreeform", kind: "literal", value: true });
    const old = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-copilot-01.captured.json"));
    expect(old.cliVersion).toBe("1.0.56");
    expect(old.input.messages.filter((message) => message.operation === "sdk/permission").flatMap((message) => message.fields)).toContainEqual({ at: "kind", kind: "literal", value: "write" });
    expect(old.input.messages.find((message) => message.operation === "sdk/plan.read")!.fields).toContainEqual({ at: "exists", kind: "literal", value: false });
  });

  it("pins Devin's acknowledged plan mode", () => {
    const devin = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-devin-01.captured.json"));
    expect(devin.input.messages.find((message) => message.kind === "reply" && message.operation === "session/set_config_option")!.fields).toContainEqual({ at: "configOptions.0.currentValue", kind: "literal", value: "plan" });
  });

  it("preserves stderr from failed children and creates a file for silent children", async () => {
    const root = NodePath.resolve(import.meta.dirname, "../../../.conformance-raw");
    const directory = NodeFS.mkdtempSync(NodePath.join(root, "stderr-test-"));
    try {
      for (const [index, script] of ["process.stderr.write('probe diagnostic'); process.exitCode = 1", "process.exitCode = 1"].entries()) {
        const child = NodeChildProcess.spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: "pipe" });
        recordChildStderr(child, directory, index);
        const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        expect(exit).toBe(1);
      }
      expect(NodeFS.readFileSync(NodePath.join(directory, "child-0.stderr.log"), "utf8")).toBe("probe diagnostic");
      expect(NodeFS.readFileSync(NodePath.join(directory, "child-1.stderr.log"), "utf8")).toBe("");
      expect(NodeFS.readFileSync(NodePath.join(directory, "stderr.log"), "utf8")).toBe("probe diagnostic");
    } finally { NodeFS.rmSync(directory, { recursive: true, force: true }); }
  });

  it("pins an acknowledged Codex collaboration mode followed by plan deltas and a completed plan", () => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "r1-codex-plan-02.captured.json"));
    const start = fixture.input.messages.filter((message) => message.operation === "turn/start");
    expect(start.map((message) => message.kind)).toEqual(["request", "reply"]);
    expect(start[0]!.fields).toContainEqual({ at: "collaborationMode.mode", kind: "literal", value: "plan" });
    expect(start[0]!.fields).toContainEqual({ at: "additionalContext", kind: "shape", jsonType: "object" });
    expect(start[1]!.fields).toContainEqual({ at: "turn.status", kind: "literal", value: "inProgress" });
    expect(fixture.input.messages.filter((message) => message.operation === "item/plan/delta").flatMap((message) => message.fields)).toContainEqual({ at: "delta", kind: "shape", jsonType: "string" });
    expect(fixture.input.messages.filter((message) => message.operation === "item/completed").flatMap((message) => message.fields)).toContainEqual({ at: "item.type", kind: "literal", value: "plan" });
    expect(fixture.input.end).toEqual({ kind: "completed" });
  });

  it.each(["questions", "questions-free-text", "questions-decline", "questions-cancel", "questions-interrupt", "questions-process-exit"])("pins Codex %s without inventing cancellation replies", (scenario) => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, `r1-codex-${scenario}.captured.json`));
    const messages = fixture.input.messages.filter((message) => message.operation === "item/tool/requestUserInput");
    const interrupted = scenario === "questions-interrupt" || scenario === "questions-process-exit";
    expect(messages.map((message) => message.kind)).toEqual(interrupted ? ["request"] : ["request", "reply"]);
    expect(messages[0]!.fields).toContainEqual({ at: "questions.0.question", kind: "shape", jsonType: "string" });
    if (interrupted) {
      expect(fixture.input.end.kind).toBe(scenario === "questions-interrupt" ? "interrupted" : "process-exit");
      const interrupts = fixture.input.messages.filter((message) => message.operation === "turn/interrupt");
      expect(interrupts.map((message) => message.kind)).toEqual(scenario === "questions-interrupt" ? ["request", "reply"] : []);
    } else {
      expect(messages[1]).toMatchObject({ exchange: "exchange" in messages[0]! ? messages[0].exchange : null });
      const answerStrings = messages[1]!.fields.filter((field) => /^answers\.ID_\d+\.answers\.0$/.test(field.at));
      expect(answerStrings.length).toBe(scenario === "questions" || scenario === "questions-free-text" ? 1 : 0);
      if (scenario === "questions-cancel") expect(messages[1]!.fields).toContainEqual({ at: "error.code", kind: "literal", value: -32800 });
      expect(fixture.input.end).toEqual({ kind: "completed" });
    }
  });

  it.each(["r1-codex-fence", "r1-cursor-fence-02", "r1-opencode-fence"])("pins successful nested fences in %s", (run) => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, `${run}.captured.json`));
    expect(fixture.input.messages.filter((message) => message.operation === "probe/fence").map((message) => message.fields)).toEqual([[
      { at: "exact", kind: "literal", value: true }, { at: "openerExact", kind: "literal", value: true },
      { at: "nestedFenceIntact", kind: "literal", value: true }, { at: "closerExact", kind: "literal", value: true },
    ]]);
  });

  it.each([["plan-02", "cancelled"], ["rejected", "rejected"], ["feedback", "feedback"]])("pins Cursor's plan key and tested %s candidate reply", (run, outcome) => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, `r1-cursor-${run}.captured.json`));
    const messages = fixture.input.messages.filter((message) => message.operation === "cursor/create_plan");
    expect(messages.map((message) => message.kind)).toEqual(["request", "reply"]);
    expect(messages[0]!.fields).toContainEqual({ at: "plan", kind: "shape", jsonType: "string" });
    expect(messages[0]!.fields.some((field) => field.at === "markdown")).toBe(false);
    expect(messages[1]!.fields).toContainEqual({ at: "outcome.outcome", kind: "literal", value: outcome });
    expect(fixture.input.messages.find((message) => message.operation === "session/prompt" && message.kind === "reply")!.fields).toContainEqual({ at: "stopReason", kind: "literal", value: "end_turn" });
  });

  it("pins OpenCode's accepted plan agent and a native question followed by an answer and idle", () => {
    const fixture = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "r1-opencode-questions.captured.json"));
    const prompt = fixture.input.messages.filter((message) => message.operation === "http/prompt_async");
    expect(prompt.map((message) => message.kind)).toEqual(["request", "reply"]);
    expect(prompt[0]!.fields).toContainEqual({ at: "agent", kind: "literal", value: "plan" });
    expect(prompt[1]!.fields).toContainEqual({ at: "status", kind: "literal", value: 204 });
    const events = fixture.input.messages.filter((message) => message.operation === "http/event").flatMap((message) => message.fields);
    expect(events).toContainEqual({ at: "type", kind: "literal", value: "question.asked" });
    expect(events).toContainEqual({ at: "properties.questions.0.options.0.label", kind: "shape", jsonType: "string" });
    expect(fixture.input.messages.filter((message) => message.operation === "http/question.reply").map((message) => message.kind)).toEqual(["request", "reply"]);
    expect(events).toContainEqual({ at: "type", kind: "literal", value: "session.idle" });
  });
});

describe("Provider conformance registry", () => {
  it("covers every enabled factory with core fixtures and supported versions", () => {
    const fixtures = validateProviderConformanceRegistry(ENABLED_PROVIDER_CONFORMANCE);
    const codex = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!;
    expect(codex.requiredProfiles).toEqual([
      "core",
      "build",
      "plan",
      "goals",
      "permissions",
      "usage",
      "session-eviction",
      "clean-fork",
      "orchestration",
      "browser-access",
      "thread-control",
      "child-cancellation",
      "turn-diff",
      "approval-review",
    ]);

    expect([...new Set(fixtures.map((fixture) => fixture.providerId))].sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "cursor",
      "opencode",
    ]);
  });

  it("exercises offline public factory core behavior", async () => {
    await expect(Promise.all(ENABLED_PROVIDER_CONFORMANCE.map(runFactoryCoreProfile))).resolves.toEqual([
      { providerId: "claude", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "codex", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "copilot", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "cursor", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "opencode", spawnCount: 1, terminalType: "turn.completed" },
    ]);
  });

  it("fails when a Provider loses manifests, profile coverage, or version evidence", () => {
    const registration = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!;

    expect(() => validateProviderConformanceRegistry([
      { ...registration, fixtureFiles: [] },
    ])).toThrow("lacks fixture manifests");
    expect(() => validateProviderConformanceRegistry([
      { ...registration, requiredProfiles: [] },
    ])).toThrow("lacks core profile coverage");
    expect(() => validateProviderConformanceRegistry([
      { ...registration, supportedVersions: [] },
    ])).toThrow("lacks supported-version evidence");

    const cursor = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "cursor")!;
    expect(() => validateProviderConformanceRegistry([
      { ...cursor, fixtureFiles: cursor.fixtureFiles.filter((file) => !file.endsWith("captured.json")) },
    ])).toThrow("lacks captured fixture coverage");

    const claude = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "claude")!;
    expect(() => validateProviderConformanceRegistry([
      { ...claude, fixtureFiles: claude.fixtureFiles.filter((file) => !file.endsWith("captured.json")) },
    ])).toThrow("lacks captured fixture coverage");
  });

  it("covers each declared Cursor capability with captured and synthetic ACP trace envelopes", async () => {
    const cursor = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "cursor")!;
    const cursorFixtures = cursor.fixtureFiles.map(loadProviderFixtureManifest);
    const captured = cursorFixtures.find((fixture) => fixture.provenance === "captured")!;
    const synthetic = cursorFixtures.find((fixture) => fixture.provenance === "synthetic")!;

    expect([...new Set(cursorFixtures.flatMap((fixture) => fixture.requiredProfiles))].sort()).toEqual(
      [...cursor.requiredProfiles].sort(),
    );
    expect(captured.requiredProfiles).toEqual(["core", "build"]);
    expect(synthetic.requiredProfiles).toEqual(cursor.requiredProfiles);
    await expect(Promise.all(cursorFixtures.map(runCursorAcpTraceProfile))).resolves.toEqual([
      {
        scenario: "synthetic Cursor ACP lifecycle and unsupported extension replay",
        coveredProfiles: cursor.requiredProfiles,
        emittedEventTypes: ["toolUse", "toolUse", "toolResult", "toolUse", "toolUse", "toolResult"],
        toolNames: ["Read", "Read", "Agent", "Agent"],
        unsupportedMethods: ["cursor/task", "cursor/continue"],
        planCaptureCount: 1,
      },
      {
        scenario: "captured Cursor ACP tool and child lifecycle envelope replay",
        coveredProfiles: ["core", "build"],
        emittedEventTypes: ["toolUse", "toolUse", "toolResult", "toolUse", "toolUse", "toolResult"],
        toolNames: ["Agent", "Agent", "Read", "Read"],
        unsupportedMethods: [],
        planCaptureCount: 0,
      },
    ]);
  });

  it("registers a sanitized Codex adversarial fixture without private content", () => {
    const registration = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!;
    const fixture = registration.fixtureFiles
      .map(loadProviderFixtureManifest)
      .find(({ scenario }) => scenario.includes("adversarial"));

    expect(fixture?.provenance).toBe("synthetic");
    expect(JSON.stringify(fixture?.input)).not.toMatch(
      /prompt|response|secret|token|password|environment|absolute path|raw|output|[A-Z]:[\\/]|\\\\/i,
    );
    expect(fixture?.expected.terminal).toBe("errored");
  });
});

describe("Provider fixture pipeline", () => {
  const fixtureFile = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!.fixtureFiles[0]!;

  it("replays structural protocol input into validated canonical drafts", () => {
    const fixture = loadProviderFixtureManifest(fixtureFile);
    const routing = {
      threadId: "THREAD_1",
      turnId: "TURN_1",
      executionId: "00000000-0000-4000-8000-000000000001",
    };
    const mapper = {
      map(events: readonly SanitizedTraceEvent[]): readonly ProviderEventDraft[] {
        return events.map((event) => ({
          eventId: `${event.kind}:${event.sequence}`,
          routing,
          sourceProviderId: "codex",
          sourceIdentities: event.nativeId
            ? [{ providerId: "codex", scope: "item", value: event.nativeId, provenance: "native" }]
            : [],
          sourceSequence: event.sequence,
          payload: event.kind === "terminal"
            ? { type: "turn.completed", endedAt: "1970-01-01T00:00:05.000Z" }
            : { type: "ingest.volatile-truncated", droppedEventCount: event.size ?? 1 },
        }));
      },
    };

    const drafts = runMapperProfile({
      fixture,
      nativeInput: fixture.input.events,
      mapper,
      summarize: (mapped) => ({
        orderedKinds: mapped.map((draft) => draft.eventId.split(":")[0] as SanitizedTraceEvent["kind"]),
        terminal: "completed",
        toolPairs: [["PAIR_1", "PAIR_1"]],
      }),
    });

    expect(drafts).toHaveLength(5);
    expect(drafts[0]?.sourceIdentities[0]).toMatchObject({ provenance: "native", value: "SESSION_1" });
  });

  it("computes the source hash and rejects sensitive or unreviewed content", () => {
    const fixture = loadProviderFixtureManifest(fixtureFile);
    const rebuilt = createProviderFixtureManifest(omitGeneratedFields(fixture));

    expect(rebuilt.sourceHash).toBe(fixture.sourceHash);
    expect(() => validateProviderFixtureManifest({ ...fixture, prompt: "private request" })).toThrow(
      "forbidden field: prompt",
    );
    expect(() => validateProviderFixtureManifest({
      ...fixture,
      scenario: "Bearer private-credential-value",
    })).toThrow("secret-shaped data");
    expect(() => validateProviderFixtureManifest({
      ...fixture,
      scenario: "C:\\Users\\person\\repo",
    })).toThrow("absolute path");
    expect(() => validateProviderFixtureManifest({
      ...fixture,
      redaction: { ...fixture.redaction, reviewed: false },
    })).toThrow("requires redaction review");
  });

  it("sanitizes raw rows without retaining private fields or native identifiers", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-conformance-"));
    const priorCwd = process.cwd();
    try {
      process.chdir(root);
      NodeFS.mkdirSync(".conformance-raw", { recursive: true });
      NodeFS.mkdirSync("src/conformance/fixtures", { recursive: true });
      NodeFS.writeFileSync(".conformance-raw/capture.jsonl", [
        JSON.stringify({ kind: "turn", nativeId: "private-native-id", status: "started", prompt: "private prompt" }),
        JSON.stringify({ kind: "terminal", nativeId: "private-native-id", status: "completed", rawOutput: "private output" }),
      ].join("\n"));

      const manifest = sanitizeProviderFixtureFile({
        rawFile: ".conformance-raw/capture.jsonl",
        outputFile: "src/conformance/fixtures/captured.json",
        metadata: {
          providerId: "codex",
          cliVersion: "1.2.3",
          protocolVersion: "2",
          provenance: "captured",
          requiredProfiles: ["core"],
          scenario: "captured lifecycle",
          expected: { orderedKinds: ["turn", "terminal"], terminal: "completed", toolPairs: [] },
        },
      });
      const output = NodeFS.readFileSync("src/conformance/fixtures/captured.json", "utf8");

      expect(manifest.input.events[0]?.nativeId).toMatch(/^NATIVE_/);
      expect(output).not.toContain("private-native-id");
      expect(output).not.toContain("private prompt");
      expect(output).not.toContain("private output");
    } finally {
      process.chdir(priorCwd);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("First provider frame in core traces", () => {
  // Structural stand-in for the server's provider-frame rule: session setup and the turn-start notice never prove the
  // provider answered; a turn item or a completed terminal does. Errored or interrupted terminals mean it never did.
  function firstProviderFrame(events: readonly SanitizedTraceEvent[]): SanitizedTraceEvent | undefined {
    return events.find((event) => event.kind === "item" || (event.kind === "terminal" && event.status === "completed"));
  }

  function fixtureEvents(providerId: string, suffix: string): readonly SanitizedTraceEvent[] {
    const file = ENABLED_PROVIDER_CONFORMANCE.find((registration) => registration.providerId === providerId)
      ?.fixtureFiles.find((path) => path.endsWith(suffix));
    if (!file) throw new Error(`Missing ${providerId} fixture ${suffix}`);
    return loadProviderFixtureManifest(file).input.events;
  }

  it.each([
    { providerId: "opencode", suffix: "opencode-core.synthetic.json", frame: { kind: "item", sequence: 3 } },
    { providerId: "codex", suffix: "codex-core.captured.json", frame: { kind: "terminal", sequence: 3 } },
  ])("places the $providerId first frame after its early turn start", ({ providerId, suffix, frame }) => {
    const events = fixtureEvents(providerId, suffix);
    const turnStart = events.find((event) => event.kind === "turn" && event.status === "started");

    expect(turnStart?.sequence).toBe(2);
    expect(firstProviderFrame(events)).toMatchObject(frame);
    expect(firstProviderFrame(events)).not.toBe(turnStart);
  });
});

describe("Deterministic canonical sink", () => {
  it.each([
    {
      type: "turn.completed" as const,
      payload: { type: "turn.completed" as const, endedAt: "1970-01-01T00:00:01.000Z" },
    },
    {
      type: "turn.cancelled" as const,
      payload: {
        type: "turn.cancelled" as const,
        endedAt: "1970-01-01T00:00:01.000Z",
        reason: "user stop",
      },
    },
    {
      type: "turn.interrupted" as const,
      payload: {
        type: "turn.interrupted" as const,
        endedAt: "1970-01-01T00:00:01.000Z",
        reason: "provider restart",
      },
    },
    {
      type: "turn.errored" as const,
      payload: {
        type: "turn.errored" as const,
        endedAt: "1970-01-01T00:00:01.000Z",
        error: "provider failed",
      },
    },
  ])("ignores and diagnoses events after $type", async ({ type, payload }) => {
    const sink = new DeterministicCanonicalSink();
    const routing = {
      threadId: "THREAD_1",
      turnId: "TURN_1",
      executionId: "00000000-0000-4000-8000-000000000001",
    };
    const terminal: ProviderEventDraft = {
      eventId: `terminal:${type}`,
      routing,
      sourceProviderId: "codex",
      sourceIdentities: [],
      payload,
    };
    const lateEvent: ProviderEventDraft = {
      eventId: `late:${type}`,
      routing,
      sourceProviderId: "codex",
      sourceIdentities: [],
      payload: { type: "ingest.volatile-truncated", droppedEventCount: 1 },
    };

    await sink.submit({ ...routing, phase: "streaming", events: [terminal] });
    await sink.submit({ ...routing, phase: "late", events: [lateEvent] });

    expect(sink.snapshot().events.map(({ payload: eventPayload }) => eventPayload.type)).toEqual([type]);
    expect(sink.snapshot().diagnostics).toEqual([`Ignored event ingest.volatile-truncated after ${type}`]);
  });

  it("reserves terminal capacity and emits explicit overflow evidence", async () => {
    const sink = new DeterministicCanonicalSink({ maxEvents: 3, maxDiagnostics: 2 });
    const routing = {
      threadId: "THREAD_1",
      turnId: "TURN_1",
      executionId: "00000000-0000-4000-8000-000000000001",
    };
    const events: ProviderEventDraft[] = Array.from({ length: 4 }, (_, index) => ({
      eventId: `event:${index}`,
      routing,
      sourceProviderId: "codex",
      sourceIdentities: [],
      sourceSequence: index + 1,
      payload: { type: "ingest.volatile-truncated", droppedEventCount: 1 },
    }));

    await sink.submit({ ...routing, phase: "streaming", events });
    await sink.submit({
      ...routing,
      phase: "late",
      events: [{ ...events[0]!, eventId: "late-event" }],
    });

    expect(sink.snapshot().events.map(({ payload }) => payload.type)).toEqual([
      "ingest.volatile-truncated",
      "ingest.volatile-truncated",
      "ingest.overflow",
    ]);
    expect(sink.snapshot().diagnostics[0]).toContain("after ingest.overflow");
  });
});

function omitGeneratedFields(
  fixture: ProviderFixtureManifest,
): Omit<ProviderFixtureManifest, "contractVersion" | "sourceHash"> {
  const {
    contractVersion: _contractVersion,
    sourceHash: _sourceHash,
    ...input
  } = fixture;
  return input;
}
