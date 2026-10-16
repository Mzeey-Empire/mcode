/** Window event asking the pooled {@link TerminalView} for one PTY to clear its view. */
export const TERMINAL_CLEAR = "mcode:terminal-clear";

/** Clears what the terminal shows. The shell's own scrollback and the replay buffer are untouched. */
export function dispatchTerminalClear(ptyId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(TERMINAL_CLEAR, { detail: ptyId }));
}
