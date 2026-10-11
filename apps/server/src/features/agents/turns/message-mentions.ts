import type { MessageMention, ProviderId } from "@mcode/contracts";
import type { FileService } from "../../projects/files/file-service.js";

const FILE_INJECTION_SEPARATOR = "\n\n---\n";

/** The file access mention checks and injection need. Undefined where no file service is wired. */
export type MentionFiles = Pick<FileService, "validateMentionPath" | "read">;

/** Where a message's mentions resolve: its workspace, its thread's checkout, and the provider that reads them. */
export interface MentionScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly providerId: ProviderId;
}

/**
 * Check every mention against the text it claims to cover and the workspace it names.
 * Returns the mentions sorted by range start. Throws on the first invalid mention.
 */
export function validateMessageMentions(
  files: MentionFiles | undefined,
  scope: MentionScope,
  content: string,
  mentions: readonly MessageMention[],
): MessageMention[] {
  const sorted = [...mentions].sort((a, b) => a.range.start - b.range.start);
  let previousEnd = 0;
  for (const mention of sorted) {
    validateMention(files, scope, content, mention, previousEnd);
    previousEnd = mention.range.end;
  }
  return sorted;
}

/**
 * Append the text of each mentioned file, once per path, for providers that cannot read
 * mentions natively. Codex takes mentions as native input parts, so callers skip it there.
 */
export async function injectMentionFileContents(
  files: MentionFiles | undefined,
  scope: Omit<MentionScope, "providerId">,
  mentions: readonly MessageMention[],
  text: string,
): Promise<string> {
  const paths = new Set<string>();
  const contents: Array<{ path: string; content: string }> = [];
  for (const mention of mentions) {
    if (mention.kind !== "file" || paths.has(mention.path)) continue;
    if (!files) throw new Error("File mention injection is unavailable");
    paths.add(mention.path);
    files.validateMentionPath(scope.workspaceId, mention.path, scope.threadId);
    const result = await files.read(scope.workspaceId, mention.path, scope.threadId, "text");
    if (result.kind !== "text") continue;
    contents.push({ path: mention.path, content: result.content });
  }
  return buildInjectedFileMessage(text, contents);
}

function validateMention(
  files: MentionFiles | undefined,
  scope: MentionScope,
  content: string,
  mention: MessageMention,
  previousEnd: number,
): void {
  const display = mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
  if (mention.range.end > content.length || content.slice(mention.range.start, mention.range.end) !== display) {
    throw new Error(`Invalid mention range for ${display}`);
  }
  if (mention.range.start < previousEnd) throw new Error("Mention ranges must not overlap");
  if (mention.kind === "file") {
    if (!files) throw new Error("File mention validation is unavailable");
    files.validateMentionPath(scope.workspaceId, mention.path, scope.threadId);
    return;
  }
  if (mention.kind !== "command" && scope.providerId !== "codex") {
    throw new Error("Provider mentions are only supported by Codex");
  }
}

function buildInjectedFileMessage(text: string, files: readonly { path: string; content: string }[]): string {
  if (files.length === 0) return text;
  const blocks = files.map((file) => {
    const content = file.content.replace(/<\/file>/gi, "<\\/file>");
    const path = file.path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<file path="${path}">\n${content}\n</file>`;
  }).join("\n");
  return `${text}${FILE_INJECTION_SEPARATOR}${blocks}`;
}
