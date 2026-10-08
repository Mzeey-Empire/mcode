import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../attachment-service.js";

const day = 24 * 60 * 60 * 1000;
let directory: string;
let service: AttachmentService;
const threadId = "draft-test";

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-draft-test-"));
  vi.stubEnv("MCODE_DATA_DIR", directory);
  service = new AttachmentService();
});
afterEach(() => {
  vi.unstubAllEnvs();
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

function source(name = "capture.png") {
  const sourcePath = NodePath.join(directory, name);
  NodeFS.writeFileSync(sourcePath, Buffer.from([137, 80, 78, 71]));
  return { id: "source", name, mimeType: "image/png", sizeBytes: 999, sourcePath };
}
function stagedPath(id: string) {
  return NodePath.join(directory, "attachments", threadId, "draft", `${id}.png`);
}

describe("durable draft images", () => {
  it("survives source deletion and service restart; send and reference discard keep the staged file", async () => {
    const attachment = source();
    const staged = await service.stageDraft(threadId, attachment);
    expect(staged).toEqual({ stagingId: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "capture.png", mimeType: "image/png", sizeBytes: 4 });
    expect(NodeFS.existsSync(attachment.sourcePath)).toBe(true);
    NodeFS.unlinkSync(attachment.sourcePath);
    service = new AttachmentService();
    const release = service.leaseDraftImages(threadId, [staged.stagingId]);
    const result = await service.persistDraftImages(threadId, [staged.stagingId]);
    release();
    await service.removeStoredAttachments(threadId, result.stored);
    expect(NodeFS.readFileSync(stagedPath(staged.stagingId))).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(service.removeExpiredDraftImages(() => Date.now() + 29 * day)).toBe(0);
    expect(service.removeExpiredDraftImages(() => Date.now() + 31 * day)).toBe(1);
    expect(NodeFS.existsSync(stagedPath(staged.stagingId))).toBe(false);
  });

  it("removes only a source under a known Mcode temp folder", async () => {
    const temp = NodePath.join(directory, "temp", "attachments");
    NodeFS.mkdirSync(temp, { recursive: true });
    const attachment = source();
    const sourcePath = NodePath.join(temp, "capture.png");
    NodeFS.renameSync(attachment.sourcePath, sourcePath);
    const staged = await service.stageDraft(threadId, { ...attachment, sourcePath });
    expect(NodeFS.existsSync(sourcePath)).toBe(false);
    expect(NodeFS.readFileSync(stagedPath(staged.stagingId))).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("keeps newer files and overlapping leases while sweeping expired images", async () => {
    const old = await service.stageDraft(threadId, source("old.png"));
    const leased = await service.stageDraft(threadId, source("leased.png"));
    const recent = await service.stageDraft(threadId, source("recent.png"));
    const now = Date.now();
    for (const id of [old.stagingId, leased.stagingId]) NodeFS.utimesSync(stagedPath(id), new Date(now - 31 * day), new Date(now - 31 * day));
    const first = service.leaseDraftImages(threadId, [leased.stagingId]);
    const second = service.leaseDraftImages(threadId, [leased.stagingId]);
    first();
    first();
    expect(service.removeExpiredDraftImages(() => now)).toBe(1);
    expect(NodeFS.existsSync(stagedPath(old.stagingId))).toBe(false);
    expect(NodeFS.existsSync(stagedPath(leased.stagingId))).toBe(true);
    expect(NodeFS.existsSync(stagedPath(recent.stagingId))).toBe(true);
    second();
    expect(NodeFS.existsSync(stagedPath(leased.stagingId))).toBe(true);
    expect(service.removeExpiredDraftImages(() => now)).toBe(1);
  });

  it("ages a staged file from staging time, not from its source file", async () => {
    const attachment = source("old-capture.png");
    const sourceTime = new Date(Date.now() - 40 * day);
    NodeFS.utimesSync(attachment.sourcePath, sourceTime, sourceTime);
    const staged = await service.stageDraft(threadId, attachment);
    expect(service.removeExpiredDraftImages()).toBe(0);
    expect(NodeFS.existsSync(stagedPath(staged.stagingId))).toBe(true);
  });

  it("thread deletion removes draft storage", async () => {
    await service.stageDraft(threadId, source());
    service.removeForThread(threadId);
    expect(NodeFS.existsSync(NodePath.join(directory, "attachments", threadId))).toBe(false);
  });

  it("rejects traversal, unsupported MIME and oversized images", async () => {
    const attachment = source();
    await expect(service.stageDraft("../escape", attachment)).rejects.toThrow();
    await expect(service.stageDraft(threadId, { ...attachment, mimeType: "text/plain" })).rejects.toThrow();
    NodeFS.truncateSync(attachment.sourcePath, 50 * 1024 * 1024);
    await expect(service.stageDraft(threadId, attachment)).rejects.toThrow();
    expect(NodeFS.existsSync(NodePath.join(directory, "attachments"))).toBe(false);
  });
});
