/** Protocol fences rendered outside the transcript, including historic stored plans. */
export const HIDDEN_PLAN_FENCE_INFO = ["plan-questions", "mcode-plan", "plan-output"];

interface Fence {
  marker: string;
  length: number;
  hidden: boolean;
}

/** Hide exact protocol info strings without parsing their contents, including unfinished fences. */
export function stripPlanFences(content: string, isStreaming = false): string {
  let fence: Fence | null = null;
  const visible: string[] = [];
  for (const raw of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = raw.replace(/\r?\n$/, "");
    if (fence) {
      if (!fence.hidden) visible.push(raw);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const partial = isStreaming && !raw.endsWith("\n");
    fence = openingFence(line, partial);
    if (fence?.hidden) continue;
    visible.push(raw);
  }
  return visible.join("");
}

function openingFence(line: string, partial: boolean): Fence | null {
  if (partial && /^ {0,3}`{1,2}$/.test(line)) return { marker: "`", length: line.trim().length, hidden: true };
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  const info = match[2].trim();
  const hidden = HIDDEN_PLAN_FENCE_INFO.includes(info)
    || partial && HIDDEN_PLAN_FENCE_INFO.some((candidate) => candidate.startsWith(info));
  return { marker: match[1][0], length: match[1].length, hidden };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1][0] === fence.marker && match[1].length >= fence.length;
}
