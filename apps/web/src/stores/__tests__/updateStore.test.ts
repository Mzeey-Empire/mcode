// @vitest-environment jsdom
import { mockTransport } from "@/__tests__/mocks/transport";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const getStage = vi.mocked(mockTransport.getStage);
vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.getStage).mockReset();
});

import { useUpdateStore } from "../updateStore";

describe("updateStore.loadStage", () => {
  afterEach(() => {
    document.title = "Mcode";
    useUpdateStore.setState({ stage: null });
  });

  it("labels the browser tab with the build stage reported by the server", async () => {
    getStage.mockResolvedValue("dev");
    await useUpdateStore.getState().loadStage();
    expect(useUpdateStore.getState().stage).toBe("dev");
    expect(document.title).toBe("Mcode (Dev)");
  });

  it("leaves the title plain for a stable build", async () => {
    getStage.mockResolvedValue("stable");
    await useUpdateStore.getState().loadStage();
    expect(document.title).toBe("Mcode");
  });
});
