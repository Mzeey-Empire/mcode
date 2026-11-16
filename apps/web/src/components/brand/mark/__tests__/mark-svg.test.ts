// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { markSvg, preloaderHtml, type McodeMarkState } from "../mark-svg";
import { STATE_BODY } from "../states";

function expectSelfContainedIds(html: string): void {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.replaceChildren(host);
  const ids = [...host.querySelectorAll("[id]")].map((el) => el.id);
  expect(new Set(ids).size).toBe(ids.length);
  const svgs = [...host.querySelectorAll("svg")];
  expect(svgs.length).toBeGreaterThan(0);
  for (const svg of svgs) {
    const refs = [...svg.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].flatMap((attr) =>
        attr.name === "href"
          ? [attr.value.slice(1)]
          : [...attr.value.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]),
      ),
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const target = document.getElementById(ref ?? "");
      expect(target, `#${ref} is missing`).not.toBeNull();
      expect(svg.contains(target), `#${ref} resolves outside its own svg`).toBe(true);
    }
  }
}

describe("markSvg", () => {
  for (const state of Object.keys(STATE_BODY) as McodeMarkState[]) {
    it(`keeps ${state} ids unique and self-contained next to another mark`, () => {
      expectSelfContainedIds(markSvg(state, "first") + markSvg(state, "second"));
    });
  }
});

describe("preloaderHtml", () => {
  it("keeps the boot and loading marks' ids apart", () => {
    expectSelfContainedIds(preloaderHtml());
  });
});
