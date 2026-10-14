// One Yjs document per project. Everything in it is shared with collaborators.
//
//   meta:   Y.Map { name }
//   boards: Y.Map<boardId, Y.Map {
//             name: string, createdAt: number, order: number,
//             elements: Y.Map<elementId, ExcalidrawElement>,   // plain JSON objects
//             files:    Y.Map<fileId, BinaryFileData>          // images (data URLs)
//           }>
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { randomId } from "./library";

export type BoardMap = Y.Map<unknown>;
export type ElementsMap = Y.Map<Record<string, unknown>>;
export type FilesMap = Y.Map<Record<string, unknown>>;

export type BoardInfo = { id: string; name: string; createdAt: number; order: number; count: number };

export class ProjectDoc {
  readonly doc = new Y.Doc();
  readonly persistence: IndexeddbPersistence;
  readonly ready: Promise<unknown>;
  readonly meta: Y.Map<unknown>;
  readonly boards: Y.Map<BoardMap>;

  constructor(readonly id: string) {
    this.persistence = new IndexeddbPersistence(`tablo-project-${id}`, this.doc);
    this.ready = this.persistence.whenSynced;
    this.meta = this.doc.getMap("meta");
    this.boards = this.doc.getMap<BoardMap>("boards");
  }

  get name(): string {
    return (this.meta.get("name") as string) || "";
  }

  setName(name: string) {
    this.meta.set("name", name);
  }

  listBoards(): BoardInfo[] {
    const out: BoardInfo[] = [];
    this.boards.forEach((b, id) => {
      const els = b.get("elements") as ElementsMap | undefined;
      let count = 0;
      els?.forEach((e) => {
        if (!e.isDeleted) count++;
      });
      out.push({
        id,
        name: (b.get("name") as string) || "Untitled board",
        createdAt: (b.get("createdAt") as number) || 0,
        order: (b.get("order") as number) ?? 0,
        count,
      });
    });
    return out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  getBoard(id: string): BoardMap | undefined {
    return this.boards.get(id);
  }

  createBoard(
    name: string,
    elements: readonly Record<string, unknown>[] = [],
    files: Record<string, Record<string, unknown>> = {},
  ): string {
    const id = randomId(8);
    const maxOrder = this.listBoards().reduce((m, b) => Math.max(m, b.order), 0);
    this.doc.transact(() => {
      const b = new Y.Map<unknown>();
      b.set("name", name);
      b.set("createdAt", Date.now());
      b.set("order", maxOrder + 1);
      const els = new Y.Map<Record<string, unknown>>();
      for (const e of elements) els.set(e.id as string, e);
      const fs = new Y.Map<Record<string, unknown>>();
      for (const [k, f] of Object.entries(files)) fs.set(k, f);
      b.set("elements", els);
      b.set("files", fs);
      this.boards.set(id, b);
    });
    return id;
  }

  renameBoard(id: string, name: string) {
    this.boards.get(id)?.set("name", name);
  }

  deleteBoard(id: string) {
    this.boards.delete(id);
  }

  async destroy() {
    await this.persistence.destroy();
    this.doc.destroy();
  }
}

// One live ProjectDoc per project for the lifetime of the page, so two parts of the UI
// never hold diverging copies of the same IndexedDB-backed document.
const openDocs = new Map<string, ProjectDoc>();

export function getProjectDoc(id: string): ProjectDoc {
  let p = openDocs.get(id);
  if (!p) {
    p = new ProjectDoc(id);
    openDocs.set(id, p);
  }
  return p;
}

/** Delete a project's local data from this device. */
export async function wipeProjectData(id: string) {
  const p = getProjectDoc(id);
  await p.ready;
  await p.persistence.clearData();
  p.doc.destroy();
  openDocs.delete(id);
}
