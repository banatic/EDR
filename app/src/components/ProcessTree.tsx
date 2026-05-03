import { useMemo } from "react";
import type { ProcessSummary } from "../types";
import { useEventStore } from "../store/eventStore";

interface TreeNode {
  proc: ProcessSummary;
  children: TreeNode[];
}

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

export function ProcessTree() {
  const processes = useEventStore((s) => s.processes);
  const focusedPid = useEventStore((s) => s.focusedPid);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);

  const tree = useMemo(() => buildTree(processes), [processes]);

  return (
    <aside className="process-tree">
      <div className="tree-section">processes</div>
      <div className="tree-list">
        {tree.map((root) => (
          <TreeRow
            key={root.proc.pid}
            node={root}
            depth={0}
            focusedPid={focusedPid}
            onSelect={setFocusedPid}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  focusedPid,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  focusedPid: number | null;
  onSelect: (pid: number | null) => void;
}) {
  const focused = focusedPid === node.proc.pid;
  return (
    <>
      <div
        className={`tree-node${focused ? " focused" : ""}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onSelect(focused ? null : node.proc.pid)}
        title={`pid ${node.proc.pid} • ${node.proc.event_count} events`}
      >
        {node.proc.alert_count > 0 && <span className="alert-dot" />}
        <span className="name">{node.proc.proc_name}</span>
        <span className="pid">[{node.proc.pid}]</span>
        <span className="count">{node.proc.event_count}</span>
      </div>
      {node.children.map((c) => (
        <TreeRow
          key={c.proc.pid}
          node={c}
          depth={depth + 1}
          focusedPid={focusedPid}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
