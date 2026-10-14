import type { KeyboardEvent } from "react";

/** What a key press means inside a question dock or question body. */
export interface QuestionKeyAction {
  readonly kind: "escape" | "enter" | "move" | "digit" | "arm";
  readonly value: number;
}

const NAMED_KEYS: Readonly<Record<string, QuestionKeyAction>> = {
  Escape: { kind: "escape", value: 0 },
  Enter: { kind: "enter", value: 0 },
  ArrowUp: { kind: "move", value: -1 },
  ArrowDown: { kind: "move", value: 1 },
};

/** `[` and `]` page between questions; typing an answer keeps them as characters. */
export function pageKeyDelta(event: KeyboardEvent, typing: boolean): -1 | 0 | 1 {
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return 0;
  if (event.key === "[") return -1;
  return event.key === "]" ? 1 : 0;
}

/**
 * Classifies a key press for question surfaces. A digit picks a row only while the user
 * is not typing an answer; any other printable key counts as typing, so it re-arms the
 * misclick guard. Space is a click on the focused row, so it only counts while typing.
 */
export function questionKeyAction(event: KeyboardEvent, typing: boolean): QuestionKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  if (!typing && /^[1-9]$/.test(event.key)) return { kind: "digit", value: Number(event.key) - 1 };
  return event.key.length === 1 && (typing || event.key !== " ") ? { kind: "arm", value: 0 } : undefined;
}
