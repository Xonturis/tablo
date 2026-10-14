import { loadFromBlob } from "@excalidraw/excalidraw";
import type { ProjectDoc } from "../store/project";
import { boardToExcalidrawFile } from "./BoardCanvas";

type Json = Record<string, unknown>;

export type ProjectFile = {
  type: "tablo-project";
  version: 1;
  name: string;
  exportedAt: string;
  boards: { name: string; scene: ReturnType<typeof boardToExcalidrawFile> }[];
};

const baseName = (fileName: string) => fileName.replace(/\.(excalidraw|json)$/i, "") || "Imported board";

/** Read one .excalidraw file into { name, elements, files } (normalised by Excalidraw). */
export async function readExcalidrawFile(file: File) {
  const scene = await loadFromBlob(file, null, null);
  return {
    name: baseName(file.name),
    elements: scene.elements.filter((e) => !e.isDeleted) as unknown as Json[],
    files: (scene.files || {}) as unknown as Record<string, Json>,
  };
}

/** Add each .excalidraw file as a new board. Returns the ids of the created boards. */
export async function importBoards(project: ProjectDoc, files: FileList | File[]): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const f of Array.from(files)) {
    try {
      const b = await readExcalidrawFile(f);
      ids.push(project.createBoard(b.name, b.elements, b.files));
    } catch (e) {
      errors.push(`${f.name}: ${(e as Error).message || "not an Excalidraw file"}`);
    }
  }
  return { ids, errors };
}

export function exportProject(project: ProjectDoc, name: string): ProjectFile {
  return {
    type: "tablo-project",
    version: 1,
    name,
    exportedAt: new Date().toISOString(),
    boards: project.listBoards().map((b) => ({ name: b.name, scene: boardToExcalidrawFile(project, b.id) })),
  };
}

export async function readProjectFile(file: File): Promise<ProjectFile | null> {
  try {
    const data = JSON.parse(await file.text());
    return data?.type === "tablo-project" && Array.isArray(data.boards) ? (data as ProjectFile) : null;
  } catch {
    return null;
  }
}

export function importProjectFile(project: ProjectDoc, data: ProjectFile) {
  for (const b of data.boards) {
    project.createBoard(
      b.name,
      (b.scene.elements || []) as Json[],
      (b.scene.files || {}) as Record<string, Json>,
    );
  }
}

export function download(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "untitled";
