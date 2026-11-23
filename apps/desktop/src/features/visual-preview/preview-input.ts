import type { WebContentsConsoleMessageEventParams } from "electron";
import {
  VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES,
  VISUAL_PREVIEW_MAX_CONSOLE_TEXT,
  visualPreviewConsolePriority,
  VisualPreviewRequestSchema,
  type VisualPreviewConsoleEntry,
  type VisualPreviewRequest,
} from "@mcode/contracts/ws/visual-preview";

/** Validate an untrusted request arriving over Electron IPC. */
export function parseVisualPreviewRequest(input: unknown): VisualPreviewRequest {
  return VisualPreviewRequestSchema().parse(input);
}

/** Normalize an Electron diagnostic for transport to the server. */
export function visualPreviewConsoleEntry(
  level: WebContentsConsoleMessageEventParams["level"], message: string, lineNumber: number,
): VisualPreviewConsoleEntry {
  return {
    level: level === "debug" ? "log" : level,
    text: message.slice(0, VISUAL_PREVIEW_MAX_CONSOLE_TEXT),
    ...(Number.isInteger(lineNumber) && lineNumber > 0 ? { line: lineNumber } : {}),
  };
}

/** Keeps diagnostics in page order and retains higher-priority entries at capacity. */
export class VisualPreviewConsole {
  readonly entries: VisualPreviewConsoleEntry[] = [];
  dropped = 0;

  /** Records a diagnostic and accounts for any entry discarded at the limit. */
  add(entry: VisualPreviewConsoleEntry): void {
    if (this.entries.length === VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES) {
      this.dropped++;
      const priority = visualPreviewConsolePriority(entry);
      const oldestLowerPriority = this.entries.findIndex((previous) => visualPreviewConsolePriority(previous) < priority);
      if (oldestLowerPriority === -1) return;
      this.entries.splice(oldestLowerPriority, 1);
    }
    this.entries.push(entry);
  }
}
