// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useModelFavoritesStore, type ModelFavoriteEntry } from "../modelFavoritesStore";

function fav(modelId: string): ModelFavoriteEntry {
  return { providerId: "claude", modelId, label: modelId };
}

const ids = () => useModelFavoritesStore.getState().entries.map((e) => e.modelId);
const toggle = (modelId: string) => useModelFavoritesStore.getState().toggleFavorite(fav(modelId));

describe("modelFavoritesStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useModelFavoritesStore.setState({ entries: [] });
  });

  it("appends a new favourite so existing ones keep their positions", () => {
    toggle("a");
    toggle("b");
    toggle("c");
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("unstarring removes only that entry", () => {
    ["a", "b", "c"].forEach(toggle);
    toggle("b");
    expect(ids()).toEqual(["a", "c"]);
  });

  it("keeps a persisted order as loaded", async () => {
    localStorage.setItem(
      "mcode-model-favorites",
      JSON.stringify({ state: { entries: [fav("z"), fav("a"), fav("m")] }, version: 0 }),
    );
    await useModelFavoritesStore.persist.rehydrate();
    expect(ids()).toEqual(["z", "a", "m"]);
    toggle("n");
    expect(ids()).toEqual(["z", "a", "m", "n"]);
  });

  it("evicts the oldest favourite past the 40 cap", () => {
    const forty = Array.from({ length: 40 }, (_, i) => `m${i}`);
    useModelFavoritesStore.setState({ entries: forty.map(fav) });
    toggle("new");
    expect(ids()).toEqual([...forty.slice(1), "new"]);
  });
});
