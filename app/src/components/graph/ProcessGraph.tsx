import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { select } from "d3-selection";
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

interface HoverState {
  node: ProcNode;
  x: number;
  y: number;
}

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 4;

export const ProcessGraph = memo(function ProcessGraph() {
  const events = useEventStore(selectVisibleEvents);
  const focusedPid = useEventStore((s) => s.focusedPid);
  const setFocusedPid = useEventStore((s) => s.setFocusedPid);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const simRef = useRef<Simulation<ProcNode, ProcLink> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const [hover, setHover] = useState<HoverState | null>(null);

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
    const viewport = viewportRef.current;
    if (!wrap || !svg || !viewport) return;

    const rect = wrap.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    // Clear previous render (children of viewport <g>, not svg itself —
    // viewport keeps its identity so the d3-zoom transform persists).
    while (viewport.firstChild) viewport.removeChild(viewport.firstChild);

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
        forceCollide<ProcNode>().radius((d) => radiusFor(d.events) + 6),
      );

    simRef.current = sim;

    const NS = "http://www.w3.org/2000/svg";

    const linkLayer = document.createElementNS(NS, "g");
    const nodeLayer = document.createElementNS(NS, "g");
    viewport.appendChild(linkLayer);
    viewport.appendChild(nodeLayer);

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

      g.addEventListener("click", (ev) => {
        // Stop the click from propagating to the zoom-handler, which
        // could otherwise be misread as a pan-end click.
        ev.stopPropagation();
        setFocusedPid(focusedPid === n.id ? null : n.id);
      });

      // Hover popup: track in screen coords (not SVG coords) so the
      // overlay <div> is laid out relative to the wrapping container.
      g.addEventListener("mouseenter", (ev) => {
        const me = ev as MouseEvent;
        const r = wrap.getBoundingClientRect();
        setHover({ node: n, x: me.clientX - r.left, y: me.clientY - r.top });
      });
      g.addEventListener("mousemove", (ev) => {
        const me = ev as MouseEvent;
        const r = wrap.getBoundingClientRect();
        setHover({ node: n, x: me.clientX - r.left, y: me.clientY - r.top });
      });
      g.addEventListener("mouseleave", () => setHover(null));

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
      text.textContent = truncateLabel(`${n.name} [${n.id}]`);
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

  // Wire up d3-zoom on the SVG; it applies the transform to the viewport <g>.
  // Done in a separate effect so it runs once per mount and survives the
  // node/link re-render in the effect above.
  useEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (!svg || !viewport) return;

    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([ZOOM_MIN, ZOOM_MAX])
      // Block dblclick.zoom so we can repurpose double-click to "fit / reset".
      .filter((event) => event.type !== "dblclick")
      .on("zoom", (event) => {
        viewport.setAttribute("transform", event.transform.toString());
      });
    zoomRef.current = z;
    select(svg).call(z);

    const onDblClick = (ev: MouseEvent) => {
      ev.preventDefault();
      select(svg).call(z.transform, zoomIdentity);
    };
    svg.addEventListener("dblclick", onDblClick);

    return () => {
      svg.removeEventListener("dblclick", onDblClick);
      select(svg).on(".zoom", null);
      zoomRef.current = null;
    };
  }, []);

  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    select(svg).call(z.scaleBy, factor);
  };

  const resetZoom = () => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    select(svg).call(z.transform, zoomIdentity);
  };

  if (nodes.length === 0) {
    return <div className="empty-state">no processes in current window</div>;
  }

  return (
    <div className="graph-root" ref={wrapRef}>
      <svg ref={svgRef}>
        <g ref={viewportRef} />
      </svg>

      {hover ? (
        <div
          className="graph-hover-popup"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="title">
            {hover.node.name} <span className="pid">[{hover.node.id}]</span>
          </div>
          <div className="meta">
            events: {hover.node.events} · alerts: {hover.node.alerts}
          </div>
        </div>
      ) : null}

      <div className="graph-controls">
        <button title="Zoom in" onClick={() => zoomBy(1.4)}>
          {"⊕"}
        </button>
        <button title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
          {"⊖"}
        </button>
        <button title="Reset (or double-click canvas)" onClick={resetZoom}>
          {"⊙"}
        </button>
      </div>

      <div className="legend">
        node size = event count · red border = alerts present · click = focus
        pid · scroll = zoom · drag = pan · dblclick = reset
      </div>
    </div>
  );
});

function radiusFor(events: number): number {
  return Math.min(36, 6 + Math.sqrt(events) * 2);
}

/** Keep node labels readable without measuring text width per-frame. */
function truncateLabel(s: string): string {
  return s.length <= 28 ? s : s.slice(0, 26) + "…";
}
