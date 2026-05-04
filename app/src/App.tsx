import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { TopBar } from "./components/TopBar";
import { ProcessTree } from "./components/ProcessTree";
import { BookmarksPanel } from "./components/BookmarksPanel";
import { Tabs } from "./components/Tabs";
import { EventDetailPanel } from "./components/EventDetailPanel";
import { EmptyState } from "./components/EmptyState";
import { HelpModal } from "./components/HelpModal";
import { SwimlaneTimeline } from "./components/timeline/SwimlaneTimeline";
import { ProcessGraph } from "./components/graph/ProcessGraph";
import { NetworkMap } from "./components/network/NetworkMap";
import { FileAccessTree } from "./components/files/FileAccessTree";
import { SettingsPanel } from "./components/SettingsPanel";
import { Splitter } from "./components/Splitter";
import { useEventStore } from "./store/eventStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

// Resizable-panel constraints. min/max prevent the user from dragging a
// panel into uselessness; the values are coupled to the layout's actual
// content density (process tree node width, detail-panel kv grid).
const LEFT_MIN = 200;
const LEFT_MAX = 400;
const LEFT_DEFAULT = 260;
const RIGHT_MIN = 280;
const RIGHT_MAX = 560;
const RIGHT_DEFAULT = 360;

const LEFT_KEY = "edr.layout.leftWidth";
const RIGHT_KEY = "edr.layout.rightWidth";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function readWidth(key: string, fallback: number, lo: number, hi: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, lo, hi);
  } catch {
    return fallback;
  }
}

export default function App() {
  const ready = useEventStore((s) => s.ready);
  const initialize = useEventStore((s) => s.initialize);
  const tab = useEventStore((s) => s.selectedTab);
  const runtimeInfo = useEventStore((s) => s.runtimeInfo);
  const selectedEventId = useEventStore((s) => s.selectedEventId);

  const [helpOpen, setHelpOpen] = useState(false);
  const toggleHelp = useCallback(() => setHelpOpen((v) => !v), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  useKeyboardShortcuts({ onToggleHelp: toggleHelp, helpOpen });

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Panel widths are restored from localStorage on first paint and
  // persisted on drag-end (mouseup). We deliberately don't write on
  // every mousemove — clamping plus a single setItem at the end is
  // cheap and avoids storage thrashing.
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    readWidth(LEFT_KEY, LEFT_DEFAULT, LEFT_MIN, LEFT_MAX),
  );
  const [rightWidth, setRightWidth] = useState<number>(() =>
    readWidth(RIGHT_KEY, RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
  );

  const onLeftDrag = useCallback((dx: number) => {
    setLeftWidth((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX));
  }, []);
  const onLeftDragEnd = useCallback(() => {
    setLeftWidth((w) => {
      try {
        window.localStorage.setItem(LEFT_KEY, String(w));
      } catch {
        /* localStorage unavailable (private mode, quota) — silently skip. */
      }
      return w;
    });
  }, []);

  // Right edge: dragging the splitter rightwards should shrink the
  // detail panel (negative delta), so we subtract dx.
  const onRightDrag = useCallback((dx: number) => {
    setRightWidth((w) => clamp(w - dx, RIGHT_MIN, RIGHT_MAX));
  }, []);
  const onRightDragEnd = useCallback(() => {
    setRightWidth((w) => {
      try {
        window.localStorage.setItem(RIGHT_KEY, String(w));
      } catch {
        /* see onLeftDragEnd */
      }
      return w;
    });
  }, []);

  useEffect(() => {
    if (!ready) {
      void initialize();
    }
  }, [ready, initialize]);

  const detailOpen = selectedEventId !== null;

  // CSS variables drive the grid columns; doing it via inline style
  // keeps the resize loop entirely on the App component without
  // touching documentElement (which would leak between tests).
  const gridStyle: CSSProperties = {
    "--left-col-width": `${leftWidth}px`,
    "--right-panel-width": `${detailOpen ? rightWidth : 0}px`,
  } as CSSProperties;

  return (
    <div className="app-shell">
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={toggleHelp}
      />
      <div className="main-grid" style={gridStyle}>
        <div className="left-col">
          <ProcessTree />
          <BookmarksPanel />
        </div>
        <Splitter
          onDrag={onLeftDrag}
          onDragEnd={onLeftDragEnd}
          ariaLabel="Resize left sidebar"
        />
        <div className="center-pane">
          <Tabs />
          <div className="tab-content">
            {!ready ? (
              <EmptyState runtimeInfo={runtimeInfo} />
            ) : tab === "timeline" ? (
              <SwimlaneTimeline />
            ) : tab === "graph" ? (
              <ProcessGraph />
            ) : tab === "network" ? (
              <NetworkMap />
            ) : (
              <FileAccessTree />
            )}
          </div>
        </div>
        {/*
         * The right splitter is always rendered (so the grid keeps its
         * 5-track shape); when no event is selected we hide it via
         * `.collapsed` so neither hover nor drag responds.
         */}
        <Splitter
          onDrag={onRightDrag}
          onDragEnd={onRightDragEnd}
          ariaLabel="Resize detail panel"
          className={detailOpen ? "" : "collapsed"}
        />
        <EventDetailPanel />
      </div>
      <HelpModal open={helpOpen} onClose={closeHelp} />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
