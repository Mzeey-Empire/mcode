/**
 * A jsdom stand-in for `VirtualViewport`: jsdom has no layout, so it publishes a host element for
 * every row in order and records each published id list for assertions.
 */
export class FakeVirtualViewport {
  /** Every id list passed to `setRows`, oldest first. */
  static readonly published: string[][] = [];
  /** Whether each `setRows` call asked for a FLIP, parallel to `published`. */
  static readonly flips: boolean[] = [];
  /** The most recently constructed viewport. */
  static latest: FakeVirtualViewport | undefined;
  readonly viewport: HTMLElement;
  readonly flowHost: HTMLDivElement | undefined;
  private readonly flowHostId: string | undefined;
  private readonly hosts = new Map<string, HTMLDivElement>();

  constructor(
    container: HTMLElement,
    private readonly publish: (hosts: ReadonlyArray<{ id: string; element: HTMLDivElement }>) => void,
    _onPosition: (position: unknown) => void,
    options: { classPrefix?: string; flowHostId?: string },
  ) {
    this.viewport = document.createElement("div");
    this.viewport.dataset.testid = `${options.classPrefix ?? "virtual"}-viewport`;
    container.append(this.viewport);
    FakeVirtualViewport.latest = this;
    this.flowHostId = options.flowHostId;
    if (options.flowHostId === undefined) return;
    this.flowHost = document.createElement("div");
    this.viewport.append(this.flowHost);
  }

  setRows(rows: ReadonlyArray<{ id: string }>, options?: { flip?: boolean }): void {
    FakeVirtualViewport.published.push(rows.map((row) => row.id));
    FakeVirtualViewport.flips.push(options?.flip === true);
    const live = new Set(rows.map((row) => row.id));
    for (const [id, element] of this.hosts) {
      if (live.has(id)) continue;
      element.remove();
      this.hosts.delete(id);
    }
    // Like the real viewport, the flow host row is never published; callers portal into it.
    const hosts = rows.filter((row) => row.id !== this.flowHostId).map((row) => ({ id: row.id, element: this.hostFor(row.id) }));
    // DOM order stands in for the real viewport's offsets, so a reorder must move the hosts.
    this.viewport.append(...hosts.map((host) => host.element));
    this.publish(hosts);
  }

  private hostFor(id: string): HTMLDivElement {
    const existing = this.hosts.get(id);
    if (existing) return existing;
    const element = document.createElement("div");
    this.viewport.append(element);
    this.hosts.set(id, element);
    return element;
  }

  // jsdom has no layout: nothing scrolls, so chrome that tracks rows sees an empty scroller.
  readonly clientHeight = 0;
  onLayout(): () => void {
    return () => {};
  }
  releaseHosts(): void {}
  getReadingAnchor(): undefined {
    return undefined;
  }
  /** Every `moveTo` call, oldest first. */
  readonly moves: Array<{ position: unknown; smooth: boolean | undefined }> = [];
  moveTo(position: unknown, smooth?: boolean): void {
    this.moves.push({ position, smooth });
  }
  restoreOffset(top: number): void {
    this.viewport.scrollTop = top;
  }
  rowTop(): undefined {
    return undefined;
  }
  rowBottom(): undefined {
    return undefined;
  }
  destroy(): void {
    this.viewport.remove();
    this.hosts.clear();
  }
}
