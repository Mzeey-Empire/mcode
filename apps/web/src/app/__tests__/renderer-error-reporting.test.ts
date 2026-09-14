import { afterEach, describe, expect, it, vi } from "vitest";
import { initRendererErrorReporting } from "../renderer-error-reporting";

describe("initRendererErrorReporting", () => {
  const reportRendererCrash = vi.fn().mockResolvedValue(undefined);

  afterEach(() => {
    reportRendererCrash.mockClear();
    Reflect.deleteProperty(window, "desktopBridge");
  });

  function installBridge(): void {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reportRendererCrash },
    });
    initRendererErrorReporting();
  }

  it("does not report ResizeObserver loop errors", () => {
    installBridge();
    window.dispatchEvent(new ErrorEvent("error", {
      message: "ResizeObserver loop completed with undelivered notifications.",
    }));
    window.dispatchEvent(new ErrorEvent("error", {
      message: "ResizeObserver loop limit exceeded",
    }));
    expect(reportRendererCrash).not.toHaveBeenCalled();
  });

  it("reports other uncaught errors", () => {
    installBridge();
    window.dispatchEvent(new ErrorEvent("error", {
      message: "boom",
      error: new Error("boom"),
    }));
    expect(reportRendererCrash).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: "boom",
    }));
  });
});
