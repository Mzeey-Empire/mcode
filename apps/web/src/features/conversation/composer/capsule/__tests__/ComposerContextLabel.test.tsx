import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComposerContextLabel } from "../ComposerContextLabel";

describe("ComposerContextLabel", () => {
  it("names the low quota, not a context percentage, while context use is below its warning level", () => {
    render(<ComposerContextLabel tokensIn={30_000} contextWindow={100_000} hasLowQuota />);
    expect(screen.getByRole("img", { name: /low provider quota/i })).toHaveTextContent("Low quota");
  });

  it("names a low provider quota when the context alone already shows the label", () => {
    render(<ComposerContextLabel tokensIn={80_000} contextWindow={100_000} hasLowQuota />);
    expect(screen.getByRole("img", { name: /80%.*low provider quota/i })).toBeInTheDocument();
  });

  it("warns of a low provider quota before any tokens are used", () => {
    render(<ComposerContextLabel tokensIn={0} contextWindow={100_000} hasLowQuota />);
    expect(screen.getByRole("img", { name: /low provider quota/i })).toHaveTextContent("Low quota");
  });

  it("warns of a low provider quota when the context window is unknown", () => {
    render(<ComposerContextLabel tokensIn={5_000} contextWindow={undefined} hasLowQuota />);
    expect(screen.getByRole("img", { name: /low provider quota/i })).toHaveTextContent("Low quota");
  });

  it("shows nothing before any tokens are used while quota is not low", () => {
    render(<ComposerContextLabel tokensIn={0} contextWindow={100_000} hasLowQuota={false} />);
    expect(screen.queryByTestId("composer-context-label")).not.toBeInTheDocument();
  });

  it("does not mention quota while it is not low", () => {
    render(<ComposerContextLabel tokensIn={80_000} contextWindow={100_000} hasLowQuota={false} />);
    expect(screen.getByRole("img", { name: /80%/ })).not.toHaveAccessibleName(/quota/i);
  });
});
