import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { getDefaultSettings, type PartialSettings } from "@mcode/contracts";

// @base-ui/react (used by Dialog primitives) does not work in jsdom; stub with plain HTML.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open !== false ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ConfirmDisableDialog } from "../ConfirmDisableDialog";

beforeEach(() => {
  const s = getDefaultSettings();
  s.model.defaults.provider = "codex";
  useSettingsStore.setState({ settings: s, update: vi.fn(async () => {}) });
  useProviderAvailabilityStore.setState({
    providers: [
      { id: "claude", enabled: true, hasAdapter: true, beta: false, comingSoon: false, cli: { status: "found", resolvedPath: "/a", configuredPath: "" } },
      { id: "codex",  enabled: true, hasAdapter: true, beta: false, comingSoon: false, cli: { status: "found", resolvedPath: "/b", configuredPath: "" } },
    ] as never,
  });
});

describe("ConfirmDisableDialog", () => {
  it("names the replacement provider (first enabled after exclusion, catalog order)", () => {
    render(<ConfirmDisableDialog providerId="codex" onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(/Claude/)).toBeInTheDocument();
  });

  it("batches toggle-off + default rewrite in a single settings.update on confirm", async () => {
    const update: Mock<(partial: PartialSettings) => Promise<void>> = vi.fn(async () => {});
    useSettingsStore.setState({ settings: useSettingsStore.getState().settings, update });
    render(<ConfirmDisableDialog providerId="codex" onCancel={() => {}} onConfirm={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /disable and switch default/i }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      provider: { enabled: { codex: false } },
      model: { defaults: { provider: "claude" } },
    });
  });

  it("calls onCancel when cancel is clicked and does not call update", async () => {
    const update: Mock<(partial: PartialSettings) => Promise<void>> = vi.fn(async () => {});
    useSettingsStore.setState({ settings: useSettingsStore.getState().settings, update });
    const onCancel = vi.fn();
    render(<ConfirmDisableDialog providerId="codex" onCancel={onCancel} onConfirm={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
