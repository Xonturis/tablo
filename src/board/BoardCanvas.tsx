// An Excalidraw canvas kept in sync with one board of the project's Yjs document.
//
// Each Excalidraw element is stored as a plain JSON value in a Y.Map keyed by element id.
// Conflicts are resolved per element the same way Excalidraw's own collaboration does:
// the higher `version` wins, ties are broken by the lower `versionNonce`.
// Deleted elements are kept as tombstones (`isDeleted: true`) so deletions sync too.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Excalidraw, CaptureUpdateAction, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import type { ElementsMap, FilesMap, ProjectDoc } from "../store/project";
import { colorFor } from "../store/library";
import type { P2PSync } from "../sync/p2p";

type El = OrderedExcalidrawElement;
type Json = Record<string, unknown>;

const LOCAL = { origin: "tablo-local-canvas" }; // Yjs transaction origin for our own edits
const THEME_KEY = "tablo.theme";

/** Is element `a` the one to keep over `b`? (Excalidraw's reconciliation rule) */
const wins = (a: Json, b: Json) =>
  (a.version as number) > (b.version as number) ||
  (a.version === b.version && (a.versionNonce as number) < (b.versionNonce as number));

const sameVersion = (a: Json, b: Json) => a.version === b.version && a.versionNonce === b.versionNonce;

const byIndex = (a: Json, b: Json) => {
  const x = a.index as string | null | undefined;
  const y = b.index as string | null | undefined;
  if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
  return x < y ? -1 : x > y ? 1 : 0;
};

// Excalidraw mutates elements in place, so never share objects between it and Yjs.
const clone = <T,>(v: T): T => structuredClone(v);

type Viewport = { scrollX: number; scrollY: number; zoom: number };
const viewKey = (projectId: string, boardId: string) => `tablo.view.${projectId}.${boardId}`;

function readViewport(key: string): Viewport | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && typeof v.zoom === "number" ? v : null;
  } catch {
    return null;
  }
}

function readTheme(): "light" | "dark" {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

type Props = {
  project: ProjectDoc;
  boardId: string;
  sync: P2PSync | null;
};

export function BoardCanvas({ project, boardId, sync }: Props) {
  const board = project.getBoard(boardId)!;
  const elementsMap = board.get("elements") as ElementsMap;
  const filesMap = board.get("files") as FilesMap;
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const applyScheduled = useRef(false);
  const lastSelection = useRef("");
  const lastTheme = useRef(readTheme());
  const pointerTimer = useRef(0);
  const vKey = viewKey(project.id, boardId);
  const savedView = useRef(readViewport(vKey));
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initialData = useMemo(() => {
    const elements = Array.from(elementsMap.values()).map(clone).sort(byIndex) as unknown as El[];
    const files: BinaryFiles = {};
    filesMap.forEach((f, id) => (files[id] = clone(f) as unknown as BinaryFileData));
    const v = savedView.current;
    return {
      elements,
      files,
      // Reopen where you left off; otherwise fit the whole board in view (see onApi)
      appState: v
        ? { theme: lastTheme.current, scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom as never } }
        : { theme: lastTheme.current },
    };
    // initial data is read once per board; later changes flow through applyRemote
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  /** Push local changes that are newer than what the shared document holds. */
  const pushLocal = useCallback(
    (elements: readonly El[], files?: BinaryFiles) => {
      const changed: Json[] = [];
      for (const el of elements) {
        const prev = elementsMap.get(el.id);
        if (!prev || wins(el as unknown as Json, prev)) changed.push(el as unknown as Json);
      }
      const newFiles = files
        ? Object.values(files).filter((f) => f && !filesMap.has(f.id))
        : [];
      if (!changed.length && !newFiles.length) return;
      project.doc.transact(() => {
        for (const el of changed) elementsMap.set(el.id as string, clone(el));
        for (const f of newFiles) filesMap.set(f.id, clone(f) as unknown as Json);
      }, LOCAL);
    },
    [elementsMap, filesMap, project],
  );

  /** Merge the shared document into the canvas (after remote edits). */
  const applyRemote = useCallback(() => {
    applyScheduled.current = false;
    const api = apiRef.current;
    if (!api) return;
    const local = api.getSceneElementsIncludingDeleted();
    const localById = new Map(local.map((e) => [e.id, e]));
    const merged: El[] = [];
    const repush: El[] = [];
    let changed = false;
    elementsMap.forEach((remote, id) => {
      const loc = localById.get(id);
      if (loc && (sameVersion(loc as unknown as Json, remote) || wins(loc as unknown as Json, remote))) {
        merged.push(loc);
        if (!sameVersion(loc as unknown as Json, remote)) repush.push(loc);
      } else {
        merged.push(clone(remote) as unknown as El);
        changed = true;
      }
      localById.delete(id);
    });
    for (const loc of localById.values()) {
      merged.push(loc); // created locally but not yet in the shared document
      repush.push(loc);
    }
    if (changed) {
      merged.sort(byIndex as unknown as (a: El, b: El) => number);
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    }
    const known = api.getFiles();
    const missing: BinaryFileData[] = [];
    filesMap.forEach((f, id) => {
      if (!known[id]) missing.push(clone(f) as unknown as BinaryFileData);
    });
    if (missing.length) api.addFiles(missing);
    if (repush.length) pushLocal(repush);
  }, [elementsMap, filesMap, pushLocal]);

  // Listen to the shared document
  useEffect(() => {
    const onRemote = (_e: unknown, txn: { origin: unknown }) => {
      if (txn.origin === LOCAL || applyScheduled.current) return;
      applyScheduled.current = true;
      requestAnimationFrame(applyRemote);
    };
    elementsMap.observe(onRemote);
    filesMap.observe(onRemote);
    return () => {
      elementsMap.unobserve(onRemote);
      filesMap.unobserve(onRemote);
    };
  }, [elementsMap, filesMap, applyRemote]);

  // Show collaborators' cursors and selections
  useEffect(() => {
    if (!sync) return;
    sync.setPresence({ boardId, pointer: null, selected: [] });
    const render = () => {
      const api = apiRef.current;
      if (!api) return;
      const collaborators = new Map<SocketId, Collaborator>();
      for (const peer of sync.getPeers()) {
        const p = peer.presence;
        if (!p || p.boardId !== boardId) continue;
        collaborators.set(peer.id as SocketId, {
          username: p.name,
          color: colorFor(p.name + peer.id),
          button: p.button,
          pointer: p.pointer ? { ...p.pointer, tool: "pointer" } : undefined,
          selectedElementIds: Object.fromEntries(p.selected.map((id) => [id, true])),
          socketId: peer.id as SocketId,
        });
      }
      api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
    };
    render();
    const unsub = sync.subscribe(render);
    return () => {
      unsub();
      sync.setPresence({ boardId: null, pointer: null, selected: [] });
    };
  }, [sync, boardId]);

  const onChange = useCallback(
    (elements: readonly El[], appState: AppState, files: BinaryFiles) => {
      pushLocal(elements, files);
      const v = savedView.current;
      if (!v || v.scrollX !== appState.scrollX || v.scrollY !== appState.scrollY || v.zoom !== appState.zoom.value) {
        savedView.current = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value };
        if (viewTimer.current) clearTimeout(viewTimer.current);
        viewTimer.current = setTimeout(() => {
          try {
            localStorage.setItem(vKey, JSON.stringify(savedView.current));
          } catch {
            /* ignore */
          }
        }, 500);
      }
      if (appState.theme !== lastTheme.current) {
        lastTheme.current = appState.theme;
        try {
          localStorage.setItem(THEME_KEY, appState.theme);
        } catch {
          /* ignore */
        }
      }
      if (sync) {
        const sel = Object.keys(appState.selectedElementIds).sort().join(",");
        if (sel !== lastSelection.current) {
          lastSelection.current = sel;
          sync.setPresence({ selected: sel ? sel.split(",") : [] });
        }
      }
    },
    [pushLocal, sync, vKey],
  );

  const onApi = useCallback((api: ExcalidrawImperativeAPI) => {
    const first = !apiRef.current;
    apiRef.current = api;
    if (first && !readViewport(vKey)) {
      // First visit of this board on this device: fit everything on screen
      setTimeout(() => {
        if (api.getSceneElements().length) api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 });
      }, 50);
    }
  }, [vKey]);

  const onPointerUpdate = useCallback(
    (p: { pointer: { x: number; y: number }; button: "up" | "down" }) => {
      if (!sync) return;
      const now = performance.now();
      if (now - pointerTimer.current < 50) return;
      pointerTimer.current = now;
      sync.setPresence({ pointer: { x: p.pointer.x, y: p.pointer.y }, button: p.button });
    },
    [sync],
  );

  const peersHere = sync ? sync.getPeers().length > 0 : false;

  return (
    <Excalidraw
      key={boardId}
      excalidrawAPI={onApi}
      initialData={initialData}
      onChange={onChange}
      onPointerUpdate={onPointerUpdate}
      isCollaborating={peersHere}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
      <WelcomeScreen>
        <WelcomeScreen.Hints.ToolbarHint />
        <WelcomeScreen.Hints.HelpHint />
        <WelcomeScreen.Center>
          <WelcomeScreen.Center.Heading>Empty board. Pick a tool and start drawing.</WelcomeScreen.Center.Heading>
        </WelcomeScreen.Center>
      </WelcomeScreen>
    </Excalidraw>
  );
}

/** Snapshot of a board as an .excalidraw file (for export). */
export function boardToExcalidrawFile(project: ProjectDoc, boardId: string) {
  const b = project.getBoard(boardId)!;
  const els = Array.from((b.get("elements") as ElementsMap).values())
    .filter((e) => !e.isDeleted)
    .sort(byIndex);
  const files: Record<string, Json> = {};
  (b.get("files") as FilesMap).forEach((f, id) => (files[id] = f));
  return {
    type: "excalidraw",
    version: 2,
    source: "tablo",
    elements: els,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files,
  };
}
