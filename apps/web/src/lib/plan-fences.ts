import { isPlanFenceOpener } from "@mcode/shared";

/** Protocol fences rendered outside the transcript, including historic stored plans. */
export const HIDDEN_PLAN_FENCE_INFO = ["plan-questions", "mcode-plan", "plan-output"];

/** Historic protocol languages hidden wherever they appear; nested blocks are never captured as plans. */
const HIDDEN_NESTED_FENCE_LANGUAGES = ["plan-questions", "plan-output"];

/** Identify a historic protocol code block by its exact language, including nested blocks. */
export function isHiddenPlanFenceLanguage(language: string): boolean {
  return HIDDEN_NESTED_FENCE_LANGUAGES.includes(language);
}

interface Fence {
  marker: string;
  length: number;
  hidden: boolean;
  plan: boolean;
  held: string[];
}

/**
 * Hide exact protocol info strings without parsing their contents. While streaming, an unfinished
 * fence stays hidden. In a finished message an unclosed `mcode-plan` fence was never captured, so
 * it stays visible rather than leaving the plan nowhere.
 */
export function stripPlanFences(content: string, isStreaming = false): string {
  let fence: Fence | null = null;
  const visible: string[] = [];
  for (const raw of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    fence = fence ? continueFence(fence, raw, visible) : startFence(raw, isStreaming, visible);
  }
  if (fence?.plan && !isStreaming) visible.push(...fence.held);
  return visible.join("");
}

function startFence(raw: string, isStreaming: boolean, visible: string[]): Fence | null {
  const fence = openingFence(raw.replace(/\r?\n$/, ""), isStreaming && !raw.endsWith("\n"));
  (fence?.hidden ? fence.held : visible).push(raw);
  return fence;
}

function continueFence(fence: Fence, raw: string, visible: string[]): Fence | null {
  (fence.hidden ? fence.held : visible).push(raw);
  return closesFence(raw.replace(/\r?\n$/, ""), fence) ? null : fence;
}

function openingFence(line: string, partial: boolean): Fence | null {
  if (partial && /^ {0,3}(`{1,2}|~{1,2})$/.test(line)) {
    return { marker: line.trim()[0], length: line.trim().length, hidden: true, plan: false, held: [] };
  }
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  const info = match[2].trim();
  const plan = isPlanFenceOpener(match[1], info);
  const hidden = plan
    || isHiddenPlanFenceLanguage(info.split(/\s+/, 1)[0])
    || partial && HIDDEN_PLAN_FENCE_INFO.some((candidate) => candidate.startsWith(info));
  return { marker: match[1][0], length: match[1].length, hidden, plan, held: [] };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1][0] === fence.marker && match[1].length >= fence.length;
}
