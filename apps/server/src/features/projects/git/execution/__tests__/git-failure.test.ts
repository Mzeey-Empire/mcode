import { describe, expect, it } from "vitest";
import { gitPushFailureDetail } from "../git-failure.js";

describe("gitPushFailureDetail", () => {
  it("keeps a fatal message while removing credentials from its URL", () => {
    const output = "fatal: unable to access 'https://user:tok@github.com/o/r.git/': Authentication failed";

    expect(gitPushFailureDetail(output)).toBe(
      "fatal: unable to access 'https://github.com/o/r.git/': Authentication failed",
    );
  });
});
