import { createVList, type PluginContext, type VList } from "vlist";

/** A stable row identity and its provisional height. */
export type VirtualRow = {
  readonly id: string;
  readonly height: number;
};

/** A React-owned host inside a vlist-owned row wrapper. */
export interface VirtualHost {
  readonly id: string;
  readonly element: HTMLDivElement;
}

/** Reading positions use row identity so prepends cannot change their meaning. */
export type ViewportPosition =
  | { readonly kind: "offset"; readonly top: number }
  | { readonly kind: "end" }
  | { readonly kind: "reading"; readonly key: string; readonly offset: number }
  | { readonly kind: "target"; readonly key: string; readonly align: "start" | "center" };

/** Configuration for a measured list, independent of any feature's scroll policy. */
export interface VirtualViewportOptions {
  readonly classPrefix?: string;
  readonly ariaLabel: string;
  readonly initialPosition?: ViewportPosition;
  readonly positionOnScroll?: (anchor: ViewportPosition, atEnd: boolean) => ViewportPosition;
}

/** Owns virtual rows, continuous measurement, and one explicit scroll position. */
export class VirtualViewport {
  readonly viewport: HTMLElement;
  private readonly list: VList<VirtualRow>;
  private context!: PluginContext<VirtualRow>;
  private rows: readonly VirtualRow[] = [];
  private readonly hosts = new Map<string, HTMLDivElement>();
  private publishedHosts: readonly VirtualHost[] = [];
  private readonly heights = new Map<string, number>();
  private readonly rowIndexes = new Map<string, number>();
  private readonly observer: ResizeObserver;
  private position: ViewportPosition;
  private readonly prefix: string;
  private expectedScrollTop = 0;
  private disposed = false;
  private animating = false;

  constructor(
    container: HTMLElement,
    private readonly publish: (hosts: readonly VirtualHost[]) => void,
    private readonly onPosition: (position: ViewportPosition) => void,
    private readonly options: VirtualViewportOptions,
  ) {
    this.prefix = options.classPrefix ?? "virtual";
    this.position = options.initialPosition ?? { kind: "offset", top: 0 };
    this.observer = new ResizeObserver((entries) => this.measure(entries));
    this.list = createVList<VirtualRow>({
      container,
      classPrefix: this.prefix,
      ariaLabel: options.ariaLabel,
      overscan: 8,
      scroll: { wheel: false },
      item: {
        height: (index) => {
          const row = this.rows[index];
          return row ? this.heights.get(row.id) ?? row.height : 80;
        },
        template: (row) => this.host(row.id),
      },
    }, [{
      name: "react-hosts",
      setup: (context) => {
        this.context = context;
        context.setScrollFns(
          () => context.dom.viewport.scrollTop,
          (top) => {
            const viewport = context.dom.viewport;
            const maximum = Math.max(0, context.sizeCache.getTotalSize() - viewport.clientHeight);
            viewport.scrollTop = Math.min(maximum, Math.max(0, top));
            // Native scroll events arrive after the synchronous row calculation.
            context.getState().scrollPosition = viewport.scrollTop;
            this.expectedScrollTop = viewport.scrollTop;
          },
        );
      },
      hooks: {
        onCommit: () => this.publishVisible(),
        onResize: () => this.applyPosition(),
      },
    }]);
    this.viewport = this.context.dom.viewport;
    this.viewport.dataset.testid = `${this.prefix}-viewport`;
    this.viewport.classList.add("overflow-y-auto");
    this.list.element.style.cssText = "height:100%;position:relative;overflow:hidden";
    this.viewport.style.cssText = "height:100%;overflow:auto;overflow-anchor:none";
    this.context.dom.content.style.position = "relative";
    this.context.dom.liveRegion.style.display = "none";
    this.viewport.addEventListener("scroll", this.onScroll, { passive: true });
    this.viewport.addEventListener("wheel", this.onWheel, { passive: true });
    this.viewport.addEventListener("touchstart", this.interrupt, { passive: true });
    this.viewport.addEventListener("pointerdown", this.onPointerDown);
    this.viewport.addEventListener("keydown", this.onKeyDown);
  }

  private host(id: string): HTMLDivElement {
    const existing = this.hosts.get(id);
    if (existing) return existing;
    const element = document.createElement("div");
    element.setAttribute(`data-${this.prefix}-key`, id);
    element.style.display = "flow-root";
    this.hosts.set(id, element);
    this.observer.observe(element);
    return element;
  }

  private publishVisible(): void {
    const state = this.context.getState();
    const visible: VirtualHost[] = [];
    for (let slot = 0; slot < state.visibleCount; slot += 1) {
      const row = this.rows[state.visibleIndices[slot]];
      const element = row && this.hosts.get(row.id);
      const wrapper = this.context.getRenderedElement(state.visibleIndices[slot]);
      if (wrapper) {
        wrapper.style.position = "absolute";
        wrapper.style.top = "0";
        wrapper.style.left = "0";
        wrapper.style.width = "100%";
      }
      if (element) visible.push({ id: row.id, element });
    }
    if (visible.length === this.publishedHosts.length && visible.every((host, index) =>
      host.id === this.publishedHosts[index].id && host.element === this.publishedHosts[index].element)) return;
    this.publishedHosts = visible;
    this.publish(visible);
  }

  /** Reconciles identities without replacing React content on streaming updates. */
  setRows(rows: readonly VirtualRow[]): void {
    const focused = document.activeElement;
    const restoreFocus = focused instanceof HTMLElement && this.viewport.contains(focused);
    const previous = new Map(this.rows.map((row) => [row.id, row]));
    this.rows = rows.map((row) => previous.get(row.id) ?? row);
    this.rowIndexes.clear();
    this.rows.forEach((row, index) => this.rowIndexes.set(row.id, index));
    for (const key of this.heights.keys()) {
      if (!this.rowIndexes.has(key)) this.heights.delete(key);
    }
    this.list.setItems([...this.rows]);
    this.applyPosition();
    if (restoreFocus && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }

  /** Releases detached hosts only after React has removed their portals. */
  releaseHosts(visible: readonly VirtualHost[]): void {
    const retained = new Set(visible.map((host) => host.id));
    for (const [id, element] of this.hosts) {
      if (retained.has(id) || element.isConnected) continue;
      this.observer.unobserve(element);
      this.hosts.delete(id);
    }
  }

  private measure(entries: readonly ResizeObserverEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      if (this.updateHeight(entry)) changed = true;
    }
    if (!changed || this.disposed) return;
    this.context.rebuildSizeCache();
    this.context.updateContentSize(this.context.sizeCache.getTotalSize());
    this.applyPosition();
  }

  private updateHeight(entry: ResizeObserverEntry): boolean {
    if (!(entry.target instanceof HTMLElement)) return false;
    const key = entry.target.getAttribute(`data-${this.prefix}-key`);
    const height = entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
    if (!key || !this.rowIndexes.has(key) || height <= 0 || this.heights.get(key) === height) return false;
    this.heights.set(key, height);
    return true;
  }

  private applyPosition(): void {
    if (this.disposed || !this.viewport) return;
    if (!this.animating) this.context.scrollTo(Math.max(0, this.targetScrollTop()));
    this.expectedScrollTop = this.viewport.scrollTop;
    this.context.forceRender();
    this.onPosition(this.position);
  }

  private targetScrollTop(): number {
    const cache = this.context.sizeCache;
    let top = this.viewport.scrollTop;
    if (this.position.kind === "offset") {
      top = this.position.top;
    } else if (this.position.kind === "end") {
      top = cache.getTotalSize() - this.viewport.clientHeight;
    } else {
      const index = this.rowIndexes.get(this.position.key);
      if (index !== undefined) {
        top = cache.getOffset(index);
        top += this.position.kind === "reading"
          ? this.position.offset
          : this.position.align === "center"
            ? (cache.getSize(index) - this.viewport.clientHeight) / 2
            : 0;
      }
    }
    return top;
  }

  private readingPosition(): ViewportPosition {
    const top = this.viewport.scrollTop;
    const index = this.context.sizeCache.indexAtOffset(top);
    const row = this.rows[index];
    return row
      ? { kind: "reading", key: row.id, offset: top - this.context.sizeCache.getOffset(index) }
      : { kind: "offset", top };
  }

  private readonly interrupt = (): void => {
    this.context.cancelScroll();
    this.animating = false;
    this.position = this.readingPosition();
    this.onPosition(this.position);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0 || event.deltaY !== 0 && this.animating) this.interrupt();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, button, [contenteditable=true]")) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      this.interrupt();
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target === this.viewport) this.interrupt();
  };

  private readonly onScroll = (): void => {
    const top = this.viewport.scrollTop;
    if (Math.abs(top - this.expectedScrollTop) < 1) return;
    const atEnd = this.viewport.scrollHeight - this.viewport.clientHeight - top <= 2;
    const anchor = this.readingPosition();
    this.position = this.options.positionOnScroll?.(anchor, atEnd) ?? anchor;
    this.expectedScrollTop = top;
    this.onPosition(this.position);
  };

  /** Captures the first visible row independently of React's commit timing. */
  getReadingAnchor(): { key: string; offset: number } | undefined {
    const position = this.readingPosition();
    return position.kind === "reading" ? { key: position.key, offset: position.offset } : undefined;
  }

  /** Restores an anchor, follows the end, or keeps a navigation target centered. */
  moveTo(position: ViewportPosition, smooth = false): void {
    this.context.cancelScroll();
    this.position = position;
    this.animating = smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (this.animating) {
      this.context.smoothScrollTo(() => Math.max(0, this.targetScrollTop()), 250, undefined, () => {
        this.animating = false;
        this.applyPosition();
      });
    }
    this.applyPosition();
  }

  /** Restores an absolute offset and captures its row anchor. */
  restoreOffset(top: number): void {
    this.context.scrollTo(top);
    this.position = this.readingPosition();
    this.applyPosition();
  }

  /** Compensates for a layout inset changing the viewport's screen position. */
  shiftReadingPosition(delta: number): void {
    if (this.position.kind !== "reading" || delta === 0) return;
    this.position = { ...this.position, offset: this.position.offset + delta };
    this.applyPosition();
  }

  /** Returns a row's measured or estimated top in viewport coordinates. */
  rowTop(key: string): number | undefined {
    const index = this.rowIndexes.get(key);
    return index === undefined ? undefined : this.context.sizeCache.getOffset(index) - this.viewport.scrollTop;
  }

  /** Returns a row's measured or estimated bottom in viewport coordinates. */
  rowBottom(key: string): number | undefined {
    const index = this.rowIndexes.get(key);
    return index === undefined ? undefined
      : this.context.sizeCache.getOffset(index) + this.context.sizeCache.getSize(index) - this.viewport.scrollTop;
  }

  /** Disconnects observers and input handlers before releasing the list. */
  destroy(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.viewport.removeEventListener("wheel", this.onWheel);
    this.viewport.removeEventListener("touchstart", this.interrupt);
    this.viewport.removeEventListener("pointerdown", this.onPointerDown);
    this.viewport.removeEventListener("keydown", this.onKeyDown);
    this.list.destroy();
    this.hosts.clear();
    this.publishedHosts = [];
  }
}
