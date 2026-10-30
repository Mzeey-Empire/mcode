import "reflect-metadata";
import { CanonicalAgentStore } from "../canonical-agent-store.js";
import "../canonical-agent-writer.worker.js";

const recordRecovery = CanonicalAgentStore.prototype.recordParentNarrativeRecoveryYielding;
let pauseNextBatch = true;
let resumeRecovery: () => void = () => {};

CanonicalAgentStore.prototype.recordParentNarrativeRecoveryYielding = function(input) {
  return recordRecovery.call(this, input, async () => {
    if (!pauseNextBatch) return;
    pauseNextBatch = false;
    const resumed = new Promise<void>((resolve) => { resumeRecovery = resolve; });
    globalThis.postMessage("recovery-batch-paused");
    await resumed;
  });
};

const handleRequest = globalThis.onmessage;
globalThis.onmessage = function(message) {
  if (message.data === "resume-recovery") resumeRecovery();
  else handleRequest?.call(this, message);
};
