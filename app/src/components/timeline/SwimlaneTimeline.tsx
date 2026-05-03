import { useEffect, useMemo, useRef, useState } from "react";
import {
  selectVisibleEvents,
  selectVisibleRange,
  useEventStore,
} from "../../store/eventStore";
import type { Category } from "../../types";
import { LEFT_GUTTER, render } from "./timelineRenderer";
import { useTimelineZoom } from "./useTimelineZoom";

interface RegionSelection {
  fromNs: number;
  toNs: number;
  pxX: number;
  pxY: number;
}

export function SwimlaneTimeline() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const events = useEventStore(selectVisibleEvents);
  const baseRange = useEventStore(selectVisibleRange);
  const mode = useEventStore((s) => s.mode);
  const focusedPid = useEventStore((s) => s.focusedPid);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);
  const selectedEventId = useEventStore((s) => s.selectedEventId);
  const setSelectedEvent = useEventStore((s) => s.setSelectedEvent);
  const setHoverEvent = useEventStore((s) => s.setHoverEvent);
  const showDimmed = useEventStore((s) => s.settings.show_dimmed);

  const { view, pixelToNs } = useTimelineZoom(wrapRef, {
    baseRange,
    follow: mode === "monitoring",
  });

  // Derive per-pid lane order (most events first; alerts get bumped up).
  const { pidsOrdered, pidLabels } = useMemo(() => {
    const counts = new Map<number, { count: number; alerts: number; name: string }>();
    for (const ev of events) {
      const c = counts.get(ev.pid);
      if (c) {
        c.count += 1;
        if (ev.severity === 2) c.alerts += 1;
      } else {
        counts.set(ev.pid, {
          count: 1,
          alerts: ev.severity === 2 ? 1 : 0,
          name: ev.proc_name,
        });
      }
    }
    const ordered = [...counts.entries()].sort((a, b) => {
      if (b[1].alerts !== a[1].alerts) return b[1].alerts - a[1].alerts;
      return b[1].count - a[1].count;
    });
    const labels = new Map<number, string>();
    const pids = ordered.map(([pid, info]) => {
      labels.set(pid, info.name);
      return pid;
    });
    return { pidsOrdered: pids, pidLabels: labels };
  }, [events]);

  // Hit-test cache (rebuilt each render).
  const hitsRef = useRef<Map<number, { x: number; y: number; w: number; h: number }>>(
    new Map(),
  );
  const laneTopsRef = useRef<Map<number, number>>(new Map());

  // Hover state — separated from the global store to avoid re-rendering
  // every cell on mousemove. We push into the store on `setSelectedEvent`.
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [region, setRegion] = useState<RegionSelection | null>(null);
  const dragStartRef = useRef<{ x: number; ts: number } | null>(null);

  // Resize observer + DPR handling
  const [size, setSize] = useState({ w: 0, h: 0, dpr: window.devicePixelRatio || 1 });
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      setSize({
        w: Math.floor(rect.width),
        h: Math.floor(rect.height),
        dpr: window.devicePixelRatio || 1,
      });
    });
    ro.observe(wrap);
    const rect = wrap.getBoundingClientRect();
    setSize({
      w: Math.floor(rect.width),
      h: Math.floor(rect.height),
      dpr: window.devicePixelRatio || 1,
    });
    return () => ro.disconnect();
  }, []);

  // Render via rAF whenever inputs change.
  const dirtyRef = useRef(true);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    dirtyRef.current = true;
    // Cancel any pending frame so the next loop captures the latest closure.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const loop = () => {
      rafRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const canvas = canvasRef.current;
      if (!canvas || size.w === 0 || size.h === 0) return;
      const dpr = size.dpr;
      // Resize canvas backing store
      if (canvas.width !== size.w * dpr) canvas.width = size.w * dpr;
      if (canvas.height !== size.h * dpr) canvas.height = size.h * dpr;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const result = render({
        ctx,
        width: size.w,
        height: size.h,
        dpr,
        events,
        pidsOrdered,
        pidLabels,
        viewFromNs: view.fromNs,
        viewToNs: view.toNs,
        focusedPid,
        selectedEventId,
        hoverEventId: hoverId,
        showDimmed,
      });
      hitsRef.current = result.hits;
      laneTopsRef.current = result.laneTops;
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [
    size,
    events,
    pidsOrdered,
    pidLabels,
    view.fromNs,
    view.toNs,
    focusedPid,
    selectedEventId,
    hoverId,
    showDimmed,
  ]);

  // Mouse handlers
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.shiftKey) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < LEFT_GUTTER) return;
    dragStartRef.current = {
      x,
      ts: pixelToNs(x, LEFT_GUTTER, size.w),
    };
    setRegion(null);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Drag-region update
    if (dragStartRef.current) {
      const startX = dragStartRef.current.x;
      const startTs = dragStartRef.current.ts;
      const curTs = pixelToNs(x, LEFT_GUTTER, size.w);
      if (Math.abs(x - startX) > 3) {
        setRegion({
          fromNs: Math.min(startTs, curTs),
          toNs: Math.max(startTs, curTs),
          pxX: Math.min(x, startX),
          pxY: y,
        });
      }
      return;
    }

    // Hit test
    let hit: number | null = null;
    for (const [id, r] of hitsRef.current) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit = id;
        break;
      }
    }
    if (hit !== hoverId) {
      setHoverId(hit);
      const ev = hit !== null ? events.find((e2) => e2.id === hit) ?? null : null;
      setHoverEvent(ev);
    }
  };

  const onMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) {
      // click → select hover event if any
      if (hoverId !== null) setSelectedEvent(hoverId);
      else setSelectedEvent(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (Math.abs(x - start.x) < 4) {
      // click without drag → select
      if (hoverId !== null) setSelectedEvent(hoverId);
      else setSelectedEvent(null);
      setRegion(null);
      return;
    }
    // keep region drawn (already set from move handler)
  };

  const onMouseLeave = () => {
    if (hoverId !== null) {
      setHoverId(null);
      setHoverEvent(null);
    }
  };

  const onDoubleClick = () => setRegion(null);

  // Region aggregate
  const regionAgg = useMemo(() => {
    if (!region) return null;
    let total = 0;
    let alert = 0;
    let susp = 0;
    const procs = new Set<number>();
    const cats = new Map<Category, number>();
    for (const ev of events) {
      if (ev.ts < region.fromNs || ev.ts > region.toNs) continue;
      total += 1;
      procs.add(ev.pid);
      if (ev.severity === 2) alert += 1;
      else if (ev.severity === 1) susp += 1;
      cats.set(ev.category, (cats.get(ev.category) ?? 0) + 1);
    }
    return { total, alert, susp, procs: procs.size, cats };
  }, [region, events]);

  return (
    <div className="timeline-root">
      <Toolbar view={view} eventCount={events.length} mode={mode} />
      <div
        className="timeline-canvas-wrap"
        ref={wrapRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onDoubleClick={onDoubleClick}
        onClick={(e) => {
          // lane-label click: focus the pid
          const x = e.nativeEvent.offsetX;
          const y = e.nativeEvent.offsetY;
          if (x < LEFT_GUTTER) {
            for (const [pid, top] of laneTopsRef.current) {
              if (y >= top && y < top + 28) {
                setFocusedPid(focusedPid === pid ? null : pid);
                break;
              }
            }
          }
        }}
      >
        <canvas ref={canvasRef} />
        {region && regionAgg && (
          <div
            className="timeline-popup"
            style={{
              left: Math.min(region.pxX + 8, size.w - 220),
              top: Math.max(8, region.pxY + 12),
            }}
          >
            <div className="head">selection</div>
            <div className="row">
              <span>events</span>
              <span>{regionAgg.total.toLocaleString()}</span>
            </div>
            <div className="row">
              <span>processes</span>
              <span>{regionAgg.procs}</span>
            </div>
            <div className="row">
              <span>alerts</span>
              <span style={{ color: "var(--severity-alert)" }}>{regionAgg.alert}</span>
            </div>
            <div className="row">
              <span>suspicious</span>
              <span style={{ color: "var(--severity-suspicious)" }}>{regionAgg.susp}</span>
            </div>
            <div style={{ marginTop: 6, opacity: 0.7 }}>
              {[...regionAgg.cats]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([cat, n]) => `${cat}:${n}`)
                .join("  ")}
            </div>
          </div>
        )}
      </div>
      <CategoryLegend />
    </div>
  );
}

function Toolbar({
  view,
  eventCount,
  mode,
}: {
  view: { fromNs: number; toNs: number };
  eventCount: number;
  mode: string;
}) {
  const span = view.toNs - view.fromNs;
  const fromLabel = new Date(view.fromNs / 1_000_000).toLocaleTimeString("en-GB", {
    hour12: false,
  });
  const toLabel = new Date(view.toNs / 1_000_000).toLocaleTimeString("en-GB", {
    hour12: false,
  });
  return (
    <div className="timeline-toolbar">
      <span>
        view <span className="pill">{fromLabel} → {toLabel}</span>
      </span>
      <span>
        span <span className="pill">{formatDur(span)}</span>
      </span>
      <span>
        events <span className="pill">{eventCount.toLocaleString()}</span>
      </span>
      <span style={{ marginLeft: "auto", color: "var(--color-text-tertiary)" }}>
        wheel = zoom · shift+drag = pan · drag = aggregate · {mode === "monitoring" ? "live" : "fixed range"}
      </span>
    </div>
  );
}

function CategoryLegend() {
  const cats: { name: Category; color: string }[] = [
    { name: "Process", color: "var(--cat-process)" },
    { name: "File", color: "var(--cat-file)" },
    { name: "Network", color: "var(--cat-network)" },
    { name: "Registry", color: "var(--cat-registry)" },
    { name: "ImageLoad", color: "var(--cat-imageload)" },
    { name: "Thread", color: "var(--cat-thread)" },
    { name: "Handle", color: "var(--cat-handle)" },
    { name: "Integrity", color: "var(--cat-integrity)" },
  ];
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 22,
        background: "var(--color-background-secondary)",
        borderTop: "0.5px solid var(--color-border-tertiary)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--color-text-secondary)",
        pointerEvents: "none",
      }}
    >
      {cats.map((c) => (
        <span key={c.name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              background: c.color,
              borderRadius: 2,
            }}
          />
          {c.name}
        </span>
      ))}
    </div>
  );
}

function formatDur(ns: number): string {
  const s = ns / 1_000_000_000;
  if (s < 1) return `${Math.round(ns / 1_000_000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(2)}h`;
}
