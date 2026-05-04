import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { selectVisibleEvents, useEventStore } from "../../store/eventStore";

interface DirNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  count: number;
  procs: Map<number, { name: string; n: number }>;
  children: Map<string, DirNode>;
}

interface FlatRow {
  node: DirNode;
  depth: number;
}

/** Row height — kept in sync with the .file-row CSS. */
const ROW_HEIGHT = 22;

/** Stable color per pid (cheap hash). */
function colorForPid(pid: number): string {
  const palette = [
    "var(--cat-process)",
    "var(--cat-file)",
    "var(--cat-network)",
    "var(--cat-registry)",
    "var(--cat-imageload)",
    "var(--cat-thread)",
    "var(--cat-handle)",
    "var(--cat-integrity)",
  ];
  return palette[pid % palette.length];
}

function makeNode(name: string, fullPath: string, isDir: boolean): DirNode {
  return {
    name,
    fullPath,
    isDir,
    count: 0,
    procs: new Map(),
    children: new Map(),
  };
}

function splitPath(p: string): string[] {
  // Split on either / or \ — preserve drive letter on Windows ("C:")
  const parts: string[] = [];
  for (const seg of p.split(/[\\/]/)) {
    if (seg.length === 0) continue;
    parts.push(seg);
  }
  return parts;
}

/**
 * Default-open everything down to `maxDepth` (root's direct children = 0).
 * Deeper directories start collapsed; the user expands what they need.
 */
function initialOpen(root: DirNode, maxDepth: number): Map<string, boolean> {
  const open = new Map<string, boolean>();
  const walk = (node: DirNode, depth: number) => {
    if (!node.isDir) return;
    if (depth <= maxDepth) {
      open.set(node.fullPath, true);
      for (const child of node.children.values()) walk(child, depth + 1);
    }
  };
  for (const child of root.children.values()) walk(child, 0);
  return open;
}

/**
 * DFS-flatten the visible portion of the tree. Children of a node are
 * skipped when the node is collapsed in `openMap`. Sibling order is by
 * descending count, matching the previous recursive component.
 */
function flatten(root: DirNode, openMap: Map<string, boolean>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: DirNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.isDir && openMap.get(n.fullPath)) {
        const kids = [...n.children.values()].sort((a, b) => b.count - a.count);
        if (kids.length > 0) walk(kids, depth + 1);
      }
    }
  };
  const roots = [...root.children.values()].sort((a, b) => b.count - a.count);
  walk(roots, 0);
  return out;
}

export const FileAccessTree = memo(function FileAccessTree() {
  const events = useEventStore(selectVisibleEvents);

  const root = useMemo<DirNode>(() => {
    const r = makeNode("root", "", true);
    for (const ev of events) {
      if (ev.category !== "File") continue;
      const parts = splitPath(ev.target);
      let cur = r;
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        acc = acc.length === 0 ? seg : `${acc}\\${seg}`;
        const isLast = i === parts.length - 1;
        let child = cur.children.get(seg);
        if (!child) {
          child = makeNode(seg, acc, !isLast);
          cur.children.set(seg, child);
        }
        cur = child;
        cur.count += 1;
        const procEntry = cur.procs.get(ev.pid);
        if (procEntry) procEntry.n += 1;
        else cur.procs.set(ev.pid, { name: ev.proc_name, n: 1 });
      }
    }
    return r;
  }, [events]);

  // We seed openMap from the freshly built tree and preserve user toggles
  // across rebuilds. Manual toggles live in `overrides` so we don't discard
  // them when the tree rebuilds (events stream in continuously). Both
  // `root` and `overrides` are deps so the merged map re-derives whenever
  // either changes.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const openMap = useMemo(() => {
    const seeded = initialOpen(root, 1);
    for (const [k, v] of overrides) seeded.set(k, v);
    return seeded;
  }, [root, overrides]);
  const toggle = useCallback((fullPath: string) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      // Flip the override against whatever the *current* effective state
      // is. If no override exists, we read from the seeded layer via the
      // last known openMap captured below.
      const cur = prev.has(fullPath)
        ? prev.get(fullPath)!
        : openMapAtToggleRef.current.get(fullPath) ?? false;
      next.set(fullPath, !cur);
      return next;
    });
  }, []);
  // Latest openMap snapshot so `toggle` can read the seeded defaults
  // without depending on them (which would re-create the callback every
  // render and bust react-window's row memoization).
  const openMapAtToggleRef = useRef(openMap);
  openMapAtToggleRef.current = openMap;

  const rows = useMemo(() => flatten(root, openMap), [root, openMap]);

  // Track viewport size for the virtualized list.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 320, height: 400 });
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

  const itemData = useMemo(() => ({ rows, openMap, toggle }), [rows, openMap, toggle]);

  return (
    <div className="files-root" ref={wrapRef}>
      {root.children.size === 0 ? (
        <div className="empty-state">no file events in current window</div>
      ) : (
        <FixedSizeList
          height={size.height}
          width={size.width}
          itemCount={rows.length}
          itemSize={ROW_HEIGHT}
          itemData={itemData}
          overscanCount={8}
        >
          {FileRow}
        </FixedSizeList>
      )}
    </div>
  );
});

interface RowData {
  rows: FlatRow[];
  openMap: Map<string, boolean>;
  toggle: (fullPath: string) => void;
}

function FileRow({ index, style, data }: ListChildComponentProps<RowData>) {
  const { node, depth } = data.rows[index];
  const open = data.openMap.get(node.fullPath) ?? false;
  const procs = useMemo(
    () =>
      [...node.procs.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 5),
    [node],
  );

  return (
    <div
      style={{ ...style, paddingLeft: 4 + depth * 14 }}
      className={`file-row ${node.isDir ? "dir" : "file"}`}
      onClick={() => node.isDir && data.toggle(node.fullPath)}
      title={node.fullPath}
    >
      <span className="twirl">{node.isDir ? (open ? "▾" : "▸") : "·"}</span>
      {procs.map(([pid]) => (
        <span
          key={pid}
          className="proc-chip"
          style={{ background: colorForPid(pid) }}
          title={`pid ${pid}`}
        />
      ))}
      <span className="name">{node.name}</span>
      <span className="count">{node.count}</span>
    </div>
  );
}
