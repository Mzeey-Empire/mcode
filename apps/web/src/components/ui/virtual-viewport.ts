import { createVList, type PluginContext, type VList } from "vlist";
import { prefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

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

/** Scroller space covered by floating chrome at each end. */
export interface ViewportInsets {
  readonly top: number;
  readonly bottom: number;
}

/** Configuration for a measured list, independent of any feature's scroll policy. */
export interface VirtualViewportOptions {
  readonly classPrefix?: string;
  readonly ariaLabel: string;
  readonly initialPosition?: ViewportPosition;
  readonly positionOnScroll?: (anchor: ViewportPosition, atEnd: boolean) => ViewportPosition;
  /**
   * Row id rendered in normal flow between size-cache spacers instead of a recycled wrapper, so it
   * can be sticky. Callers list it as an ordinary row and portal into {@link VirtualViewport.flowHost}.
   */
  readonly flowHostId?: string;
}

/** Options for {@link VirtualViewport.setRows}. */
export interface SetRowsOptions {
  /**
   * Slide hosts that stay visible from their old offset to their new one. Hosts entering view do
   * not animate, and reduced motion animates nothing.
   */
  readonly flip?: boolean;
}

// DESIGN.md motion tokens: standard duration and the one ease curve.
const FLIP_DURATION_MS = 180;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

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
  private pinnedAnchor: { key: string; top: number } | undefined;
  private insets: ViewportInsets = { top: 0, bottom: 0 };
  private flow: { prefix: HTMLDivElement; host: HTMLDivElement; suffix: HTMLDivElement } | undefined;
  private flowFill = 0;
  private readonly layoutListeners = new Set<() => void>();
  private layoutFramePending = false;

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
          if (!row) return 80;
          const height = this.heights.get(row.id) ?? row.height;
          return row.id === this.options.flowHostId ? height + this.flowFill : height;
        },
        template: () => "",
      },
    }, [{
      name: "react-hosts",
      setup: (context) => {
        this.context = context;
        context.setScrollFns(
          () => context.dom.viewport.scrollTop,
          (top) => {
            const viewport = context.dom.viewport;
            const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
            viewport.scrollTop = Math.min(maximum, Math.max(0, top));
            // Native scroll events arrive after the synchronous row calculation.
            context.getState().scrollPosition = viewport.scrollTop;
            this.expectedScrollTop = viewport.scrollTop;
          },
        );
      },
      hooks: {
        onCommit: () => this.publishVisible(),
        onResize: () => this.applyPosition(true),
      },
    }]);
    this.viewport = this.context.dom.viewport;
    this.viewport.dataset.testid = `${this.prefix}-viewport`;
    this.viewport.classList.add("overflow-y-auto");
    this.list.element.style.cssText = "height:100%;position:relative;overflow:hidden";
    this.viewport.style.cssText = "height:100%;overflow:auto;overflow-anchor:none";
    this.context.dom.content.style.position = "relative";
    this.context.dom.liveRegion.style.display = "none";
    if (options.flowHostId !== undefined) this.mountFlowHost(options.flowHostId);
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

  // vlist removes only wrappers it tracks and skips content children without data-index, so these
  // three nodes survive recycling. The host's own index keeps an empty wrapper that reserves its slot.
  private mountFlowHost(id: string): void {
    const prefix = document.createElement("div");
    const suffix = document.createElement("div");
    const host = this.host(id);
    host.style.position = "sticky";
    host.style.bottom = "0";
    // vlist appends absolute wrappers after the host, which would otherwise paint over it.
    host.style.zIndex = "1";
    this.context.dom.content.prepend(prefix, host, suffix);
    this.flow = { prefix, host, suffix };
  }

  /** The persistent sticky host element, when `flowHostId` was configured. */
  get flowHost(): HTMLDivElement | undefined {
    return this.flow?.host;
  }

  /** Visible height of the scroller, for chrome that tracks a row. */
  get clientHeight(): number {
    return this.viewport.clientHeight;
  }

  // Resized in the same pass as the content size, so the host never shows a frame off its slot.
  private layoutFlowHost(): void {
    if (!this.flow || this.options.flowHostId === undefined) return;
    const index = this.rowIndexes.get(this.options.flowHostId);
    const { prefix, host, suffix } = this.flow;
    const display = index === undefined ? "none" : "";
    host.style.display = index === undefined ? "none" : "flow-root";
    prefix.style.display = display;
    suffix.style.display = display;
    if (index === undefined) return;
    const cache = this.context.sizeCache;
    const offset = cache.getOffset(index);
    const size = cache.getSize(index);
    prefix.style.height = `${offset}px`;
    suffix.style.height = `${Math.max(0, cache.getTotalSize() - offset - size)}px`;
  }

  /**
   * Calls `listener` after commits, scroll frames and measured resizes, at most once per frame,
   * so chrome can read `rowTop` and `rowBottom` without its own scroll listener. Returns an unsubscribe.
   */
  onLayout(listener: () => void): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  private scheduleLayout(): void {
    if (this.layoutListeners.size === 0 || this.layoutFramePending) return;
    this.layoutFramePending = true;
    requestAnimationFrame(() => {
      this.layoutFramePending = false;
      if (this.disposed) return;
      for (const listener of this.layoutListeners) listener();
    });
  }

  private publishedOffsets(): Map<string, number> {
    const offsets = new Map<string, number>();
    for (const { id } of this.publishedHosts) {
      const index = this.rowIndexes.get(id);
      if (index !== undefined) offsets.set(id, this.context.sizeCache.getOffset(index));
    }
    return offsets;
  }

  // Animates the React-owned host, never vlist's wrapper, whose transform vlist owns.
  private playFlip(before: ReadonlyMap<string, number>): void {
    for (const { id, element } of this.publishedHosts) {
      const from = before.get(id);
      const index = this.rowIndexes.get(id);
      if (from === undefined || index === undefined || typeof element.animate !== "function") continue;
      const delta = from - this.context.sizeCache.getOffset(index);
      if (delta === 0) continue;
      element.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
      );
    }
  }

  private publishVisible(): void {
    const state = this.context.getState();
    const visible: VirtualHost[] = [];
    for (let slot = 0; slot < state.visibleCount; slot += 1) {
      const row = this.rows[state.visibleIndices[slot]];
      const wrapper = this.context.getRenderedElement(state.visibleIndices[slot]);
      if (!row || !wrapper) continue;
      // The flow host's empty wrapper too: left in flow, it stacks below the prefix and suffix that
      // already span the list, then its transform pushes it down again, doubling the scroll height.
      wrapper.style.position = "absolute";
      wrapper.style.top = "0";
      wrapper.style.left = "0";
      wrapper.style.width = "100%";
      if (row.id === this.options.flowHostId) continue;
      const element = this.host(row.id);
      // Reconcile keyed hosts after vlist finishes recycling its index-based wrappers.
      if (element.parentElement !== wrapper) wrapper.replaceChildren(element);
      visible.push({ id: row.id, element });
    }
    if (visible.length === this.publishedHosts.length && visible.every((host, index) =>
      host.id === this.publishedHosts[index].id && host.element === this.publishedHosts[index].element)) return;
    this.publishedHosts = visible;
    this.publish(visible);
  }

  /** Reconciles identities without replacing React content on streaming updates. */
  setRows(rows: readonly VirtualRow[], options: SetRowsOptions = {}): void {
    const before = options.flip && !prefersReducedMotion() ? this.publishedOffsets() : undefined;
    const focused = document.activeElement;
    const restoreFocus = focused instanceof HTMLElement && this.viewport.contains(focused);
    this.reconcileRows(rows);
    this.list.setItems([...this.rows]);
    this.applyPosition(true);
    if (before) this.playFlip(before);
    if (restoreFocus && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }

  private reconcileRows(rows: readonly VirtualRow[]): void {
    const previous = new Map(this.rows.map((row) => [row.id, row]));
    this.rows = rows.map((row) => previous.get(row.id) ?? row);
    this.rowIndexes.clear();
    this.rows.forEach((row, index) => this.rowIndexes.set(row.id, index));
    for (const key of this.heights.keys()) {
      if (!this.rowIndexes.has(key)) this.heights.delete(key);
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

  private measurePending = false;

  private measure(entries: readonly ResizeObserverEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      if (this.updateHeight(entry)) changed = true;
    }
    if (!changed || this.disposed || this.measurePending) return;
    // Applying sizes inside the observer callback resizes observed rows and
    // re-triggers delivery in the same frame ("ResizeObserver loop" errors).
    // Deferring to rAF matches the browser's own deferral without the warning.
    this.measurePending = true;
    requestAnimationFrame(() => {
      this.measurePending = false;
      if (this.disposed) return;
      this.context.rebuildSizeCache();
      this.context.updateContentSize(this.context.sizeCache.getTotalSize());
      this.applyPosition(true);
    });
  }

  private updateHeight(entry: ResizeObserverEntry): boolean {
    if (!(entry.target instanceof HTMLElement)) return false;
    const key = entry.target.getAttribute(`data-${this.prefix}-key`);
    const height = entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
    // The fill is padding the host carries, not content, so the cache keeps the natural height.
    const natural = key === this.options.flowHostId ? height - this.flowFill : height;
    if (!key || !this.rowIndexes.has(key) || natural <= 0 || this.heights.get(key) === natural) return false;
    this.heights.set(key, natural);
    return true;
  }

  // Sticky only lifts a host that would fall below the bottom edge, so a short list pads above the
  // host until the host and every row after it end on that edge. Computed from the total without
  // the current fill, the fill cannot feed back into itself.
  private fitFlowFill(): void {
    if (!this.flow || this.options.flowHostId === undefined) return;
    const natural = this.context.sizeCache.getTotalSize() - this.flowFill;
    const available = this.viewport.clientHeight - this.insets.top - this.insets.bottom;
    const fill = this.rowIndexes.has(this.options.flowHostId) ? Math.max(0, available - natural) : 0;
    if (fill === this.flowFill) return;
    this.flowFill = fill;
    this.flow.host.style.paddingTop = `${fill}px`;
    this.context.rebuildSizeCache();
  }

  private applyPosition(correctAnchor = false): void {
    if (this.disposed || !this.viewport) return;
    this.fitFlowFill();
    const anchor = correctAnchor ? this.readingAnchorHost() : undefined;
    const target = Math.max(0, this.targetScrollTop());
    // A short initial page needs its trailing space retained when history is prepended.
    this.context.updateContentSize(Math.max(
      this.context.sizeCache.getTotalSize(),
      this.position.kind === "reading" ? target + this.viewport.clientHeight - this.insets.top - this.insets.bottom : 0,
    ));
    if (!this.animating) {
      this.context.scrollTo(target);
      this.correctAnchorDrift(anchor);
    }
    this.expectedScrollTop = this.viewport.scrollTop;
    this.context.forceRender();
    this.layoutFlowHost();
    this.scheduleLayout();
    this.onPosition(this.position);
  }

  /** The reading row's live host plus the screen position it must keep. */
  private readingAnchorHost(): { host: HTMLDivElement; top: number } | undefined {
    if (this.position.kind !== "reading") return undefined;
    const host = this.hosts.get(this.position.key);
    // Content changes push the anchored row between measurement passes, so the
    // pin must come from the user's last scroll, not the current drifted rect.
    const pinned = this.pinnedAnchor;
    const top = pinned?.key === this.position.key
      ? pinned.top
      : host?.isConnected ? host.getBoundingClientRect().top : undefined;
    return host && top !== undefined ? { host, top } : undefined;
  }

  /** Sizes resolve through provisional heights; the host's real rect is truth. */
  private correctAnchorDrift(anchor: { host: HTMLDivElement; top: number } | undefined): void {
    if (!anchor?.host.isConnected) return;
    const drift = anchor.host.getBoundingClientRect().top - anchor.top;
    if (drift !== 0) this.viewport.scrollTop += drift;
  }

  private targetScrollTop(): number {
    const cache = this.context.sizeCache;
    const { top: insetTop, bottom: insetBottom } = this.insets;
    const height = this.viewport.clientHeight;
    if (this.position.kind === "offset") return this.position.top;
    if (this.position.kind === "end") return insetTop + cache.getTotalSize() + insetBottom - height;
    const index = this.rowIndexes.get(this.position.key);
    if (index === undefined) return this.viewport.scrollTop;
    const offset = cache.getOffset(index);
    if (this.position.kind === "reading") return offset + this.position.offset;
    return this.position.align === "center"
      ? offset + (insetTop + cache.getSize(index) + insetBottom - height) / 2
      : offset;
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
    this.pinReadingAnchor();
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
    this.scheduleLayout();
    const top = this.viewport.scrollTop;
    if (Math.abs(top - this.expectedScrollTop) < 1) return;
    const atEnd = this.viewport.scrollHeight - this.viewport.clientHeight - top <= 2;
    const anchor = this.readingPosition();
    this.position = this.options.positionOnScroll?.(anchor, atEnd) ?? anchor;
    this.pinReadingAnchor();
    this.expectedScrollTop = top;
    this.onPosition(this.position);
  };

  private pinReadingAnchor(): void {
    const host = this.position.kind === "reading" ? this.hosts.get(this.position.key) : undefined;
    this.pinnedAnchor = this.position.kind === "reading" && host?.isConnected
      ? { key: this.position.key, top: host.getBoundingClientRect().top }
      : undefined;
  }

  /** Captures the first visible row independently of React's commit timing. */
  getReadingAnchor(): { key: string; offset: number } | undefined {
    const position = this.readingPosition();
    return position.kind === "reading" ? { key: position.key, offset: position.offset } : undefined;
  }

  /** Restores an anchor, follows the end, or keeps a navigation target centered. */
  moveTo(position: ViewportPosition, smooth = false): void {
    this.context.cancelScroll();
    this.position = position;
    this.animating = smooth && !prefersReducedMotion();
    if (this.animating) {
      this.context.smoothScrollTo(() => Math.max(0, this.targetScrollTop()), 250, undefined, () => {
        this.animating = false;
        this.applyPosition();
        this.pinReadingAnchor();
      });
    }
    this.applyPosition();
    this.pinReadingAnchor();
  }

  /** Restores an absolute offset and captures its row anchor. */
  restoreOffset(top: number): void {
    this.context.scrollTo(top);
    this.position = this.readingPosition();
    this.applyPosition();
    this.pinReadingAnchor();
  }

  /**
   * Pads the scroller so rows pass under floating chrome mid-scroll but rest clear of it at either end.
   * Reading offsets and row edges are measured from the top inset's edge, so a reading row follows the
   * chrome when it resizes. vlist still sizes its range from the raw scrollTop, so rows behind the top
   * inset render through overscan.
   */
  setInsets(insets: ViewportInsets): void {
    const shift = insets.top - this.insets.top;
    if (shift === 0 && insets.bottom === this.insets.bottom) return;
    this.insets = insets;
    this.viewport.style.paddingTop = `${insets.top}px`;
    this.viewport.style.paddingBottom = `${insets.bottom}px`;
    if (this.pinnedAnchor) this.pinnedAnchor = { ...this.pinnedAnchor, top: this.pinnedAnchor.top + shift };
    this.applyPosition();
  }

  /** Returns a row's measured or estimated top, measured from the top inset's edge. */
  rowTop(key: string): number | undefined {
    const index = this.rowIndexes.get(key);
    return index === undefined ? undefined : this.context.sizeCache.getOffset(index) - this.viewport.scrollTop;
  }

  /** Returns a row's measured or estimated bottom, measured from the top inset's edge. */
  rowBottom(key: string): number | undefined {
    const index = this.rowIndexes.get(key);
    return index === undefined ? undefined
      : this.context.sizeCache.getOffset(index) + this.context.sizeCache.getSize(index) - this.viewport.scrollTop;
  }

  /** Disconnects observers and input handlers before releasing the list. */
  destroy(): void {
    this.disposed = true;
    this.layoutListeners.clear();
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
