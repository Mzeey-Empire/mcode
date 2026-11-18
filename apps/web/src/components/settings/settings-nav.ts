import type { ComponentType } from "react";
import { Bug, Info, Keyboard, MessagesSquare, Plug, SlidersHorizontal, SquareTerminal, type LucideIcon } from "lucide-react";
import { GENERAL, GeneralSection } from "./sections/GeneralSection";
import { THREADS, ThreadsSection } from "./sections/ThreadsSection";
import { PROVIDERS, ProvidersSection } from "./sections/ProvidersSection";
import { TERMINAL, TerminalSection } from "@/features/terminal";
import { KEYBOARD, KeyboardShortcutsSection } from "./sections/KeyboardShortcutsSection";
import { TROUBLESHOOTING, TroubleshootingSection } from "./sections/TroubleshootingSection";
import { ABOUT, AboutSection } from "./sections/AboutSection";
import type { SettingDef } from "./setting-def";
import type { SettingsSection } from "./settings-sections";

export type { SettingsSection } from "./settings-sections";

/** One settings page: its id, sidebar label and icon, the component that renders it, and every setting it renders. */
export interface SettingsPage {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly component: ComponentType;
  /** Every setting the page renders. Search and the completeness test read this. */
  readonly settings: readonly SettingDef[];
}

/** Settings pages in sidebar order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "general", label: "General", icon: SlidersHorizontal, component: GeneralSection, settings: GENERAL.all },
  { id: "threads", label: "Threads", icon: MessagesSquare, component: ThreadsSection, settings: THREADS.all },
  { id: "providers", label: "Providers", icon: Plug, component: ProvidersSection, settings: PROVIDERS.all },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, component: TerminalSection, settings: TERMINAL.all },
  { id: "keyboard", label: "Keyboard shortcuts", icon: Keyboard, component: KeyboardShortcutsSection, settings: KEYBOARD.all },
  { id: "troubleshooting", label: "Troubleshooting", icon: Bug, component: TroubleshootingSection, settings: TROUBLESHOOTING.all },
  { id: "about", label: "About", icon: Info, component: AboutSection, settings: ABOUT.all },
];
