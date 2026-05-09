import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { SettingsView } from "@/components/settings/SettingsView";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useUpdateStore } from "@/stores/updateStore";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import { TerminalPanel } from "@/components/terminal";
import { RightPanel } from "@/components/panels/RightPanel";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { ProjectSelectorLanding } from "@/components/projects/ProjectSelectorLanding";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { resizeMessageCache } from "@/stores/messageCache";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { initShortcuts } from "@/lib/shortcuts";
import { registerCommand } from "@/lib/command-registry";
import { setContext } from "@/lib/context-tracker";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { getTransport } from "@/transport";
import { useIdleReclamation } from "@/hooks/useIdleReclamation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastContainer } from "@/components/Toast";
import type { SettingsSection } from "@/components/settings/settings-nav";

/**
 * Tracks threads for which a PTY creation RPC is already in flight.
 * Prevents duplicate terminals when Ctrl+J is pressed rapidly or when
 * the toggle fires twice before the first creation resolves.
 */
const terminalCreationInFlight = new Set<string>();

/** Root application component. Initializes WS transport and push listeners. */
export function App() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const threadCacheSize = useSettingsStore((s) => s.settings.performance.threadCacheSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("model");
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const pendingNewThread = useWorkspaceStore((s) => s.pendingNewThread);
  // Landing is the default whenever no thread is active. The new-thread composer
  // takes precedence so the user can compose against an active workspace without
  // bouncing back to the project list.
  const showLanding = activeThreadId === null && !pendingNewThread;
  useIdleReclamation();

  useEffect(() => {
    startPushListeners();
    useSettingsStore.getState().fetch();
    return () => stopPushListeners();
  }, []);

  // Mirror the user-controlled message-cache capacity into the runtime cache.
  // Runs on every settings change; LruCache.resize is a no-op when capacity is unchanged.
  useEffect(() => {
    resizeMessageCache(threadCacheSize);
  }, [threadCacheSize]);

  // Hydrate app version + auto-updater status from the Electron preload bridge.
  useEffect(() => {
    const bridge = window.desktopBridge?.app;
    if (!bridge) return;

    void bridge.getVersion().then((v) => useUpdateStore.getState().setVersion(v));
    void bridge.getUpdateStatus().then((s) => {
      if (s && useUpdateStore.getState().status.state === "idle") {
        useUpdateStore.getState().setStatus(s as UpdateStatus);
      }
    });

    const listener = bridge.onUpdateStatus((status) => {
      useUpdateStore.getState().setStatus(status);
    });
    return () => bridge.offUpdateStatus(listener);
  }, []);

  // Listen for deep-link requests to open a specific settings section
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent<{ section: SettingsSection }>).detail?.section ?? "model";
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener("mcode:open-settings", handler);
    return () => window.removeEventListener("mcode:open-settings", handler);
  }, []);

  // Keep settingsOpen context in sync
  useEffect(() => {
    setContext("settingsOpen", settingsOpen);
  }, [settingsOpen]);

  // Landing-only shortcuts (e.g. mod+Enter for new project) should not fire
  // when settings covers the main pane or chat is visible.
  useEffect(() => {
    setContext("showLanding", showLanding && !settingsOpen);
  }, [showLanding, settingsOpen]);

  // Register all commands and initialize shortcuts
  useEffect(() => {
    const cleanup = initShortcuts();

    const disposers = [
      registerCommand({
        id: "palette.open",
        title: "Open Command Palette",
        category: "Navigation",
        handler: () => useCommandPaletteStore.getState().open(),
      }),
      // Backward-compat alias — mod+p still opens the palette
      registerCommand({
        id: "commandPalette.toggle",
        title: "Command Palette",
        category: "General",
        handler: () => {
          const palette = useCommandPaletteStore.getState();
          if (palette.isOpen) palette.close();
          else palette.open();
        },
      }),
      registerCommand({
        id: "escape.handle",
        title: "Escape",
        category: "General",
        handler: () => {
          const palette = useCommandPaletteStore.getState();
          if (palette.isOpen) {
            palette.close();
            return;
          }
          const ui = useUiStore.getState();
          if (ui.shortcutHelpOpen) {
            ui.setShortcutHelpOpen(false);
          } else {
            useWorkspaceStore.getState().setActiveThread(null);
          }
        },
      }),
      registerCommand({
        id: "thread.new",
        title: "New Thread",
        category: "Thread",
        handler: () => {
          useCommandPaletteStore.getState().open({
            intent: "projects",
            nextAction: "newThread",
          });
        },
      }),
      registerCommand({
        // Command id stays `workspace.new` for shortcut/persistence stability
        // even though the user-facing label is now "New Project".
        id: "workspace.new",
        title: "New Project",
        category: "Project",
        handler: () => {
          // Reuse the same browse-mode entry the landing's "+ Add project"
          // button uses, instead of the previous orphan custom event.
          useCommandPaletteStore.getState().open({ intent: "addProject" });
        },
      }),
      registerCommand({
        id: "sidebar.toggle",
        title: "Toggle Sidebar",
        category: "View",
        handler: () => useUiStore.getState().toggleSidebar(),
      }),
      registerCommand({
        id: "terminal.toggle",
        title: "Toggle Terminal",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (!tid) return;
          const store = useTerminalStore.getState();
          const panel = store.terminalPanelByThread[tid];
          const isCurrentlyVisible = panel?.visible ?? false;
          store.toggleTerminalPanel(tid);
          // Auto-create a terminal when opening a panel that has none.
          if (!isCurrentlyVisible && !terminalCreationInFlight.has(tid)) {
            const terminals = store.terminals[tid];
            if (!terminals || terminals.length === 0) {
              terminalCreationInFlight.add(tid);
              try {
                const transport = getTransport();
                transport
                  .terminalCreate(tid)
                  .then((ptyId) => {
                    terminalCreationInFlight.delete(tid);
                    const currentStore = useTerminalStore.getState();
                    const currentPanel = currentStore.terminalPanelByThread[tid];
                    // Panel was closed while creation was in flight — dispose the orphaned PTY.
                    if (!currentPanel?.visible) {
                      transport.terminalKill(ptyId).catch(() => {});
                      return;
                    }
                    // Another terminal may have been created (e.g. user clicked "New terminal")
                    // while the RPC was in flight — avoid duplicates.
                    const currentTerminals = currentStore.terminals[tid];
                    if (!currentTerminals || currentTerminals.length === 0) {
                      currentStore.addTerminal(tid, ptyId);
                    } else {
                      transport.terminalKill(ptyId).catch(() => {});
                    }
                  })
                  .catch(() => {
                    terminalCreationInFlight.delete(tid);
                  });
              } catch {
                terminalCreationInFlight.delete(tid);
              }
            }
          }
        },
      }),
      registerCommand({
        id: "settings.open",
        title: "Open Settings",
        category: "General",
        handler: () => {
          window.dispatchEvent(
            new CustomEvent("mcode:open-settings", {
              detail: { section: "model" },
            }),
          );
        },
      }),
      registerCommand({
        id: "shortcuts.help",
        title: "Keyboard Shortcuts",
        category: "General",
        handler: () => {
          const store = useUiStore.getState();
          store.setShortcutHelpOpen(!store.shortcutHelpOpen);
        },
      }),
      registerCommand({
        id: "tasks.toggle",
        title: "Toggle Tasks Panel",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (!tid) return;
          const { getRightPanel, showRightPanel, setRightPanelTab, hideRightPanel } =
            useDiffStore.getState();
          const panel = getRightPanel(tid);
          if (!panel.visible) {
            showRightPanel(tid);
            setRightPanelTab(tid, "tasks");
          } else if (panel.activeTab !== "tasks") {
            setRightPanelTab(tid, "tasks");
          } else {
            hideRightPanel(tid);
          }
        },
      }),
      registerCommand({
        id: "changes.toggle",
        title: "Toggle Changes Panel",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (!tid) return;
          const { getRightPanel, showRightPanel, setRightPanelTab, hideRightPanel } =
            useDiffStore.getState();
          const panel = getRightPanel(tid);
          if (!panel.visible) {
            showRightPanel(tid);
            setRightPanelTab(tid, "changes");
          } else if (panel.activeTab !== "changes") {
            setRightPanelTab(tid, "changes");
          } else {
            hideRightPanel(tid);
          }
        },
      }),
      registerCommand({
        id: "preview.toggle",
        title: "Toggle Preview Panel",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (!tid) return;
          const { getRightPanel, showRightPanel, setRightPanelTab, hideRightPanel } =
            useDiffStore.getState();
          const panel = getRightPanel(tid);
          if (!panel.visible) {
            showRightPanel(tid);
            setRightPanelTab(tid, "preview");
          } else if (panel.activeTab !== "preview") {
            setRightPanelTab(tid, "preview");
          } else {
            hideRightPanel(tid);
          }
        },
      }),
      // Thread switching: Cmd+1 through Cmd+9
      ...Array.from({ length: 9 }, (_, i) =>
        registerCommand({
          id: `thread.goTo${i + 1}`,
          title: `Go to Thread ${i + 1}`,
          category: "Thread",
          handler: () => {
            const threads = useWorkspaceStore.getState().threads;
            if (threads[i]) {
              useWorkspaceStore.getState().setActiveThread(threads[i].id);
            }
          },
        }),
      ),
    ];

    return () => {
      cleanup();
      disposers.forEach((d) => d());
    };
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = (dark: boolean) => root.classList.toggle("dark", dark);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(mq.matches);
      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } else {
      applyTheme(theme === "dark");
    }
  }, [theme]);

  return (
    <TooltipProvider delay={400}>
      {/* Floating-panel layout: page chrome is a darker tone (--page) with small
          gaps between panels. Each panel renders as a rounded surface that
          appears lifted off the chrome — no inter-panel divider lines required. */}
      <div className="flex h-screen flex-col overflow-hidden bg-page text-foreground">
        <ConnectionBanner />
        <UpdateBanner />
        <div className="flex flex-1 gap-1.5 overflow-hidden p-1.5">
          {/* Settings view force-expands the sidebar so the settings nav is reachable.
              When the sidebar is hidden, the chat panel claims the full width and the
              reveal button lives inline in the chat header (see ChatView). */}
          {(!sidebarCollapsed || settingsOpen) && (
            <div className="flex shrink-0 overflow-hidden rounded-lg shadow-sm">
              <Sidebar
                settingsOpen={settingsOpen}
                settingsSection={settingsSection}
                onSettingsSection={setSettingsSection}
                onOpenSettings={() => setSettingsOpen(true)}
                onCloseSettings={() => setSettingsOpen(false)}
              />
            </div>
          )}
          <div className="flex flex-1 flex-col gap-1.5 overflow-hidden">
            <div className="flex flex-1 gap-1.5 overflow-hidden">
              <main className="flex-1 overflow-hidden rounded-lg bg-background shadow-sm">
                {settingsOpen ? (
                  <SettingsView section={settingsSection} />
                ) : showLanding ? (
                  <div className="flex h-full flex-col">
                    {/* When the sidebar is collapsed, show the reveal button so the
                        user can re-expand it from the landing page. */}
                    {sidebarCollapsed && (
                      <div className="flex h-11 shrink-0 items-center px-2">
                        <SidebarRevealButton />
                      </div>
                    )}
                    <ProjectSelectorLanding />
                  </div>
                ) : (
                  <ChatView />
                )}
              </main>
              {!settingsOpen && !showLanding && <RightPanel />}
            </div>
            {!settingsOpen && !showLanding && <TerminalPanel />}
          </div>
        </div>
      </div>
      <CommandPalette />
      <ShortcutHelpDialog />
      <ToastContainer />
    </TooltipProvider>
  );
}
