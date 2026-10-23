import type { PreviewGuestAgentPointerMessage } from "../contracts/guest-input.js";

/** Time after the last agent point before the in-page mark fades out and is removed. */
export const GUEST_AGENT_CURSOR_IDLE_MS = 700;

const MOTION_MS = 150;
const MAX_VIEWPORT_COORDINATE = 100_000;
// Matches --amber-500, the dark-theme --primary, so recordings show the same mark as the host.
const MARK_COLOR = "oklch(72% 0.170 75)";
// The pointer tip sits at (4, 4) in the 24-unit icon box; shifting by it puts the tip on the point.
const TIP_OFFSET_PX = 3.3;

const SHADOW_STYLE = `
  svg {
    position: absolute;
    left: ${-TIP_OFFSET_PX}px;
    top: ${-TIP_OFFSET_PX}px;
    width: 20px;
    height: 20px;
    fill: ${MARK_COLOR};
    stroke: ${MARK_COLOR};
    stroke-width: 2;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 4px rgb(0 0 0 / 0.45));
  }
  .ping {
    position: absolute;
    left: -10px;
    top: -10px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid ${MARK_COLOR};
    box-sizing: border-box;
    opacity: 0;
    /* Waits for the mark's travel so the ring appears where the click lands. */
    animation: ping 450ms ease-out ${MOTION_MS}ms forwards;
  }
  @keyframes ping {
    from { opacity: 0.9; transform: scale(0.4); }
    to { opacity: 0; transform: scale(1.8); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ping { animation: none; opacity: 0; }
  }
`;

const POINTER_PATH =
  "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";

/** In-page agent cursor drawn by the guest preload so tab recordings include it. */
export interface GuestAgentCursor {
  /** Moves the mark to one host-reported point; malformed messages are ignored. */
  show(message: unknown): void;
  /** Number of click pings drawn since creation. */
  pingCount(): number;
}

interface MountedMark {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
}

/**
 * Creates the in-page agent cursor. The mark is inert: it never takes input, is hidden from
 * assistive technology, and is removed once the agent goes idle so no animation keeps running.
 */
export function createGuestAgentCursor(document: Document): GuestAgentCursor {
  let mounted: MountedMark | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;
  let pings = 0;

  const unmount = () => {
    mounted?.host.remove();
    mounted = null;
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (removeTimer) clearTimeout(removeTimer);
    removeTimer = null;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      mounted?.host.style.setProperty("opacity", "0", "important");
      removeTimer = setTimeout(unmount, MOTION_MS);
    }, GUEST_AGENT_CURSOR_IDLE_MS);
  };

  return {
    show(message) {
      const pointer = parsePointerMessage(message);
      if (!pointer) return;
      const mark = mounted?.host.isConnected ? mounted : mountMark(document);
      mounted = mark;
      mark.host.style.setProperty("opacity", "1", "important");
      mark.host.style.setProperty("transform", `translate(${pointer.x}px, ${pointer.y}px)`, "important");
      if (pointer.phase === "click") {
        pings += 1;
        drawPing(mark.root);
      }
      scheduleIdle();
    },
    pingCount: () => pings,
  };
}

function mountMark(document: Document): MountedMark {
  const host = document.createElement("mcode-agent-cursor");
  host.setAttribute("aria-hidden", "true");
  // Inline !important keeps page stylesheets from moving, hiding, or making the mark clickable.
  for (const [property, value] of [
    ["all", "initial"],
    ["position", "fixed"],
    ["left", "0"],
    ["top", "0"],
    ["width", "0"],
    ["height", "0"],
    ["pointer-events", "none"],
    ["z-index", "2147483647"],
    ["transition", `transform ${MOTION_MS}ms ease-out, opacity ${MOTION_MS}ms ease-out`],
  ] as const) {
    host.style.setProperty(property, value, "important");
  }
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = SHADOW_STYLE;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", POINTER_PATH);
  svg.append(path);
  root.append(style, svg);
  document.documentElement.append(host);
  return { host, root };
}

function drawPing(root: ShadowRoot): void {
  root.querySelector(".ping")?.remove();
  const ping = root.ownerDocument.createElement("span");
  ping.className = "ping";
  root.append(ping);
}

function parsePointerMessage(message: unknown): PreviewGuestAgentPointerMessage | null {
  if (!message || typeof message !== "object") return null;
  const { phase, x, y } = message as Partial<Record<keyof PreviewGuestAgentPointerMessage, unknown>>;
  if (phase !== "move" && phase !== "click") return null;
  if (!isViewportCoordinate(x) || !isViewportCoordinate(y)) return null;
  return { phase, x, y };
}

function isViewportCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_VIEWPORT_COORDINATE;
}
