import { useEffect } from "react";
import { create } from "zustand";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import { getTransport } from "@/transport";
import {
  failedUsage,
  mergeProviderUsageSnapshot,
  toProviderQuotaUsage,
  type ProviderQuotaUsage,
} from "./provider-usage-snapshot";

/** The server caches Claude usage for 90 s, so a fetch sooner than that returns the same bytes. */
const FRESH_FOR_MS = 90_000;
const WATCH_INTERVAL_MS = 5 * 60_000;

interface ProviderUsageState {
  byProvider: Readonly<Partial<Record<string, ProviderQuotaUsage>>>;
}

const useProviderUsageStore = create<ProviderUsageState>(() => ({ byProvider: {} }));

interface UsageRequest {
  superseded: boolean;
}

const inFlight = new Map<string, UsageRequest>();
const watchers = new Map<string, number>();
let ticker: ReturnType<typeof setInterval> | undefined;
let tickerStarted = false;

/**
 * Reads one provider's account-wide usage and keeps it fresh while mounted. Pass `undefined` to watch
 * nothing. Pass a module-level `select` returning a primitive to skip re-renders on unrelated refreshes.
 */
export function useProviderUsage(providerId: string | undefined): ProviderQuotaUsage | undefined;
export function useProviderUsage<T>(
  providerId: string | undefined,
  select: (usage: ProviderQuotaUsage | undefined) => T,
): T;
export function useProviderUsage<T>(
  providerId: string | undefined,
  select?: (usage: ProviderQuotaUsage | undefined) => T,
): T | ProviderQuotaUsage | undefined {
  useEffect(() => (providerId === undefined ? undefined : watch(providerId)), [providerId]);
  return useProviderUsageStore((state) => {
    const usage = providerId === undefined ? undefined : state.byProvider[providerId];
    return select ? select(usage) : usage;
  });
}

/**
 * Routes a quotaUpdate to the provider snapshot. An event with categories (Codex) is a quota
 * observation and is applied directly. An event without categories is a signal, not an empty quota:
 * Claude invalidates its server cache just before emitting it, so the quota on screen stays and a
 * refresh runs now.
 */
export function observeQuotaUpdate(event: Extract<AgentEvent, { type: "quotaUpdate" }>): void {
  const providerId = event.providerId;
  const categories = Array.isArray(event.categories) ? event.categories : [];
  const pending = inFlight.get(providerId);
  // The pending request may have read the server before this event, so its answer is older than the
  // event. Discard it and run one trailing refresh once it settles.
  if (pending) pending.superseded = true;
  if (categories.length > 0) {
    apply(providerId, {
      providerId,
      quotaCategories: categories,
      billingMode: event.billingMode,
      usageStatus: "ready",
      fetchedAt: new Date().toISOString(),
    });
    return;
  }
  if (!pending) void refresh(providerId, 0);
}

/** Clears usage, in-flight requests, watchers, and the ticker between tests. */
export function resetProviderUsageForTests(): void {
  inFlight.clear();
  watchers.clear();
  stopTicker();
  useProviderUsageStore.setState({ byProvider: {} });
}

/** Seeds one provider's snapshot for render tests that are about formatting, not refreshing. */
export function seedProviderUsageForTests(usage: ProviderQuotaUsage): void {
  useProviderUsageStore.setState((state) => ({
    byProvider: { ...state.byProvider, [usage.providerId]: usage },
  }));
}

function watch(providerId: string): () => void {
  watchers.set(providerId, (watchers.get(providerId) ?? 0) + 1);
  startTicker();
  void refresh(providerId, FRESH_FOR_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (watchers.get(providerId) ?? 1) - 1;
    if (remaining > 0) watchers.set(providerId, remaining);
    else watchers.delete(providerId);
    if (watchers.size === 0) stopTicker();
  };
}

function onVisibilityChange(): void {
  clearTickerInterval();
  if (document.visibilityState !== "visible") return;
  tick();
  ticker = setInterval(tick, WATCH_INTERVAL_MS);
}

function startTicker(): void {
  if (tickerStarted) return;
  tickerStarted = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (document.visibilityState === "visible") ticker = setInterval(tick, WATCH_INTERVAL_MS);
}

function clearTickerInterval(): void {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
}

function stopTicker(): void {
  tickerStarted = false;
  clearTickerInterval();
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

function tick(): void {
  if (document.visibilityState !== "visible") return;
  const byProvider = useProviderUsageStore.getState().byProvider;
  for (const providerId of watchers.keys()) {
    // The timer keeps shown limits current. A provider with none is left to opens and quotaUpdate
    // events: for Codex an empty server cache makes every getUsage launch a throwaway app-server.
    const status = byProvider[providerId]?.usageStatus;
    // The freshness floor, not the interval: a snapshot stamped just after the last tick is a little
    // under one interval old at this tick, and would otherwise wait a second interval.
    if (status === "ready" || status === "stale") void refresh(providerId, FRESH_FOR_MS);
  }
}

function snapshotAgeMs(usage: ProviderQuotaUsage | undefined): number {
  const stamp = usage?.fetchedAt ?? usage?.failedAt;
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY;
}

async function refresh(providerId: string, maxAgeMs: number): Promise<void> {
  if (inFlight.has(providerId)) return;
  if (snapshotAgeMs(useProviderUsageStore.getState().byProvider[providerId]) < maxAgeMs) return;
  const request: UsageRequest = { superseded: false };
  inFlight.set(providerId, request);
  let incoming: ProviderQuotaUsage;
  try {
    incoming = toProviderQuotaUsage(await getTransport().getProviderUsage(providerId));
  } catch {
    incoming = failedUsage(providerId, Date.now());
  }
  // A test reset dropped this request; its answer belongs to no one.
  if (inFlight.get(providerId) !== request) return;
  inFlight.delete(providerId);
  if (request.superseded) {
    void refresh(providerId, 0);
    return;
  }
  apply(providerId, incoming);
}

function apply(providerId: string, incoming: ProviderQuotaUsage): void {
  useProviderUsageStore.setState((state) => ({
    byProvider: {
      ...state.byProvider,
      [providerId]: mergeProviderUsageSnapshot(state.byProvider[providerId], incoming),
    },
  }));
}
