import { useEffect, useRef } from "react";
import { EditorState, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { PLAN_EDITOR_CLASS, planEditorDecorations, type PlanDecorationRange } from "./plan-editor-decorations";

const hiddenMark = Decoration.replace({});

function toDecoration(range: PlanDecorationRange) {
  switch (range.kind) {
    case "line":
      return Decoration.line({ class: range.className }).range(range.from);
    case "mark":
      return Decoration.mark({ class: range.className }).range(range.from, range.to);
    case "hide":
      return hiddenMark.range(range.from, range.to);
  }
}

function buildDecorations(doc: string): DecorationSet {
  return Decoration.set(planEditorDecorations(doc).map(toDecoration), true);
}

const planDecorations = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? buildDecorations(tr.state.doc.toString()) : value),
  provide: (field) => EditorView.decorations.from(field),
});

const planTheme = EditorView.theme({
  "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", fontSize: "1.4rem", lineHeight: "2rem" },
  ".cm-content": { padding: "0.8rem 2.4rem 2.4rem", caretColor: "transparent" },
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
});

const planExtensions = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.lineWrapping,
  planDecorations,
  planTheme,
];

/** Props for {@link PlanEditor}. */
interface PlanEditorProps {
  /** Markdown source of the plan version being read. */
  readonly contentMd: string;
}

/**
 * Read-only CodeMirror view of a plan version. Markdown syntax stays in the
 * document but its marks are hidden, so the text reads as a formatted plan.
 */
export function PlanEditor({ contentMd }: PlanEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialContentRef = useRef(contentMd);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: initialContentRef.current, extensions: planExtensions }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === contentMd) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: contentMd } });
  }, [contentMd]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" data-testid="plan-editor" />;
}
