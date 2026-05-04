import { useEffect, useMemo, useRef, useState } from "react";
import {
  selectVisibleEvents,
  selectVisibleRange,
  useEventStore,
} from "../../store/eventStore";
import { CATEGORIES } from "../../types";
import type { Category, Event } from "../../types";
import {
  CARET_WIDTH,
  HEADER_HEIGHT,
  LANE_HEIGHT,
  LEFT_GUTTER,
  computePidLayout,
  render,
  renderHeader,
  type PidLayout,
} from "./timelineRenderer";
import { useTimelineZoom } from "./useTimelineZoom";

interface RegionSelection {
  fromNs: number;
  toNs: number;
  pxX: number;
  pxY: number;
}

interface MousePos {
  x: number;
  y: number;
}

type SortMode = "first-seen" | "alerts";

const HOVER_POPUP_W = 260;
const HOVER_POPUP_H_EVENT = 96;
const HOVER_POPUP_H_LANE = 60;
const TARGET_MAX = 60;
/** Causality candidates are capped to keep the overlay legible. */
const CAUSALITY_CAP = 8;

function formatTs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  const d = new Date(ms);
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(ms % 1000).padStart(3, "0")}`;
}

function ellipsizeMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

/** Cap effective redraw rate. 30fps is plenty for time-series glyphs. */
const FRAME_BUDGET_MS = 33;
/** Bottom legend strip height — must match `.timeline-legend-strip`. */
const LEGEND_HEIGHT = 22;

export function SwimlaneTimeline() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyCanvasRef = useRef<HTMLCanvasElement>(null);
  const headerCanvasRef = useRef<HTMLCanvasElement>(null);

  const events = useEventStore(selectVisibleEvents);
  const baseRange = useEventStore(selectVisibleRange);
  const mode = useEventStore((s) => s.mode);
  const focusedPid = useEventStore((s) => s.focusedPid);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);
  const selectedEventId = useEventStore((s) => s.selectedEventId);
  const setSelectedEvent = useEventStore((s) => s.setSelectedEvent);
  const setHoverEvent = useEventStore((s) => s.setHoverEvent);
  const showDimmed = useEventStore((s) => s.settings.show_dimmed);

  const { view, pixelToNs, isPaused, resetView } = useTimelineZoom(wrapRef, {
    baseRange,
    follow: mode === "monitoring",
  });

  // Lane sort mode is local to the timeline — it's a per-user view preference,
  // not something the rest of the app needs to coordinate on.
  const [sortMode, setSortMode] = useState<SortMode>("first-seen");

  // Per-pid expansion state. Local to the timeline view and intentionally
  // not persisted across sessions — the right pids to expand depends on
  // current activity.
  const [expandedPids, setExpandedPids] = useState<Set<number>>(() => new Set());
  const togglePidExpansion = (pid: number) => {
    setExpandedPids((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  // Derive per-pid lane order. In `first-seen` mode we use the PID's first
  // appearance index in the current visible-events array; this keeps the lane
  // a user is watching from jumping when a new alert arrives. In `alerts`
  // mode we sort by alert count desc, then total event count desc.
  // We also expose the per-pid counts so the lane-label hover popup can
  // surface them without re-scanning `events`.
  const { pidsOrdered, pidLabels, pidStats } = useMemo(() => {
    const firstIndex = new Map<number, number>();
    const stat = new Map<number, { count: number; alerts: number; name: string }>();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!firstIndex.has(ev.pid)) firstIndex.set(ev.pid, i);
      const s = stat.get(ev.pid);
      if (s) {
        s.count += 1;
        if (ev.severity === 2) s.alerts += 1;
      } else {
        stat.set(ev.pid, {
          count: 1,
          alerts: ev.severity === 2 ? 1 : 0,
          name: ev.proc_name,
        });
      }
    }
    const pids = [...firstIndex.keys()];
    if (sortMode === "alerts") {
      pids.sort((a, b) => {
        const sa = stat.get(a)!;
        const sb = stat.get(b)!;
        if (sb.alerts !== sa.alerts) return sb.alerts - sa.alerts;
        return sb.count - sa.count;
      });
    }
    // first-seen mode: insertion order of `firstIndex` already reflects
    // first-appearance order in the visible array.
    const labels = new Map<number, string>();
    const stats = new Map<number, { events: number; alerts: number; name: string }>();
    for (const pid of pids) {
      const s = stat.get(pid);
      labels.set(pid, s?.name ?? `pid ${pid}`);
      stats.set(pid, {
        events: s?.count ?? 0,
        alerts: s?.alerts ?? 0,
        name: s?.name ?? `pid ${pid}`,
      });
    }
    return { pidsOrdered: pids, pidLabels: labels, pidStats: stats };
  }, [events, sortMode]);

  // Drop expansions for pids that fall out of the visible window so we don't
  // accumulate stale entries forever in long sessions. Cheap — pidsOrdered
  // changes infrequently.
  useEffect(() => {
    if (expandedPids.size === 0) return;
    const valid = new Set(pidsOrdered);
    let needsUpdate = false;
    for (const pid of expandedPids) {
      if (!valid.has(pid)) {
        needsUpdate = true;
        break;
      }
    }
    if (!needsUpdate) return;
    setExpandedPids((prev) => {
      const next = new Set<number>();
      for (const pid of prev) if (valid.has(pid)) next.add(pid);
      return next;
    });
  }, [pidsOrdered, expandedPids]);

  // Stable string fingerprint of expandedPids for redraw-skip comparison.
  const expandedKey = useMemo(() => {
    const arr = [...expandedPids];
    arr.sort((a, b) => a - b);
    return arr.join(",");
  }, [expandedPids]);

  // Layout — single source of truth for vertical placement, shared with the
  // renderer (so hit-tests and draw stay in sync).
  const layout = useMemo(
    () => computePidLayout(pidsOrdered, expandedPids),
    [pidsOrdered, expandedPids],
  );

  const expandAll = () => setExpandedPids(new Set(pidsOrdered));
  const collapseAll = () => setExpandedPids(new Set());

  // Category visibility — clicking a legend item toggles. Initial: all on.
  const [enabledCategories, setEnabledCategories] = useState<Set<Category>>(
    () => new Set(CATEGORIES),
  );
  const enabledCategoriesKey = useMemo(() => {
    const arr = [...enabledCategories];
    arr.sort();
    return arr.join(",");
  }, [enabledCategories]);
  const toggleCategory = (cat: Category, soloMode: boolean) => {
    setEnabledCategories((prev) => {
      // Solo (shift/alt): if this is already the only enabled category,
      // re-enable everything; otherwise enable only this one.
      if (soloMode) {
        if (prev.size === 1 && prev.has(cat)) return new Set(CATEGORIES);
        return new Set([cat]);
      }
      const next = new Set(prev);
      if (next.has(cat)) {
        // Don't allow disabling the very last category (would blank the
        // timeline with no obvious affordance to recover).
        if (next.size === 1) return new Set(CATEGORIES);
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  // Hit-test cache (rebuilt each render). Coords are in CSS px relative to
  // the body canvas. The wrapping div scrolls vertically with the canvas, so
  // mouse coords against the body canvas's getBoundingClientRect() match.
  const hitsRef = useRef<Map<number, { x: number; y: number; w: number; h: number }>>(
    new Map(),
  );
  const layoutRef = useRef<Map<number, PidLayout>>(new Map());
  layoutRef.current = layout.byPid;

  // Hover state — separated from the global store to avoid re-rendering
  // every cell on mousemove. We push into the store on `setSelectedEvent`.
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [laneHoverPid, setLaneHoverPid] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<MousePos | null>(null);
  const [region, setRegion] = useState<RegionSelection | null>(null);
  const dragStartRef = useRef<{ x: number; ts: number } | null>(null);

  // Wrapper size (CSS px). Width is the visible chart width; height is the
  // viewport-visible height (excluding header + bottom legend strip).
  const [size, setSize] = useState({ w: 0, h: 0, dpr: window.devicePixelRatio || 1 });
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const rect = wrap.getBoundingClientRect();
      setSize({
        w: Math.floor(rect.width),
        h: Math.floor(rect.height),
        dpr: window.devicePixelRatio || 1,
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, []);

  // Body canvas height grows with the (variable, expansion-aware) lane sum.
  // We use at least the visible viewport so empty/sparse states fill the
  // area; once lanes exceed the viewport, the wrapper scrolls.
  const bodyHeight = Math.max(size.h, layout.totalHeight);

  // Causality overlay. Only computed when there's a selected event; matches
  // the same definition the EventDetailPanel uses (children spawned by the
  // selected pid, plus other procs touching the same target). Capped per-bucket.
  const causalityLinks = useMemo(() => {
    if (selectedEventId === null) return null;
    const selected = events.find((e) => e.id === selectedEventId);
    if (!selected) return null;
    const span = Math.max(1, view.toNs - view.fromNs);
    const chartW = Math.max(1, size.w - LEFT_GUTTER);

    /**
     * Project an event to body-canvas coords. Returns `null` when the
     * event's pid isn't in the current visible lane set (so it has no row
     * to anchor to). Sub-lane-aware via the shared layout.
     */
    const project = (ev: Event): { x: number; y: number } | null => {
      const lay = layout.byPid.get(ev.pid);
      if (!lay) return null;
      let top: number;
      let h: number;
      if (lay.subLanes) {
        const sub = lay.subLanes.find((s) => s.category === ev.category);
        if (!sub) return null;
        top = sub.top;
        h = sub.height;
      } else {
        top = lay.top;
        h = lay.mainHeight;
      }
      const x = LEFT_GUTTER + ((ev.ts - view.fromNs) / span) * chartW;
      return { x, y: top + h / 2 };
    };

    const fromPt = project(selected);
    if (!fromPt) return null;

    const links: { from: { x: number; y: number }; to: { x: number; y: number }; kind: "spawn" | "sameTarget" }[] = [];
    const children: Event[] = [];
    const sameTarget: Event[] = [];
    for (const ev of events) {
      if (ev.id === selected.id) continue;
      if (ev.ppid === selected.pid && ev.category === "Process") {
        if (children.length < CAUSALITY_CAP) children.push(ev);
      } else if (ev.target === selected.target && ev.pid !== selected.pid) {
        if (sameTarget.length < CAUSALITY_CAP) sameTarget.push(ev);
      }
      if (children.length >= CAUSALITY_CAP && sameTarget.length >= CAUSALITY_CAP) break;
    }
    for (const ev of children) {
      const to = project(ev);
      if (to) links.push({ from: fromPt, to, kind: "spawn" });
    }
    for (const ev of sameTarget) {
      const to = project(ev);
      if (to) links.push({ from: fromPt, to, kind: "sameTarget" });
    }
    return links;
  }, [events, selectedEventId, view.fromNs, view.toNs, size.w, layout]);

  // ---- Render scheduling ---------------------------------------------------
  // Coalesce all redraw requests through a single rAF tick capped at ~30fps.
  // Inputs are stored in refs so the loop always reads the latest values
  // without us spawning a fresh closure on every prop change.
  const renderInputsRef = useRef({
    events,
    pidsOrdered,
    pidLabels,
    view,
    focusedPid,
    selectedEventId,
    hoverId,
    showDimmed,
    size,
    bodyHeight,
    sortMode,
    enabledCategories,
    enabledCategoriesKey,
    expandedPids,
    expandedKey,
    causalityLinks,
  });
  renderInputsRef.current = {
    events,
    pidsOrdered,
    pidLabels,
    view,
    focusedPid,
    selectedEventId,
    hoverId,
    showDimmed,
    size,
    bodyHeight,
    sortMode,
    enabledCategories,
    enabledCategoriesKey,
    expandedPids,
    expandedKey,
    causalityLinks,
  };

  // Track which inputs we drew last so we can decide whether a new event
  // batch actually requires a repaint. Events that fall outside the
  // visible window (count of events in-window unchanged) skip the redraw.
  const lastDrawRef = useRef({
    eventsLength: -1,
    lastEventTs: -1,
    lastEventInRange: -1, // ts of the most recent in-window event we drew
    inRangeCount: -1,
    fromNs: -1,
    toNs: -1,
    pidCount: -1,
    focusedPid: null as number | null,
    selectedEventId: null as number | null,
    hoverId: null as number | null,
    showDimmed,
    sizeW: 0,
    sizeH: 0,
    sizeDpr: 1,
    bodyHeight: 0,
    sortMode: "first-seen" as SortMode,
    enabledCategoriesKey: "",
    expandedKey: "",
  });

  const dirtyRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastPaintRef = useRef(0);

  // Tick once per RAF; if we painted within the frame budget, defer.
  useEffect(() => {
    const schedule = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(loop);
    };
    const loop = () => {
      rafRef.current = null;
      const now = performance.now();
      if (now - lastPaintRef.current < FRAME_BUDGET_MS) {
        // Within frame budget — re-queue the next rAF and try again.
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      if (!dirtyRef.current) return;
      const inputs = renderInputsRef.current;
      const bodyCanvas = bodyCanvasRef.current;
      const headerCanvas = headerCanvasRef.current;
      if (!bodyCanvas || !headerCanvas || inputs.size.w === 0 || inputs.size.h === 0)
        return;

      // Decide whether the visible content actually changed since the
      // last paint. Cheap signature check first.
      const evs = inputs.events;
      let lastTs = -1;
      let inRangeCount = 0;
      let lastInRangeTs = -1;
      const ec = inputs.enabledCategories;
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.ts > lastTs) lastTs = ev.ts;
        if (ev.ts >= inputs.view.fromNs && ev.ts <= inputs.view.toNs) {
          if (!ec.has(ev.category)) continue;
          inRangeCount++;
          if (ev.ts > lastInRangeTs) lastInRangeTs = ev.ts;
        }
      }
      const ld = lastDrawRef.current;
      const sameVisibleSet =
        inRangeCount === ld.inRangeCount &&
        lastInRangeTs === ld.lastEventInRange &&
        inputs.view.fromNs === ld.fromNs &&
        inputs.view.toNs === ld.toNs &&
        inputs.pidsOrdered.length === ld.pidCount &&
        inputs.focusedPid === ld.focusedPid &&
        inputs.selectedEventId === ld.selectedEventId &&
        inputs.hoverId === ld.hoverId &&
        inputs.showDimmed === ld.showDimmed &&
        inputs.size.w === ld.sizeW &&
        inputs.size.h === ld.sizeH &&
        inputs.size.dpr === ld.sizeDpr &&
        inputs.bodyHeight === ld.bodyHeight &&
        inputs.sortMode === ld.sortMode &&
        inputs.enabledCategoriesKey === ld.enabledCategoriesKey &&
        inputs.expandedKey === ld.expandedKey;
      if (sameVisibleSet) {
        // Nothing to paint. Stay clean; future state changes will redirty.
        dirtyRef.current = false;
        return;
      }

      dirtyRef.current = false;
      lastPaintRef.current = now;

      const dpr = inputs.size.dpr;

      // Header canvas — fixed HEADER_HEIGHT, full width.
      const hW = inputs.size.w;
      const hH = HEADER_HEIGHT;
      if (headerCanvas.width !== hW * dpr) headerCanvas.width = hW * dpr;
      if (headerCanvas.height !== hH * dpr) headerCanvas.height = hH * dpr;
      headerCanvas.style.width = `${hW}px`;
      headerCanvas.style.height = `${hH}px`;
      const headerCtx = headerCanvas.getContext("2d");
      if (headerCtx) {
        renderHeader({
          ctx: headerCtx,
          width: hW,
          height: hH,
          dpr,
          viewFromNs: inputs.view.fromNs,
          viewToNs: inputs.view.toNs,
        });
      }

      // Body canvas — width matches wrapper, height grows with lane count.
      const bW = inputs.size.w;
      const bH = inputs.bodyHeight;
      if (bodyCanvas.width !== bW * dpr) bodyCanvas.width = bW * dpr;
      if (bodyCanvas.height !== bH * dpr) bodyCanvas.height = bH * dpr;
      bodyCanvas.style.width = `${bW}px`;
      bodyCanvas.style.height = `${bH}px`;
      const bodyCtx = bodyCanvas.getContext("2d");
      if (!bodyCtx) return;
      const result = render({
        ctx: bodyCtx,
        width: bW,
        height: bH,
        dpr,
        events: inputs.events,
        pidsOrdered: inputs.pidsOrdered,
        pidLabels: inputs.pidLabels,
        viewFromNs: inputs.view.fromNs,
        viewToNs: inputs.view.toNs,
        focusedPid: inputs.focusedPid,
        selectedEventId: inputs.selectedEventId,
        hoverEventId: inputs.hoverId,
        showDimmed: inputs.showDimmed,
        enabledCategories: inputs.enabledCategories,
        expandedPids: inputs.expandedPids,
        causalityLinks: inputs.causalityLinks,
      });
      hitsRef.current = result.hits;
      layoutRef.current = result.layoutByPid;

      ld.eventsLength = evs.length;
      ld.lastEventTs = lastTs;
      ld.lastEventInRange = lastInRangeTs;
      ld.inRangeCount = inRangeCount;
      ld.fromNs = inputs.view.fromNs;
      ld.toNs = inputs.view.toNs;
      ld.pidCount = inputs.pidsOrdered.length;
      ld.focusedPid = inputs.focusedPid;
      ld.selectedEventId = inputs.selectedEventId;
      ld.hoverId = inputs.hoverId;
      ld.showDimmed = inputs.showDimmed;
      ld.sizeW = inputs.size.w;
      ld.sizeH = inputs.size.h;
      ld.sizeDpr = inputs.size.dpr;
      ld.bodyHeight = inputs.bodyHeight;
      ld.sortMode = inputs.sortMode;
      ld.enabledCategoriesKey = inputs.enabledCategoriesKey;
      ld.expandedKey = inputs.expandedKey;
    };

    dirtyRef.current = true;
    schedule();
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
    bodyHeight,
    sortMode,
    enabledCategoriesKey,
    expandedKey,
    causalityLinks,
  ]);

  // Mouse handlers operate on the body canvas's coordinate system. Using
  // the body canvas's bounding rect (rather than the wrapper's) means
  // scrollTop is implicitly accounted for — scrolling moves the canvas, so
  // the rect's top moves too.
  const bodyRect = () => bodyCanvasRef.current?.getBoundingClientRect();

  /**
   * Resolve the pid whose lane region (main + sub-lanes) contains y. Used
   * by gutter-hover and click handlers so an expanded pid's sub-lane area
   * still tracks back to the parent pid.
   */
  const pidAtY = (y: number): number | null => {
    for (const entry of layoutRef.current.values()) {
      if (y >= entry.top && y < entry.top + entry.totalHeight) return entry.pid;
    }
    return null;
  };

  /**
   * True when (x, y) falls in the caret hit-area at the head of a pid's main
   * lane. Returns the pid in question, or null otherwise.
   */
  const caretPidAt = (x: number, y: number): number | null => {
    if (x >= CARET_WIDTH) return null;
    for (const entry of layoutRef.current.values()) {
      if (y >= entry.top && y < entry.top + entry.mainHeight) return entry.pid;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.shiftKey) return;
    const rect = bodyRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    if (x < LEFT_GUTTER) return;
    dragStartRef.current = {
      x,
      ts: pixelToNs(x, LEFT_GUTTER, size.w),
    };
    setRegion(null);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = bodyRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMousePos({ x, y });

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

    // Lane gutter hover-test (left of the chart area). The hover follows
    // the parent pid even when the cursor is inside one of its sub-lanes,
    // so the popup content stays consistent regardless of expansion.
    if (x < LEFT_GUTTER) {
      const nextLanePid = pidAtY(y);
      if (nextLanePid !== laneHoverPid) setLaneHoverPid(nextLanePid);
      // No event hit-test in the gutter — clear any glyph hover.
      if (hoverId !== null) {
        setHoverId(null);
        setHoverEvent(null);
      }
      return;
    } else if (laneHoverPid !== null) {
      setLaneHoverPid(null);
    }

    // Glyph hit test
    let hit: number | null = null;
    for (const [id, r] of hitsRef.current) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit = id;
        break;
      }
    }
    if (hit !== hoverId) {
      setHoverId(hit);
      const ev: Event | null =
        hit !== null ? events.find((e2) => e2.id === hit) ?? null : null;
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
    const rect = bodyRect();
    if (!rect) return;
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
    if (laneHoverPid !== null) setLaneHoverPid(null);
    setMousePos(null);
  };

  const onDoubleClick = () => setRegion(null);

  // Hover event lookup — used by the popup. Cheap when hoverId is null.
  const hoverEvent = useMemo<Event | null>(() => {
    if (hoverId === null) return null;
    return events.find((e) => e.id === hoverId) ?? null;
  }, [hoverId, events]);

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
      <Toolbar
        view={view}
        eventCount={events.length}
        mode={mode}
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        isPaused={isPaused}
        onGoLive={resetView}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        anyExpanded={expandedPids.size > 0}
      />
      <div className="timeline-canvas-wrap">
        <div className="timeline-header-sticky">
          <canvas ref={headerCanvasRef} />
        </div>
        <div
          className="timeline-body-scroll"
          ref={wrapRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onDoubleClick={onDoubleClick}
          onClick={(e) => {
            // Gutter clicks: caret = expand/collapse, otherwise = focus pid.
            const rect = bodyCanvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            if (x >= LEFT_GUTTER) return;
            const caretPid = caretPidAt(x, y);
            if (caretPid !== null) {
              togglePidExpansion(caretPid);
              return;
            }
            // Focus toggle on the lane label area. Use the main-lane band
            // only — sub-lane area in the gutter is non-actionable to keep
            // the click target predictable.
            for (const entry of layoutRef.current.values()) {
              if (y >= entry.top && y < entry.top + entry.mainHeight) {
                setFocusedPid(focusedPid === entry.pid ? null : entry.pid);
                break;
              }
            }
          }}
        >
          <canvas ref={bodyCanvasRef} />
          {/* Lane-label gutter hover popup. Suppressed while a region drag
              popup is showing so we don't stack two popups. The popup is
              positioned inside `.timeline-body-scroll` so it scrolls with
              the body canvas — mousePos is body-canvas relative. */}
          {!region && laneHoverPid !== null && mousePos && (() => {
            const stat = pidStats.get(laneHoverPid);
            if (!stat) return null;
            const popW = 220;
            const popH = HOVER_POPUP_H_LANE;
            let left = mousePos.x + 12;
            let top = mousePos.y + 12;
            if (left + popW > size.w - 8) left = mousePos.x - popW - 12;
            if (top + popH > bodyHeight - 8) top = mousePos.y - popH - 12;
            left = Math.max(4, left);
            top = Math.max(4, top);
            return (
              <div
                className="timeline-popup hover lane"
                style={{ left, top, minWidth: popW }}
              >
                <div className="head">{stat.name} [{laneHoverPid}]</div>
                <div className="row">
                  <span>events</span>
                  <span>{stat.events.toLocaleString()}</span>
                </div>
                <div className="row">
                  <span>alerts</span>
                  <span style={{ color: "var(--severity-alert)" }}>{stat.alerts}</span>
                </div>
              </div>
            );
          })()}
          {/* Event glyph hover popup. Same coordinate space as the lane
              gutter popup — both anchor to mousePos which is body-canvas
              relative, so they stay attached when the user scrolls. */}
          {!region && hoverEvent && mousePos && (() => {
            const popW = HOVER_POPUP_W;
            const popH = HOVER_POPUP_H_EVENT;
            let left = mousePos.x + 12;
            let top = mousePos.y + 12;
            if (left + popW > size.w - 8) left = mousePos.x - popW - 12;
            if (top + popH > bodyHeight - 8) top = mousePos.y - popH - 12;
            left = Math.max(4, left);
            top = Math.max(4, top);
            const sevLabel =
              hoverEvent.severity === 2
                ? "alert"
                : hoverEvent.severity === 1
                  ? "suspicious"
                  : null;
            const sevColor =
              hoverEvent.severity === 2
                ? "var(--severity-alert)"
                : "var(--severity-suspicious)";
            return (
              <div
                className="timeline-popup hover event"
                style={{ left, top, minWidth: popW }}
              >
                <div className="head" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{formatTs(hoverEvent.ts)}</span>
                  {sevLabel && (
                    <span
                      style={{
                        color: sevColor,
                        border: `0.5px solid ${sevColor}`,
                        borderRadius: 3,
                        padding: "0 4px",
                        fontSize: 10,
                      }}
                    >
                      {sevLabel}
                    </span>
                  )}
                </div>
                <div style={{ color: "var(--color-text-primary)" }}>
                  {hoverEvent.proc_name} <span style={{ color: "var(--color-text-tertiary)" }}>[{hoverEvent.pid}]</span>
                </div>
                <div style={{ color: "var(--color-text-secondary)", marginTop: 2 }}>
                  {hoverEvent.category} · {hoverEvent.op}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    color: "var(--color-text-tertiary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: popW - 16,
                  }}
                  title={hoverEvent.target}
                >
                  {ellipsizeMid(hoverEvent.target, TARGET_MAX)}
                </div>
              </div>
            );
          })()}
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
      </div>
      <CategoryLegend
        enabled={enabledCategories}
        onToggle={toggleCategory}
      />
    </div>
  );
}

function Toolbar({
  view,
  eventCount,
  mode,
  sortMode,
  onSortModeChange,
  isPaused,
  onGoLive,
  onExpandAll,
  onCollapseAll,
  anyExpanded,
}: {
  view: { fromNs: number; toNs: number };
  eventCount: number;
  mode: string;
  sortMode: SortMode;
  onSortModeChange: (m: SortMode) => void;
  isPaused: boolean;
  onGoLive: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  anyExpanded: boolean;
}) {
  const span = view.toNs - view.fromNs;
  const fromLabel = new Date(view.fromNs / 1_000_000).toLocaleTimeString("en-GB", {
    hour12: false,
  });
  const toLabel = new Date(view.toNs / 1_000_000).toLocaleTimeString("en-GB", {
    hour12: false,
  });
  const monitoring = mode === "monitoring";
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
      <div className="mode-toggle timeline-sort-toggle" role="group" aria-label="lane sort">
        <button
          type="button"
          className={sortMode === "first-seen" ? "active" : ""}
          onClick={() => onSortModeChange("first-seen")}
        >
          first-seen
        </button>
        <button
          type="button"
          className={sortMode === "alerts" ? "active" : ""}
          onClick={() => onSortModeChange("alerts")}
        >
          alerts ↓
        </button>
      </div>
      <div className="mode-toggle timeline-expand-toggle" role="group" aria-label="lane expansion">
        <button type="button" onClick={onExpandAll} title="Expand every lane">
          expand all
        </button>
        <button
          type="button"
          onClick={onCollapseAll}
          title="Collapse every lane"
          disabled={!anyExpanded}
        >
          collapse all
        </button>
      </div>
      {monitoring &&
        (isPaused ? (
          <span className="live-pill paused">
            <span className="dot paused" />
            PAUSED
            <button type="button" className="go-live" onClick={onGoLive}>
              ▶ Go live
            </button>
          </span>
        ) : (
          <span className="live-pill live">
            <span className="dot live" />
            LIVE
          </span>
        ))}
      <span style={{ marginLeft: "auto", color: "var(--color-text-tertiary)" }}>
        wheel = zoom · shift+drag = pan · drag = aggregate · click ▶ = expand
      </span>
    </div>
  );
}

function CategoryLegend({
  enabled,
  onToggle,
}: {
  enabled: Set<Category>;
  onToggle: (cat: Category, soloMode: boolean) => void;
}) {
  // `glyph` is a one-letter prefix that lets color-blind / monochrome
  // viewers distinguish categories without relying on the swatch color.
  const cats: { name: Category; color: string; glyph: string }[] = [
    { name: "Process", color: "var(--cat-process)", glyph: "P" },
    { name: "File", color: "var(--cat-file)", glyph: "F" },
    { name: "Network", color: "var(--cat-network)", glyph: "N" },
    { name: "Registry", color: "var(--cat-registry)", glyph: "R" },
    { name: "ImageLoad", color: "var(--cat-imageload)", glyph: "I" },
    { name: "Thread", color: "var(--cat-thread)", glyph: "T" },
    { name: "Handle", color: "var(--cat-handle)", glyph: "H" },
    { name: "Integrity", color: "var(--cat-integrity)", glyph: "⚠" },
  ];
  return (
    <div
      className="timeline-legend-strip"
      style={{
        height: LEGEND_HEIGHT,
      }}
    >
      {cats.map((c) => {
        const off = !enabled.has(c.name);
        return (
          <span
            key={c.name}
            className={`item${off ? " off" : ""}`}
            onClick={(e) => onToggle(c.name, e.shiftKey || e.altKey)}
            title={`Toggle ${c.name} · shift/alt-click = solo`}
          >
            <span
              className="swatch"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: c.color,
                color: "#0f1011",
                fontWeight: 700,
                fontSize: 9,
                lineHeight: 1,
              }}
              aria-hidden
            >
              {c.glyph}
            </span>
            {c.name}
          </span>
        );
      })}
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
