/**
 * Shared layout classes for narrative tool rows.
 *
 * Flex rows need `min-w-0` and `overflow-hidden` on the container (not only on
 * the truncating child) so long unbroken command strings ellipsize instead of
 * widening the chat column.
 */

/**
 * Narration and answer prose at 16/28 ink. Markdown paragraphs and list items
 * carry their own `leading-relaxed`, so they inherit the prose leading instead;
 * otherwise settled text would sit at 26px lines and the row would shrink at
 * the swap from the streaming body to the persisted markdown.
 *
 * The chat column clips horizontal overflow, so an unbroken run such as a comma-separated number
 * list, a URL or a hash breaks inside the column instead of being cut off at its edge.
 */
export const TURN_PROSE_CLASS = "text-prose text-ink break-words [&_p]:leading-[inherit] [&_li]:leading-[inherit]";

/** Constrains a horizontal tool/meta row inside the virtualized chat column. */
export const NARRATIVE_TOOL_ROW =
  "flex min-w-0 max-w-full items-center gap-2 overflow-hidden";
