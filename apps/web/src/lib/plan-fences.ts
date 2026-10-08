/** Internal fences hidden from chat, including stored legacy plans. */
export const HIDDEN_PLAN_FENCES: ReadonlySet<string> = new Set(["plan-questions", "mcode-plan", "plan-output"]);

type Fence = { marker: string; length: number; hidden: boolean };

/** Strip internal fences by exact info string without interpreting their contents. */
export function stripPlanFences(content: string, isStreaming = false): string {
  let fence: Fence | undefined;
  const visible: string[] = [];
  for (const line of content.split(/(?<=\n)/)) {
    if (fence) {
      if (!fence.hidden) visible.push(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    // Hold an unfinished opener until its info string rules out an internal fence.
    if (isStreaming && isPendingPlanFence(line)) break;
    const opening = /^ {0,3}(`{3,}|~{3,})([^`]*?)(?:\r?\n)?$/.exec(line);
    if (opening) {
      fence = {
        marker: opening[1][0], length: opening[1].length,
        hidden: HIDDEN_PLAN_FENCES.has(opening[2].trim()),
      };
      if (fence.hidden) continue;
    }
    visible.push(line);
  }
  return visible.join("");
}

function isPendingPlanFence(line: string): boolean {
  if (line.endsWith("\n")) return false;
  if (/^ {0,3}(`{1,2}|~{1,2})$/.test(line)) return true;
  const opening = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
  return opening !== null && [...HIDDEN_PLAN_FENCES].some((name) => name.startsWith(opening[2].trim()));
}

function closesFence(line: string, fence: Fence): boolean {
  const closing = /^ {0,3}(`+|~+)[\t ]*(?:\r?\n)?$/.exec(line);
  return closing !== null && closing[1][0] === fence.marker && closing[1].length >= fence.length;
}
