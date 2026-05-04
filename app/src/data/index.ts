import type { EventSource } from "./source";
import { MockEventSource } from "./mockSource";
import { TauriEventSource } from "./tauriSource";

/**
 * Returns the active event source. Auto-detects the Tauri runtime and
 * falls back to the in-process mock (so plain `npm run dev` works).
 */
export function getEventSource(): EventSource {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return new TauriEventSource();
  }
  return new MockEventSource();
}

export type { EventSource, RunningProcess } from "./source";
