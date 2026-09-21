import { useCallback, useEffect, useState, type MutableRefObject, type RefObject } from "react";
import type { LexicalEditor } from "lexical";
import type { MessageMention } from "@mcode/contracts";
import { Check, Trash2, X } from "lucide-react";
import {
  ComposerEditor,
  createMentionNodeData,
  insertMentionNode,
  insertSelectedPluginMention,
  insertSlashCommandNode,
} from "@/components/chat/lexical";
import { FileTagPopup, useFileTagPopup } from "@/components/chat/FileTagPopup";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import { handleSlashCommandPopupKey, type Command, useSlashCommand } from "@/components/chat/useSlashCommand";
import { useFileAutocomplete, type MentionSuggestion } from "@/components/chat/useFileAutocomplete";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import {
  decideCommentDismissal,
  type CommentDismissalFamily,
} from "./comment-editor-model";

function isPopupTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-file-popup], [data-slash-popup]"));
}

/**
 * Two-attempt dismissal policy for dirty comment editors: Escape and
 * outside-pointer each warn once, then close. Shared by the selected-text and
 * diff comment editors so both surfaces behave identically.
 */
export function useCommentDismissal({
  rootRef,
  isDirty,
  isPopupOpenRef,
  onClose,
  onAnnouncement,
  onWarningsChange,
  initialEscapeWarned = false,
  initialOutsideWarned = false,
}: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly isDirty: boolean;
  readonly isPopupOpenRef: RefObject<boolean>;
  readonly onClose: () => void;
  readonly onAnnouncement?: (message: string) => void;
  readonly onWarningsChange?: (escapeWarned: boolean, outsideWarned: boolean) => void;
  readonly initialEscapeWarned?: boolean;
  readonly initialOutsideWarned?: boolean;
}) {
  const [escapeWarned, setEscapeWarned] = useState(initialEscapeWarned);
  const [outsideWarned, setOutsideWarned] = useState(initialOutsideWarned);
  const [isShaking, setIsShaking] = useState(false);

  const resetWarnings = useCallback(() => {
    setEscapeWarned(false);
    setOutsideWarned(false);
    setIsShaking(false);
    onWarningsChange?.(false, false);
  }, [onWarningsChange]);

  const requestDismissal = useCallback((family: CommentDismissalFamily) => {
    const decision = decideCommentDismissal({
      family,
      isDirty,
      escapeWarned,
      outsideWarned,
    });
    if (decision.kind === "close") {
      resetWarnings();
      onClose();
      return;
    }
    setIsShaking(false);
    requestAnimationFrame(() => setIsShaking(true));
    if (family === "escape") {
      setEscapeWarned(true);
      onWarningsChange?.(true, outsideWarned);
    } else {
      setOutsideWarned(true);
      onWarningsChange?.(escapeWarned, true);
    }
    onAnnouncement?.(decision.announcement);
  }, [escapeWarned, isDirty, onAnnouncement, onClose, onWarningsChange, outsideWarned, resetWarnings]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isPopupOpenRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestDismissal("escape");
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (rootRef.current?.contains(target as Node) || isPopupTarget(target)) return;
      if (isDirty && !outsideWarned) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      requestDismissal("outside");
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isDirty, isPopupOpenRef, outsideWarned, requestDismissal, rootRef]);

  return { isShaking, requestDismissal, resetWarnings };
}

/**
 * Compact ComposerEditor wired for comment notes: file mentions, slash
 * commands, and popup key routing. Shared by every "Add comment" surface so
 * the editing experience is identical wherever it appears.
 */
export function CommentEditorComposer({
  threadId,
  workspaceId,
  providerId,
  savedNote,
  savedMentions,
  editorRef,
  contentEditableRef,
  rootRef,
  isPopupOpenRef,
  maxHeight,
  onChange,
  onSubmit,
}: {
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly providerId?: string;
  readonly savedNote: string;
  readonly savedMentions: readonly MessageMention[];
  readonly editorRef: MutableRefObject<LexicalEditor | null>;
  readonly contentEditableRef: React.Ref<HTMLDivElement>;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly isPopupOpenRef: RefObject<boolean>;
  readonly maxHeight?: number;
  readonly onChange: (note: string, mentions: MessageMention[]) => void;
  readonly onSubmit: () => void;
}) {
  const fileAutocomplete = useFileAutocomplete({ workspaceId, threadId, providerId });
  const slashCommand = useSlashCommand({
    anchorRef: rootRef,
    workspaceId,
    threadId,
    providerId: providerId ?? "selected-text-comment",
    includeBuiltins: false,
  });
  isPopupOpenRef.current = fileAutocomplete.isOpen || slashCommand.isOpen;

  useEffect(() => {
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editorRef]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) writeComposerContent(editor, savedNote, savedMentions);
  }, [editorRef, savedMentions, savedNote]);

  const handleMentionSelect = useCallback((item: MentionSuggestion) => {
    const editor = editorRef.current;
    if (!editor) return;
    fileAutocomplete.selectSuggestion(item);
    insertMentionNode(editor, createMentionNodeData(item), fileAutocomplete.triggerStart, fileAutocomplete.query.length);
  }, [editorRef, fileAutocomplete]);

  const filePopup = useFileTagPopup({
    items: fileAutocomplete.suggestions,
    query: fileAutocomplete.query,
    isOpen: fileAutocomplete.isOpen,
    onSelect: handleMentionSelect,
    onDismiss: fileAutocomplete.dismiss,
  });

  const handleSlashSelect = useCallback((command: Command) => {
    const editor = editorRef.current;
    if (!editor) return;
    slashCommand.onSelect(command, () => {});
    if (!insertSelectedPluginMention(editor, command)) {
      insertSlashCommandNode(editor, command.name, command.namespace, command.identity);
    }
  }, [editorRef, slashCommand]);

  const handlePopupKeyDown = useCallback((key: string): boolean => {
    if (fileAutocomplete.isOpen) {
      return filePopup.handleKeyDown({
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.KeyboardEvent);
    }
    if (slashCommand.isOpen) {
      return handleSlashCommandPopupKey(
        key,
        slashCommand.items,
        slashCommand.selectedIndex,
        handleSlashSelect,
        slashCommand.onDismiss,
        slashCommand.onKeyDown,
      );
    }
    return false;
  }, [fileAutocomplete.isOpen, filePopup, handleSlashSelect, slashCommand]);

  const popupAnchorRect = fileAutocomplete.isOpen
    ? rootRef.current?.getBoundingClientRect() ?? null
    : null;

  return (
    <>
      <ComposerEditor
        onChange={onChange}
        onSubmit={onSubmit}
        onMentionTrigger={fileAutocomplete.handleInputChange}
        onMentionDismiss={fileAutocomplete.dismiss}
        isMentionPopupOpen={fileAutocomplete.isOpen}
        onSlashTrigger={slashCommand.onInputChange}
        onSlashDismiss={slashCommand.onDismiss}
        isSlashPopupOpen={slashCommand.isOpen}
        editorRef={editorRef}
        contentEditableRef={contentEditableRef}
        autoFocus
        id="selected-text-comment-note"
        ariaLabel="Comment note"
        placeholder="Write a note"
        submitOnEnter={false}
        compact
        compactMaxHeight={maxHeight}
        isPopupOpen={isPopupOpenRef.current}
        onPopupKeyDown={handlePopupKeyDown}
      />
      <FileTagPopup
        items={fileAutocomplete.suggestions}
        isOpen={fileAutocomplete.isOpen}
        onSelect={handleMentionSelect}
        listRef={filePopup.listRef}
        selectedIndex={filePopup.selectedIndex}
        anchorRect={popupAnchorRect}
        presentation="compact"
      />
      <SlashCommandPopup
        state={slashCommand.state}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        onSelect={handleSlashSelect}
        onDismiss={slashCommand.onDismiss}
        onRetry={slashCommand.onRetry}
      />
    </>
  );
}

/** Save / delete / close icon controls shared by every compact comment editor. */
export function CommentEditorControls({
  editing,
  canSave,
  onSave,
  onDelete,
  onClose,
}: {
  readonly editing: boolean;
  readonly canSave: boolean;
  readonly onSave: () => void;
  readonly onDelete?: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {canSave && (
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                size="icon-xs"
                className="order-2 rounded-full"
                aria-label={editing ? "Save comment" : "Add comment"}
                onClick={onSave}
              >
                <Check size={13} aria-hidden />
              </Button>
            )}
          />
          <TooltipContent>{editing ? "Save comment" : "Add comment"}</TooltipContent>
        </Tooltip>
      )}
      {editing && onDelete && (
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="order-3 rounded-full text-destructive hover:text-destructive"
                aria-label="Delete comment"
                onClick={onDelete}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            )}
          />
          <TooltipContent>Delete comment</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="order-1 rounded-full"
              aria-label="Close comment editor"
              onClick={onClose}
            >
              <X size={14} aria-hidden />
            </Button>
          )}
        />
        <TooltipContent>Close comment editor</TooltipContent>
      </Tooltip>
    </div>
  );
}
