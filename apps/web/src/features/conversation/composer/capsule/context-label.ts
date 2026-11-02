/** How urgently the context label asks for attention. */
export type ContextLabelTone = "warning" | "destructive";

/** What the capsule's context label shows: the rounded percentage alone, since the "context" word is a container-query detail. */
export interface ContextLabel {
  readonly text: string;
  readonly tone: ContextLabelTone;
}

const WARNING_PERCENT = 70;
const DESTRUCTIVE_PERCENT = 90;

/** Formats a context percentage the way the label and its card show it. */
export function formatContextPercent(percentUsed: number): string {
  return `${Math.round(percentUsed)}%`;
}

/**
 * The label for a thread's context usage, or null below 70% or when the window is unknown.
 * Below 70% the number is noise, so the label only appears once it is worth acting on.
 */
export function contextLabelFor(percentUsed: number | null): ContextLabel | null {
  if (percentUsed === null || percentUsed < WARNING_PERCENT) return null;
  return {
    text: formatContextPercent(percentUsed),
    tone: percentUsed >= DESTRUCTIVE_PERCENT ? "destructive" : "warning",
  };
}
