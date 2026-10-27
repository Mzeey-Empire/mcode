import * as NodePath from "node:path";

/** Title prefix that marks every synthetic sidebar thread. */
export const SIDEBAR_FIXTURE_TITLE_PREFIX = "Sidebar perf";

/** Title of the thread the stream workload replays a turn into. */
export const SIDEBAR_STREAM_TARGET_TITLE = `${SIDEBAR_FIXTURE_TITLE_PREFIX} stream target`;

/** Number of synthetic workspaces the threads are spread across. */
export const SIDEBAR_WORKSPACE_COUNT = 6;

/** Largest synthetic thread count the seeder accepts. */
export const SIDEBAR_MAX_THREADS = 5_000;

const DAY_MS = 86_400_000;
const SPREAD_DAYS = 120;

/** Returns the synthetic workspace folder names, in creation order. */
export function sidebarWorkspaceNames() {
  return Array.from({ length: SIDEBAR_WORKSPACE_COUNT }, (_, index) => `sidebar-perf-${index + 1}`);
}

/** Parses a synthetic thread count from 0 through {@link SIDEBAR_MAX_THREADS}. */
export function parseSidebarThreadCount(value) {
  const count = Number(value);
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(count) || count > SIDEBAR_MAX_THREADS) {
    throw new Error(`--sidebar-threads must be an integer from 0 through ${SIDEBAR_MAX_THREADS}`);
  }
  return count;
}

function isInside(parent, child) {
  const relative = NodePath.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

/**
 * Resolves the database the seeder may write. Only an `app.sqlite` under the
 * worktree's own `.dev/` qualifies, so the seeder cannot reach the live Mcode
 * database or another worktree's runtime.
 */
export function resolveSidebarFixtureDatabasePath(repoRoot, requested) {
  const devRoot = NodePath.resolve(repoRoot, ".dev");
  const dbPath = NodePath.resolve(repoRoot, requested ?? NodePath.join(".dev", "db", "app.sqlite"));
  const comparable = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
  if (!isInside(comparable(devRoot), comparable(dbPath)) || NodePath.basename(dbPath) !== "app.sqlite") {
    throw new Error(`Refusing to seed ${dbPath}: the database must be an app.sqlite inside ${devRoot}`);
  }
  return dbPath;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function planBackgroundThread(index, nowMs, random) {
  const createdMs = nowMs - DAY_MS - Math.floor(random() * SPREAD_DAYS * DAY_MS);
  const hasTurn = random() < 0.7;
  const lastTurnEndedMs = hasTurn ? createdMs + Math.floor(random() * (nowMs - createdMs)) : null;
  const updatedMs = Math.max(createdMs, lastTurnEndedMs ?? createdMs) + Math.floor(random() * 60_000);
  const completed = hasTurn && random() < 0.15;
  return {
    workspaceIndex: index % SIDEBAR_WORKSPACE_COUNT,
    title: `${SIDEBAR_FIXTURE_TITLE_PREFIX} thread ${String(index).padStart(5, "0")}`,
    createdAt: iso(createdMs),
    updatedAt: iso(Math.min(updatedMs, nowMs)),
    lastTurnEndedAt: lastTurnEndedMs === null ? null : iso(lastTurnEndedMs),
    lastTurnOutcome: hasTurn ? "completed" : null,
    userCompletedAt: completed && lastTurnEndedMs !== null ? iso(lastTurnEndedMs + 1_000) : null,
  };
}

/**
 * Plans the synthetic threads for one scale. The stream target always exists,
 * is the newest thread in the first workspace, and is never completed, so the
 * sidebar shows it at every scale. A count of 0 therefore still yields one thread.
 */
export function planSidebarThreads(count, nowMs) {
  const random = createRandom(0x5eed + count);
  const target = {
    workspaceIndex: 0,
    title: SIDEBAR_STREAM_TARGET_TITLE,
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs),
    lastTurnEndedAt: null,
    lastTurnOutcome: null,
    userCompletedAt: null,
  };
  const background = Array.from({ length: Math.max(0, count - 1) }, (_, index) =>
    planBackgroundThread(index + 1, nowMs, random));
  return [target, ...background];
}
