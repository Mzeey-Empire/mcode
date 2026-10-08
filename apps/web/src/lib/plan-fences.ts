/** Internal fences hidden from chat, including stored legacy plans. */
export const HIDDEN_PLAN_FENCES: ReadonlySet<string> = new Set(["plan-questions", "mcode-plan", "plan-output"]);

/** Strip internal fences by exact info string without interpreting their contents. */
export function stripPlanFences(content: string): string {
  let fence: { marker: string; length: number; hidden: boolean } | undefined;
  const visible: string[] = [];
  for (const line of content.split(/(?<=\n)/)) {
    if (fence) {
      if (!fence.hidden) visible.push(line);
      const closing = /^ {0,3}(`+|~+)[\t ]*(?:\r?\n)?$/.exec(line);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})([^`]*?)(?:\r?\n)?$/.exec(line);
    if (opening) fence = {
      marker: opening[1][0], length: opening[1].length,
      hidden: HIDDEN_PLAN_FENCES.has(opening[2].trim()),
    };
    if (!fence?.hidden) visible.push(line);
  }
  return visible.join("");
}
