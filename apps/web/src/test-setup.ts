import "@testing-library/jest-dom/vitest";

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(String(key)) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(String(key));
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  };
}

// Polyfill window.matchMedia for jsdom (skip in node environment)
if (typeof window !== "undefined") {
  // Node 26 exposes a localStorage getter that returns undefined without a
  // persistence flag, which prevents Vitest's jsdom environment from installing storage.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: createTestStorage(),
  });
  // jsdom lacks the observers pierre's diff Virtualizer constructs at setup.
  if (!("IntersectionObserver" in window)) {
    class IntersectionObserverStub {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "IntersectionObserver", {
      writable: true,
      configurable: true,
      value: IntersectionObserverStub,
    });
  }
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      writable: true,
      configurable: true,
      value: ResizeObserverStub,
    });
  }
  // jsdom has no Web Animations API; Base UI's ScrollArea calls it on a timer.
  if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "getAnimations", {
      writable: true,
      configurable: true,
      value: () => [],
    });
  }
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
