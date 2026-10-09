import { createMockThread } from "@/__tests__/mocks/transport";
import { render, screen } from "@testing-library/react";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverviewCard } from "../overview-card";
import type { OverviewEntry, OverviewSectionId } from "../overview-registry";
import type { OverviewSubject } from "../overview-subject";

// Vitest stubs imported CSS, so the card's section rules are loaded from disk.
const cardCss = NodeFS.readFileSync(
  NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../overview-card.css"),
  "utf8",
);

const subject: OverviewSubject = { kind: "thread", thread: createMockThread({ id: "card-thread" }) };

function entry(id: string, section: OverviewSectionId, visible: boolean): OverviewEntry {
  return {
    id,
    section,
    order: 0,
    subjects: ["thread"],
    Entry: () => (visible ? <div data-testid={`row-${id}`}>{id}</div> : null),
  };
}

function sectionStyle(section: OverviewSectionId) {
  const element = screen.getByTestId("thread-overview-card").querySelector(`[data-overview-section="${section}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`missing section ${section}`);
  const style = getComputedStyle(element);
  return { hidden: style.display === "none", divider: style.borderTopStyle === "solid" };
}

describe("OverviewCard", () => {
  let styleTag: HTMLStyleElement;
  beforeEach(() => {
    styleTag = document.createElement("style");
    styleTag.textContent = cardCss;
    document.head.append(styleTag);
  });
  afterEach(() => styleTag.remove());

  it("hides empty sections and draws dividers only between sections with rows", () => {
    render(
      <OverviewCard
        subject={subject}
        presentation="docked"
        headerActions={[]}
        entries={[
          entry("lane-row", "lane", true),
          entry("activity-empty", "activity", false),
          entry("terminal-row", "terminals", true),
          entry("summary-empty", "summary", false),
        ]}
      />,
    );

    expect(sectionStyle("lane")).toEqual({ hidden: false, divider: false });
    expect(sectionStyle("activity").hidden).toBe(true);
    expect(sectionStyle("terminals")).toEqual({ hidden: false, divider: true });
    expect(sectionStyle("summary").hidden).toBe(true);
  });

  it("puts the first non-empty section directly under the header without a divider", () => {
    render(
      <OverviewCard
        subject={subject}
        presentation="overlay"
        headerActions={[]}
        entries={[entry("lane-empty", "lane", false), entry("summary-row", "summary", true)]}
      />,
    );

    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "overlay");
    expect(sectionStyle("summary")).toEqual({ hidden: false, divider: false });
    expect(screen.getByTestId("thread-overview-card-header")).toHaveTextContent("Overview");
  });
});
