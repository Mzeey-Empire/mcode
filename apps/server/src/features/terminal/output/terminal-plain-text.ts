type EscapeState = "text" | "escape" | "intermediate" | "csi" | "string" | "string-escape";

/** Decodes command bytes into completed lines and the current overwritten line. */
export class TerminalPlainTextDecoder {
  private readonly decoder = new TextDecoder();
  private state: EscapeState = "text";
  private line: string[] = [];
  private cursor = 0;
  private bellTerminatesString = false;

  write(bytes: Uint8Array): { completedLines: string[]; currentLine: string } {
    const completedLines: string[] = [];
    for (const character of this.decoder.decode(bytes, { stream: true })) {
      this.consume(character, completedLines);
    }
    return { completedLines, currentLine: this.line.join("") };
  }

  private consume(character: string, completedLines: string[]): void {
    if (this.state !== "text") {
      this.consumeEscape(character);
      return;
    }
    if (character === "\x1b") this.state = "escape";
    else if (character === "\x9b") this.state = "csi";
    else if (/[\x90\x98\x9d-\x9f]/u.test(character)) {
      this.state = "string";
      this.bellTerminatesString = character === "\x9d";
    } else if (character === "\r") this.cursor = 0;
    else if (character === "\n") {
      completedLines.push(this.line.join(""));
      this.line = [];
      this.cursor = 0;
    } else if (character === "\t" || !/[\x00-\x1f\x7f-\x9f]/u.test(character)) {
      this.line[this.cursor++] = character;
    }
  }

  private consumeEscape(character: string): void {
    if (this.state === "string" || this.state === "string-escape") {
      this.consumeControlString(character);
      return;
    }
    if (this.state === "escape") {
      this.bellTerminatesString = character === "]";
      this.state = escapeStart(character);
      return;
    }
    const finalByte = this.state === "csi" ? /[\x40-\x7e]/u : /[\x30-\x7e]/u;
    if (finalByte.test(character)) this.state = "text";
  }

  private consumeControlString(character: string): void {
    if ((character === "\x07" && this.bellTerminatesString) || character === "\x9c" || (this.state === "string-escape" && character === "\\")) {
      this.state = "text";
    } else this.state = character === "\x1b" ? "string-escape" : "string";
  }
}

function escapeStart(character: string): EscapeState {
  if (character === "[") return "csi";
  if ("]PX^_".includes(character)) return "string";
  if (/[\x20-\x2f]/u.test(character)) return "intermediate";
  return "text";
}
