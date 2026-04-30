/**
 * Builds ACP {@link ContentBlock} arrays for Cursor from composer text, optional
 * attachments, and user-scope instructions (same sources as {@link buildCursorPrompt}).
 */

import { readFileSync } from "node:fs";
import type { AttachmentMeta } from "@mcode/contracts";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  buildCursorPrompt,
  readCursorUserInstructions,
} from "./cursor-prompt.js";

/**
 * Assembles prompt blocks for `session/prompt`, embedding images when readable
 * from disk; non-image attachments stay as inline text notes without raw paths.
 *
 * @param message - User-visible message for this turn (may include branch replay text).
 * @param attachments - Persisted attachment metadata with `sourcePath` for images.
 * @param userInstructions - Optional AGENTS.md contents; defaults to {@link readCursorUserInstructions}.
 */
export function buildCursorAcpPromptBlocks(
  message: string,
  attachments?: AttachmentMeta[],
  userInstructions?: string,
): ContentBlock[] {
  const instructions = userInstructions ?? readCursorUserInstructions();
  const blocks: ContentBlock[] = [];

  const nonImageAttachments =
    attachments?.filter((att) => !att.mimeType.startsWith("image/")) ?? [];

  for (const att of attachments ?? []) {
    if (!att.mimeType.startsWith("image/")) continue;
    try {
      const buf = readFileSync(att.sourcePath);
      blocks.push({
        type: "image",
        mimeType: att.mimeType,
        data: buf.toString("base64"),
      });
    } catch {
      blocks.push({
        type: "text",
        text: `[Attached image unreadable: ${att.name.replace(/[\x00-\x1f\x7f]/g, "")}]`,
      });
    }
  }

  const textBody = buildCursorPrompt(message, nonImageAttachments, instructions);
  blocks.push({ type: "text", text: textBody });
  return blocks;
}
