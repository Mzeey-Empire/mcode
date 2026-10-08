/** Captures the first complete mcode-plan fence without interpreting its markdown. */
export class PlanFenceParser {
  private pendingLine = "";
  private fence: { marker: string; length: number; plan: boolean } | null = null;
  private lines: string[] = [];
  private markdown: string | null = null;

  /** Clone a partially received fence for staged execution state. */
  fork(): PlanFenceParser {
    const copy = new PlanFenceParser();
    copy.pendingLine = this.pendingLine;
    copy.fence = this.fence ? { ...this.fence } : null;
    copy.lines = [...this.lines];
    copy.markdown = this.markdown;
    return copy;
  }

  /** Feed text deltas; only newline-terminated closing lines are complete during streaming. */
  feed(delta: string): string | null {
    if (this.markdown !== null) return this.markdown;
    this.pendingLine += delta;
    let end = this.pendingLine.indexOf("\n");
    while (end !== -1 && this.markdown === null) {
      this.readLine(this.pendingLine.slice(0, end).replace(/\r$/, ""));
      this.pendingLine = this.pendingLine.slice(end + 1);
      end = this.pendingLine.indexOf("\n");
    }
    return this.markdown;
  }

  /** Settle the last line at an assistant-message boundary; an unclosed fence yields no plan. */
  finish(): string | null {
    if (this.markdown === null) this.readLine(this.pendingLine.replace(/\r$/, ""));
    this.pendingLine = "";
    return this.markdown;
  }

  private readLine(line: string): void {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (this.fence) {
      this.readFencedLine(line, match, this.fence);
      return;
    }
    if (!match) return;
    const marker = match[1][0];
    if (marker === "`" && match[2].includes("`")) return;
    this.fence = { marker, length: match[1].length,
      plan: marker === "`" && match[1].length >= 4 && match[2].trim() === "mcode-plan" };
  }

  private readFencedLine(line: string, match: RegExpExecArray | null, fence: { marker: string; length: number; plan: boolean }): void {
    if (closesFence(match, fence)) {
      if (fence.plan) this.markdown = this.lines.join("\n").trim() || null;
      this.fence = null;
      this.lines = [];
    } else if (fence.plan) {
      this.lines.push(line);
    }
  }
}

function closesFence(match: RegExpExecArray | null, fence: { marker: string; length: number }): boolean {
  return match !== null && match[1][0] === fence.marker
    && match[1].length >= fence.length && match[2].trim() === "";
}
