/** A failed user-visible resilience invariant, distinct from a broken test harness. */
export class InvariantViolation extends Error {
  override readonly name = "InvariantViolation";
}

/** Assert a resilience requirement without swallowing unrelated errors. */
export function expectInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

/**
 * Keep a reproduced stall green until the product fix requires removing its marker. The stall passes only when it
 * fails with its own signature, so a different failure, or a different invariant, is never mistaken for it.
 */
export async function knownStall(reason: string, expected: RegExp, scenario: () => Promise<void>): Promise<void> {
  try {
    await scenario();
  } catch (error) {
    if (error instanceof InvariantViolation && expected.test(error.message)) return;
    throw error;
  }
  throw new Error(`Known stall is fixed: remove knownStall("${reason}")`);
}
