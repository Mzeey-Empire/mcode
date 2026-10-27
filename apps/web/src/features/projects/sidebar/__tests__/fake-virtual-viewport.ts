/**
 * A jsdom stand-in for `VirtualViewport`: jsdom has no layout, so it publishes a host element for
 * every row in order and records each published id list for assertions.
 */
export class FakeVirtualViewport {
  /** Every id list passed to `setRows`, oldest first. */
  static readonly published: string[][] = [];
  readonly viewport: HTMLElement;
  readonly flowHost = null;
  private readonly hosts = new Map<string, HTMLDivElement>();

  constructor(
    container: HTMLElement,
    private readonly publish: (hosts: ReadonlyArray<{ id: string; element: HTMLDivElement }>) => void,
    _onPosition: (position: unknown) => void,
    options: { classPrefix?: string },
  ) {
    this.viewport = document.createElement("div");
    this.viewport.dataset.testid = `${options.classPrefix ?? "virtual"}-viewport`;
    container.append(this.viewport);
  }

  setRows(rows: ReadonlyArray<{ id: string }>): void {
    FakeVirtualViewport.published.push(rows.map((row) => row.id));
    const live = new Set(rows.map((row) => row.id));
    for (const [id, element] of this.hosts) {
      if (live.has(id)) continue;
      element.remove();
      this.hosts.delete(id);
    }
    this.publish(rows.map((row) => ({ id: row.id, element: this.hostFor(row.id) })));
  }

  private hostFor(id: string): HTMLDivElement {
    const existing = this.hosts.get(id);
    if (existing) return existing;
    const element = document.createElement("div");
    this.viewport.append(element);
    this.hosts.set(id, element);
    return element;
  }

  releaseHosts(): void {}
  getReadingAnchor(): undefined {
    return undefined;
  }
  moveTo(): void {}
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
