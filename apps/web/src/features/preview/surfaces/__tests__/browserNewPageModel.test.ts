import type { BrowserHistoryEntry, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { projectServerTiles, recentPages, serverForPort } from "../browserNewPageModel";

function run(actionId: string, overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "ws-1",
    actionId,
    runId: `run-${actionId}`,
    revision: 1,
    terminalSessionId: "pty-1",
    trigger: "manual",
    port: {
      runId: `run-${actionId}`,
      port: 5173,
      host: "localhost",
      url: "http://localhost:5173/",
      reachable: false,
      detectedAt: "2026-08-22T12:00:02.000Z",
    },
    actionName: actionId,
    status: "interrupted",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: "2026-08-22T12:05:00.000Z",
    exitCode: null,
    ...overrides,
  };
}

function live(actionId: string, reachable: boolean): WorkspaceEnvironmentActionRun {
  const stopped = run(actionId);
  return { ...stopped, status: "running", finishedAt: null, port: { ...stopped.port!, reachable } };
}

function tilesOf(...runs: WorkspaceEnvironmentActionRun[]) {
  return projectServerTiles(Object.fromEntries(runs.map((entry) => [entry.actionId, entry])), []);
}

describe("serverForPort", () => {
  it("has no owner for a page that is not on loopback or a port nobody announced", () => {
    const tiles = tilesOf(run("web"));
    expect(serverForPort(null, tiles)).toBeNull();
    expect(serverForPort("3000", tiles)).toBeNull();
  });

  it("returns the single stopped tile on the port", () => {
    expect(serverForPort("5173", tilesOf(run("web")))?.actionId).toBe("web");
  });

  it("lets a running tile outrank a stopped one that sorts first", () => {
    expect(serverForPort("5173", tilesOf(run("api"), live("web", true)))?.actionId).toBe("web");
  });

  it("lets a starting tile outrank a stopped one but not a running one", () => {
    expect(serverForPort("5173", tilesOf(run("api"), live("web", false)))?.actionId).toBe("web");
    expect(serverForPort("5173", tilesOf(live("api", false), live("web", true)))?.actionId).toBe("web");
  });

  it("has no owner when two stopped tiles share the port", () => {
    expect(serverForPort("5173", tilesOf(run("api"), run("web")))).toBeNull();
  });
});

describe("recentPages", () => {
  const entry: BrowserHistoryEntry = {
    url: "http://localhost:5173/docs",
    title: null,
    faviconUrl: null,
    lastVisitedAt: 1,
  };

  it("names a page after the live server on its port, not a stopped one that sorts first", () => {
    const [page] = recentPages([entry], tilesOf(run("api"), live("web", true)));
    expect(page?.server).toBe("web");
  });

  it("falls back to the host when two stopped servers make the owner a guess", () => {
    const [page] = recentPages([entry], tilesOf(run("api"), run("web")));
    expect(page?.server).toBe("localhost:5173");
  });
});
