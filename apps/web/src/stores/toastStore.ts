import { create } from "zustand";

/** What a toast reports. The kind sets its status mark, its live-region role and its lifetime. */
export type ToastKind = "finished" | "needs-you" | "failed" | "info";

/** What a caller passes to {@link ToastState.show}. */
export interface ToastInput {
  readonly kind: ToastKind;
  readonly title: string;
  /**
   * The caption line, for example `Finished · 14:32`. When it contains ` · `, the label
   * before the first separator takes the kind's colour, as on the Paper toast.
   */
  readonly meta?: string;
  /** Opens the toast's object. When set, the whole toast is the button; clicking it also dismisses the toast. */
  readonly onOpen?: () => void;
  /** At most one live toast holds a key; showing another with the same key replaces it in place. */
  readonly dedupeKey?: string;
}

/** A toast in the lane. */
export interface Toast extends ToastInput {
  readonly id: string;
}

/** How long finished and info toasts stay before hiding. */
export const TOAST_LIFETIME_MS = 8_000;

/** Toasts beyond this are dropped, oldest first; thread events have no log to fall back to. */
const MAX_TOASTS = 3;

/** Needs-you and failed toasts stay until the user opens or closes them. */
const LIFETIME_BY_KIND: Record<ToastKind, number | null> = {
  finished: TOAST_LIFETIME_MS,
  info: TOAST_LIFETIME_MS,
  "needs-you": null,
  failed: null,
};

interface ToastState {
  /** Live toasts, newest first. */
  readonly toasts: readonly Toast[];
  /** Shows a toast and returns its id. A live toast with the same `dedupeKey` keeps its id and slot. */
  show: (input: ToastInput) => string;
  /** Removes a toast and cancels its timer. */
  dismiss: (id: string) => void;
  /** Removes the toast holding `dedupeKey`, if any, and cancels its timer. */
  dismissByKey: (dedupeKey: string) => void;
  /** Stops a toast's lifetime while the pointer rests on it. */
  pause: (id: string) => void;
  /** Restarts a paused lifetime with the time it had left. */
  resume: (id: string) => void;
}

/** A running or paused lifetime. `startedAt` is null while paused. */
interface Lifetime {
  remainingMs: number;
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let nextId = 0;
const lifetimes = new Map<string, Lifetime>();
// Hover is tracked apart from lifetimes so a toast replaced under the pointer stays paused.
const hovered = new Set<string>();

function stopLifetime(id: string): void {
  const lifetime = lifetimes.get(id);
  if (lifetime?.timer) clearTimeout(lifetime.timer);
  lifetimes.delete(id);
}

function runLifetime(id: string, lifetime: Lifetime, dismiss: (id: string) => void): void {
  lifetime.startedAt = Date.now();
  lifetime.timer = setTimeout(() => dismiss(id), lifetime.remainingMs);
}

/** The app's single toast lane. `components/ui/toast.tsx` renders it. */
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (input) => {
    const current = get().toasts;
    const replaced = input.dedupeKey === undefined
      ? undefined
      : current.find((toast) => toast.dedupeKey === input.dedupeKey);
    const id = replaced?.id ?? String(++nextId);
    const toast: Toast = { ...input, id };

    stopLifetime(id);
    const lifetimeMs = LIFETIME_BY_KIND[input.kind];
    if (lifetimeMs !== null) {
      const lifetime: Lifetime = { remainingMs: lifetimeMs, startedAt: null, timer: null };
      lifetimes.set(id, lifetime);
      if (!hovered.has(id)) runLifetime(id, lifetime, get().dismiss);
    }

    if (replaced) {
      set({ toasts: current.map((existing) => (existing.id === id ? toast : existing)) });
      return id;
    }
    const toasts = [toast, ...current];
    for (const dropped of toasts.slice(MAX_TOASTS)) {
      stopLifetime(dropped.id);
      hovered.delete(dropped.id);
    }
    set({ toasts: toasts.slice(0, MAX_TOASTS) });
    return id;
  },

  dismiss: (id) => {
    stopLifetime(id);
    hovered.delete(id);
    const toasts = get().toasts;
    if (toasts.some((toast) => toast.id === id)) set({ toasts: toasts.filter((toast) => toast.id !== id) });
  },

  dismissByKey: (dedupeKey) => {
    const keyed = get().toasts.find((toast) => toast.dedupeKey === dedupeKey);
    if (keyed) get().dismiss(keyed.id);
  },

  pause: (id) => {
    hovered.add(id);
    const lifetime = lifetimes.get(id);
    if (!lifetime || lifetime.startedAt === null) return;
    if (lifetime.timer) clearTimeout(lifetime.timer);
    lifetime.remainingMs -= Date.now() - lifetime.startedAt;
    lifetime.startedAt = null;
    lifetime.timer = null;
  },

  resume: (id) => {
    hovered.delete(id);
    const lifetime = lifetimes.get(id);
    if (!lifetime || lifetime.startedAt !== null) return;
    runLifetime(id, lifetime, get().dismiss);
  },
}));
