import { memo, useMemo, useState } from "react";
import type { Event } from "../types";
import { SEVERITY_LABEL } from "../types";
import { severityClass, useEventStore } from "../store/eventStore";

function formatTs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  const d = new Date(ms);
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(ms % 1000).padStart(3, "0")}`;
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Cap on rendered rows — bookmarks panel is a quick-jump list, not a log. */
const MAX_ROWS = 12;

export const BookmarksPanel = memo(function BookmarksPanel() {
  const events = useEventStore((s) => s.events);
  const bookmarks = useEventStore((s) => s.bookmarks);
  const setSelectedEvent = useEventStore((s) => s.setSelectedEvent);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);
  const toggleBookmark = useEventStore((s) => s.toggleBookmark);

  const [collapsed, setCollapsed] = useState(false);

  const items: Event[] = useMemo(() => {
    if (bookmarks.size === 0) return [];
    const ids = bookmarks;
    const out: Event[] = [];
    for (const ev of events) {
      if (ev.id !== undefined && ids.has(ev.id)) out.push(ev);
    }
    // Newest first.
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, MAX_ROWS);
  }, [events, bookmarks]);

  const count = bookmarks.size;

  return (
    <aside className="bookmarks-panel">
      <button
        className="bookmarks-section"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? "expand" : "collapse"}
      >
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        bookmarks ({count})
      </button>
      {!collapsed && count > 0 && (
        <div className="bookmarks-list">
          {items.map((e) => (
            <div
              key={e.id}
              className="bookmark-row"
              onClick={() => {
                if (e.id === undefined) return;
                setSelectedEvent(e.id);
                setFocusedPid(e.pid);
              }}
            >
              <div className="head">
                <span className={`severity-badge ${severityClass(e.severity)}`}>
                  {SEVERITY_LABEL[e.severity]}
                </span>
                <span className="proc">{e.proc_name}</span>
                <button
                  className="remove-btn"
                  title="Remove bookmark"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (e.id !== undefined) toggleBookmark(e.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="meta" title={e.target}>
                {formatTs(e.ts)} · {e.op} · {truncate(e.target)}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
});
