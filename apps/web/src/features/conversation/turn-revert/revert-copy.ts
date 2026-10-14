import type { RevertFilePlan, TurnRevertPreview, TurnRevertResult } from "@mcode/contracts";
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

/** Turn ordinals a file revert spans. `from === to` is a single turn. */
export interface FileRevertRange {
  readonly from: number;
  readonly to: number;
}

/** "Revert X to before Turn N?" The range's first turn, so a retried turn reads as before its first attempt. */
export function fileRevertTitle(path: string, range: FileRevertRange): string {
  return `Revert ${basename(path)} to before Turn ${range.from}?`;
}

function renameChainLead(preview: ReadyPreview, clickedPath: string): string | null {
  const normalize = (path: string) => path.split("\\").join("/");
  if (!preview.files.some((file) => normalize(file.path) !== normalize(clickedPath))) return null;
  const names = (actions: readonly RevertFilePlan["action"][]) =>
    revertableFiles(preview).filter((file) => actions.includes(file.action)).map((file) => basename(file.path));
  const restored = names(["restore", "recreate"]);
  const removed = names(["delete"]);
  if (restored.length === 0 && removed.length === 0) return null;
  const parts = [
    ...(restored.length > 0 ? [`Restores ${restored.join(", ")}`] : []),
    ...(removed.length > 0 ? [`${restored.length > 0 ? "removes" : "Removes"} ${removed.join(", ")}`] : []),
  ];
  return `${parts.join(" and ")}.`;
}

function rangeWarning(preview: ReadyPreview, range: FileRevertRange): string | null {
  const changed = preview.files.filter((file) => file.state === "changed_later");
  const first = changed[0];
  if (!first) return null;
  const others = changed.length - 1;
  const subject = others > 0 ? `${basename(first.path)} and ${others} other ${others === 1 ? "file" : "files"}` : basename(first.path);
  return `${subject} changed after Turn ${range.to}. Reverting removes those changes too.`;
}

/**
 * Body of the Revert file confirm: what changes, then a warning for edits made
 * after the range. A rename chain names the paths it restores and removes.
 */
export function fileRevertBody(preview: ReadyPreview, clickedPath: string, range: FileRevertRange): string {
  const single = range.from === range.to;
  const lead = renameChainLead(preview, clickedPath) ?? "Only this file changes.";
  const scope = single ? "The turn's other edits stay." : `Its changes from Turns ${range.from}–${range.to} are undone, and other files stay.`;
  const warning = single ? revertWarning(preview) : rangeWarning(preview, range);
  return [lead, scope, warning].filter((sentence) => sentence !== null).join(" ");
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
