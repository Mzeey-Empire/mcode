import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { auditDelivery, savedTerminal, finalizeOutcome } from "./heavy-stream-save-harness.mjs";
import * as Harness from "./heavy-stream-save-harness.mjs";

NodeTest.test("outcome gate rejects each independent failure", async (test) => {
  const cases = [
    ["clean", () => {}, "completed"],
    ["no terminal", (r) => { r.terminalEvent = null; }],
    ["lost pieces", (r) => { r.delivery.pieces.lost = 1; }],
    ["lost tools", (r) => { r.delivery.tools.lost = 1; }],
    ["missing output", (r) => { r.largeOutput.saved = false; }],
    ...["queueCapacity", "acceptanceRejected", "deliveryFailed", "other"].map((reason) => [reason, (r) => { r.serverDropLogLines[reason] = 1; }]),
    ["unmatched lag join", (r) => { r.delivery.savedPieces[0].position.epoch = "other"; }],
    ["unmatched acceptance", (r) => { r.saves.unmatchedAcceptedEvents = 1; }],
    ["incomplete fixture", (r) => { r.emitted.complete = false; }],
    ["error", (r) => { r.error = "save failed"; }],
    ["interrupted", () => {}],
  ];
  for (const [name, change, expected = "failed"] of cases) await test.test(name, () => {
    const receipt = { outcome: "completed", emitted: { complete: true }, terminalEvent: "turn.completed", largeOutput: { saved: true },
      serverDropLogLines: { queueCapacity: 0, acceptanceRejected: 0, deliveryFailed: 0, other: 0 },
      delivery: { pieces: { lost: 0 }, tools: { lost: 0 }, savedPieces: [{ at: 100, position: { epoch: "a", sequence: 1 } }] },
      saves: { unmatchedAcceptedEvents: 0, savedTimes: [{ at: 120, through: { epoch: "a", sequence: 1 } }] } };
    change(receipt);
    finalizeOutcome(receipt, name === "interrupted");
    NodeAssertStrict.equal(receipt.outcome, expected);
  });
});

NodeTest.test("drop log lines count every reason only for the measured thread after the offset", async () => {
  NodeFS.mkdirSync(NodePath.join(process.cwd(), ".codex/tmp"), { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(process.cwd(), ".codex/tmp/drop-lines-"));
  const file = NodePath.join(directory, "server.log");
  const line = (threadId, reason) => `warn: Codex observation dropped; execution continues ${JSON.stringify({ threadId, reason })}\n`;
  const before = line("mine", "queue-capacity");
  try {
    NodeFS.writeFileSync(file, before + line("mine", "queue-capacity").repeat(2) + line("mine", "acceptance-rejected") + line("mine", "delivery-failed") + line("mine", "future-reason") + line("other", "queue-capacity") + line("mine-extra", "acceptance-rejected") + 'info: unrelated {"threadId":"mine","reason":"delivery-failed"}\n');
    NodeAssertStrict.deepEqual(await Harness.countDropLines(file, Buffer.byteLength(before), "mine"), { queueCapacity: 2, acceptanceRejected: 1, deliveryFailed: 1, other: 1 });
    NodeAssertStrict.deepEqual(await Harness.countDropLines(file, 0, "absent"), { queueCapacity: 0, acceptanceRejected: 0, deliveryFailed: 0, other: 0 });
  } finally { NodeFS.rmSync(directory, { recursive: true }); }
});

NodeTest.test("send-to-save lag uses the matching epoch and a missing match fails the run", () => {
  const receipt = { outcome: "completed", emitted: { complete: true }, terminalEvent: "turn.completed", largeOutput: { saved: true }, delivery: { pieces: { lost: 0 }, tools: { lost: 0 }, savedPieces: [{ at: 100, position: { epoch: "a", sequence: 1 } }] }, saves: { unmatchedAcceptedEvents: 0, savedTimes: [{ at: 120, through: { epoch: "b", sequence: 2 } }, { at: 150, through: { epoch: "a", sequence: 1 } }] } };
  finalizeOutcome(receipt, false);
  NodeAssertStrict.deepEqual(receipt.endToEndLag, { count: 1, p50Ms: 50, p95Ms: 50, maxMs: 50, unmatchedSavedPieces: 0 });
  NodeAssertStrict.equal(receipt.outcome, "completed");
  receipt.delivery.savedPieces = [{ at: 100, position: { epoch: "missing", sequence: 1 } }];
  finalizeOutcome(receipt, false);
  NodeAssertStrict.equal(receipt.outcome, "failed");
  NodeAssertStrict.equal(receipt.endToEndLag.unmatchedSavedPieces, 1);
});

NodeTest.test("delivery counts unique saved pieces and completed tools against sends", () => {
  const rows = [{ envelope_json: JSON.stringify({ payload: { text: "piece 0\npiece 0\n", toolCallId: "t", output: "done" } }) }];
  const result = auditDelivery(rows, { pieces: [{ index: 0, at: 10 }, { index: 1, at: 20 }], tools: ["t", "missing"] });
  NodeAssertStrict.deepEqual(result.pieces, { sent: 2, saved: 1, lost: 1 });
  NodeAssertStrict.deepEqual(result.tools, { sent: 2, saved: 1, lost: 1 });
});

NodeTest.test("terminal is found before final publication and scoped to the turn", () => {
  const rows = ["turn.completed", "publication.recorded"].map((type) => ({ envelope_json: JSON.stringify({ turnId: "mine", payload: { type } }) }));
  NodeAssertStrict.equal(savedTerminal(rows, "mine"), "turn.completed");
  NodeAssertStrict.equal(savedTerminal(rows, "other"), null);
  NodeAssertStrict.equal(savedTerminal([{ envelope_json: '{"payload":{"type":"turn.completed"}}' }], undefined), null);
});

NodeTest.test("DB save lag uses first durable piece timestamps and excludes lost pieces", () => {
  const row = (text, persisted_at) => ({ persisted_at, envelope_json: JSON.stringify({ payload: { text } }) });
  const delivery = auditDelivery([row("piece 0\npiece 1\n", "1970-01-01T00:00:00.150Z"), row("piece 0\n", "1970-01-01T00:00:00.900Z")],
    { pieces: [{ index: 0, at: 100 }, { index: 1, at: 120 }, { index: 2, at: 125 }], tools: [] });
  const receipt = { delivery, saves: {}, emitted: { complete: true } };
  finalizeOutcome(receipt, false);
  NodeAssertStrict.deepEqual(receipt.persistedAtLag, { count: 2, p50Ms: 30, p95Ms: 50, maxMs: 50, unmatchedSavedPieces: 0 });
  NodeAssertStrict.equal(receipt.lagExcludesLostPieces, true);
  NodeAssertStrict.equal(receipt.delivery.pieces.lost, 1);
});

NodeTest.test("first signal permits restoration and second SIGINT or SIGTERM forces exit", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const script = `import { createInterruptHandler } from ${JSON.stringify(new URL("./heavy-stream-save-harness.mjs", import.meta.url).href)};
      const state = {};
      const handler = createInterruptHandler(state);
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      process.emit("SIGINT");
      if (state.interrupted) process.stdout.write("restoration reachable\\n");
      process.emit(${JSON.stringify(signal)});
      process.stdout.write("still running\\n");`;
    const child = NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true });
    NodeAssertStrict.equal(child.status, 130, child.stderr);
    NodeAssertStrict.equal(child.stdout, "restoration reachable\n");
  }
});

NodeTest.test("epochs cannot save one another's accepted sequences", () => {
  const result = summarizeSaves([{ t: 10, d: { phase: "accepted", from: { epoch: "a", sequence: 0 }, through: { epoch: "a", sequence: 1 } } }, { t: 20, d: { phase: "saved", through: { epoch: "b", sequence: 1 }, events: 1 } }]);
  NodeAssertStrict.equal(result.unmatchedAcceptedEvents, 1);
});
import { parseHeavyArguments, summarizeRows, summarizeSaves, auditLargeOutput, streamedDeltaCount, isMeasurementRecord, restoreFixture } from "./heavy-stream-save-harness.mjs";
import { isToolIndex } from "../../.agents/skills/verify-mcode/scripts/heavy-stream-provider-fixture.mjs";

NodeTest.test("CLI restoration succeeds when stopping a blocked execution fails", async () => {
  let configuredCli = "fixture.cmd";
  const socket = { async rpc(method, params) {
    if (method === "agent.stop") throw new Error("stop unavailable");
    if (method === "settings.update") configuredCli = params.provider.cli.codex;
  } };
  const receipt = { threadId: "fixture-thread", cleanup: {} };
  await restoreFixture(socket, receipt, {}, true, "original.cmd");
  NodeAssertStrict.equal(configuredCli, "original.cmd");
  NodeAssertStrict.equal(receipt.cleanup.settingsRestored, true);
  NodeAssertStrict.equal(typeof receipt.cleanup.stopError, "string");
});

NodeTest.test("tool scheduling includes an unaligned midpoint without duplicating aligned tools", () => {
  NodeAssertStrict.deepEqual(Array.from({ length: 18 }, (_, index) => index).filter((index) => isToolIndex(index, 18, 2)), [0, 9, 10]);
  NodeAssertStrict.deepEqual(Array.from({ length: 20 }, (_, index) => index).filter((index) => isToolIndex(index, 20, 2)), [0, 10]);
});

NodeTest.test("delta totals exclude tool output and lifecycle notifications", () => {
  NodeAssertStrict.equal(streamedDeltaCount({ counts: { "item/agentMessage/delta": 7, "item/reasoning/summaryTextDelta": 3, "item/commandExecution/outputDelta": 100, "item/started": 2 } }), 10);
  NodeAssertStrict.equal(streamedDeltaCount({ counts: { "item/agentMessage/delta": 4 } }), 4);
  NodeAssertStrict.equal(streamedDeltaCount(null), 0);
});

NodeTest.test("record selection excludes other threads and unrelated channels", () => {
  NodeAssertStrict.equal(isMeasurementRecord({ th: "mine", ch: "push.canonical" }, "mine"), true);
  NodeAssertStrict.equal(isMeasurementRecord({ th: "mine", ch: "progress.save-failed" }, "mine"), true);
  NodeAssertStrict.equal(isMeasurementRecord({ ch: "app.stall" }, "mine"), true);
  NodeAssertStrict.equal(isMeasurementRecord({ th: "other", ch: "push.canonical" }, "mine"), false);
  NodeAssertStrict.equal(isMeasurementRecord({ th: "mine", ch: "rpc.request" }, "mine"), false);
});

NodeTest.test("workload options retain defaults and reject invalid or repeated inputs", () => {
  NodeAssertStrict.deepEqual(parseHeavyArguments([]), { duration: 120, rate: 36, grow: 0 });
  NodeAssertStrict.deepEqual(parseHeavyArguments(["--duration", "600", "--grow-thread", "20000"]), { duration: 600, rate: 36, grow: 20000 });
  for (const argv of [["--rate", "0"], ["--duration"], ["--rate", "1.5"], ["--unknown", "4"], ["--rate", "2", "--rate", "3"]]) NodeAssertStrict.throws(() => parseHeavyArguments(argv));
});

NodeTest.test("large output proof requires the payload and later saved records", () => {
  const output = { envelope_json: JSON.stringify({ payload: { type: "item.recorded", output: "HEAVY_OUTPUT:" + "x".repeat(300 * 1024 - 13) + "\n" } }) };
  const end = { envelope_json: '{"payload":{"type":"turn.completed"}}' };
  NodeAssertStrict.deepEqual(auditLargeOutput([output, end]), { bytes: 307200, saved: true, savedAfter: true });
  NodeAssertStrict.deepEqual(auditLargeOutput([end, output]), { bytes: 307200, saved: true, savedAfter: false });
  NodeAssertStrict.deepEqual(auditLargeOutput([end]), { bytes: 307200, saved: false, savedAfter: false });
  NodeAssertStrict.deepEqual(auditLargeOutput([output, { envelope_json: '{"payload":{"type":"publication.recorded"}}' }]), { bytes: 307200, saved: true, savedAfter: true });
});

NodeTest.test("row breakdown separates raw projections and divides by saved pieces", () => {
  const rows = [
    { durable_revision: 1, envelope_json: '{"payload":{"type":"item.recorded","item":{"payload":{"projection":"providerRuntimeEvent"}}}}' },
    { durable_revision: 1, envelope_json: '{"payload":{"type":"item.recorded","item":{"payload":{"projection":"assistant"}}}}' },
    { durable_revision: 2, envelope_json: '{"payload":{"type":"item.content-appended"}}' },
    { durable_revision: 3, envelope_json: '{"payload":{"type":"publication.recorded"}}' },
    { durable_revision: 3, envelope_json: '{"payload":{"type":"turn.completed"}}' },
  ];
  NodeAssertStrict.deepEqual(summarizeRows(rows, 2, 4), { total: 5,
    types: { "item.recorded": 2, "item.content-appended": 1, "publication.recorded": 1, "turn.completed": 1 },
    itemProjections: { providerRuntimeEvent: 1, assistant: 1 }, itemRows: 4, contentAppends: 1, writerReceipts: 3,
    rowsPerSavedDelta: 2.5, perSavedDelta: { itemRows: 2, contentAppends: 0.5, writerReceipts: 1.5 } });
  NodeAssertStrict.deepEqual(summarizeRows([], 0), { total: 0, types: {}, itemProjections: {}, itemRows: 0, contentAppends: 0,
    writerReceipts: 0, rowsPerSavedDelta: null, perSavedDelta: { itemRows: null, contentAppends: null, writerReceipts: null } });
  NodeAssertStrict.throws(() => summarizeRows([{ envelope_json: "broken" }], 1));
});

NodeTest.test("truncated output needs an intact artifact, not just its path", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "heavy-proof-"));
  const file = NodePath.join(directory, "output.txt");
  const row = { envelope_json: JSON.stringify({ payload: { output: "HEAVY_OUTPUT:preview", outputTruncated: true, outputArtifactPath: file } }) };
  try {
    NodeAssertStrict.equal(auditLargeOutput([row]).saved, false);
    NodeFS.writeFileSync(file, "HEAVY_OUTPUT:" + "x".repeat(300 * 1024 - 13) + "\n");
    NodeAssertStrict.equal(auditLargeOutput([row]).saved, true);
    NodeFS.writeFileSync(file, "damaged");
    NodeAssertStrict.equal(auditLargeOutput([row]).saved, false);
  } finally { NodeFS.rmSync(directory, { recursive: true }); }
});

NodeTest.test("save watermarks assign each accepted event its first save and expose unsaved events", () => {
  const records = [
    { t: 100, d: { phase: "accepted", from: 0, through: 2 } },
    { t: 110, d: { phase: "accepted", from: 2, through: 4 } },
    { t: 120, d: { phase: "saved", through: 1, events: 1 } },
    { t: 140, d: { phase: "saved", through: 3, events: 2 } },
  ];
  const result = summarizeSaves(records.reverse());
  NodeAssertStrict.equal(result.commits, 2);
  NodeAssertStrict.deepEqual(result.eventsPerCommit, [1, 2]);
  NodeAssertStrict.equal(result.acceptedEvents, 4);
  NodeAssertStrict.equal(result.unmatchedAcceptedEvents, 1);
  NodeAssertStrict.deepEqual(result.lag, { count: 3, p50Ms: 30, p95Ms: 40, maxMs: 40 });
  NodeAssertStrict.deepEqual(summarizeSaves([]).lag, { count: 0, p50Ms: null, p95Ms: null, maxMs: null });
});
