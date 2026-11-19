/** Prefix of the notice key on every planned-restart notice; a wake's key ends with its anchor turn id. */
export const PLANNED_RESTART_NOTICE_KEY_PREFIX = "planned-restart:";

/** Prefix of the notice key on the note that boot stopped a thread's leftover background commands. */
export const BACKGROUND_RESTART_NOTICE_KEY_PREFIX = "background-restart:";

/**
 * True for the note that boot stopped background commands. It keeps the `warning` kind, which the
 * transcript hides for provider warnings, so the key prefix is what lets the timeline show it.
 */
export function isBackgroundRestartNotice(notice: { systemNotice?: { noticeKey?: string } | null }): boolean {
  return notice.systemNotice?.noticeKey?.startsWith(BACKGROUND_RESTART_NOTICE_KEY_PREFIX) === true;
}

/** Output written on a background tool call that a planned restart stopped. */
export const ORPHANED_BACKGROUND_TOOL_OUTPUT = "Stopped when Mcode restarted.";

/** How a planned restart continued a thread: resuming an interrupted turn, or waking a finished one. */
export type PlannedRestartAction = "resume" | "wake";
/** Whether the continuation started or could not start. */
export type PlannedRestartResult = "started" | "failed";

const NOTICE_TEXT: Record<PlannedRestartAction, Record<PlannedRestartResult, string>> = {
  resume: { started: "Resumed after Mcode restarted", failed: "Could not resume after Mcode restarted" },
  wake: { started: "Woke after Mcode restarted", failed: "Could not wake after Mcode restarted" },
};
/** Every planned-restart failure text, for readers that match failures in stored rows. */
export const PLANNED_RESTART_FAILURE_TEXTS: readonly string[] = [NOTICE_TEXT.resume.failed, NOTICE_TEXT.wake.failed];
const FAILURE_TEXTS: ReadonlySet<string> = new Set(PLANNED_RESTART_FAILURE_TEXTS);

/** The single definition of every planned-restart notice text, shared by the server that writes it and the web that reads it. */
export function plannedRestartNoticeText(action: PlannedRestartAction, result: PlannedRestartResult): string {
  return NOTICE_TEXT[action][result];
}

/** The fields of a saved system notice that identify a planned-restart notice. */
export interface PlannedRestartNoticeFields {
  content: string;
  systemNotice?: { noticeKey?: string } | null;
}

/** True only for a planned-restart notice: its key carries the planned-restart prefix. */
export function isPlannedRestartNotice(notice: PlannedRestartNoticeFields): boolean {
  return notice.systemNotice?.noticeKey?.startsWith(PLANNED_RESTART_NOTICE_KEY_PREFIX) === true;
}

/**
 * True for a planned-restart failure. Failures keep the `diagnostic` kind because the transcript hides
 * `warning` notices, so the key prefix and the exact failure text together identify them.
 */
export function isPlannedRestartFailure(notice: PlannedRestartNoticeFields): boolean {
  return isPlannedRestartNotice(notice) && FAILURE_TEXTS.has(notice.content);
}
