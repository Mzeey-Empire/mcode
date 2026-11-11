import {
  LAUNCH_USABLE_LIMIT_MS,
  RENDERER_LAUNCH_MARKS,
  ServerLaunchTelemetrySchema,
  type LaunchRecord,
  type MainLaunchMark,
} from "@mcode/contracts/launch-telemetry";

type LaunchRecordDependencies = {
  launchId: string;
  appVersion: string;
  t0: number | null;
  bootAt: number;
  mainModuleStart: number;
  now(): number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** Fetches the server's window. With `usableAt` the server holds the response until the window closes. */
  fetch(usableAt?: number): Promise<Response>;
  write(record: LaunchRecord): void;
};

/** Collects one launch and owns its single log write. */
export function createLaunchRecord(deps: LaunchRecordDependencies) {
  let phase: "collecting" | "fetching" | "written" = "collecting";
  const record: LaunchRecord = {
    version: 1,
    launchId: deps.launchId,
    appVersion: deps.appVersion,
    t0: deps.t0,
    bootAt: deps.bootAt,
    firstSinceBoot: null,
    serverMode: "spawned",
    main: { mainModuleStart: deps.mainModuleStart },
    renderer: {},
    serverTelemetry: null,
    serverTelemetryError: null,
    writtenBecause: "quit",
  };
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  function write(reason: LaunchRecord["writtenBecause"]) {
    if (phase === "written") return;
    phase = "written";
    deps.clearTimeout(giveUp);
    record.writtenBecause = reason;
    deps.write(structuredClone(record));
  }
  async function readServerTelemetry(usableAt: number | undefined) {
    try {
      const response = await deps.fetch(usableAt);
      if (response.status !== 200) {
        record.serverTelemetryError = "http-status";
        return;
      }
      const parsed = ServerLaunchTelemetrySchema().safeParse(await response.json());
      if (!parsed.success) record.serverTelemetryError = "invalid-schema";
      else if (parsed.data.launchId !== deps.launchId) record.serverTelemetryError = "launch-id-mismatch";
      else record.serverTelemetry = parsed.data;
    } catch {
      record.serverTelemetryError = "fetch-failed";
    }
  }
  async function finish(reason: "window-ended" | "usable-timeout") {
    if (phase !== "collecting") return;
    phase = "fetching";
    deps.clearTimeout(giveUp);
    if (record.serverMode === "spawned") {
      await readServerTelemetry(reason === "window-ended" ? record.renderer.usable : undefined);
    }
    write(reason);
  }
  return {
    mark(name: MainLaunchMark, at = deps.now()) {
      if (phase !== "written" && record.main[name] === undefined) record.main[name] = at;
    },
    rendererMark(sender: unknown, mainWebContents: unknown, name: unknown, at: unknown) {
      if (phase === "written" || !mainWebContents || sender !== mainWebContents) return;
      const mark = RENDERER_LAUNCH_MARKS.find((candidate) => candidate === name);
      if (!mark || typeof at !== "number" || !Number.isFinite(at) || at <= 0 || record.renderer[mark] !== undefined) return;
      record.renderer[mark] = at;
      if (mark === "usable") void finish("window-ended");
    },
    bootClassified(firstSinceBoot: boolean | null) {
      if (phase !== "written") record.firstSinceBoot = firstSinceBoot;
    },
    /**
     * Starts the usable-frame wait at the first health answer. The window handover has no deadline of its own, so
     * starting here makes desktop read the server's window before the server drops it. Until health, the server
     * startup deadline bounds the launch, and a failed startup writes the record through {@link failed}.
     */
    serverHealthy(serverMode: LaunchRecord["serverMode"]) {
      if (phase !== "collecting" || record.main.serverHealthy !== undefined) return;
      record.main.serverHealthy = deps.now();
      record.serverMode = serverMode;
      giveUp = deps.setTimeout(() => void finish("usable-timeout"), LAUNCH_USABLE_LIMIT_MS);
    },
    failed() {
      write("startup-failed");
    },
    quit() {
      write("quit");
    },
  };
}
