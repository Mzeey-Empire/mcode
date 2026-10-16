import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
  encodeEnvironmentDocument,
  WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES,
  WorkspaceEnvironmentCommandSchema,
  WorkspaceEnvironmentDocumentSchema,
  WorkspaceEnvironmentActionRunSchema,
  WorkspaceEnvironmentErrorSchema,
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
    expect(workspaceEnvironmentValidationIssues(ninth.error).map((issue) => issue.reason)).toEqual(["too_many_startup_actions"]);
  });
});
