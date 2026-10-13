import type { HeldApprovalNote } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore, type QueuedApprovalNote, type QueuedMessage } from "@/stores/queueStore";
import { scheduleDrainAfterEdit, useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";

type HeldNoteState = HeldApprovalNote["state"];

/** Notes open in the composer for editing. Their item is out of the queue, so a restore must not add another. */
const notesInEdit = new Set<string>();

/** Marks a note as open in the composer, or closes it. */
export function setApprovalNoteInEdit(requestId: string, editing: boolean): void {
  if (editing) notesInEdit.add(requestId);
  else notesInEdit.delete(requestId);
}

function noteMessage(threadId: string, requestId: string, note: string, state: HeldNoteState): QueuedMessage & { approvalNote: QueuedApprovalNote } {
  const thread = useWorkspaceStore.getState().threads.find((item) => item.id === threadId);
  return {
    id: crypto.randomUUID(),
    content: note,
    attachments: [],
    // Empty inherits the thread's model at send time; the server stores only the text.
    model: thread?.model ?? "",
    permissionMode: thread?.permission_mode ?? useThreadStore.getState().getThreadSettings(threadId).permissionMode,
    queuedAt: Date.now(),
    approvalNote: { requestId, state },
  };
}

/**
 * Adds a deny note to its thread's queue. A queued note sends when the turn ends, or now if it
 * already has; a delivery-unknown note waits for the user.
 */
export function queueApprovalNote(threadId: string, requestId: string, note: string, state: HeldNoteState): void {
  if (notesInEdit.has(requestId)) return;
  useQueueStore.getState().upsertApprovalNote(threadId, noteMessage(threadId, requestId, note, state));
  if (state === "queued") scheduleDrainAfterEdit(threadId);
}

/** Runs on every connect: every note the server still holds comes back to its thread's queue. */
export async function restoreApprovalNotes(): Promise<void> {
  const notes = await getTransport().listApprovalNotes();
  for (const held of notes) {
    if (notesInEdit.has(held.requestId)) continue;
    useQueueStore.getState().upsertApprovalNote(held.threadId, noteMessage(held.threadId, held.requestId, held.note, held.state));
  }
}

/**
 * Holds the item while the server answers, so no drain sends it meanwhile. Restores its
 * previous state and reports the failure when the server cannot be asked.
 */
async function settleNote<Status extends string>(
  threadId: string,
  message: QueuedMessage,
  call: (requestId: string) => Promise<{ status: Status }>,
): Promise<Status | null> {
  const note = message.approvalNote;
  if (!note || note.state === "settling") return null;
  const queue = useQueueStore.getState();
  queue.setApprovalNoteState(threadId, message.id, "settling");
  try {
    return (await call(note.requestId)).status;
  } catch (error) {
    useQueueStore.getState().setApprovalNoteState(threadId, message.id, note.state);
    const meta = error instanceof Error ? error.message : String(error);
    useToastStore.getState().show({ kind: "failed", title: "Could not settle the note", meta });
    return null;
  }
}

/** Send again on a delivery-unknown note: it becomes an ordinary queued note that admission claims once. */
export async function sendApprovalNoteAgain(threadId: string, message: QueuedMessage): Promise<void> {
  const status = await settleNote(threadId, message, (requestId) => getTransport().resendApprovalNote(requestId));
  if (status === null) return;
  const queue = useQueueStore.getState();
  // Closed means another window already sent or removed it.
  if (status === "closed") {
    queue.removeFromQueue(threadId, message.id);
    return;
  }
  queue.setApprovalNoteState(threadId, message.id, "queued");
  scheduleDrainAfterEdit(threadId);
}

/** Removes a note on the server first, so it does not come back on the next reconnect. */
export async function removeApprovalNote(threadId: string, message: QueuedMessage): Promise<void> {
  const status = await settleNote(threadId, message, (requestId) => getTransport().removeApprovalNote(requestId));
  if (status !== null) useQueueStore.getState().removeFromQueue(threadId, message.id);
}

/**
 * Saves an edited note on the server, where it survives a reload. A note that was already sent
 * or removed elsewhere leaves the queue.
 */
export async function saveApprovalNoteEdit(threadId: string, requestId: string, content: string): Promise<void> {
  const dropEditedNote = () => {
    const queue = useQueueStore.getState();
    const item = (queue.queues[threadId] ?? []).find((message) => message.approvalNote?.requestId === requestId);
    if (item) queue.removeFromQueue(threadId, item.id);
  };
  try {
    const result = await getTransport().updateApprovalNote(requestId, content);
    if (result.status === "closed") dropEditedNote();
  } catch (error) {
    const meta = error instanceof Error ? error.message : String(error);
    useToastStore.getState().show({ kind: "failed", title: "The note edit was not saved", meta });
  }
}

/** Removes a note the user emptied while editing it. */
export async function discardApprovalNote(requestId: string): Promise<void> {
  try {
    await getTransport().removeApprovalNote(requestId);
  } catch (error) {
    const meta = error instanceof Error ? error.message : String(error);
    useToastStore.getState().show({ kind: "failed", title: "Could not remove the note", meta });
  }
}
