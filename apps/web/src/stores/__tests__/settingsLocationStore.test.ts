import { beforeEach, describe, expect, it } from "vitest";
import { selectSettingsCanvas, useSettingsLocation } from "../settingsLocationStore";

beforeEach(() => {
  useSettingsLocation.getState().leave();
});

describe("settings location", () => {
  it("opens on General after Settings closes on another page", () => {
    useSettingsLocation.getState().openPage("terminal");
    useSettingsLocation.getState().leave();

    expect(selectSettingsCanvas(useSettingsLocation.getState())).toEqual({ kind: "page", page: "general", hit: null });
  });

  it("opens a named page after Settings closes", () => {
    useSettingsLocation.getState().openPage("terminal");
    useSettingsLocation.getState().leave();
    useSettingsLocation.getState().openPage("threads");

    expect(selectSettingsCanvas(useSettingsLocation.getState())).toEqual({ kind: "page", page: "threads", hit: null });
  });
});
