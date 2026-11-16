import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Shortest server observation window once the usable frame is known, measured from the server's listen. */
export const LAUNCH_MIN_WINDOW_MS = 30_000;
/** How long observation continues after the usable frame, so work that the frame triggered is still seen. */
export const LAUNCH_SETTLE_MS = 10_000;
/**
 * How long desktop waits for a server it spawned to answer health, including an awaited local conversation-data
 * migration before the server can report readiness.
 */
export const SERVER_STARTUP_TIMEOUT_MS = 10 * 60_000;
/**
 * Desktop's usable-frame timeout from the server's first health answer. Startup failures within
 * `SERVER_STARTUP_TIMEOUT_MS` are recorded as such.
 */
export const LAUNCH_USABLE_LIMIT_MS = 120_000;
/**
 * How long, from listen, the server keeps a window nobody has read. Desktop waits at most one startup timeout for
 * health, counted from the spawn, which precedes listen. The 30 seconds covers the health probe in flight at that
 * deadline, and desktop reads by the end of its usable limit, which starts at health. A window still unread after
 * that has lost its desktop, so the server drops it instead of sampling for its whole life.
 */
export const LAUNCH_RETENTION_MS = SERVER_STARTUP_TIMEOUT_MS + LAUNCH_USABLE_LIMIT_MS + 30_000;
/** Requests one window keeps, answered or not. Later requests only count toward `rpcsDropped`. */
export const LAUNCH_RPC_LIMIT = 10_000;
/** Desktop main milestones, measured in epoch milliseconds. */
export const MAIN_LAUNCH_MARKS = [
  "mainModuleStart",
  "whenReady",
  "windowCreated",
  "serverSpawned",
  "serverHealthy",
  "readyToShow",
] as const;
/** Renderer milestones accepted by the desktop host. */
export const RENDERER_LAUNCH_MARKS = [
  "scriptsEvaluated",
  "urlReceived",
  "socketOpen",
  "workspaceListAnswered",
  "threadListAnswered",
  "settingsAnswered",
  "reactCommitted",
  "usable",
  "threadReopened",
] as const;
/** A key of {@link LaunchRecord}'s `main` map. */
export type MainLaunchMark = typeof MAIN_LAUNCH_MARKS[number];
/** A key of {@link LaunchRecord}'s `renderer` map. */
export type RendererLaunchMark = typeof RENDERER_LAUNCH_MARKS[number];
/** A server startup boundary. A name repeats when its step repeats, such as once per interrupted checkpoint. */
export const LaunchMarkSchema = lazySchema(() => z.object({
  name: z.string(),
  at: z.number().finite(),
}));
/** A server startup boundary parsed by {@link LaunchMarkSchema}. */
export type LaunchMark = z.infer<ReturnType<typeof LaunchMarkSchema>>;
/** The bounded server observation window returned once to desktop main. */
export const ServerLaunchTelemetrySchema = lazySchema(() => z.object({
  launchId: z.string().uuid(),
  migrated: z.boolean(),
  marks: z.array(LaunchMarkSchema()),
  listenAt: z.number().finite(),
  windowEndAt: z.number().finite(),
  rpcs: z.array(z.object({
    method: z.string(),
    startAt: z.number().finite(),
    durationMs: z.number().finite(),
    responseBytes: z.number().nonnegative(),
  })).max(LAUNCH_RPC_LIMIT),
  unansweredRpcs: z.array(z.object({
    method: z.string(),
    startAt: z.number().finite(),
  })).max(LAUNCH_RPC_LIMIT),
  rpcsDropped: z.number().int().nonnegative(),
  tasks: z.array(z.object({
    name: z.string(),
    startAt: z.number().finite(),
    endAt: z.number().finite().nullable(),
  })),
  stalls: z.array(z.object({
    startAt: z.number().finite(),
    endAt: z.number().finite(),
  })),
  memory: z.array(z.object({
    at: z.number().finite(),
    rssBytes: z.number().nonnegative(),
  })),
}));
/** Server observations parsed by {@link ServerLaunchTelemetrySchema}. */
export type ServerLaunchTelemetry = z.infer<ReturnType<typeof ServerLaunchTelemetrySchema>>;
/** One complete or interrupted desktop launch, written once to the rotating log. */
export const LaunchRecordSchema = lazySchema(() => z.object({
  version: z.literal(1),
  launchId: z.string().uuid(),
  appVersion: z.string(),
  t0: z.number().finite().nullable(),
  bootAt: z.number().finite(),
  /** Whether this is the first launch since the OS booted; null when no earlier launch left its boot time. */
  firstSinceBoot: z.boolean().nullable(),
  serverMode: z.enum([
    "spawned",
    "reused",
  ]),
  main: z.record(z.enum(MAIN_LAUNCH_MARKS), z.number().finite()),
  renderer: z.record(z.enum(RENDERER_LAUNCH_MARKS), z.number().finite()),
  serverTelemetry: ServerLaunchTelemetrySchema().nullable(),
  serverTelemetryError: z.string().nullable(),
  writtenBecause: z.enum([
    "window-ended",
    "usable-timeout",
    "startup-failed",
    "quit",
  ]),
}));
/** One launch record parsed by {@link LaunchRecordSchema}. */
export type LaunchRecord = z.infer<ReturnType<typeof LaunchRecordSchema>>;
