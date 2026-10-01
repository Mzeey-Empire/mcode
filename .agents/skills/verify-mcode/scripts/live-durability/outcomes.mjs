/** Keeps provider completion, cancellation, and save failure as separate proof conditions. */
export function requireSaveOutcome({ expectedOutcome, snapshot, terminal, cancelled }) {
  if (!['completed', 'interrupted'].includes(expectedOutcome)) throw new Error('Choose completed or interrupted save-retry proof');
  if (!terminal || terminal.expired || snapshot?.phase !== expectedOutcome) throw new Error('Public terminal outcome differs from the requested save-retry journey');
  if (expectedOutcome === 'completed' && cancelled) throw new Error('Cancelled native invocation cannot prove successful completion');
  if (expectedOutcome === 'interrupted' && !cancelled) throw new Error('Interrupted proof requires fresh native cancellation evidence');
}

/** Requires the actual selected Composer and public runtime to stay active beyond the send RPC timeout. */
export function requireHealthyPrefix({ snapshot, executionId, prefixRendered, stopButtonCount, terminal }) {
  if (snapshot?.phase !== 'running' || snapshot.turnExecutionId !== executionId) throw new Error('Public execution changed during the healthy prefix gate');
  if (!prefixRendered || stopButtonCount !== 1 || terminal) throw new Error('Renderer/native state did not remain active during the healthy prefix gate');
}
