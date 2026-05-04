import { memo, useEffect, useState } from "react";
import { useEventStore } from "../store/eventStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

const CLUSTER_MIN = 1;
const CLUSTER_MAX = 100;

export const SettingsPanel = memo(function SettingsPanel({ open, onClose }: Props) {
  const settings = useEventStore((s) => s.settings);
  const setSetting = useEventStore((s) => s.setSetting);

  // Local draft for the numeric input — committed on blur / Enter so we
  // don't write half-typed values like "1" while the user is typing "12".
  const [clusterDraft, setClusterDraft] = useState<string>(
    String(settings.cluster_threshold),
  );

  useEffect(() => {
    setClusterDraft(String(settings.cluster_threshold));
  }, [settings.cluster_threshold, open]);

  // Esc to close — registered only while open so background shortcuts still work.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const commitCluster = () => {
    const n = Number(clusterDraft);
    if (!Number.isFinite(n)) {
      setClusterDraft(String(settings.cluster_threshold));
      return;
    }
    const clamped = Math.max(CLUSTER_MIN, Math.min(CLUSTER_MAX, Math.round(n)));
    setClusterDraft(String(clamped));
    if (clamped !== settings.cluster_threshold) {
      void setSetting("cluster_threshold", clamped);
    }
  };

  return (
    <div
      className="settings-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-modal" role="dialog" aria-label="Settings">
        <div className="settings-modal-header">
          <span className="title">settings</span>
          <button
            className="settings-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="settings-modal-body">
          <label className="settings-row">
            <input
              type="checkbox"
              checked={settings.hide_whitelisted}
              onChange={(e) => {
                void setSetting("hide_whitelisted", e.target.checked);
              }}
            />
            <span className="settings-row-label">
              <span className="settings-row-title">
                hide whitelisted events
              </span>
              <span className="settings-row-hint">
                drop whitelisted events instead of dimming them
              </span>
            </span>
          </label>

          <label className="settings-row">
            <input
              type="checkbox"
              checked={settings.show_dimmed}
              onChange={(e) => {
                void setSetting("show_dimmed", e.target.checked);
              }}
            />
            <span className="settings-row-label">
              <span className="settings-row-title">
                dim non-alert events
              </span>
              <span className="settings-row-hint">
                fade whitelisted / normal events; off = solid
              </span>
            </span>
          </label>

          <div className="settings-row settings-row--number">
            <span className="settings-row-label">
              <span className="settings-row-title">
                cluster threshold (N repeats)
              </span>
              <span className="settings-row-hint">
                fold identical (proc, op, target) when repeated ≥ N times
              </span>
            </span>
            <input
              type="number"
              min={CLUSTER_MIN}
              max={CLUSTER_MAX}
              value={clusterDraft}
              onChange={(e) => setClusterDraft(e.target.value)}
              onBlur={commitCluster}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
