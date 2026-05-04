/**
 * Tauri-backed event source. Wires `invoke()` to the Rust commands in
 * `src-tauri/src/commands.rs` and listens to the `edr://event-batch`
 * window event for streaming.
 */

import type { Bucket, Event, ProcessSummary, QueryFilter, Settings } from "../types";
import type { EventSource, RunningProcess } from "./source";

// NOTE: imported lazily so the mock source can run in plain Vite dev
// (where window.__TAURI__ is undefined).
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

async function getTauri(): Promise<{ invoke: InvokeFn; listen: ListenFn }> {
  const core = await import("@tauri-apps/api/core");
  const eventApi = await import("@tauri-apps/api/event");
  return {
    invoke: core.invoke as InvokeFn,
    listen: eventApi.listen as ListenFn,
  };
}

export class TauriEventSource implements EventSource {
  /** Per-exe icon promise cache so concurrent rows for the same exe share. */
  private iconCache = new Map<string, Promise<string | null>>();

  async queryEvents(filter: QueryFilter): Promise<Event[]> {
    const { invoke } = await getTauri();
    return invoke<Event[]>("query_events", { filter });
  }

  async listProcesses(): Promise<ProcessSummary[]> {
    const { invoke } = await getTauri();
    return invoke<ProcessSummary[]>("list_processes");
  }

  async listRunningProcesses(): Promise<RunningProcess[]> {
    const { invoke } = await getTauri();
    return invoke<RunningProcess[]>("list_running_processes");
  }

  getProcessIcon(exePath: string): Promise<string | null> {
    const cached = this.iconCache.get(exePath);
    if (cached) return cached;
    const p = (async () => {
      try {
        const { invoke } = await getTauri();
        return await invoke<string | null>("get_process_icon", { exePath });
      } catch {
        return null;
      }
    })();
    this.iconCache.set(exePath, p);
    return p;
  }

  async aggregateRange(from_ns: number, to_ns: number, by_pid: boolean): Promise<Bucket[]> {
    const { invoke } = await getTauri();
    return invoke<Bucket[]>("aggregate_range", { fromNs: from_ns, toNs: to_ns, byPid: by_pid });
  }

  async getSettings(): Promise<Settings> {
    const { invoke } = await getTauri();
    return invoke<Settings>("get_settings");
  }

  async setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    const { invoke } = await getTauri();
    await invoke<void>("set_setting", { key, value });
  }

  subscribeBatch(onBatch: (events: Event[]) => void): () => void {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const { listen } = await getTauri();
      const off = await listen<Event[]>("edr://event-batch", (msg) => {
        const payload = msg.payload;
        if (Array.isArray(payload) && payload.length > 0) onBatch(payload);
      });
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
}
