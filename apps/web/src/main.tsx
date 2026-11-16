import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/public-sans/wght.css";
import "@fontsource-variable/public-sans/wght-italic.css";
import { App } from "./app/App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { initRendererErrorReporting } from "./app/renderer-error-reporting";
import { initTransport } from "./transport";
import { initDesktopPowerReporting } from "./lib/desktop-power";
import { startMotionGate } from "./lib/window-focus";
import { markSvg } from "./components/brand/mark/mark-svg";
import { reportLaunchMark, observeUsableLaunch } from "./transport/launch-marks";
import { useWorkspaceStore } from "./features/projects/state/workspaceStore";
import "./index.css";

startMotionGate();
reportLaunchMark("scriptsEvaluated");

/** Render an error fallback when transport initialization fails. */
function renderTransportError(root: HTMLElement, error: unknown): void {
  const message =
    error instanceof Error ? error.message : String(error);
  root.innerHTML = "";

  const mark = document.createElement("div");
  mark.style.cssText = "width:6.4rem;height:6.4rem;";
  mark.innerHTML = markSvg("failed", "boot-error");

  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100vh;font-family:var(--font-sans);color:var(--ink);background:var(--background);gap:1.6rem;padding:2.4rem;";

  const heading = document.createElement("h1");
  heading.textContent = "Failed to connect";
  heading.style.cssText = "margin:0;font-size:2.4rem;line-height:2.8rem;";

  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = "margin:0;color:var(--muted);max-width:48rem;text-align:center;font-size:1.4rem;line-height:1.6rem;";

  const button = document.createElement("button");
  button.textContent = "Retry";
  button.style.cssText =
    "height:3.2rem;padding:0 1.2rem;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--button-secondary);" +
    "color:var(--ink);cursor:pointer;font-size:1.4rem;line-height:1.6rem;font-weight:500;";
  button.addEventListener("click", () => window.location.reload());

  container.append(mark, heading, detail, button);
  root.appendChild(container);
}

const root = document.getElementById("root")!;
initRendererErrorReporting();

const transportReady = initTransport();
observeUsableLaunch(useWorkspaceStore, transportReady);
transportReady
  .then(async () => {
    if (
      import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
      import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production"
    ) {
      const fixtureBridge = await import("./performance/frontend-renderer-fixture-bridge");
      fixtureBridge.installFrontendRendererFixtureBridge();
    }
    // Desktop only: report running turns / open terminals to the main
    // process so it can hold a power save blocker while the server is busy.
    initDesktopPowerReporting();
    // The preloader from index.html stays until React's first commit replaces #root's children.
    createRoot(root).render(
      <StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </StrictMode>
    );
  })
  .catch((error: unknown) => {
    renderTransportError(root, error);
  });
