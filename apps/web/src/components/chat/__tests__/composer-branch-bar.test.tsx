/**
 * Tests for the ComposerBranchBar component.
 *
 * Verifies the minimal ↳ glyph layout.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ComposerBranchBar } from "../ComposerBranchBar";

describe("ComposerBranchBar — minimal glyph layout", () => {
  it("renders the ↳ glyph when branchFromMessageId is set", () => {
    render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        branchFromMessageContent="Fix the auth bug in the login flow"
        onBranchModeExit={vi.fn()}
      />,
    );
    expect(screen.getByText("↳")).toBeTruthy();
  });

  it('renders "Forking from" label text', () => {
    render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        onBranchModeExit={vi.fn()}
      />,
    );
    expect(screen.getByText("Forking from")).toBeTruthy();
  });

  it("renders italic excerpt when branchFromMessageContent is provided", () => {
    render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        branchFromMessageContent="Fix the auth bug in the login flow"
        onBranchModeExit={vi.fn()}
      />,
    );
    expect(screen.getByText(/Fix the auth bug/)).toBeTruthy();
  });

  it("renders nothing when branchFromMessageId is absent", () => {
    const { container } = render(
      <ComposerBranchBar onBranchModeExit={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
