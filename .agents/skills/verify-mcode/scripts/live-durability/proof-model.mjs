/** Pure evidence checks for the accepted/saved/recovery contract. No runtime or filesystem actions. */
import * as NodeCrypto from 'node:crypto';

const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

/** Compares immutable semantic content independently of its eventual save revision/timestamp. */
export function semanticDescriptor(event) {
  if (typeof event?.eventId !== 'string' || !event.routing || !Number.isSafeInteger(event.acceptedSequence)) throw new Error('Invalid canonical event evidence');
  const identity = { eventId: event.eventId, routing: event.routing, sourceProviderId: event.sourceProviderId,
    sourceIdentities: event.sourceIdentities, sourceSequence: event.sourceSequence, acceptedSequence: event.acceptedSequence,
    progressPosition: event.progressPosition, providerTimestamp: event.providerTimestamp,
    acceptedAt: event.serverTimestamps?.acceptedAt, payload: event.payload };
  return { eventId: event.eventId, executionId: event.routing.executionId, acceptedSequence: event.acceptedSequence,
    progressPosition: event.progressPosition ?? null,
    semanticHash: NodeCrypto.createHash('sha256').update(JSON.stringify(stable(identity))).digest('hex') };
}

/** Rejects old envelopes explicitly rather than inferring progress from the retired protocol. */
export function canonicalFrames(pushes, threadId) {
  return pushes.filter((message) => message.channel === 'agent.canonical').map((message) => {
    const frame = message.data;
    if (!['accepted', 'saved', 'recovery'].includes(frame?.phase) || typeof frame.epoch !== 'string') throw new Error('Expected accepted/saved/recovery frames; rebuild the runtime before AFTER proof');
    return frame;
  }).filter((frame) => frame.threadId === threadId);
}

/** Retains positions and identities without persisting provider payloads or credentials. */
export function frameSummary(frame) {
  return { phase: frame.phase, threadId: frame.threadId, epoch: frame.epoch,
    ...(frame.phase === 'accepted' ? { from: frame.from, through: frame.through } : {}),
    ...(frame.phase === 'saved' ? { through: frame.through, revision: frame.revision } : {}),
    ...(frame.phase === 'recovery' ? { acceptedThrough: frame.acceptedThrough, savedThrough: frame.savedThrough,
      loss: frame.loss, durableRevision: frame.durable.mode === 'snapshot' ? frame.durable.snapshot.revision : frame.durable.through } : {}),
    events: (frame.phase === 'recovery' ? frame.retained : frame.events).map(semanticDescriptor) };
}

/** Save receipts may repeat; an event identity can never change content or appear twice on disk. */
export function compareEventIdentities(expected, stored) {
  const expectedById = new Map();
  for (const event of expected) {
    const previous = expectedById.get(event.eventId);
    if (previous && previous.semanticHash !== event.semanticHash) throw new Error('Accepted evidence changed an immutable identity');
    expectedById.set(event.eventId, event);
  }
  const storedById = new Map(stored.map((event) => [event.eventId, event]));
  const missing = [...expectedById.keys()].filter((id) => !storedById.has(id));
  const unexpected = [...storedById.keys()].filter((id) => !expectedById.has(id));
  const changed = [...expectedById].filter(([id, event]) => storedById.has(id) && event.semanticHash !== storedById.get(id).semanticHash).map(([id]) => id);
  return { expectedCount: expectedById.size, storedCount: stored.length, missing, unexpected, changed,
    duplicateStoredIds: stored.length - storedById.size,
    exact: missing.length === 0 && unexpected.length === 0 && changed.length === 0 && stored.length === storedById.size };
}
