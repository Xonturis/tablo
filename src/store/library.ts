// The local list of projects on this device. Never shared with anyone.
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

export type ProjectEntry = {
  id: string;
  name: string;
  /** Random secret: anyone holding it (via the share link) can join the project. */
  secret: string;
  createdAt: number;
  openedAt: number;
  /** Whether live peer-to-peer sharing is switched on for this project. */
  sharing: boolean;
  /** Joined from someone else's link (its content arrives from peers). */
  joined?: boolean;
};

export const randomId = (bytes = 12): string => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, bytes * 2);
};

const doc = new Y.Doc();
const persistence = new IndexeddbPersistence("tablo-library", doc);
export const libraryReady: Promise<unknown> = persistence.whenSynced;
export const projectsMap = doc.getMap<ProjectEntry>("projects");

export function listProjects(): ProjectEntry[] {
  return Array.from(projectsMap.values()).sort((a, b) => b.openedAt - a.openedAt);
}

export function getProject(id: string): ProjectEntry | undefined {
  return projectsMap.get(id);
}

export function upsertProject(entry: ProjectEntry) {
  projectsMap.set(entry.id, entry);
}

export function updateProject(id: string, patch: Partial<ProjectEntry>) {
  const cur = projectsMap.get(id);
  if (cur) projectsMap.set(id, { ...cur, ...patch });
}

export function createProjectEntry(name: string): ProjectEntry {
  const now = Date.now();
  const entry: ProjectEntry = {
    id: randomId(10),
    name,
    secret: randomId(16),
    createdAt: now,
    openedAt: now,
    sharing: false,
  };
  upsertProject(entry);
  return entry;
}

export function removeProjectEntry(id: string) {
  projectsMap.delete(id);
}

// ---- share links -------------------------------------------------------------
// The secret lives in the URL fragment (#...), which browsers never send to a server.

export function shareLink(p: ProjectEntry): string {
  const base = location.href.split("#")[0];
  return `${base}#/join/${p.id}/${p.secret}/${encodeURIComponent(p.name)}`;
}

export function parseShareLink(text: string): { id: string; secret: string; name: string } | null {
  const m = text.trim().match(/#\/join\/([a-z0-9]+)\/([a-z0-9]+)(?:\/([^/?#]*))?/i);
  if (!m) return null;
  return { id: m[1], secret: m[2], name: m[3] ? decodeURIComponent(m[3]) : "Shared project" };
}

// ---- user identity (per device) ------------------------------------------------

const NAME_KEY = "tablo.username";

export function getUserName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function setUserName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable: name lasts for this session only */
  }
}

export function colorFor(seed: string): { background: string; stroke: string } {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return { background: `hsl(${hue} 80% 85%)`, stroke: `hsl(${hue} 70% 40%)` };
}
