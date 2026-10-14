import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { mapPlanCommentMarks, planCommentRowOffset, type PlanCommentMark } from "./plan-comment-marks";

/** Replaces the marks the editor highlights and hangs rows under. */
export const setPlanCommentMarks = StateEffect.define<readonly PlanCommentMark[]>();

/**
 * DOM nodes of the rows CodeMirror lays out under comment lines. CodeMirror
 * owns when they exist; the React layer subscribes and portals into them.
 */
export class PlanCommentHosts {
  private hosts: ReadonlyMap<string, HTMLElement> = new Map();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReadonlyMap<string, HTMLElement> => this.hosts;

  register(id: string, element: HTMLElement): void {
    this.hosts = new Map(this.hosts).set(id, element);
    this.emit();
  }

  unregister(id: string, element: HTMLElement): void {
    if (this.hosts.get(id) !== element) return;
    const next = new Map(this.hosts);
    next.delete(id);
    this.hosts = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

class RowHostWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly hosts: PlanCommentHosts,
  ) {
    super();
  }

  override eq(other: RowHostWidget): boolean {
    return other.id === this.id && other.hosts === this.hosts;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-plan-comment-host";
    element.dataset.commentId = this.id;
    // Registered after CodeMirror attaches the node, so the portal never targets a detached element.
    queueMicrotask(() => this.hosts.register(this.id, element));
    return element;
  }

  override destroy(dom: HTMLElement): void {
    this.hosts.unregister(this.id, dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const highlight = Decoration.mark({ class: "cm-plan-comment" });

interface MarkState {
  readonly marks: readonly PlanCommentMark[];
  readonly decorations: DecorationSet;
}

function build(marks: readonly PlanCommentMark[], doc: string, hosts: PlanCommentHosts): MarkState {
  const ranges = marks.flatMap((mark) => {
    const row = Decoration.widget({ widget: new RowHostWidget(mark.id, hosts), block: true, side: 1 }).range(
      planCommentRowOffset(doc, mark),
    );
    return mark.range ? [highlight.range(mark.range.from, mark.range.to), row] : [row];
  });
  return { marks, decorations: Decoration.set(ranges, true) };
}

function markField(hosts: PlanCommentHosts): StateField<MarkState> {
  return StateField.define<MarkState>({
    create: (state) => build([], state.doc.toString(), hosts),
    update(value, tr) {
      let replaced: readonly PlanCommentMark[] | undefined;
      for (const effect of tr.effects) if (effect.is(setPlanCommentMarks)) replaced = effect.value;
      if (replaced) return build(replaced, tr.state.doc.toString(), hosts);
      if (!tr.docChanged) return value;
      return build(mapPlanCommentMarks(value.marks, tr.changes), tr.state.doc.toString(), hosts);
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}

const commentTheme = EditorView.baseTheme({
  ".cm-plan-comment": {
    backgroundColor: "var(--color-selected)",
    borderBottom: "1px solid var(--color-muted)",
  },
});

/** Options for {@link planCommentExtension}. */
export interface PlanCommentExtensionOptions {
  readonly hosts: PlanCommentHosts;
  /** Called on pointer-up with the non-empty selection, in document offsets. */
  readonly onSelect: (from: number, to: number) => void;
}

/** What {@link planCommentExtension} returns. */
export interface PlanCommentExtension {
  readonly extension: Extension;
  /** The marks as the editor currently places them, after edits since they were set. */
  readonly readMarks: (view: EditorView) => readonly PlanCommentMark[];
}

/** The comment field and its pointer-up selection trigger. */
export function planCommentExtension({ hosts, onSelect }: PlanCommentExtensionOptions): PlanCommentExtension {
  const field = markField(hosts);
  const trigger = EditorView.domEventHandlers({
    mouseup: (event, view) => {
      // A click inside a comment row leaves the old editor selection standing.
      if (event.target instanceof Element && event.target.closest(".cm-plan-comment-host")) return;
      // CodeMirror commits the drag selection after this handler, so read it a tick later.
      queueMicrotask(() => {
        const { from, to } = view.state.selection.main;
        if (from !== to) onSelect(from, to);
      });
    },
  });
  return { extension: [field, commentTheme, trigger], readMarks: (view) => view.state.field(field).marks };
}

/** A comment extension plus the handles the React layer needs, created once per Plan panel. */
export interface PlanCommentBinding extends PlanCommentExtension {
  readonly hosts: PlanCommentHosts;
  /** Set by the layer; the extension calls it through this indirection so the editor is built once. */
  readonly onSelect: { current: (from: number, to: number) => void };
}

/** Creates the comment extension and its host registry. */
export function createPlanCommentBinding(): PlanCommentBinding {
  const hosts = new PlanCommentHosts();
  const onSelect = { current: (_from: number, _to: number) => {} };
  return { hosts, onSelect, ...planCommentExtension({ hosts, onSelect: (from, to) => onSelect.current(from, to) }) };
}
