import type { RevertFilePlan, TurnRevertPreview, TurnRevertResult } from "@mcode/contracts/models/turn-revert";
import { basename } from "@/lib/path";

type ReadyPreview = Extract<TurnRevertPreview, { status: "ready" }>;
type UnavailableReason = Extract<TurnRevertPreview, { status: "unavailable" }>["reason"];
type BusyReason = Extract<TurnRevertPreview, { status: "busy" }>["reason"];
/** An apply or undo outcome the confirm or receipt must explain. */
export type RevertFailure = Exclude<TurnRevertResult, { status: "reverted" | "stale" }>;

const UNAVAILABLE_COPY: Readonly<Record<UnavailableReason, string>> = {
  not_git: "Not a git repository",
  snapshot_missing: "This turn's snapshot is gone",
  snapshot_pruned: "This turn's snapshot is gone",
  worktree_missing: "This turn's worktree no longer exists",
  no_attributed_files: "No files in this turn can be reverted",
  recovery_expired: "Undo is no longer available",
};

const BUSY_COPY: Readonly<Record<BusyReason, string>> = {
  turn_running: "Wait for the turn to finish",
  revert_running: "Wait for the other revert to finish",
};

/** Why a preview cannot become a revert, or null when it can. */
export function previewBlockedReason(preview: TurnRevertPreview): string | null {
  switch (preview.status) {
    case "ready":
      return null;
    case "nothing_to_revert":
      return "Already reverted";
    case "busy":
      return BUSY_COPY[preview.reason];
    case "unavailable":
      return UNAVAILABLE_COPY[preview.reason];
  }
}

/** Files a revert would still write. Paths already back at their pre-turn state are not counted. */
export function revertableFiles(preview: ReadyPreview): RevertFilePlan[] {
  return preview.files.filter((file) => file.state !== "already_reverted");
}

/** "Revert N files to before this turn?" */
export function turnRevertTitle(preview: ReadyPreview): string {
  const count = revertableFiles(preview).length;
  return `Revert ${count} ${count === 1 ? "file" : "files"} to before this turn?`;
}

/** The one warning sentence for edits a revert would also remove, or null for a clean preview. */
export function revertWarning(preview: ReadyPreview): string | null {
  const changed = preview.files.filter((file) => file.state === "changed_later");
  const first = changed[0];
  if (!first) return null;
  const name = basename(first.path);
  if (changed.length > 1) {
    const others = changed.length - 1;
    return `${name} and ${others} other ${others === 1 ? "file was" : "files were"} edited later. Reverting removes those edits too.`;
  }
  return first.changedBy === "later_turn"
    ? `${name} was edited by a later turn. Reverting removes those edits too.`
    : `${name} changed after this turn. Reverting removes those changes too.`;
}

/** The muted note for changes the turn made through commands, which revert cannot attribute. */
export function unattributedNote(preview: ReadyPreview): string | null {
  return preview.unattributedChangeCount > 0 ? "Files changed by commands in this turn are not reverted." : null;
}

/** Copy for an apply or undo outcome, and whether trying again can help. */
export function failureCopy(failure: RevertFailure): { text: string; retry: boolean } {
  if (failure.status === "busy") return { text: BUSY_COPY[failure.reason], retry: false };
  if (failure.status === "unavailable") return { text: UNAVAILABLE_COPY[failure.reason], retry: false };
  if (failure.outcome === "recovery_failed") {
    const count = failure.paths.length;
    return {
      text: `Couldn't put back ${count} ${count === 1 ? "file" : "files"}: ${failure.paths.map(basename).join(", ")}. Check Review › Unstaged.`,
      retry: false,
    };
  }
  const subject = failure.paths[0] ? basename(failure.paths[0]) : "files";
  const after = failure.outcome === "unchanged" ? "Nothing was changed." : "Files were put back as they were.";
  return { text: `Couldn't revert ${subject} · ${failure.detail.replace(/\.$/, "")}. ${after}`, retry: true };
}
