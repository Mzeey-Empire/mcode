/** Log-safe text for an unknown thrown value. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
