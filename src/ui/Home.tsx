import { useRef, useState } from "react";
import {
  createProjectEntry,
  getProject,
  parseShareLink,
  removeProjectEntry,
  type ProjectEntry,
} from "../store/library";
import { getProjectDoc, wipeProjectData } from "../store/project";
import { importBoards, importProjectFile, readProjectFile } from "../board/importExport";
import { navigate, useProjects } from "./hooks";

const fmtDate = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function Home({ notice }: { notice?: string }) {
  const projects = useProjects();
  const [newName, setNewName] = useState("");
  const [joinText, setJoinText] = useState("");
  const [message, setMessage] = useState(notice ?? "");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const p = createProjectEntry(newName.trim() || "Untitled project");
    setNewName("");
    navigate(`/p/${p.id}`);
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const link = parseShareLink(joinText);
    if (!link) return setMessage("That doesn't look like a Tablo share link.");
    if (getProject(link.id)) return navigate(`/p/${link.id}`);
    navigate(`/join/${link.id}/${link.secret}/${encodeURIComponent(link.name)}`);
  };

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    // A Tablo project backup becomes a project; .excalidraw files become boards of a new project
    const projectFile = list.length === 1 ? await readProjectFile(list[0]) : null;
    const entry = createProjectEntry(
      projectFile?.name ?? (list.length === 1 ? list[0].name.replace(/\.(excalidraw|json)$/i, "") : "Imported boards"),
    );
    const doc = getProjectDoc(entry.id);
    await doc.ready;
    doc.setName(entry.name);
    let errors: string[] = [];
    if (projectFile) importProjectFile(doc, projectFile);
    else errors = (await importBoards(doc, list)).errors;
    if (doc.listBoards().length === 0) doc.createBoard("Board 1");
    if (errors.length) setMessage(`Some files could not be imported: ${errors.join("; ")}`);
    else navigate(`/p/${entry.id}`);
    if (fileInput.current) fileInput.current.value = "";
  };

  const remove = async (p: ProjectEntry) => {
    if (confirmDelete !== p.id) return setConfirmDelete(p.id);
    setConfirmDelete(null);
    removeProjectEntry(p.id);
    await wipeProjectData(p.id);
  };

  return (
    <div className="home">
      <header className="home-header">
        <img src="./icon.svg" alt="" width={36} height={36} />
        <div>
          <h1>Tablo</h1>
          <p className="muted">Whiteboards stored on this device. Share a project with a link; edits sync directly between browsers.</p>
        </div>
      </header>

      {message && (
        <div className="notice" role="status">
          {message}
          <button className="link" onClick={() => setMessage("")}>Dismiss</button>
        </div>
      )}

      <section className="home-actions">
        <form onSubmit={create} className="card">
          <h2>New project</h2>
          <div className="row">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Project name" aria-label="Project name" />
            <button type="submit" className="primary">Create</button>
          </div>
        </form>
        <form onSubmit={join} className="card">
          <h2>Join a shared project</h2>
          <div className="row">
            <input value={joinText} onChange={(e) => setJoinText(e.target.value)} placeholder="Paste a share link" aria-label="Share link" />
            <button type="submit">Join</button>
          </div>
        </form>
        <div className="card">
          <h2>Import</h2>
          <p className="muted small">.excalidraw files (each becomes a board) or a Tablo project backup.</p>
          <button onClick={() => fileInput.current?.click()}>Choose files…</button>
          <input
            ref={fileInput}
            type="file"
            accept=".excalidraw,.json,application/json"
            multiple
            hidden
            onChange={(e) => onImport(e.target.files)}
          />
        </div>
      </section>

      <section>
        <h2 className="section-title">Projects</h2>
        {projects.length === 0 ? (
          <p className="muted">No projects yet. Create one or import your exported boards.</p>
        ) : (
          <ul className="project-grid">
            {projects.map((p) => (
              <li key={p.id} className="project-card">
                <a href={`#/p/${p.id}`} className="project-open">
                  <span className="project-name">{p.name}</span>
                  <span className="muted small">
                    Opened {fmtDate(p.openedAt)}
                    {p.sharing && <span className="badge">Shared</span>}
                  </span>
                </a>
                <button
                  className={confirmDelete === p.id ? "danger small" : "ghost small"}
                  onClick={() => remove(p)}
                  onBlur={() => setConfirmDelete(null)}
                  title="Delete this project from this device"
                >
                  {confirmDelete === p.id ? "Confirm delete" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="muted small">
        Deleting a project removes it from this device only; collaborators keep their copy.
      </footer>
    </div>
  );
}
