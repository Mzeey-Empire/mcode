import { describe, expect, it } from "vitest";
import { gitPushFailureDetail } from "../git-failure.js";

describe("gitPushFailureDetail", () => {
  it("keeps a fatal message while removing credentials from its URL", () => {
    const output = "fatal: unable to access 'https://user:tok@github.com/o/r.git/': Authentication failed";

    expect(gitPushFailureDetail(output)).toBe(
      "fatal: unable to access 'https://github.com/o/r.git/': Authentication failed",
    );
  });

  it("removes a token a host put in the URL's query", () => {
    const output = "fatal: unable to access 'https://git.example.com/o/r.git?access_token=tok': 403";

    expect(gitPushFailureDetail(output)).toBe("fatal: unable to access 'https://git.example.com/o/r.git': 403");
  });
});
