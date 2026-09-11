import { VirtualViewport, type VirtualHost, type ViewportPosition } from "@/components/ui/virtual-viewport";

/** A React-owned transcript host published by the shared viewport. */
export type TranscriptHost = VirtualHost;

/** Chat navigation and reading position in the shared viewport. */
export type TranscriptPosition = ViewportPosition;

/** Chooses chat's initial position and resumes following when the reader reaches the end. */
export class TranscriptViewport extends VirtualViewport {
  constructor(
    container: HTMLElement,
    publish: (hosts: readonly TranscriptHost[]) => void,
    onPosition: (position: TranscriptPosition) => void,
  ) {
    super(container, publish, onPosition, {
      classPrefix: "transcript",
      ariaLabel: "Conversation",
      initialPosition: { kind: "end" },
      positionOnScroll: (anchor, atEnd) => atEnd ? { kind: "end" } : anchor,
    });
    this.viewport.addEventListener("click", this.anchorDisclosure, true);
  }

  private readonly anchorDisclosure = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("button[aria-expanded]");
    const key = control?.closest("[data-transcript-key]")?.getAttribute("data-transcript-key");
    if (!key) return;
    const top = this.rowTop(key);
    if (top !== undefined) this.moveTo({ kind: "reading", key, offset: -top });
  };

  /** Removes the disclosure listener before releasing the transcript viewport. */
  override destroy(): void {
    this.viewport.removeEventListener("click", this.anchorDisclosure, true);
    super.destroy();
  }
}
