import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Picker, type PickerProps, type PickerStatus } from "@/components/ui/picker";

interface Branch {
  readonly name: string;
  readonly protected?: boolean;
}

const PAGE = 50;
const SOURCE: Branch[] = Array.from({ length: 568 }, (_, index) => ({
  name: `branch-${String(index).padStart(3, "0")}`,
  protected: index === 1,
}));
const TABS = [
  { id: "branches", label: "Branches" },
  { id: "prs", label: "Pull requests" },
];

const ROW_PX = 33;
const VIEWPORT_PX = 172;

// jsdom does no layout. Give the listbox a 172px viewport over 33px rows so the scroll math runs.
const layoutProps = ["scrollHeight", "clientHeight"] as const;
const originals = layoutProps.map((prop) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "listbox" ? this.childElementCount * ROW_PX : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "listbox" ? VIEWPORT_PX : 0;
    },
  });
});
afterAll(() => {
  layoutProps.forEach((prop, index) => {
    const original = originals[index];
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
  });
});

/** A fake paged source: filters by query and serves 50 rows per page, only when the test says so. */
function PagedPicker(props: Partial<PickerProps<Branch>> & { readonly pages?: number; readonly status?: PickerStatus }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("branches");
  const matches = SOURCE.filter((branch) => branch.name.includes(query));
  const items = matches.slice(0, PAGE * (props.pages ?? 1));
  return (
    <Picker<Branch>
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      query={query}
      onQueryChange={setQuery}
      items={items}
      total={matches.length}
      status="ready"
      renderItem={(branch) => ({ key: branch.name, name: branch.name, mono: true, disabled: branch.protected })}
      onSelect={() => {}}
      {...props}
    />
  );
}

function scrollListTo(remainingPx: number) {
  const list = screen.getByRole("listbox");
  list.scrollTop = list.scrollHeight - list.clientHeight - remainingPx;
  fireEvent.scroll(list);
}

describe("Picker", () => {
  it("counts the loaded page", () => {
    render(<PagedPicker />);
    expect(screen.getByText("Showing 50 of 568")).toBeInTheDocument();
  });

  it("asks for the next page once per page as the list nears its end", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<PagedPicker onLoadMore={onLoadMore} />);
    expect(onLoadMore).not.toHaveBeenCalled();

    scrollListTo(ROW_PX * 10);
    expect(onLoadMore).not.toHaveBeenCalled();
    scrollListTo(ROW_PX * 2);
    scrollListTo(0);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<PagedPicker onLoadMore={onLoadMore} pages={2} />);
    expect(screen.getByText("Showing 100 of 568")).toBeInTheDocument();
    scrollListTo(ROW_PX * 2);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("asks for the same page again after it fails and the user retries", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<PagedPicker onLoadMore={onLoadMore} />);
    scrollListTo(0);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<PagedPicker onLoadMore={onLoadMore} status={{ failed: "Couldn't load more branches" }} />);
    rerender(<PagedPicker onLoadMore={onLoadMore} />);
    scrollListTo(0);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("stops asking once every row is loaded", () => {
    const onLoadMore = vi.fn();
    render(<PagedPicker onLoadMore={onLoadMore} pages={12} />);
    expect(screen.getByText("Showing 568 of 568")).toBeInTheDocument();
    scrollListTo(0);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("scrolls the selection into view on open and the highlight on arrow keys, but never on hover", () => {
    // jsdom has no scrollIntoView, so install a spy for this test only.
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    onTestFinished(() => {
      if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    render(<PagedPicker selectedKey="branch-040" />);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("option", { name: "branch-040" }));
    scrollIntoView.mockClear();

    fireEvent.mouseMove(screen.getByRole("option", { name: "branch-004" }));
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("option", { name: "branch-005" }));
  });

  it("does not ask for more while a page is loading", () => {
    const onLoadMore = vi.fn();
    render(<PagedPicker onLoadMore={onLoadMore} status="loading" />);
    scrollListTo(0);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("shows the bottom fade only while rows remain below, and the top fade only once scrolled", () => {
    const { container } = render(<PagedPicker />);
    const fade = (edge: string) => container.querySelector(`[data-slot="picker-fade-${edge}"]`);
    expect(fade("top")).toBeNull();
    expect(fade("bottom")).not.toBeNull();
    scrollListTo(0);
    expect(fade("top")).not.toBeNull();
    expect(fade("bottom")).toBeNull();
  });

  it("moves the highlight with the arrow keys, skips disabled rows, and picks with Enter", () => {
    const onSelect = vi.fn();
    render(<PagedPicker onSelect={onSelect} />);
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(SOURCE[2]);
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "branch-002" }).id);

    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(SOURCE[0]);
  });

  it("starts the highlight on the selected row and marks it selected", () => {
    render(<PagedPicker selectedKey="branch-007" />);
    const option = screen.getByRole("option", { name: "branch-007" });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", option.id);
  });

  it("keeps the query when switching tabs", () => {
    const onTabChange = vi.fn();
    render(<PagedPicker onTabChange={onTabChange} />);
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "branch-01" } });
    fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
    expect(onTabChange).toHaveBeenCalledWith("prs");
    expect(search).toHaveValue("branch-01");
    expect(screen.getAllByRole("option")).toHaveLength(10);
  });

  it("says nothing matches and offers the other tab", () => {
    const onTabChange = vi.fn();
    render(<PagedPicker onTabChange={onTabChange} emptySwitch={{ tabId: "prs", label: "matches in Pull requests" }} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sidebar-v2" } });
    expect(screen.getByText("Nothing matches “sidebar-v2”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show matches in Pull requests" }));
    expect(onTabChange).toHaveBeenCalledWith("prs");
  });

  it("shows the failure title, the raw detail, and Retry in place of an empty list", () => {
    const onRetry = vi.fn();
    render(
      <PagedPicker
        items={[]}
        status={{ failed: "Couldn't list branches", detail: "fatal: not a git repository" }}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't list branches");
    expect(alert).toHaveTextContent("fatal: not a git repository");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps the loaded rows when a later page fails", () => {
    render(<PagedPicker status={{ failed: "Couldn't load more branches" }} onRetry={() => {}} />);
    expect(screen.getAllByRole("option")).toHaveLength(50);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load more branches");
  });

  it("names why a disabled row is unavailable", () => {
    render(
      <PagedPicker
        renderItem={(branch) => ({
          key: branch.name,
          name: branch.name,
          disabled: branch.protected,
          disabledReason: branch.protected ? "Protected branch" : undefined,
        })}
      />,
    );
    expect(screen.getByRole("option", { name: "branch-001" })).toHaveAccessibleDescription("Protected branch");
  });

  it("hides the count while the total is unknown", () => {
    render(<PagedPicker total={null} />);
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });
});
