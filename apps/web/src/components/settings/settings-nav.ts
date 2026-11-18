import type { ComponentType } from "react";
import { Bug, Info, Keyboard, MessagesSquare, Plug, SlidersHorizontal, SquareTerminal, type LucideIcon } from "lucide-react";
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

/** One settings page: its id, sidebar label and icon, and the component that renders it. */
export interface SettingsPage {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly component: ComponentType;
}

/** Settings pages in sidebar order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "general", label: "General", icon: SlidersHorizontal, component: GeneralSection },
  { id: "threads", label: "Threads", icon: MessagesSquare, component: ThreadsSection },
  { id: "providers", label: "Providers", icon: Plug, component: ProvidersSection },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, component: TerminalSection },
  { id: "keyboard", label: "Keyboard shortcuts", icon: Keyboard, component: KeyboardShortcutsSection },
  { id: "troubleshooting", label: "Troubleshooting", icon: Bug, component: TroubleshootingSection },
  { id: "about", label: "About", icon: Info, component: AboutSection },
];
