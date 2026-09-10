import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ContextTracker } from "../ContextTracker";

describe("ContextTracker", () => {
  it("keeps the ring number-free in a 32px target and shows capacity on hover", async () => {
    const user = userEvent.setup();
    render(<ContextTracker tokensIn={82_000} contextWindow={258_000} totalProcessedTokens={528_000} />);
    const ring = screen.getByRole("img", { name: /Context window: 32%/ });
    expect(ring).toHaveStyle({ width: "3.2rem", height: "3.2rem" });
    expect(ring).toHaveTextContent("");
    await user.hover(ring);
    const bar = await screen.findByRole("progressbar", { name: "Context window usage" });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo(82 / 258 * 100);
    expect(screen.getByText("176k left")).toBeVisible();
    expect(screen.getByText("528k tokens")).toBeVisible();
  });

  it("caps an over-capacity bar and exposes the card to keyboard focus", async () => {
    const user = userEvent.setup();
    render(<ContextTracker tokensIn={300_000} contextWindow={258_000} />);
    await user.tab();
    expect(screen.getByRole("img", { name: /Context window:/ })).toHaveFocus();
    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("0 left")).toBeVisible();
    expect(screen.queryByText("Total processed")).not.toBeInTheDocument();
  });

  it.each([
    { name: "normal", tokensIn: 69, ringClass: "stroke-primary", barClass: "bg-primary" },
    { name: "warning", tokensIn: 70, ringClass: "stroke-amber-500", barClass: "bg-amber-500" },
    { name: "critical", tokensIn: 90, ringClass: "stroke-destructive", barClass: "bg-destructive" },
  ])("uses the $name color tier for the ring and usage bar", async ({ tokensIn, ringClass, barClass }) => {
    const user = userEvent.setup();
    const { container } = render(<ContextTracker tokensIn={tokensIn} contextWindow={100} />);

    await user.hover(screen.getByRole("img", { name: /Context window:/ }));

    const ring = container.querySelector("circle[stroke-dasharray]");
    const bar = await screen.findByRole("progressbar", { name: "Context window usage" });

    expect(ring).toHaveClass(ringClass);
    expect(bar.firstElementChild).toHaveClass(barClass);
  });
});
