# Mcode docs

Start with [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), and [ARCHITECTURE.md](../ARCHITECTURE.md).

Most code changes do not need a documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding or updating a page.

## Internals

Architectural decisions and their reasons, cross-component constraints, and
implementation traps that are hard to discover from the source.

Internal guides are grouped in topic subfolders. Use this index to find a guide.

### Conversation

- [Narrative pipeline](internals/conversation/narrative-pipeline.md): timeline derivation and event traps
- [Chat fork handoff](internals/conversation/chat-fork-handoff.md)
- [Composer drafts](internals/conversation/composer-drafts.md): draft ownership, attachment transfer, and dispatch restoration
- [Composer overlays](internals/conversation/composer-overlays.md)

### Providers

- [Provider architecture](internals/providers/provider-architecture.md): adapter contract and SessionRuntime convention
- [Codex app-server trace](internals/providers/codex-app-server-trace.md): observed Codex protocol evidence
- [Codex narrative spec](internals/providers/codex-narrative-spec.md): Codex event-to-narrative mapping
- [Cursor SDK migration handoff](internals/providers/cursor-sdk-migration.md): deferred migration context
- [Mcode runtime agent instructions](internals/providers/mcode-agent-instructions.md)

### Projects

- [Project environments](internals/projects/environment.md): Setup admission, command approval, and Action lifecycle
- [Completed-thread worktree cleanup](internals/projects/thread-cleanup.md)

### Review

- [Pull request mutations](internals/review/pull-request-mutations.md)
- [Pull request review worktrees](internals/review/pull-request-review-worktrees.md)
- [Last turn changes](internals/review/turn-diff-review.md)

### Renderer

- [UI component registry](internals/renderer/ui-components.md): component rules and live verification
- [Shiki in the web worker](internals/renderer/shiki-worker.md)

### Runtime

- [Terminal lifecycle](internals/runtime/terminal-lifecycle.md): shell ownership, host recovery, and packaged runtime constraints
- [Browser v2 operations](internals/runtime/browser-v2-rollout.md): automation lifecycle and guest security boundaries
- [Agent workflow](internals/runtime/agent-workflow.md): implementation and focused-check workflow

### Performance

- [Performance audit checklist](internals/performance/performance-audit.md)
- [Terminal workload corpus](internals/performance/terminal-workload-corpus.md)
- [SQLite performance profile](internals/performance/sqlite-performance-profile.md)

### Persistence and settings

- [Database migrations](internals/persistence/db-migrations.md)
- [Settings schema conventions](internals/persistence/settings-schema.md)

## Architecture decision records

Point-in-time decisions. New ADRs take the next free number below. Numbers
0018 and 0020 are each used twice historically; start new ADRs at 0023.

- [0001: Provider CLI discovery is per-provider; version policy is the one provider-blind seam](adr/0001-per-provider-cli-discovery-shared-version-policy.md)
- [0002: Preview tab discard policy](adr/0002-preview-tab-discard-policy.md)
- [0003: No in-app multi-engine browser preview](adr/0003-no-in-app-multi-engine-browser-preview.md)
- [0004: Right panel state split and singleton tabs](adr/0004-workspace-global-right-panel-singleton-tabs.md)
- [0005: Two-tier default open-in app](adr/0005-two-tier-default-open-in-app.md)
- [0006: External terminal launch does not share ShellEnvResolver](adr/0006-external-terminal-launch-no-shell-resolver-sharing.md)
- [0007: Branch comparison defaults upstream-first with three-dot range](adr/0007-branch-comparison-default-and-range.md)
- [0008: Backend memory policy](adr/0008-backend-memory-policy.md)
- [0009: Goals are thread state with transcript receipts](adr/0009-goals-are-thread-state-with-transcript-receipts.md)
- [0010: Terminal views detach; shell sessions persist](adr/0010-terminal-view-detach-shell-session-persists.md)
- [0011: Review default view per thread](adr/0011-review-default-view-per-thread.md)
- [0012: Right-panel container state per thread](adr/0012-right-panel-state-per-thread.md)
- [0013: Thread recap generation and caching](adr/0013-thread-recap-generation-and-caching.md)
- [0014: Persist typed mention metadata](adr/0014-persist-typed-mention-metadata.md)
- [0015: Branchless worktrees for new isolated threads](adr/0015-branchless-worktrees-for-new-isolated-threads.md)
- [0016: Preview rendering host switch](adr/0016-preview-rendering-host-switch.md)
- [0017: Separate maintained tests from disposable verification](adr/0017-separate-maintained-tests-from-disposable-verification.md)
- [0018: Codex app-server owns capability catalogs](adr/0018-codex-app-server-owns-capability-catalogs.md)
- [0018: Use the visible preview for agent browser automation](adr/0018-use-the-visible-preview-for-agent-browser-automation.md)
- [0019: Thread conversation residency ownership](adr/0019-thread-conversation-residency-ownership.md)
- [0020: Delete superseded nightly releases](adr/0020-delete-superseded-nightly-releases.md)
- [0020: Repeatable terminal tabs in right-panel order](adr/0020-repeatable-terminal-tabs-in-right-panel-order.md)
- [0021: Thread control authority and lifecycle](adr/0021-thread-control-authority-and-lifecycle.md)
- [0022: Server-owned streaming durability and provider-native recovery](adr/0022-server-owned-streaming-durability-and-provider-native-recovery.md)

## Agent runbooks

Procedures for agents operating this repository.

- [Runtime](agents/runtime.md): startup commands, environment variables, artifacts, write boundaries
- [Domain](agents/domain.md): domain docs for agent consumption
- [Issue tracker](agents/issue-tracker.md): GitHub issue workflows
- [Triage labels](agents/triage-labels.md)

## User docs

`docs/user/` holds task-oriented guides in the product's voice. Not yet
populated; see the [documentation rules](../AGENTS.md#documentation) before
adding pages.

## References and working material

- [Settings reference](settings/reference.md): per-setting reference for `settings.json`
- `design/`, `performance/`, `plans/`, `research/`, and
  `security/` hold point-in-time working material. They are not maintained
  documentation; move durable knowledge into `docs/internals/` or an ADR.
