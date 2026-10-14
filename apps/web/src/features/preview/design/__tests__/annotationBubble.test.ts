import { describe, expect, it } from "vitest";
import { annotationBubbleStyle } from "../annotationBubble";

const element = (y: number, height: number) => ({ x: 40, y, width: 200, height });

describe("annotationBubbleStyle", () => {
  it("places the bubble under the element when it fits", () => {
    expect(annotationBubbleStyle(element(100, 40), 800, 600)).toMatchObject({ left: 40, top: 148 });
  });

  it("flips above the element near the bottom of the preview", () => {
    const style = annotationBubbleStyle(element(400, 200), 800, 600);
    expect(style).toMatchObject({ bottom: 208 });
    expect(style).not.toHaveProperty("top");
  });

  it("stays below when above has even less room", () => {
    expect(annotationBubbleStyle(element(20, 560), 800, 600)).toMatchObject({ top: 588 });
  });

  it("stays below when the surface height is unknown", () => {
    expect(annotationBubbleStyle(element(400, 200), 800, 0)).toMatchObject({ top: 608 });
  });
});
