# Composer draft ownership

A composer session belongs to one owner. Its input, attachments, and agent
selection must move together when navigation changes that owner. The editor is
a view of the session, not a second draft authority. See the
[composer glossary](../../../CONTEXT.md#composer) for product terms.

## Owners and settings

[`ComposerOwner`](../../../apps/web/src/features/conversation/composer/draft/composer-session-lifecycle.ts)
distinguishes a fresh `new` composer, a local `draft` entity, and a `thread`.
The owner key keeps a draft ID distinct from a thread ID.

A fresh composer uses global defaults. An ordinary new-thread composer with
sendable content in a workspace creates a local-only row in
[`threadDraftStore`](../../../apps/web/src/stores/threadDraftStore.ts) and binds
the composer to that draft. The row retains its agent selection and execution
target so reopening it does not adopt another draft's worktree or branch.

A thread reads unsent content and model selection from
[`composerDraftStore`](../../../apps/web/src/stores/composerDraftStore.ts) when
a saved draft exists. Its interaction and permission modes come from current
thread settings. Without a saved draft, the thread row supplies its session,
with defaults for missing values. Optional provider settings follow the
explicit saved-value fallbacks in
[`buildSavedComposerSession`](../../../apps/web/src/lib/composer-session/index.ts).
Loading global model and mode defaults does not replace a bound local draft's
stored selection.

## Navigation restores before it saves

[`useComposerFormController`](../../../apps/web/src/features/conversation/composer/draft/useComposerFormController.ts)
snapshots the departing session if its owner still exists, then installs the
incoming owner's resolved session. If the departing owner was deleted, the
transition releases its attachment resources instead of recreating the owner.

Opening a local draft also restores its execution target through
[`openThreadDraft`](../../../apps/web/src/features/projects/state/workspaceStore.ts).
The outgoing snapshot retains the departing draft's target because shared
new-thread controls may already contain the incoming draft's target.

Persistence waits until `restoredOwnerKey` matches the current owner key. This
state-based gate prevents the initial empty render and StrictMode effect replay
from overwriting a saved draft before restoration. Materializing a local draft
can change the owner while the user types. The controller avoids rewriting
identical editor content so that rebinding does not move the caret.

## Submission transfers attachment ownership

`clearSubmittedDraft` consumes only the revision captured for submission. If
the user has edited the session since that snapshot, it leaves the draft intact.
For a matching revision, it detaches attachments without releasing their
resources, clears the editor, and removes the saved draft through
`removeDraftAfterAttachmentTransfer`. A local draft row disappears at this point.
The dispatch snapshot retains the detached attachments and the consumed row
while dispatch is pending. New edits discard this rollback snapshot, so a later
failure cannot overwrite those edits.

`confirmSubmittedDispatch` releases the detached resources after success.
`restoreFailedDispatch` restores content when the submitted owner key still
matches. It also allows restoration when the snapshot contains a consumed
local draft row and the current owner key is `new`, restoring that row with its
original identity. The `new` key is shared by fresh composers; this check does
not establish workspace or generation identity. A different `draft` or `thread`
owner key cannot receive the failed submission's text or attachments.

Deleting a draft releases its attachments. Consuming it for dispatch transfers
them. Keep those operations distinct or submission can revoke resources still
needed by the dispatched payload.

See [composer overlays](../composer-overlays.md) for editor layout and the
[narrative pipeline](../narrative-pipeline.md#renderer-ownership) for transcript
residency, which has separate ownership from unsent composer state.
