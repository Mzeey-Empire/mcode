import {
  createModeSignalCollector,
  createPageSignalCollector,
  summarizeDurationSamples,
} from "./frontend-performance-collectors.mjs";

/** Explicit-only sidebar workloads. They need the sidebar thread fixture and run without the chat fixture. */
export const SIDEBAR_RENDERER_WORKLOADS = Object.freeze([
  "sidebarStream",
  "sidebarScroll",
  "sidebarHydration",
]);

const SIDEBAR_PROFILER_ID = "sidebar";
const THREAD_TITLE_PREFIX = "Sidebar perf";
const WHEEL_STEP_PX = 100;
const MAX_WHEEL_STEPS = 4_000;
const REFRESH_PROBE_FRAMES = 120;
const HYDRATION_TIMEOUT_MS = 60_000;

/** Returns the nearest-rank percentile of finite values, or null when there are none. */
export function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

/** Summarizes rAF intervals against a frame budget. A frame is over budget when it spans at least half a missed vsync. */
export function summarizeFrameIntervals(intervalsMs, budgetMs) {
  const intervals = intervalsMs.filter(Number.isFinite);
  return {
    frameCount: intervals.length,
    p50Ms: percentile(intervals, 0.5),
    p95Ms: percentile(intervals, 0.95),
    maxMs: intervals.length > 0 ? Math.max(...intervals) : null,
    budgetMs,
    overBudgetFrames: intervals.filter((interval) => interval > budgetMs * 1.5).length,
  };
}

/** Aggregates per-event sidebar commit records from accepted stream samples, split by push channel. */
export function summarizeSidebarStreamEvents(samples) {
  const byChannel = {};
  for (const event of samples.flat()) {
    const bucket = byChannel[event.channel] ?? (byChannel[event.channel] = { durations: [], commits: [] });
    bucket.durations.push(event.commitDurationMs);
    bucket.commits.push(event.commitCount);
  }
  const summarize = ({ durations, commits }) => ({
    eventCount: durations.length,
    commitDurationP50Ms: percentile(durations, 0.5),
    commitDurationP95Ms: percentile(durations, 0.95),
    commitsPerEventP50: percentile(commits, 0.5),
    commitsPerEventMax: commits.length > 0 ? Math.max(...commits) : null,
    totalCommits: commits.reduce((total, count) => total + count, 0),
  });
  const all = Object.values(byChannel).reduce(
    (merged, bucket) => ({ durations: [...merged.durations, ...bucket.durations], commits: [...merged.commits, ...bucket.commits] }),
    { durations: [], commits: [] },
  );
  return {
    all: summarize(all),
    byChannel: Object.fromEntries(Object.entries(byChannel).map(([channel, bucket]) => [channel, summarize(bucket)])),
  };
}

/**
 * Rewrites the captured Codex turn onto one sidebar thread with fresh epoch and
 * execution identities. The capture's first frame is the admission in an older
 * epoch, so the replay starts with a recovery frame built from it, the way a
 * subscribing client receives a turn already in progress.
 */
export function buildSidebarStreamEvents(capture, targetThreadId, sampleKey, executionId) {
  let text = JSON.stringify(capture.frames).replaceAll(capture.threadId, targetThreadId)
    .replaceAll(capture.executionId, executionId);
  const epochs = [...new Set(capture.frames.map((frame) => frame.epoch))];
  epochs.forEach((epoch, index) => { text = text.replaceAll(epoch, `sidebar-perf-${sampleKey}-${index}`); });
  const [admission, start, ...rest] = JSON.parse(text);
  if (admission?.phase !== "saved" || start?.phase !== "saved" || rest.some((frame) => frame.epoch !== start.epoch)) {
    throw new Error("The canonical capture must be one saved admission followed by one live epoch.");
  }
  return [
    { channel: "thread.status", data: { threadId: targetThreadId, status: "active" } },
    { channel: "agent.canonical", data: null, recoveryBase: { admission, start } },
    ...[start, ...rest].map((frame) => ({ channel: "agent.canonical", data: frame })),
    { channel: "thread.status", data: { threadId: targetThreadId, status: "interrupted" } },
  ];
}

async function nextFrames(page, count) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);
}

async function measureRefreshRate(page) {
  const intervals = await page.evaluate(async (frames) => {
    const times = [];
    for (let index = 0; index <= frames; index += 1) times.push(await new Promise((resolve) => requestAnimationFrame(resolve)));
    return times.slice(1).map((time, index) => time - times[index]);
  }, REFRESH_PROBE_FRAMES);
  const medianMs = percentile(intervals, 0.5);
  return { medianFrameIntervalMs: medianMs, refreshRateHz: medianMs ? Math.round(1000 / medianMs) : null };
}

function projectToggle(page, name) {
  return page.getByRole("button", { name: `Toggle threads for ${name}`, exact: true });
}

async function scrollSidebarTo(page, position) {
  await page.evaluate((target) => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const scroller = [...(body?.querySelectorAll("*") ?? [])].find((element) =>
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    if (scroller) scroller.scrollTop = target === "top" ? 0 : scroller.scrollHeight;
  }, position);
  await nextFrames(page, 2);
}

async function expandProject(page, name) {
  const toggle = projectToggle(page, name);
  for (const position of ["top", "bottom"]) {
    if (await toggle.count() > 0) break;
    await scrollSidebarTo(page, position);
  }
  await toggle.waitFor({ state: "attached", timeout: 30_000 });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click({ force: true });
}

async function readSidebarState(page, workspaceIds) {
  return page.evaluate(({ ids, prefix }) => {
    const state = window.__mcodeFrontendPerformanceModules?.workspaceStore.getState();
    const owned = new Set(ids);
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const mountedRows = [...(body?.querySelectorAll('[role="button"]') ?? [])]
      .filter((element) => element.textContent?.includes(prefix)).length;
    return { loadedThreads: state?.threads.filter((thread) => owned.has(thread.workspace_id)).length ?? 0, mountedRows };
  }, { ids: workspaceIds, prefix: THREAD_TITLE_PREFIX });
}

async function waitForStableThreadCount(page, workspaceIds) {
  let previous = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { loadedThreads } = await readSidebarState(page, workspaceIds);
    if (loadedThreads !== previous) {
      previous = loadedThreads;
      stableSince = Date.now();
    } else if (loadedThreads > 0 && Date.now() - stableSince > 2_000) {
      return loadedThreads;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("The sidebar thread list did not settle after expanding the seeded projects.");
}

/** Expands every seeded project through its toggle button and waits until the sidebar's thread list settles. */
async function prepareSidebar(page, fixture) {
  await page.waitForFunction(() => Boolean(window.__mcodeFrontendPerformanceModules), null, { timeout: 30_000 });
  const names = fixture.workspaces.map((workspace) => workspace.name);
  await page.getByRole("button", { name: `Open project ${names[0]}`, exact: true })
    .waitFor({ state: "attached", timeout: 30_000 });
  for (const name of [...names].reverse()) await expandProject(page, name);
  return waitForStableThreadCount(page, fixture.workspaces.map((workspace) => workspace.id));
}

/** Opens the stream target through its sidebar row, because the store only applies canonical progress for an open thread. */
async function openStreamTarget(page, fixture) {
  await scrollSidebarTo(page, "top");
  const row = page.getByRole("button", { name: fixture.streamTarget.title });
  if ((await row.count()) === 0) return false;
  await row.first().click();
  await page.waitForFunction(
    (threadId) => window.__mcodeFrontendPerformanceModules?.threadStore.getState().currentThreadId === threadId,
    fixture.streamTarget.id,
    { timeout: 30_000 },
  );
  await nextFrames(page, 10);
  return true;
}

async function replayStreamEvents(page, events, profiling) {
  return page.evaluate(async ({ events: pushes, profilerId, profiling: enabled }) => {
    const modules = window.__mcodeFrontendPerformanceModules;
    const commits = () => window.__mcodePerformanceAttribution?.commits ?? [];
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const recoveryFrame = ({ admission, start }) => {
      const reduced = modules.agentModel.reduce(modules.agentModel.create(), [...admission.events, ...start.events]);
      if (reduced.outcome === "rejected") throw new Error("The canonical capture admission did not reduce.");
      return {
        phase: "recovery", threadId: start.threadId, epoch: start.epoch, acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none",
        durable: { mode: "snapshot", threadId: start.threadId, snapshot: { revision: start.revision, state: reduced.state } },
      };
    };
    const records = [];
    for (const push of pushes) {
      const data = push.recoveryBase ? recoveryFrame(push.recoveryBase) : push.data;
      const before = commits().length;
      modules.push(push.channel, data);
      await frame();
      await frame();
      const sidebar = commits().slice(before).filter((commit) => commit.profilerId === profilerId);
      records.push({
        channel: push.recoveryBase ? "agent.canonical.recovery" : push.channel,
        commitCount: enabled ? sidebar.length : null,
        commitDurationMs: enabled ? sidebar.reduce((total, commit) => total + commit.actualDurationMs, 0) : null,
      });
    }
    return records;
  }, { events, profilerId: SIDEBAR_PROFILER_ID, profiling });
}

async function readAppliedTurnStatus(page, threadId, executionId) {
  return page.evaluate(({ thread, execution }) => {
    const record = window.__mcodeFrontendPerformanceModules?.threadStore.getState().records.get(thread);
    const turns = Object.values(record?.canonicalAgent?.state.turns ?? {});
    return turns.find((turn) => turn.executionId === execution)?.status ?? null;
  }, { thread: threadId, execution: executionId });
}

async function runStreamSample(context, sampleKey) {
  const { page, fixture, capture, mode } = context;
  const targetVisible = await openStreamTarget(page, fixture);
  const executionId = crypto.randomUUID();
  const events = buildSidebarStreamEvents(capture, fixture.streamTarget.id, sampleKey, executionId);
  const records = await replayStreamEvents(page, events, mode === "profiling");
  const total = records.reduce((sum, record) => sum + (record.commitDurationMs ?? 0), 0);
  return {
    durationMs: total,
    check: {
      targetVisible,
      appliedTurnStatus: await readAppliedTurnStatus(page, fixture.streamTarget.id, executionId),
      deliveredEvents: records.length,
      expectedEvents: events.length,
      events: records,
    },
  };
}

async function readFrameIndex(page) {
  return page.evaluate(() => window.__mcodePerformanceAttribution?.frameTimes.length ?? 0);
}

async function readFrameIntervals(page, fromIndex) {
  return page.evaluate((index) => {
    const times = window.__mcodePerformanceAttribution?.frameTimes.slice(index) ?? [];
    return times.slice(1).map((time, offset) => time - times[offset]);
  }, fromIndex);
}

async function readScrollPosition(page) {
  return page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const scroller = [...(body?.querySelectorAll("*") ?? [])].find((element) =>
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    return scroller
      ? { scrollTop: scroller.scrollTop, maxScrollTop: scroller.scrollHeight - scroller.clientHeight }
      : { scrollTop: 0, maxScrollTop: 0 };
  });
}

async function wheelToBottom(page) {
  const box = await page.getByTestId("sidebar-body").boundingBox();
  if (!box) throw new Error("The sidebar body has no layout box.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let steps = 0;
  let position = await readScrollPosition(page);
  while (position.scrollTop < position.maxScrollTop - 2 && steps < MAX_WHEEL_STEPS) {
    await page.mouse.wheel(0, WHEEL_STEP_PX);
    await nextFrames(page, 1);
    steps += 1;
    position = await readScrollPosition(page);
  }
  return { steps, position };
}

async function runScrollSample(context) {
  const { page, fixture, frameBudgetMs } = context;
  await scrollSidebarTo(page, "top");
  const frameIndex = await readFrameIndex(page);
  const startedAt = Date.now();
  const { steps, position } = await wheelToBottom(page);
  const durationMs = Date.now() - startedAt;
  const frames = summarizeFrameIntervals(await readFrameIntervals(page, frameIndex), frameBudgetMs);
  const rows = await readSidebarState(page, fixture.workspaces.map((workspace) => workspace.id));
  const scrollable = position.maxScrollTop > 0;
  return {
    // A sidebar that does not overflow has no scroll to time, so the sample carries no duration.
    durationMs: scrollable ? frames.p95Ms ?? Number.NaN : Number.NaN,
    check: {
      wheelSteps: steps,
      scrollDurationMs: durationMs,
      scrollHeightPx: position.maxScrollTop,
      scrollable,
      reachedBottom: position.scrollTop >= position.maxScrollTop - 2,
      frames,
      ...rows,
    },
  };
}

/** Installs a pre-navigation sink that records sidebar commits and the first painted seeded thread row during boot. */
async function installBootProbe(page) {
  await page.addInitScript(({ profilerId, prefix }) => {
    const boot = { sidebarCommits: [], firstThreadRowMs: null };
    window.__mcodeSidebarBoot = boot;
    window.__mcodeReactPerformanceSink = {
      recordCommit(commit) {
        if (commit.profilerId === profilerId) boot.sidebarCommits.push(commit);
      },
      recordRowRender() {},
    };
    const poll = (time) => {
      const rows = document.querySelectorAll('[data-testid="sidebar-body"] [role="button"]');
      if ([...rows].some((row) => row.textContent?.includes(prefix))) {
        boot.firstThreadRowMs = time;
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }, { profilerId: SIDEBAR_PROFILER_ID, prefix: THREAD_TITLE_PREFIX });
}

function createThreadListByteCounter(page) {
  const state = { requests: new Set(), responses: 0, bytes: 0, socketSeen: false };
  const parse = (payload) => {
    try { return JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8")); } catch { return null; }
  };
  const onSocket = (socket) => {
    state.socketSeen = true;
    socket.on("framesent", ({ payload }) => {
      const message = parse(payload);
      if (message?.method === "thread.list") state.requests.add(message.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = parse(payload);
      if (!message || !state.requests.has(message.id)) return;
      state.responses += 1;
      state.bytes += Buffer.byteLength(typeof payload === "string" ? payload : payload);
    });
  };
  page.on("websocket", onSocket);
  return {
    reset() { state.requests.clear(); state.responses = 0; state.bytes = 0; state.socketSeen = false; },
    read() { return state.socketSeen ? { responses: state.responses, bytes: state.bytes } : { responses: null, bytes: null }; },
    dispose() { page.off("websocket", onSocket); },
  };
}

async function readHeapAfterGc(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage");
    const usage = await session.send("Runtime.getHeapUsage");
    return { usedBytes: usage.usedSize, totalBytes: usage.totalSize };
  } finally {
    await session.detach();
  }
}

async function readBootProbe(page) {
  return page.evaluate(() => {
    const boot = window.__mcodeSidebarBoot;
    const commits = boot?.sidebarCommits ?? [];
    return {
      firstThreadRowMs: boot?.firstThreadRowMs ?? null,
      firstSidebarCommitMs: commits[0]?.commitTimeMs ?? null,
      sidebarCommitsBeforeSettle: commits.length,
      sidebarCommitDurationMs: commits.reduce((total, commit) => total + commit.actualDurationMs, 0),
    };
  });
}

async function runHydrationSample(context) {
  const { page, fixture, byteCounter, modeCollector, signalCollector } = context;
  byteCounter.reset();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mcodeSidebarBoot?.firstThreadRowMs != null, null, { timeout: HYDRATION_TIMEOUT_MS });
  const loadedThreads = await waitForStableThreadCount(page, fixture.workspaces.map((workspace) => workspace.id));
  const boot = await readBootProbe(page);
  await modeCollector.install();
  await signalCollector.install();
  const heap = await readHeapAfterGc(page);
  const rows = await readSidebarState(page, fixture.workspaces.map((workspace) => workspace.id));
  return {
    durationMs: boot.firstThreadRowMs ?? Number.NaN,
    check: { ...boot, threadList: byteCounter.read(), heap, ...rows, loadedThreads },
  };
}

const SIDEBAR_CHECKS = {
  sidebarStream: (check) => [
    [check.targetVisible, "the stream target row was not in the sidebar"],
    [check.deliveredEvents === check.expectedEvents, "not every recorded push was delivered"],
    [check.appliedTurnStatus === "Interrupted", "the thread store did not apply the replayed turn"],
  ],
  sidebarScroll: (check) => [
    [check.reachedBottom, "the wheel did not reach the bottom of the sidebar"],
    [!check.scrollable || check.frames.frameCount > 0, "no frames were recorded during the scroll"],
  ],
  sidebarHydration: (check, mode) => [
    [Number.isFinite(check.firstThreadRowMs), "no seeded thread row painted after reload"],
    [mode !== "profiling" || check.sidebarCommitsBeforeSettle > 0, "the sidebar Profiler recorded no commits"],
  ],
};

/** Returns the failure messages for one sidebar workload sample. */
export function validateSidebarCheck(workload, check, mode) {
  return SIDEBAR_CHECKS[workload](check, mode).filter(([passed]) => !passed).map(([, message]) => message);
}

const SIDEBAR_SAMPLE_RUNNERS = {
  sidebarStream: (context, index) => runStreamSample(context, `${context.runtime}-${index + 1}`),
  sidebarScroll: (context) => runScrollSample(context),
  sidebarHydration: (context) => runHydrationSample(context),
};

async function runSidebarWorkload(context, workload) {
  const run = SIDEBAR_SAMPLE_RUNNERS[workload];
  await run(context, -1);
  const rawSamples = [];
  for (let index = 0; index < context.sampleCount; index += 1) {
    const { result, attribution } = await context.modeCollector.measure(() => run(context, index));
    const failures = validateSidebarCheck(workload, result.check, context.mode);
    rawSamples.push({
      sampleIndex: index,
      durationMs: result.durationMs,
      attribution: { ...attribution, react: null },
      correctness: { passed: failures.length === 0, failures, observed: result.check },
    });
  }
  return buildSidebarMetric(workload, rawSamples);
}

function buildSidebarMetric(workload, rawSamples) {
  const accepted = rawSamples.filter((sample) => sample.correctness.passed);
  return {
    rawSamples,
    summary: summarizeDurationSamples(accepted.map((sample) => sample.durationMs).filter(Number.isFinite)),
    sidebarStream: workload === "sidebarStream"
      ? summarizeSidebarStreamEvents(accepted.map((sample) => sample.correctness.observed.events))
      : null,
    correctness: {
      passed: accepted.length === rawSamples.length,
      rejectedSamples: rawSamples.length - accepted.length,
    },
  };
}

/** Runs the selected sidebar workloads against the seeded sidebar fixture in one runtime. */
export async function runSidebarMatrix(page, runtime, sampleCount, mode, options) {
  const { sidebarFixture: fixture, canonicalCapture: capture, workloads } = options;
  if (!fixture || !capture) throw new Error("Sidebar workloads need the sidebar thread fixture and the canonical capture.");
  await installBootProbe(page);
  const byteCounter = createThreadListByteCounter(page);
  const signalCollector = await createPageSignalCollector(page);
  const modeCollector = await createModeSignalCollector(page, mode);
  try {
    const loadedThreads = await prepareSidebar(page, fixture);
    const refresh = await measureRefreshRate(page);
    const context = {
      page, runtime, sampleCount, mode, fixture, capture, byteCounter, modeCollector, signalCollector,
      frameBudgetMs: refresh.medianFrameIntervalMs,
    };
    const metrics = {};
    for (const workload of workloads) metrics[workload] = await runSidebarWorkload(context, workload);
    const observations = await signalCollector.read();
    return {
      runtime,
      buildMode: mode,
      sampleCount,
      workloads,
      sidebarFixture: { requestedThreadCount: fixture.requestedThreadCount, seededThreadCount: fixture.seededThreadCount, loadedThreadsAfterExpand: loadedThreads },
      display: refresh,
      metrics,
      observations,
      correctness: {
        passed: Object.values(metrics).every((metric) => metric.correctness.passed),
        rejectedSamples: Object.values(metrics).reduce((total, metric) => total + metric.correctness.rejectedSamples, 0),
      },
    };
  } finally {
    byteCounter.dispose();
    signalCollector.dispose();
    await modeCollector.dispose();
  }
}
