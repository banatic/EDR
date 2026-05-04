import type { RuntimeInfo } from "../types";

interface Props {
  runtimeInfo: RuntimeInfo | null;
}

/**
 * Pre-ready placeholder. Branches on the backend snapshot so the user
 * sees what's actually happening (real ETW vs demo) instead of the
 * generic "loading…". Each tab has its own post-ready empty-state
 * messaging — this component intentionally only handles the boot phase.
 */
export function EmptyState({ runtimeInfo }: Props) {
  if (runtimeInfo === null) {
    return <div className="empty-state">starting up…</div>;
  }
  if (runtimeInfo.etw_failed) {
    return (
      <div className="empty-state">
        ETW failed — falling back to demo data
        {runtimeInfo.message ? <small>{runtimeInfo.message}</small> : null}
      </div>
    );
  }
  if (runtimeInfo.backend === "etw") {
    return (
      <div className="empty-state">waiting for ETW events… (a few seconds depending on activity)</div>
    );
  }
  return (
    <div className="empty-state">
      generating demo data…
      <small>restart as administrator to see real ETW events</small>
    </div>
  );
}
