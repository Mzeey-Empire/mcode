import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComposerContextLabel } from "../ComposerContextLabel";

describe("ComposerContextLabel", () => {
  it("shows nothing before any tokens are used", () => {
    render(<ComposerContextLabel tokensIn={0} contextWindow={100_000} />);
    expect(screen.queryByTestId("composer-context-label")).not.toBeInTheDocument();
  });

  it("shows nothing while context use is below its warning level", () => {
    render(<ComposerContextLabel tokensIn={30_000} contextWindow={100_000} />);
    expect(screen.queryByTestId("composer-context-label")).not.toBeInTheDocument();
  });

  it("names the context percentage from its warning level", () => {
    render(<ComposerContextLabel tokensIn={80_000} contextWindow={100_000} />);
    expect(screen.getByRole("img", { name: "Context window: 80% · 80k/100k context used" })).toBeInTheDocument();
  });
});
