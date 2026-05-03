import { useMemo } from "react";
import type { Event } from "../types";
import { SEVERITY_LABEL } from "../types";
import { severityClass, useEventStore } from "../store/eventStore";

function formatTs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  const d = new Date(ms);
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(ms % 1000).padStart(3, "0")}`;
}

export function EventDetailPanel() {
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

  // Causality candidates:
  //  - children processes (same ppid as selected.pid, kind=Process Create)
  //  - other processes that touched the same `target`
  const causality = useMemo(() => {
    if (!selected) return [] as Event[];
    const children: Event[] = [];
    const sameTarget: Event[] = [];
    for (const ev of events) {
      if (ev.id === selected.id) continue;
      if (ev.ppid === selected.pid && ev.category === "Process") children.push(ev);
      else if (ev.target === selected.target && ev.pid !== selected.pid) sameTarget.push(ev);
    }
    return [...children.slice(0, 8), ...sameTarget.slice(0, 8)];
  }, [events, selected]);

  if (!selected) {
    return <aside className="detail-panel collapsed" aria-hidden />;
  }

  const meta = selected.meta ?? {};
  const isBookmarked = selected.id !== undefined && bookmarks.has(selected.id);

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <span className={`severity-badge ${severityClass(selected.severity)}`}>
          {SEVERITY_LABEL[selected.severity]}
        </span>
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

        {Object.keys(meta).length > 0 && (
          <>
            <div className="detail-section-title">meta</div>
            <pre
              style={{
                background: "var(--color-background-tertiary)",
                padding: "var(--space-2)",
                borderRadius: "var(--border-radius-sm)",
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {JSON.stringify(meta, null, 2)}
            </pre>
          </>
        )}

        <div className="detail-section-title">causality</div>
        {causality.length === 0 ? (
          <div style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>
            no downstream events linked
          </div>
        ) : (
          <div className="causality-list">
            {causality.map((c) => (
              <div
                key={c.id}
                className="causality-row"
                onClick={() => c.id !== undefined && setSelectedEvent(c.id)}
              >
                <div className="head">
                  <span className={`severity-badge ${severityClass(c.severity)}`}>
                    {SEVERITY_LABEL[c.severity]}
                  </span>
                  <span>{c.proc_name}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>·</span>
                  <span>{c.op}</span>
                </div>
                <div className="meta">{c.target}</div>
              </div>
            ))}
          </div>
        )}

        {selected.id !== undefined && bookmarks.size > 0 && (
          <>
            <div className="detail-section-title">bookmarks</div>
            <div className="causality-list">
              {[...bookmarks].slice(0, 12).map((bid) => {
                const e = events.find((ev) => ev.id === bid);
                if (!e) return null;
                return (
                  <div
                    key={bid}
                    className="causality-row"
                    onClick={() => setSelectedEvent(bid)}
                  >
                    <div className="head">
                      <span className={`severity-badge ${severityClass(e.severity)}`}>
                        {SEVERITY_LABEL[e.severity]}
                      </span>
                      <span>{e.proc_name}</span>
                    </div>
                    <div className="meta">
                      {formatTs(e.ts)} · {e.op} · {e.target}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
