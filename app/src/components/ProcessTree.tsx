import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import type { ProcessSummary } from "../types";
import type { RunningProcess } from "../data";
import { useEventStore } from "../store/eventStore";

interface TreeNode {
  proc: ProcessSummary;
  children: TreeNode[];
}

interface FlatRow {
  proc: ProcessSummary;
  depth: number;
}

/** Row height — kept in sync with the .tree-node CSS. */
const ROW_HEIGHT = 26;
/**
 * Module-scoped icon promise cache so multiple ProcessTree instances or
 * remounts don't refetch.
 */
const iconPromiseCache = new Map<string, Promise<string | null>>();
const iconResolvedCache = new Map<string, string | null>();

function buildTree(processes: ProcessSummary[]): TreeNode[] {
  const map = new Map<number, TreeNode>();
  for (const p of processes) map.set(p.pid, { proc: p, children: [] });
  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    const parent = map.get(node.proc.ppid);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // Sort by event_count desc within siblings, with alerts first.
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (b.proc.alert_count !== a.proc.alert_count) {
        return b.proc.alert_count - a.proc.alert_count;
      }
      return b.proc.event_count - a.proc.event_count;
    });
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Flatten a tree (DFS) into virtualizable rows. */
function flatten(tree: TreeNode[]): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ proc: n.proc, depth });
      if (n.children.length > 0) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/**
 * Merge OS-snapshot processes with live ETW-derived ones. ETW data wins
 * (it has counts) but we keep OS rows for everything we haven't seen yet.
 * Returns a unified `ProcessSummary[]` plus a pid → exe_path lookup.
 */
function mergeRunningWithEtw(
  running: RunningProcess[],
  etw: ProcessSummary[],
): { merged: ProcessSummary[]; exeByPid: Map<number, string | null> } {
  const exeByPid = new Map<number, string | null>();
  const map = new Map<number, ProcessSummary>();
  for (const r of running) {
    exeByPid.set(r.pid, r.exe_path);
    map.set(r.pid, {
      pid: r.pid,
      ppid: r.ppid,
      proc_name: r.name,
      first_seen_ts: 0,
      last_seen_ts: 0,
      event_count: 0,
      alert_count: 0,
    });
  }
  for (const e of etw) {
    map.set(e.pid, e);
  }
  return { merged: [...map.values()], exeByPid };
}

export const ProcessTree = memo(function ProcessTree() {
  const processes = useEventStore((s) => s.processes);
  const runningProcesses = useEventStore((s) => s.runningProcesses);
  const focusedPid = useEventStore((s) => s.focusedPid);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);
  const source = useEventStore((s) => s.source);

  const { rows, exeByPid } = useMemo(() => {
    const { merged, exeByPid } = mergeRunningWithEtw(runningProcesses, processes);
    const tree = buildTree(merged);
    return { rows: flatten(tree), exeByPid };
  }, [runningProcesses, processes]);

  // Track the wrapper height so FixedSizeList knows the viewport.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 240, height: 400 });
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(160, Math.floor(rect.width)),
        height: Math.max(120, Math.floor(rect.height)),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const itemData = useMemo(
    () => ({ rows, exeByPid, focusedPid, setFocusedPid, source }),
    [rows, exeByPid, focusedPid, setFocusedPid, source],
  );

  return (
    <aside className="process-tree">
      <div className="tree-section">processes</div>
      <div className="tree-list" ref={wrapRef}>
        {rows.length === 0 ? (
          <div style={{ padding: 12, fontSize: 11, opacity: 0.6 }}>no processes</div>
        ) : (
          <FixedSizeList
            height={size.height}
            width={size.width}
            itemCount={rows.length}
            itemSize={ROW_HEIGHT}
            itemData={itemData}
            overscanCount={6}
          >
            {TreeRow}
          </FixedSizeList>
        )}
      </div>
    </aside>
  );
});

interface RowData {
  rows: FlatRow[];
  exeByPid: Map<number, string | null>;
  focusedPid: number | null;
  setFocusedPid: (pid: number | null) => void;
  source: ReturnType<typeof useEventStore.getState>["source"];
}

function TreeRow({ index, style, data }: ListChildComponentProps<RowData>) {
  const row = data.rows[index];
  const focused = data.focusedPid === row.proc.pid;
  const exePath = data.exeByPid.get(row.proc.pid) ?? null;
  return (
    <div
      style={{ ...style, paddingLeft: 12 + row.depth * 14 }}
      className={`tree-node${focused ? " focused" : ""}`}
      onClick={() => data.setFocusedPid(focused ? null : row.proc.pid)}
      title={`pid ${row.proc.pid} • ${row.proc.event_count} events`}
    >
      <ProcessIcon exePath={exePath} source={data.source} />
      {row.proc.alert_count > 0 && <span className="alert-dot" />}
      <span className="name">{row.proc.proc_name}</span>
      <span className="pid">[{row.proc.pid}]</span>
      {row.proc.event_count > 0 && (
        <span className="count">{row.proc.event_count}</span>
      )}
    </div>
  );
}

/**
 * Lazily fetch and render an exe icon. Multiple rows pointing at the
 * same `exe_path` share one in-flight promise.
 */
const ProcessIcon = memo(function ProcessIcon({
  exePath,
  source,
}: {
  exePath: string | null;
  source: RowData["source"];
}) {
  const [icon, setIcon] = useState<string | null>(() =>
    exePath ? iconResolvedCache.get(exePath) ?? null : null,
  );

  useEffect(() => {
    if (!exePath) {
      setIcon(null);
      return;
    }
    if (iconResolvedCache.has(exePath)) {
      setIcon(iconResolvedCache.get(exePath) ?? null);
      return;
    }
    let cancelled = false;
    let promise = iconPromiseCache.get(exePath);
    if (!promise) {
      promise = source.getProcessIcon(exePath).then((url) => {
        iconResolvedCache.set(exePath, url);
        return url;
      });
      iconPromiseCache.set(exePath, promise);
    }
    promise.then((url) => {
      if (!cancelled) setIcon(url);
    });
    return () => {
      cancelled = true;
    };
  }, [exePath, source]);

  if (icon) {
    return (
      <img
        loading="lazy"
        src={icon}
        width={16}
        height={16}
        alt=""
        className="proc-icon"
        style={{ width: 16, height: 16, flex: "0 0 auto" }}
      />
    );
  }
  return <span className="proc-icon proc-icon-placeholder" aria-hidden />;
});
