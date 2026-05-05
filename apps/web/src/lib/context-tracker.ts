/** UI context keys used in keybinding "when" clauses. */
export interface ContextState {
  /** An input, textarea, or contenteditable element has focus. */
  inputFocused: boolean;
  /** The xterm terminal has focus. */
  terminalFocused: boolean;
  /** The command palette is currently open. */
  commandPaletteOpen: boolean;
  /** The settings view is visible. */
  settingsOpen: boolean;
  /**
   * The project landing is visible (no active thread, not obscured by settings).
   * Used so landing-only shortcuts do not fire in chat or fullscreen settings.
   */
  showLanding: boolean;
}

/** Valid context key names. */
export type ContextKey = keyof ContextState;

/** Factory for the initial context state (single source of truth for defaults). */
function getDefaultContext(): ContextState {
  return {
    inputFocused: false,
    terminalFocused: false,
    commandPaletteOpen: false,
    settingsOpen: false,
    showLanding: false,
  };
}

const state: ContextState = getDefaultContext();

/** Get the current context snapshot. */
export function getContext(): Readonly<ContextState> {
  return { ...state };
}

/** Set a single context value. */
export function setContext<K extends ContextKey>(key: K, value: ContextState[K]): void {
  state[key] = value;
}

/**
 * Evaluates one context atom: `key` or `!key` for a known `ContextKey`.
 */
function evaluateWhenAtom(atom: string): boolean {
  const trimmed = atom.trim();
  const negated = trimmed.startsWith("!");
  const key = (negated ? trimmed.slice(1) : trimmed) as ContextKey;

  if (!Object.prototype.hasOwnProperty.call(state, key)) return false;

  const value = state[key];
  return negated ? !value : !!value;
}

/**
 * Evaluate a "when" clause against the current context.
 * Supports simple keys (`inputFocused`), negation (`!inputFocused`), and
 * conjunction with ` && ` (all subclauses must pass). Returns true if the
 * clause is undefined (unconditional).
 */
export function evaluateWhen(when: string | undefined): boolean {
  if (when === undefined) return true;

  const parts = when.split(/\s+&&\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (!evaluateWhenAtom(parts[i]!)) return false;
  }
  return true;
}

/** Reset all context to defaults (for testing). */
export function resetContext(): void {
  Object.assign(state, getDefaultContext());
}
