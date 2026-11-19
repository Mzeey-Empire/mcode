/** Image source scheme an agent's reply uses to place a published visual: `![Title](visual:<message id>)`. */
const VISUAL_MARKER_SCHEME = "visual:";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_SPAN = /(`+)[\s\S]*?\1/g;

/** Returns the visual message id a markdown image source names, or undefined for any other source. */
export function visualMarkerMessageId(src: string | undefined): string | undefined {
  if (!src?.startsWith(VISUAL_MARKER_SCHEME)) return undefined;
  const id = src.slice(VISUAL_MARKER_SCHEME.length);
  return id === "" ? undefined : id;
}

/**
 * True when a reply renders the visual at its own marker: an image `![alt](visual:<id>)` outside code.
 * A marker shown as code or written as a plain link renders no visual, so it must not count as placed.
 */
export function replyPlacesVisual(content: string, messageId: string): boolean {
  if (!content.includes(`${VISUAL_MARKER_SCHEME}${messageId}`)) return false;
  // The server escapes `\`, `[` and `]` in titles, so alt text may hold escaped brackets.
  const marker = new RegExp(`!\\[(?:[^\\[\\]\\\\]|\\\\.)*\\]\\(${escapeRegExp(VISUAL_MARKER_SCHEME + messageId)}\\)`);
  return marker.test(withoutCode(content));
}

function withoutCode(content: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    if (fence) {
      if (line.trim().startsWith(fence) && line.trim().replaceAll(fence[0] ?? "", "") === "") fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open) fence = open;
    else kept.push(line);
  }
  return kept.join("\n").replace(INLINE_CODE_SPAN, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
