import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";
import { type ProviderRateLimit } from "@mcode/contracts/providers/provider-status";
import type { ProviderEventIngressEvent } from "../composition/provider-event-ingress.js";

/** The fields of a `RateLimited` agent event the store reads. */
export interface RateLimitSignal {
  active: boolean;
  retryAfterMs?: number;
  limitType?: string;
}

const MAX_LIMIT_TYPE_LENGTH = 64;

/**
 * Latest active rate limit per provider, fed by `RateLimited` agent events.
 * An entry clears when the provider reports the limit lifted or its reset
 * time passes; either way `onChange` fires so the bell drops the row.
 */
export class ProviderRateLimitStore {
  private readonly entries = new Map<ProviderId, { limit: ProviderRateLimit; expiresAtMs: number | null }>();
  private readonly timers = new Map<ProviderId, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(providerId: ProviderId) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Applies one `RateLimited` event for a provider. */
  record(providerId: ProviderId, signal: RateLimitSignal): void {
    this.clearTimer(providerId);
    if (!signal.active) {
      if (this.entries.delete(providerId)) this.emit(providerId);
      return;
    }
    const expiresAtMs = validRetryAfter(signal.retryAfterMs) ? this.now() + signal.retryAfterMs : null;
    this.entries.set(providerId, {
      limit: {
        resetsAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
        limitType: signal.limitType?.slice(0, MAX_LIMIT_TYPE_LENGTH) || null,
      },
      expiresAtMs,
    });
    if (expiresAtMs !== null) this.scheduleExpiry(providerId, expiresAtMs);
    this.emit(providerId);
  }

  /** Returns the active limit, or null when none is recorded or it has expired. */
  get(providerId: ProviderId): ProviderRateLimit | null {
    const entry = this.entries.get(providerId);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.now()) return null;
    return entry.limit;
  }

  /** Subscribes to per-provider changes, including expiry. Returns an unsubscribe function. */
  onChange(listener: (providerId: ProviderId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleExpiry(providerId: ProviderId, expiresAtMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(providerId);
      this.entries.delete(providerId);
      this.emit(providerId);
    }, Math.max(0, expiresAtMs - this.now()));
    timer.unref?.();
    this.timers.set(providerId, timer);
  }

  private clearTimer(providerId: ProviderId): void {
    const timer = this.timers.get(providerId);
    if (timer) clearTimeout(timer);
    this.timers.delete(providerId);
  }

  private emit(providerId: ProviderId): void {
    for (const listener of this.listeners) listener(providerId);
  }
}

function validRetryAfter(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Builds a provider-event-ingress observer that feeds `RateLimited` events into the store. */
export function recordRateLimitEvents(store: ProviderRateLimitStore): (delivered: ProviderEventIngressEvent) => void {
  return (delivered) => {
    if (delivered.event.type === AgentEventType.RateLimited) store.record(delivered.providerId, delivered.event);
  };
}
