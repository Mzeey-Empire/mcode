/**
 * An acknowledgement past the newest settled visible sequence, mapped to a structured RPC failure by the router.
 * Kept free of DI imports so the router can load it without the reflect polyfill.
 */
export class SequenceAheadError extends Error {
  readonly code = "sequence_ahead";
  constructor() {
    super("Acknowledged sequence is ahead of settled history");
  }
}
