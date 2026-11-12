import { useCallback, useRef, useEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { type EditorState, type LexicalEditor } from "lexical";
import type { MessageMention } from "@mcode/contracts/models/mention";
import { MentionNode } from "./MentionNode";
import { SlashCommandNode } from "./SlashCommandNode";
import { MentionPlugin } from "./MentionPlugin";
import { SlashCommandPlugin } from "./SlashCommandPlugin";
import { KeyboardPlugin } from "./KeyboardPlugin";
import { extractComposerMessage } from "./cursor-utils";
import type { SlashMenuAria } from "../useSlashCommand";

interface ComposerEditorProps {
  onChange: (text: string, mentions: MessageMention[]) => void;
  onSubmit: () => void;
  /** Called when @ trigger is detected - drives file autocomplete popup */
  onMentionTrigger: (text: string, cursorPos: number) => void;
  onMentionDismiss: () => void;
  isMentionPopupOpen: boolean;
  /** Called when / trigger is detected - drives slash command tray */
  onSlashTrigger: (textBeforeCaret: string, nodeKey: string) => void;
  onSlashDismiss: () => void;
  /** Called when `/name` is closed by a space; return true to consume the typed command. */
  onInlineSlashCommand?: (commandName: string) => boolean;
  /** Ref callback to expose the LexicalEditor instance */
  editorRef?: React.MutableRefObject<LexicalEditor | null>;
  /** Ref for the rendered editable element. */
  contentEditableRef?: React.Ref<HTMLDivElement>;
  /** Focuses the editable element when it mounts. */
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** DOM identifier for a focus target outside the editor. */
  id?: string;
  /** Accessible name for the editor control. */
  ariaLabel?: string;
  /** When false, Ctrl/Cmd+Enter submits and Enter inserts a line break. */
  submitOnEnter?: boolean;
  /** Uses the compact annotation sizing required by selected-text comments. */
  compact?: boolean;
  /** Caps the compact editor content without affecting the full composer. */
  compactMaxHeight?: number;
  /** One 24px line that grows with its content; the composer capsule's cell clips or scrolls it. */
  capsule?: boolean;
  /** When true, intercept navigation keys for popup keyboard handling. */
  isPopupOpen?: boolean;
  /** Called when a navigation key is pressed while popup is open. Returns true if handled. */
  onPopupKeyDown?: (key: string) => boolean;
  /** Points the editor at the slash menu and its highlighted option, so screen readers follow the highlight. */
  slashMenu?: SlashMenuAria;
}

const COMPOSER_MIN_HEIGHT = "56px";
const COMPOSER_MAX_HEIGHT = "30vh";
const COMPACT_EDITOR_MIN_HEIGHT = "2.25rem";
const COMPACT_EDITOR_MIN_HEIGHT_PX = 36;

const EDITOR_THEME = {
  paragraph: `min-h-[${COMPOSER_MIN_HEIGHT}]`,
};

const COMPACT_EDITOR_THEME = {
  paragraph: "min-h-0",
};

// The composer capsule's cell clips or scrolls the draft, so the editor itself only grows.
const CAPSULE_EDITOR_STYLE = { minHeight: "24px" } as const;

type EditorSizing = "compact" | "capsule" | "card";

const PLACEHOLDER_CLASS: Record<EditorSizing, string> = {
  compact: "pointer-events-none absolute left-2 top-2.5 text-sm text-muted",
  capsule: "text-fade pointer-events-none absolute inset-x-0 top-0 whitespace-nowrap text-body text-muted",
  card: "pointer-events-none absolute left-0 top-0 text-body text-muted",
};

function editorSizing(compact: boolean, capsule: boolean): EditorSizing {
  if (compact) return "compact";
  return capsule ? "capsule" : "card";
}

function editorStyle(sizing: EditorSizing, compactMaxHeight: number | undefined) {
  if (sizing === "capsule") return CAPSULE_EDITOR_STYLE;
  return { ...editorHeightStyle(sizing === "compact", compactMaxHeight), overflowY: "auto" as const };
}

function editorHeightStyle(compact: boolean, compactMaxHeight: number | undefined) {
  const maximumCompactHeight = compactMaxHeight === undefined ? undefined : Math.max(0, compactMaxHeight);
  const minimumCompactHeight = maximumCompactHeight === undefined
    ? COMPACT_EDITOR_MIN_HEIGHT
    : Math.min(COMPACT_EDITOR_MIN_HEIGHT_PX, maximumCompactHeight);
  return {
    minHeight: compact ? minimumCompactHeight : COMPOSER_MIN_HEIGHT,
    maxHeight: compact ? maximumCompactHeight ?? COMPOSER_MAX_HEIGHT : COMPOSER_MAX_HEIGHT,
  };
}

/** Internal plugin that exposes the editor instance via ref. */
function EditorRefPlugin({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  return null;
}

/**
 * The composer, by label, that lost focus by being disabled or replaced rather than by the user. A new thread's
 * first message does both: it swaps in the thread's composer, which stays disabled while the thread starts.
 * One element holds focus at a time, so one slot is enough. A pointer press or focus landing anywhere cancels
 * it, so a composer never takes focus from what the user reached for meanwhile.
 */
let pendingFocusReturn: { readonly key: string; readonly listeners: AbortController } | null = null;

function holdFocusReturn(key: string): void {
  releaseFocusReturn();
  const listeners = new AbortController();
  document.addEventListener("focusin", releaseFocusReturn, { capture: true, signal: listeners.signal });
  document.addEventListener("pointerdown", releaseFocusReturn, { capture: true, signal: listeners.signal });
  pendingFocusReturn = { key, listeners };
}

function releaseFocusReturn(): void {
  pendingFocusReturn?.listeners.abort();
  pendingFocusReturn = null;
}

/** Takes back focus held for this composer, unless focus has since gone somewhere else. */
function returnHeldFocus(editor: LexicalEditor, focusKey: string | undefined): void {
  if (!focusKey || pendingFocusReturn?.key !== focusKey) return;
  releaseFocusReturn();
  if (document.activeElement !== null && document.activeElement !== document.body) return;
  // `editor.focus()` alone moves only the selection, which focuses the root in some engines but not all.
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.focus();
}

/** Internal plugin that syncs the editor's editable state with the disabled prop and returns focus lost to it. */
function EditablePlugin({ disabled, focusKey }: { readonly disabled?: boolean; readonly focusKey?: string }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!focusKey) return undefined;
    // Lexical detaches the root while it is still in the page, so it still holds focus here.
    return editor.registerRootListener((root, previous) => {
      if (root === null && previous?.contains(document.activeElement)) holdFocusReturn(focusKey);
    });
  }, [editor, focusKey]);
  useEffect(() => {
    if (disabled) {
      if (focusKey && editor.getRootElement()?.contains(document.activeElement)) holdFocusReturn(focusKey);
      editor.setEditable(false);
      return;
    }
    editor.setEditable(true);
    returnHeldFocus(editor, focusKey);
  }, [editor, disabled, focusKey]);
  return null;
}

// The editor stays a multi-line textbox: aria-expanded is not valid there, but these three are (WAI-ARIA 1.2).
function slashMenuAriaProps(slashMenu: SlashMenuAria | undefined) {
  if (!slashMenu) return {};
  return {
    ariaAutoComplete: "list" as const,
    ariaControls: slashMenu.expanded ? slashMenu.listboxId : undefined,
    ariaActiveDescendant: slashMenu.expanded ? slashMenu.activeOptionId : undefined,
  };
}

/** Rich text composer with inline mention/slash-command chip support. */
export function ComposerEditor({
  onChange,
  onSubmit,
  onMentionTrigger,
  onMentionDismiss,
  isMentionPopupOpen,
  onSlashTrigger,
  onSlashDismiss,
  onInlineSlashCommand,
  editorRef,
  contentEditableRef,
  autoFocus,
  disabled,
  placeholder = "Ask for follow-up changes or attach images",
  id,
  ariaLabel,
  submitOnEnter,
  compact = false,
  compactMaxHeight,
  capsule = false,
  isPopupOpen,
  onPopupKeyDown,
  slashMenu,
}: ComposerEditorProps) {
  const internalRef = useRef<LexicalEditor | null>(null);
  const ref = editorRef ?? internalRef;
  const sizing = editorSizing(compact, capsule);

  const initialConfig = useRef({
    namespace: "McodeComposer",
    theme: sizing === "card" ? EDITOR_THEME : COMPACT_EDITOR_THEME,
    nodes: [MentionNode, SlashCommandNode],
    onError: (error: Error) => {
      console.error("[ComposerEditor]", error);
    },
    editable: true,
  }).current;

  const handleChange = useCallback(
    (_editorState: EditorState, editor: LexicalEditor) => {
      const message = extractComposerMessage(editor);
      onChange(message.text, message.mentions);
    },
    [onChange],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              ref={contentEditableRef}
              autoFocus={autoFocus}
              className={compact
                ? "w-full resize-none bg-transparent px-2 pt-2.5 pb-1.5 text-sm leading-5 text-ink placeholder:text-muted focus:outline-none"
                : "w-full resize-none bg-transparent text-body text-ink placeholder:text-muted focus:outline-none"}
              id={id}
              aria-label={ariaLabel}
              aria-placeholder={placeholder}
              {...slashMenuAriaProps(slashMenu)}
              placeholder={
                <div className={PLACEHOLDER_CLASS[sizing]}>
                  {placeholder}
                </div>
              }
              style={editorStyle(sizing, compactMaxHeight)}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <EditorRefPlugin editorRef={ref} />
        <EditablePlugin disabled={disabled} focusKey={ariaLabel} />
        <MentionPlugin
          onTrigger={onMentionTrigger}
          onDismiss={onMentionDismiss}
          isPopupOpen={isMentionPopupOpen}
        />
        <SlashCommandPlugin
          onTrigger={onSlashTrigger}
          onDismiss={onSlashDismiss}
          onInlineCommand={onInlineSlashCommand}
        />
        <KeyboardPlugin
          onSubmit={onSubmit}
          disabled={disabled}
          submitOnEnter={submitOnEnter}
          isPopupOpen={isPopupOpen}
          onPopupKeyDown={onPopupKeyDown}
        />
      </div>
    </LexicalComposer>
  );
}
