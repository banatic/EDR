import { useEffect, useMemo, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { selectVisibleEvents, useEventStore } from "../../store/eventStore";

interface ClusterNode extends SimulationNodeDatum {
  id: string;
  label: string;
  count: number;
  alerts: number;
  /** Distinct pids that connected here. */
  procs: Set<number>;
}

/**
 * Network map. We don't have a geo-IP database, so we cluster external
 * connections by /24 subnet and render them as a force-directed bubble
 * cluster, with a domain (DNS) aggregation list on the right side.
 */
export function NetworkMap() {
  const events = useEventStore(selectVisibleEvents);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<ClusterNode, undefined> | null>(null);

  const { clusters, domains } = useMemo(() => {
    const clusterMap = new Map<string, ClusterNode>();
    const domainMap = new Map<string, { count: number; alerts: number; procs: Set<number> }>();
    for (const ev of events) {
      if (ev.category !== "Network") continue;
      if (ev.op === "DnsQuery") {
        const d = ev.target;
        let agg = domainMap.get(d);
        if (!agg) {
          agg = { count: 0, alerts: 0, procs: new Set() };
          domainMap.set(d, agg);
        }
        agg.count += 1;
        if (ev.severity === 2) agg.alerts += 1;
        agg.procs.add(ev.pid);
        continue;
      }
      const slash24 = subnet24(ev.target);
      if (!slash24) continue;
      let cl = clusterMap.get(slash24);
      if (!cl) {
        cl = {
          id: slash24,
          label: slash24,
          count: 0,
          alerts: 0,
          procs: new Set(),
        };
        clusterMap.set(slash24, cl);
      }
      cl.count += 1;
      if (ev.severity === 2) cl.alerts += 1;
      cl.procs.add(ev.pid);
    }
    return {
      clusters: [...clusterMap.values()].sort((a, b) => b.count - a.count),
      domains: [...domainMap.entries()]
        .map(([d, info]) => ({ domain: d, ...info }))
        .sort((a, b) => b.count - a.count),
    };
  }, [events]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    if (!wrap || !svg) return;

    const rect = wrap.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    if (simRef.current) simRef.current.stop();

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (clusters.length === 0) return;

    const NS = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(NS, "g");
    svg.appendChild(layer);

    const sim = forceSimulation<ClusterNode>(clusters)
      .force("charge", forceManyBody().strength(-50))
      .force("center", forceCenter(W / 2, H / 2))
      .force(
        "collide",
        forceCollide<ClusterNode>().radius((d) => radiusFor(d.count) + 4),
      );
    simRef.current = sim;

    const els = clusters.map((c) => {
      const g = document.createElementNS(NS, "g");
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("r", `${radiusFor(c.count)}`);
      circle.setAttribute(
        "fill",
        c.alerts > 0 ? "rgba(248,113,113,0.35)" : "rgba(196,181,253,0.22)",
      );
      circle.setAttribute(
        "stroke",
        c.alerts > 0 ? "var(--severity-alert)" : "var(--color-border-primary)",
      );
      circle.setAttribute("stroke-width", "1");
      g.appendChild(circle);

      const t = document.createElementNS(NS, "text");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dy", "3");
      t.setAttribute("style", "font-family:var(--font-mono);font-size:10px;fill:var(--color-text-primary);pointer-events:none");
      t.textContent = c.label;
      g.appendChild(t);

      const t2 = document.createElementNS(NS, "text");
      t2.setAttribute("text-anchor", "middle");
      t2.setAttribute("dy", `${radiusFor(c.count) + 12}`);
      t2.setAttribute("style", "font-family:var(--font-mono);font-size:9px;fill:var(--color-text-secondary);pointer-events:none");
      t2.textContent = `${c.count} conn · ${c.procs.size} proc`;
      g.appendChild(t2);

      layer.appendChild(g);
      return g;
    });

    sim.on("tick", () => {
      for (let i = 0; i < clusters.length; i++) {
        const n = clusters[i];
        if (n.x === undefined || n.y === undefined) continue;
        els[i].setAttribute("transform", `translate(${n.x},${n.y})`);
      }
    });

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [clusters]);

  return (
    <div className="network-root">
      <div className="network-canvas" ref={wrapRef}>
        {clusters.length === 0 ? (
          <div className="empty-state">no network events in current window</div>
        ) : (
          <svg ref={svgRef} />
        )}
      </div>
      <aside className="network-aside">
        <section>
          <h3>domains ({domains.length})</h3>
          {domains.length === 0 ? (
            <div style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>
              no DNS queries
            </div>
          ) : (
            domains.slice(0, 30).map((d) => (
              <div className="row" key={d.domain}>
                <span style={{ color: d.alerts > 0 ? "var(--severity-alert)" : undefined }}>
                  {d.domain}
                </span>
                <span className="v">
                  {d.count} · {d.procs.size}p
                </span>
              </div>
            ))
          )}
        </section>
        <section>
          <h3>top /24 clusters</h3>
          {clusters.slice(0, 12).map((c) => (
            <div className="row" key={c.id}>
              <span style={{ color: c.alerts > 0 ? "var(--severity-alert)" : undefined }}>
                {c.label}
              </span>
              <span className="v">
                {c.count} · {c.procs.size}p
              </span>
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}

function radiusFor(count: number): number {
  return Math.min(48, 6 + Math.sqrt(count) * 3);
}

function subnet24(target: string): string | null {
  const ipPart = target.split(":")[0];
  const m = ipPart.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.0/24`;
}
