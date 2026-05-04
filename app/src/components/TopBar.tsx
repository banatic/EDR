import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useEventStore, selectVisibleEvents } from "../store/eventStore";
import type { RuntimeInfo } from "../types";

const RANGE_OPTIONS = [
  { label: "1 min", value: 1 },
  { label: "5 min", value: 5 },
  { label: "10 min", value: 10 },
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
  { label: "4 hr", value: 240 },
];

/**
 * Live counters re-render at most every {@link STATS_INTERVAL_MS}. The
 * underlying store still updates on every batch but the component sleeps
 * between ticks; clock drift between ticks is irrelevant for an at-a-
 * glance counter.
 */
const STATS_INTERVAL_MS = 500;

/**
 * Search input is debounced before it reaches the global store. At 100k
 * retained events every keystroke would otherwise re-run every selector.
 */
const SEARCH_DEBOUNCE_MS = 200;

interface Stats {
  total: number;
  alert: number;
  susp: number;
}

function emptyStats(): Stats {
  return { total: 0, alert: 0, susp: 0 };
}

function computeStats(): Stats {
  const evs = selectVisibleEvents(useEventStore.getState());
  let alert = 0;
  let susp = 0;
  for (const e of evs) {
    if (e.severity === 2) alert += 1;
    else if (e.severity === 1) susp += 1;
  }
  return { total: evs.length, alert, susp };
}

interface ChipDisplay {
  cls: "ok" | "warn" | "err";
  label: string;
  title: string;
}

/**
 * Compact viewport breakpoints. We don't use Tailwind/etc here, so the
 * names are local. The thresholds match the comments in CLAUDE.md and
 * `app.css` `@media` rules — keep all three in sync if you change one.
 */
type Breakpoint = "xl" | "lg" | "md" | "sm" | "xs";

function bpFromWidth(w: number): Breakpoint {
  if (w < 750) return "xs";
  if (w < 850) return "sm";
  if (w < 950) return "md";
  if (w < 1100) return "lg";
  return "xl";
}

function describeRuntime(info: RuntimeInfo | null, bp: Breakpoint): ChipDisplay {
  // At sm/xs we drop the elevation suffix and shorten "demo data" to
  // "demo" — the title attribute still holds the full diagnostic.
  const compact = bp === "sm" || bp === "xs";
  if (info === null) {
    return {
      cls: "warn",
      label: compact ? "…" : "starting…",
      title: "fetching runtime info",
    };
  }
  if (info.etw_failed) {
    return {
      cls: "err",
      label: compact ? "ETW fail" : "ETW failed — using demo",
      title: titleFor(info),
    };
  }
  if (info.backend === "etw") {
    return {
      cls: "ok",
      label: compact ? "ETW" : info.elevated ? "ETW · admin" : "ETW",
      title: titleFor(info),
    };
  }
  return {
    cls: "warn",
    label: compact ? "demo" : "demo data",
    title: titleFor(info),
  };
}

function titleFor(info: RuntimeInfo): string {
  const lines = [
    `backend: ${info.backend}`,
    `elevated: ${info.elevated}`,
    `integrity watch: ${info.integrity_watch ? "on" : "off"}`,
    `rules: ${info.rule_count}`,
  ];
  if (info.message) lines.push(info.message);
  return lines.join("\n");
}

interface Props {
  onOpenSettings?: () => void;
  onOpenHelp?: () => void;
}

export const TopBar = memo(function TopBar({ onOpenSettings, onOpenHelp }: Props = {}) {
  const mode = useEventStore((s) => s.mode);
  const rangeMinutes = useEventStore((s) => s.rangeMinutes);
  const search = useEventStore((s) => s.search);
  const runtimeInfo = useEventStore((s) => s.runtimeInfo);
  const setMode = useEventStore((s) => s.setMode);
  const setRangeMinutes = useEventStore((s) => s.setRangeMinutes);
  const setSearch = useEventStore((s) => s.setSearch);

  // Viewport breakpoint — drives compact labels for the status chip and
  // toggles CSS-only hide/show for stat labels. We track window.innerWidth
  // (cheap, no ResizeObserver needed) since the topbar always spans 100vw.
  const [bp, setBp] = useState<Breakpoint>(() =>
    bpFromWidth(typeof window !== "undefined" ? window.innerWidth : 1440),
  );
  useEffect(() => {
    const onResize = () => setBp(bpFromWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Stats are sampled on a fixed interval; the input box and dropdowns
  // remain perfectly responsive even as the store fires on every batch.
  const [stats, setStats] = useState<Stats>(emptyStats);
  const tickRef = useRef<number | null>(null);
  useEffect(() => {
    setStats(computeStats());
    tickRef.current = window.setInterval(() => {
      setStats(computeStats());
    }, STATS_INTERVAL_MS);
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, []);

  // ---- Debounced search input -------------------------------------------
  const [searchInput, setSearchInput] = useState(search);
  const debounceRef = useRef<number | null>(null);

  // External writes to store.search (from other components, future use)
  // sync back into local input when they diverge.
  useEffect(() => {
    setSearchInput((prev) => (prev === search ? prev : search));
  }, [search]);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (searchInput === search) return;
    debounceRef.current = window.setTimeout(() => {
      setSearch(searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
    // `search` is intentionally read inside the effect via closure: we
    // only want to react to local input changes, not to store updates
    // (which the previous effect already mirrors back to local).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const clearSearch = () => {
    setSearchInput("");
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSearch("");
  };

  const chip = useMemo(() => describeRuntime(runtimeInfo, bp), [runtimeInfo, bp]);

  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="accent">●</span> personalEDR
      </div>

      <div className={`status-chip chip-${chip.cls}`} title={chip.title}>
        <span className={`dot ${chip.cls}`} />
        <span>{chip.label}</span>
      </div>

      <div className="mode-toggle" role="tablist" aria-label="Mode">
        <button
          className={mode === "monitoring" ? "active" : ""}
          onClick={() => setMode("monitoring")}
          title="Rolling sliding window, auto-scroll"
        >
          monitor
        </button>
        <button
          className={mode === "investigation" ? "active" : ""}
          onClick={() => setMode("investigation")}
          title="Time range fixed, free navigation"
        >
          investigate
        </button>
      </div>

      <div className="range-picker">
        <span className="label">range</span>
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

      {/*
       * Each .stat carries both a word label and a single-character glyph;
       * `.session-stats` media queries decide which one is visible. The
       * glyphs (Σ, ◆, ▲) are aria-hidden — screen readers always read the
       * full word.
       */}
      <div className="session-stats">
        <span className="stat" title="events">
          <span className="label">events</span>
          <span className="glyph" aria-hidden="true">
            Σ
          </span>
          <span className="v">{stats.total.toLocaleString()}</span>
        </span>
        <span className="stat" title="suspicious">
          <span className="label">susp</span>
          <span className="glyph susp" aria-hidden="true">
            ◆
          </span>
          <span className="v susp">{stats.susp}</span>
        </span>
        <span className="stat" title="alert">
          <span className="label">alert</span>
          <span className="glyph alert" aria-hidden="true">
            ▲
          </span>
          <span className="v alert">{stats.alert}</span>
        </span>
      </div>

      <div className="search-box">
        <input
          id="topbar-search"
          placeholder="search… (/)"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput.length > 0 ? (
          <button
            type="button"
            className="clear-btn"
            onClick={clearSearch}
            title="Clear search"
            aria-label="Clear search"
          >
            ×
          </button>
        ) : null}
      </div>

      <button
        className="icon-btn"
        title="Help (?)"
        aria-label="Open help"
        onClick={() => onOpenHelp?.()}
      >
        {"?"}
      </button>
      <button
        className="icon-btn"
        title="Settings"
        aria-label="Open settings"
        onClick={() => onOpenSettings?.()}
      >
        {"⚙"}
      </button>
    </div>
  );
});
