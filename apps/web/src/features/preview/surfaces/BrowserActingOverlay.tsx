import type { BrowserAutomationPointerEvent } from "@mcode/contracts";
import { MousePointer2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { browserAutomationTargetKey, useBrowserAutomationStore } from "../automation/browserAutomationStore";
import { useBrowserActing } from "../state/useBrowserActing";

const EDGE_BOX_SHADOW = [
  "inset 0 0 0 2px var(--primary)",
  "inset 0 0 28px color-mix(in oklab, var(--primary) 35%, transparent)",
].join(", ");

/** How long the agent cursor stays fully opaque after the agent's last point before it dims. */
export const AGENT_CURSOR_ACTIVE_MS = 700;

const AGENT_CURSOR_IDLE_OPACITY = 0.35;
// The pointer tip sits at (4, 4) in the 24-unit icon box; at 20px that is 3.3px in from the corner.
const AGENT_CURSOR_TIP_OFFSET_PX = 3.3;

/** Where the hosted page is drawn inside the overlay: its top-left corner and its drawn-to-layout size ratio. */
export interface AgentCursorPagePlacement {
  readonly left: number;
  readonly top: number;
  readonly scale: number;
}

/**
 * Maps an agent point from page CSS pixels to overlay pixels. Page zoom enlarges CSS pixels
 * inside the page, and a responsive viewport draws the whole page smaller or larger.
 */
export function mapAgentCursorPoint(
  point: Pick<BrowserAutomationPointerEvent, "x" | "y" | "zoomFactor">,
  page: AgentCursorPagePlacement,
): { readonly x: number; readonly y: number } {
  return {
    x: page.left + point.x * point.zoomFactor * page.scale,
    y: page.top + point.y * point.zoomFactor * page.scale,
  };
}

/** Measures the page against `origin`, an element covering the overlay, whose surface sits beside the overlay. */
function measurePagePlacement(origin: HTMLElement, threadId: string, tabId: string): AgentCursorPagePlacement {
  const surface = origin.closest('[data-testid="browser-acting-overlay"]')?.parentElement;
  const page = [...(surface?.querySelectorAll<HTMLElement>('[data-testid="preview-webview"]') ?? [])]
    .find((candidate) => candidate.dataset.threadId === threadId && candidate.dataset.tabId === tabId);
  if (!page) return { left: 0, top: 0, scale: 1 };
  const overlayRect = origin.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  // offsetWidth ignores CSS transforms, so the ratio is the responsive viewport's scale.
  const scale = page.offsetWidth > 0 ? pageRect.width / page.offsetWidth : 1;
  return { left: pageRect.left - overlayRect.left, top: pageRect.top - overlayRect.top, scale };
}

interface AgentCursorProps {
  readonly threadId: string;
  readonly tabId: string;
  readonly pointer: BrowserAutomationPointerEvent;
}

/** Presentation-only mark at the agent's latest point; it never takes input or moves the OS pointer. */
function AgentCursor({ threadId, tabId, pointer }: AgentCursorProps) {
  const originRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [idleSequence, setIdleSequence] = useState<number | null>(null);

  useLayoutEffect(() => {
    const origin = originRef.current;
    if (!origin) return;
    setPosition(mapAgentCursorPoint(pointer, measurePagePlacement(origin, threadId, tabId)));
  }, [pointer, threadId, tabId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setIdleSequence(pointer.sequence), AGENT_CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timer);
  }, [pointer.sequence]);

  return (
    <div ref={originRef} className="absolute inset-0" aria-hidden>
      {position && <AgentCursorMark position={position} active={idleSequence !== pointer.sequence} pointer={pointer} />}
    </div>
  );
}

function AgentCursorMark({
  position,
  active,
  pointer,
}: {
  readonly position: { readonly x: number; readonly y: number };
  readonly active: boolean;
  readonly pointer: BrowserAutomationPointerEvent;
}) {
  return (
    <div
      data-testid="browser-automation-pointer"
      className="absolute top-0 left-0 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        opacity: active ? 1 : AGENT_CURSOR_IDLE_OPACITY,
      }}
    >
      {pointer.phase === "click" && (
        <span
          key={pointer.sequence}
          data-testid="browser-automation-pointer-ping"
          className="animate-agent-cursor-ping absolute -top-2.5 -left-2.5 size-5 rounded-full border-2 border-primary"
        />
      )}
      <MousePointer2
        className="absolute size-5 fill-primary text-primary"
        style={{
          left: -AGENT_CURSOR_TIP_OFFSET_PX,
          top: -AGENT_CURSOR_TIP_OFFSET_PX,
          filter: "drop-shadow(0 0 5px color-mix(in oklab, var(--primary) 72%, transparent))",
        }}
      />
    </div>
  );
}

interface BrowserActingOverlayProps {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly coveredRight: number;
}

/**
 * Click-through edge wash and agent cursor shown over the page while the agent acts on the active
 * tab. It renders above the hosted page, which paints from the detached surface host root.
 */
export function BrowserActingOverlay({ workspaceId, threadId, tabId, coveredRight }: BrowserActingOverlayProps) {
  const acting = useBrowserActing(workspaceId, threadId, tabId);
  const pointer = useBrowserAutomationStore(
    (state) => state.pointers.get(browserAutomationTargetKey(workspaceId, threadId, tabId)) ?? null,
  );
  if (!acting) return null;
  return (
    <div
      data-testid="browser-acting-overlay"
      className="pointer-events-none absolute inset-0 z-(--layer-browser-overlay) rounded-tr-md"
      style={{
        clipPath: coveredRight ? `inset(0 ${coveredRight}px 0 0)` : undefined,
        boxShadow: EDGE_BOX_SHADOW,
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">
        Agent controls Browser
      </span>
      {pointer && <AgentCursor threadId={threadId} tabId={tabId} pointer={pointer} />}
    </div>
  );
}
