import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderDiscStack, ProviderIcon } from "../provider-icon";

describe("ProviderIcon", () => {
  it("renders the provider's mark at the requested size", () => {
    const { container } = render(<ProviderIcon provider="codex" size={20} />);

    expect(container.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("width", "20");
    expect(mark).toHaveAttribute("height", "20");
  });

  it("renders a placeholder for an unknown provider", () => {
    const { container } = render(<ProviderIcon provider="toString" />);

    expect(container.querySelector('[data-provider-icon="unknown"]')).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("ProviderDiscStack", () => {
  it("shows three discs for eight subagents", () => {
    render(<ProviderDiscStack providers={Array.from({ length: 8 }, () => "codex")} />);

    expect(screen.getAllByTestId("provider-disc")).toHaveLength(3);
    expect(screen.getByTestId("provider-disc-stack")).toHaveStyle({ width: "44px" });
  });

  it("keeps each subagent's own provider in display order", () => {
    const { container } = render(<ProviderDiscStack providers={["claude", "codex"]} />);

    const marks = [...container.querySelectorAll("[data-provider-icon]")]
      .map((mark) => mark.getAttribute("data-provider-icon"));
    expect(marks).toEqual(["claude", "codex"]);
  });

  it("renders nothing without subagents", () => {
    const { container } = render(<ProviderDiscStack providers={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
