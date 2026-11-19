import type { ComponentType } from "react";
import { GeneralSection } from "./sections/GeneralSection";
import { ThreadsSection } from "./sections/ThreadsSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { TerminalSection } from "@/features/terminal";
import { KeyboardShortcutsSection } from "./sections/KeyboardShortcutsSection";
import { TroubleshootingSection } from "./sections/TroubleshootingSection";
import { AboutSection } from "./sections/AboutSection";

/** Available settings pages in the app. */
export type SettingsSection =
  | "general"
  | "threads"
  | "providers"
  | "terminal"
  | "keyboard"
  | "troubleshooting"
  | "about";

/** One settings page: its id, sidebar label, and the component that renders it. */
export interface SettingsPage {
  readonly id: SettingsSection;
  readonly label: string;
  readonly component: ComponentType;
}

/** Settings pages in sidebar order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "general", label: "General", component: GeneralSection },
  { id: "threads", label: "Threads", component: ThreadsSection },
  { id: "providers", label: "Providers", component: ProvidersSection },
  { id: "terminal", label: "Terminal", component: TerminalSection },
  { id: "keyboard", label: "Keyboard shortcuts", component: KeyboardShortcutsSection },
  { id: "troubleshooting", label: "Troubleshooting", component: TroubleshootingSection },
  { id: "about", label: "About", component: AboutSection },
];
