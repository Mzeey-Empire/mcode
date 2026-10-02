# Chat Fork Handoff

How chat forking works in mcode and how to extend it.

## Overview

Clicking the fork icon on a message in a parent thread creates a child thread. The child receives a "handoff document" that summarises the parent conversation up to the fork point, giving the child's first turn full context without replaying every message token-by-token.

The document is produced either by the parent's provider (when the provider supports a side-channel query) or by a deterministic builder (when it does not). Either way the artifact is the same shape: a Markdown file with YAML frontmatter plus a JSON sidecar.

The [pipeline](../../../apps/server/src/features/handoff/orchestration/handoff-pipeline.ts)
selects the generation path. The
[coordinator](../../../apps/server/src/features/handoff/orchestration/handoff-coordinator.ts)
persists the artifact and delivers it to the child.

## The B/D ladder

The pipeline attempts path B when eligible, then falls back to path D if the
provider attempt fails. Ineligible parents go directly to D.

**Path B: clean-fork providers.** The pipeline calls the parent's
`forker.fork(request)` only when `sessionForkOnResume` is `"clean"` and the
parent has an `sdk_session_id`. The forker owns the isolated provider query,
which leaves the parent conversation unchanged. A stored session ID permits
the attempt; it does not guarantee that the provider can still recover it.

**Path D: deterministic fallback.** The local builder uses stored parent
context up to the fork point without a provider call. Unsupported providers,
unresolved providers, and parents without a session ID go directly to D.
This includes Devin: its unused history-replay side channel and descriptor
capability do not override its `"unsupported"` runtime flag. A clean provider
with no session ID also goes to D rather than a sessionless B-prime query.

Any path-B error falls back to D. The artifact records the error
classification, including transient errors and the 120-second abort timeout.
Generation fallback does not guarantee that later storage or delivery succeeds.

## Provider capabilities

The [provider interface](../../../packages/contracts/src/providers/interfaces.ts)
declares the runtime fork flag and forker. The
[`SessionForker` contract](../../../packages/contracts/src/providers/session-forker.ts)
defines the request and artifact. Concrete side-channel methods remain inside
provider implementations; the pipeline dispatches through the forker after
checking the flag and parent session ID.

## Storage layout

Each handoff is a ULID-named directory so lexicographic order equals chronological order:

```text
<MCODE_DATA_DIR>/threads/<threadId>/handoffs/<ulid>/handoff.md
<MCODE_DATA_DIR>/threads/<threadId>/handoffs/<ulid>/handoff.json
```

`handoff.md` contains YAML frontmatter (schema version, provenance, ladder step, mode) followed by the handoff body.

`handoff.json` is the full `HandoffMeta` object: provenance, error classification if any, attachment manifest, and regeneration history.

Attachments copied from parent messages land at:

```text
<MCODE_DATA_DIR>/threads/<threadId>/attachments/<id>.<ext>
```

## Delivery and document size

Full-versus-minimal selection and the 115% section-boundary truncation guard
are retired. `HandoffMeta.mode` and YAML frontmatter retain the constant
`"full"` for provenance compatibility. The provider's
`maxInputCharactersPerTurn` no longer selects a document mode or body budget.

The coordinator normally writes the document to an OS temp file. The child's
first-turn prompt contains its path, a short fallback summary, and the user's
message. A [scoped pre-grant](../../../apps/server/src/features/agents/permissions/scoped-pre-grant.ts)
allows one `Read` of that exact file during the child's first turn. The grant
is consumed once and cleared when the turn ends.

Adapters without that read path receive bounded inline delivery. Currently
the coordinator selects this path for Codex: the document plus user message
is capped at 14,000 characters, with truncation notices when needed. If the
combined prompt exceeds the cap, the user message receives up to 4,000
characters and the document uses the remaining space. The full artifact
remains stored. This delivery limit does not change the artifact's mode.

If the temp-file write fails, the coordinator falls back to the document
inline. That fallback does not apply the Codex delivery cap.

## Robustness

The pipeline includes several guards to avoid blocking or corrupting the fork flow:

- **120-second abort signal.** The pipeline supplies a timed `AbortSignal` to the provider forker. The forker must respect it. An aborted provider call falls to path D with `reason: "transient"`.
- **Fork history budget.** Parent history is read in newest-first pages under a byte budget. The handoff records when older history was elided.
- **25 MB attachment size cap.** `HandoffStorage.copyAttachments` skips any attachment larger than 25 MB and records a sentinel `sha256: "<skipped>"` in the manifest.
- **Abandoned-child cleanup.** Before writing the artifact, the coordinator re-fetches the child thread. A missing or deleted child aborts delivery before an artifact is written.
- **Anchor persistence.** Delivery waits for the child's handoff message to be saved. An unknown anchor commit outcome fails delivery rather than attempting a second anchor through legacy replay.

## Settings

`chat.handoff.notifyOnLocalFallback` (default `true`) -- when true, the UI shows a notice when the handoff fell back to path D (deterministic) due to a provider error. Set to `false` to suppress the notice.

## Adding a new provider

1. Verify whether an isolated query can resume the parent session without mutating it. Use `"clean"` only when the adapter supports that behavior. Otherwise use `"unsupported"`, which sends the public pipeline directly to D.

2. Set the runtime flag and supply a forker that implements the linked `SessionForker` contract. Keep provider-specific side-channel operations inside the adapter or its forker. Respect the request's abort signal and retire any throwaway resources.

3. Verify the child's delivery path in the coordinator. Use file delivery only when the adapter can read the artifact under the scoped grant; otherwise provide bounded inline delivery.

4. Add focused behavior coverage for the supported path, provider failure, and missing parent session ID. Run the relevant workspace tests through its configured runner, for example:

   ```sh
   bun run --cwd apps/server test -- src/features/handoff/orchestration/__tests__/handoff-pipeline.test.ts
   ```
