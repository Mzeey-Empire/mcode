import type { KeyboardEvent, ReactNode } from "react";
import type { Message } from "@/transport";
import { EntityToken } from "@/components/chat/EntityToken";
import { basename } from "@/lib/path";
import { openFileInFiles } from "@/features/files/open-file-command";

/** Props for {@link MentionedText}. */
export interface MentionedTextProps {
  /** Message text the mention ranges index into. */
  text: string;
  /** Mentions recorded when the user sent the message. */
  mentions: NonNullable<Message["mentions"]>;
}

/**
 * Renders user text with each still-valid mention replaced by an entity token.
 * Returns inline nodes only, so callers choose the wrapping element.
 */
export function MentionedText({ text, mentions }: MentionedTextProps) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const sorted = [...mentions].sort((a, b) => a.range.start - b.range.start);

  for (const mention of sorted) {
    const rawMention = getRawMention(mention);
    if (!isVisibleMention(text, cursor, mention.range, rawMention)) continue;
    addLeadingText(nodes, text, cursor, mention.range.start);
    nodes.push(createMentionToken(mention, rawMention));
    cursor = mention.range.end;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** Gets the unmodified transcript text for a mention. */
function getRawMention(mention: NonNullable<Message["mentions"]>[number]): string {
  return mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
}

/** Checks that a mention range still points at the user-entered mention text. */
function isVisibleMention(
  text: string,
  cursor: number,
  range: { start: number; end: number },
  rawMention: string,
): boolean {
  return range.start >= cursor
    && range.end <= text.length
    && text.slice(range.start, range.end) === rawMention;
}

/** Appends text that appears before the next mention token. */
function addLeadingText(nodes: ReactNode[], text: string, cursor: number, mentionStart: number): void {
  if (mentionStart > cursor) nodes.push(text.slice(cursor, mentionStart));
}

/** Creates the user-tone entity token for one valid mention. */
function createMentionToken(mention: NonNullable<Message["mentions"]>[number], rawMention: string): ReactNode {
  const label = mention.kind === "file" ? `@${basename(mention.path)}` : rawMention;
  return (
    <EntityToken
      key={`${mention.id}-${mention.range.start}`}
      kind={mention.kind === "command" ? mention.namespace : mention.kind}
      label={label}
      filePath={mention.kind === "file" ? mention.path : undefined}
      title={rawMention}
      tone="user"
      invocation={mention.kind === "command"}
      {...(mention.kind === "file" ? fileLinkProps(mention.path) : {})}
    />
  );
}

/** Makes a file token act as a link that opens its file in the Files tool. */
function fileLinkProps(path: string) {
  return {
    role: "link",
    tabIndex: 0,
    className: "cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-focus",
    onClick: () => openFileInFiles(path),
    onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      openFileInFiles(path);
    },
  };
}
