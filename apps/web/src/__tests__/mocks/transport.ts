import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import type {
  McodeTransport,
  ProviderCatalogRequest,
} from "@/transport/types";
import { getDefaultSettings } from "@mcode/contracts";
import { vi } from "vitest";

const transportDefaults: Partial<McodeTransport> = {
  registerBrowserAutomationHost: vi.fn().mockResolvedValue({
    generation: 1,
    desktopInstanceId: "desktop-test",
  }),
  updateBrowserAutomationHostTargets: vi.fn().mockResolvedValue(undefined),
  respondToBrowserAutomationRequest: vi.fn().mockResolvedValue(undefined),
  heartbeatBrowserAutomationHost: vi.fn().mockResolvedValue(undefined),
  cancelBrowserAutomationRequest: vi.fn().mockResolvedValue(undefined),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  renameWorkspace: vi.fn().mockResolvedValue(createMockWorkspace()),
  resolveProjectIcons: vi.fn().mockResolvedValue([]),
  listProjectIconCandidates: vi.fn().mockResolvedValue({ files: [], total: 0 }),
  readWorkspaceEnvironment: vi.fn().mockResolvedValue({
    document: { version: "0.0.1", actions: [] },
    revision: null,
    status: "absent",
  }),
  saveWorkspaceEnvironment: vi.fn().mockImplementation(async (_workspaceId, document) => ({
    document,
    revision: "revision",
    status: "present",
  })),
  setWorkspaceEnvironmentStorageMode: vi.fn().mockResolvedValue({
    document: { version: "0.0.1", actions: [] },
    revision: null,
    status: "absent",
    storageMode: "system",
  }),
  approveWorkspaceEnvironmentCommand: vi.fn().mockResolvedValue(undefined),
  forgetWorkspaceEnvironmentApproval: vi.fn().mockResolvedValue(undefined),
  listWorkspaceActionRuns: vi.fn().mockResolvedValue([]),
  stopWorkspaceAction: vi.fn().mockResolvedValue(null),
  getWorkspaceActionRun: vi.fn().mockResolvedValue(null),
  deleteWorkspace: vi.fn().mockResolvedValue(true),
  touchLastOpened: vi.fn().mockResolvedValue(undefined),
  reorderWorkspace: vi.fn().mockResolvedValue(undefined),
  pinWorkspace: vi.fn().mockResolvedValue(undefined),
  removeRecent: vi.fn().mockResolvedValue(undefined),
  enrichWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
  filesystemBrowse: vi.fn().mockResolvedValue({ path: "/", parent: null, entries: [], requestedPath: "folder", isTooBroad: false }),
  listThreads: vi.fn().mockResolvedValue([]),
  listRecentThreads: vi.fn().mockResolvedValue([]),
  searchThreads: vi.fn().mockResolvedValue({ threads: [], workspaces: [] }),
  deleteThread: vi.fn().mockResolvedValue(true),
  completeThread: vi.fn().mockResolvedValue(createMockThread()),
  reopenThread: vi.fn().mockResolvedValue(createMockThread()),
  countBlockedThreadCleanupCandidates: vi.fn().mockResolvedValue({ count: 0 }),
  retryThreadCleanup: vi.fn().mockResolvedValue(createMockThread()),
  listRefs: vi.fn().mockResolvedValue({ ok: true, items: [], total: 0, nextCursor: null }),
  searchCommits: vi.fn().mockResolvedValue({ ok: true, commits: [], matchCount: 0, totalCount: 0 }),
  listPullRequestTargets: vi.fn().mockResolvedValue({ ok: true, items: [], total: 0, nextCursor: null }),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
  checkoutBranch: vi.fn().mockResolvedValue(undefined),
  createBranch: vi.fn().mockResolvedValue({ branch: "feat/test" }),
  listWorktrees: vi.fn().mockResolvedValue([]),
  sendMessage: vi.fn().mockResolvedValue(1),
  listHeldSteers: vi.fn().mockResolvedValue([]),
  retryErroredTurn: vi.fn().mockResolvedValue({ turnId: "turn-resume" }),
  scheduleTurnResume: vi.fn().mockImplementation(async ({ turnId, at }: { turnId: string; at: string }) => ({ turnId, at })),
  unscheduleTurnResume: vi.fn().mockResolvedValue(undefined),
  resumeInterruptedTurn: vi.fn().mockResolvedValue({ turnId: "turn-resume", mode: "native-session" }),
  retrySave: vi.fn().mockResolvedValue({ retried: false }),
  getThreadStartup: vi.fn().mockResolvedValue(null),
  listThreadStartups: vi.fn().mockResolvedValue({ records: [] }),
  continueWithoutSaving: vi.fn().mockResolvedValue(undefined),
  stopAgent: vi.fn().mockImplementation((threadId: string) => Promise.resolve({
    threadId,
    turnExecutionId: null,
    snapshot: { threadId, turnExecutionId: null, phase: "idle" },
    status: "already-terminal",
    dispatchState: "unknown",
  })),
  respondToApproval: vi.fn().mockResolvedValue(undefined),
  listPendingApprovals: vi.fn().mockResolvedValue([]),
  answerPlanQuestions: vi.fn().mockResolvedValue(undefined),
  dismissPlanQuestions: vi.fn().mockResolvedValue(undefined),
  getActiveAgentCount: vi.fn().mockResolvedValue(0),
  listRunning: vi.fn().mockResolvedValue([]),
  subscribeThread: vi.fn().mockResolvedValue(undefined),
  unsubscribeThread: vi.fn().mockResolvedValue(undefined),
  getThreadGoal: vi.fn().mockResolvedValue({
    goal: null,
    authoritative: true,
    source: "unsupported",
    reason: "unsupported-provider",
  }),
  confirmMessage: vi.fn().mockResolvedValue({ admitted: false }),
  clearThreadGoal: vi.fn().mockResolvedValue({
    goal: null,
    authoritative: true,
    source: "unsupported",
    reason: "unsupported-provider",
  }),
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  loadSubagentRoster: vi.fn().mockResolvedValue({
    owningParentThreadId: "thread-1",
    epoch: "test-boot",
    revision: 0,
    entries: [],
    truncated: false,
  }),
  loadSubagentDetail: vi.fn().mockResolvedValue({ entryId: "", steps: [], totalSteps: 0, summary: null }),
  stopCanonicalSubagent: vi.fn().mockResolvedValue({
    childThreadId: "child-1",
    status: "interrupted",
  }),
  updateThreadTitle: vi.fn().mockResolvedValue(true),
  updateThreadSettings: vi.fn().mockResolvedValue(true),
  listAttention: vi.fn().mockResolvedValue([]),
  acknowledgeSeen: vi.fn().mockResolvedValue({ previous: { sequence: null, at: null }, current: { sequence: null, at: null } }),
  syncThreadPrs: vi.fn().mockResolvedValue([]),
  discoverConfig: vi.fn().mockResolvedValue({}),
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
  getStage: vi.fn().mockResolvedValue("stable"),
  readClipboardImage: vi.fn().mockResolvedValue(null),
  saveClipboardFile: vi.fn().mockResolvedValue(null),
  listWorkspaceFiles: vi.fn().mockResolvedValue({ paths: [], truncated: false }),
  getWorkspaceFileChanges: vi.fn().mockResolvedValue({ git: true, entries: [], truncated: false }),
  refreshWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
  getReviewComparison: vi.fn().mockResolvedValue({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } }),
  generateCommitMessage: vi.fn().mockResolvedValue({
    status: "ok",
    subject: "chore: update files",
    body: "",
    model: { provider: "claude", id: "haiku", name: "Haiku 5.5" },
  }),
  commitChanges: vi.fn().mockResolvedValue({
    status: "committed",
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    branch: "main",
    push: { status: "skipped" },
  }),
  readFileContent: vi.fn().mockResolvedValue({ kind: "text", path: "", size: 0, encoding: "utf-8", content: "", changedLines: null }),
  readFileAtRef: vi.fn().mockResolvedValue(""),
  listOpenInApps: vi.fn().mockResolvedValue([]),
  openIn: vi.fn().mockResolvedValue(undefined),
  getBranchPr: vi.fn().mockResolvedValue(null),
  cancelPullRequestOperation: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
  checkStatus: vi.fn().mockResolvedValue({ aggregate: "no_checks", runs: [], fetchedAt: 0 }),
  getProviderCatalog: vi.fn().mockImplementation(async (request: ProviderCatalogRequest) => ({
    providerId: request.providerId,
    context: request.workspaceId
      ? { scope: "workspace" as const, workspaceId: request.workspaceId, ...(request.threadId ? { threadId: request.threadId } : {}) }
      : request.cwd
        ? { scope: "path" as const, cwd: request.cwd }
        : { scope: "user" as const },
    freshness: { status: "fresh" as const, fetchedAt: "2026-07-20T12:00:00.000Z" },
    diagnostics: [],
    entries: [],
    selectableAgents: [],
  })),
  terminalCapabilities: vi.fn().mockResolvedValue({
    contractVersion: 0,
    backend: "legacy",
    publicFrameVersion: 0,
    recovery: { replay: true, checkpoint: true, gap: true },
  }),
  terminalProfileList: vi.fn().mockResolvedValue({ certified: [], custom: [] }),
  terminalProfileCreate: vi.fn().mockResolvedValue({
    id: "custom:11111111-1111-4111-8111-111111111111",
    name: "Custom",
    executable: "sh",
    arguments: [],
  }),
  terminalProfileUpdate: vi.fn().mockResolvedValue({
    id: "custom:11111111-1111-4111-8111-111111111111",
    name: "Custom",
    executable: "sh",
    arguments: [],
  }),
  terminalProfileDelete: vi.fn().mockResolvedValue({ deleted: true }),
  terminalProfileSetDefault: vi.fn().mockResolvedValue({ defaultProfileId: "automatic" }),
  terminalWorkspacePreferencesGet: vi.fn().mockImplementation((workspaceId: string) =>
    Promise.resolve({ workspaceId, defaultProfileId: null })),
  terminalWorkspacePreferencesUpdate: vi.fn().mockImplementation((workspaceId: string, defaultProfileId: string) =>
    Promise.resolve({ workspaceId, defaultProfileId })),
  terminalWorkspacePreferencesReset: vi.fn().mockResolvedValue({ reset: true }),
  terminalPreferencesReset: vi.fn().mockResolvedValue({ reset: true }),
  terminalPreferencesUpdate: vi.fn().mockImplementation(async (input) => ({
    terminal: {
      presentation: { ...getDefaultSettings().terminal.presentation, ...input.presentation },
      behavior: { ...getDefaultSettings().terminal.behavior, ...input.behavior },
      accessibility: { ...getDefaultSettings().terminal.accessibility, ...input.accessibility },
    },
  })),
  terminalCreate: vi.fn().mockResolvedValue({ ptyId: "pty-mock-1", shell: "pwsh" }),
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  terminalResize: vi.fn().mockResolvedValue(undefined),
  terminalKill: vi.fn().mockResolvedValue(undefined),
  terminalPause: vi.fn().mockResolvedValue(undefined),
  terminalResume: vi.fn().mockResolvedValue(undefined),
  terminalSubscribe: vi.fn(() => () => {}),
  terminalDetachForSwitch: vi.fn().mockResolvedValue(undefined),
  terminalKillByThread: vi.fn().mockResolvedValue(undefined),
  terminalReattach: vi.fn().mockResolvedValue({ mode: "delta" }),
  terminalCheckpoint: vi.fn().mockResolvedValue({ accepted: true }),
  terminalListActive: vi.fn().mockResolvedValue([]),
  terminalHasChildren: vi.fn().mockResolvedValue({ hasChildren: false }),
  terminalDiagnostics: vi.fn().mockResolvedValue({
    contractVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    backend: "legacy",
    health: {
      contractVersion: 1,
      state: "healthy",
      hostGeneration: "0",
      activeSessions: 0,
      lastHeartbeatMsAgo: null,
      queueBytes: 0,
      eventLoopLagMs: 0,
      hostRssBytes: "0",
    },
    events: [],
    counters: [],
    histograms: [],
  }),
  listToolCallRecords: vi.fn().mockResolvedValue([]),
  listToolCallRecordsByParent: vi.fn().mockResolvedValue([]),
  listNarrative: vi.fn().mockResolvedValue({ tools: [], thoughts: [], hooks: [] }),
  loadTurn: vi.fn().mockResolvedValue([]),
  getThreadTasks: vi.fn().mockResolvedValue(null),
  getPlanSnapshot: vi.fn().mockResolvedValue({ versions: [], comments: [], phase: null, pendingQuestions: null, pendingImplement: null }),
  getSnapshotDiff: vi.fn().mockResolvedValue(""),
  getTurnDiffComparison: vi.fn().mockResolvedValue({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } }),
  listReviewTurns: vi.fn().mockResolvedValue([]),
  previewTurnRevert: vi.fn().mockResolvedValue({ status: "nothing_to_revert" }),
  applyTurnRevert: vi.fn().mockResolvedValue({ status: "unavailable", reason: "snapshot_missing" }),
  undoTurnRevert: vi.fn().mockResolvedValue({ status: "unavailable", reason: "recovery_expired" }),
  getTurnDiffFile: vi.fn().mockResolvedValue(""),
  getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
  cleanupSnapshots: vi.fn().mockResolvedValue({ removed: 0 }),
  listSnapshots: vi.fn().mockResolvedValue([]),
    getCumulativeDiff: vi.fn().mockResolvedValue(""),
    getCumulativeDiffStats: vi.fn().mockResolvedValue({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } }),
  getGitLog: vi.fn().mockResolvedValue([]),
  getCommitDiff: vi.fn().mockResolvedValue(""),
  getCommitFiles: vi.fn().mockResolvedValue([]),
  getWorkingTreeDiff: vi.fn().mockResolvedValue(""),
  getBranchDiff: vi.fn().mockResolvedValue(""),
  getBranchComparison: vi
    .fn()
    .mockResolvedValue({
      base: null,
      compare: null,
      isUnborn: false,
      isComparisonAvailable: false,
    }),
  getRemoteUrl: vi.fn().mockResolvedValue({ webUrl: null, label: "test-project" }),
  getReviewState: vi.fn().mockResolvedValue({ isGitRepo: true, head: "abc123", branch: "main", uncommitted: { staged: 0, unstaged: 0, untracked: 0 }, commitsAhead: null, branchDefault: { unavailable: "no-base" } }),
  push: vi.fn().mockResolvedValue({ success: true }),
  generatePrDraft: vi.fn().mockResolvedValue({ title: "", body: "" }),
  createPr: vi.fn().mockResolvedValue({ number: 1, url: "" }),
  getSettings: vi.fn().mockImplementation(() => Promise.resolve(structuredClone(getDefaultSettings()))),
  updateSettings: vi.fn().mockImplementation(() => Promise.resolve(structuredClone(getDefaultSettings()))),
  listProviderModels: vi.fn().mockResolvedValue([]),
  listProviderModes: vi.fn().mockResolvedValue(null),
  listProviderAvailability: vi.fn().mockResolvedValue([]),
  listProviderStatus: vi.fn().mockResolvedValue([]),
  acknowledgeProviderModels: vi.fn().mockResolvedValue(undefined),
  setBackground: vi.fn().mockResolvedValue(undefined),
  getProviderUsage: vi.fn().mockResolvedValue({
    providerId: "claude",
    quotaCategories: [],
  }),
  generateRecap: vi.fn().mockResolvedValue({ text: "Mock recap" }),
  readLatestHandoff: vi.fn().mockResolvedValue(null),
};

const inspectionKeys = new Set([
  "then", "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "constructor",
]);

/** Shared transport fake with stable async spies for methods without explicit defaults. */
export const mockTransport: McodeTransport = new Proxy(transportDefaults, {
  get(target, key) {
    if (typeof key !== "string" || inspectionKeys.has(key)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      Object.defineProperty(target, key, {
        value: vi.fn(async () => undefined),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Reflect.get(target, key);
  },
}) as McodeTransport;

vi.mocked(mockTransport.loadConversationPage).mockImplementation(
  async (threadId: string, limit: number, before?: number) => {
    const result = await mockTransport.getMessages(threadId, limit, before);
    return { ...result, narrativeByMessage: {} };
  },
);

vi.mocked(mockTransport.loadOlderConversationPage).mockImplementation(
  async (request) => {
    const result = await mockTransport.loadConversationPage(
      request.threadId,
      request.limit,
      request.cursor.beforeSequence,
    );
    return {
      ...result,
      identity: {
        threadId: request.threadId,
        cursor: request.cursor,
        direction: request.direction,
        generation: request.generation,
        conversationRevision: request.conversationRevision,
      },
      nextCursor: result.hasMore && result.messages.length > 0
        ? { version: 1, beforeSequence: result.messages[0].sequence }
        : null,
    };
  },
);
