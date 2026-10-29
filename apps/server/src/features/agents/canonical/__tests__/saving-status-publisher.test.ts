import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnSavingStatus } from "@mcode/contracts/models/turn-runtime";
import { SavingStatusPublisher } from "../saving-status-publisher.js";

const saving = { threadId: "owner", executionId: "00000000-0000-4000-8000-000000000123", mode: "saving",
  accepted: { epoch: "epoch", sequence: 1 }, saved: { epoch: "epoch", sequence: 0 },
  pendingEvents: 1, pendingBytes: 100, oldestPendingAt: "2026-10-29T10:00:00.000Z" } satisfies TurnSavingStatus;
const durable = { threadId: saving.threadId, executionId: saving.executionId, mode: "durable" } satisfies TurnSavingStatus;
const failed = { ...saving, mode: "saving-failed",
  failure: { kind: "permanent", name: "Error", message: "Disk full" } } satisfies TurnSavingStatus;

describe("SavingStatusPublisher", () => {
  let published: TurnSavingStatus[];
  let publisher: SavingStatusPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    publisher = new SavingStatusPublisher((status) => published.push(status), {
      schedule(callback, delayMs) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    });
  });
  afterEach(() => { publisher.close(); vi.useRealTimers(); });

  it("publishes the latest saving/durable flip once per 250 ms window", () => {
    for (let index = 0; index < 20; index += 1) {
      publisher.publish(saving, []);
      publisher.publish(durable, []);
      vi.advanceTimersByTime(10);
    }
    expect(published).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(published).toEqual([{ threadId: "owner", executionId: saving.executionId, mode: "durable" }]);
    publisher.publish(saving, []);
    vi.advanceTimersByTime(100);
    publisher.publish({ ...saving, accepted: { epoch: "epoch", sequence: 42 }, pendingEvents: 42 }, []);
    vi.advanceTimersByTime(149);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ mode: "saving", accepted: { sequence: 42 }, pendingEvents: 42 });
  });

  it("cancels a pending durable for owner and family on failure and sends recovery immediately", () => {
    publisher.publish(durable, ["child"]);
    vi.advanceTimersByTime(249);
    publisher.publish(failed, ["child"]);
    expect(published.map(({ threadId, mode }) => ({ threadId, mode }))).toEqual([
      { threadId: "owner", mode: "saving-failed" }, { threadId: "child", mode: "saving-failed" },
    ]);
    vi.advanceTimersByTime(1_000);
    expect(published).toHaveLength(2);
    publisher.publish(durable, ["child"]);
    expect(published.map(({ threadId, mode }) => ({ threadId, mode }))).toEqual([
      { threadId: "owner", mode: "saving-failed" }, { threadId: "child", mode: "saving-failed" },
      { threadId: "owner", mode: "durable" }, { threadId: "child", mode: "durable" },
    ]);
  });

  it.each([
    { kind: "transient", name: "Error", message: "Disk full" },
    { kind: "permanent", name: "StorageError", message: "Disk full" },
    { kind: "permanent", name: "Error", message: "Permission denied" },
  ] satisfies Extract<TurnSavingStatus, { mode: "saving-failed" }>["failure"][])("immediately publishes a changed failure $kind/$name/$message", (failure) => {
    publisher.publish(failed, []);
    publisher.publish({ ...failed, accepted: { epoch: "epoch", sequence: 2 } }, []);
    expect(published).toHaveLength(1);
    publisher.publish({ ...failed, failure }, []);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ mode: "saving-failed", failure });
    vi.advanceTimersByTime(250);
    expect(published).toHaveLength(2);
  });

  it("treats retry mode changes as edges and coalesces unchanged failure positions", () => {
    publisher.publish(failed, []);
    publisher.publish({ ...failed, mode: "save-retrying" }, []);
    expect(published.map(({ mode }) => mode)).toEqual(["saving-failed", "save-retrying"]);
    publisher.publish({ ...failed, mode: "save-retrying", pendingEvents: 7 }, []);
    vi.advanceTimersByTime(250);
    expect(published).toHaveLength(3);
    expect(published[2]).toMatchObject({ mode: "save-retrying", pendingEvents: 7 });
    publisher.publish(saving, []);
    expect(published.map(({ mode }) => mode)).toEqual(["saving-failed", "save-retrying", "save-retrying", "saving"]);
  });

  it("keeps independent execution windows and captures the latest family targets", () => {
    const targets = ["old-child"];
    publisher.publish(saving, targets);
    targets.push("unrelated");
    vi.advanceTimersByTime(100);
    publisher.publish({ ...durable, executionId: "00000000-0000-4000-8000-000000000124" }, []);
    publisher.publish(durable, ["latest-child"]);
    vi.advanceTimersByTime(150);
    expect(published.map(({ threadId, mode }) => ({ threadId, mode }))).toEqual([
      { threadId: "owner", mode: "durable" }, { threadId: "latest-child", mode: "durable" },
    ]);
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(3);
    expect(published[2]).toEqual({ threadId: "owner", executionId: "00000000-0000-4000-8000-000000000124", mode: "durable" });
  });
});
