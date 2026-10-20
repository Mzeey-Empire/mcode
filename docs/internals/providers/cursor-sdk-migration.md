# Cursor SDK migration

Status: deferred pending authentication compatibility.

The May 2026 investigation found that `@cursor/sdk` v1.0.13 required an API
key and could not reuse the CLI's saved login. That finding must be rechecked
against the SDK version considered for migration. Requiring users to supply
another credential would expand the scope beyond replacing the transport.

The current [Cursor provider](../../../packages/providers/src/private/cursor/cursor-provider.ts)
uses the long-lived `cursor-agent acp` subprocess. A future migration to
`@cursor/sdk` should preserve turn ownership, event translation, cancellation,
permissions, and native session continuity while replacing the subprocess
transport. Verify CLI login reuse and supported account tiers before choosing
the SDK.

## Context transfer is independent of transport

[Handoff v2](../conversation/chat-fork-handoff.md) supplies a budgeted selection
of stored history inline for provider switch, fork, and recovery. It needs
neither an outgoing provider call nor an SDK session fork. Changing Cursor's
transport must preserve the existing v2 boundary rather than introduce a new
context-transfer mechanism. See [ADR 0031](../../adr/0031-handoff-v2-budgeted-transcript-selection.md).

## Existing session compatibility

Do not assume ACP session identifiers can be resumed by the SDK. Verify that
contract explicitly. If the identifiers are incompatible, define how the
provider reports invalid native sessions so the existing recovery path can
start a fresh session with v2 history. Keep the durable thread and its
conversation intact.

Validate first sends, native resume, eviction, cancellation, permission
requests, stream completion, and invalid-session recovery through the provider
factory and conformance tests. A transport migration must retain these
behaviors even when the SDK exposes different primitives.
