import { describe, expect, it } from "vitest";
import { crashDumpOptions } from "../crash-dumps";

describe("crashDumpOptions", () => {
  it("keeps local dumps with uploads off in development builds", () => {
    expect(crashDumpOptions(false)).toEqual({ uploadToServer: false });
  });

  it("disables crash reporting in packaged builds", () => {
    expect(crashDumpOptions(true)).toBeNull();
  });
});
