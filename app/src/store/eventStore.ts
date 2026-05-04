import { create } from "zustand";
import type {
  AppMode,
  Category,
  Event,
  ProcessSummary,
  RuntimeInfo,
  Severity,
  Settings,
  TabId,
} from "../types";
import { getEventSource } from "../data";
import type { EventSource, RunningProcess } from "../data";

const NS_PER_MS = 1_000_000;
/**
 * Hard cap on retained events. Real ETW load can hit 10k events/sec; at
 * ~10s of full-throttle traffic we hit this and start evicting.
 */
const RING_CAPACITY = 100_000;
/** When the ring fills, drop the oldest CHUNK so we don't thrash. */
const RING_EVICT_CHUNK = 5_000;

interface State {
  // Data
  source: EventSource;
  events: Event[]; // logical chronological view (already-evicted prefix removed)
  /**
   * Monotonically increasing index of the oldest retained event (for
   * future absolute references). Indexes inside `byPid`/`byCategory`
   * always refer to positions in the current `events` array.
   */
  evictionOffset: number;
  processes: ProcessSummary[];
  /** Cached running-process inventory from the OS (icon-aware). */
  runningProcesses: RunningProcess[];
  settings: Settings;
  /** One-shot backend status snapshot, fetched on initialize. */
  runtimeInfo: RuntimeInfo | null;
  // Indexes (rebuilt incrementally)
  byPid: Map<number, number[]>; // pid → indexes into `events`
  byCategory: Map<Category, number[]>;
  firstSeen: Map<string, number>; // key=`pid|cat|target` → ts of first sighting

  // UI state
  mode: AppMode;
  /** Investigation mode pinned range; in monitoring mode uses live window. */
  rangeMinutes: number;
  fixedRange: { fromNs: number; toNs: number } | null;
  search: string;
  selectedTab: TabId;
  focusedPid: number | null;
  selectedEventId: number | null;
  bookmarks: Set<number>;
  hoverEvent: Event | null;

  // Lifecycle
  ready: boolean;
}

interface Actions {
  initialize: () => Promise<void>;
  /** Append a batch of events with a single store update. */
  appendMany: (events: Event[]) => void;

  setMode: (mode: AppMode) => void;
  setRangeMinutes: (m: number) => void;
  setSearch: (s: string) => void;
  setSelectedTab: (t: TabId) => void;
  setFocusedPid: (pid: number | null) => void;
  setSelectedEvent: (id: number | null) => void;
  toggleBookmark: (id: number) => void;
  setHoverEvent: (ev: Event | null) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
}

export type EventStoreState = State & Actions;

let nextLocalId = 1_000_000_000;

export const useEventStore = create<EventStoreState>((set, get) => ({
  source: getEventSource(),
  events: [],
  evictionOffset: 0,
  processes: [],
  runningProcesses: [],
  settings: { hide_whitelisted: false, cluster_threshold: 10, show_dimmed: true },
  runtimeInfo: null,
  byPid: new Map(),
  byCategory: new Map(),
  firstSeen: new Map(),

  mode: "monitoring",
  rangeMinutes: 10,
  fixedRange: null,
  search: "",
  selectedTab: "timeline",
  focusedPid: null,
  selectedEventId: null,
  bookmarks: new Set(),
  hoverEvent: null,

  ready: false,

  async initialize() {
    const { source } = get();
    // Fetch runtime info first (and surface it to the store before the
    // heavier backlog query) so the EmptyState shows the correct
    // "demo data" / "ETW failed" hint while we wait.
    try {
      const info = await source.getRuntimeInfo();
      set({ runtimeInfo: info });
    } catch {
      // Older backends without the command leave runtimeInfo null.
    }
    const settings = await source.getSettings();
    const backlog = await source.queryEvents({ limit: RING_CAPACITY });
    const processes = await source.listProcesses();
    // Best-effort running-process inventory; if the backend doesn't have
    // the new command yet, fall back to an empty array rather than
    // blocking initialization.
    let runningProcesses: RunningProcess[] = [];
    try {
      runningProcesses = await source.listRunningProcesses();
    } catch {
      runningProcesses = [];
    }

    const events: Event[] = [];
    const byPid = new Map<number, number[]>();
    const byCategory = new Map<Category, number[]>();
    const firstSeen = new Map<string, number>();

    for (const raw of backlog) {
      const ev = ensureId(raw);
      const idx = events.length;
      events.push(ev);
      pushIndex(byPid, ev.pid, idx);
      pushIndex(byCategory, ev.category, idx);
      const k = firstSeenKey(ev);
      const prior = firstSeen.get(k);
      if (prior === undefined || ev.ts < prior) firstSeen.set(k, ev.ts);
    }
    // Mark new badges retroactively (only for events that match the
    // canonical first-seen ts).
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (firstSeen.get(firstSeenKey(ev)) === ev.ts) ev.isNew = true;
    }

    set({
      settings,
      events,
      processes,
      runningProcesses,
      byPid,
      byCategory,
      firstSeen,
      ready: true,
    });

    // Subscribe to streamed event batches.
    source.subscribeBatch((batch) => get().appendMany(batch));
  },

  appendMany(rawBatch) {
    if (rawBatch.length === 0) return;
    set((state) => {
      // Mutate copies in-place: we own these structures and are firing
      // exactly one React state update for the whole batch.
      const events = state.events.slice();
      const byPid = new Map(state.byPid);
      const byCategory = new Map(state.byCategory);
      const firstSeen = state.firstSeen; // mutated in place — refs not shared with React tree

      // Process inventory updates clone-on-write only once for the batch.
      const processes = state.processes.slice();
      const procIndex = new Map<number, number>();
      for (let i = 0; i < processes.length; i++) procIndex.set(processes[i].pid, i);

      for (let i = 0; i < rawBatch.length; i++) {
        const ev = ensureId(rawBatch[i]);

        const k = firstSeenKey(ev);
        if (!firstSeen.has(k)) {
          firstSeen.set(k, ev.ts);
          ev.isNew = true;
        }

        const idx = events.length;
        events.push(ev);
        pushIndex(byPid, ev.pid, idx);
        pushIndex(byCategory, ev.category, idx);

        const pi = procIndex.get(ev.pid);
        if (pi === undefined) {
          processes.push({
            pid: ev.pid,
            ppid: ev.ppid,
            proc_name: ev.proc_name,
            first_seen_ts: ev.ts,
            last_seen_ts: ev.ts,
            event_count: 1,
            alert_count: ev.severity === 2 ? 1 : 0,
          });
          procIndex.set(ev.pid, processes.length - 1);
        } else {
          // Clone before mutating so equality-checked memoizers downstream
          // notice the change.
          const existing = processes[pi];
          processes[pi] = {
            ...existing,
            last_seen_ts: ev.ts,
            event_count: existing.event_count + 1,
            alert_count: existing.alert_count + (ev.severity === 2 ? 1 : 0),
          };
        }
      }

      // Ring buffer trim: drop the oldest chunk in O(events.length) only
      // when we exceed the cap. We rebuild the indexes on eviction; the
      // common path (no eviction) stays O(batchSize).
      let nextEvents = events;
      let nextByPid = byPid;
      let nextByCategory = byCategory;
      let nextOffset = state.evictionOffset;
      if (events.length > RING_CAPACITY) {
        const drop = events.length - (RING_CAPACITY - RING_EVICT_CHUNK);
        nextEvents = events.slice(drop);
        nextByPid = new Map<number, number[]>();
        nextByCategory = new Map<Category, number[]>();
        for (let i = 0; i < nextEvents.length; i++) {
          const e = nextEvents[i];
          pushIndex(nextByPid, e.pid, i);
          pushIndex(nextByCategory, e.category, i);
        }
        nextOffset = state.evictionOffset + drop;
      }

      return {
        events: nextEvents,
        byPid: nextByPid,
        byCategory: nextByCategory,
        firstSeen,
        processes,
        evictionOffset: nextOffset,
      };
    });
  },

  setMode(mode) {
    if (mode === "investigation") {
      const { events, rangeMinutes } = get();
      const last = events.length > 0 ? events[events.length - 1].ts : Date.now() * NS_PER_MS;
      const fromNs = last - rangeMinutes * 60_000 * NS_PER_MS;
      set({ mode, fixedRange: { fromNs, toNs: last } });
    } else {
      set({ mode, fixedRange: null });
    }
  },
  setRangeMinutes(m) {
    set({ rangeMinutes: m });
    const { mode } = get();
    if (mode === "investigation") {
      // recompute the fixed range anchored at the same end
      const fr = get().fixedRange;
      const end = fr ? fr.toNs : Date.now() * NS_PER_MS;
      set({ fixedRange: { fromNs: end - m * 60_000 * NS_PER_MS, toNs: end } });
    }
  },
  setSearch(s) {
    set({ search: s });
  },
  setSelectedTab(t) {
    set({ selectedTab: t });
  },
  setFocusedPid(pid) {
    set({ focusedPid: pid });
  },
  setSelectedEvent(id) {
    set({ selectedEventId: id });
  },
  toggleBookmark(id) {
    set((s) => {
      const next = new Set(s.bookmarks);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { bookmarks: next };
    });
  },
  setHoverEvent(ev) {
    set({ hoverEvent: ev });
  },
  async setSetting(key, value) {
    const { source } = get();
    await source.setSetting(key as keyof Settings, value as Settings[keyof Settings]);
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
  },
}));

// ---- helpers ---------------------------------------------------------------

function ensureId(ev: Event): Event {
  if (ev.id === undefined) {
    return { ...ev, id: nextLocalId++ };
  }
  return ev;
}

function firstSeenKey(ev: Event): string {
  return `${ev.pid}|${ev.category}|${ev.target}`;
}

function pushIndex<K>(map: Map<K, number[]>, key: K, idx: number) {
  const arr = map.get(key);
  if (arr) arr.push(idx);
  else map.set(key, [idx]);
}

// ---- Selectors -------------------------------------------------------------

/** Compute the current visible time range based on mode. */
export function selectVisibleRange(s: EventStoreState): { fromNs: number; toNs: number } {
  if (s.mode === "investigation" && s.fixedRange) return s.fixedRange;
  const last = s.events.length > 0 ? s.events[s.events.length - 1].ts : Date.now() * NS_PER_MS;
  const fromNs = last - s.rangeMinutes * 60_000 * NS_PER_MS;
  return { fromNs, toNs: last };
}

/**
 * Filter events by the active range, search, and whitelist setting.
 *
 * NOTE: this still walks the full retained event list. Components that
 * rerender on every batch should select via `useEventStore` directly so
 * Zustand can shallow-compare the array reference; if the events array
 * didn't change, the selector won't fire and downstream `useMemo`s skip.
 */
export function selectVisibleEvents(s: EventStoreState): Event[] {
  const { fromNs, toNs } = selectVisibleRange(s);
  const q = s.search.trim().toLowerCase();
  const out: Event[] = [];
  const evs = s.events;
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.ts < fromNs || ev.ts > toNs) continue;
    if (s.settings.hide_whitelisted && ev.whitelisted) continue;
    if (q.length > 0) {
      if (
        !ev.proc_name.toLowerCase().includes(q) &&
        !ev.op.toLowerCase().includes(q) &&
        !ev.target.toLowerCase().includes(q) &&
        !ev.category.toLowerCase().includes(q)
      )
        continue;
    }
    out.push(ev);
  }
  return out;
}

/** Severity style helpers shared across components. */
export function severityClass(s: Severity): string {
  return s === 2 ? "alert" : s === 1 ? "suspicious" : "normal";
}
