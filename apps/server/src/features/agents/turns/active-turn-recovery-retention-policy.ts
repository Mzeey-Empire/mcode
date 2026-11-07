/** Retention limits for one unfinished parent assistant response. */
export const PARENT_ASSISTANT_TEXT_RETAINED_LIMITS = {
  maxBytes: 256 * 1024,
  maxChunks: 16_384,
} as const;

/** Semantic retention limits shared by active-turn recovery paths. */
export const ACTIVE_TURN_RECOVERY_RETAINED_LIMITS = {
  maxBytes: PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes,
  maxRecords: PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks,
} as const;

/** Whether optional recovery data fits without limiting clean conversation history. */
export function fitsActiveTurnRecoveryRetention(recordCount: number, byteLength: number): boolean {
  return recordCount <= ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxRecords
    && byteLength <= ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxBytes;
}
