# Mcode docs

Start with [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), and [ARCHITECTURE.md](../ARCHITECTURE.md).

Most code changes do not need a documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding or updating a page.

## Internals

Architectural decisions and their reasons, cross-component constraints, and
implementation traps that are hard to discover from the source.

- [Agent workflow](internals/agent-workflow.md): implementation and focused-check workflow
- [Narrative pipeline](internals/narrative-pipeline.md): timeline derivation and event traps
- [Provider architecture](internals/provider-architecture.md): adapter contract and SessionRuntime convention
- [Codex app-server trace](internals/codex-app-server-trace.md): observed Codex protocol evidence
- [Codex narrative spec](internals/codex-narrative-spec.md): Codex event-to-narrative mapping
- [Cursor SDK migration handoff](internals/cursor-sdk-migration.md)
- [Chat fork handoff](internals/chat-fork-handoff.md)
- [Composer overlays](internals/composer-overlays.md)
- [UI component registry](internals/ui-components.md): component rules and live verification
- [Database migrations](internals/db-migrations.md)
- [Settings schema conventions](internals/settings-schema.md)
- [Pull request mutations](internals/pull-request-mutations.md)
- [Pull request review worktrees](internals/pull-request-review-worktrees.md)
- [Last turn changes](internals/turn-diff-review.md)
- [Completed-thread worktree cleanup](internals/thread-cleanup.md)
- [Browser v2 operations](internals/browser-v2-rollout.md)
- [Mcode runtime agent instructions](internals/mcode-agent-instructions.md)
- [Performance audit checklist](internals/performance-audit.md)
- [SQLite performance profile](internals/sqlite-performance-profile.md)
- [Shiki in the web worker](internals/shiki-worker.md)
- [Terminal workload corpus](internals/terminal-workload-corpus.md)

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

## Specs

Dated pre-implementation design docs. Snapshots, not living documentation.

- [2026-04-13: Markdown rendering and Mermaid visualizer](specs/2026-04-13-md-rendering-mermaid-design.md)
- [2026-04-14: Usage tracking and quota display](specs/2026-04-14-usage-tracking-design.md)
- [2026-04-22: Dynamic context window discovery and user override](specs/2026-04-22-dynamic-context-window-design.md)
- [2026-05-01: Project sort order and draggable sidebar](specs/2026-05-01-project-sort-order-design.md)
- [2026-06-16: Thread overview](specs/2026-06-16-thread-overview-design.md)
- [2026-07-11: Pull request inbox and review worktrees](specs/2026-07-11-pull-request-inbox-and-review-worktrees.md)
- [2026-07-20: Review files navigator](specs/2026-07-20-review-files-navigator.md)
- [2026-07-22: Desktop title bar and navigation history](specs/2026-07-22-desktop-title-bar-navigation.md)
- [2026-07-25: Agent thread control contract](specs/2026-07-25-agent-thread-control-contract.md)

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
- `design/`, `performance/`, `plans/`, `prototypes/`, `research/`, and
  `security/` hold point-in-time working material. They are not maintained
  documentation; move durable knowledge into `docs/internals/` or an ADR.
