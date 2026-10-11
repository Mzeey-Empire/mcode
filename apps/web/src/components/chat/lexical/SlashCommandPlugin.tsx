import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  TextNode,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import {
  $createSlashCommandNode,
  type SlashCommandNamespace,
} from "./SlashCommandNode";
import {
  $createTypedMentionNode,
  createMentionId,
  type MentionNodeData,
} from "./MentionNode";
import type { ProviderCapabilityIdentity } from "@mcode/contracts";
import { SLASH_TRIGGER_RE, type Command } from "../useSlashCommand";

/** Props for the SlashCommandPlugin that detects /-triggers in the editor. */
interface SlashCommandPluginProps {
  /** Called when a /command trigger is detected, with the full text content. */
  readonly onTrigger: (value: string) => void;
  /** Called to close the slash tray when the trigger is no longer valid. */
  readonly onDismiss: () => void;
  /** Whether the slash command tray is currently visible. */
  readonly isPopupOpen: boolean;
  /**
   * Called when the user types a space right after `/name`. Returning true
   * consumes the command: the plugin removes the `/name ` text from the draft.
   */
  readonly onInlineCommand?: (commandName: string) => boolean;
}

/** A command name typed and closed by a space, e.g. `/plan ` before the cursor. */
const INLINE_COMMAND_RE = /(^|\s)\/(\S+) $/;

interface InlineCommandMatch {
  readonly nodeKey: NodeKey;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

interface ActiveSlashTrigger {
  readonly node: TextNode;
  readonly textContent: string;
  readonly triggerStart: number;
  readonly cursorOffset: number;
}

/** Text node and offset of a collapsed caret, or null when the caret is not inside text. */
function $getCollapsedTextCaret(): { node: TextNode; offset: number } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  if (anchor.type !== "text") return null;
  const node = anchor.getNode();
  if (!(node instanceof TextNode)) return null;
  return { node, offset: anchor.offset };
}

function $findActiveSlashTrigger(): ActiveSlashTrigger | null {
  const caret = $getCollapsedTextCaret();
  if (!caret) return null;
  const textContent = caret.node.getTextContent();
  const match = SLASH_TRIGGER_RE.exec(textContent.slice(0, caret.offset));
  if (!match) return null;
  return {
    node: caret.node,
    textContent,
    triggerStart: match.index + match[1].length,
    cursorOffset: caret.offset,
  };
}

// Only a single space typed at the caret counts, so moving the caret, deleting,
// or pasting next to existing `/name ` text never converts it.
function $matchInlineCommand(
  prevEditorState: EditorState,
  caret: { node: TextNode; offset: number },
): InlineCommandMatch | null {
  const textContent = caret.node.getTextContent();
  const match = INLINE_COMMAND_RE.exec(textContent.slice(0, caret.offset));
  if (!match) return null;
  const nodeKey = caret.node.getKey();
  const previousText = prevEditorState.read(() => $getNodeByKey(nodeKey)?.getTextContent());
  const textWithoutSpace = textContent.slice(0, caret.offset - 1) + textContent.slice(caret.offset);
  if (previousText !== textWithoutSpace) return null;
  return {
    nodeKey,
    name: match[2],
    start: match.index + match[1].length,
    end: caret.offset,
  };
}

function removeInlineCommand(editor: LexicalEditor, command: InlineCommandMatch): void {
  editor.update(() => {
    const node = $getNodeByKey(command.nodeKey);
    if (!(node instanceof TextNode)) return;
    const text = node.getTextContent();
    if (text.slice(command.start, command.end) !== `/${command.name} `) return;
    node.setTextContent(text.slice(0, command.start) + text.slice(command.end));
    node.select(command.start, command.start);
  });
}

/**
 * Lexical plugin that detects /-triggers for slash commands and converts an
 * inline `/name ` the owner accepts.
 *
 * Uses refs for callbacks to register the update listener once,
 * avoiding re-registration on every prop change.
 */
export function SlashCommandPlugin({
  onTrigger,
  onDismiss,
  isPopupOpen,
  onInlineCommand,
}: SlashCommandPluginProps): null {
  const [editor] = useLexicalComposerContext();

  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const isPopupOpenRef = useRef(isPopupOpen);
  isPopupOpenRef.current = isPopupOpen;
  const onInlineCommandRef = useRef(onInlineCommand);
  onInlineCommandRef.current = onInlineCommand;

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, prevEditorState, dirtyLeaves, tags }) => {
      const inlineCommand = editorState.read(() => {
        const caret = $getCollapsedTextCaret();
        const textBeforeCursor = caret?.node.getTextContent().slice(0, caret.offset);
        if (caret && textBeforeCursor !== undefined && SLASH_TRIGGER_RE.test(textBeforeCursor)) {
          // Pass only text before the cursor so the regex $ anchor matches
          onTriggerRef.current(textBeforeCursor);
          return null;
        }
        if (isPopupOpenRef.current) onDismissRef.current();
        // Undo and redo replay history, so they must not re-run a command.
        if (!caret || dirtyLeaves.size === 0 || tags.has("historic")) return null;
        return $matchInlineCommand(prevEditorState, caret);
      });
      if (inlineCommand && onInlineCommandRef.current?.(inlineCommand.name)) {
        removeInlineCommand(editor, inlineCommand);
      }
    });
  }, [editor]);

  return null;
}

function replaceActiveSlashTrigger(
  editor: LexicalEditor,
  createNode: () => LexicalNode,
): void {
  editor.update(() => {
    const trigger = $findActiveSlashTrigger();
    if (!trigger) return;
    const { node, textContent, triggerStart, cursorOffset } = trigger;

    const beforeText = textContent.slice(0, triggerStart);
    const afterCursor = textContent.slice(cursorOffset);
    const insertedNode = createNode();
    const trailingText = afterCursor.length > 0 ? afterCursor : " ";
    const afterNode = $createTextNode(trailingText);

    if (beforeText) {
      const beforeNode = $createTextNode(beforeText);
      node.replace(beforeNode);
      beforeNode.insertAfter(insertedNode);
      insertedNode.insertAfter(afterNode);
    } else {
      node.replace(insertedNode);
      insertedNode.insertAfter(afterNode);
    }

    const offset = trailingText.startsWith(" ") ? 1 : 0;
    afterNode.select(offset, offset);
  });
}

/** Replaces the active slash trigger with a native Codex plugin mention. */
export function insertPluginMentionNode(
  editor: LexicalEditor,
  mention: Extract<MentionNodeData, { kind: "plugin" }>,
): void {
  replaceActiveSlashTrigger(editor, () => $createTypedMentionNode(mention));
}

/**
 * Insert a slash command node at the current / trigger position.
 */
export function insertSlashCommandNode(
  editor: LexicalEditor,
  commandName: string,
  namespace: SlashCommandNamespace,
  capabilityIdentity?: ProviderCapabilityIdentity,
  path?: string,
): void {
  replaceActiveSlashTrigger(
    editor,
    () => $createSlashCommandNode(commandName, namespace, capabilityIdentity, path),
  );
}

/** Inserts a selected plugin command as a native Codex mention. */
export function insertSelectedPluginMention(
  editor: LexicalEditor,
  command: Pick<Command, "capabilityKind" | "mentionPath" | "name">,
): boolean {
  if (command.capabilityKind !== "plugin" || !command.mentionPath) return false;
  insertPluginMentionNode(editor, {
    id: createMentionId(),
    kind: "plugin",
    label: command.name,
    name: command.name,
    path: command.mentionPath,
  });
  return true;
}

/** Removes the slash trigger at the current selection without inserting a command node. */
export function removeSlashCommandTrigger(editor: LexicalEditor): void {
  editor.update(() => {
    const trigger = $findActiveSlashTrigger();
    if (!trigger) return;
    const { node, textContent, triggerStart, cursorOffset } = trigger;
    node.setTextContent(textContent.slice(0, triggerStart) + textContent.slice(cursorOffset));
    node.select(triggerStart, triggerStart);
  });
}
