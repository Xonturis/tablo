import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getProject, getUserName, setUserName, shareLink, updateProject, colorFor } from "../store/library";
import { getProjectDoc, type ProjectDoc } from "../store/project";
import { P2PSync } from "../sync/p2p";
import { BoardCanvas, boardToExcalidrawFile } from "../board/BoardCanvas";
import { download, exportProject, importBoards, safeFileName } from "../board/importExport";
import { navigate, useBoards, usePeers, useProjectName, useProjects } from "./hooks";
import { NameDialog } from "./NameDialog";
import { PdfDialog, exportFramesPdf } from "./PdfDialog";
import { framesForSelection, listFrames } from "../board/pdfExport";
import { boardScene } from "../board/BoardCanvas";

export function ProjectView({ projectId, boardId }: { projectId: string; boardId: string | null }) {
  const entry = useProjects().find((p) => p.id === projectId) ?? getProject(projectId)!;
  const [project, setProject] = useState<ProjectDoc | null>(null);
  const [sync, setSync] = useState<P2PSync | null>(null);
  const [userName, setUserNameState] = useState(getUserName());
  const [askName, setAskName] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState("");
  const boards = useBoards(project);
  const projectName = useProjectName(project);
  const peers = usePeers(sync);

  // Open the project's document
  useEffect(() => {
    let alive = true;
    const p = getProjectDoc(projectId);
    p.ready.then(() => {
      if (!alive) return;
      const e = getProject(projectId);
      if (e && !e.joined) {
        if (!p.name) p.setName(e.name);
        if (p.listBoards().length === 0) p.createBoard("Board 1");
      }
      setProject(p);
    });
    updateProject(projectId, { openedAt: Date.now() });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // Keep the local project list in step with the shared name
  useEffect(() => {
    if (projectName && projectName !== entry.name) updateProject(projectId, { name: projectName });
  }, [projectName, entry.name, projectId]);

  // Live sharing: join the peer-to-peer room while sharing is on
  useEffect(() => {
    if (!project || !entry.sharing) return;
    if (!userName) {
      setAskName(true);
      return;
    }
    const s = new P2PSync(project.doc, projectId, entry.secret, userName);
    setSync(s);
    return () => {
      setSync(null);
      void s.leave();
    };
  }, [project, entry.sharing, entry.secret, projectId, userName]);

  // Pick a board: the one in the URL, else the first
  const current = boards.find((b) => b.id === boardId) ? boardId : boards[0]?.id ?? null;
  useEffect(() => {
    if (current && current !== boardId) history.replaceState(null, "", `#/p/${projectId}/${current}`);
  }, [current, boardId, projectId]);

  const fileInput = useRef<HTMLInputElement>(null);
  const onSelectionChange = useCallback((ids: string[]) => setSelection(ids), []);
  useEffect(() => setSelection([]), [current]);
  // Frames the current selection points at (a frame, or elements inside frames)
  const selectedFrames = useMemo(() => {
    if (!project || !current || !selection.length) return [];
    const { elements } = boardScene(project, current);
    const ids = framesForSelection(elements, selection);
    return listFrames(elements).filter((f) => ids.includes(f.id));
  }, [project, current, selection]);
  if (!project) return <div className="splash">Opening project…</div>;

  const boardName = boards.find((b) => b.id === current)?.name ?? "Board";
  const quickPdf = async () => {
    if (!current) return;
    setPdfBusy("Exporting…");
    try {
      await exportFramesPdf(project, current, selectedFrames.map((f) => f.id), "single", boardName);
    } catch (e) {
      setNotice(`PDF export failed: ${(e as Error).message}`);
    } finally {
      setPdfBusy("");
    }
  };

  const addBoard = () => {
    const id = project.createBoard(`Board ${boards.length + 1}`);
    navigate(`/p/${projectId}/${id}`);
  };

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const { ids, errors } = await importBoards(project, files);
    if (errors.length) setNotice(`Not imported: ${errors.join("; ")}`);
    if (ids.length) navigate(`/p/${projectId}/${ids[ids.length - 1]}`);
    if (fileInput.current) fileInput.current.value = "";
  };

  const exportBoard = () => {
    const b = boards.find((x) => x.id === current);
    if (b) download(`${safeFileName(b.name)}.excalidraw`, boardToExcalidrawFile(project, b.id));
  };

  const startSharing = () => {
    if (!userName) setAskName(true);
    updateProject(projectId, { sharing: true });
    setShareOpen(true);
  };

  return (
    <div className={`project ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Project">
        <div className="sidebar-top">
          <a href="#/" className="back" title="All projects">← Projects</a>
          <button className="ghost icon" onClick={() => setCollapsed(true)} title="Hide sidebar" aria-label="Hide sidebar">⟨</button>
        </div>

        <EditableText
          className="project-title"
          value={projectName || entry.name}
          onSave={(v) => project.setName(v)}
          label="Project name"
        />

        <div className="share-box">
          {entry.sharing ? (
            <>
              <div className="status">
                <span className={`dot ${peers.length ? "on" : ""}`} />
                {peers.length
                  ? `${peers.length} other ${peers.length > 1 ? "people" : "person"} connected`
                  : "Shared · nobody else online"}
              </div>
              {peers.length > 0 && (
                <ul className="peers">
                  {peers.map((p) => (
                    <li key={p.id}>
                      <span className="avatar" style={{ background: colorFor((p.presence?.name ?? "") + p.id).stroke }} />
                      {p.presence?.name ?? "Connecting…"}
                      {p.presence?.boardId && p.presence.boardId !== current && (
                        <button className="link small" onClick={() => navigate(`/p/${projectId}/${p.presence!.boardId}`)}>
                          on {boards.find((b) => b.id === p.presence!.boardId)?.name ?? "another board"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <button className="small" onClick={() => setShareOpen(true)}>Share link…</button>
            </>
          ) : (
            <button className="primary" onClick={startSharing}>Share project…</button>
          )}
        </div>

        <div className="boards-header">
          <h2>Boards</h2>
          <button className="ghost small" onClick={addBoard} title="New board">+ New</button>
        </div>
        <ul className="boards">
          {boards.map((b) => (
            <BoardRow
              key={b.id}
              name={b.name}
              count={b.count}
              active={b.id === current}
              onOpen={() => navigate(`/p/${projectId}/${b.id}`)}
              onRename={(n) => project.renameBoard(b.id, n)}
              onDelete={() => {
                project.deleteBoard(b.id);
                if (b.id === current) navigate(`/p/${projectId}`);
              }}
              canDelete={boards.length > 1}
            />
          ))}
          {boards.length === 0 && (
            <li className="muted small waiting">
              {entry.joined
                ? "Waiting for someone who has this project to come online…"
                : "No boards yet."}
            </li>
          )}
        </ul>

        <div className="sidebar-actions">
          <button className="ghost small" onClick={() => fileInput.current?.click()}>Import .excalidraw…</button>
          <input ref={fileInput} type="file" accept=".excalidraw,.json" multiple hidden onChange={(e) => onImport(e.target.files)} />
          <button className="ghost small" onClick={exportBoard} disabled={!current}>Export board</button>
          {selectedFrames.length > 0 ? (
            <button className="small pdf-quick" onClick={quickPdf} disabled={!!pdfBusy} title="Export the selected frame(s) as PDF">
              {pdfBusy ||
                (selectedFrames.length === 1
                  ? `PDF of “${selectedFrames[0].name}”`
                  : `PDF of ${selectedFrames.length} selected frames`)}
            </button>
          ) : null}
          <button className="ghost small" onClick={() => setPdfOpen(true)} disabled={!current}>Export frames to PDF…</button>
          <button
            className="ghost small"
            onClick={() => download(`${safeFileName(projectName || entry.name)}.tablo.json`, exportProject(project, projectName || entry.name))}
          >
            Back up project
          </button>
        </div>
        {notice && (
          <div className="notice small">
            {notice} <button className="link" onClick={() => setNotice("")}>OK</button>
          </div>
        )}
        <div className="me muted small">
          You: {userName || "(no name)"}{" "}
          <button className="link small" onClick={() => setAskName(true)}>change</button>
        </div>
      </aside>

      {collapsed && (
        <button className="expand" onClick={() => setCollapsed(false)} title="Show sidebar" aria-label="Show sidebar">⟩</button>
      )}

      <main className="canvas">
        {current && project.getBoard(current) ? (
          <BoardCanvas key={current} project={project} boardId={current} sync={sync} onSelectionChange={onSelectionChange} />
        ) : (
          <div className="splash muted">{entry.joined ? "Waiting for the project to arrive…" : "Create a board to start."}</div>
        )}
      </main>

      {pdfOpen && current && (
        <PdfDialog
          project={project}
          boardId={current}
          boardName={boardName}
          preselected={selectedFrames.map((f) => f.id)}
          onClose={() => setPdfOpen(false)}
        />
      )}
      {askName && (
        <NameDialog
          initial={userName}
          onSave={(n) => {
            setUserName(n);
            setUserNameState(n);
            setAskName(false);
          }}
          onCancel={userName ? () => setAskName(false) : undefined}
        />
      )}
      {shareOpen && !askName && (
        <ShareDialog
          link={shareLink({ ...entry, name: projectName || entry.name })}
          onStop={() => {
            updateProject(projectId, { sharing: false });
            setShareOpen(false);
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

function EditableText({ value, onSave, className, label }: { value: string; onSave: (v: string) => void; className?: string; label: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing)
    return (
      <h1 className={className} title="Click to rename" onClick={() => { setDraft(value); setEditing(true); }}>
        {value}
      </h1>
    );
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      className={`${className} editing`}
      aria-label={label}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function BoardRow(props: {
  name: string;
  count: number;
  active: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onRename: (n: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState(props.name);
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== props.name) props.onRename(draft.trim());
  };
  return (
    <li className={`board-row ${props.active ? "active" : ""}`}>
      {editing ? (
        <input
          autoFocus
          aria-label="Board name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button className="board-open" onClick={props.onOpen} onDoubleClick={() => { setDraft(props.name); setEditing(true); }} title="Double-click to rename">
          <span className="board-name">{props.name}</span>
          <span className="muted small">{props.count}</span>
        </button>
      )}
      {!editing && (
        <span className="board-tools">
          <button className="ghost icon" title="Rename" aria-label={`Rename ${props.name}`} onClick={() => { setDraft(props.name); setEditing(true); }}>✎</button>
          {props.canDelete && (
            <button
              className={confirm ? "danger small" : "ghost icon"}
              title="Delete board"
              aria-label={`Delete ${props.name}`}
              onClick={() => (confirm ? props.onDelete() : setConfirm(true))}
              onBlur={() => setConfirm(false)}
            >
              {confirm ? "Delete?" : "🗑"}
            </button>
          )}
        </span>
      )}
    </li>
  );
}

function ShareDialog({ link, onStop, onClose }: { link: string; onStop: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      (document.getElementById("share-link") as HTMLInputElement | null)?.select();
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="share-title">Share this project</h2>
        <p className="muted small">
          Anyone with this link can view and edit every board in the project. Changes travel directly
          between your browsers, encrypted. You both need the app open at the same time to sync; each
          of you keeps a full copy and works offline in between.
        </p>
        <div className="row">
          <input id="share-link" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Share link" />
          <button className="primary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <div className="modal-actions">
          <button className="ghost small" onClick={onStop}>Stop sharing on this device</button>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
