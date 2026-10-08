/** Read the plan field observed in Cursor's native create_plan request. */
export function extractCursorCreatePlanMarkdown(params: Record<string, unknown>): string | null {
  return typeof params.plan === "string" && params.plan.trim() ? params.plan.trim() : null;
}
