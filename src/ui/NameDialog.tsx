import { useState } from "react";

export function NameDialog({ initial, onSave, onCancel }: { initial: string; onSave: (n: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
      >
        <h2 id="name-title">Your name</h2>
        <p className="muted small">Shown to collaborators next to your cursor.</p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lylian" aria-label="Your name" />
        <div className="modal-actions">
          {onCancel && (
            <button type="button" className="ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
