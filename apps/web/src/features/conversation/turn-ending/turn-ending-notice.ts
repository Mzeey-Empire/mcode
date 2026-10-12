import type { AgentTurnEnding, InterruptionCause, PersistedTurnFailure, SystemStopReason, TurnOutcome } from "@mcode/contracts";
import { workFoldLabel } from "../turn/WorkFold";

/** Everything the end-notice table reads about one logical turn's latest attempt. */
export interface TurnEndingInput {
  status: TurnOutcome;
  ending: AgentTurnEnding | null;
  providerStartedAt: string | null;
  durationMs: number | null;
  /** Display name of the thread's provider, for example "Codex". */
  providerLabel: string;
  /** True while the provider status reports the user signed out. */
  providerSignedOut: boolean;
  /** ISO time of the user's scheduled retry of this turn, or null. */
  scheduledResumeAt: string | null;
  /** Epoch ms the table reads time against; a reset already past offers plain Retry. */
  now: number;
  /** The thread's first turn, whose pre-frame ending the startup trail owns. */
  isStartupTurn: boolean;
  /** Only the thread's latest turn can be retried or resumed. */
  isLatestTurn: boolean;
  executionId: string | null;
}

/** A user action a filled notice can offer. */
export type TurnEndAction = "retry" | "retry_at" | "cancel_retry" | "switch_model" | "sign_in" | "resume";

/** A quiet one-line ending: no fill, muted title. */
export interface QuietNotice {
  style: "quiet";
  title: string;
  detail?: string;
}

/** A filled ending with a cause, optional raw Details, and actions. */
export interface FilledNotice {
  style: "filled";
  icon: "failed" | "usage_limit" | "interrupted";
  title: string;
  detail?: string;
  /** Raw provider text plus the turn line, shown behind "Details". */
  details?: string;
  secondary?: { action: "switch_model"; label: string };
  primary?: NoticePrimary;
}

/** A notice's primary action; Retry at carries the reset time it schedules for. */
export type NoticePrimary =
  | { action: "retry_at"; label: string; at: string }
  | { action: Exclude<TurnEndAction, "switch_model" | "retry_at">; label: string };

/** The notice under a settled turn. */
export type TurnEndNoticeView = QuietNotice | FilledNotice;

/** How one turn ending renders: its work fold label (null hides the fold) and its notice. */
export interface TurnEndingView {
  foldLabel: string | null;
  notice: TurnEndNoticeView | null;
}

/** Value equality, because projections rebuild notices on every canonical change. */
export function sameTurnEndNotice(left: TurnEndNoticeView, right: TurnEndNoticeView): boolean {
  const before = noticeFields(left);
  const after = noticeFields(right);
  return before.length === after.length && before.every((field, index) => field === after[index]);
}

function noticeFields(notice: TurnEndNoticeView): ReadonlyArray<string | undefined> {
  if (notice.style === "quiet") return [notice.style, notice.title, notice.detail];
  const { primary, secondary } = notice;
  return [notice.style, notice.icon, notice.title, notice.detail, notice.details, primary?.action, primary?.label, primary?.action === "retry_at" ? primary.at : undefined, secondary?.label];
}

const STATUS_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
};

const LIMIT_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
};

const MCODE_STOP_NOTICES: Readonly<Record<Exclude<SystemStopReason, "thread_deleted">, QuietNotice>> = {
  approval_unanswerable: { style: "quiet", title: "Stopped by Mcode", detail: "Mcode couldn't answer an approval request" },
  thread_control: { style: "quiet", title: "Stopped by another thread" },
};

const HIDDEN: TurnEndingView = { foldLabel: null, notice: null };

/** Maps a turn's persisted ending to its fold label and end notice. */
export function turnEndingView(input: TurnEndingInput): TurnEndingView {
  if (input.status === "completed") return { foldLabel: workFoldLabel("completed", input.durationMs), notice: null };
  const providerStarted = input.providerStartedAt !== null;
  if (input.isStartupTurn && !providerStarted) return HIDDEN;
  const foldLabel = providerStarted ? workFoldLabel(input.status, input.durationMs) : null;
  if (input.status === "cancelled") return cancelledView(input, foldLabel);
  if (input.status === "interrupted") return { foldLabel, notice: interruptedNotice(input) };
  return { foldLabel, notice: erroredNotice(input) };
}

function cancelledView(input: TurnEndingInput, foldLabel: string | null): TurnEndingView {
  // Rows written before stop causes existed read as a user stop.
  const stop = input.ending?.outcome === "cancelled" ? input.ending.stop : { by: "user" as const };
  if (stop.by === "mcode") {
    return stop.reason === "thread_deleted" ? HIDDEN : { foldLabel, notice: MCODE_STOP_NOTICES[stop.reason] };
  }
  return input.providerStartedAt === null
    ? { foldLabel: null, notice: { style: "quiet", title: `Stopped before ${input.providerLabel} started` } }
    : { foldLabel, notice: { style: "quiet", title: "You stopped" } };
}

const INTERRUPTION_DETAILS: Readonly<Record<InterruptionCause, (provider: string) => string>> = {
  app_closed: (provider) => `Mcode closed while ${provider} was working`,
  provider_exited: (provider) => `${provider} stopped unexpectedly`,
  saving_stopped: (provider) => `Mcode stopped saving ${provider}'s output`,
  unknown: (provider) => `${provider} stopped before finishing`,
};

function interruptedNotice(input: TurnEndingInput): FilledNotice {
  const cause = input.ending?.outcome === "interrupted" ? input.ending.cause : "unknown";
  const notice: FilledNotice = {
    style: "filled",
    icon: "interrupted",
    title: "Interrupted",
    detail: INTERRUPTION_DETAILS[cause](input.providerLabel),
    primary: { action: "resume", label: "Resume" },
  };
  return input.isLatestTurn ? notice : withoutActions(notice);
}

function erroredNotice(input: TurnEndingInput): FilledNotice {
  const failure = input.ending?.outcome === "errored" ? input.ending.failure : null;
  const notice = failure ? failureNotice(failure, input) : unclassifiedNotice(input);
  return input.isLatestTurn ? notice : withoutActions(notice);
}

// Every action retries or resumes the turn, which the server refuses once a newer turn exists.
function withoutActions({ primary: _primary, secondary: _secondary, ...notice }: FilledNotice): FilledNotice {
  return notice;
}

function unclassifiedNotice(input: TurnEndingInput): FilledNotice {
  return { style: "filled", icon: "failed", title: `${input.providerLabel} couldn't finish this turn`, primary: RETRY };
}

const RETRY = { action: "retry", label: "Retry" } as const;

function failureNotice(failure: PersistedTurnFailure, input: TurnEndingInput): FilledNotice {
  const details = rawDetails(failure.message, input.executionId);
  switch (failure.kind) {
    case "retryable":
      return { style: "filled", icon: "failed", title: `${input.providerLabel} stopped responding`, detail: retryableDetail(failure), details, primary: RETRY };
    case "fatal":
      return { style: "filled", icon: "failed", title: `${input.providerLabel} couldn't finish this turn`, detail: firstLine(failure.message), details, primary: RETRY };
    case "usage_limit":
      return usageLimitNotice(failure, input);
    case "auth":
      return {
        style: "filled",
        icon: "failed",
        title: `${input.providerLabel} is signed out`,
        detail: `Threads on ${input.providerLabel} can't run until you sign in`,
        primary: input.providerSignedOut ? { action: "sign_in", label: "Sign in" } : RETRY,
      };
  }
}

function usageLimitNotice(failure: PersistedTurnFailure, input: TurnEndingInput): FilledNotice {
  const limit = failure.limitType ? LIMIT_LABELS[failure.limitType] ?? failure.limitType : "Usage limit";
  const base = {
    style: "filled",
    icon: "usage_limit",
    title: `${input.providerLabel} usage limit reached`,
    secondary: { action: "switch_model", label: "Switch model" },
  } as const;
  if (input.scheduledResumeAt) {
    return { ...base, detail: `Retrying at ${clockTime(input.scheduledResumeAt)}`, primary: { action: "cancel_retry", label: "Cancel retry" } };
  }
  if (failure.resetsAt && Date.parse(failure.resetsAt) > input.now) {
    const resetsAt = clockTime(failure.resetsAt);
    return { ...base, detail: `${limit} · resets ${resetsAt}`, primary: { action: "retry_at", label: `Retry at ${resetsAt}`, at: failure.resetsAt } };
  }
  return { ...base, detail: limit, primary: RETRY };
}

function retryableDetail(failure: PersistedTurnFailure): string {
  const phrase = failure.status === undefined ? undefined : STATUS_PHRASES[failure.status];
  if (!phrase) return firstLine(failure.message);
  const made = failure.retries?.made ?? 0;
  if (made === 0) return phrase;
  return `${phrase} after ${made} ${made === 1 ? "retry" : "retries"}`;
}

function rawDetails(message: string, executionId: string | null): string {
  return executionId ? `${message}\nturn ${executionId.slice(0, 8)}` : message;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim();
}

/** Local 24-hour "HH:MM", the format the notice table specifies. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
