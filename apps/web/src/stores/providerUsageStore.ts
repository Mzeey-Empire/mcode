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

/** Matches the server's 90 s Claude usage cache, which answers sooner requests from the same data. */
const MIN_REFRESH_AGE_MS = 90_000;
const POLL_INTERVAL_MS = 5 * 60_000;

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
 * Reads and watches one provider's account-wide usage while mounted. Pass `undefined` to watch
 * nothing. A `select` with a stable result avoids re-renders on unrelated refreshes.
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
 * Applies quota categories when the event carries them (Codex). An event without categories keeps the
 * quota on screen and requests a refresh, because Claude sends it right after invalidating its server
 * usage cache. A request already in flight may have read the server before the event, so its answer
 * is discarded and one refresh runs after it settles.
 */
export function observeQuotaUpdate(event: Extract<AgentEvent, { type: "quotaUpdate" }>): void {
  const providerId = event.providerId;
  const categories = Array.isArray(event.categories) ? event.categories : [];
  const pending = inFlight.get(providerId);
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

/** Resets usage and watchers between tests, stops polling, and drops answers to earlier requests. */
export function resetProviderUsageForTests(): void {
  inFlight.clear();
  watchers.clear();
  stopTicker();
  useProviderUsageStore.setState({ byProvider: {} });
}

/** Sets one provider's snapshot for tests. Mounted watchers still follow the normal refresh rules. */
export function seedProviderUsageForTests(usage: ProviderQuotaUsage): void {
  useProviderUsageStore.setState((state) => ({
    byProvider: { ...state.byProvider, [usage.providerId]: usage },
  }));
}

function watch(providerId: string): () => void {
  watchers.set(providerId, (watchers.get(providerId) ?? 0) + 1);
  startTicker();
  void refresh(providerId, MIN_REFRESH_AGE_MS);
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
  ticker = setInterval(tick, POLL_INTERVAL_MS);
}

function startTicker(): void {
  if (tickerStarted) return;
  tickerStarted = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (document.visibilityState === "visible") ticker = setInterval(tick, POLL_INTERVAL_MS);
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
    // Poll only quota there is to show: a Codex cache miss can start a temporary `codex app-server`
    // to read limits, which a timer would repeat all day for accounts without them.
    const status = byProvider[providerId]?.usageStatus;
    if (status === "ready" || status === "stale") void refresh(providerId, MIN_REFRESH_AGE_MS);
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
