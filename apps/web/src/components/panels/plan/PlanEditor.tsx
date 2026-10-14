import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  PLAN_EDITOR_CLASS,
  planEditorDecorations,
  visibleDecorations,
  type PlanDecorationRange,
  type PlanLineSpan,
} from "./plan-editor-decorations";
import { evaluateWhen } from "@/lib/context-tracker";

const hiddenMark = Decoration.replace({});

class TrailingTextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
  ) {
    super();
  }

  override eq(other: TrailingTextWidget): boolean {
    return other.text === this.text && other.className === this.className;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }
}

function toDecoration(range: PlanDecorationRange) {
  switch (range.kind) {
    case "line":
      return Decoration.line({ class: range.className }).range(range.from);
    case "mark":
      return Decoration.mark({ class: range.className }).range(range.from, range.to);
    case "hide":
      return hiddenMark.range(range.from, range.to);
    case "widget":
      return Decoration.widget({ widget: new TrailingTextWidget(range.text, range.className), side: 1 }).range(range.from);
  }
}

// Lines holding a selection, while the editor has focus, show raw markdown.
function focusedLines(view: EditorView): PlanLineSpan[] {
  if (!view.hasFocus) return [];
  const { doc } = view.state;
  return view.state.selection.ranges.map((range) => ({ from: doc.lineAt(range.from).from, to: doc.lineAt(range.to).to }));
}

// A plugin rather than a state field because focus lives on the view. The
// parse only reruns when the document changes.
const planDecorations = ViewPlugin.fromClass(
  class {
    ranges: readonly PlanDecorationRange[];
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.ranges = planEditorDecorations(view.state.doc.toString());
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.ranges = planEditorDecorations(update.state.doc.toString());
      if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view);
    }

    build(view: EditorView): DecorationSet {
      return Decoration.set(visibleDecorations(this.ranges, focusedLines(view)).map(toDecoration), true);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Claiming the key inserts no line break; the document shortcut handler still
// sees the event and runs Implement.
const implementKey = Prec.highest(keymap.of([{ key: "Mod-Shift-Enter", run: () => evaluateWhen("planImplementable") }]));

const planTheme = EditorView.theme({
  "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", fontSize: "1.4rem", lineHeight: "2rem" },
  ".cm-content": { padding: "0.8rem 2.4rem 2.4rem", caretColor: "var(--color-ink)" },
  ".cm-line": { padding: "0" },
  [`.${PLAN_EDITOR_CLASS.title}`]: {
    fontSize: "2.4rem",
    lineHeight: "3.2rem",
    fontWeight: "600",
    letterSpacing: "-0.01em",
    color: "var(--color-ink)",
  },
  [`.${PLAN_EDITOR_CLASS.summary}`]: { color: "var(--color-muted)" },
  [`.${PLAN_EDITOR_CLASS.label}`]: { fontSize: "1.2rem", lineHeight: "1.6rem", color: "var(--color-muted)" },
  [`.${PLAN_EDITOR_CLASS.listMarker}`]: {
    display: "inline-block",
    width: "2rem",
    fontFamily: "var(--font-mono)",
    fontSize: "1.2rem",
    lineHeight: "2rem",
    color: "var(--color-muted)",
  },
  [`.${PLAN_EDITOR_CLASS.code}`]: { fontFamily: "var(--font-mono)" },
  [`.${PLAN_EDITOR_CLASS.pathName}`]: { fontFamily: "var(--font-mono)", fontWeight: "600", color: "var(--color-ink)" },
  [`.${PLAN_EDITOR_CLASS.pathFolder}`]: {
    marginLeft: "0.8rem",
    fontFamily: "var(--font-mono)",
    color: "var(--color-muted)",
  },
});

// Marks store-driven document replacements so they are not reported as edits.
const externalSync = Annotation.define<boolean>();

function editability(editable: boolean): Extension {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

/** Props for {@link PlanEditor}. */
interface PlanEditorProps {
  /** Markdown the editor shows. A change replaces the document. */
  readonly contentMd: string;
  readonly editable: boolean;
  /** Receives the full document after each user edit. */
  readonly onChange?: (text: string) => void;
  readonly onBlur?: () => void;
  /** Extra extensions, fixed for the life of the editor. */
  readonly extensions?: Extension;
  /** Receives the view once it exists, and null when it is torn down. */
  readonly onViewChange?: (view: EditorView | null) => void;
}

/**
 * CodeMirror live preview of a plan version. Markdown syntax stays in the
 * document but its marks are hidden, except on the lines being edited.
 */
export function PlanEditor({ contentMd, editable, onChange, onBlur, extensions, onViewChange }: PlanEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableCompartment = useRef(new Compartment()).current;
  const initialRef = useRef({ contentMd, editable });
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const extensionsRef = useRef(extensions);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const listener = EditorView.updateListener.of((update) => {
      const userEdit = update.docChanged && !update.transactions.some((tr) => tr.annotation(externalSync));
      if (userEdit) onChangeRef.current?.(update.state.doc.toString());
      if (update.focusChanged && !update.view.hasFocus) onBlurRef.current?.();
    });
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialRef.current.contentMd,
        extensions: [
          editableCompartment.of(editability(initialRef.current.editable)),
          implementKey,
          EditorView.lineWrapping,
          planDecorations,
          planTheme,
          listener,
          extensionsRef.current ?? [],
        ],
      }),
    });
    viewRef.current = view;
    onViewChangeRef.current?.(view);
    return () => {
      onViewChangeRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [editableCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableCompartment.reconfigure(editability(editable)) });
  }, [editable, editableCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === contentMd) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: contentMd },
      annotations: externalSync.of(true),
    });
  }, [contentMd]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" data-testid="plan-editor" />;
}
