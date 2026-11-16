/** A failed user-visible resilience invariant, distinct from a broken test harness. */
export class InvariantViolation extends Error {
  override readonly name = "InvariantViolation";
}

/** Assert a resilience requirement without swallowing unrelated errors. */
export function expectInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

/** Keep a reproduced stall green until the product fix requires removing its marker. */
export async function knownStall(reason: string, scenario: () => Promise<void>): Promise<void> {
  try {
    await scenario();
  } catch (error) {
    if (error instanceof InvariantViolation) return;
    throw error;
  }
  throw new Error(`Known stall is fixed: remove knownStall("${reason}")`);
}
