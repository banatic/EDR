import { useCallback, useEffect, useRef, useState } from "react";

export interface ViewRange {
  fromNs: number;
  toNs: number;
}

const NS_PER_MS = 1_000_000;
const MIN_SPAN_NS = 1 * 1_000_000_000;             // 1 second
const MAX_SPAN_NS = 60 * 60 * 1_000_000_000;       // 1 hour

interface Options {
  /** The "natural" view bounds when not user-zoomed (e.g. last 10 minutes). */
  baseRange: ViewRange;
  /** When true, the view is locked to baseRange (live monitoring). */
  follow: boolean;
}

interface ZoomState {
  view: ViewRange;
  isPanning: boolean;
}

/**
 * Wheel + drag zoom/pan controller. Exposes a `view` range, plus handlers
 * to attach to a wrapping element. Resets to baseRange whenever `follow`
 * flips back to true.
 */
export function useTimelineZoom(
  ref: React.RefObject<HTMLElement>,
  opts: Options,
): ZoomState & {
  resetView: () => void;
  /** Convert a CSS pixel x within element to nanoseconds. */
  pixelToNs: (px: number, leftGutter: number, width: number) => number;
} {
  const { baseRange, follow } = opts;
  const [view, setView] = useState<ViewRange>(baseRange);
  const [isPanning, setPanning] = useState(false);

  const baseRef = useRef(baseRange);
  baseRef.current = baseRange;
  const followRef = useRef(follow);
  followRef.current = follow;

  // Sync to baseRange when in follow mode.
  useEffect(() => {
    if (follow) setView(baseRange);
  }, [follow, baseRange]);

  // Mouse wheel zoom (focus = cursor x)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // horizontal trackpad pan
        const dx = e.deltaX;
        e.preventDefault();
        setView((prev) => {
          const span = prev.toNs - prev.fromNs;
          const rect = el.getBoundingClientRect();
          const ratio = dx / Math.max(1, rect.width);
          const shift = span * ratio;
          return { fromNs: prev.fromNs + shift, toNs: prev.toNs + shift };
        });
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, px / Math.max(1, rect.width)));
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      setView((prev) => {
        const anchorNs = prev.fromNs + (prev.toNs - prev.fromNs) * ratio;
        let span = (prev.toNs - prev.fromNs) * factor;
        span = Math.max(MIN_SPAN_NS, Math.min(MAX_SPAN_NS, span));
        const fromNs = anchorNs - span * ratio;
        const toNs = fromNs + span;
        return { fromNs, toNs };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);

  // Mouse drag pan (left button only, when shift is held — leaves left
  // button free for region-select). Plus middle-button pan.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dragging = false;
    let lastX = 0;
    const onDown = (e: MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        e.preventDefault();
        dragging = true;
        lastX = e.clientX;
        setPanning(true);
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      setView((prev) => {
        const rect = el.getBoundingClientRect();
        const span = prev.toNs - prev.fromNs;
        const shift = -span * (dx / Math.max(1, rect.width));
        return { fromNs: prev.fromNs + shift, toNs: prev.toNs + shift };
      });
    };
    const onUp = () => {
      dragging = false;
      setPanning(false);
    };
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [ref]);

  const resetView = useCallback(() => setView(baseRef.current), []);

  const pixelToNs = useCallback(
    (px: number, leftGutter: number, width: number) => {
      const chartW = Math.max(1, width - leftGutter);
      const ratio = (px - leftGutter) / chartW;
      return view.fromNs + (view.toNs - view.fromNs) * Math.max(0, Math.min(1, ratio));
    },
    [view],
  );

  return { view, isPanning, resetView, pixelToNs };
}

export const ZOOM_LIMITS = { MIN_SPAN_NS, MAX_SPAN_NS, NS_PER_MS };
