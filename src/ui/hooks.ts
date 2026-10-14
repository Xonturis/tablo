import { useEffect, useState, useSyncExternalStore } from "react";
import { listProjects, projectsMap, type ProjectEntry } from "../store/library";
import type { BoardInfo, ProjectDoc } from "../store/project";
import type { P2PSync, PeerState } from "../sync/p2p";

export function useHashRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export const navigate = (path: string) => {
  location.hash = path;
};

export function useProjects(): ProjectEntry[] {
  const [list, setList] = useState(listProjects);
  useEffect(() => {
    const on = () => setList(listProjects());
    projectsMap.observe(on);
    on();
    return () => projectsMap.unobserve(on);
  }, []);
  return list;
}

export function useBoards(project: ProjectDoc | null): BoardInfo[] {
  const [boards, setBoards] = useState<BoardInfo[]>(() => project?.listBoards() ?? []);
  useEffect(() => {
    if (!project) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBoards(project.listBoards()));
    };
    project.boards.observeDeep(on);
    setBoards(project.listBoards());
    return () => {
      cancelAnimationFrame(raf);
      project.boards.unobserveDeep(on);
    };
  }, [project]);
  return boards;
}

export function useProjectName(project: ProjectDoc | null): string {
  const [name, setName] = useState(() => project?.name ?? "");
  useEffect(() => {
    if (!project) return;
    const on = () => setName(project.name);
    project.meta.observe(on);
    on();
    return () => project.meta.unobserve(on);
  }, [project]);
  return name;
}

const noPeers: PeerState[] = [];

export function usePeers(sync: P2PSync | null): PeerState[] {
  return useSyncExternalStore(
    (cb) => (sync ? sync.subscribe(cb) : () => {}),
    () => (sync ? peersSnapshot(sync) : noPeers),
  );
}

// useSyncExternalStore needs a stable snapshot between changes
const snapshots = new WeakMap<P2PSync, { key: string; value: PeerState[] }>();
function peersSnapshot(sync: P2PSync): PeerState[] {
  const peers = sync.getPeers();
  const key = peers.map((p) => `${p.id}:${p.presence?.name ?? ""}:${p.presence?.boardId ?? ""}`).join("|");
  const cached = snapshots.get(sync);
  if (cached && cached.key === key) return cached.value;
  snapshots.set(sync, { key, value: peers });
  return peers;
}
