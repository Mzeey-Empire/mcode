import type { FileReadState } from "./useFilesData";

/** Which body and row-2 controls a Files tab gets. */
export type FileViewKind = "markdown" | "image" | "svg" | "code";

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

/** Picks the view for an open file; anything not yet read, or unreadable, is "code" so CodeFileView explains it. */
export function fileViewKind(path: string, state: FileReadState | undefined): FileViewKind {
  if (state?.status !== "ready") return "code";
  const { result } = state;
  if (result.kind === "image") return result.mime === "image/svg+xml" ? "svg" : "image";
  if (result.kind === "text" && MARKDOWN_EXTENSION.test(path)) return "markdown";
  return "code";
}
