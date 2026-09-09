import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NarrativeItem } from "../types";
import { NarrativeRows } from "../NarrativeRows";

function thought(index: number): NarrativeItem {
  return {
    type: "thought",
    segment: { text: `Narrative row ${index}`, startedAt: index },
    isActive: false,
  };
}

describe("NarrativeRows", () => {
  it("keeps all dense narrative text in order without browsing controls", () => {
    render(<NarrativeRows items={Array.from({ length: 50 }, (_, index) => thought(index))} allToolCalls={[]} />);

    expect(screen.getAllByText(/^Narrative row \d+$/).map((row) => row.textContent))
      .toEqual(Array.from({ length: 50 }, (_, index) => `Narrative row ${index}`));
    expect(screen.queryByRole("button", { name: /Browse all|Previous|Next|Summary/ })).toBeNull();
  });

  it("retains earlier text when streaming crosses the former summary threshold", () => {
    const items = Array.from({ length: 24 }, (_, index) => thought(index));
    const { rerender } = render(<NarrativeRows items={items} allToolCalls={[]} animateEntry />);

    rerender(<NarrativeRows items={[...items, thought(24)]} allToolCalls={[]} animateEntry />);

    expect(screen.getAllByText(/^Narrative row \d+$/).map((row) => row.textContent))
      .toEqual(Array.from({ length: 25 }, (_, index) => `Narrative row ${index}`));

    rerender(<NarrativeRows items={[]} allToolCalls={[]} />);
    expect(screen.queryAllByText(/^Narrative row \d+$/)).toEqual([]);
    expect(screen.queryByRole("button", { name: /Browse all|Previous|Next|Summary/ })).toBeNull();
  });
});
