import { useMemo } from "react";
import { useEventStore, selectVisibleEvents } from "../store/eventStore";

const RANGE_OPTIONS = [
  { label: "1 min", value: 1 },
  { label: "5 min", value: 5 },
  { label: "10 min", value: 10 },
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
];

export function TopBar() {
  const mode = useEventStore((s) => s.mode);
  const rangeMinutes = useEventStore((s) => s.rangeMinutes);
  const search = useEventStore((s) => s.search);
  const setMode = useEventStore((s) => s.setMode);
  const setRangeMinutes = useEventStore((s) => s.setRangeMinutes);
  const setSearch = useEventStore((s) => s.setSearch);

  const visible = useEventStore(selectVisibleEvents);
  const stats = useMemo(() => {
    let alert = 0;
    let susp = 0;
    for (const e of visible) {
      if (e.severity === 2) alert += 1;
      else if (e.severity === 1) susp += 1;
    }
    return { total: visible.length, alert, susp };
  }, [visible]);

  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="accent">●</span> personalEDR
      </div>

      <div className="mode-toggle" role="tablist" aria-label="Mode">
        <button
          className={mode === "monitoring" ? "active" : ""}
          onClick={() => setMode("monitoring")}
          title="Rolling sliding window, auto-scroll"
        >
          모니터링
        </button>
        <button
          className={mode === "investigation" ? "active" : ""}
          onClick={() => setMode("investigation")}
          title="Time range fixed, free navigation"
        >
          조사
        </button>
      </div>

      <div className="range-picker">
        <span>range</span>
        <select
          value={rangeMinutes}
          onChange={(e) => setRangeMinutes(Number(e.target.value))}
        >
          {RANGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="topbar-spacer" />

      <div className="session-stats">
        <span className="stat">
          <span>events</span>
          <span className="v">{stats.total.toLocaleString()}</span>
        </span>
        <span className="stat">
          <span>susp</span>
          <span className="v susp">{stats.susp}</span>
        </span>
        <span className="stat">
          <span>alert</span>
          <span className="v alert">{stats.alert}</span>
        </span>
      </div>

      <div className="search-box">
        <input
          placeholder="search proc / op / target…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
    </div>
  );
}
