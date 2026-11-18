import { appModuleUrl } from "./app-probes.mjs";

/**
 * Marker the fixture writes into the usage record's `diagnostic` field, so anyone reading the
 * store sees that the numbers are not live.
 */
export const USAGE_CAPTURE_FIXTURE_DIAGNOSTIC = "Capture fixture, not live usage.";

/** File-name marker for captures that show fixture usage instead of live usage. */
export const USAGE_CAPTURE_FIXTURE_SUFFIX = ".usage-fixture";

/**
 * Capture fixture: replaces the open thread's usage for one provider with fixed quota readings
 * (5-hour limit 34% used, weekly limit 51% used), so a capture can show the Usage row while the
 * live usage source is down. The numbers are invented. Name the capture with
 * {@link USAGE_CAPTURE_FIXTURE_SUFFIX} and say in the PR that it shows fixture usage.
 *
 * Pass the provider the open thread runs on, such as "claude". The live source can overwrite the
 * fixture on its next refresh, so capture straight after applying it.
 */
export async function applyUsageCaptureFixture(page, { providerId }) {
  if (typeof providerId !== "string" || !/^[a-z][a-z0-9-]*$/.test(providerId)) {
    throw new Error(`Pass the open thread's provider id, such as "claude"; received ${providerId}`);
  }
  const threadStoreUrl = await appModuleUrl(page, "/src/stores/threadStore.ts");
  return page.evaluate(writeUsageFixture, {
    threadStoreUrl,
    providerId,
    diagnostic: USAGE_CAPTURE_FIXTURE_DIAGNOSTIC,
  });
}

async function writeUsageFixture({ threadStoreUrl, providerId, diagnostic }) {
  const { useThreadStore } = await import(threadStoreUrl);
  const state = useThreadStore.getState();
  const threadId = state.currentThreadId;
  const record = threadId ? state.records.get(threadId) : undefined;
  if (!record) throw new Error("Open a thread before applying the usage capture fixture");

  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const quota = (label, used, resetsInMs) => ({
    label,
    used,
    total: 100,
    remainingPercent: (100 - used) / 100,
    resetDate: new Date(now + resetsInMs).toISOString(),
    isUnlimited: false,
  });
  const usage = {
    providerId,
    quotaCategories: [quota("5-hour limit", 34, 3 * hour), quota("Weekly limit", 51, 5 * 24 * hour)],
    billingMode: "plan",
    usageStatus: "ready",
    fetchedAt: new Date(now).toISOString(),
    diagnostic,
  };
  const records = new Map(state.records);
  records.set(threadId, { ...record, usageByProvider: { ...record.usageByProvider, [providerId]: usage } });
  useThreadStore.setState({ records });
  return { threadId, providerId };
}
