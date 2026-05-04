/**
 * Mock event source. Replicates the scripted scenario from
 * `crates/edr-collector/src/synthetic.rs` with a richer cast so the demo
 * shows interesting suspicious / alert events.
 *
 * Generates ~2,000 backlog events spread across the last 10 minutes and
 * then streams batches of ~50 events every 200ms (matching the real
 * `edr://event-batch` cadence) so the React renderer can be tuned against
 * realistic throughput without a Tauri runtime.
 */

import type {
  Bucket,
  Category,
  Event,
  ProcessSummary,
  QueryFilter,
  Settings,
  Severity,
} from "../types";
import type { EventSource, RunningProcess } from "./source";

const NS_PER_MS = 1_000_000;
const WINDOW_MIN = 10;
const BATCH_INTERVAL_MS = 200;
const BATCH_SIZE = 50;

interface Template {
  pid: number;
  ppid: number;
  proc_name: string;
  category: Category;
  op: string;
  target: string;
  severity: Severity;
}

// ---- Scenario --------------------------------------------------------------

const PROCESSES: ProcessSummary[] = [
  { pid: 4, ppid: 0, proc_name: "System", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 600, ppid: 4, proc_name: "services.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 4321, ppid: 600, proc_name: "explorer.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 5500, ppid: 600, proc_name: "chrome.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 5501, ppid: 5500, proc_name: "chrome.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 7777, ppid: 4321, proc_name: "winword.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 8888, ppid: 7777, proc_name: "cmd.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 8889, ppid: 8888, proc_name: "powershell.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 9001, ppid: 4321, proc_name: "notepad.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 6660, ppid: 600, proc_name: "lsass.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
  { pid: 12345, ppid: 8889, proc_name: "rundll32.exe", first_seen_ts: 0, last_seen_ts: 0, event_count: 0, alert_count: 0 },
];

const TEMPLATES: Template[] = [
  // explorer.exe — boring noise
  { pid: 4321, ppid: 600, proc_name: "explorer.exe", category: "File", op: "Read", target: "C:\\Users\\moomin\\Desktop\\desktop.ini", severity: 0 },
  { pid: 4321, ppid: 600, proc_name: "explorer.exe", category: "Registry", op: "QueryValue", target: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", severity: 0 },
  { pid: 4321, ppid: 600, proc_name: "explorer.exe", category: "ImageLoad", op: "Load", target: "C:\\Windows\\System32\\shell32.dll", severity: 0 },

  // chrome.exe — networky
  { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: "Network", op: "DnsQuery", target: "www.google.com", severity: 0 },
  { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: "Network", op: "Connect", target: "142.250.196.110:443", severity: 0 },
  { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: "Network", op: "Connect", target: "151.101.1.69:443", severity: 0 },
  { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: "Network", op: "DnsQuery", target: "fonts.gstatic.com", severity: 0 },
  { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: "File", op: "Write", target: "C:\\Users\\moomin\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\data_2", severity: 0 },
  { pid: 5501, ppid: 5500, proc_name: "chrome.exe", category: "Network", op: "Connect", target: "104.18.21.226:443", severity: 0 },
  { pid: 5501, ppid: 5500, proc_name: "chrome.exe", category: "Network", op: "DnsQuery", target: "www.cloudflare.com", severity: 0 },

  // notepad.exe
  { pid: 9001, ppid: 4321, proc_name: "notepad.exe", category: "File", op: "Open", target: "C:\\Users\\moomin\\Documents\\todo.txt", severity: 0 },
  { pid: 9001, ppid: 4321, proc_name: "notepad.exe", category: "File", op: "Read", target: "C:\\Users\\moomin\\Documents\\todo.txt", severity: 0 },
  { pid: 9001, ppid: 4321, proc_name: "notepad.exe", category: "ImageLoad", op: "Load", target: "C:\\Windows\\System32\\shell32.dll", severity: 0 },

  // winword.exe — suspicious_office_child rule
  { pid: 7777, ppid: 4321, proc_name: "winword.exe", category: "File", op: "Read", target: "C:\\Users\\moomin\\Documents\\invoice_payment.docm", severity: 1 },
  { pid: 7777, ppid: 4321, proc_name: "winword.exe", category: "Process", op: "Create", target: "C:\\Windows\\System32\\cmd.exe", severity: 2 },
  { pid: 8888, ppid: 7777, proc_name: "cmd.exe", category: "Process", op: "Create", target: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", severity: 2 },
  { pid: 8889, ppid: 8888, proc_name: "powershell.exe", category: "Network", op: "Connect", target: "185.220.101.34:443", severity: 2 },
  { pid: 8889, ppid: 8888, proc_name: "powershell.exe", category: "File", op: "Write", target: "C:\\Users\\moomin\\AppData\\Roaming\\runtime.exe", severity: 2 },
  { pid: 8888, ppid: 7777, proc_name: "cmd.exe", category: "Registry", op: "SetValue", target: "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\evil", severity: 2 },
  { pid: 12345, ppid: 8889, proc_name: "rundll32.exe", category: "ImageLoad", op: "Load", target: "C:\\Users\\moomin\\AppData\\Roaming\\runtime.exe", severity: 2 },

  // lsass-style probes
  { pid: 8889, ppid: 8888, proc_name: "powershell.exe", category: "Handle", op: "OpenProcess", target: "lsass.exe", severity: 2 },
  { pid: 8889, ppid: 8888, proc_name: "powershell.exe", category: "Thread", op: "CreateRemoteThread", target: "lsass.exe", severity: 2 },

  // services.exe — quiet
  { pid: 600, ppid: 4, proc_name: "services.exe", category: "Registry", op: "OpenKey", target: "HKLM\\System\\CurrentControlSet\\Services", severity: 0 },
  { pid: 600, ppid: 4, proc_name: "services.exe", category: "ImageLoad", op: "Load", target: "C:\\Windows\\System32\\rpcrt4.dll", severity: 0 },

  // integrity self-check (every minute, suspicious if it ever fails)
  { pid: 0, ppid: 0, proc_name: "edr-collector", category: "Integrity", op: "EtwHashCheck", target: "ntdll!EtwEventWrite", severity: 0 },

  // System
  { pid: 4, ppid: 0, proc_name: "System", category: "ImageLoad", op: "Load", target: "C:\\Windows\\System32\\drivers\\ntoskrnl.exe", severity: 0 },
];

const RUNNING_PROCESSES: RunningProcess[] = [
  { pid: 4, ppid: 0, name: "System", exe_path: null },
  { pid: 600, ppid: 4, name: "services.exe", exe_path: "C:\\Windows\\System32\\services.exe" },
  { pid: 4321, ppid: 600, name: "explorer.exe", exe_path: "C:\\Windows\\explorer.exe" },
  { pid: 5500, ppid: 600, name: "chrome.exe", exe_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { pid: 5501, ppid: 5500, name: "chrome.exe", exe_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { pid: 6660, ppid: 600, name: "lsass.exe", exe_path: "C:\\Windows\\System32\\lsass.exe" },
  { pid: 7777, ppid: 4321, name: "winword.exe", exe_path: "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE" },
  { pid: 9001, ppid: 4321, name: "notepad.exe", exe_path: "C:\\Windows\\System32\\notepad.exe" },
];

// ---- Mock source -----------------------------------------------------------

export class MockEventSource implements EventSource {
  private settings: Settings = {
    hide_whitelisted: false,
    cluster_threshold: 10,
    show_dimmed: true,
  };

  private listeners = new Set<(events: Event[]) => void>();
  private streamingTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 0;
  private backlog: Event[] = [];

  constructor() {
    this.backlog = generateBacklog(2000);
    this.nextId = this.backlog.length;
  }

  async queryEvents(filter: QueryFilter): Promise<Event[]> {
    let out = this.backlog;
    if (filter.from_ns !== undefined) out = out.filter((e) => e.ts >= filter.from_ns!);
    if (filter.to_ns !== undefined) out = out.filter((e) => e.ts <= filter.to_ns!);
    if (filter.pids && filter.pids.length > 0) {
      const set = new Set(filter.pids);
      out = out.filter((e) => set.has(e.pid));
    }
    if (filter.categories && filter.categories.length > 0) {
      const set = new Set(filter.categories);
      out = out.filter((e) => set.has(e.category));
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      out = out.filter(
        (e) =>
          e.proc_name.toLowerCase().includes(q) ||
          e.op.toLowerCase().includes(q) ||
          e.target.toLowerCase().includes(q),
      );
    }
    if (filter.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  async listProcesses(): Promise<ProcessSummary[]> {
    const map = new Map<number, ProcessSummary>();
    for (const p of PROCESSES) {
      map.set(p.pid, {
        ...p,
        first_seen_ts: Number.MAX_SAFE_INTEGER,
        last_seen_ts: 0,
        event_count: 0,
        alert_count: 0,
      });
    }
    for (const ev of this.backlog) {
      let p = map.get(ev.pid);
      if (!p) {
        p = {
          pid: ev.pid,
          ppid: ev.ppid,
          proc_name: ev.proc_name,
          first_seen_ts: ev.ts,
          last_seen_ts: ev.ts,
          event_count: 0,
          alert_count: 0,
        };
        map.set(ev.pid, p);
      }
      p.first_seen_ts = Math.min(p.first_seen_ts, ev.ts);
      p.last_seen_ts = Math.max(p.last_seen_ts, ev.ts);
      p.event_count += 1;
      if (ev.severity === 2) p.alert_count += 1;
    }
    return [...map.values()].sort((a, b) => b.event_count - a.event_count);
  }

  async listRunningProcesses(): Promise<RunningProcess[]> {
    return RUNNING_PROCESSES.map((p) => ({ ...p }));
  }

  async getProcessIcon(_exePath: string): Promise<string | null> {
    // No real icons in dev; return null so the placeholder renders.
    return null;
  }

  async aggregateRange(from_ns: number, to_ns: number, by_pid: boolean): Promise<Bucket[]> {
    const buckets = new Map<string, Bucket>();
    const span = Math.max(1, to_ns - from_ns);
    const bucketNs = Math.max(1_000_000_000, Math.floor(span / 60)); // ~60 buckets
    for (const ev of this.backlog) {
      if (ev.ts < from_ns || ev.ts > to_ns) continue;
      const ts_bucket = from_ns + Math.floor((ev.ts - from_ns) / bucketNs) * bucketNs;
      const key = by_pid ? `${ts_bucket}:${ev.pid}` : `${ts_bucket}`;
      const b = buckets.get(key);
      if (b) b.count += 1;
      else
        buckets.set(key, {
          ts_bucket,
          pid: by_pid ? ev.pid : undefined,
          count: 1,
        });
    }
    return [...buckets.values()].sort((a, b) => a.ts_bucket - b.ts_bucket);
  }

  async getSettings(): Promise<Settings> {
    return { ...this.settings };
  }

  async setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    (this.settings as Record<keyof Settings, Settings[keyof Settings]>)[key] = value;
  }

  subscribeBatch(onBatch: (events: Event[]) => void): () => void {
    this.listeners.add(onBatch);
    if (!this.streamingTimer) {
      this.streamingTimer = setInterval(() => this.tick(), BATCH_INTERVAL_MS);
    }
    return () => {
      this.listeners.delete(onBatch);
      if (this.listeners.size === 0 && this.streamingTimer) {
        clearInterval(this.streamingTimer);
        this.streamingTimer = null;
      }
    };
  }

  private tick(): void {
    const batch: Event[] = new Array(BATCH_SIZE);
    const baseTs = Date.now() * NS_PER_MS;
    for (let i = 0; i < BATCH_SIZE; i++) {
      const t = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
      // Spread the synthetic batch across the last ~200ms so they don't
      // collapse onto a single x-coordinate in the timeline.
      const ts = baseTs - Math.floor(Math.random() * BATCH_INTERVAL_MS) * NS_PER_MS;
      const ev: Event = {
        ts,
        pid: t.pid,
        ppid: t.ppid,
        proc_name: t.proc_name,
        category: t.category,
        op: t.op,
        target: t.target,
        severity: t.severity,
        meta: { synthetic: true, seq: this.nextId },
        id: this.nextId,
      };
      this.nextId += 1;
      batch[i] = ev;
      this.backlog.push(ev);
    }
    // Cap backlog at ~30k mocked events to keep memory bounded.
    if (this.backlog.length > 30_000) {
      this.backlog.splice(0, this.backlog.length - 30_000);
    }
    for (const fn of this.listeners) fn(batch);
  }
}

// ---- Backlog helpers -------------------------------------------------------

function generateBacklog(target: number): Event[] {
  const now = Date.now() * NS_PER_MS;
  const start = now - WINDOW_MIN * 60_000 * NS_PER_MS;
  const span = now - start;

  // Distribution: most events normal noise, a tighter alert burst near minute 7.
  const events: Event[] = [];
  const burstStart = start + span * 0.7;
  const burstEnd = start + span * 0.78;

  for (let i = 0; i < target; i++) {
    let ts: number;
    let template: Template;

    if (i % 17 === 0) {
      // burst from the suspicious_office_child path
      ts = burstStart + Math.random() * (burstEnd - burstStart);
      template = pickTemplate(true);
    } else {
      ts = start + Math.random() * span;
      template = pickTemplate(false);
    }

    events.push({
      ts: Math.floor(ts),
      pid: template.pid,
      ppid: template.ppid,
      proc_name: template.proc_name,
      category: template.category,
      op: template.op,
      target: template.target,
      severity: template.severity,
      meta: { synthetic: true, seq: i },
      id: i,
    });
  }

  events.sort((a, b) => a.ts - b.ts);
  return events;
}

function pickTemplate(preferAlert: boolean): Template {
  if (preferAlert) {
    const alerts = TEMPLATES.filter((t) => t.severity === 2);
    return alerts[Math.floor(Math.random() * alerts.length)];
  }
  return TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
}
