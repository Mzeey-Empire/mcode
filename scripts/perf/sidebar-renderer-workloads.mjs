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
  "sidebarCompleteFlight",
  "sidebarOlderCrossing",
  "sidebarIdleTick",
]);

const SIDEBAR_PROFILER_ID = "sidebar";
const THREAD_TITLE_PREFIX = "Sidebar perf";
const WHEEL_STEP_PX = 100;
const MAX_WHEEL_STEPS = 4_000;
const REFRESH_PROBE_FRAMES = 120;
const HYDRATION_TIMEOUT_MS = 60_000;
const FLIGHT_TIMEOUT_MS = 20_000;
const CROSSING_THREAD_COUNT = 5;
const CROSSING_LEAD_MS = 1_500;
const OLDER_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;
const IDLE_WINDOW_MS = 61_000;
const ROW_RENDER_PREFIX = "sidebar-thread:";
const AGE_RENDER_PREFIX = "sidebar-age:";
const SET_ROWS_COUNTER = "sidebar.setRows";

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

const STREAM_BUCKET_FIELDS = [
  ["durations", "commitDurationMs"],
  ["commits", "commitCount"],
  ["rowRenders", "rowRenderCount"],
  ["rowsRendered", "rowsRendered"],
  ["setRows", "setRowsCount"],
];

function emptyStreamBucket() {
  return Object.fromEntries(STREAM_BUCKET_FIELDS.map(([field]) => [field, []]));
}

function finiteMax(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : null;
}

/** Aggregates per-event sidebar commit records from accepted stream samples, split by push channel. */
export function summarizeSidebarStreamEvents(samples) {
  const byChannel = {};
  for (const event of samples.flat()) {
    const bucket = byChannel[event.channel] ?? (byChannel[event.channel] = emptyStreamBucket());
    for (const [field, key] of STREAM_BUCKET_FIELDS) bucket[field].push(event[key] ?? null);
  }
  const summarize = ({ durations, commits, rowRenders, rowsRendered, setRows }) => ({
    eventCount: durations.length,
    commitDurationP50Ms: percentile(durations, 0.5),
    commitDurationP95Ms: percentile(durations, 0.95),
    commitsPerEventP50: percentile(commits, 0.5),
    commitsPerEventMax: finiteMax(commits),
    totalCommits: commits.reduce((total, count) => total + (count ?? 0), 0),
    rowRendersPerEventP50: percentile(rowRenders, 0.5),
    rowRendersPerEventMax: finiteMax(rowRenders),
    rowsRenderedPerEventMax: finiteMax(rowsRendered),
    setRowsPerEventP50: percentile(setRows, 0.5),
    setRowsPerEventMax: finiteMax(setRows),
  });
  const all = Object.values(byChannel).reduce(
    (merged, bucket) => Object.fromEntries(STREAM_BUCKET_FIELDS.map(([field]) => [field, [...merged[field], ...bucket[field]]])),
    emptyStreamBucket(),
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

/**
 * Builds the single-thread pushes that follow the turn: an activity bump and a linked pull
 * request, each of which should re-render only the target row.
 */
export function buildSidebarSignalPushes(targetThreadId, atIso, prNumber) {
  return [
    { channel: "thread.activity", data: { threadId: targetThreadId, at: atIso } },
    {
      channel: "thread.pullRequests",
      data: {
        threadId: targetThreadId,
        pullRequests: [{ number: prNumber, state: "open", title: "Sidebar perf PR", url: `https://example.com/pull/${prNumber}` }],
      },
    },
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

function threadRowLocator(page, title) {
  return page.locator('[data-testid="thread-item"]', { has: page.getByText(title, { exact: true }) }).locator('[role="button"]');
}

async function scrollSidebarByPage(page) {
  const moved = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const scroller = [...(body?.querySelectorAll("*") ?? [])].find((element) =>
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return false;
    scroller.scrollTop += scroller.clientHeight * 0.8;
    return true;
  });
  await nextFrames(page, 2);
  return moved;
}

/** Scrolls the virtual list a page at a time from the top until the titled row mounts. */
async function revealThreadRow(page, title) {
  await scrollSidebarTo(page, "top");
  const row = threadRowLocator(page, title);
  for (let step = 0; step < MAX_WHEEL_STEPS; step += 1) {
    if ((await row.count()) > 0) return row.first();
    if (!(await scrollSidebarByPage(page))) break;
  }
  return (await row.count()) > 0 ? row.first() : null;
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
    const mountedRows = [...(body?.querySelectorAll('[data-testid="thread-item"]') ?? [])]
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
  const row = await revealThreadRow(page, fixture.streamTarget.title);
  if (!row) return false;
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
  return page.evaluate(async ({ events: pushes, profilerId, profiling: enabled, rowPrefix, setRowsCounter }) => {
    const modules = window.__mcodeFrontendPerformanceModules;
    const commits = () => window.__mcodePerformanceAttribution?.commits ?? [];
    const rowRenders = () => ({ ...window.__mcodePerformanceAttribution?.rowRenders });
    const setRows = () => window.__mcodePerformanceAttribution?.counters?.[setRowsCounter] ?? 0;
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
      const rendersBefore = rowRenders();
      const setRowsBefore = setRows();
      modules.push(push.channel, data);
      await frame();
      await frame();
      const sidebar = commits().slice(before).filter((commit) => commit.profilerId === profilerId);
      const rendered = Object.entries(rowRenders())
        .filter(([rowId, count]) => rowId.startsWith(rowPrefix) && count > (rendersBefore[rowId] ?? 0))
        .map(([rowId, count]) => count - (rendersBefore[rowId] ?? 0));
      records.push({
        channel: push.recoveryBase ? "agent.canonical.recovery" : push.channel,
        commitCount: enabled ? sidebar.length : null,
        commitDurationMs: enabled ? sidebar.reduce((total, commit) => total + commit.actualDurationMs, 0) : null,
        rowRenderCount: enabled ? rendered.reduce((total, count) => total + count, 0) : null,
        rowsRendered: enabled ? rendered.length : null,
        setRowsCount: enabled ? setRows() - setRowsBefore : null,
      });
    }
    return records;
  }, { events, profilerId: SIDEBAR_PROFILER_ID, profiling, rowPrefix: ROW_RENDER_PREFIX, setRowsCounter: SET_ROWS_COUNTER });
}

async function readAppliedTurnStatus(page, threadId, executionId) {
  return page.evaluate(({ thread, execution }) => {
    const record = window.__mcodeFrontendPerformanceModules?.threadStore.getState().records.get(thread);
    const turns = Object.values(record?.canonicalAgent?.state.turns ?? {});
    return turns.find((turn) => turn.executionId === execution)?.status ?? null;
  }, { thread: threadId, execution: executionId });
}

async function runStreamSample(context, sampleKey, sampleIndex) {
  const { page, fixture, capture, mode } = context;
  const targetVisible = await openStreamTarget(page, fixture);
  const executionId = crypto.randomUUID();
  const events = [
    ...buildSidebarStreamEvents(capture, fixture.streamTarget.id, sampleKey, executionId),
    ...buildSidebarSignalPushes(fixture.streamTarget.id, new Date().toISOString(), 1_001 + sampleIndex),
  ];
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

// `thread.listAll` replaced the per-project `thread.list` pages; count either so baseline and head compare.
const THREAD_LIST_METHODS = new Set(["thread.list", "thread.listAll"]);

function createThreadListByteCounter(page) {
  const state = { requests: new Set(), responses: 0, bytes: 0, socketSeen: false };
  const parse = (payload) => {
    try { return JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8")); } catch { return null; }
  };
  const onSocket = (socket) => {
    state.socketSeen = true;
    socket.on("framesent", ({ payload }) => {
      const message = parse(payload);
      if (THREAD_LIST_METHODS.has(message?.method)) state.requests.add(message.id);
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

/**
 * Counts rAF intervals that end inside a window, against the frame budget. A flight's frames are
 * the intervals whose end falls from its first copy appearing to its last copy landing.
 */
export function summarizeFramesInWindow(frameTimes, startMs, endMs, budgetMs) {
  const intervals = [];
  for (let index = 1; index < frameTimes.length; index += 1) {
    if (frameTimes[index] > startMs && frameTimes[index] <= endMs) intervals.push(frameTimes[index] - frameTimes[index - 1]);
  }
  return summarizeFrameIntervals(intervals, budgetMs);
}

/** Records when flying title copies join and leave the document body. */
async function installFlightObserver(page) {
  await page.evaluate(() => {
    window.__mcodeSidebarFlights?.observer.disconnect();
    const log = { added: [], removed: [], observer: null };
    const isCopy = (node) => node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true" && node.style.position === "fixed";
    log.observer = new MutationObserver((mutations) => {
      const now = performance.now();
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) if (isCopy(node)) log.added.push(now);
        for (const node of mutation.removedNodes) if (isCopy(node)) log.removed.push(now);
      }
    });
    log.observer.observe(document.body, { childList: true });
    window.__mcodeSidebarFlights = log;
  });
}

async function waitForFlightsLanded(page, expectRowsGone) {
  await page.waitForFunction(({ ids }) => {
    const log = window.__mcodeSidebarFlights;
    const gone = ids.every((id) => !document.querySelector(`[data-testid="thread-item"][data-thread-id="${CSS.escape(id)}"]`));
    return gone && log && log.added.length > 0 && log.removed.length === log.added.length;
  }, { ids: expectRowsGone }, { timeout: FLIGHT_TIMEOUT_MS });
  await nextFrames(page, 3);
  return page.evaluate(() => {
    const log = window.__mcodeSidebarFlights;
    log.observer.disconnect();
    return { flights: log.added.length, firstFlightMs: Math.min(...log.added), landedMs: Math.max(...log.removed) };
  });
}

async function moveMouseOutOfSidebar(page) {
  await page.mouse.move(1_200, 500);
  await nextFrames(page, 2);
}

async function setSidebarView(page, view) {
  const toggle = page.getByRole("button", { name: view === "flat" ? "Show as one list" : "Group by project", exact: true });
  if ((await toggle.count()) > 0) await toggle.click();
  await nextFrames(page, 30);
}

/** Lists thread rows whose box sits fully inside the sidebar scroller, top to bottom. */
async function readVisibleThreadRows(page, excludeIds) {
  return page.evaluate((excluded) => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const scroller = [...(body?.querySelectorAll("*") ?? [])].find((element) =>
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) ?? body;
    const view = scroller.getBoundingClientRect();
    const olderTop = document.querySelector('[data-testid="older-bar"]')?.getBoundingClientRect().top ?? view.bottom;
    return [...document.querySelectorAll('[data-testid="thread-item"]')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ element, rect }) => !excluded.includes(element.dataset.threadId) && rect.height > 0
        && rect.top >= view.top && rect.bottom <= Math.min(view.bottom, olderTop))
      .sort((left, right) => left.rect.top - right.rect.top)
      .map(({ element }) => ({ id: element.dataset.threadId, title: element.querySelector('[data-testid="thread-title"]')?.textContent?.trim() ?? "" }));
  }, excludeIds);
}

async function readPageNow(page) {
  return page.evaluate(() => performance.now());
}

async function measureFlightFrames(context, startMs, landing) {
  const { page, frameBudgetMs } = context;
  const frameTimes = await page.evaluate(() => [...(window.__mcodePerformanceAttribution?.frameTimes ?? [])]);
  return {
    clickToLanding: summarizeFramesInWindow(frameTimes, startMs, landing.landedMs, frameBudgetMs),
    flight: summarizeFramesInWindow(frameTimes, landing.firstFlightMs, landing.landedMs, frameBudgetMs),
  };
}

async function runCompletionFlightSample(context) {
  const { page, fixture } = context;
  await setSidebarView(page, "grouped");
  await scrollSidebarTo(page, "top");
  await moveMouseOutOfSidebar(page);
  const [candidate] = await readVisibleThreadRows(page, [fixture.streamTarget.id]);
  if (!candidate) return { durationMs: Number.NaN, check: { candidate: null } };
  await installFlightObserver(page);
  await threadRowLocator(page, candidate.title).first().hover();
  const clickedMs = await readPageNow(page);
  await page.getByRole("button", { name: `Complete ${candidate.title}`, exact: true }).click();
  await moveMouseOutOfSidebar(page);
  const landing = await waitForFlightsLanded(page, [candidate.id]);
  const frames = await measureFlightFrames(context, clickedMs, landing);
  return {
    durationMs: landing.landedMs - landing.firstFlightMs,
    check: { candidate, ...landing, clickToLandingMs: landing.landedMs - clickedMs, frames, ...(await readSidebarState(page, fixture.workspaces.map((workspace) => workspace.id))) },
  };
}

/**
 * Ages the five lowest Recent rows on screen to just short of the Older boundary in the client
 * store, so the sidebar's own boundary timer moves them into Older. Rows already at the bottom
 * of Recent keep their order, so nothing reorders before the crossing.
 */
async function ageThreadsToBoundary(page, ids) {
  return page.evaluate(({ threadIds, days, dayMs, leadMs }) => {
    const store = window.__mcodeFrontendPerformanceModules.workspaceStore;
    const crossAt = Date.now() + leadMs;
    const at = new Date(crossAt - days * dayMs).toISOString();
    const owned = new Set(threadIds);
    store.setState((state) => ({ threads: state.threads.map((thread) => owned.has(thread.id) ? { ...thread, last_activity_at: at } : thread) }));
    return performance.now() + leadMs;
  }, { threadIds: ids, days: OLDER_AFTER_DAYS, dayMs: DAY_MS, leadMs: CROSSING_LEAD_MS });
}

/** The five oldest Recent threads in the fixture: the last rows of the flat Active list. */
async function readOldestRecentThreads(page, workspaceIds, excludeId) {
  return page.evaluate(({ ids, excluded, days, dayMs, count }) => {
    const owned = new Set(ids);
    const cutoff = Date.now() - days * dayMs;
    return window.__mcodeFrontendPerformanceModules.workspaceStore.getState().threads
      .filter((thread) => owned.has(thread.workspace_id) && thread.id !== excluded && !thread.user_completed_at
        && Date.parse(thread.last_activity_at) >= cutoff)
      .sort((left, right) => Date.parse(left.last_activity_at) - Date.parse(right.last_activity_at))
      .slice(0, count)
      .map((thread) => thread.id);
  }, { ids: workspaceIds, excluded: excludeId, days: OLDER_AFTER_DAYS, dayMs: DAY_MS, count: CROSSING_THREAD_COUNT });
}

async function alignRowToTop(page, threadId) {
  const moved = await page.evaluate((id) => {
    const body = document.querySelector('[data-testid="sidebar-body"]');
    const scroller = [...(body?.querySelectorAll("*") ?? [])].find((element) =>
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    const row = document.querySelector(`[data-testid="thread-item"][data-thread-id="${CSS.escape(id)}"]`);
    if (!scroller || !row) return false;
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (delta < 1) return false;
    scroller.scrollTop += delta;
    return true;
  }, threadId);
  await nextFrames(page, 2);
  return moved;
}

// Scrolls down a page at a time rather than jumping to the end, because the flat list's scroll
// height overshoots its rows at 1,000+ threads and the end of the list renders blank.
async function revealThreadIds(page, ids, excludeId) {
  await scrollSidebarTo(page, "top");
  for (let step = 0; step < MAX_WHEEL_STEPS; step += 1) {
    const visible = await readVisibleThreadRows(page, [excludeId]);
    const shown = visible.filter((row) => ids.includes(row.id));
    if (shown.length === ids.length) return shown;
    const moved = shown.length > 0 ? await alignRowToTop(page, shown[0].id) : await scrollSidebarByPage(page);
    if (!moved) return shown;
  }
  return [];
}

async function runOlderCrossingSample(context) {
  const { page, fixture } = context;
  await setSidebarView(page, "flat");
  await moveMouseOutOfSidebar(page);
  const workspaceIds = fixture.workspaces.map((workspace) => workspace.id);
  const oldest = await readOldestRecentThreads(page, workspaceIds, fixture.streamTarget.id);
  const crossing = await revealThreadIds(page, oldest, fixture.streamTarget.id);
  if (oldest.length < CROSSING_THREAD_COUNT || crossing.length < CROSSING_THREAD_COUNT) {
    await setSidebarView(page, "grouped");
    return { durationMs: Number.NaN, check: { crossing } };
  }
  await installFlightObserver(page);
  const crossAtMs = await ageThreadsToBoundary(page, crossing.map((row) => row.id));
  const landing = await waitForFlightsLanded(page, crossing.map((row) => row.id));
  const frames = await measureFlightFrames(context, crossAtMs, landing);
  const rows = await readSidebarState(page, fixture.workspaces.map((workspace) => workspace.id));
  await setSidebarView(page, "grouped");
  return { durationMs: landing.landedMs - landing.firstFlightMs, check: { crossing, ...landing, frames, ...rows } };
}

// The minute ticker re-renders only each row's age line, so idle renders count the row and its age line.
async function readRowRenderTotal(page) {
  return page.evaluate((prefixes) => Object.entries(window.__mcodePerformanceAttribution?.rowRenders ?? {})
    .filter(([rowId]) => prefixes.some((prefix) => rowId.startsWith(prefix)))
    .reduce((total, [, count]) => total + count, 0), [ROW_RENDER_PREFIX, AGE_RENDER_PREFIX]);
}

/** Leaves the sidebar idle across at least one minute tick and counts thread row renders. */
async function runIdleTickSample(context) {
  const { page, fixture } = context;
  await moveMouseOutOfSidebar(page);
  const before = await readRowRenderTotal(page);
  const startedAt = Date.now();
  await page.waitForTimeout(IDLE_WINDOW_MS);
  const elapsedMs = Date.now() - startedAt;
  const renders = (await readRowRenderTotal(page)) - before;
  const rowsPerMinute = (renders * 60_000) / elapsedMs;
  return {
    durationMs: rowsPerMinute,
    check: { renders, elapsedMs, rowsPerMinute, profiling: context.mode === "profiling", ...(await readSidebarState(page, fixture.workspaces.map((workspace) => workspace.id))) },
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
  sidebarCompleteFlight: (check) => [
    [check.candidate != null, "no thread row besides the stream target was on screen"],
    [check.candidate == null || check.flights >= 1, "the completed row did not fly"],
  ],
  sidebarOlderCrossing: (check) => [
    [check.crossing.length === CROSSING_THREAD_COUNT, "fewer than five Recent rows were on screen"],
    [check.crossing.length < CROSSING_THREAD_COUNT || check.flights >= 1, "no row flew to the Older bar"],
  ],
  sidebarIdleTick: (check) => [
    [check.profiling, "row renders are only counted in a profiling build"],
    [check.elapsedMs >= 60_000, "the idle window was shorter than one minute tick"],
  ],
};

/** Returns the failure messages for one sidebar workload sample. */
export function validateSidebarCheck(workload, check, mode) {
  return SIDEBAR_CHECKS[workload](check, mode).filter(([passed]) => !passed).map(([, message]) => message);
}

const SIDEBAR_SAMPLE_RUNNERS = {
  sidebarStream: (context, index) => runStreamSample(context, `${context.runtime}-${index + 1}`, index + 1),
  sidebarScroll: (context) => runScrollSample(context),
  sidebarHydration: (context) => runHydrationSample(context),
  sidebarCompleteFlight: (context) => runCompletionFlightSample(context),
  sidebarOlderCrossing: (context) => runOlderCrossingSample(context),
  sidebarIdleTick: (context) => runIdleTickSample(context),
};

const TRACED_SIDEBAR_WORKLOADS = new Set(["sidebarCompleteFlight", "sidebarOlderCrossing"]);

/** Saves a Chrome trace of each flight workload's first measured sample beside the results. */
function sampleMeasureOptions(context, workload, index) {
  if (!TRACED_SIDEBAR_WORKLOADS.has(workload) || index !== 0 || !context.traceDirectory) return {};
  return { trace: true, traceFile: `${context.traceDirectory}/${context.runtime}-${context.mode}-${context.fixture.requestedThreadCount}-${workload}.trace.json` };
}

async function runSidebarWorkload(context, workload) {
  const run = SIDEBAR_SAMPLE_RUNNERS[workload];
  await run(context, -1);
  const rawSamples = [];
  for (let index = 0; index < context.sampleCount; index += 1) {
    const { result, attribution } = await context.modeCollector.measure(() => run(context, index), sampleMeasureOptions(context, workload, index));
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
  const { sidebarFixture: fixture, canonicalCapture: capture, workloads, traceDirectory = null } = options;
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
      frameBudgetMs: refresh.medianFrameIntervalMs, traceDirectory,
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
