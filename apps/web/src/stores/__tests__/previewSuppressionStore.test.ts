import { describe, expect, it, beforeEach } from "vitest";
import { usePreviewSuppressionStore } from "../previewSuppressionStore";

describe("previewSuppressionStore", () => {
  beforeEach(() => {
    usePreviewSuppressionStore.setState({ count: 0 });
  });

  it("starts at zero", () => {
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
  });

  it("increment bumps the count", () => {
    usePreviewSuppressionStore.getState().increment();
    expect(usePreviewSuppressionStore.getState().count).toBe(1);
    usePreviewSuppressionStore.getState().increment();
    expect(usePreviewSuppressionStore.getState().count).toBe(2);
  });

  it("decrement reduces the count", () => {
    const { increment, decrement } = usePreviewSuppressionStore.getState();
    increment();
    increment();
    decrement();
    expect(usePreviewSuppressionStore.getState().count).toBe(1);
  });

  it("decrement at zero stays at zero (no underflow)", () => {
    usePreviewSuppressionStore.getState().decrement();
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
    usePreviewSuppressionStore.getState().decrement();
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
  });

  it("balanced increment/decrement returns to zero", () => {
    const { increment, decrement } = usePreviewSuppressionStore.getState();
    increment();
    increment();
    increment();
    decrement();
    decrement();
    decrement();
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
  });
});
