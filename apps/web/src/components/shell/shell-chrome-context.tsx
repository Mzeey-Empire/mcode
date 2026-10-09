import { createContext, useContext, useMemo, type ReactNode } from "react";

/** Layout facts the window headers need from the app shell. */
export interface ShellChrome {
  /** The docked sidebar is showing, so its header owns the sidebar controls. */
  readonly sidebarDocked: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

const ShellChromeContext = createContext<ShellChrome>({
  sidebarDocked: true,
  canGoBack: false,
  canGoForward: false,
});

/** Provide the shell layout facts to every header below it. */
export function ShellChromeProvider({
  sidebarDocked,
  canGoBack,
  canGoForward,
  children,
}: ShellChrome & { readonly children: ReactNode }) {
  const value = useMemo(
    () => ({ sidebarDocked, canGoBack, canGoForward }),
    [sidebarDocked, canGoBack, canGoForward],
  );
  return <ShellChromeContext.Provider value={value}>{children}</ShellChromeContext.Provider>;
}

/** Read the shell layout facts. */
export function useShellChrome(): ShellChrome {
  return useContext(ShellChromeContext);
}
