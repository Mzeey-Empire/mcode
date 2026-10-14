import { useEffect, useState } from "react";
import { getWorker, nextRequestId, pending, workerGeneration, type WorkerResponse } from "@/lib/shiki-worker-client";
import { langFromPath } from "@/lib/lang-from-path";
import type { TokenSpan } from "@/workers/shiki.worker";

/** Files above this size stay plain text; tokenizing them would stall the worker. */
const MAX_HIGHLIGHT_CHARS = 512 * 1024;
const BLOCK_ID = "file";

function isTokenSpan(value: unknown): value is TokenSpan {
  return typeof value === "object" && value !== null && "content" in value && "color" in value
    && typeof value.content === "string" && typeof value.color === "string";
}

function isTokenLines(value: unknown): value is TokenSpan[][] {
  return Array.isArray(value) && value.every((line) => Array.isArray(line) && line.every(isTokenSpan));
}

function linesFromResponse(response: WorkerResponse | null): TokenSpan[][] | null {
  const results = response?.results;
  if (!Array.isArray(results)) return null;
  const block: unknown = results[0];
  if (typeof block !== "object" || block === null || !("lines" in block)) return null;
  return isTokenLines(block.lines) && block.lines.length > 0 ? block.lines : null;
}

/**
 * Tokenizes a file in the shared shiki worker with the Files theme. Returns
 * null until tokens arrive, so the view shows plain text first and swaps in
 * colors without blocking the first paint.
 */
export function useCodeTokens(path: string, content: string | null): TokenSpan[][] | null {
  const [tokens, setTokens] = useState<{ readonly key: string; readonly lines: TokenSpan[][] } | null>(null);
  const key = `${path}\u0000${content ?? ""}`;
  const language = langFromPath(path);

  useEffect(() => {
    if (content === null || content.length === 0 || content.length > MAX_HIGHLIGHT_CHARS || language === "text") return;
    if (typeof Worker === "undefined") return;
    const id = nextRequestId("files-hl");
    const generationAtRequest = workerGeneration;
    pending.set(id, (response) => {
      if (generationAtRequest !== workerGeneration) return;
      const lines = linesFromResponse(response);
      if (lines) setTokens({ key, lines });
    });
    getWorker().postMessage({
      id,
      type: "tokenize",
      blocks: [{ blockId: BLOCK_ID, code: content, language, theme: "mcode-files" }],
    });
    return () => {
      pending.delete(id);
    };
  }, [content, key, language]);

  return tokens?.key === key ? tokens.lines : null;
}
