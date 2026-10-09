import { beforeEach, describe, expect, it } from "vitest";
import { overviewPresentation, threadOverviewKey, useOverviewStore } from "../overviewStore";

const key = threadOverviewKey("thread-1");
const other = threadOverviewKey("thread-2");

describe("overviewStore", () => {
  beforeEach(() => {
    useOverviewStore.setState({ closedSubjects: new Set(), overlaySubject: null, requestedSubject: null });
  });

  it("keeps the request until the matching thread consumes it", () => {
    useOverviewStore.getState().requestOpen("thread-1");
    useOverviewStore.getState().consumeOpenRequest(other, true);
    expect(useOverviewStore.getState().requestedSubject).toBe("thread:thread-1");

    useOverviewStore.getState().consumeOpenRequest(key, true);
    expect(useOverviewStore.getState().requestedSubject).toBeNull();
  });

  it("closes and reopens the docked card per thread", () => {
    useOverviewStore.getState().toggle(key, true);
    expect(useOverviewStore.getState().closedSubjects.has(key)).toBe(true);
    expect(useOverviewStore.getState().closedSubjects.has(other)).toBe(false);

    useOverviewStore.getState().toggle(key, true);
    expect(useOverviewStore.getState().closedSubjects.has(key)).toBe(false);
  });

  it("shows and hides the overlay without touching the docked choice", () => {
    useOverviewStore.getState().toggle(key, false);
    expect(useOverviewStore.getState().overlaySubject).toBe(key);

    useOverviewStore.getState().dismissOverlay(other);
    expect(useOverviewStore.getState().overlaySubject).toBe(key);

    useOverviewStore.getState().toggle(key, false);
    expect(useOverviewStore.getState().overlaySubject).toBeNull();
    expect(useOverviewStore.getState().closedSubjects.size).toBe(0);
  });

  it("reopens a closed card for a request, as an overlay where it cannot dock", () => {
    useOverviewStore.getState().toggle(key, true);
    useOverviewStore.getState().requestOpen("thread-1");
    useOverviewStore.getState().consumeOpenRequest(key, false);

    expect(useOverviewStore.getState().closedSubjects.has(key)).toBe(false);
    expect(useOverviewStore.getState().overlaySubject).toBe(key);
  });

  it("docks unless closed, and overlays only on request where it cannot dock", () => {
    expect(overviewPresentation({ dockable: true, closed: false, overlay: false })).toBe("docked");
    expect(overviewPresentation({ dockable: true, closed: true, overlay: true })).toBe("hidden");
    expect(overviewPresentation({ dockable: false, closed: false, overlay: false })).toBe("hidden");
    expect(overviewPresentation({ dockable: false, closed: true, overlay: true })).toBe("overlay");
  });
});
