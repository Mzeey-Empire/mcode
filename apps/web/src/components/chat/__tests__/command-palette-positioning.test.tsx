/**
 * Tests for SettingsView padding classes.
 *
 * Ensures SettingsView uses the balanced px-8/py-8 padding (not px-10/py-7).
 */
import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView = () => {};
});

// Mock the settings section map so SettingsView renders without real section components
vi.mock("../../settings/settings-nav", () => ({
  SECTION_MAP: {
    model: () => <div data-testid="model-section" />,
  },
}));

import { SettingsView } from "../../settings/SettingsView";

describe("SettingsView padding", () => {
  it("does NOT have px-10 in the outer div className", () => {
    const { container } = render(<SettingsView section="model" />);
    const innerDiv = container.querySelector(".max-w-\\[96rem\\]");
    expect(innerDiv?.className ?? "").not.toContain("px-10");
  });

  it("keeps px-8 padding at the sm breakpoint", () => {
    const { container } = render(<SettingsView section="model" />);
    const innerDiv = container.querySelector(".max-w-\\[96rem\\]");
    expect(innerDiv?.className ?? "").toContain("sm:px-8");
  });
});
