import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { Thread } from "@/transport";
import type { OverviewSubject } from "./overview-subject";

/** Keeps an entry's hook mounted independently of its popover row. */
export function createOverviewEntryState<State>(useValue: (thread: Thread) => State) {
  const Context = createContext<State | null>(null);

  function ThreadProvider({ thread, children }: { thread: Thread; children: ReactNode }) {
    const value = useValue(thread);
    return <Context.Provider value={value}>{children}</Context.Provider>;
  }

  function Provider({ subject, children }: { subject: OverviewSubject; children: ReactNode }) {
    return subject.kind === "thread"
      ? <ThreadProvider thread={subject.thread}>{children}</ThreadProvider>
      : children;
  }

  function useEntryState() {
    const value = useContext(Context);
    if (value === null) throw new Error("Overview entry requires its state provider");
    return value;
  }

  return { Provider, useEntryState };
}

/** A registered entry or header action that may own state outliving the popover. */
export interface OverviewStateOwner {
  readonly id: string;
  readonly State?: ComponentType<{ subject: OverviewSubject; children: ReactNode }>;
}

/** Mounts registered state providers outside the content that closes and unmounts. */
export function OverviewEntryStateProviders({ entries, subject, children }: {
  entries: readonly OverviewStateOwner[];
  subject: OverviewSubject;
  children: ReactNode;
}) {
  return entries.reduceRight((content, { id, State }) => State
    ? <State key={id} subject={subject}>{content}</State>
    : content, children);
}
