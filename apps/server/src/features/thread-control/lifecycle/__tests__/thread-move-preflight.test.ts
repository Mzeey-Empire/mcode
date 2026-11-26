import "reflect-metadata";
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadMovePreflightService } from "../thread-move-preflight.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");

describe("ThreadMovePreflightService", () => {
  let folder: string;

  beforeEach(() => {
    folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-preflight-"));
  });
  afterEach(() => {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  });

  function service(options: { threads?: ReturnType<typeof createMockThread>[]; kind?: "no_project" | "project" } = {}) {
    const workspace = createMockWorkspace({ id: "no-project-1", kind: options.kind ?? "no_project", path: folder });
    const threads = [createMockThread({ id: "mine", workspace_id: workspace.id, title: "Mine" }), ...(options.threads ?? [])];
    return new ThreadMovePreflightService(
      {
        findById: (id) => threads.find((thread) => thread.id === id) ?? null,
        listAllByWorkspace: (workspaceId) => threads.filter((thread) => thread.workspace_id === workspaceId),
      },
      { findById: (id) => (id === workspace.id ? workspace : null) },
      () => NOW,
    );
  }

  it("reports files without naming or counting them", async () => {
    NodeFS.writeFileSync(NodePath.join(folder, "quarterly-secrets.csv"), "x");
    NodeFS.writeFileSync(NodePath.join(folder, "notes.md"), "y");

    const result = await service().read("mine");

    expect(result?.hasFiles).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/quarterly-secrets|notes\.md/);
    expect(Object.keys(result ?? {}).sort()).toEqual(["deadline", "hasFiles", "otherThreadsInFolder"]);
  });

  it("reports an empty or missing folder as holding no files", async () => {
    expect((await service().read("mine"))?.hasFiles).toBe(false);
    NodeFS.rmSync(folder, { recursive: true });
    expect((await service().read("mine"))?.hasFiles).toBe(false);
  });

  it("projects the deadline 7 days after now", async () => {
    expect((await service().read("mine"))?.deadline).toBe("2026-12-03T12:00:00.000Z");
  });

  it("lists the other live threads in the folder and skips deleted ones", async () => {
    const result = await service({
      threads: [
        createMockThread({ id: "fork", workspace_id: "no-project-1", title: "A fork" }),
        createMockThread({ id: "gone", workspace_id: "no-project-1", title: "Deleted", deleted_at: "2026-11-25T00:00:00.000Z" }),
        createMockThread({ id: "elsewhere", workspace_id: "project-1", title: "Elsewhere" }),
      ],
    }).read("mine");

    expect(result?.otherThreadsInFolder).toEqual({ count: 1, titles: ["A fork"] });
  });

  it("returns null for a thread that cannot move", async () => {
    expect(await service().read("missing")).toBeNull();
    expect(await service({ kind: "project" }).read("mine")).toBeNull();
  });
});
