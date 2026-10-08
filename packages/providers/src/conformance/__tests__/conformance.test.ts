import { describe, expect, it, vi } from "vitest";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
  let turn = 0;
  const stream = (async function* () {
    for await (const _input of prompt) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      turn++;
      yield { type: "result", uuid: `RESULT_${turn}`, is_error: false };
    }
  })();
  return Object.assign(stream, { close: () => undefined, setModel: async () => undefined });
} }));
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { loadPlanProtocolFixture, parsePlanProtocolFixture, projectPlanProtocolCapture, sanitizePlanProtocolCapture } from "../plan-probes/fixture.js";
import { providerFixtureSourceHash } from "../fixture-safety.js";
import { containedPath } from "../plan-probes/runtime.js";
import type { ProviderEventDraft } from "../../host-ports.js";
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
  it("discovers and validates every committed capture without changing factory coverage", () => {
    const files = NodeFS.readdirSync(planFixtureDirectory);
    expect(files).toContain("s07-devin-01.captured.json");
    expect(files).toContain("s07-codex-03.captured.json");
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

  it("pins Devin's acknowledged plan mode and preserves Codex's unanswered initialize", () => {
    const devin = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-devin-01.captured.json"));
    expect(devin.input.messages.find((message) => message.kind === "reply" && message.operation === "session/set_config_option")!.fields).toContainEqual({ at: "configOptions.0.currentValue", kind: "literal", value: "plan" });
    const codex = loadPlanProtocolFixture(NodePath.join(planFixtureDirectory, "s07-codex-03.captured.json"));
    expect(codex.input.end).toEqual({ kind: "timeout" });
    expect(codex.input.messages.filter((message) => message.operation === "initialize").map((message) => message.kind)).toEqual(["request"]);
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
      },
      {
        scenario: "captured Cursor ACP tool and child lifecycle envelope replay",
        coveredProfiles: ["core", "build"],
        emittedEventTypes: ["toolUse", "toolUse", "toolResult", "toolUse", "toolUse", "toolResult"],
        toolNames: ["Agent", "Agent", "Read", "Read"],
        unsupportedMethods: [],
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
