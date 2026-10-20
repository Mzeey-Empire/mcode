// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const getStage = vi.fn();
vi.mock("@/transport", () => ({ getTransport: () => ({ getStage }) }));

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
