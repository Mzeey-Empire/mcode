import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeltaBlock } from "../DeltaBlock";
import { ThoughtBlock } from "../ThoughtBlock";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("assistant plan fence rendering", () => {
  it.each(["mcode-plan", "plan-questions", "plan-output"])(
    "hides every character of a streamed %s fence, including its opener",
    (name) => {
      vi.useFakeTimers();
      const { container, rerender } = render(<DeltaBlock text="Summary." isStreaming showCursor={false} />);
      act(() => vi.advanceTimersByTime(1000));
      const fence = `\n\n\`\`\`\`${name}\n# Hidden plan\n\`\`\`ts\nconst secret = 1;\n\`\`\`\n\`\`\`\``;
      for (let length = 1; length <= fence.length; length++) {
        rerender(<DeltaBlock text={"Summary." + fence.slice(0, length)} isStreaming showCursor={false} />);
        act(() => vi.advanceTimersByTime(1000));
        expect(container.textContent?.trim()).toBe("Summary.");
        expect(container.querySelector('[data-testid="streaming-skeleton"]')).toBeNull();
        expect(container.querySelector("pre")).toBeNull();
      }
    },
  );

  it.each([true, false])("hides plan fences in narrative text with isActive=%s", (isActive) => {
    vi.useFakeTimers();
    const { container } = render(<ThoughtBlock isActive={isActive} segment={{
      text: "Summary.\n````mcode-plan\n# Hidden plan\n````", startedAt: 0,
    }} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent?.trim()).toBe("Summary.");
  });
});
