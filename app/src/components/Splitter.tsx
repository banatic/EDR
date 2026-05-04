import { memo, useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** Drag delta in CSS pixels since the last move event. */
  onDrag: (deltaPx: number) => void;
  /** Fired once on mouseup, after the final drag has settled. */
  onDragEnd?: () => void;
  /** Accessible label for assistive tech. */
  ariaLabel?: string;
  /**
   * Extra class names. Used by the App layout to mark the right splitter
   * as `.collapsed` when the detail panel is hidden — keeps the grid
   * shape stable (5 tracks) without responding to hover/drag.
   */
  className?: string;
}

/**
 * Vertical 4-px splitter handle (resizes horizontally adjacent panels).
 *
 * The component keeps no width state itself — it only emits relative
 * deltas; the parent owns the absolute width. This keeps the handle
 * cheap to mount/unmount when an adjacent panel collapses.
 */
export const Splitter = memo(function Splitter({
  onDrag,
  onDragEnd,
  ariaLabel,
  className,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const lastXRef = useRef<number>(0);
  const collapsed = className?.includes("collapsed") ?? false;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (collapsed) return;
      e.preventDefault();
      lastXRef.current = e.clientX;
      setDragging(true);
    },
    [collapsed],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      if (dx !== 0) onDrag(dx);
    };
    const onUp = () => {
      setDragging(false);
      onDragEnd?.();
    };

    // While dragging we suppress text selection and force the resize
    // cursor everywhere — otherwise hovering over a child element with
    // its own cursor (e.g. text inputs) would reset the visual feedback.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, onDrag, onDragEnd]);

  const cls = [
    "splitter",
    dragging ? "dragging" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-hidden={collapsed || undefined}
      onMouseDown={onMouseDown}
    />
  );
});
