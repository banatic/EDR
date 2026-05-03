import { memo, useEffect, useMemo, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { selectVisibleEvents, useEventStore } from "../../store/eventStore";

interface ProcNode extends SimulationNodeDatum {
  id: number;
  name: string;
  events: number;
  alerts: number;
}

interface ProcLink extends SimulationLinkDatum<ProcNode> {
  source: number | ProcNode;
  target: number | ProcNode;
  weight: number;
}

export const ProcessGraph = memo(function ProcessGraph() {
  const events = useEventStore(selectVisibleEvents);
  const focusedPid = useEventStore((s) => s.focusedPid);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<ProcNode, ProcLink> | null>(null);

  const { nodes, links } = useMemo(() => {
    const procMap = new Map<number, ProcNode>();
    const linkMap = new Map<string, ProcLink>();
    for (const ev of events) {
      let n = procMap.get(ev.pid);
      if (!n) {
        n = { id: ev.pid, name: ev.proc_name, events: 0, alerts: 0 };
        procMap.set(ev.pid, n);
      }
      n.events += 1;
      if (ev.severity === 2) n.alerts += 1;

      // Edge from parent → child if parent exists in our set
      if (ev.ppid !== 0 && ev.ppid !== ev.pid) {
        if (!procMap.has(ev.ppid)) {
          procMap.set(ev.ppid, {
            id: ev.ppid,
            name: `pid ${ev.ppid}`,
            events: 0,
            alerts: 0,
          });
        }
        const key = `${ev.ppid}→${ev.pid}`;
        const lk = linkMap.get(key);
        if (lk) lk.weight += 1;
        else
          linkMap.set(key, {
            source: ev.ppid,
            target: ev.pid,
            weight: 1,
          });
      }
    }
    return {
      nodes: [...procMap.values()],
      links: [...linkMap.values()],
    };
  }, [events]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    if (!wrap || !svg) return;

    const rect = wrap.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    if (nodes.length === 0) return;

    const linkSel = forceLink<ProcNode, ProcLink>(links)
      .id((d) => d.id)
      .distance(70)
      .strength((d) => Math.min(1, 0.3 + d.weight * 0.05));

    const sim = forceSimulation<ProcNode>(nodes)
      .force("link", linkSel)
      .force("charge", forceManyBody().strength(-180))
      .force("center", forceCenter(W / 2, H / 2))
      .force(
        "collide",
        forceCollide<ProcNode>().radius((d) => radiusFor(d.events) + 4),
      );

    simRef.current = sim;

    // Imperative SVG render (avoid React reconciliation in tick).
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const NS = "http://www.w3.org/2000/svg";

    const linkLayer = document.createElementNS(NS, "g");
    const nodeLayer = document.createElementNS(NS, "g");
    svg.appendChild(linkLayer);
    svg.appendChild(nodeLayer);

    const linkEls = links.map((lk) => {
      const el = document.createElementNS(NS, "line");
      el.setAttribute("stroke", "rgba(154,154,154,0.35)");
      el.setAttribute("stroke-width", `${Math.min(3, 0.6 + lk.weight * 0.05)}`);
      linkLayer.appendChild(el);
      return el;
    });

    const nodeEls = nodes.map((n) => {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("style", "cursor:pointer");
      g.addEventListener("click", () =>
        setFocusedPid(focusedPid === n.id ? null : n.id),
      );

      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("r", `${radiusFor(n.events)}`);
      circle.setAttribute(
        "fill",
        n.alerts > 0 ? "rgba(248,113,113,0.4)" : "rgba(217,119,87,0.18)",
      );
      circle.setAttribute(
        "stroke",
        n.alerts > 0
          ? "var(--severity-alert)"
          : focusedPid === n.id
          ? "var(--color-accent)"
          : "var(--color-border-primary)",
      );
      circle.setAttribute("stroke-width", "1");
      g.appendChild(circle);

      const text = document.createElementNS(NS, "text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dy", `${radiusFor(n.events) + 12}`);
      text.textContent = `${n.name} [${n.id}]`;
      g.appendChild(text);

      nodeLayer.appendChild(g);
      return g;
    });

    sim.on("tick", () => {
      for (let i = 0; i < links.length; i++) {
        const lk = links[i];
        const s = lk.source as ProcNode;
        const t = lk.target as ProcNode;
        if (s.x === undefined || t.x === undefined) continue;
        linkEls[i].setAttribute("x1", `${s.x}`);
        linkEls[i].setAttribute("y1", `${s.y}`);
        linkEls[i].setAttribute("x2", `${t.x}`);
        linkEls[i].setAttribute("y2", `${t.y}`);
      }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.x === undefined || n.y === undefined) continue;
        nodeEls[i].setAttribute("transform", `translate(${n.x},${n.y})`);
      }
    });

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links, focusedPid, setFocusedPid]);

  if (nodes.length === 0) {
    return <div className="empty-state">no processes in current window</div>;
  }

  return (
    <div className="graph-root" ref={wrapRef}>
      <svg ref={svgRef} />
      <div className="legend">
        node size = event count · red border = alerts present · click = focus pid
      </div>
    </div>
  );
});

function radiusFor(events: number): number {
  return Math.min(36, 6 + Math.sqrt(events) * 2);
}
