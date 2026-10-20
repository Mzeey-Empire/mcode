import { describe, expect, it } from "vitest";
import { WS_CHANNELS } from "../../ws/channels.js";
import {
  actionSchedule,
  DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
  encodeEnvironmentDocument,
  normalizeAction,
  WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES,
  WorkspaceEnvironmentCommandSchema,
  WorkspaceEnvironmentDocumentSchema,
  WorkspaceEnvironmentActionRunSchema,
  WorkspaceEnvironmentErrorSchema,
  WorkspaceEnvironmentLoopbackUrlSchema,
  WorkspaceEnvironmentAutomaticSetupSnapshotSchema,
  WorkspaceEnvironmentAutomaticSetupStopInputSchema,
  WorkspaceEnvironmentAutomaticSetupRetryInputSchema,
  workspaceEnvironmentValidationIssues,
} from "../workspace-environment.js";

const validCommand = { default: "bun run dev" };
const validDocument = {
  version: "0.0.1",
  actions: [{ id: "opaque-id", name: "Run app", command: validCommand }],
};

describe("encodeEnvironmentDocument", () => {
  it("keeps an untouched default at 0.0.1", () => {
    const encoded = encodeEnvironmentDocument(DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT);
    expect(encoded.document).toEqual({ version: "0.0.1", actions: [] });
    expect(new TextDecoder().decode(encoded.bytes)).toBe('{"version":"0.0.1","actions":[]}');
  });

  it("rejects legacy Setup at the save boundary", () => {
    expect(() => encodeEnvironmentDocument({ ...validDocument, setup: validCommand })).toThrow();
  });

  it("derives 0.0.1 when a 0.1.0 document has no new fields", () => {
    const encoded = encodeEnvironmentDocument({ version: "0.1.0", actions: [] });
    expect(encoded.document).toEqual({ version: "0.0.1", actions: [] });
    expect(new TextDecoder().decode(encoded.bytes)).toBe('{"version":"0.0.1","actions":[]}');
  });

  it.each([
    { icon: "future-tool" },
    { runOnStartup: true },
    { runOnStartup: false },
    { runOnCleanup: true },
    { runOnCleanup: false },
    { futureAction: { enabled: false } },
  ])("writes 0.1.0 for action metadata %j", (metadata) => {
    const action = { id: "run", name: "Run", command: validCommand, ...metadata };
    const input = { version: "0.0.1", actions: [action] };
    const encoded = encodeEnvironmentDocument(input);
    const expected = { version: "0.1.0", actions: [action] };
    expect(encoded.document).toEqual(expected);
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(expected);
    expect(input.version).toBe("0.0.1");
  });

  it("writes 0.1.0 and preserves an unknown action key named constructor", () => {
    const action = { id: "run", name: "Run", command: validCommand, constructor: "future-constructor" };
    const encoded = encodeEnvironmentDocument({ version: "0.0.1", actions: [action] });
    const expected = { version: "0.1.0", actions: [action] };
    expect(encoded.document).toEqual(expected);
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(expected);
  });

  it("writes 0.1.0 for unknown top-level keys", () => {
    const encoded = encodeEnvironmentDocument({ version: "0.0.1", actions: [], future: { order: ["run"] } });
    const expected = { version: "0.1.0", actions: [], future: { order: ["run"] } };
    expect(encoded.document).toEqual(expected);
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(expected);
  });

  it("rejects promotion while legacy Setup is still present", () => {
    expect(() => encodeEnvironmentDocument({ ...validDocument, setup: validCommand, future: true })).toThrow();
  });

  it("encodes a legacy-flag document with the same bytes as before the scheduling keys existed", () => {
    const action = { id: "run", name: "Run", command: validCommand, icon: "bolt", runOnStartup: true, runOnCleanup: false };
    const encoded = encodeEnvironmentDocument({ version: "0.0.1", actions: [action] });
    expect(new TextDecoder().decode(encoded.bytes)).toBe(
      '{"version":"0.1.0","actions":[{"id":"run","name":"Run","command":{"default":"bun run dev"},"icon":"bolt","runOnStartup":true,"runOnCleanup":false}]}',
    );
  });

  it("keeps an undefined legacy value from promoting the document", () => {
    const encoded = encodeEnvironmentDocument({
      version: "0.1.0", actions: [{ id: "run", name: "Run", command: validCommand, icon: undefined }],
    });
    expect(encoded.document.version).toBe("0.0.1");
  });

  it.each([
    ["waitForExit without runOnStartup", { waitForExit: false as const }],
    ["waitForExit with runOnStartup off", { runOnStartup: false, waitForExit: false as const }],
    ["a false runOnSettle", { runOnSettle: false }],
  ])("drops the inert or default key for %s", (_label, metadata) => {
    const input = { version: "0.1.0", actions: [{ id: "run", name: "Run", command: validCommand, ...metadata }] };
    const encoded = encodeEnvironmentDocument(input);
    const stored = encoded.document.actions[0];
    expect(stored).not.toHaveProperty("waitForExit");
    expect(stored).not.toHaveProperty("runOnSettle");
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(encoded.document);
  });

  it("falls back to 0.0.1 when dropping inert keys leaves only legacy keys", () => {
    const encoded = encodeEnvironmentDocument({
      version: "0.1.0", actions: [{ id: "run", name: "Run", command: validCommand, runOnSettle: false }],
    });
    expect(new TextDecoder().decode(encoded.bytes)).toBe(
      '{"version":"0.0.1","actions":[{"id":"run","name":"Run","command":{"default":"bun run dev"}}]}',
    );
  });

  it.each([
    { runOnStartup: true, waitForExit: false as const },
    { runOnSettle: true },
    { openPreview: true as const },
    { openPreview: "http://localhost:5173/app" },
  ])("round-trips %j at 0.1.0 without reordering keys", (metadata) => {
    const action = { id: "run", name: "Run", command: validCommand, ...metadata };
    const encoded = encodeEnvironmentDocument({ version: "0.0.1", actions: [action] });
    expect(encoded.document).toEqual({ version: "0.1.0", actions: [action] });
    const bytes = new TextDecoder().decode(encoded.bytes);
    expect(WorkspaceEnvironmentDocumentSchema().parse(JSON.parse(bytes))).toEqual(encoded.document);
    expect(Object.keys(JSON.parse(bytes).actions[0])).toEqual(Object.keys(action));
  });

  it("keeps the order of keys that follow an inert key it removes", () => {
    const encoded = encodeEnvironmentDocument({
      version: "0.1.0",
      actions: [{ id: "run", name: "Run", command: validCommand, waitForExit: false, runOnCleanup: true, openPreview: true }],
    });
    expect(Object.keys(encoded.document.actions[0] ?? {})).toEqual(["id", "name", "command", "runOnCleanup", "openPreview"]);
  });
});

describe("normalizeAction", () => {
  const base = { id: "run", name: "Run", command: validCommand };

  it("keeps waitForExit false only while runOnStartup is on", () => {
    expect(normalizeAction({ ...base, runOnStartup: true, waitForExit: false })).toEqual({ ...base, runOnStartup: true, waitForExit: false });
    expect(normalizeAction({ ...base, runOnStartup: false, waitForExit: false })).toEqual({ ...base, runOnStartup: false });
  });

  it("does not mutate its input", () => {
    const action = { ...base, waitForExit: false as const };
    normalizeAction(action);
    expect(action).toHaveProperty("waitForExit", false);
  });

  it("leaves unknown keys alone", () => {
    expect(normalizeAction({ ...base, futureAction: [1] })).toEqual({ ...base, futureAction: [1] });
  });
});

describe("actionSchedule", () => {
  const base = { id: "run", name: "Run", command: validCommand };

  it("keeps today's behavior for an action with no scheduling keys", () => {
    expect(actionSchedule(base)).toEqual({ startup: null, settle: false, cleanup: false, preview: null });
  });

  it("gates on exit unless waitForExit is false", () => {
    expect(actionSchedule({ ...base, runOnStartup: true }).startup).toEqual({ gate: "wait" });
    expect(actionSchedule({ ...base, runOnStartup: true, waitForExit: false }).startup).toEqual({ gate: "release" });
  });

  it("ignores waitForExit when the action does not run on startup", () => {
    expect(actionSchedule({ ...base, waitForExit: false }).startup).toBeNull();
    expect(actionSchedule({ ...base, runOnStartup: false, waitForExit: false }).startup).toBeNull();
  });

  it("reads settle and cleanup as booleans", () => {
    expect(actionSchedule({ ...base, runOnSettle: true, runOnCleanup: true })).toMatchObject({ settle: true, cleanup: true });
    expect(actionSchedule({ ...base, runOnSettle: false, runOnCleanup: false })).toMatchObject({ settle: false, cleanup: false });
  });

  it("opens the detected URL when preview is on without one, and the configured URL otherwise", () => {
    expect(actionSchedule({ ...base, openPreview: true }).preview).toEqual({ url: null });
    expect(actionSchedule({ ...base, openPreview: "http://localhost:3000/x" }).preview).toEqual({ url: "http://localhost:3000/x" });
  });
});

describe("loopback preview URL", () => {
  const parse = (value: unknown) => WorkspaceEnvironmentLoopbackUrlSchema().safeParse(value);
  const origin = "http://localhost:3000/";

  it.each([
    "http://localhost:5173/app?x=1#top",
    "https://localhost",
    "http://127.0.0.1:8080",
    "http://[::1]:3000/",
    "http://0.0.0.0:3000/",
    "HTTP://LOCALHOST:3000/",
  ])("accepts %s", (url) => {
    expect(parse(url).success).toBe(true);
  });

  it("stores the trimmed URL", () => {
    expect(parse("  http://localhost:3000/  ").data).toBe("http://localhost:3000/");
  });

  it.each([
    "https://example.com/",
    "http://localhost.evil.com/",
    "http://localhost@evil.com/",
    "http://127.0.0.1.nip.io/",
    "http://192.168.1.5:3000/",
    "ftp://localhost/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "localhost:3000",
    "not a url",
    "",
    "   ",
    123,
    false,
  ])("rejects %j", (value) => {
    expect(parse(value).success).toBe(false);
  });

  it("accepts exactly 2048 characters and rejects 2049", () => {
    const atLimit = origin + "a".repeat(2_048 - origin.length);
    expect(parse(atLimit).success).toBe(true);
    expect(parse(`${atLimit}a`).success).toBe(false);
  });

  it("reports a bad host on the openPreview field with the copy the editor shows", () => {
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse({
      version: "0.1.0",
      actions: [{ id: "run", name: "Run", command: validCommand, openPreview: "https://example.com/" }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(workspaceEnvironmentValidationIssues(parsed.error)).toEqual([
      { path: ["actions", 0, "openPreview"], code: "CUSTOM", reason: "invalid_value", message: "Use a localhost URL" },
    ]);
  });

  it("rejects openPreview false and waitForExit true so neither is ever stored", () => {
    for (const metadata of [{ openPreview: false }, { waitForExit: true }]) {
      const parsed = WorkspaceEnvironmentDocumentSchema().safeParse({
        version: "0.1.0", actions: [{ id: "run", name: "Run", command: validCommand, ...metadata }],
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe("workspace.environment.action.updated push", () => {
  const run = {
    threadId: "thread-1", workspaceId: "workspace-1", actionId: "web", runId: "run-1", revision: 1,
    terminalSessionId: "terminal-1", trigger: "manual", port: null, actionName: "Web", status: "running",
    snapshot: { platform: "windows", script: "bun run dev", checkoutPath: "C:\\repo", terminal: null, environmentNames: [] },
    createdAt: "2026-10-20T12:00:00.000Z", startedAt: "2026-10-20T12:00:00.000Z", finishedAt: null, exitCode: null,
  };
  const envelope = { threadId: "thread-1", actionId: "web", runId: "run-1", run };
  const channel = WS_CHANNELS["workspace.environment.action.updated"];

  it("accepts an update with and without the one-time preview instruction", () => {
    expect(channel.safeParse(envelope).success).toBe(true);
    expect(channel.safeParse({ ...envelope, openPreview: { url: "http://localhost:5173/" } }).data?.openPreview).toEqual({ url: "http://localhost:5173/" });
  });

  it("refuses a preview instruction that points off the loopback hosts", () => {
    expect(channel.safeParse({ ...envelope, openPreview: { url: "https://example.com/" } }).success).toBe(false);
    expect(channel.safeParse({ ...envelope, openPreview: { url: "http://localhost:5173/", extra: 1 } }).success).toBe(false);
  });

  it("keeps the preview instruction out of the retained run", () => {
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({ ...run, openPreview: { url: "http://localhost:5173/" } }).success).toBe(false);
  });
});

describe("workspace environment contracts", () => {
  it("accepts the exact versioned document shape and preserves action ids", () => {
    const result = WorkspaceEnvironmentDocumentSchema().parse(validDocument);
    expect(result).toEqual(validDocument);
    expect(result.actions[0]?.id).toBe("opaque-id");
  });

  it("rejects missing scripts, byte-boundary overflow, null bytes, and unknown command keys", () => {
    expect(WorkspaceEnvironmentCommandSchema().safeParse({}).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "x".repeat(WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES + 1) }).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "é".repeat(Math.floor(WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES / 2) + 1) }).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "ok\0bad" }).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "ok", extra: "no" }).success).toBe(false);
  });

  it.each(["0.0.1", "0.1.0"])("accepts version %s and preserves unknown document and action keys", (version) => {
    const document = {
      version,
      futureDocument: { enabled: true },
      actions: [{ id: "run", name: "Run", command: validCommand, futureAction: [1, "two"] }],
    };
    expect(WorkspaceEnvironmentDocumentSchema().parse(document)).toEqual(document);
  });

  it("rejects 0.1.0 Setup with a field-level migration message", () => {
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse({ ...validDocument, setup: validCommand, version: "0.1.0" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(workspaceEnvironmentValidationIssues(parsed.error)).toEqual([{
      path: ["setup"],
      code: "INVALID_VALUE",
      reason: "invalid_value",
      message: "Move Setup into a startup action.",
    }]);
  });

  it.each(["document", "action"])("counts unknown %s keys toward the 512KB cap", (location) => {
    const extra = { future: "é".repeat(262_144) };
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse({
      version: "0.1.0",
      ...(location === "document" ? extra : {}),
      actions: [{ id: "run", name: "Run", command: validCommand, ...(location === "action" ? extra : {}) }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(workspaceEnvironmentValidationIssues(parsed.error)).toEqual([
      expect.objectContaining({ path: [], reason: "document_too_large" }),
    ]);
  });

  it.each(["future-tool", "a", "a".repeat(32)])("accepts portable icon id %s", (icon) => {
    const document = { version: "0.1.0", actions: [{ id: "run", name: "Run", command: validCommand, icon }] };
    expect(WorkspaceEnvironmentDocumentSchema().parse(document)).toEqual(document);
  });

  it.each(["", "Uppercase", "-tool", "../tool", "a".repeat(33)])("rejects invalid icon id %s", (icon) => {
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse({
      version: "0.1.0", actions: [{ id: "run", name: "Run", command: validCommand, icon }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(workspaceEnvironmentValidationIssues(parsed.error)).toEqual([
      expect.objectContaining({ path: ["actions", 0, "icon"], reason: "invalid_value" }),
    ]);
  });

  it("returns stable structured reasons for unsupported versions and size limits", () => {
    const version = WorkspaceEnvironmentDocumentSchema().safeParse({ ...validDocument, version: "0.2.0" });
    expect(version.success).toBe(false);
    if (!version.success) {
      expect(workspaceEnvironmentValidationIssues(version.error)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["version"], code: "UNSUPPORTED_VERSION", reason: "unsupported_version" }),
      ]));
    }

    const command = WorkspaceEnvironmentCommandSchema().safeParse({ default: "x".repeat(32_760), windows: "x".repeat(32_760) });
    expect(command.success).toBe(false);
    if (!command.success) {
      expect(workspaceEnvironmentValidationIssues(command.error)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "COMMAND_TOO_LARGE", reason: "command_too_large" }),
      ]));
    }
    expect(WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES).toBe(64 * 1024);
  });

  it("rejects duplicate action ids with a path to the duplicate", () => {
    const result = WorkspaceEnvironmentDocumentSchema().safeParse({
      ...validDocument,
      actions: [validDocument.actions[0], { ...validDocument.actions[0], name: "Run again" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(workspaceEnvironmentValidationIssues(result.error)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["actions", 1, "id"],
          code: "DUPLICATE_ACTION_ID",
          reason: "duplicate_action_id",
        }),
      ]));
    }
  });

  it("preserves a nonblank default when an OS override is blank", () => {
    const command = WorkspaceEnvironmentCommandSchema().parse({
      default: "  bun run setup  ",
      windows: " \t ",
    });

    expect(command).toEqual({ default: "  bun run setup  ", windows: " \t " });
  });

  it("accepts the retained latest Action result and rejects obsolete transcript data", () => {
    const run = WorkspaceEnvironmentActionRunSchema().parse({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      actionId: "build",
      runId: "run-1",
      revision: 1,
      terminalSessionId: "terminal-1",
      trigger: "manual",
      port: null,
      actionName: "Build",
      status: "completed",
      snapshot: {
        platform: "windows",
        script: "bun run build",
        checkoutPath: "C:\\repo",
        terminal: {
          executable: "C:\\Program Files\\PowerShell\\pwsh.exe",
          arguments: ["-NoLogo", "-NonInteractive", "-Command", "bun run build"],
        },
        environmentNames: ["PATH", "TEMP"],
      },
      createdAt: "2026-08-22T12:00:00.000Z",
      startedAt: "2026-08-22T12:00:00.000Z",
      finishedAt: "2026-08-22T12:00:05.000Z",
      exitCode: 0,
    });

    expect(run.status).toBe("completed");
    expect(run.trigger).toBe("manual");
    const port = { runId: "earlier-run", host: "localhost", port: 5173, url: "http://localhost:5173/", reachable: false, detectedAt: "2026-08-22T11:00:00.000Z" };
    expect(WorkspaceEnvironmentActionRunSchema().parse({ ...run, port }).port?.runId).toBe("earlier-run");
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({ ...run, port: { ...port, reachable: true } }).success).toBe(false);
    const running = { ...run, status: "running", finishedAt: null, exitCode: null };
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({ ...running, port: { ...port, reachable: true } }).success).toBe(false);
    expect(WorkspaceEnvironmentActionRunSchema().parse({ ...running, port: { ...port, runId: "run-1", reachable: true } }).port?.reachable).toBe(true);
    expect(WorkspaceEnvironmentActionRunSchema().parse({ ...run, trigger: "startup", terminalSessionId: null }).trigger).toBe("startup");
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({ ...run, trigger: "scheduled" }).success).toBe(false);
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({
      ...run,
      transcript: "obsolete output",
    }).success).toBe(false);
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({
      ...run,
      revision: -1,
    }).success).toBe(false);
  });

  it("accepts the Action lifecycle errors returned by the RPC boundary", () => {
    expect(WorkspaceEnvironmentErrorSchema().parse({
      code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
      message: "This Project Action is already running for this Thread",
    }).code).toBe("WORKSPACE_ENVIRONMENT_ACTION_RUNNING");
    expect(WorkspaceEnvironmentErrorSchema().parse({
      code: "WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND",
      message: "Project Action not found",
    }).code).toBe("WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND");
  });

  it("accepts automatic sequence lifecycle records and rejects obsolete command results", () => {
    const attempt = {
      id: "attempt-1", state: "queued", reason: null, failedActionId: null,
      createdAt: "2026-10-16T12:00:00.000Z", startedAt: null, finishedAt: null,
    };
    const snapshot = { gate: "blocked", attempt, queuedTurns: [] };
    expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().parse(snapshot)).toEqual(snapshot);
    for (const obsolete of ["snapshot", "outcome", "exitCode", "output", "outputTruncated"]) {
      expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().safeParse({
        ...snapshot, attempt: { ...attempt, [obsolete]: null },
      }).success).toBe(false);
    }
    expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().safeParse({
      ...snapshot, attempt: { ...attempt, state: "passed" },
    }).success).toBe(false);
    const passed = { ...attempt, state: "passed", startedAt: attempt.createdAt, finishedAt: attempt.createdAt };
    expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().parse({ ...snapshot, gate: "released-by-pass", attempt: passed }).attempt).toEqual(passed);
    expect(WorkspaceEnvironmentAutomaticSetupStopInputSchema().safeParse({ threadId: "" }).success).toBe(false);
    expect(WorkspaceEnvironmentAutomaticSetupRetryInputSchema().safeParse({ threadId: "thread-1", extra: true }).success).toBe(false);
  });

  it("accepts eight startup actions with full-size scripts and rejects the ninth with its stable reason", () => {
    const actions = Array.from({ length: 8 }, (_, index) => ({
      id: `action-${index}`, name: `Action ${index}`, runOnStartup: true,
      command: { default: "x".repeat(32 * 1024) },
    }));
    const document = { version: "0.1.0", actions };
    expect(WorkspaceEnvironmentDocumentSchema().parse(document)).toEqual(document);
    const ninth = WorkspaceEnvironmentDocumentSchema().safeParse({
      ...document, actions: [...actions, { ...actions[0], id: "ninth" }],
    });
    expect(ninth.success).toBe(false);
    if (ninth.success) throw new Error("Expected the startup limit");
    expect(workspaceEnvironmentValidationIssues(ninth.error)).toEqual([expect.objectContaining({
      reason: "too_many_startup_actions", message: "At most 8 actions can run on startup.",
    })]);
  });
});
