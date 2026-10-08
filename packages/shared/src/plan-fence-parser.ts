/** Incrementally captures the first complete Markdown plan fence in assistant text. */
export class PlanFenceParser {
  private pending = "";
  private fence: { marker: string; length: number; plan: boolean } | undefined;
  private markdown = "";
  private captured = false;

  /** Copy parser state without consuming the accepted execution's stream. */
  fork(): PlanFenceParser {
    const copy = new PlanFenceParser();
    copy.pending = this.pending;
    copy.fence = this.fence && { ...this.fence };
    copy.markdown = this.markdown;
    copy.captured = this.captured;
    return copy;
  }

  /** Consume complete lines; an unterminated closing line waits for finish(). */
  feed(delta: string): string | null {
    if (this.captured) return null;
    this.pending += delta;
    let start = 0;
    let end = this.pending.indexOf("\n", start);
    while (end !== -1) {
      const result = this.line(this.pending.slice(start, end + 1));
      start = end + 1;
      if (result !== null) {
        this.pending = "";
        return result;
      }
      end = this.pending.indexOf("\n", start);
    }
    this.pending = this.pending.slice(start);
    return null;
  }

  /** Finish an assistant message, including a closing fence without a final newline. */
  finish(): string | null {
    if (this.captured) return null;
    const result = this.line(this.pending ? this.pending + "\n" : "");
    this.pending = "";
    return result;
  }

  private capture(): string | null {
    const markdown = this.markdown.replace(/\r?\n$/, "");
    this.markdown = "";
    if (!markdown.trim()) return null;
    this.captured = true;
    return markdown;
  }

  private line(raw: string): string | null {
    const line = raw.replace(/\r?\n$/, "");
    if (!this.fence) {
      const opening = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
      if (opening) this.fence = {
        marker: opening[1][0], length: opening[1].length,
        plan: opening[1][0] === "`" && opening[2].trim() === "mcode-plan",
      };
      return null;
    }
    const closing = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
    if (closing && closing[1][0] === this.fence.marker && closing[1].length >= this.fence.length) {
      const plan = this.fence.plan;
      this.fence = undefined;
      if (!plan) return null;
      return this.capture();
    }
    if (this.fence.plan) this.markdown += raw;
    return null;
  }
}
