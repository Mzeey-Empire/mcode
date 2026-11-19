import type { ComponentType } from "react";
import type { SettingsSection } from "./settings-sections";

declare const settingDefBrand: unique symbol;

/** Stable id `${page}.${key}`, made by settingsPage from the record key, so it is unique by construction. */
export type SettingId = `${SettingsSection}.${string}`;

/** A location label inside a page. The page renders the same object, so the title has one copy. */
export interface SettingsGroupRef {
  readonly title: string;
  readonly description?: string;
}

/** A row that only applies to some choices, such as Thinking for Haiku. Only these rows call hooks from their definition. */
export interface SettingCondition {
  /** Hook: true when the row applies to the current choices. Called unconditionally by a dedicated component. */
  readonly useApplies: () => boolean;
  /** Shown in a search result instead of the control when the row does not apply. */
  readonly reason: string;
  /** Setting on the same page whose row is marked when this row does not apply. */
  readonly anchor: SettingId;
}

/** Where a row is drawn: on its page, as the best search match, or as another match (no hint). */
export type SettingVariant = "page" | "best" | "match";

/** Props a custom whole row receives. */
export interface SettingRowProps {
  readonly def: SettingDef;
  readonly variant: SettingVariant;
}

interface SettingInputBase {
  readonly label: string;
  /** Static description. Searchable; live status text belongs in the row, never here. */
  readonly hint?: string;
  readonly group?: SettingsGroupRef;
  /** Space-separated extra words the user might type. */
  readonly synonyms?: string;
  /** Phrases describing a symptom this setting fixes, e.g. "threads deleted too soon". */
  readonly problems?: string;
  /** Store key the control writes, for the later revert layer. `terminal.*` keys are written through the terminal store. */
  readonly configKey?: string;
  /** Platform check, pure and cheap: false hides the row everywhere, search included (e.g. no desktop bridge). */
  readonly exists?: () => boolean;
  readonly when?: SettingCondition;
}

/** A standard row: label and hint on the left, a control that takes no props and owns its store access on the right. */
interface ControlSettingInput extends SettingInputBase {
  readonly Control: ComponentType;
  readonly Row?: never;
}

/** A custom whole row (live hint, provider row, profile list). It must render through SettingRowFrame or call useSettingHit. */
interface RowSettingInput extends SettingInputBase {
  readonly Row: ComponentType<SettingRowProps>;
  readonly Control?: never;
}

/** What a page module writes for one setting. */
export type SettingInput = ControlSettingInput | RowSettingInput;

/** A registered setting. Only settingsPage can make one, so a row cannot exist without a page list. */
export type SettingDef = SettingInput & {
  readonly [settingDefBrand]: true;
  readonly id: SettingId;
  readonly page: SettingsSection;
};

/** Declares a page's settings, keyed by a name unique within the page. `all` keeps declaration order. */
export function settingsPage<const K extends string>(
  page: SettingsSection,
  inputs: { readonly [Key in K]: SettingInput },
): { readonly [Key in K]: SettingDef } & { readonly all: readonly SettingDef[] } {
  const defs = {} as Record<K, SettingDef>;
  for (const key of Object.keys(inputs) as K[]) {
    defs[key] = { ...inputs[key], id: `${page}.${key}`, page } as SettingDef;
  }
  return Object.assign(defs, { all: Object.values<SettingDef>(defs) });
}

/** Names a group of rows on a page; the page passes the same object to SettingsGroup. */
export function settingsGroup(title: string, description?: string): SettingsGroupRef {
  return description === undefined ? { title } : { title, description };
}
