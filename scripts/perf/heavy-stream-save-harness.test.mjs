import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import { parseHeavyArguments, summarizeRows, summarizeSaves, auditLargeOutput } from "./heavy-stream-save-harness.mjs";

NodeTest.test("workload options retain defaults and reject invalid or repeated inputs", () => {
  NodeAssertStrict.deepEqual(parseHeavyArguments([]), { duration: 120, rate: 36, grow: 0 });
  NodeAssertStrict.deepEqual(parseHeavyArguments(["--duration", "600", "--grow-thread", "20000"]), { duration: 600, rate: 36, grow: 20000 });
  for (const argv of [["--rate", "0"], ["--duration"], ["--rate", "1.5"], ["--unknown", "4"], ["--rate", "2", "--rate", "3"]]) NodeAssertStrict.throws(() => parseHeavyArguments(argv));
});

NodeTest.test("large output proof requires the payload and later saved records", () => {
  const output = { envelope_json: JSON.stringify({ payload: { type: "item.recorded", output: "HEAVY_OUTPUT:" + "x".repeat(300 * 1024) } }) };
  const end = { envelope_json: '{"payload":{"type":"turn.ended"}}' };
  NodeAssertStrict.deepEqual(auditLargeOutput([output, end]), { bytes: 307200, saved: true, savedAfter: true });
  NodeAssertStrict.deepEqual(auditLargeOutput([end, output]), { bytes: 307200, saved: true, savedAfter: false });
  NodeAssertStrict.deepEqual(auditLargeOutput([end]), { bytes: 307200, saved: false, savedAfter: false });
  NodeAssertStrict.deepEqual(auditLargeOutput([output, { envelope_json: '{"payload":{"type":"publication.recorded"}}' }]), { bytes: 307200, saved: true, savedAfter: true });
});

NodeTest.test("row breakdown separates raw projections and divides by emitted deltas", () => {
  const rows = [
    { envelope_json: '{"payload":{"type":"item.recorded","item":{"payload":{"projection":"providerRuntimeEvent"}}}}' },
    { envelope_json: '{"payload":{"type":"item.recorded","item":{"payload":{"projection":"assistant"}}}}' },
    { envelope_json: '{"payload":{"type":"publication.recorded"}}' },
    { envelope_json: '{"payload":{"type":"turn.ended"}}' },
  ];
  NodeAssertStrict.deepEqual(summarizeRows(rows, 2), { total: 4, types: { "item.recorded": 2, "publication.recorded": 1, "turn.ended": 1 }, itemProjections: { providerRuntimeEvent: 1, assistant: 1 }, rowsPerStreamedDelta: 2 });
  NodeAssertStrict.deepEqual(summarizeRows([], 0), { total: 0, types: {}, itemProjections: {}, rowsPerStreamedDelta: null });
  NodeAssertStrict.throws(() => summarizeRows([{ envelope_json: "broken" }], 1));
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
