/**
 * Keys that open the command menu at the start of a word. `/` lists everything; a currency key is the shorter path
 * to skills and plugins only. The trigger pattern is built from this list.
 */
export const MENU_TRIGGER_KEYS = ["/", "$", "£", "₦"] as const;

/** One of {@link MENU_TRIGGER_KEYS}. */
export type MenuTriggerKey = (typeof MENU_TRIGGER_KEYS)[number];

/** Where a trigger was typed: the editor text node, the key's offset in it, and the key. */
export type TriggerAnchor = { readonly nodeKey: string; readonly start: number; readonly key: MenuTriggerKey };

/** A trigger read before the caret: its anchor, the text typed after the key, and which entries it lists. */
export type MenuTrigger = { readonly anchor: TriggerAnchor; readonly query: string; readonly scope: "all" | "skills" };

/** The menu is open on a trigger, or closed, remembering the anchor Escape closed it on. */
export type SlashMenuState =
  | { readonly status: "closed"; readonly dismissed: TriggerAnchor | null }
  | { readonly status: "open"; readonly trigger: MenuTrigger };

/** What happened to the menu: the caret moved onto or off a trigger, Escape, a pick, or the editor losing focus. */
export type SlashMenuEvent =
  | { readonly type: "caretMoved"; readonly trigger: MenuTrigger | null }
  | { readonly type: "escaped" }
  | { readonly type: "picked" }
  | { readonly type: "blurred" };

const escapeForCharacterClass = (key: string) => key.replace(/[\\\]^-]/g, "\\$&");

/** A trigger key at the start of the text or after whitespace, then the word typed so far, up to the caret. */
const MENU_TRIGGER_RE = new RegExp(`(^|\\s)([${MENU_TRIGGER_KEYS.map(escapeForCharacterClass).join("")}])(\\S*)$`, "u");

function isMenuTriggerKey(key: string): key is MenuTriggerKey {
  return MENU_TRIGGER_KEYS.some((triggerKey) => triggerKey === key);
}

/** Reads a menu trigger from the text before the caret in the editor text node `nodeKey`. */
export function readMenuTrigger(nodeKey: string, textBeforeCaret: string): MenuTrigger | null {
  const match = MENU_TRIGGER_RE.exec(textBeforeCaret);
  if (!match) return null;
  const [, lead, key, query] = match;
  if (!isMenuTriggerKey(key)) return null;
  const scope = key === "/" ? "all" : "skills";
  // "$5", "£20" and "₦1,000" are money, so a currency key followed by a digit stays plain text.
  if (scope === "skills" && /^\d/.test(query)) return null;
  return {
    anchor: { nodeKey, start: match.index + lead.length, key },
    query,
    scope,
  };
}

/** The entries a trigger lists: names containing its query, and for a currency key only skills and plugins. */
export function filterMenuCommands<T extends { readonly name: string; readonly namespace: string }>(
  commands: readonly T[],
  { query, scope }: Pick<MenuTrigger, "query" | "scope">,
): T[] {
  const needle = query.toLowerCase();
  return commands.filter((command) => (
    (scope === "all" || command.namespace === "skill" || command.namespace === "plugin")
    && command.name.toLowerCase().includes(needle)
  ));
}

function sameAnchor(a: TriggerAnchor, b: TriggerAnchor): boolean {
  return a.nodeKey === b.nodeKey && a.start === b.start && a.key === b.key;
}

const CLOSED: SlashMenuState = { status: "closed", dismissed: null };

/** The closed state with nothing dismissed, reusing `state` when it already is that, so owners can skip a render. */
function closedClean(state: SlashMenuState): SlashMenuState {
  return state.status === "closed" && state.dismissed === null ? state : CLOSED;
}

function onCaretMoved(state: SlashMenuState, trigger: MenuTrigger | null): SlashMenuState {
  if (!trigger) return closedClean(state);
  if (state.status === "closed" && state.dismissed && sameAnchor(state.dismissed, trigger.anchor)) return state;
  return { status: "open", trigger };
}

/**
 * Applies a menu event. Escape remembers the trigger's anchor, so the menu stays closed while the user keeps typing
 * the same word; a trigger at another anchor, or the caret leaving every trigger, forgets it.
 */
export function slashMenuReducer(state: SlashMenuState, event: SlashMenuEvent): SlashMenuState {
  switch (event.type) {
    case "caretMoved":
      return onCaretMoved(state, event.trigger);
    case "escaped":
      return state.status === "open" ? { status: "closed", dismissed: state.trigger.anchor } : state;
    case "picked":
    case "blurred":
      return closedClean(state);
  }
}
