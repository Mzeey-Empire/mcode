import { createContext } from "react";

/**
 * Host element inside the Review toolbar row that the file-list controls
 * portal into. Null when no toolbar slot is mounted (tests, standalone
 * FileList), in which case the controls render inline above the diff.
 */
export const ReviewToolbarSlotContext = createContext<HTMLElement | null>(null);
