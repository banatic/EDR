import { memo } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Row {
  keys: string[];
  desc: string;
}

const KEYBOARD_ROWS: Row[] = [
  { keys: ["Esc"], desc: "close detail panel / clear search / clear focus (in priority)" },
  { keys: ["/"], desc: "focus search input" },
  { keys: ["1"], desc: "timeline tab" },
  { keys: ["2"], desc: "graph tab" },
  { keys: ["3"], desc: "network tab" },
  { keys: ["4"], desc: "files tab" },
  { keys: ["b"], desc: "toggle bookmark on selected event" },
  { keys: ["m"], desc: "toggle mode (monitor ↔ investigate)" },
  { keys: ["f"], desc: "clear process focus" },
  { keys: ["?"], desc: "open / close this dialog" },
];

const MOUSE_ROWS: Row[] = [
  { keys: ["wheel"], desc: "zoom timeline" },
  { keys: ["shift", "+", "drag"], desc: "pan timeline" },
  { keys: ["drag"], desc: "select region (aggregate)" },
  { keys: ["double-click"], desc: "clear region" },
];

function Kbd({ label }: { label: string }) {
  // Plus-glyph is rendered as plain text so the visual "shift + drag"
  // reads naturally instead of boxing the operator.
  if (label === "+") return <span className="help-modal-plus">+</span>;
  return <span className="kbd">{label}</span>;
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <ul className="help-modal-list">
      {rows.map((row, i) => (
        <li key={i}>
          <span className="help-modal-keys">
            {row.keys.map((k, j) => (
              <Kbd key={j} label={k} />
            ))}
          </span>
          <span className="help-modal-desc">{row.desc}</span>
        </li>
      ))}
    </ul>
  );
}

export const HelpModal = memo(function HelpModal({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      className="help-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-modal-header">
          <h2 id="help-modal-title">Keyboard shortcuts &amp; gestures</h2>
          <button
            type="button"
            className="help-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="help-modal-grid">
          <section>
            <h3>Keyboard</h3>
            <RowList rows={KEYBOARD_ROWS} />
          </section>
          <section>
            <h3>Mouse (timeline)</h3>
            <RowList rows={MOUSE_ROWS} />
          </section>
        </div>

        <div className="help-modal-footer">
          press <span className="kbd">?</span> to toggle this dialog
        </div>
      </div>
    </div>
  );
});
