import { useMemo, useState } from "react";
import type { ProjectDoc } from "../store/project";
import { boardScene } from "../board/BoardCanvas";
import { downloadBlob, framesToPdf, listFrames } from "../board/pdfExport";
import { safeFileName } from "../board/importExport";

/** Unique, file-system-safe PDF names: "Frame.pdf", "Frame (2).pdf", ... */
export function pdfNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const base = safeFileName(n);
    const k = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), k);
    return k === 1 ? `${base}.pdf` : `${base} (${k}).pdf`;
  });
}

/** Export frames of a board; each PDF is named after its frame. Resolves when downloads start. */
export async function exportFramesPdf(
  project: ProjectDoc,
  boardId: string,
  frameIds: string[],
  mode: "single" | "separate",
  boardName: string,
  onProgress?: (done: number, total: number) => void,
) {
  const { elements, files } = boardScene(project, boardId);
  const frames = listFrames(elements).filter((f) => frameIds.includes(f.id));
  if (mode === "single" || frames.length === 1) {
    const blob = await framesToPdf(elements, files, frames.map((f) => f.id), onProgress);
    const name = frames.length === 1 ? pdfNames([frames[0].name])[0] : `${safeFileName(boardName)} - ${frames.length} frames.pdf`;
    downloadBlob(name, blob);
    return;
  }
  const names = pdfNames(frames.map((f) => f.name));
  for (const [i, f] of frames.entries()) {
    const blob = await framesToPdf(elements, files, [f.id]);
    downloadBlob(names[i], blob);
    onProgress?.(i + 1, frames.length);
    await new Promise((r) => setTimeout(r, 300)); // browsers drop downloads fired too quickly
  }
}

export function PdfDialog({
  project,
  boardId,
  boardName,
  preselected,
  onClose,
}: {
  project: ProjectDoc;
  boardId: string;
  boardName: string;
  preselected: string[];
  onClose: () => void;
}) {
  const frames = useMemo(() => listFrames(boardScene(project, boardId).elements), [project, boardId]);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(preselected.length ? preselected : frames.map((f) => f.id)),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const run = async (ids: string[], mode: "single" | "separate", label: string) => {
    setError("");
    setBusy(label);
    try {
      await exportFramesPdf(project, boardId, ids, mode, boardName, (d, t) => t > 1 && setBusy(`${label} ${d}/${t}`));
    } catch (e) {
      setError((e as Error).message || "Export failed");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const ids = frames.filter((f) => checked.has(f.id)).map((f) => f.id);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal pdf-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="pdf-title">Export frames to PDF</h2>
        {frames.length === 0 ? (
          <p className="muted small">This board has no frames. Draw one with the frame tool (F) around what you want to export.</p>
        ) : (
          <>
            <p className="muted small">Each PDF is named after its frame. Vector output: text stays selectable.</p>
            <div className="frame-list-tools small">
              <button className="link small" onClick={() => setChecked(new Set(frames.map((f) => f.id)))}>All</button>
              <button className="link small" onClick={() => setChecked(new Set())}>None</button>
              <span className="muted">{ids.length} of {frames.length} selected</span>
            </div>
            <ul className="frame-list">
              {frames.map((f) => (
                <li key={f.id}>
                  <label>
                    <input type="checkbox" checked={checked.has(f.id)} onChange={() => toggle(f.id)} />
                    <span className="frame-name">{f.name}</span>
                  </label>
                  <button className="small" disabled={!!busy} onClick={() => run([f.id], "single", f.name)} title={`Download ${f.name}.pdf`}>
                    PDF
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <div className="notice small">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={!!busy}>Close</button>
          {frames.length > 0 && (
            <span className="row">
              <button disabled={!ids.length || !!busy} onClick={() => run(ids, "separate", "Exporting")}>
                Separate PDFs
              </button>
              <button className="primary" disabled={!ids.length || !!busy} onClick={() => run(ids, "single", "Exporting")}>
                {busy ?? (ids.length > 1 ? `One PDF (${ids.length} pages)` : "Export")}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
