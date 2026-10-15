import { MousePointer2 } from "lucide-react";
import { browserAutomationTargetKey, useBrowserAutomationStore } from "../automation/browserAutomationStore";
import { useBrowserActing } from "../state/useBrowserActing";

const EDGE_BACKGROUND_IMAGE = [
  "linear-gradient(to right, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
  "linear-gradient(to left, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
  "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
  "linear-gradient(to top, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
].join(", ");

const EDGE_BOX_SHADOW = [
  "inset 0 0 40px color-mix(in oklab, var(--primary) 30%, transparent)",
  "0 0 24px color-mix(in oklab, var(--primary) 28%, transparent)",
].join(", ");

interface BrowserActingOverlayProps {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly coveredRight: number;
}

/**
 * Click-through edge wash and pointer shown over the page while the agent acts on the active
 * tab. It renders above the hosted page, which paints from the detached surface host root.
 */
export function BrowserActingOverlay({ workspaceId, threadId, tabId, coveredRight }: BrowserActingOverlayProps) {
  const acting = useBrowserActing(workspaceId, threadId, tabId);
  const pointer = useBrowserAutomationStore(
    (state) => state.controllers.get(browserAutomationTargetKey(workspaceId, threadId, tabId))?.pointer ?? null,
  );
  if (!acting) return null;
  return (
    <div
      data-testid="browser-acting-overlay"
      className="pointer-events-none absolute inset-0 z-(--layer-browser-overlay) rounded-tr-md"
      style={{
        clipPath: coveredRight ? `inset(0 ${coveredRight}px 0 0)` : undefined,
        backgroundImage: EDGE_BACKGROUND_IMAGE,
        boxShadow: EDGE_BOX_SHADOW,
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">
        Agent controls Browser
      </span>
      <MousePointer2
        data-testid="browser-automation-pointer"
        className="absolute size-5 fill-primary text-primary motion-reduce:transition-none"
        style={{
          left: pointer?.x ?? 24,
          top: pointer?.y ?? 24,
          filter: "drop-shadow(0 0 5px color-mix(in oklab, var(--primary) 72%, transparent))",
        }}
        aria-hidden
      />
    </div>
  );
}
