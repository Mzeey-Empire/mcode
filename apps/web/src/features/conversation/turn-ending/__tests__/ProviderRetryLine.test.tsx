import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ProviderRetryLine } from "../ProviderRetryLine";
import type { ProviderRetry } from "../provider-retry";

describe("ProviderRetryLine", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderLine(retry: Omit<ProviderRetry, "receivedAt">, providerLabel = "Codex") {
    return render(<ProviderRetryLine retry={{ ...retry, receivedAt: Date.now() }} providerLabel={providerLabel} />);
  }

  it("names the provider over the status, attempt and countdown", () => {
    renderLine({ errorStatus: 502, attempt: 2, maxRetries: 10, delayMs: 8000 });
    expect(screen.getByRole("status")).toHaveTextContent("Codex is retrying502 Bad Gateway · attempt 2 of 10 · next in 8s");
  });

  it("leaves out parts the provider did not report", () => {
    const { container } = renderLine({ attempt: 3 }, "Claude");
    expect(screen.getByText("Claude is retrying")).toBeInTheDocument();
    expect(screen.getByText("attempt 3")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|next in/);
  });

  it("names an unlisted status by its code", () => {
    renderLine({ errorStatus: 520 });
    expect(screen.getByText("HTTP 520")).toBeInTheDocument();
  });

  it("shows only the title when nothing is known", () => {
    renderLine({});
    expect(screen.getByRole("status")).toHaveTextContent(/^Codex is retrying$/);
  });

  it("counts down each second and drops the countdown at zero", () => {
    renderLine({ attempt: 1, delayMs: 2000 });
    expect(screen.getByText("attempt 1 · next in 2s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("attempt 1 · next in 1s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("attempt 1")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the countdown from a newer notice that lands between ticks", () => {
    const { rerender } = renderLine({ attempt: 1, delayMs: 1000 });
    act(() => vi.advanceTimersByTime(1500));
    rerender(<ProviderRetryLine retry={{ attempt: 2, delayMs: 4000, receivedAt: Date.now() }} providerLabel="Codex" />);
    expect(screen.getByText("attempt 2 · next in 4s")).toBeInTheDocument();
  });
});
