import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProviderUnavailableBanner } from "../ProviderUnavailableBanner";

describe("ProviderUnavailableBanner", () => {
  it("renders disabled copy and both action buttons when reason=disabled", () => {
    render(<ProviderUnavailableBanner providerId="claude" reason="disabled" onOpenSettings={() => {}} onBranch={() => {}} />);
    expect(screen.getByText(/Claude is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /branch to another provider/i })).toBeInTheDocument();
  });

  it("renders cli_missing copy and only the settings button when reason=cli_missing", () => {
    render(<ProviderUnavailableBanner providerId="codex" reason="cli_missing" onOpenSettings={() => {}} onBranch={() => {}} />);
    expect(screen.getByText(/Codex CLI was not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /branch to another provider/i })).not.toBeInTheDocument();
  });
});
