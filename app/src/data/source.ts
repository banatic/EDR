import type { Bucket, Event, ProcessSummary, QueryFilter, RuntimeInfo, Settings } from "../types";

/**
 * Snapshot of a currently-running process. Returned by
 * `list_running_processes()` once on UI mount so the process tree starts
 * pre-populated rather than waiting for ETW events to dribble in.
 */
export interface RunningProcess {
  pid: number;
  ppid: number;
  name: string;
  exe_path: string | null;
}

/**
 * Abstract event source. Implementations:
 *   - `MockEventSource`     — pure in-process generator for dev / demos.
 *   - `TauriEventSource`    — invoke()/listen() over the Tauri IPC bridge.
 *
 * The orchestrator can swap the implementation by editing `getEventSource()`
 * (see `index.ts` in this folder).
 */
export interface EventSource {
  /** Initial backlog (≤ window). Returns synchronously-ish via Promise. */
  queryEvents(filter: QueryFilter): Promise<Event[]>;

  /** Process inventory (for the left tree). */
  listProcesses(): Promise<ProcessSummary[]>;

  /** Snapshot of all running processes (used to seed the process tree). */
  listRunningProcesses(): Promise<RunningProcess[]>;

  /** Returns a `data:image/png;base64,…` URL for the exe, or null. */
  getProcessIcon(exePath: string): Promise<string | null>;

  /** Bucketed counts for an explicit time range. */
  aggregateRange(from_ns: number, to_ns: number, by_pid: boolean): Promise<Bucket[]>;

  getSettings(): Promise<Settings>;
  setSetting(key: keyof Settings, value: Settings[keyof Settings]): Promise<void>;

  /** One-shot snapshot of which backend is running and whether ETW failed. */
  getRuntimeInfo(): Promise<RuntimeInfo>;

  /**
   * Subscribe to streamed event batches. Returns an unlisten fn.
   *
   * The Tauri source binds the `edr://event-batch` window event (payload
   * is an `Event[]`); the mock source emits ~50 events every 200ms.
   *
   * Single-event delivery is intentionally not exposed — the per-event
   * setState path could not keep up with the real ETW volume.
   */
  subscribeBatch(onBatch: (events: Event[]) => void): () => void;
}

export type EventSourceFactory = () => EventSource;
