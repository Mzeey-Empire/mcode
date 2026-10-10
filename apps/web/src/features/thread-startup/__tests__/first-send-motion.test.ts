import { createElement, useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIRST_SEND_RECORD_TTL_MS,
  firstSendAnimations,
  recordFirstSend,
  sidebarRowAnimations,
  takeFirstSend,
  useFirstSendMotion,
  usePreparingRowEntrance,
} from "../first-send-motion";

const EASING = "cubic-bezier(.2, 0, 0, 1)";

function rect(top: number, height = 0): DOMRect {
  return { top, left: 0, width: 600, height, right: 600, bottom: top + height, x: 0, y: top, toJSON: () => ({}) };
}

function startColumn(composerTop: number): HTMLElement {
  const column = document.createElement("div");
  column.dataset.testid = "new-thread-start-column";
  column.innerHTML = '<h1 id="heading" class="animate-fade-up-in">Start</h1><div data-testid="composer-surface"></div>';
  column.querySelector<HTMLElement>('[data-testid="composer-surface"]')!.getBoundingClientRect = () => rect(composerTop);
  return column;
}

function stubReducedMotion(reduced: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: reduced, media: query }) as MediaQueryList,
  );
}

type AnimateCall = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };

function stubAnimate(): AnimateCall[] {
  const calls: AnimateCall[] = [];
  Element.prototype.animate = function (this: Element, keyframes, options) {
    calls.push({ element: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions });
    return { finished: new Promise(() => {}) } as unknown as Animation;
  };
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).animate;
  document.body.innerHTML = "";
});

describe("first-send record", () => {
  it("returns the composer position recorded at send", () => {
    recordFirstSend("thread-1", startColumn(412), 1000);

    expect(takeFirstSend("thread-1", 1000 + FIRST_SEND_RECORD_TTL_MS)?.composerTop).toBe(412);
  });

  it("expires a record the surface did not claim within the TTL", () => {
    recordFirstSend("thread-1", startColumn(412), 1000);

    expect(takeFirstSend("thread-1", 1000 + FIRST_SEND_RECORD_TTL_MS + 1)).toBeUndefined();
  });

  it("plays at most once per send", () => {
    recordFirstSend("thread-1", startColumn(412), 1000);

    expect(takeFirstSend("thread-1", 1100)).toBeDefined();
    expect(takeFirstSend("thread-1", 1100)).toBeUndefined();
  });

  it("drops a stale record when a later send records", () => {
    recordFirstSend("stale", startColumn(412), 1000);
    recordFirstSend("fresh", startColumn(412), 1000 + FIRST_SEND_RECORD_TTL_MS + 1);

    expect(takeFirstSend("stale", 1000)).toBeUndefined();
  });

  it("records nothing when the column has no composer card", () => {
    recordFirstSend("thread-1", document.createElement("div"), 1000);

    expect(takeFirstSend("thread-1", 1000)).toBeUndefined();
  });

  it("copies the column with its card hidden and without ids or test ids", () => {
    recordFirstSend("thread-1", startColumn(412), 1000);

    const clone = takeFirstSend("thread-1", 1000)!.startColumn!.clone;
    expect(clone.querySelectorAll("[id], [data-testid]")).toHaveLength(0);
    expect(clone.hasAttribute("data-testid")).toBe(false);
    expect(clone.querySelector("h1")?.textContent).toBe("Start");
    expect(clone.querySelector("div")?.style.visibility).toBe("hidden");
  });

  it("stops the copied heading from replaying its entrance animation", () => {
    recordFirstSend("thread-1", startColumn(412), 1000);

    const clone = takeFirstSend("thread-1", 1000)!.startColumn!.clone;
    expect(clone.querySelector("h1")?.style.animation).toBe("none");
  });
});

describe("firstSendAnimations", () => {
  it("follows the 04g timeline", () => {
    expect(firstSendAnimations(-300, false)).toEqual({
      startColumn: {
        keyframes: [{ opacity: 1 }, { opacity: 0 }],
        options: { duration: 120, easing: EASING, fill: "forwards" },
      },
      composer: {
        keyframes: [{ transform: "translateY(-300px)" }, { transform: "translateY(0)" }],
        options: { duration: 240, easing: EASING },
      },
      message: {
        keyframes: [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
        options: { duration: 180, delay: 120, easing: EASING, fill: "backwards" },
      },
      steps: {
        keyframes: [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
        options: { duration: 180, delay: 240, easing: EASING, fill: "backwards" },
      },
    });
  });

  it("only fades the message and steps over 120ms under reduced motion", () => {
    const fade = { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 120, easing: EASING, fill: "backwards" } };

    expect(firstSendAnimations(-300, true)).toEqual({ message: fade, steps: fade });
  });
});

describe("sidebarRowAnimations", () => {
  it("fades the new row in and slides a moved row from where it was", () => {
    const animations = sidebarRowAnimations(false)!;

    expect(animations.entering).toEqual({ keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 180, easing: EASING } });
    expect(animations.shifted(28)).toEqual({
      keyframes: [{ transform: "translateY(-28px)" }, { transform: "translateY(0)" }],
      options: { duration: 180, easing: EASING },
    });
  });

  it("does not move the sidebar under reduced motion", () => {
    expect(sidebarRowAnimations(true)).toBeUndefined();
  });
});

function DockedSurface({ threadId, cardTop }: { threadId: string; cardTop: number }) {
  const motion = useFirstSendMotion(threadId);
  return createElement(
    "div",
    null,
    createElement(
      "div",
      { ref: motion.composer, "data-role": "composer" },
      createElement("div", {
        "data-testid": "composer-surface",
        ref: (card: HTMLDivElement | null) => {
          if (card) card.getBoundingClientRect = () => rect(cardTop);
        },
      }),
    ),
    createElement("div", { ref: motion.message, "data-role": "message" }),
    createElement("div", { ref: motion.steps, "data-role": "steps" }),
  );
}

function roles(calls: AnimateCall[]): (string | null)[] {
  return calls.map((call) => call.element.getAttribute("data-role"));
}

describe("useFirstSendMotion", () => {
  it("slides the composer from where the start column had it and fades the column copy", () => {
    stubReducedMotion(false);
    const calls = stubAnimate();
    recordFirstSend("thread-1", startColumn(412));

    render(createElement(DockedSurface, { threadId: "thread-1", cardTop: 712 }));

    expect(roles(calls)).toEqual([null, "composer", "message", "steps"]);
    expect(calls[1]!.keyframes[0]).toEqual({ transform: "translateY(-300px)" });
    expect(calls[0]!.element.parentElement).toBe(document.body);
  });

  it("translates nothing under reduced motion", () => {
    stubReducedMotion(true);
    const calls = stubAnimate();
    recordFirstSend("thread-1", startColumn(412));

    render(createElement(DockedSurface, { threadId: "thread-1", cardTop: 712 }));

    expect(roles(calls)).toEqual(["message", "steps"]);
    expect(calls.flatMap((call) => call.keyframes).some((frame) => "transform" in frame)).toBe(false);
  });

  it("stays still when the thread was not just sent from the start column", () => {
    stubReducedMotion(false);
    const calls = stubAnimate();

    render(createElement(DockedSurface, { threadId: "thread-1", cardTop: 712 }));

    expect(calls).toEqual([]);
  });
});

function ThreadRows({ drafts = [], ids, preparing }: { drafts?: string[]; ids: string[]; preparing: string[] }) {
  const list = useRef<HTMLDivElement>(null);
  usePreparingRowEntrance(list, [...drafts.map((id) => `draft:${id}`), ...ids], preparing);
  return createElement(
    "div",
    { ref: list },
    ids.map((id) =>
      createElement("div", {
        key: id,
        "data-thread-id": id,
        ref: (row: HTMLDivElement | null) => {
          if (row) row.getBoundingClientRect = () => rect(0, 28);
        },
      }),
    ),
  );
}

describe("usePreparingRowEntrance", () => {
  it("fades in a newly preparing row and shifts the rows after it", () => {
    stubReducedMotion(false);
    const calls = stubAnimate();
    const { rerender } = render(createElement(ThreadRows, { ids: ["a", "b"], preparing: [] }));

    rerender(createElement(ThreadRows, { ids: ["new", "a", "b"], preparing: ["new"] }));

    expect(calls.map((call) => call.element.getAttribute("data-thread-id"))).toEqual(["new", "a", "b"]);
    expect(calls[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(calls[1]!.keyframes).toEqual([{ transform: "translateY(-28px)" }, { transform: "translateY(0)" }]);
  });

  it("keeps the rows still when a draft above them becomes the new thread", () => {
    stubReducedMotion(false);
    const calls = stubAnimate();
    const { rerender } = render(createElement(ThreadRows, { drafts: ["d1"], ids: ["a", "b"], preparing: [] }));

    rerender(createElement(ThreadRows, { ids: ["new", "a", "b"], preparing: ["new"] }));

    expect(calls.map((call) => call.element.getAttribute("data-thread-id"))).toEqual(["new"]);
  });

  it("stays still when a failed placeholder is retried in place", () => {
    stubReducedMotion(false);
    const calls = stubAnimate();
    const { rerender } = render(createElement(ThreadRows, { ids: ["retry", "a"], preparing: [] }));

    rerender(createElement(ThreadRows, { ids: ["retry", "a"], preparing: ["retry"] }));

    expect(calls).toEqual([]);
  });

  it("does not replay for a row already preparing when the list first renders", () => {
    stubReducedMotion(false);
    const calls = stubAnimate();

    const { rerender } = render(createElement(ThreadRows, { ids: ["new", "a"], preparing: ["new"] }));
    rerender(createElement(ThreadRows, { ids: ["new", "a"], preparing: ["new"] }));

    expect(calls).toEqual([]);
  });
});
