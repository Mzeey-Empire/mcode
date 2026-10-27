import type { ApprovalRequest } from "./models/approval.js";
import type { Workspace } from "./models/workspace.js";
import type { Thread } from "./models/thread.js";
import type { Message } from "./models/message.js";

/** A valid approval used to arrange transport and store tests. */
export function createMockApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "req-1", threadId: "thread-1", providerId: "codex", requestedAt: "2026-10-10T10:00:00Z",
    subject: { kind: "command", command: "git status" },
    choices: [{ id: "allow", intent: "allow_once", label: "Allow once" }, { id: "deny", intent: "deny", label: "Deny" }],
    origin: { kind: "agent" }, ...overrides,
  };
}

/**
 * Build a mock {@link Workspace} with stable defaults for tests.
 * Override any field via the `overrides` argument; the returned object is a
 * fresh shallow copy so callers can freely mutate it without affecting siblings.
 */
export function createMockWorkspace(
  overrides?: Partial<Workspace>,
): Workspace {
  return {
    id: crypto.randomUUID(),
    name: "test-project",
    path: "/tmp/test-project",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: null,
    sort_order: 0,
    deleted_at: null,
    icon_path: null,
    ...overrides,
  };
}

/** Build a mock `Thread` with stable defaults for tests. */
export function createMockThread(overrides?: Partial<Thread>): Thread {
  return {
    id: crypto.randomUUID(),
    workspace_id: crypto.randomUUID(),
    title: "Test Thread",
    status: "active",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    base_branch: null,
    head_sha: null,
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    scheduled_resume: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    fast_mode: null,
    devin_mode: null,
    default_open_in_app: null,
    parent_thread_id: null,
    delegation_coordinator_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    plan_phase: null,
    has_file_changes: false,
    ...overrides,
  };
}

/** Build a mock {@link Message} with stable defaults for tests. */
export function createMockMessage(overrides?: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    thread_id: crypto.randomUUID(),
    role: "user",
    content: "Hello",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: new Date().toISOString(),
    sequence: 1,
    attachments: null,
    ...overrides,
  };
}
