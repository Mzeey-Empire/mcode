import { describe, it, expect, beforeEach, onTestFinished, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useModelFavoritesStore } from "@/stores/modelFavoritesStore";
import { MODEL_PROVIDERS } from "@/lib/model-registry";
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

/** Tooltip relies on Base UI and App-level TooltipProvider; unwrap triggers and print the content for jsdom. */
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render?: React.ReactElement; children?: React.ReactNode }) =>
    render ? React.cloneElement(render, undefined, children ?? (render.props as { children?: React.ReactNode }).children) : <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <span data-testid="tooltip">{children}</span>,
}));

// Prevent real RPC calls triggered when a provider tab loads models.
const { listProviderModels } = vi.hoisted(() => ({ listProviderModels: vi.fn() }));
vi.mock("@/transport", () => ({
  getTransport: () => ({
    listProviderModels,
  }),
}));

import { ModelSelector } from "../ModelSelector";

function setProviders(enabled: Record<string, boolean>) {
  useProviderAvailabilityStore.setState({
    providers: Object.entries(enabled).map(([id, on]) => ({
      id,
      enabled: on,
      hasAdapter: true,
      beta: false,
      comingSoon: false,
      cli: { status: "found", resolvedPath: `/${id}`, configuredPath: "" },
    })) as never,
  });
}

async function openPicker() {
  await userEvent.click(screen.getByTestId("model-selector-trigger"));
  return screen.getByRole("dialog", { name: "Choose model and provider" });
}

function optionNames(): string[] {
  return screen.getAllByRole("option").map((option) => option.textContent ?? "");
}

beforeEach(() => {
  listProviderModels.mockReset().mockResolvedValue([]);
  useModelFavoritesStore.setState({ entries: [] });
  setProviders({ claude: true, codex: false });
});

describe("ModelSelector", () => {
  it("renders the live Codex order and submits the original model ID", async () => {
    setProviders({ claude: true, codex: true });
    listProviderModels.mockResolvedValue([
      { id: "gpt-9-zeta", name: "GPT-9 Zeta", group: "OpenAI" },
      { id: "gpt-9-alpha", name: "GPT-9 Alpha", group: "OpenAI" },
    ]);
    const onSelect = vi.fn();
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={onSelect} locked={false} />);
    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));
    await waitFor(() => expect(optionNames()).toEqual(["GPT-9 Zeta", "GPT-9 Alpha"]));
    await userEvent.click(screen.getByRole("option", { name: /GPT-9 Alpha/ }));
    expect(onSelect).toHaveBeenCalledWith("gpt-9-alpha", "codex");
  });

  it("lands focus in search on open and keeps the query across tabs", async () => {
    setProviders({ claude: true, codex: true });
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={vi.fn()} locked={false} />);
    await openPicker();
    const search = screen.getByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());

    await userEvent.type(search, "5.6 sol");
    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));

    expect(search).toHaveValue("5.6 sol");
    expect(optionNames()).toEqual(["GPT-5.6 Sol"]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={vi.fn()} locked={false} />);
    await openPicker();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("model-selector-trigger")).toHaveFocus();
  });

  it("disables a provider tab that is turned off in settings and says why", async () => {
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={vi.fn()} locked={false} />);
    const dialog = await openPicker();

    expect(within(dialog).getByRole("radio", { name: "Codex" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "Claude" })).toBeEnabled();
    expect(dialog).toHaveTextContent("Codex is disabled. Enable it in Settings under Providers.");
  });

  it("names each provider tab and shows the active tab's name", async () => {
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={vi.fn()} locked={false} />);
    await openPicker();

    const tabs = screen.getAllByRole("radio").map((tab) => tab.textContent);
    expect(tabs[0]).toBe("Favourites");
    expect(tabs).toContain("Claude");
    expect(screen.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps only the thread's provider tab when the provider is locked", async () => {
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={vi.fn()} locked={false} providerLocked />);
    await openPicker();

    expect(screen.getAllByRole("radio").map((tab) => tab.textContent)).toEqual(["Claude"]);
  });

  it("checks the selected row and stars a model without choosing it", async () => {
    const onSelect = vi.fn();
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={onSelect} locked={false} />);
    await openPicker();

    const selected = screen.getByRole("option", { selected: true });
    expect(selected).toHaveTextContent("Sonnet 4.6");
    await userEvent.click(within(selected).getByRole("button", { name: /Add .* to favourites/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(useModelFavoritesStore.getState().entries).toEqual([
      expect.objectContaining({ providerId: "claude", modelId: "claude-sonnet-4-6" }),
    ]);
  });

  it("lists favourites with their provider on a second line", async () => {
    setProviders({ claude: true, codex: true });
    useModelFavoritesStore.setState({
      entries: [{ providerId: "codex", modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
    });
    const onSelect = vi.fn();
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={onSelect} locked={false} />);
    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "Favourites" }));

    const row = screen.getByRole("option", { name: /GPT-5.6 Sol/ });
    expect(row).toHaveTextContent("Codex");
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("gpt-5.6-sol", "codex");
  });

  it("dims a model whose access ended, explains why, and refuses to pick it", async () => {
    // No catalog sets availableUntil yet, so seed an ended model into the static fallback the picker shows.
    const claude = MODEL_PROVIDERS.find((provider) => provider.id === "claude");
    claude?.models.push({ id: "claude-retired-1", label: "Claude Retired 1", providerId: "claude", availableUntil: "2020-01-31" });
    onTestFinished(() => {
      claude?.models.pop();
    });
    const onSelect = vi.fn();
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={onSelect} locked={false} />);
    await openPicker();

    const gated = await screen.findByRole("option", { name: /Claude Retired 1/ });
    expect(gated).toHaveAttribute("aria-disabled", "true");
    expect(gated).toHaveAccessibleDescription(/Subscription access to Claude Retired 1 ended on/);
    await userEvent.click(gated);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the loading row while a catalog loads and keeps the cached models after a timeout", async () => {
    setProviders({ claude: true, codex: true });
    let rejectModelRequest: (reason?: unknown) => void = () => {
      throw new Error("Model request did not start");
    };
    listProviderModels.mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => {
        rejectModelRequest = reject;
      }),
    );

    render(<ModelSelector selectedModelId="gpt-5.6-sol" selectedProviderId="codex"
      onSelect={vi.fn()} locked={false} />);
    const dialog = await openPicker();
    expect(within(dialog).getByLabelText("Loading")).toBeInTheDocument();
    rejectModelRequest(new Error("Request timed out. Try again."));

    await waitFor(() => expect(within(dialog).queryByLabelText("Loading")).toBeNull());
    expect(dialog).toHaveTextContent("GPT-5.6 Sol");
  });

  it("shows the locked label instead of a picker while the agent runs", () => {
    render(<ModelSelector selectedModelId="claude-sonnet-4-6" selectedProviderId="claude"
      onSelect={vi.fn()} locked />);
    expect(screen.queryByTestId("model-selector-trigger")).toBeNull();
    expect(screen.getByRole("img", { name: "Sonnet 4.6" })).toBeInTheDocument();
  });
});
