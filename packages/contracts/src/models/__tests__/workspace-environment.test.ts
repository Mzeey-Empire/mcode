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
  WorkspaceEnvironmentSetupAttemptSchema,
  WorkspaceEnvironmentAutomaticSetupSnapshotSchema,
  WorkspaceEnvironmentQueuedTurnCancelInputSchema,
  WorkspaceEnvironmentAutomaticSetupStopInputSchema,
  WorkspaceEnvironmentAutomaticSetupRetryInputSchema,
  WorkspaceEnvironmentAutomaticSetupTerminalInputSchema,
  WorkspaceEnvironmentAutomaticSetupTerminalSchema,
  workspaceEnvironmentValidationIssues,
} from "../workspace-environment.js";

const validCommand = { default: "bun run dev" };
const validDocument = {
  version: "0.0.1",
  setup: validCommand,
  actions: [{ id: "opaque-id", name: "Run app", command: validCommand }],
};

describe("encodeEnvironmentDocument", () => {
  it("keeps an untouched default at 0.0.1", () => {
    const encoded = encodeEnvironmentDocument(DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT);
    expect(encoded.document).toEqual({ version: "0.0.1", actions: [] });
    expect(new TextDecoder().decode(encoded.bytes)).toBe('{"version":"0.0.1","actions":[]}');
  });

  it("preserves legacy Setup and platform overrides without migrating", () => {
    const document = {
      ...validDocument,
      setup: { default: "bun install", windows: "bun install --frozen-lockfile" },
    };
    const encoded = encodeEnvironmentDocument(document);
    expect(encoded.document).toEqual(document);
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(document);
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
    expect(() => encodeEnvironmentDocument({ ...validDocument, future: true })).toThrow("Move Setup into an action first.");
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
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse({ ...validDocument, version: "0.1.0" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(workspaceEnvironmentValidationIssues(parsed.error)).toEqual([{
      path: ["setup"],
      code: "INVALID_VALUE",
      reason: "invalid_value",
      message: "Move Setup into an action first.",
    }]);
  });

  it.each(["document", "action"])("counts unknown %s keys toward the 128KB cap", (location) => {
    const extra = { future: "é".repeat(65_536) };
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

  it("carries Terminal-bounded immutable manual Setup outcomes without environment values", () => {
    const attempt = WorkspaceEnvironmentSetupAttemptSchema().parse({
      id: "attempt-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      status: "failed",
      outcome: "containment_failure",
      snapshot: {
        platform: "windows",
        script: "bun run setup",
        checkoutPath: "C:\\repo",
        terminal: {
          executable: "C:\\Program Files\\PowerShell\\pwsh.exe",
          arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "bun run setup"],
        },
      },
      createdAt: "2026-08-22T12:00:00.000Z",
      startedAt: "2026-08-22T12:00:00.000Z",
      finishedAt: "2026-08-22T12:00:05.000Z",
      exitCode: null,
      output: "Setup timed out",
      outputTruncated: false,
      cleanupPending: true,
    });

    expect(attempt.outcome).toBe("containment_failure");
    expect(attempt.snapshot.terminal?.arguments).toContain("-NonInteractive");
    expect(JSON.stringify(attempt)).not.toContain("SECRET_TOKEN");
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      cleanupPending: false,
      snapshot: {
        ...attempt.snapshot,
        terminal: {
          executable: "x".repeat(1_025),
          arguments: Array.from({ length: 33 }, () => "argument"),
        },
      },
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "running",
      outcome: null,
      startedAt: null,
      finishedAt: null,
      cleanupPending: false,
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "passed",
      outcome: "success",
      cleanupPending: false,
      exitCode: 1,
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "passed",
      outcome: "success",
      cleanupPending: false,
      exitCode: 0,
      startedAt: null,
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "failed",
      outcome: "success",
      cleanupPending: false,
      exitCode: 0,
    }).success).toBe(false);
  });

  it("accepts the retained latest Action result and rejects an unbounded transcript", () => {
    const run = WorkspaceEnvironmentActionRunSchema().parse({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      actionId: "build",
      runId: "run-1",
      revision: 1,
      terminalSessionId: "terminal-1",
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
      transcript: "done",
      transcriptTruncated: false,
    });

    expect(run.status).toBe("completed");
    expect(WorkspaceEnvironmentActionRunSchema().safeParse({
      ...run,
      transcript: "x".repeat(WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES * 9),
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

  it("accepts exact automatic gate lifecycle shapes and rejects unfinished results", () => {
    const queued = WorkspaceEnvironmentAutomaticSetupSnapshotSchema().parse({
      gate: "blocked",
      attempt: {
        id: "attempt-automatic-1",
        state: "queued",
        reason: null,
        snapshot: null,
        outcome: null,
        createdAt: "2026-08-22T12:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        output: "",
        outputTruncated: false,
      },
      queuedTurns: [{
        id: "submission-1",
        messageId: "message-1",
        state: "queued",
        createdAt: "2026-08-22T12:00:00.000Z",
        dispatchedAt: null,
      }, {
        id: "submission-2",
        messageId: "message-2",
        state: "queued",
        createdAt: "2026-08-22T12:00:01.000Z",
        dispatchedAt: null,
      }],
    });
    expect(queued.gate).toBe("blocked");
    expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().safeParse({
      ...queued,
      attempt: { ...queued.attempt, state: "failed", reason: null, finishedAt: null },
      extra: true,
    }).success).toBe(false);

    const dispatched = WorkspaceEnvironmentAutomaticSetupSnapshotSchema().parse({
      gate: "released-by-pass",
      attempt: {
        id: "attempt-automatic-1",
        state: "passed",
        reason: null,
        snapshot: {
          platform: "linux",
          script: "bun run setup",
          checkoutPath: "/repo/.worktrees/first",
          terminal: { executable: "sh", arguments: ["-c", "bun run setup"] },
        },
        outcome: "success",
        createdAt: "2026-08-22T12:00:00.000Z",
        startedAt: "2026-08-22T12:00:00.000Z",
        finishedAt: "2026-08-22T12:00:01.000Z",
        exitCode: 0,
        output: "done",
        outputTruncated: false,
      },
      queuedTurns: [{
        id: "submission-1",
        messageId: "message-1",
        state: "dispatched",
        createdAt: "2026-08-22T12:00:00.000Z",
        dispatchedAt: "2026-08-22T12:00:01.000Z",
      }],
    });
    expect(dispatched.queuedTurns).toHaveLength(1);
    expect(dispatched.queuedTurns[0]?.state).toBe("dispatched");
    expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().safeParse({
      ...dispatched,
      attempt: { ...dispatched.attempt, exitCode: 1 },
    }).success).toBe(false);
    expect(WorkspaceEnvironmentAutomaticSetupSnapshotSchema().safeParse({
      ...dispatched,
      queuedTurns: [{ ...dispatched.queuedTurns[0]!, dispatchedAt: null }],
    }).success).toBe(false);
  });

  it("validates strict targeted automatic Setup recovery inputs and Terminal results", () => {
    expect(WorkspaceEnvironmentQueuedTurnCancelInputSchema().safeParse({ threadId: "thread-1" }).success).toBe(false);
    expect(WorkspaceEnvironmentQueuedTurnCancelInputSchema().parse({ threadId: "thread-1", queuedTurnId: "queued-1" })).toEqual({ threadId: "thread-1", queuedTurnId: "queued-1" });
    expect(WorkspaceEnvironmentQueuedTurnCancelInputSchema().safeParse({ threadId: "thread-1", queuedTurnId: "queued-1", extra: true }).success).toBe(false);
    expect(WorkspaceEnvironmentAutomaticSetupStopInputSchema().safeParse({ threadId: "" }).success).toBe(false);
    expect(WorkspaceEnvironmentAutomaticSetupRetryInputSchema().safeParse({ threadId: "thread-1", extra: true }).success).toBe(false);
    expect(WorkspaceEnvironmentAutomaticSetupTerminalInputSchema().parse({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(WorkspaceEnvironmentAutomaticSetupTerminalSchema().safeParse({ ptyId: "pty-1", shell: "pwsh", extra: true }).success).toBe(false);
  });
});
