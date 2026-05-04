import { memo, useEffect, useMemo, useRef, useState } from "react";
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

interface PopupState {
  kind: "cluster";
  cluster: ClusterNode;
  x: number;
  y: number;
}

const POPUP_OFFSET = 12;
const POPUP_W = 240;
const POPUP_H = 110;

/**
 * Network map. We don't have a geo-IP database, so we cluster external
 * connections by /24 subnet and render them as a force-directed bubble
 * cluster, with a domain (DNS) aggregation list on the right side.
 */
export const NetworkMap = memo(function NetworkMap() {
  const events = useEventStore(selectVisibleEvents);
  const search = useEventStore((s) => s.search);
  const setSearch = useEventStore((s) => s.setSearch);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<ClusterNode, undefined> | null>(null);
  // Cluster `<g>` element handles, indexed parallel to `clusters`. Used by
  // the search-active effect so we can repaint stroke/active class without
  // rebuilding the simulation (and losing layout).
  const elsRef = useRef<SVGGElement[]>([]);
  const [popup, setPopup] = useState<PopupState | null>(null);

  const { clusters, domains, procNames } = useMemo(() => {
    const clusterMap = new Map<string, ClusterNode>();
    const domainMap = new Map<string, { count: number; alerts: number; procs: Set<number> }>();
    const procNames = new Map<number, string>();
    for (const ev of events) {
      if (ev.category !== "Network") continue;
      // Build pid → proc_name lookup so popups can show readable names.
      if (!procNames.has(ev.pid)) procNames.set(ev.pid, ev.proc_name);
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
      procNames,
    };
  }, [events]);

  // Click toggles a search filter on the clicked label. Same click on the
  // already-active label clears it; clicks while a different filter is
  // active replace it. We stash this in a ref so the SVG-level effect
  // (which only reruns on `clusters`) always sees the latest `search`.
  const toggleSearchRef = useRef<(label: string) => void>(() => {});
  toggleSearchRef.current = (label: string) => {
    setSearch(search === label ? "" : label);
  };
  const toggleSearch = (label: string) => toggleSearchRef.current(label);

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
      g.setAttribute("class", "cluster-node");
      g.setAttribute("style", "cursor:pointer");
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

      // Hover/click wiring. Local position (relative to the canvas wrapper)
      // keeps the popup correctly placed even when the page is scrolled.
      const onEnter = (e: MouseEvent) => {
        const r = wrap.getBoundingClientRect();
        setPopup({
          kind: "cluster",
          cluster: c,
          x: e.clientX - r.left,
          y: e.clientY - r.top,
        });
      };
      const onMove = (e: MouseEvent) => {
        const r = wrap.getBoundingClientRect();
        setPopup((prev) =>
          prev && prev.cluster.id === c.id
            ? { ...prev, x: e.clientX - r.left, y: e.clientY - r.top }
            : prev,
        );
      };
      const onLeave = () => {
        setPopup((prev) => (prev && prev.cluster.id === c.id ? null : prev));
      };
      const onClick = () => toggleSearchRef.current(c.label);
      g.addEventListener("mouseenter", onEnter);
      g.addEventListener("mousemove", onMove);
      g.addEventListener("mouseleave", onLeave);
      g.addEventListener("click", onClick);

      layer.appendChild(g);
      return g;
    });
    elsRef.current = els;

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
      elsRef.current = [];
    };
  }, [clusters]);

  // Repaint the active cluster outline whenever search changes, without
  // rebuilding the simulation (otherwise toggling the filter would jiggle
  // every bubble back to a fresh layout).
  useEffect(() => {
    const els = elsRef.current;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const g = els[i];
      if (!g) continue;
      const active = search === c.label;
      g.classList.toggle("active", active);
      const circle = g.firstChild as SVGCircleElement | null;
      if (circle) {
        circle.setAttribute(
          "stroke",
          active
            ? "var(--color-accent)"
            : c.alerts > 0
              ? "var(--severity-alert)"
              : "var(--color-border-primary)",
        );
        circle.setAttribute("stroke-width", active ? "2" : "1");
      }
    }
  }, [search, clusters]);

  // Clamp popup inside the canvas so it never escapes the right/bottom edges.
  const popupStyle = useMemo(() => {
    if (!popup || !wrapRef.current) return null;
    const rect = wrapRef.current.getBoundingClientRect();
    const left = Math.min(popup.x + POPUP_OFFSET, Math.max(0, rect.width - POPUP_W - 4));
    const top = Math.min(popup.y + POPUP_OFFSET, Math.max(0, rect.height - POPUP_H - 4));
    return { left, top };
  }, [popup]);

  return (
    <div className="network-root">
      <div className="network-canvas" ref={wrapRef}>
        {clusters.length === 0 ? (
          <div className="empty-state">no network events in current window</div>
        ) : (
          <svg ref={svgRef} />
        )}
        {popup && popupStyle && (
          <div
            className="network-popup"
            style={{ left: popupStyle.left, top: popupStyle.top }}
          >
            <div className="head">{popup.cluster.label}</div>
            <div className="row">
              <span>connections</span>
              <span>{popup.cluster.count}</span>
            </div>
            <div className="row">
              <span>processes</span>
              <span>{popup.cluster.procs.size}</span>
            </div>
            <div className="row">
              <span>alerts</span>
              <span style={{ color: popup.cluster.alerts > 0 ? "var(--severity-alert)" : undefined }}>
                {popup.cluster.alerts}
              </span>
            </div>
            {popup.cluster.procs.size > 0 && (
              <div className="procs">
                {[...popup.cluster.procs]
                  .slice(0, 3)
                  .map((pid) => (
                    <div key={pid} className="proc">
                      {procNames.get(pid) ?? "?"} <span className="pid">[{pid}]</span>
                    </div>
                  ))}
                {popup.cluster.procs.size > 3 && (
                  <div className="more">+{popup.cluster.procs.size - 3} more</div>
                )}
              </div>
            )}
          </div>
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
              <div
                className={`row clickable${search === d.domain ? " active" : ""}`}
                key={d.domain}
                onClick={() => toggleSearch(d.domain)}
                title={`${d.count} queries · ${d.procs.size} processes${d.alerts > 0 ? ` · ${d.alerts} alerts` : ""}`}
              >
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
            <div
              className={`row clickable${search === c.label ? " active" : ""}`}
              key={c.id}
              onClick={() => toggleSearch(c.label)}
              title={`${c.count} connections · ${c.procs.size} processes${c.alerts > 0 ? ` · ${c.alerts} alerts` : ""}`}
            >
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
});

function radiusFor(count: number): number {
  return Math.min(48, 6 + Math.sqrt(count) * 3);
}

function subnet24(target: string): string | null {
  const ipPart = target.split(":")[0];
  const m = ipPart.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.0/24`;
}
