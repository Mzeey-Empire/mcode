import { logger } from "@mcode/shared";
import { TerminalReplayBuffer } from "./terminal-replay-buffer.js";

/** Retains early command observations until the action owner has saved its run. */
export class ActionTerminalEvents {
  private readonly outputs = new Set<(bytes: Uint8Array) => void>();
  private readonly exits = new Set<(exit: { readonly exitCode: number | null }) => void>();
  private readonly closures = new Set<() => void>();
  private output: TerminalReplayBuffer;
  private exit: { readonly exitCode: number | null } | null = null;
  private closed = false;
  private sequence = 0;

  constructor(private readonly cap: number) {
    this.output = new TerminalReplayBuffer(cap);
  }

  /** Starts a fresh command observation window for a rerun. */
  reset(): void {
    this.output = new TerminalReplayBuffer(this.cap);
    this.sequence = 0;
    this.exit = null;
  }

  /** Records only bytes emitted by the command process. */
  emitOutput(bytes: Uint8Array): void {
    if (this.outputs.size === 0) this.output.record(++this.sequence, bytes);
    for (const listener of this.outputs) listener(bytes);
  }

  /** Replays early command bytes, then delivers new bytes to the owner. */
  onCommandOutput = (listener: (bytes: Uint8Array) => void): (() => void) => {
    this.outputs.add(listener);
    for (const chunk of this.output.replay(-1).chunks) listener(chunk.bytes);
    this.output = new TerminalReplayBuffer(this.cap);
    return () => { this.outputs.delete(listener); };
  };

  /** Observes a command exit even when it preceded owner attachment. */
  onCommandExit = (listener: (exit: { readonly exitCode: number | null }) => void): (() => void) => {
    this.exits.add(listener);
    if (this.exit) listener(this.exit);
    return () => { this.exits.delete(listener); };
  };

  /** Signals a command exit without letting an owner prevent shell hand-off. */
  emitExit(exitCode: number | null): void {
    this.exit = { exitCode };
    for (const listener of this.exits) {
      try { listener(this.exit); }
      catch (error) { logger.warn("Action terminal exit listener failed", { error: String(error) }); }
    }
  }

  /** Observes explicit terminal closure or scope teardown. */
  onClosed = (listener: () => void): (() => void) => {
    this.closures.add(listener);
    if (this.closed) listener();
    return () => { this.closures.delete(listener); };
  };

  /** Releases listeners when the terminal record is removed. */
  close(): void {
    this.closed = true;
    for (const listener of this.closures) listener();
    this.outputs.clear();
    this.exits.clear();
    this.closures.clear();
    this.output = new TerminalReplayBuffer(this.cap);
  }
}

/** Formats an echo for display without sending any script text to the shell. */
export function actionCommandEcho(shell: string, cwd: string, script: string): Uint8Array {
  const basename = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase();
  const prompt = basename === "pwsh" || basename === "powershell"
    ? `PS ${cwd}> ` : basename === "cmd" ? `${cwd}> ` : "$ ";
  const command = script.replace(/\r\n?/g, "\n").split("\n").join("\r\n  ");
  return Buffer.from(`\u001b[90m${prompt}\u001b[39m${command}\u001b[0m\r\n`);
}
