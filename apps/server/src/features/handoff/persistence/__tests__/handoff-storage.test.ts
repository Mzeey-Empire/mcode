import "reflect-metadata";
import { newHandoffUlid } from "@mcode/shared";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WS_METHODS } from "@mcode/contracts";
import { HandoffStorage, type HandoffAudit } from "../handoff-storage.js";
import { routeHandoffRpc } from "../../transport/handoff-rpc.js";

const audit: HandoffAudit = {
  kind: "switch", fromProvider: "claude", toProvider: "codex",
  coveredSequences: [1, 2], omittedSequences: [3], budgetBytes: 4096,
  droppedOptions: [{ option: "thinking", value: true, reason: "unsupported" }],
  history: "The replayed history",
};

describe("HandoffStorage", () => {
  let dir: string;
  let storage: HandoffStorage;
  beforeEach(async () => {
    dir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-storage-"));
    storage = HandoffStorage.forTesting({ mcodeDirFn: () => dir });
  });
  afterEach(async () => {
    await NodeFSPromises.rm(dir, { recursive: true, force: true });
  });

  it.each(["switch", "fork", "recovery"] as const)("reads a %s audit through the RPC contract", async (kind) => {
    const ulid = await storage.writeHandoffAudit("child", newHandoffUlid(), { ...audit, kind });
    const result = await routeHandoffRpc("handoff.readLatest", { threadId: "child" }, { handoffStorage: storage });
    const parsed = WS_METHODS()["handoff.readLatest"].result.parse(result);
    expect(parsed?.meta).toEqual({
      schemaVersion: 2, kind, fromProvider: "claude", toProvider: "codex",
      coveredSequences: [1, 2], omittedSequences: [3], budgetBytes: 4096,
      droppedOptions: [{ option: "thinking", value: true, reason: "unsupported" }],
    });
    expect(parsed?.markdown).toContain("\n\nThe replayed history\n");
    expect(await storage.readLatestHandoffAudit("child")).toBe(parsed?.markdown);
    expect(await NodeFSPromises.readdir(NodePath.join(dir, "threads", "child", "handoffs", ulid))).toEqual(["handoff.md"]);
  });

  it("returns the newest audit by ULID, independent of kind", async () => {
    const first = await storage.writeHandoffAudit("child", newHandoffUlid(), audit);
    const second = await storage.writeHandoffAudit("child", newHandoffUlid(), { ...audit, kind: "recovery", history: "Recovered history" });
    // Use fixed directory names so the assertion is independent of clock resolution and ULID randomness.
    const handoffs = NodePath.join(dir, "threads", "child", "handoffs");
    await NodeFSPromises.rename(NodePath.join(handoffs, first), NodePath.join(handoffs, "01"));
    await NodeFSPromises.rename(NodePath.join(handoffs, second), NodePath.join(handoffs, "02"));
    expect((await storage.readLatest("child"))?.meta.kind).toBe("recovery");
    expect(await storage.readLatestHandoffAudit("child")).toContain("Recovered history");
  });

  it("ignores legacy metadata and preserves existing audit files", async () => {
    const legacy = NodePath.join(dir, "threads", "child", "handoffs", "ZZZ-legacy");
    await NodeFSPromises.mkdir(legacy, { recursive: true });
    await NodeFSPromises.writeFile(NodePath.join(legacy, "handoff.md"), "---\nschemaVersion: 1\nmode: minimal\n---\nOld summary");
    await NodeFSPromises.writeFile(NodePath.join(legacy, "handoff.json"), '{"schemaVersion":1,"mode":"minimal"}');
    expect(await storage.readLatest("child")).toBeNull();
    await storage.writeHandoffAudit("child", newHandoffUlid(), audit);
    expect((await storage.readLatest("child"))?.meta.schemaVersion).toBe(2);
    expect(await NodeFSPromises.readFile(NodePath.join(legacy, "handoff.json"), "utf8")).toBe('{"schemaVersion":1,"mode":"minimal"}');
  });

  it("skips invalid frontmatter and round trips quoted provider IDs", async () => {
    const invalid = NodePath.join(dir, "threads", "child", "handoffs", "ZZZ-invalid");
    await NodeFSPromises.mkdir(invalid, { recursive: true });
    await NodeFSPromises.writeFile(NodePath.join(invalid, "handoff.md"), "---\nschemaVersion: 2\nkind: unknown\n---\nInvalid");
    await storage.writeHandoffAudit("child", newHandoffUlid(), { ...audit, fromProvider: null, toProvider: "custom: provider\nname" });
    expect((await storage.readLatest("child"))?.meta).toMatchObject({ fromProvider: null, toProvider: "custom: provider\nname" });
  });

  it("skips an audit whose write is still in progress", async () => {
    await storage.writeHandoffAudit("child", newHandoffUlid(), audit);
    const inProgress = NodePath.join(dir, "threads", "child", "handoffs", "ZZZ-in-progress");
    await NodeFSPromises.mkdir(inProgress, { recursive: true });
    await NodeFSPromises.writeFile(NodePath.join(inProgress, "handoff.md.partial"), "---\nschemaVersion: 2\n");
    expect((await storage.readLatest("child"))?.meta.kind).toBe("switch");
  });

  it("returns null for an absent thread and removes audits on thread deletion", async () => {
    expect(await storage.readLatest("absent")).toBeNull();
    await storage.writeHandoffAudit("child", newHandoffUlid(), audit);
    await storage.deleteThreadFiles("child");
    expect(await storage.readLatest("child")).toBeNull();
  });

  it.each(["..", "../escape", "child/../../escape", "child\\..\\..\\escape", "has..dots"])(
    "refuses unsafe thread identity %s even when an audit exists at its resolved target", async (threadId) => {
      const id = await storage.writeHandoffAudit("child", newHandoffUlid(), audit);
      const markdown = await NodeFSPromises.readFile(NodePath.join(dir, "threads", "child", "handoffs", id, "handoff.md"), "utf8");
      const target = NodePath.join(dir, "threads", threadId, "handoffs", id);
      await NodeFSPromises.mkdir(target, { recursive: true });
      await NodeFSPromises.writeFile(NodePath.join(target, "handoff.md"), markdown);
      await expect(storage.readLatest(threadId)).rejects.toThrow();
    },
  );
});
