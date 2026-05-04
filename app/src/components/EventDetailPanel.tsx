import { memo, useMemo } from "react";
import type { Category, Event, Severity } from "../types";
import { SEVERITY_LABEL } from "../types";
import { severityClass, useEventStore } from "../store/eventStore";

function formatTs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  const d = new Date(ms);
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * Per-category preferred meta keys, rendered as labelled rows.
 * Anything not in this list falls into the .meta-extra dump.
 */
const META_KEYS_BY_CATEGORY: Record<Category, readonly string[]> = {
  Process: ["cmdline", "integrity", "user", "parent_proc"],
  File: ["size", "operation", "extension"],
  Network: ["remote_ip", "remote_port", "protocol", "bytes_sent", "bytes_recv"],
  Registry: ["value_name", "value_type", "value_data"],
  ImageLoad: ["image_path", "signature", "signed"],
  Thread: ["target_pid", "start_addr"],
  Handle: ["target_pid", "access_mask"],
  Integrity: ["module", "delta_bytes"],
};

const VALUE_MAX_LEN = 200;

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function clip(s: string): string {
  if (s.length <= VALUE_MAX_LEN) return s;
  return `${s.slice(0, VALUE_MAX_LEN - 1)}…`;
}

// Redundant shape encoding so severity is distinguishable without color
// (color-blind users, monochrome displays, B&W print).
const SEVERITY_GLYPH: Record<Severity, string> = {
  0: "○",
  1: "◆",
  2: "▲",
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`severity-badge ${severityClass(severity)}`}>
      <span className="shape" aria-hidden>
        {SEVERITY_GLYPH[severity]}
      </span>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export const EventDetailPanel = memo(function EventDetailPanel() {
  const events = useEventStore((s) => s.events);
  const selectedEventId = useEventStore((s) => s.selectedEventId);
  const bookmarks = useEventStore((s) => s.bookmarks);
  const toggleBookmark = useEventStore((s) => s.toggleBookmark);
  const setSelectedEvent = useEventStore((s) => s.setSelectedEvent);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);

  const selected: Event | null = useMemo(() => {
    if (selectedEventId === null) return null;
    return events.find((e) => e.id === selectedEventId) ?? null;
  }, [events, selectedEventId]);

  // Causality candidates split into two buckets so the user can tell them apart:
  //  - children: processes spawned by selected.pid
  //  - sameTarget: other processes touching the same target
  const causality = useMemo(() => {
    if (!selected) return { children: [] as Event[], sameTarget: [] as Event[] };
    const children: Event[] = [];
    const sameTarget: Event[] = [];
    for (const ev of events) {
      if (ev.id === selected.id) continue;
      if (ev.ppid === selected.pid && ev.category === "Process") children.push(ev);
      else if (ev.target === selected.target && ev.pid !== selected.pid) sameTarget.push(ev);
    }
    return { children: children.slice(0, 8), sameTarget: sameTarget.slice(0, 8) };
  }, [events, selected]);

  if (!selected) {
    return <aside className="detail-panel collapsed" aria-hidden />;
  }

  const meta = selected.meta ?? {};
  const isBookmarked = selected.id !== undefined && bookmarks.has(selected.id);

  // Split meta into known (per-category) and unknown buckets so the user gets
  // a labelled grid for the common cases and a fallback dump for the rest.
  const knownKeys = META_KEYS_BY_CATEGORY[selected.category] ?? [];
  const knownEntries: Array<[string, unknown]> = [];
  const unknownEntries: Array<[string, unknown]> = [];
  for (const k of knownKeys) {
    if (k in meta) knownEntries.push([k, meta[k]]);
  }
  for (const [k, v] of Object.entries(meta)) {
    if (!knownKeys.includes(k)) unknownEntries.push([k, v]);
  }
  const hasMeta = knownEntries.length > 0 || unknownEntries.length > 0;

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <SeverityBadge severity={selected.severity} />
        <span className="title">
          {selected.proc_name} · {selected.op}
        </span>
        <button
          className="close"
          title={isBookmarked ? "Remove bookmark" : "Bookmark"}
          onClick={() => selected.id !== undefined && toggleBookmark(selected.id)}
        >
          {isBookmarked ? "★" : "☆"}
        </button>
        <button className="close" onClick={() => setSelectedEvent(null)} title="Close">
          ✕
        </button>
      </div>
      <div className="detail-body">
        <div className="kv">
          <span className="k">ts</span>
          <span className="v">{formatTs(selected.ts)}</span>
          <span className="k">pid</span>
          <span className="v">
            <button
              style={{
                color: "var(--color-accent)",
                textDecoration: "underline",
                background: "none",
                padding: 0,
              }}
              onClick={() => setFocusedPid(selected.pid)}
            >
              {selected.pid}
            </button>
            {" "}
            (parent {selected.ppid})
          </span>
          <span className="k">category</span>
          <span className="v">{selected.category}</span>
          <span className="k">op</span>
          <span className="v">{selected.op}</span>
          <span className="k">target</span>
          <span className="v">{selected.target}</span>
          {selected.isNew && (
            <>
              <span className="k">flag</span>
              <span className="v">
                <span className="new-badge">NEW</span> first sighting this session
              </span>
            </>
          )}
          {selected.cluster && (
            <>
              <span className="k">cluster</span>
              <span className="v">
                <span className="cluster-badge">×{selected.cluster.count}</span> in window
              </span>
            </>
          )}
        </div>

        {hasMeta && (
          <>
            <div className="detail-section-title">meta</div>
            {knownEntries.length > 0 && (
              <div className="kv meta-grid">
                {knownEntries.map(([k, v]) => (
                  <span key={k} style={{ display: "contents" }}>
                    <span className="k">{k}</span>
                    <span className="v">{clip(stringify(v))}</span>
                  </span>
                ))}
              </div>
            )}
            {unknownEntries.length > 0 && (
              <div className="meta-extra">
                {unknownEntries.map(([k, v]) => (
                  <div className="meta-extra-row" key={k}>
                    <span className="k">{k}</span>
                    <span className="v">{clip(stringify(v))}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {causality.children.length > 0 && (
          <>
            <div className="detail-section-title">
              spawned ({causality.children.length})
            </div>
            <div className="causality-list">
              {causality.children.map((c) => (
                <div
                  key={c.id}
                  className="causality-row"
                  onClick={() => c.id !== undefined && setSelectedEvent(c.id)}
                >
                  <div className="head">
                    <SeverityBadge severity={c.severity} />
                    <span>{c.proc_name}</span>
                    <span style={{ color: "var(--color-text-tertiary)" }}>·</span>
                    <span>{c.op}</span>
                  </div>
                  <div className="meta">{c.target}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {causality.sameTarget.length > 0 && (
          <>
            <div className="detail-section-title">
              same target ({causality.sameTarget.length})
            </div>
            <div className="causality-list">
              {causality.sameTarget.map((c) => (
                <div
                  key={c.id}
                  className="causality-row"
                  onClick={() => c.id !== undefined && setSelectedEvent(c.id)}
                >
                  <div className="head">
                    <SeverityBadge severity={c.severity} />
                    <span>{c.proc_name}</span>
                    <span style={{ color: "var(--color-text-tertiary)" }}>·</span>
                    <span>{c.op}</span>
                  </div>
                  <div className="meta">{c.target}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {causality.children.length === 0 && causality.sameTarget.length === 0 && (
          <>
            <div className="detail-section-title">causality</div>
            <div style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>
              no related events
            </div>
          </>
        )}
      </div>
    </aside>
  );
});
