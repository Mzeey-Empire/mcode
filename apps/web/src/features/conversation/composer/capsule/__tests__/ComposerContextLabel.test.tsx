import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComposerContextLabel } from "../ComposerContextLabel";

describe("ComposerContextLabel", () => {
  it("names a low provider quota when only the quota brings the label up", () => {
    render(<ComposerContextLabel tokensIn={30_000} contextWindow={100_000} hasLowQuota />);
    expect(screen.getByRole("img", { name: /30%.*low provider quota/i })).toBeInTheDocument();
  });

  it("names a low provider quota when the context alone already shows the label", () => {
    render(<ComposerContextLabel tokensIn={80_000} contextWindow={100_000} hasLowQuota />);
    expect(screen.getByRole("img", { name: /80%.*low provider quota/i })).toBeInTheDocument();
  });

  it("does not mention quota while it is not low", () => {
    render(<ComposerContextLabel tokensIn={80_000} contextWindow={100_000} hasLowQuota={false} />);
    expect(screen.getByRole("img", { name: /80%/ })).not.toHaveAccessibleName(/quota/i);
  });
});
