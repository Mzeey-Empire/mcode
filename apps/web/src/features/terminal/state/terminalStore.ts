import { create } from "zustand";
import { TERMINAL_MAX_PER_SCOPE, type LegacyTerminalRecord, type TerminalExitMetadata, type TerminalSessionState } from "@mcode/contracts";
import { getTransport } from "@/transport";

/** A single PTY-backed terminal instance displayed in the terminal panel. */
export interface TerminalInstance {
  readonly id: string;
  readonly threadId: string;
  readonly label: string;
  readonly state?: TerminalSessionState | "pending";
  readonly exit?: TerminalExitMetadata;
  readonly exitCode?: number | null;
  readonly cwd?: string;
  readonly createdAt?: string;
  readonly kind?: "shell" | "action";
  /** Project Action that owns this record; set only when `kind` is `"action"`. */
  readonly actionId?: string;
}

/** Server-authoritative PTY identity returned during reconnect. */
export type ActiveTerminalSession = LegacyTerminalRecord;

/** Search matching flags retained independently for each PTY. */
export interface TerminalSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

/** Search query and match snapshot retained independently for each PTY. */
export interface TerminalSearchState {
  readonly open: boolean;
  readonly query: string;
  readonly options: TerminalSearchOptions;
  readonly resultIndex: number;
  readonly resultCount: number;
}

/** Default terminal search options. */
export const TERMINAL_SEARCH_OPTIONS_DEFAULT: TerminalSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
} as const;

/** Default terminal search state for a PTY without a saved query. */
export const TERMINAL_SEARCH_STATE_DEFAULT: TerminalSearchState = {
  open: false,
  query: "",
  options: TERMINAL_SEARCH_OPTIONS_DEFAULT,
  resultIndex: -1,
  resultCount: 0,
} as const;

interface TerminalState {
  readonly hasHydrated: boolean;
  readonly terminals: Record<string, readonly TerminalInstance[]>;
  readonly activeTerminalByScope: Record<string, string | null>;
  /** Reverse index: ptyId → threadId for O(1) owner lookup in removeTerminal. */
  readonly ptyToThread: Record<string, string>;
  readonly terminalSearchByPty: Record<string, TerminalSearchState>;
  readonly splitMode: boolean;

  setActiveTerminal: (threadId: string, ptyId: string | null) => void;
  openTerminalSearch: (ptyId: string) => void;
  closeTerminalSearch: (ptyId: string) => void;
  setTerminalSearchQuery: (ptyId: string, query: string) => void;
  setTerminalSearchOptions: (
    ptyId: string,
    options: TerminalSearchOptions,
  ) => void;
  setTerminalSearchResult: (
    ptyId: string,
    resultIndex: number,
    resultCount: number,
  ) => void;
  clearTerminalSearchResult: (ptyId: string) => void;
  /** `activate: false` preserves an existing active tab for background updates. */
  addTerminal: (
    threadId: string,
    ptyId: string,
    shell?: string,
    metadata?: Omit<LegacyTerminalRecord, "ptyId" | "threadId" | "shell">,
    activate?: boolean,
  ) => void;
  /** Replaces an exited terminal in its existing slot after Retry succeeds. */
  replaceTerminal: (ptyId: string, replacement: LegacyTerminalRecord) => void;
  /** Retains terminal output metadata after a natural or failed session exit. */
  recordTerminalExit: (ptyId: string, exit: TerminalExitMetadata) => void;
  /** Replaces stale client identities with the server's active PTY set. */
  reconcileActiveSessions: (sessions: readonly ActiveTerminalSession[]) => void;
  removeTerminal: (ptyId: string) => void;
  removeAllTerminals: (threadId: string) => void;
  clearThread: (threadId: string) => void;
  toggleSplit: () => void;
}

/** Resume belongs to TerminalView: its data listener must be attached before output flows. */
function pauseReplacedTerminal(previous: string | null, next: string | null): void {
  if (!previous || previous === next) return;
  getTransport().terminalPause(previous).catch(() => {});
}

function generateLabel(existing: readonly TerminalInstance[]): string {
  let max = 0;
  for (const t of existing) {
    const match = t.label.match(/^Terminal (\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return `Terminal ${max + 1}`;
}

function reconcileActiveTerminalSessions(
  state: Pick<TerminalState, "terminals" | "ptyToThread" | "activeTerminalByScope" | "terminalSearchByPty">,
  sessions: readonly ActiveTerminalSession[],
) {
  const existingById = new Map(
    Object.values(state.terminals).flat().map((terminal) => [terminal.id, terminal] as const),
  );
  const { terminals, ptyToThread } = reconcileTerminalInstances(sessions, existingById);
  return {
    terminals,
    ptyToThread,
    activeTerminalByScope: reconcileActiveTerminals(state, terminals),
    terminalSearchByPty: reconcileTerminalSearch(state.terminalSearchByPty, sessions),
  };
}

function reconcileTerminalInstances(
  sessions: readonly ActiveTerminalSession[],
  existingById: ReadonlyMap<string, TerminalInstance>,
): {
  readonly terminals: Record<string, readonly TerminalInstance[]>;
  readonly ptyToThread: Record<string, string>;
} {
  const terminals: Record<string, readonly TerminalInstance[]> = {};
  const ptyToThread: Record<string, string> = {};
  for (const session of [...sessions].sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))) {
    const scopeTerminals = terminals[session.threadId] ?? [];
    const terminal = reconcileTerminalInstance(session, existingById.get(session.ptyId), scopeTerminals);
    terminals[session.threadId] = [...scopeTerminals, terminal];
    ptyToThread[session.ptyId] = session.threadId;
  }
  return { terminals, ptyToThread };
}

function reconcileTerminalInstance(
  session: ActiveTerminalSession,
  existing: TerminalInstance | undefined,
  scopeTerminals: readonly TerminalInstance[],
): TerminalInstance {
  const terminal = existing ?? { id: session.ptyId, label: session.shell ?? generateLabel(scopeTerminals) };
  return {
    ...terminal,
    threadId: session.threadId,
    label: session.shell ?? terminal.label,
    state: session.state ?? "running",
    exitCode: session.exitCode,
    cwd: session.cwd,
    createdAt: session.createdAt,
    kind: session.kind ?? "shell",
    actionId: session.actionId,
    exit: session.state === "exited"
      ? { code: session.exitCode ?? null, signal: null, reason: "natural" }
      : undefined,
  };
}

function reconcileActiveTerminals(
  state: Pick<TerminalState, "terminals" | "activeTerminalByScope">,
  terminals: Record<string, readonly TerminalInstance[]>,
): Record<string, string | null> {
  const activeTerminalByScope = { ...state.activeTerminalByScope };
  const scopeIds = new Set([...Object.keys(state.terminals), ...Object.keys(terminals)]);
  for (const scopeId of scopeIds) {
    const scopeTerminals = terminals[scopeId] ?? [];
    const active = activeTerminalByScope[scopeId] ?? null;
    activeTerminalByScope[scopeId] = scopeTerminals.some((terminal) => terminal.id === active)
      ? active
      : scopeTerminals[0]?.id ?? null;
  }
  return activeTerminalByScope;
}

function reconcileTerminalSearch(
  terminalSearchByPty: Record<string, TerminalSearchState>,
  sessions: readonly ActiveTerminalSession[],
): Record<string, TerminalSearchState> {
  const next = { ...terminalSearchByPty };
  const activePtyIds = new Set(sessions.map((session) => session.ptyId));
  for (const ptyId of Object.keys(next)) {
    if (!activePtyIds.has(ptyId)) delete next[ptyId];
  }
  return next;
}

/** Zustand store for terminal instances and the active terminal per scope. */
export const useTerminalStore = create<TerminalState>((set) => ({
  hasHydrated: false,
  terminals: {},
  activeTerminalByScope: {},
  ptyToThread: {},
  terminalSearchByPty: {},
  splitMode: true,

  setActiveTerminal: (threadId, ptyId) =>
    set((state) => {
      const previous = state.activeTerminalByScope[threadId] ?? null;
      pauseReplacedTerminal(previous, ptyId);
      return { activeTerminalByScope: { ...state.activeTerminalByScope, [threadId]: ptyId } };
    }),

  openTerminalSearch: (ptyId) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: { ...current, open: true, options: { ...current.options } },
        },
      };
    }),

  closeTerminalSearch: (ptyId) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId];
      if (!current) return state;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: { ...current, open: false, options: { ...current.options } },
        },
      };
    }),

  setTerminalSearchQuery: (ptyId, query) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            query,
            options: { ...current.options },
            resultIndex: -1,
            resultCount: 0,
          },
        },
      };
    }),

  setTerminalSearchOptions: (ptyId, options) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            options: { ...options },
            resultIndex: -1,
            resultCount: 0,
          },
        },
      };
    }),

  setTerminalSearchResult: (ptyId, resultIndex, resultCount) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            options: { ...current.options },
            resultIndex,
            resultCount,
          },
        },
      };
    }),

  clearTerminalSearchResult: (ptyId) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId];
      if (!current) return state;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            options: { ...current.options },
            resultIndex: -1,
            resultCount: 0,
          },
        },
      };
    }),

  addTerminal: (threadId, ptyId, shell, metadata, activate = true) =>
    set((state) => {
      const existing = state.terminals[threadId] ?? [];
      if (existing.some((terminal) => terminal.id === ptyId) || existing.length >= TERMINAL_MAX_PER_SCOPE) return state;
      const instance = reconcileTerminalInstance({ ...metadata, ptyId, threadId, shell }, undefined, existing);
      const previous = state.activeTerminalByScope[threadId] ?? null;
      const keepsActive = !activate && previous !== null;
      if (!keepsActive) pauseReplacedTerminal(previous, ptyId);
      return {
        terminals: {
          ...state.terminals,
          [threadId]: [...existing, instance],
        },
        ptyToThread: { ...state.ptyToThread, [ptyId]: threadId },
        activeTerminalByScope: keepsActive
          ? state.activeTerminalByScope
          : { ...state.activeTerminalByScope, [threadId]: ptyId },
      };
    }),

  recordTerminalExit: (ptyId, exit) =>
    set((state) => {
      const ownerThreadId = state.ptyToThread[ptyId];
      if (!ownerThreadId) return state;
      const ownerInstances = state.terminals[ownerThreadId];
      if (!ownerInstances) return state;
      const nextState = exit.reason === "host-crash" ||
          exit.reason === "containment-failure" ||
          exit.reason === "protocol-failure"
        ? "failed"
        : "exited";
      return {
        terminals: {
          ...state.terminals,
          [ownerThreadId]: ownerInstances.map((terminal) =>
            terminal.id === ptyId
              ? { ...terminal, state: nextState, exit, exitCode: exit.code }
              : terminal,
          ),
        },
      };
    }),

  replaceTerminal: (ptyId, replacement) =>
    set((state) => {
      const scopeId = state.ptyToThread[ptyId];
      if (!scopeId || scopeId !== replacement.threadId) return state;
      const ptyToThread = { ...state.ptyToThread };
      delete ptyToThread[ptyId];
      ptyToThread[replacement.ptyId] = scopeId;
      const terminalSearchByPty = { ...state.terminalSearchByPty };
      delete terminalSearchByPty[ptyId];
      return {
        ptyToThread,
        terminalSearchByPty,
        terminals: {
          ...state.terminals,
          [scopeId]: state.terminals[scopeId].map((terminal) => terminal.id === ptyId
            ? reconcileTerminalInstance(replacement, undefined, [])
            : terminal),
        },
        activeTerminalByScope: { ...state.activeTerminalByScope, [scopeId]: replacement.ptyId },
      };
    }),

  reconcileActiveSessions: (sessions) =>
    set((state) => ({ ...reconcileActiveTerminalSessions(state, sessions), hasHydrated: true })),

  removeTerminal: (ptyId) =>
    set((state) => {
      const terminalSearchByPty = { ...state.terminalSearchByPty };
      delete terminalSearchByPty[ptyId];
      // O(1) owner lookup via the reverse index.
      const ownerThreadId = state.ptyToThread[ptyId];
      if (!ownerThreadId) {
        return state.terminalSearchByPty[ptyId]
          ? { terminalSearchByPty }
          : state;
      }
      const ownerInstances = state.terminals[ownerThreadId];
      if (!ownerInstances) return { terminalSearchByPty };

      const filtered = ownerInstances.filter((t) => t.id !== ptyId);
      const updatedTerminals =
        filtered.length > 0
          ? { ...state.terminals, [ownerThreadId]: filtered }
          : (() => {
              const rest = { ...state.terminals };
              delete rest[ownerThreadId];
              return rest;
            })();

      const remainingPtyToThread = { ...state.ptyToThread };
      delete remainingPtyToThread[ptyId];

      const active = state.activeTerminalByScope[ownerThreadId] ?? null;
      const nextActive = active === ptyId ? (filtered[0]?.id ?? null) : active;

      return {
        terminals: updatedTerminals,
        ptyToThread: remainingPtyToThread,
        terminalSearchByPty,
        activeTerminalByScope: { ...state.activeTerminalByScope, [ownerThreadId]: nextActive },
      };
    }),

  removeAllTerminals: (threadId) =>
    set((state) => {
      const threadTerminals = state.terminals[threadId];
      if (!threadTerminals) return state;
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[threadId];

      // Clean up reverse index for all removed PTYs.
      const remainingPtyToThread = { ...state.ptyToThread };
      for (const t of threadTerminals) delete remainingPtyToThread[t.id];

      const terminalSearchByPty = { ...state.terminalSearchByPty };
      for (const t of threadTerminals) delete terminalSearchByPty[t.id];

      return {
        terminals: remainingTerminals,
        ptyToThread: remainingPtyToThread,
        terminalSearchByPty,
        ...(threadId in state.activeTerminalByScope
          ? { activeTerminalByScope: { ...state.activeTerminalByScope, [threadId]: null } }
          : {}),
      };
    }),

  clearThread: (threadId) =>
    set((state) => {
      if (!state.terminals[threadId] && !(threadId in state.activeTerminalByScope)) return state;
      const threadTerminals = state.terminals[threadId];
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[threadId];
      const remainingActive = { ...state.activeTerminalByScope };
      delete remainingActive[threadId];

      // Clean up reverse index for all removed PTYs.
      const remainingPtyToThread = { ...state.ptyToThread };
      if (threadTerminals) {
        for (const t of threadTerminals) delete remainingPtyToThread[t.id];
      }

      const terminalSearchByPty = { ...state.terminalSearchByPty };
      if (threadTerminals) {
        for (const t of threadTerminals) delete terminalSearchByPty[t.id];
      }

      return {
        terminals: remainingTerminals,
        ptyToThread: remainingPtyToThread,
        terminalSearchByPty,
        activeTerminalByScope: remainingActive,
      };
    }),

  toggleSplit: () => set((state) => ({ splitMode: !state.splitMode })),
}));
