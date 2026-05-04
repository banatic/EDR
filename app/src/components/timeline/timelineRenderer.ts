/**
 * Canvas-based timeline renderer.
 *
 * Layout:
 *  - Y axis = process lanes (one row per pid). Lanes can be expanded into 8
 *    per-category sub-lanes.
 *  - X axis = time (mapped through `viewFromNs..viewToNs`)
 *  - Each cell is rendered as a small rect tinted by category and severity
 *  - Density is conveyed by semi-transparent overlap, plus an aggregated
 *    heatmap row at the top per lane.
 *  - severity=Alert events draw a red overlay + a triangular marker at the
 *    top of their lane.
 *
 * The header (time axis) and the body (lanes) draw to *separate* canvases so
 * the body can scroll vertically while the header stays pinned. They share
 * the same time→x mapping so vertical grid lines line up between them.
 *
 * Virtualization: we filter events by visible time range *before* drawing,
 * so 50k mocked events render only the slice intersecting the viewport.
 */

import type { Category, Event, Severity } from "../../types";
import { CATEGORIES } from "../../types";

export const LANE_HEIGHT = 28;
export const LANE_PAD = 4;
export const HEADER_HEIGHT = 24;
export const LEFT_GUTTER = 140;
export const SUB_LANE_HEIGHT = 18;
export const SUB_LANE_PAD = 2;
/** Width of the expand/collapse caret hit area at the very left. */
export const CARET_WIDTH = 16;

const CATEGORY_COLOR: Record<Category, string> = {
  Process: "#93c5fd",
  File: "#86efac",
  Network: "#c4b5fd",
  Registry: "#fcd34d",
  ImageLoad: "#67e8f9",
  Thread: "#f0abfc",
  Handle: "#fdba74",
  Integrity: "#fca5a5",
};

const SEVERITY_RING: Record<Severity, string | null> = {
  0: null,
  1: "#fcd34d",
  2: "#f87171",
};

/**
 * A single sub-lane describing where one category's events should be drawn
 * underneath an expanded pid.
 */
export interface SubLane {
  category: Category;
  /** Top y of the sub-lane (CSS px, body-canvas relative). */
  top: number;
  /** Height of the sub-lane (CSS px). Constant SUB_LANE_HEIGHT today. */
  height: number;
}

/**
 * Layout entry for one pid lane. `subLanes` is set iff the pid is expanded.
 * The total vertical region the pid occupies is
 *   `top .. top + mainHeight + (subLanes ? subLanes.length * SUB_LANE_HEIGHT : 0)`
 * which is also returned as `totalHeight` for convenience.
 */
export interface PidLayout {
  pid: number;
  top: number;
  mainHeight: number;
  totalHeight: number;
  subLanes: SubLane[] | null;
}

/**
 * Compute the lane stacking layout given the order of pids and the set of
 * expanded ones. This is the single source of truth for vertical placement
 * — the renderer and the React-side hit-test both call it.
 */
export function computePidLayout(
  pidsOrdered: number[],
  expandedPids: Set<number>,
): { lanes: PidLayout[]; totalHeight: number; byPid: Map<number, PidLayout> } {
  const lanes: PidLayout[] = [];
  const byPid = new Map<number, PidLayout>();
  let cursor = 0;
  for (const pid of pidsOrdered) {
    const expanded = expandedPids.has(pid);
    let subLanes: SubLane[] | null = null;
    let totalHeight = LANE_HEIGHT;
    if (expanded) {
      subLanes = [];
      let subTop = cursor + LANE_HEIGHT;
      for (const cat of CATEGORIES) {
        subLanes.push({ category: cat, top: subTop, height: SUB_LANE_HEIGHT });
        subTop += SUB_LANE_HEIGHT;
      }
      totalHeight = LANE_HEIGHT + CATEGORIES.length * SUB_LANE_HEIGHT;
    }
    const entry: PidLayout = {
      pid,
      top: cursor,
      mainHeight: LANE_HEIGHT,
      totalHeight,
      subLanes,
    };
    lanes.push(entry);
    byPid.set(pid, entry);
    cursor += totalHeight;
  }
  return { lanes, totalHeight: cursor, byPid };
}

/**
 * A causality link to draw on top of the lane content. Coordinates are in
 * CSS px relative to the body canvas. `kind` maps to two visual styles:
 * `spawn` is a solid orange curve, `sameTarget` is a dashed grey curve.
 */
export interface CausalityLink {
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: "spawn" | "sameTarget";
}

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  /** CSS-pixel width of the body canvas. */
  width: number;
  /** CSS-pixel height of the body canvas (lanes only — no header). */
  height: number;
  dpr: number;

  events: Event[];
  pidsOrdered: number[];
  pidLabels: Map<number, string>;

  viewFromNs: number;
  viewToNs: number;

  focusedPid: number | null;
  selectedEventId: number | null;
  hoverEventId: number | null;
  showDimmed: boolean;
  /**
   * Categories the user wants visible. Events with a category not in this
   * set are skipped in heatmap, glyph and hit-test passes (so hover/click
   * also become inert for them).
   */
  enabledCategories: Set<Category>;
  /** Pids whose category sub-lanes should be rendered expanded. */
  expandedPids: Set<number>;
  /** Optional causality overlay; drawn last on top of everything. */
  causalityLinks?: CausalityLink[] | null;
}

export interface HitTarget {
  event: Event;
  x: number;
  y: number;
}

export interface RenderResult {
  /** Hit-test rects keyed by event id, in CSS pixels relative to the body canvas. */
  hits: Map<number, { x: number; y: number; w: number; h: number }>;
  /** Mapping pid → laneTop (CSS px, body-canvas relative) — main lane top. */
  laneTops: Map<number, number>;
  /** Full layout entries, keyed by pid. */
  layoutByPid: Map<number, PidLayout>;
}

export interface HeaderRenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  viewFromNs: number;
  viewToNs: number;
}

/**
 * Draws only the time-axis header strip. The body's vertical grid lines are
 * drawn by `render()` against the same tick set so the two canvases align.
 */
export function renderHeader(input: HeaderRenderInput): void {
  const { ctx, width, height, dpr, viewFromNs, viewToNs } = input;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#17181a";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#1c1d1f";
  ctx.beginPath();
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();

  // Vertical separator between gutter and chart.
  ctx.strokeStyle = "#1c1d1f";
  ctx.beginPath();
  ctx.moveTo(LEFT_GUTTER, 0);
  ctx.lineTo(LEFT_GUTTER, height);
  ctx.stroke();

  const chartW = Math.max(1, width - LEFT_GUTTER);
  const span = Math.max(1, viewToNs - viewFromNs);
  const ticks = chooseTicks(span);
  const startMs = Math.ceil(viewFromNs / 1_000_000 / ticks) * ticks;
  const endMs = Math.floor(viewToNs / 1_000_000);

  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";

  for (let ms = startMs; ms <= endMs; ms += ticks) {
    const ns = ms * 1_000_000;
    const x = LEFT_GUTTER + ((ns - viewFromNs) / span) * chartW;
    // Tick marker on the header
    ctx.strokeStyle = "rgba(154, 154, 154, 0.25)";
    ctx.beginPath();
    ctx.moveTo(x, height - 4);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillStyle = "#9a9a9a";
    ctx.fillText(formatTick(ms, ticks), x + 4, height / 2);
  }

  ctx.restore();
}

/**
 * Renders lanes + events into the body canvas. The caller sizes the canvas
 * to the value returned from `computePidLayout(pidsOrdered, expandedPids)`
 * (`totalHeight`) so the wrapping div can scroll it.
 */
export function render(input: RenderInput): RenderResult {
  const { ctx, width, height, events, pidsOrdered, pidLabels, focusedPid } = input;
  const { viewFromNs, viewToNs, selectedEventId, hoverEventId, showDimmed } = input;
  const { enabledCategories, expandedPids, causalityLinks } = input;

  ctx.save();
  ctx.scale(input.dpr, input.dpr);
  ctx.clearRect(0, 0, width, height);

  // Background
  ctx.fillStyle = "#0f1011";
  ctx.fillRect(0, 0, width, height);

  // ---- vertical grid lines (mirrored from header ticks) ----
  const span = Math.max(1, viewToNs - viewFromNs);
  const chartWidth = Math.max(1, width - LEFT_GUTTER);
  const ticks = chooseTicks(span);
  const startMs = Math.ceil(viewFromNs / 1_000_000 / ticks) * ticks;
  const endMs = Math.floor(viewToNs / 1_000_000);
  ctx.strokeStyle = "rgba(154, 154, 154, 0.12)";
  ctx.lineWidth = 1;
  for (let ms = startMs; ms <= endMs; ms += ticks) {
    const ns = ms * 1_000_000;
    const x = LEFT_GUTTER + ((ns - viewFromNs) / span) * chartWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // ---- lanes ----
  const layout = computePidLayout(pidsOrdered, expandedPids);
  const laneTops = new Map<number, number>();
  for (const entry of layout.lanes) {
    const { pid, top, mainHeight, subLanes } = entry;
    laneTops.set(pid, top);

    // Lane separator at top of main lane
    ctx.strokeStyle = "#1c1d1f";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(width, top);
    ctx.stroke();

    // Focus highlight (main lane only). The fill is intentionally subtle so
    // it doesn't overwhelm event glyphs; the 2px accent strip on the left
    // gives an unmissable cue without raising the fill opacity further.
    if (focusedPid === pid) {
      ctx.fillStyle = "rgba(217, 119, 87, 0.12)";
      ctx.fillRect(0, top, width, mainHeight);
      ctx.fillStyle = "#d97757";
      ctx.fillRect(0, top, 2, mainHeight);
    }

    const expanded = subLanes !== null;

    // Caret glyph for expand/collapse.
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.fillText(expanded ? "▼" : "▶", 4, top + mainHeight / 2);

    // Lane label.
    // Lane label x is shifted right by CARET_WIDTH so the caret has dedicated
    // hit-area space. We size [pid] placement off the actual label width
    // rather than a fixed x so short names sit close to their pid and long
    // names don't overlap.
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "11px ui-monospace, Menlo, monospace";
    const label = pidLabels.get(pid) ?? `pid ${pid}`;
    const drawLabel = truncate(label, 16);
    ctx.fillText(drawLabel, CARET_WIDTH + 4, top + mainHeight / 2);

    const labelW = ctx.measureText(drawLabel).width;
    const pidText = `[${pid}]`;
    const pidX = CARET_WIDTH + 4 + labelW + 8;
    const pidW = ctx.measureText(pidText).width;
    if (pidX + pidW <= LEFT_GUTTER - 4) {
      ctx.fillStyle = "#6a6a6a";
      ctx.fillText(pidText, pidX, top + mainHeight / 2);
    }

    // Sub-lane gutter labels — small color swatch + glyph + name.
    if (expanded && subLanes) {
      ctx.font = "9px ui-monospace, Menlo, monospace";
      for (const sub of subLanes) {
        const enabled = enabledCategories.has(sub.category);
        const swatchY = sub.top + sub.height / 2 - 4;
        ctx.globalAlpha = enabled ? 1 : 0.35;
        ctx.fillStyle = CATEGORY_COLOR[sub.category];
        ctx.fillRect(20, swatchY, 8, 8);
        ctx.fillStyle = "#9a9a9a";
        ctx.fillText(sub.category, 32, sub.top + sub.height / 2);
        ctx.globalAlpha = 1;

        // Faint horizontal separator at top of each sub-lane (skip first
        // since the main-lane separator above already covers it).
        if (sub !== subLanes[0]) {
          ctx.strokeStyle = "rgba(28, 29, 31, 0.6)";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(LEFT_GUTTER, sub.top);
          ctx.lineTo(width, sub.top);
          ctx.stroke();
        }
      }
    }
  }

  // Last lane bottom border
  const totalLanesBottom = layout.totalHeight;
  ctx.strokeStyle = "#1c1d1f";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, totalLanesBottom);
  ctx.lineTo(width, totalLanesBottom);
  ctx.stroke();

  // Vertical separator between gutter and chart
  ctx.strokeStyle = "#1c1d1f";
  ctx.beginPath();
  ctx.moveTo(LEFT_GUTTER, 0);
  ctx.lineTo(LEFT_GUTTER, height);
  ctx.stroke();

  // ---- events ----
  const hits = new Map<number, { x: number; y: number; w: number; h: number }>();

  /**
   * Resolve where an event should draw vertically. For a collapsed pid this
   * is the main lane; for an expanded pid the events live in their category
   * sub-lane and the main lane is left blank (deliberately — keeps the lane
   * label uncluttered when the user has chosen to inspect by category).
   * Returns `null` when there's no matching lane (pid not in current order).
   */
  const resolveLane = (
    ev: Event,
  ): { top: number; height: number; pad: number; subLane: boolean } | null => {
    const layoutEntry = layout.byPid.get(ev.pid);
    if (!layoutEntry) return null;
    if (layoutEntry.subLanes) {
      // Expanded — pick the matching sub-lane.
      const sub = layoutEntry.subLanes.find((s) => s.category === ev.category);
      if (!sub) return null;
      return { top: sub.top, height: sub.height, pad: SUB_LANE_PAD, subLane: true };
    }
    return {
      top: layoutEntry.top,
      height: layoutEntry.mainHeight,
      pad: LANE_PAD,
      subLane: false,
    };
  };

  // density overlay per lane (heatmap-ish tinting): bucket by ~2px
  // Key by `${pid}|${categoryOrEmpty}` so expanded pids get per-sub-lane
  // heatmaps rather than collapsing into the main lane.
  const buckets = new Map<string, Map<number, number>>();
  for (const ev of events) {
    if (ev.ts < viewFromNs || ev.ts > viewToNs) continue;
    if (!enabledCategories.has(ev.category)) continue;
    const lane = resolveLane(ev);
    if (!lane) continue;
    const x = LEFT_GUTTER + Math.floor(((ev.ts - viewFromNs) / span) * chartWidth);
    const bx = Math.floor(x / 2) * 2;
    const key = lane.subLane ? `${ev.pid}|${ev.category}` : `${ev.pid}|`;
    let m = buckets.get(key);
    if (!m) {
      m = new Map();
      buckets.set(key, m);
    }
    m.set(bx, (m.get(bx) ?? 0) + 1);
  }

  // Heatmap pass: dim bands underneath events.
  for (const [key, m] of buckets) {
    const sepIdx = key.indexOf("|");
    const pid = Number(key.slice(0, sepIdx));
    const cat = key.slice(sepIdx + 1) as Category | "";
    const layoutEntry = layout.byPid.get(pid);
    if (!layoutEntry) continue;
    let laneTop: number;
    let laneH: number;
    let pad: number;
    if (cat && layoutEntry.subLanes) {
      const sub = layoutEntry.subLanes.find((s) => s.category === cat);
      if (!sub) continue;
      laneTop = sub.top;
      laneH = sub.height;
      pad = SUB_LANE_PAD;
    } else {
      laneTop = layoutEntry.top;
      laneH = layoutEntry.mainHeight;
      pad = LANE_PAD;
    }
    const top = laneTop + pad;
    const h = Math.max(1, laneH - pad * 2);
    for (const [bx, count] of m) {
      const a = Math.min(0.4, 0.05 + count * 0.04);
      ctx.fillStyle = `rgba(217, 119, 87, ${a})`;
      ctx.fillRect(bx, top, 2, h);
    }
  }

  // Event glyph pass
  for (const ev of events) {
    if (ev.ts < viewFromNs || ev.ts > viewToNs) continue;
    if (!enabledCategories.has(ev.category)) continue;
    const lane = resolveLane(ev);
    if (!lane) continue;
    const x = LEFT_GUTTER + ((ev.ts - viewFromNs) / span) * chartWidth;
    const top = lane.top + lane.pad;
    const h = Math.max(1, lane.height - lane.pad * 2);

    const fill = CATEGORY_COLOR[ev.category];
    const dimmed = ev.whitelisted && showDimmed;

    ctx.globalAlpha = dimmed ? 0.4 : 1.0;
    ctx.fillStyle = fill;
    // Inset from sub-lane edges (smaller padding than main-lane glyphs).
    const insetTop = lane.subLane ? 2 : 4;
    const insetH = Math.max(1, h - (lane.subLane ? 4 : 8));
    ctx.fillRect(x - 1, top + insetTop, 3, insetH);

    // Severity overlay
    if (ev.severity === 2) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.35)";
      ctx.fillRect(x - 4, top, 8, h);
      // Marker triangle at top of lane. Clamp to canvas top so the first
      // lane's marker isn't clipped above the body canvas.
      const laneTopY = lane.top;
      const markerTipY = Math.max(laneTopY - 4, 1);
      const markerBaseY = Math.max(laneTopY, markerTipY + 3);
      ctx.fillStyle = "#f87171";
      ctx.beginPath();
      ctx.moveTo(x, markerTipY);
      ctx.lineTo(x - 4, markerBaseY);
      ctx.lineTo(x + 4, markerBaseY);
      ctx.closePath();
      ctx.fill();
    } else if (ev.severity === 1) {
      // Dashed stroke gives suspicious a non-color cue alongside the yellow ring.
      ctx.strokeStyle = SEVERITY_RING[1] ?? "transparent";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(x - 1.5, top + insetTop - 0.5, 4, insetH + 1);
      ctx.setLineDash([]);
    }

    // Selection / hover ring
    if (ev.id !== undefined && (ev.id === selectedEventId || ev.id === hoverEventId)) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle =
        ev.id === selectedEventId ? "#d97757" : "rgba(236, 236, 236, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 4, top, 8, h);
    }

    if (ev.id !== undefined) {
      hits.set(ev.id, { x: x - 4, y: top, w: 8, h });
    }
  }
  ctx.globalAlpha = 1;

  // ---- causality overlay ----
  // Draw last so curves sit on top of every glyph. Visually distinct: spawn
  // = solid orange, sameTarget = dashed grey.
  if (causalityLinks && causalityLinks.length > 0) {
    ctx.save();
    for (const link of causalityLinks) {
      if (link.kind === "spawn") {
        ctx.strokeStyle = "rgba(217, 119, 87, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = "rgba(154, 154, 154, 0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
      }
      ctx.beginPath();
      ctx.moveTo(link.from.x, link.from.y);
      const cx = (link.from.x + link.to.x) / 2;
      ctx.bezierCurveTo(cx, link.from.y, cx, link.to.y, link.to.x, link.to.y);
      ctx.stroke();
      // Small dot at the destination so very short curves are still visible.
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.beginPath();
      ctx.arc(link.to.x, link.to.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.restore();

  return { hits, laneTops, layoutByPid: layout.byPid };
}

/** Choose a tick interval (ms) given span (ns). */
function chooseTicks(spanNs: number): number {
  const spanS = spanNs / 1_000_000_000;
  if (spanS < 5) return 500;
  if (spanS < 30) return 2_000;
  if (spanS < 120) return 10_000;
  if (spanS < 600) return 60_000;
  if (spanS < 1800) return 5 * 60_000;
  if (spanS < 7200) return 15 * 60_000;
  return 30 * 60_000;
}

function formatTick(ms: number, tickMs: number): string {
  const d = new Date(ms);
  if (tickMs < 60_000) {
    return `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
