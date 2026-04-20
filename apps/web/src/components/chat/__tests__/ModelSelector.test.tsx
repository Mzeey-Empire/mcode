import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import React from "react";

// @base-ui/react (used by Button) does not work in jsdom; stub with a native button.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

// @base-ui/react (used by Badge) does not work in jsdom; stub as a plain span.
vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    "data-testid": testId,
    ...rest
  }: {
    children?: React.ReactNode;
    "data-testid"?: string;
    [key: string]: unknown;
  }) => (
    <span data-testid={testId} {...rest}>
      {children}
    </span>
  ),
}));

// Prevent real RPC calls triggered by fetchProviderModels on hover.
vi.mock("@/transport", () => ({
  getTransport: () => ({
    listProviderModels: vi.fn().mockResolvedValue([]),
  }),
}));

import { ModelSelector } from "../ModelSelector";

beforeEach(() => {
  useProviderAvailabilityStore.setState({
    providers: [
      {
        id: "claude",
        enabled: true,
        hasAdapter: true,
        beta: false,
        comingSoon: false,
        cli: { status: "found", resolvedPath: "/a", configuredPath: "" },
      },
      {
        id: "codex",
        enabled: false,
        hasAdapter: true,
        beta: false,
        comingSoon: false,
        cli: { status: "found", resolvedPath: "/b", configuredPath: "" },
      },
    ] as never,
  });
});

describe("ModelSelector", () => {
  it("marks disabled providers with data-disabled='true' on their group container", async () => {
    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={vi.fn()}
        locked={false}
      />,
    );

    // Open the dropdown by clicking the trigger button.
    const trigger = screen.getAllByRole("button")[0];
    await userEvent.click(trigger);

    const codexGroup = document.querySelector("[data-testid='model-group-codex']");
    expect(codexGroup).not.toBeNull();
    expect(codexGroup).toHaveAttribute("data-disabled", "true");
  });

  it("shows a 'Disabled' badge for the disabled provider", async () => {
    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={vi.fn()}
        locked={false}
      />,
    );

    const trigger = screen.getAllByRole("button")[0];
    await userEvent.click(trigger);

    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("does not mark enabled providers as disabled", async () => {
    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={vi.fn()}
        locked={false}
      />,
    );

    const trigger = screen.getAllByRole("button")[0];
    await userEvent.click(trigger);

    const claudeGroup = document.querySelector("[data-testid='model-group-claude']");
    expect(claudeGroup).toHaveAttribute("data-disabled", "false");
  });
});
