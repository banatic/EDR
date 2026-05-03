/**
 * Canvas-based timeline renderer.
 *
 * Layout:
 *  - Y axis = process lanes (one row per pid)
 *  - X axis = time (mapped through `viewFromNs..viewToNs`)
 *  - Each cell is rendered as a small rect tinted by category and severity
 *  - Density is conveyed by semi-transparent overlap, plus an aggregated
 *    heatmap row at the top per lane.
 *  - severity=Alert events draw a red overlay + a triangular marker at the
 *    top of their lane.
 *
 * Virtualization: we filter events by visible time range *before* drawing,
 * so 50k mocked events render only the slice intersecting the viewport.
 */

import type { Category, Event, Severity } from "../../types";

export const LANE_HEIGHT = 28;
export const LANE_PAD = 4;
export const HEADER_HEIGHT = 24;
export const LEFT_GUTTER = 140;

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

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
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
}

export interface HitTarget {
  event: Event;
  x: number;
  y: number;
}

export interface RenderResult {
  /** Hit-test rects keyed by event id, in screen pixels (CSS units). */
  hits: Map<number, { x: number; y: number; w: number; h: number }>;
  /** Mapping pid → laneTop so the hit-test in the wrapper is consistent. */
  laneTops: Map<number, number>;
}

export function render(input: RenderInput): RenderResult {
  const { ctx, width, height, events, pidsOrdered, pidLabels, focusedPid } = input;
  const { viewFromNs, viewToNs, selectedEventId, hoverEventId, showDimmed } = input;

  ctx.save();
  ctx.scale(input.dpr, input.dpr);
  ctx.clearRect(0, 0, width, height);

  // Background
  ctx.fillStyle = "#0f1011";
  ctx.fillRect(0, 0, width, height);

  // ---- header (time axis) ----
  drawTimeAxis(ctx, width, viewFromNs, viewToNs);

  // ---- lanes ----
  const laneTops = new Map<number, number>();
  for (let i = 0; i < pidsOrdered.length; i++) {
    const pid = pidsOrdered[i];
    const top = HEADER_HEIGHT + i * LANE_HEIGHT;
    laneTops.set(pid, top);

    // Lane separator
    ctx.strokeStyle = "#1c1d1f";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(width, top);
    ctx.stroke();

    // Focus highlight
    if (focusedPid === pid) {
      ctx.fillStyle = "rgba(217, 119, 87, 0.06)";
      ctx.fillRect(0, top, width, LANE_HEIGHT);
    }

    // Lane label
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    const label = pidLabels.get(pid) ?? `pid ${pid}`;
    ctx.fillText(truncate(label, 16), 8, top + LANE_HEIGHT / 2);

    ctx.fillStyle = "#6a6a6a";
    ctx.fillText(`[${pid}]`, 100, top + LANE_HEIGHT / 2);
  }

  // Last lane bottom border
  const totalLanesBottom = HEADER_HEIGHT + pidsOrdered.length * LANE_HEIGHT;
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
  const span = Math.max(1, viewToNs - viewFromNs);
  const chartWidth = Math.max(1, width - LEFT_GUTTER);
  const pidIndex = new Map<number, number>();
  for (let i = 0; i < pidsOrdered.length; i++) pidIndex.set(pidsOrdered[i], i);
  const hits = new Map<number, { x: number; y: number; w: number; h: number }>();

  // density overlay per lane (heatmap-ish tinting): bucket by ~2px
  const buckets = new Map<number, Map<number, number>>(); // pid → bucketX → count
  for (const ev of events) {
    if (ev.ts < viewFromNs || ev.ts > viewToNs) continue;
    const laneIdx = pidIndex.get(ev.pid);
    if (laneIdx === undefined) continue;
    const x = LEFT_GUTTER + Math.floor(((ev.ts - viewFromNs) / span) * chartWidth);
    const bx = Math.floor(x / 2) * 2;
    let m = buckets.get(ev.pid);
    if (!m) {
      m = new Map();
      buckets.set(ev.pid, m);
    }
    m.set(bx, (m.get(bx) ?? 0) + 1);
  }

  // Heatmap pass: dim bands underneath events.
  for (const [pid, m] of buckets) {
    const laneIdx = pidIndex.get(pid)!;
    const top = HEADER_HEIGHT + laneIdx * LANE_HEIGHT + LANE_PAD;
    const h = LANE_HEIGHT - LANE_PAD * 2;
    for (const [bx, count] of m) {
      const a = Math.min(0.4, 0.05 + count * 0.04);
      ctx.fillStyle = `rgba(217, 119, 87, ${a})`;
      ctx.fillRect(bx, top, 2, h);
    }
  }

  // Event glyph pass
  for (const ev of events) {
    if (ev.ts < viewFromNs || ev.ts > viewToNs) continue;
    const laneIdx = pidIndex.get(ev.pid);
    if (laneIdx === undefined) continue;
    const x = LEFT_GUTTER + ((ev.ts - viewFromNs) / span) * chartWidth;
    const top = HEADER_HEIGHT + laneIdx * LANE_HEIGHT + LANE_PAD;
    const h = LANE_HEIGHT - LANE_PAD * 2;

    const fill = CATEGORY_COLOR[ev.category];
    const dimmed = ev.whitelisted && showDimmed;

    ctx.globalAlpha = dimmed ? 0.4 : 1.0;
    ctx.fillStyle = fill;
    ctx.fillRect(x - 1, top + 4, 3, h - 8);

    // Severity overlay
    if (ev.severity === 2) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.35)";
      ctx.fillRect(x - 4, top, 8, h);
      // marker triangle at top of lane
      ctx.fillStyle = "#f87171";
      ctx.beginPath();
      ctx.moveTo(x, top - 4);
      ctx.lineTo(x - 4, top);
      ctx.lineTo(x + 4, top);
      ctx.closePath();
      ctx.fill();
    } else if (ev.severity === 1) {
      ctx.strokeStyle = SEVERITY_RING[1] ?? "transparent";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1.5, top + 3.5, 4, h - 7);
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

  ctx.restore();

  return { hits, laneTops };
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  width: number,
  fromNs: number,
  toNs: number,
) {
  ctx.fillStyle = "#17181a";
  ctx.fillRect(0, 0, width, HEADER_HEIGHT);
  ctx.strokeStyle = "#1c1d1f";
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT);
  ctx.lineTo(width, HEADER_HEIGHT);
  ctx.stroke();

  const chartW = width - LEFT_GUTTER;
  const span = Math.max(1, toNs - fromNs);
  const ticks = chooseTicks(span);
  const startMs = Math.ceil(fromNs / 1_000_000 / ticks) * ticks;
  const endMs = Math.floor(toNs / 1_000_000);

  ctx.fillStyle = "#9a9a9a";
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";

  for (let ms = startMs; ms <= endMs; ms += ticks) {
    const ns = ms * 1_000_000;
    const x = LEFT_GUTTER + ((ns - fromNs) / span) * chartW;
    ctx.strokeStyle = "rgba(154, 154, 154, 0.15)";
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, 9999);
    ctx.stroke();
    ctx.fillStyle = "#9a9a9a";
    ctx.fillText(formatTick(ms, ticks), x + 4, HEADER_HEIGHT / 2);
  }
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
