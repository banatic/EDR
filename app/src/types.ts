/**
 * Mirrors the Rust schema in `crates/edr-core/src/event.rs`.
 *
 * - `ts` is unix nanoseconds. JS numbers safely cover ~285 years from epoch
 *   so we keep `number` for now; the backend will downcast via serde u64/i64.
 *   For sub-millisecond resolution we keep arithmetic in i64-as-number range.
 * - `severity` matches the `Severity` Rust enum (0=Normal,1=Suspicious,2=Alert).
 */

export type Category =
  | "Process"
  | "File"
  | "Network"
  | "Registry"
  | "ImageLoad"
  | "Thread"
  | "Handle"
  | "Integrity";

export const CATEGORIES: Category[] = [
  "Process",
  "File",
  "Network",
  "Registry",
  "ImageLoad",
  "Thread",
  "Handle",
  "Integrity",
];

export type Severity = 0 | 1 | 2;

export interface Cluster {
  count: number;
  first_ts: number;
  last_ts: number;
}

export interface Event {
  /** Unix timestamp in nanoseconds. */
  ts: number;
  pid: number;
  ppid: number;
  proc_name: string;
  category: Category;
  /** Operation verb (Create / Write / Connect / SetValue / ...). */
  op: string;
  /** Path / IP:port / registry key / etc. */
  target: string;
  severity: Severity;
  /** Free-form per-category metadata. */
  meta: Record<string, unknown>;

  /** Optional client-assigned monotonic id, never sent over the wire. */
  id?: number;
  /** Optional cluster aggregate when repeats were folded by the backend. */
  cluster?: Cluster;
  /** Whitelisted by user rules. Renders dimmed (or hidden) in the UI. */
  whitelisted?: boolean;
  /** First time we saw this (proc, category, target) tuple this session. */
  isNew?: boolean;
}

export interface ProcessSummary {
  pid: number;
  ppid: number;
  proc_name: string;
  first_seen_ts: number;
  last_seen_ts: number;
  event_count: number;
  alert_count: number;
}

export interface QueryFilter {
  from_ns?: number;
  to_ns?: number;
  pids?: number[];
  categories?: Category[];
  search?: string;
  limit?: number;
}

export interface Bucket {
  ts_bucket: number;
  pid?: number;
  category?: Category;
  count: number;
}

export interface Settings {
  hide_whitelisted: boolean;
  cluster_threshold: number;
  show_dimmed: boolean;
}

export type AppMode = "monitoring" | "investigation";

export type TabId = "timeline" | "graph" | "network" | "files";

export const SEVERITY_LABEL: Record<Severity, string> = {
  0: "normal",
  1: "suspicious",
  2: "alert",
};
