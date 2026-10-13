import type { HeldApprovalNote } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore, type QueuedApprovalNote, type QueuedMessage } from "@/stores/queueStore";
import { scheduleDrainAfterEdit, useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";

type HeldNoteState = HeldApprovalNote["state"];

const notesInEdit = new Set<string>();

/** Marks a note as open in the composer, or closes it. */
export function setApprovalNoteInEdit(requestId: string, editing: boolean): void {
  if (editing) notesInEdit.add(requestId);
  else notesInEdit.delete(requestId);
}

type QueuePayload = Omit<QueuedMessage, "id" | "queuedAt">;

function noteMessage(threadId: string, requestId: string, note: string, state: HeldNoteState): QueuedMessage & { approvalNote: QueuedApprovalNote } {
  const thread = useWorkspaceStore.getState().threads.find((item) => item.id === threadId);
  return {
    id: crypto.randomUUID(),
    content: note,
    attachments: [],
    model: thread?.model ?? "",
    permissionMode: thread?.permission_mode ?? useThreadStore.getState().getThreadSettings(threadId).permissionMode,
    queuedAt: Date.now(),
    approvalNote: { requestId, state },
  };
}

function findNote(threadId: string, requestId: string): QueuedMessage | undefined {
  return (useQueueStore.getState().queues[threadId] ?? []).find((message) => message.approvalNote?.requestId === requestId);
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

/**
 * Runs on every connect. Edits the server never saved are saved first, then every note the
 * server still holds comes back to its thread's queue.
 */
export async function restoreApprovalNotes(): Promise<void> {
  const unsaved = Object.entries(useQueueStore.getState().queues).flatMap(([threadId, messages]) =>
    messages.flatMap((message) => message.approvalNote?.state === "unsaved" ? [resaveNote(threadId, message)] : []));
  await Promise.all(unsaved);
  const notes = await getTransport().listApprovalNotes();
  for (const held of notes) {
    if (notesInEdit.has(held.requestId)) continue;
    useQueueStore.getState().upsertApprovalNote(held.threadId, noteMessage(held.threadId, held.requestId, held.note, held.state));
  }
}

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
  if (status === "closed") {
    queue.removeFromQueue(threadId, message.id);
    return;
  }
  queue.setApprovalNoteState(threadId, message.id, "queued");
  scheduleDrainAfterEdit(threadId);
}

/** Removes a note on the server first, so it does not come back on the next reconnect. Returns whether it left. */
export async function removeApprovalNote(threadId: string, message: QueuedMessage): Promise<boolean> {
  const status = await settleNote(threadId, message, (requestId) => getTransport().removeApprovalNote(requestId));
  if (status !== null) useQueueStore.getState().removeFromQueue(threadId, message.id);
  return status !== null;
}

/**
 * Puts an edited note back in its slot and saves the edit on the server, where it survives a
 * reload. Admission sends the server's text, so the slot is held until the save lands.
 */
export function requeueEditedNote(threadId: string, index: number, payload: QueuePayload, requestId: string): boolean {
  const held = { ...payload, approvalNote: { requestId, state: "settling" as const } };
  if (!useQueueStore.getState().insertAt(threadId, index, held)) return false;
  void saveNoteEdit(threadId, requestId, payload.content);
  return true;
}

async function resaveNote(threadId: string, message: QueuedMessage): Promise<void> {
  const requestId = message.approvalNote?.requestId;
  if (!requestId) return;
  useQueueStore.getState().setApprovalNoteState(threadId, message.id, "settling");
  await saveNoteEdit(threadId, requestId, message.content);
}

/** An unsaved edit stays held, because sending it would deliver the server's older text. */
async function saveNoteEdit(threadId: string, requestId: string, content: string): Promise<void> {
  let status: "updated" | "closed";
  try {
    status = (await getTransport().updateApprovalNote(requestId, content)).status;
  } catch (error) {
    setNoteState(threadId, requestId, "unsaved");
    const meta = error instanceof Error ? error.message : String(error);
    useToastStore.getState().show({ kind: "failed", title: "The note edit was not saved", meta });
    return;
  }
  if (status === "closed") {
    const item = findNote(threadId, requestId);
    if (item) useQueueStore.getState().removeFromQueue(threadId, item.id);
    return;
  }
  setNoteState(threadId, requestId, "queued");
  scheduleDrainAfterEdit(threadId);
}

function setNoteState(threadId: string, requestId: string, state: QueuedApprovalNote["state"]): void {
  const item = findNote(threadId, requestId);
  if (item) useQueueStore.getState().setApprovalNoteState(threadId, item.id, state);
}

/**
 * Removes a note the user emptied while editing it. The original holds its slot until the server
 * removes it, so a failed removal leaves it queued. Returns whether it left.
 */
export async function discardEditedNote(threadId: string, index: number, original: QueuePayload): Promise<boolean> {
  const requestId = original.approvalNote?.requestId;
  if (!requestId || !useQueueStore.getState().insertAt(threadId, index, original)) return false;
  const item = findNote(threadId, requestId);
  return item ? removeApprovalNote(threadId, item) : false;
}
