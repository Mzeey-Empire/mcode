// apps/web/src/lib/shortcuts.ts
//
// Thin integration layer: on each keydown, finds the matching keybinding,
// checks the "when" clause, and executes the associated command.

import {
  matchesKeyEvent,
  getKeybindings,
  getParsedKeybinding,
  loadKeybindings,
  addDynamicKeybinding,
  removeDynamicKeybindings,
  type Keybinding,
} from "./keybinding-manager";
import { evaluateWhen, setContext } from "./context-tracker";
import { executeCommand, registerCommand } from "./command-registry";
import defaultKeybindings from "@/config/default-keybindings.json";
import { useActionStore } from "@/stores/actionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Detect whether an element is an input that should set the inputFocused context. */
function isInputElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/** Detect whether the active element is inside xterm. */
function isTerminalFocused(el: Element | null): boolean {
  if (!el) return false;
  return (
    !!el.closest(".xterm") ||
    el.classList.contains("xterm-helper-textarea")
  );
}

/** Update the inputFocused and terminalFocused context based on the active element. */
function updateFocusContext(): void {
  const active = document.activeElement;
  setContext("inputFocused", isInputElement(active));
  setContext("terminalFocused", isTerminalFocused(active));
}

function handleKeyDown(e: KeyboardEvent): void {
  // Refresh focus context right before matching so evaluateWhen
  // has up-to-date inputFocused / terminalFocused values.
  updateFocusContext();

  const bindings = getKeybindings();
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (matchesKeyEvent(getParsedKeybinding(i), e) && evaluateWhen(binding.when)) {
      if (executeCommand(binding.command)) {
        e.preventDefault();
        return;
      }
      // Command not registered; continue scanning for another binding on the same key
    }
  }
}

/** Disposers for currently registered action commands and their keybindings. */
let actionCommandDisposers: (() => void)[] = [];

/**
 * Register keybindings for the active workspace's actions.
 *
 * Clears any previously registered action bindings first, then registers
 * a command and keybinding for each action that has a shortcut defined.
 */
export function registerActionKeybindings(): void {
  unregisterActionKeybindings();

  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!workspaceId) return;

  const actions = useActionStore.getState().getActions(workspaceId);
  for (const action of actions) {
    if (!action.shortcut) continue;

    const commandId = `action.run.${action.id}`;
    const commandDispose = registerCommand({
      id: commandId,
      title: `Run: ${action.name}`,
      category: "Project Actions",
      handler: () => {
        const threadId = useWorkspaceStore.getState().activeThreadId;
        if (!threadId || !workspaceId) return;
        useActionStore.getState().runAction(workspaceId, action.id, threadId);
      },
    });

    const bindingDispose = addDynamicKeybinding({
      command: commandId,
      key: action.shortcut,
      when: "!inputFocused && !terminalFocused",
    });

    actionCommandDisposers.push(commandDispose, bindingDispose);
  }
}

/**
 * Remove all action keybindings and unregister their commands.
 *
 * Also calls removeDynamicKeybindings as a safety net to clean up
 * any bindings not tracked via the disposers array.
 */
export function unregisterActionKeybindings(): void {
  for (const dispose of actionCommandDisposers) dispose();
  actionCommandDisposers = [];
  removeDynamicKeybindings("action.run.");
}

/**
 * Initialize the keybinding system.
 * Loads default keybindings (merged with optional user overrides),
 * attaches the global keydown listener, and sets up focus tracking.
 * Also subscribes to workspace and action store changes to keep action
 * keybindings in sync with the active workspace.
 */
export function initShortcuts(overrides?: Keybinding[]): () => void {
  loadKeybindings(defaultKeybindings as Keybinding[], overrides);
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("focusin", updateFocusContext);
  document.addEventListener("focusout", updateFocusContext);

  // Re-register action keybindings when active workspace changes.
  // Both stores use plain `create` without subscribeWithSelector, so we
  // compare the relevant slice manually to avoid spurious re-registrations.
  const unsubWorkspace = useWorkspaceStore.subscribe((state, prevState) => {
    if (state.activeWorkspaceId !== prevState.activeWorkspaceId) {
      registerActionKeybindings();
    }
  });

  const unsubActions = useActionStore.subscribe((state, prevState) => {
    if (state.actionsByWorkspace !== prevState.actionsByWorkspace) {
      registerActionKeybindings();
    }
  });

  return () => {
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("focusin", updateFocusContext);
    document.removeEventListener("focusout", updateFocusContext);
    unsubWorkspace();
    unsubActions();
    unregisterActionKeybindings();
  };
}

/** Get all active keybindings. */
export { getKeybindings } from "./keybinding-manager";
/** Load keybindings from defaults and optional user overrides. */
export { loadKeybindings } from "./keybinding-manager";
/** Return all currently registered commands. */
export { getAllCommands } from "./command-registry";
/** Register a command and return a disposer that unregisters it. */
export { registerCommand } from "./command-registry";
