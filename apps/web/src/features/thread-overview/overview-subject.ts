import type { Thread } from "@/transport";

/** What the overview card is about: an unsent new thread or a durable thread. */
export type OverviewSubject =
  | { readonly kind: "new-thread"; readonly workspaceId: string }
  | { readonly kind: "thread"; readonly thread: Thread };
