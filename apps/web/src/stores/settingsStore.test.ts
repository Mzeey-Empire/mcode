import { beforeEach, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useSettingsStore } from "./settingsStore";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
});

it("keeps the confirmed value and returns a rejected write's reason", async () => {
  vi.mocked(mockTransport.updateSettings).mockRejectedValueOnce(new Error("Permission denied"));
  const failure = await useSettingsStore.getState().update({
    thread: { completion: { completeOnPrMerge: false } },
  });
  expect(failure).toBe("Permission denied");
  expect(useSettingsStore.getState().settings.thread.completion.completeOnPrMerge).toBe(true);
});

it("applies a confirmed settings write", async () => {
  const confirmed = getDefaultSettings();
  confirmed.thread.completion.completeOnPrMerge = false;
  vi.mocked(mockTransport.updateSettings).mockResolvedValueOnce(confirmed);
  expect(await useSettingsStore.getState().update({
    thread: { completion: { completeOnPrMerge: false } },
  })).toBeUndefined();
  expect(useSettingsStore.getState().settings.thread.completion.completeOnPrMerge).toBe(false);
});
