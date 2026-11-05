import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  BoundedToolOutputBuffer,
  TOOL_OUTPUT_PREVIEW_BYTES,
  boundToolOutput,
  pruneStaleToolOutputArtifacts,
  resolveToolOutputArtifactPath,
  toolOutputWireBytes,
} from "@mcode/providers";

describe("bounded tool output", () => {
  let originalDataDir: string | undefined;
  let testDataDir: string;

  beforeAll(() => {
    originalDataDir = process.env.MCODE_DATA_DIR;
    testDataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-bounded-output-"));
    process.env.MCODE_DATA_DIR = testDataDir;
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.MCODE_DATA_DIR;
    } else {
      process.env.MCODE_DATA_DIR = originalDataDir;
    }
    NodeFS.rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    NodeFS.rmSync(NodePath.join(testDataDir, "artifacts", "tool-output"), {
      recursive: true,
      force: true,
    });
  });

  it("keeps small output inline without an artifact reference", () => {
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "tool-1",
      output: "hello",
    });

    expect(result).toEqual({
      output: "hello",
      outputTruncated: false,
      outputTotalBytes: 5,
    });
  });

  it("keeps head and tail preview while spooling the full output", () => {
    const fullOutput =
      "A".repeat(200 * 1024)
      + "M".repeat(16 * 1024)
      + "Z".repeat(80 * 1024);
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "tool-1",
      output: fullOutput,
    });

    expect(result.outputTruncated).toBe(true);
    expect(result.outputTotalBytes).toBe(Buffer.byteLength(fullOutput, "utf8"));
    expect(Buffer.byteLength(JSON.stringify(result.output), "utf8") - 2).toBe(TOOL_OUTPUT_PREVIEW_BYTES);
    expect(result.output.startsWith("A".repeat(1024))).toBe(true);
    expect(result.output.endsWith("Z".repeat(1024))).toBe(true);
    expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8")).toBe(fullOutput);
  });

  it("bounds JSON escapes while preserving raw full-output bytes", () => {
    const output = "\u0001".repeat(100_000);
    const result = boundToolOutput({ threadId: "thread-1", toolCallId: "controls", output });

    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.output)) - 2).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_BYTES);
    expect(result.outputTotalBytes).toBe(100_000);
    expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8")).toBe(output);
  });

  it("keeps an escaped character that exceeds the remaining head capacity", () => {
    const output = "a".repeat(96 * 1024 - 1) + "\n" + "b".repeat(32 * 1024 - 1);
    const result = boundToolOutput({ threadId: "thread-1", toolCallId: "head-boundary", output });

    expect(result.output === output).toBe(true);
    expect(result.outputTruncated).toBe(false);
  });

  it("seeds the artifact losslessly after an escaped head boundary", () => {
    const head = "a".repeat(96 * 1024 - 1);
    const tail = "\n" + "b".repeat(32 * 1024 - 1);
    const buffer = new BoundedToolOutputBuffer("thread-1", "stream-boundary");
    buffer.append(head);
    buffer.append(tail);
    buffer.append("c");
    const result = buffer.finalize();

    expect(result.outputTruncated).toBe(true);
    expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8") === head + tail + "c").toBe(true);
  });

  it("retains a lone surrogate at the tail boundary without splitting an emoji", () => {
    const head = "a".repeat(96 * 1024 - 1);
    const tail = "\ud800😀" + "b".repeat(32 * 1024 - 9);
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "surrogate-boundary",
      output: head + "\n" + tail,
    });

    expect(toolOutputWireBytes(result.output)).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_BYTES);
    expect(result.output === head + tail).toBe(true);
    expect(result.output.replace("\ud800", "").isWellFormed()).toBe(true);
  });

  it("preserves deterministic mixed outputs around the wire budget", () => {
    let seed = 2468;
    const characters = ["a", "é", "中", "\n", '"', "\\", "\u0001", "\b", "\f", "\r", "\t", "😀"];
    const fragment = Array.from({ length: 128 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return characters[seed % characters.length];
    }).join("");
    const fragmentBytes = Buffer.byteLength(JSON.stringify(fragment), "utf8") - 2;

    for (const size of [64, 96 * 1024, TOOL_OUTPUT_PREVIEW_BYTES - 1, TOOL_OUTPUT_PREVIEW_BYTES, TOOL_OUTPUT_PREVIEW_BYTES + 1, TOOL_OUTPUT_PREVIEW_BYTES + 7]) {
      const head = size > 96 * 1024 ? "a".repeat(96 * 1024 - 1) + "\n" : "";
      const remaining = size - (Buffer.byteLength(JSON.stringify(head), "utf8") - 2);
      const repeats = Math.floor(remaining / fragmentBytes);
      const output = head + fragment.repeat(repeats) + "b".repeat(remaining - repeats * fragmentBytes);
      const result = boundToolOutput({ threadId: "thread-1", toolCallId: `generated-${size}`, output });

      expect(result.outputTruncated).toBe(size > TOOL_OUTPUT_PREVIEW_BYTES);
      if (!result.outputTruncated) {
        expect(result.output === output).toBe(true);
      } else {
        expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8") === output).toBe(true);
        expect(toolOutputWireBytes(result.output)).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_BYTES);
      }
    }
  });

  it("sanitizes artifact path segments", () => {
    const path = resolveToolOutputArtifactPath("../thread", "../tool");
    const dotPath = resolveToolOutputArtifactPath("..", ".");

    expect(path).toContain(NodePath.join("artifacts", "tool-output"));
    expect(path).not.toContain("..");
    expect(dotPath).toContain(NodePath.join("artifacts", "tool-output"));
    expect(NodePath.basename(NodePath.dirname(dotPath))).toMatch(/^thread-[a-f0-9]{24}$/);
    expect(NodePath.basename(dotPath)).toMatch(/^tool-[a-f0-9]{24}\.txt$/);
  });

  it("drops forced artifacts for small untruncated output", () => {
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "tool-1",
      output: "small",
      forceArtifact: true,
    });

    expect(result).toEqual({
      output: "small",
      outputTruncated: false,
      outputTotalBytes: 5,
    });
  });

  it("retains only the tail when a single chunk exceeds the tail budget", () => {
    const buffer = new BoundedToolOutputBuffer("thread-1", "tool-1");
    const fullOutput =
      "A".repeat(200 * 1024)
      + "M".repeat(16 * 1024)
      + "Z".repeat(80 * 1024);

    buffer.append(fullOutput);
    const result = buffer.finalize();

    expect(result.outputTruncated).toBe(true);
    expect(result.output.endsWith("Z".repeat(32 * 1024))).toBe(true);
    expect(result.output.includes("M".repeat(1024))).toBe(false);
  });

  it("recreates the artifact directory before flushing queued chunks", () => {
    const buffer = new BoundedToolOutputBuffer("thread-1", "tool-1", {
      forceArtifact: true,
    });
    const artifactPath = resolveToolOutputArtifactPath("thread-1", "tool-1");
    const largeOutput = "x".repeat(300 * 1024);

    buffer.append("small");
    NodeFS.rmSync(NodePath.dirname(artifactPath), { recursive: true, force: true });
    buffer.append(largeOutput);
    const result = buffer.finalize();

    expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8")).toBe(`small${largeOutput}`);
  });

  it("prunes stale artifacts and keeps fresh artifacts", () => {
    const stale = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "old",
      output: "x".repeat(300 * 1024),
    });
    const fresh = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "new",
      output: "y".repeat(300 * 1024),
    });
    const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    NodeFS.utimesSync(stale.outputArtifactPath!, oldTime, oldTime);

    const removed = pruneStaleToolOutputArtifacts();

    expect(removed).toBe(1);
    expect(NodeFS.existsSync(stale.outputArtifactPath!)).toBe(false);
    expect(NodeFS.existsSync(fresh.outputArtifactPath!)).toBe(true);
    expect(NodeFS.statSync(fresh.outputArtifactPath!).isFile()).toBe(true);
  });
});
