// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMotionGate } from "../window-focus";

describe("startMotionGate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pauses motion on blur and resumes it on focus", () => {
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    startMotionGate();
    expect(document.documentElement.dataset.motion).toBe("live");

    focused = false;
    window.dispatchEvent(new Event("blur"));
    expect(document.documentElement.dataset.motion).toBe("paused");

    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(document.documentElement.dataset.motion).toBe("live");
  });

  it("pauses motion while the tab is hidden and resumes it when visible", () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    startMotionGate();
    expect(document.documentElement.dataset.motion).toBe("live");

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.documentElement.dataset.motion).toBe("paused");

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.documentElement.dataset.motion).toBe("live");
  });
});
