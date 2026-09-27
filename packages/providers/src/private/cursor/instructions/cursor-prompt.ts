/**
 * @internal
 * Prompt assembly for `cursor-agent --print`. Cursor exposes no `--system` or
 * `--instructions` flag; user-scope guidance from `~/.cursor/AGENTS.md` is
 * prepended here so each turn receives it alongside workspace-local discovery.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AttachmentMeta, MessageMention } from "@mcode/contracts";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";

/**
 * Reads trimmed contents of `~/.cursor/AGENTS.md` when that file exists.
 *
 * @returns File contents or `undefined` when missing or unreadable.
 */
export function readCursorUserInstructions(): string | undefined {
  const path = NodePath.join(NodeOS.homedir(), ".cursor", "AGENTS.md");
  if (!NodeFS.existsSync(path)) return undefined;
  try {
    const text = NodeFS.readFileSync(path, "utf-8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds prompt text from optional user instructions, attachment references, and the message.
 *
 * Images become explicit paths; non-images become labelled mentions without raw FS paths.
 *
 * @param message User-visible message body for this turn.
 * @param attachments Optional attachment metadata from the composer.
 * @param userInstructions Optional extra instructions (typically from {@link readCursorUserInstructions}).
 */
export function buildCursorPrompt(
  message: string,
  attachments?: AttachmentMeta[],
  userInstructions?: string,
): string {
  const lines: string[] = [];
  const trimmedInstructions = userInstructions?.trim();
  if (trimmedInstructions) {
    lines.push(`<user-instructions>\n${trimmedInstructions}\n</user-instructions>`);
  }
  for (const att of attachments ?? []) {
    if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
    if (att.mimeType.startsWith("image/")) {
      lines.push(`[Attached image path: ${att.sourcePath}]`);
    } else {
      const safeName = att.name.replace(/[\x00-\x1f\x7f]/g, "");
      const safeMime = att.mimeType.replace(/[\x00-\x1f\x7f]/g, "");
      lines.push(`[Attached file: ${safeName} (${safeMime})]`);
    }
  }
  lines.push(message);
  return lines.join("\n\n");
}

/**
 * Rewrites selected slash-command mentions as `[/name](path)` markdown links so
 * Cursor, which has no native skill-invocation channel, receives the backing
 * file the command refers to. Mentions whose stored range no longer matches the
 * `/label` text (stale draft state) are left verbatim.
 */
export function rewriteCursorCommandMentionsAsLinks(
  message: string,
  mentions: readonly MessageMention[] = [],
): string {
  let text = message;
  const linked = mentions
    .filter((mention): mention is Extract<MessageMention, { kind: "command" }> =>
      mention.kind === "command" && mention.path !== undefined)
    // Descending order keeps earlier mention ranges valid while splicing.
    .sort((a, b) => b.range.start - a.range.start);
  for (const mention of linked) {
    const expected = `/${mention.label}`;
    const { start, end } = mention.range;
    if (start < 0 || end > text.length || text.slice(start, end) !== expected) continue;
    text = `${text.slice(0, start)}[${expected}](${mention.path})${text.slice(end)}`;
  }
  return text;
}
