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
        // jsdom returns zero-area rects, but a real observer cannot report
        // isIntersecting with an empty intersectionRect. Consumers that gate on
        // intersectionRect.width (e.g. MermaidBlock) would wait for the timeout.
        const measured = target.getBoundingClientRect();
        const rect = (
          measured.width > 0 && measured.height > 0
            ? measured
            : { x: 0, y: 0, top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, toJSON: () => ({}) }
        ) as DOMRectReadOnly;
        const entry = {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          intersectionRect: rect,
          boundingClientRect: rect,
          rootBounds: null,
          time: 0,
        } as IntersectionObserverEntry;
        // Real observers never fire synchronously from observe(); a sync call
        // breaks consumers that initialize state after observing (TDZ).
        queueMicrotask(() => {
          this.callback([entry], this as unknown as IntersectionObserver);
        });
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
  // With getAnimations defined, Base UI waits a frame for popup exit animations
  // that jsdom never runs, so popovers stay mounted past assertions. Its own
  // kill switch restores the synchronous path used when the API is absent.
  Object.defineProperty(globalThis, "BASE_UI_ANIMATIONS_DISABLED", {
    writable: true,
    configurable: true,
    value: true,
  });
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
