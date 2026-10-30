import type { Thread } from "@/transport";

/**
 * What the overview card is about: an unsent new thread or a durable thread. A `readOnly` new-thread subject
 * shows the target of a thread that is already starting, so its rows open no picker.
 */
export type OverviewSubject =
  | { readonly kind: "new-thread"; readonly workspaceId: string; readonly readOnly?: boolean }
  | { readonly kind: "thread"; readonly thread: Thread };
