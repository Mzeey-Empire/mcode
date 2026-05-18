import { langFromPath } from "@/lib/lang-from-path";

/** GitHub-style code reference fence: startLine:endLine:path (path may be relative or absolute). */
const LINE_RANGE_FENCE = /^\d+:\d+:(.+)$/;

/** Alternate tool output: lineNumber:path (one line ref before the path). */
const LINE_START_FENCE = /^\d+:(.+)$/;

/**
 * Returns true when `s` is plausibly a file path worth mapping (has a separator
 * or a basename.extension shape). Keeps hot paths cheap by avoiding regex when
 * there is no dot.
 */
function looksLikeFilePath(s: string): boolean {
  if (!s.includes(".") && !s.includes("/") && !s.includes("\\")) return false;
  if (s.includes("/") || s.includes("\\")) return true;
  // Basename.extension (e.g. preview-browser.ts). Requires a final segment after the last dot.
  return /^[\w.-]+\.[\w]+$/u.test(s);
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Returns the path segment embedded in tool-style fence metadata, or a bare path-looking string.
 * Tries `line:line:path` before `line:path` so values like `12:34:file.ts` are not parsed as `34:file.ts`.
 */
function pathSegmentFromFenceInfo(fenceInfo: string): string | null {
  const rangeMatch = LINE_RANGE_FENCE.exec(fenceInfo);
  if (rangeMatch?.[1]) return rangeMatch[1].trim();

  const startMatch = LINE_START_FENCE.exec(fenceInfo);
  if (startMatch?.[1]) return startMatch[1].trim();

  if (looksLikeFilePath(fenceInfo)) return fenceInfo.trim();
  return null;
}

/**
 * If the fence info string embeds a path with an extension, returns the inferred
 * Shiki language and a short display label. Otherwise returns null so callers can
 * pass the raw fence language to the worker (aliases like `ts` stay unchanged).
 */
function tryLangFromEmbeddedPath(fenceInfo: string): { language: string; label: string } | null {
  const pathPart = pathSegmentFromFenceInfo(fenceInfo);
  if (!pathPart) return null;

  const lang = langFromPath(pathPart);
  if (lang === "text") return null;

  const slash = Math.max(pathPart.lastIndexOf("/"), pathPart.lastIndexOf("\\"));
  const label = slash >= 0 ? pathPart.slice(slash + 1) : pathPart;
  return { language: lang, label };
}

export interface ResolvedCodeBlockLanguage {
  /** Shiki / worker language id (e.g. `typescript`). */
  language: string;
  /** Human-readable header for {@link CodeBlock} (filename or original fence tag). */
  label: string;
}

/**
 * Derives the syntax highlighting language from a markdown fence info string,
 * including GitHub `line:line:path` references and bare paths ending in a known extension.
 * Falls back to the trimmed fence string for the worker (which applies its own aliases).
 *
 * @param fenceInfo - The info string after the opening fence (e.g. `ts`, `12:34:src/a.ts`).
 * @param code - When `fenceInfo` is empty, only the first line is scanned for a line:line:path prefix
 *   so the common hot path (non-empty fences) never walks past the opening line.
 */
export function resolveCodeBlockLanguage(fenceInfo: string, code = ""): ResolvedCodeBlockLanguage {
  const trimmed = fenceInfo.trim();
  if (!trimmed) {
    const head = firstLine(code).trim();
    if (head) {
      const fromHead = tryLangFromEmbeddedPath(head);
      if (fromHead) {
        return { language: fromHead.language, label: fromHead.label };
      }
    }
    return { language: "text", label: "text" };
  }

  const fromPath = tryLangFromEmbeddedPath(trimmed);
  if (fromPath) {
    return { language: fromPath.language, label: fromPath.label };
  }

  return { language: trimmed, label: trimmed };
}
