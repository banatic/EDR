import { useEffect } from "react";
import { useEventStore } from "../store/eventStore";
import type { TabId } from "../types";

interface Options {
  /** Toggle the help modal open/closed (called for `?`). */
  onToggleHelp: () => void;
  /** When true, the help modal owns Esc — only Esc-to-close is allowed. */
  helpOpen: boolean;
}

/**
 * Returns true when the keydown originated from a text input surface
 * where typed characters belong to the user, not to global hotkeys.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Global keyboard shortcut wiring. Registers a single window keydown
 * listener and dispatches store actions for the conventional bindings:
 *
 *   Esc  – close detail panel → clear search → clear focused PID
 *   /    – focus the TopBar search input
 *   1-4  – switch tab (timeline / graph / network / files)
 *   b    – toggle bookmark on the selected event
 *   ?    – toggle help modal
 *   m    – toggle monitoring/investigation mode
 *   f    – clear focused PID
 *
 * Inputs receive characters normally; only `Esc` is honored from
 * within a text field (to clear/leave the search box).
 */
export function useKeyboardShortcuts({ onToggleHelp, helpOpen }: Options): void {
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      // Ignore key combos with modifiers we don't bind, so platform
      // shortcuts (copy/paste, devtools, etc.) keep working.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key;
      const typing = isTypingTarget(event.target);

      // While the help modal is open, only Esc closes it. Everything
      // else is suppressed so the user can't accidentally toggle tabs
      // from behind the overlay.
      if (helpOpen) {
        if (key === "Escape") {
          event.preventDefault();
          onToggleHelp();
        }
        return;
      }

      const store = useEventStore.getState();

      if (key === "Escape") {
        // Priority: detail panel → search → focused pid. Stops at the
        // first non-empty surface so a single Esc undoes one thing.
        if (store.selectedEventId !== null) {
          store.setSelectedEvent(null);
        } else if (store.search.length > 0) {
          store.setSearch("");
          // Blur the input so subsequent keys hit global handlers.
          if (event.target instanceof HTMLInputElement) event.target.blur();
        } else if (store.focusedPid !== null) {
          store.setFocusedPid(null);
        }
        return;
      }

      // From here on, typing inside an input must not trigger globals.
      if (typing) return;

      switch (key) {
        case "/": {
          event.preventDefault();
          const el = document.getElementById("topbar-search");
          if (el instanceof HTMLInputElement) el.focus();
          return;
        }
        case "?": {
          event.preventDefault();
          onToggleHelp();
          return;
        }
        case "1":
        case "2":
        case "3":
        case "4": {
          const tabs: TabId[] = ["timeline", "graph", "network", "files"];
          store.setSelectedTab(tabs[Number(key) - 1]);
          return;
        }
        case "b":
        case "B": {
          const id = store.selectedEventId;
          if (id !== null) store.toggleBookmark(id);
          return;
        }
        case "m":
        case "M": {
          store.setMode(store.mode === "monitoring" ? "investigation" : "monitoring");
          return;
        }
        case "f":
        case "F": {
          store.setFocusedPid(null);
          return;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [helpOpen, onToggleHelp]);
}
