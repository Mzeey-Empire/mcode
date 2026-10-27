import type { WorkspaceEnvironmentActionPort } from "@mcode/contracts/models/workspace-environment";
import { TerminalPlainTextDecoder } from "../../terminal/output/terminal-plain-text.js";

/** A loopback URL from command output, awaiting a TCP probe. */
export type ActionPortCandidate = Pick<WorkspaceEnvironmentActionPort, "host" | "port" | "url">;

const OUTPUT_LIMIT = 1_048_576;
const CANDIDATE_LIMIT = 8;
const LOCAL_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):([0-9]+)(?=[/?#\s]|$)[^\s<>"'\x00-\x1f]*/giu;

/** Collects bounded, deduplicated candidates from one run's command bytes. */
export class ActionPortDetector {
  private readonly decoder = new TerminalPlainTextDecoder();
  private readonly candidates = new Set<string>();
  private scannedBytes = 0;
  private confirmed = false;

  confirm(): void { this.confirmed = true; }

  write(bytes: Uint8Array): ActionPortCandidate[] {
    if (this.confirmed || this.scannedBytes >= OUTPUT_LIMIT || this.candidates.size >= CANDIDATE_LIMIT) return [];
    const bounded = bytes.subarray(0, OUTPUT_LIMIT - this.scannedBytes);
    this.scannedBytes += bounded.byteLength;
    const decoded = this.decoder.write(bounded);
    const text = [...decoded.completedLines, decoded.currentLine].join("\n");
    const added: ActionPortCandidate[] = [];
    for (const match of text.matchAll(LOCAL_URL)) {
      const candidate = parseCandidate(match);
      if (!candidate) continue;
      const key = `${candidate.host}:${candidate.port}`;
      if (this.candidates.has(key)) continue;
      this.candidates.add(key);
      added.push(candidate);
      if (this.candidates.size === CANDIDATE_LIMIT) break;
    }
    return added;
  }
}

function parseCandidate(match: RegExpMatchArray): ActionPortCandidate | null {
  const host = match[1].toLowerCase().replace(/[[\]]/gu, "");
  if (!isLocalHost(host)) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535 || match[0].length > 2_048) return null;
  try {
    const url = new URL(match[0]);
    if (host === "0.0.0.0" || host === "::") url.hostname = "localhost";
    if (url.href.length > 2_048) return null;
    return { host, port, url: url.href };
  } catch {
    return null;
  }
}

function isLocalHost(host: string): host is ActionPortCandidate["host"] {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host === "::";
}

/**
 * Turns a configured preview URL into a probe candidate, or null when it is not a loopback URL.
 *
 * The URL is already validated by the environment schema; this repeats the host check because a
 * candidate's `host` selects the probe address, and a default port is filled in from the scheme.
 */
export function candidateFromConfiguredUrl(value: string): ActionPortCandidate | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/[[\]]/gu, "");
  if (!isLocalHost(host)) return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (host === "0.0.0.0" || host === "::") url.hostname = "localhost";
  return { host, port, url: url.href };
}
