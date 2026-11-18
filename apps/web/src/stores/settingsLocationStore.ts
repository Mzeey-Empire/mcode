import { create } from "zustand";
import type { SettingsSection } from "@/components/settings/settings-sections";
import type { SettingId } from "@/components/settings/setting-def";

/** The row a location link opened. The nonce changes on every open, so choosing the same link again scrolls again. */
export interface SettingsHit {
  readonly id: SettingId;
  readonly nonce: number;
}

/** Where Settings is pointing: the page, the search text and the marked row. One owner for sidebar and canvas. */
export interface SettingsLocationState {
  readonly page: SettingsSection;
  /** Raw text in the search field. Results show while it is non-blank and no hit is open. */
  readonly query: string;
  /** Setting whose row is marked; its page is always `page` (set together by openHit). */
  readonly hit: SettingsHit | null;
  /** Setting whose location link opened the last hit; Back to results returns focus to it. */
  readonly returnTo: SettingId | null;
  /**
   * Changes when page navigation moves to another page, which starts a new Settings visit. Opening a search hit does
   * not change it, so edits made from results stay in the visit when the hit opens its page.
   */
  readonly pageVisit: number;
  /** Page link, deep link, history restore: clears query and hit. */
  openPage(page: SettingsSection): void;
  /** Typing: clears hit, keeps page so clearing the field returns to it. */
  setQuery(query: string): void;
  /** Location link in a result: sets page and hit together, keeps query for Back to results. */
  openHit(target: { readonly page: SettingsSection; readonly id: SettingId; readonly from: SettingId }): void;
  /** Back to results: clears the hit only. */
  backToResults(): void;
  /** Settings closed: forget the search and return to General, so an open that names no page lands there. */
  leave(): void;
}

/** What the Settings canvas shows. */
export type SettingsCanvas =
  | { readonly kind: "results"; readonly query: string }
  | { readonly kind: "page"; readonly page: SettingsSection; readonly hit: SettingsHit | null };

/** The one rule for results versus page: a non-blank query with no open hit shows results. */
export function selectSettingsCanvas(state: Pick<SettingsLocationState, "page" | "query" | "hit">): SettingsCanvas {
  if (state.hit === null && state.query.trim() !== "") return { kind: "results", query: state.query };
  return { kind: "page", page: state.page, hit: state.hit };
}

/** True when the sidebar should show "Back to results". */
export function selectCanGoBackToResults(state: Pick<SettingsLocationState, "query" | "hit">): boolean {
  return state.hit !== null && state.query.trim() !== "";
}

/** Module-level so the nonce never repeats, even after Back to results clears the hit. */
let hitOpenCount = 0;

/** Settings location store; replaces the app shell's own page state. */
export const useSettingsLocation = create<SettingsLocationState>()((set) => ({
  page: "general",
  query: "",
  hit: null,
  returnTo: null,
  pageVisit: 0,
  openPage: (page) =>
    set((state) => ({ page, query: "", hit: null, returnTo: null, pageVisit: state.page === page ? state.pageVisit : state.pageVisit + 1 })),
  setQuery: (query) => set({ query, hit: null, returnTo: null }),
  openHit: ({ page, id, from }) => set({ page, hit: { id, nonce: ++hitOpenCount }, returnTo: from }),
  backToResults: () => set({ hit: null }),
  leave: () => set({ page: "general", query: "", hit: null, returnTo: null }),
}));
