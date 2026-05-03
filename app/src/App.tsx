import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { ProcessTree } from "./components/ProcessTree";
import { Tabs } from "./components/Tabs";
import { EventDetailPanel } from "./components/EventDetailPanel";
import { SwimlaneTimeline } from "./components/timeline/SwimlaneTimeline";
import { ProcessGraph } from "./components/graph/ProcessGraph";
import { NetworkMap } from "./components/network/NetworkMap";
import { FileAccessTree } from "./components/files/FileAccessTree";
import { useEventStore } from "./store/eventStore";

export default function App() {
  const ready = useEventStore((s) => s.ready);
  const initialize = useEventStore((s) => s.initialize);
  const tab = useEventStore((s) => s.selectedTab);

  useEffect(() => {
    if (!ready) {
      void initialize();
    }
  }, [ready, initialize]);

  return (
    <div className="app-shell">
      <TopBar />
      <div className="main-grid">
        <ProcessTree />
        <div className="center-pane">
          <Tabs />
          <div className="tab-content">
            {!ready ? (
              <div className="empty-state">loading scenario…</div>
            ) : tab === "timeline" ? (
              <SwimlaneTimeline />
            ) : tab === "graph" ? (
              <ProcessGraph />
            ) : tab === "network" ? (
              <NetworkMap />
            ) : (
              <FileAccessTree />
            )}
          </div>
        </div>
        <EventDetailPanel />
      </div>
    </div>
  );
}
