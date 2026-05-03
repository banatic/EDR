import type { TabId } from "../types";
import { useEventStore } from "../store/eventStore";

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: "timeline", label: "timeline" },
  { id: "graph", label: "process graph" },
  { id: "network", label: "network map" },
  { id: "files", label: "file access" },
];

export function Tabs() {
  const selected = useEventStore((s) => s.selectedTab);
  const setSelectedTab = useEventStore((s) => s.setSelectedTab);

  return (
    <div className="tabs-bar">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={`tab-btn${selected === t.id ? " active" : ""}`}
          onClick={() => setSelectedTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
