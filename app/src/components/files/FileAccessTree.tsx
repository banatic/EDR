import { useMemo, useState } from "react";
import { selectVisibleEvents, useEventStore } from "../../store/eventStore";

interface DirNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  count: number;
  procs: Map<number, { name: string; n: number }>;
  children: Map<string, DirNode>;
}

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

export function FileAccessTree() {
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

  if (root.children.size === 0) {
    return <div className="empty-state">no file events in current window</div>;
  }

  return (
    <div className="files-root">
      {[...root.children.values()]
        .sort((a, b) => b.count - a.count)
        .map((c) => (
          <DirRow key={c.fullPath} node={c} depth={0} defaultOpen />
        ))}
    </div>
  );
}

function DirRow({
  node,
  depth,
  defaultOpen = false,
}: {
  node: DirNode;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const children = [...node.children.values()].sort((a, b) => b.count - a.count);
  const procs = [...node.procs.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 5);

  return (
    <>
      <div
        className={`file-row ${node.isDir ? "dir" : "file"}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => node.isDir && setOpen(!open)}
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
      {open &&
        children.map((c) => <DirRow key={c.fullPath} node={c} depth={depth + 1} />)}
    </>
  );
}
