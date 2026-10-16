// Export Excalidraw frames to vector PDF, one page per frame.
//
// Each frame is rendered by Excalidraw to SVG (clipped to the frame), then drawn into the PDF
// by svg2pdf.js: lines stay sharp and text stays selectable text. Excalidraw's fonts are
// embedded from public/pdf-fonts (TrueType copies made by scripts/build-pdf-fonts.py).
import { exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, ExcalidrawFrameLikeElement, NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { jsPDF as JsPDF } from "jspdf";

type El = NonDeletedExcalidrawElement;

// Font names exactly as Excalidraw writes them in SVG -> TrueType file in public/pdf-fonts
const FONT_FILES: Record<string, string> = {
  Virgil: "Virgil",
  Helvetica: "Liberation", // metric-compatible with Helvetica, and covers accents
  Cascadia: "Cascadia",
  Excalifont: "Excalifont",
  Nunito: "Nunito",
  "Lilita One": "Lilita",
  "Comic Shanns": "ComicShanns",
  "Liberation Sans": "Liberation",
};
const FAMILY_BY_ID: Record<number, string> = {
  1: "Virgil", 2: "Helvetica", 3: "Cascadia", 5: "Excalifont", 6: "Nunito", 7: "Lilita One", 8: "Comic Shanns", 9: "Liberation Sans",
};
const PT_PER_PX = 0.75; // CSS pixel = 1/96 in, PDF point = 1/72 in
const MAX_PT = 14400; // PDF page size limit (200 in)

export type FrameInfo = { id: string; name: string };

const isFrame = (e: ExcalidrawElement): e is ExcalidrawFrameLikeElement =>
  (e.type === "frame" || e.type === "magicframe") && !e.isDeleted;

export function frameName(f: { name?: string | null }) {
  return (f.name || "").trim() || "Frame";
}

/** Frames of a scene in reading order (top to bottom, then left to right). */
export function listFrames(elements: readonly ExcalidrawElement[]): FrameInfo[] {
  return elements
    .filter(isFrame)
    .sort((a, b) => Math.round(a.y / 50) - Math.round(b.y / 50) || a.x - b.x)
    .map((f) => ({ id: f.id, name: frameName(f) }));
}

/** Frames the user is pointing at: selected frames, or the frames of selected elements. */
export function framesForSelection(elements: readonly ExcalidrawElement[], selectedIds: readonly string[]): string[] {
  if (!selectedIds.length) return [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const id of selectedIds) {
    const e = byId.get(id);
    if (!e || e.isDeleted) continue;
    if (isFrame(e)) out.add(e.id);
    else if (e.frameId && byId.get(e.frameId) && !byId.get(e.frameId)!.isDeleted) out.add(e.frameId);
  }
  return [...out];
}

function elementsForFrame(all: readonly El[], frame: ExcalidrawFrameLikeElement): El[] {
  const fx1 = frame.x, fy1 = frame.y, fx2 = frame.x + frame.width, fy2 = frame.y + frame.height;
  return all.filter((e) => {
    if (e.id === frame.id || e.frameId === frame.id) return true;
    if (isFrame(e)) return false; // other frames: their content is decided by their own bounds
    const [x1, y1, x2, y2] = getCommonBounds([e]);
    return x2 >= fx1 && x1 <= fx2 && y2 >= fy1 && y1 <= fy2;
  });
}

const fontData = new Map<string, Promise<string>>();
function loadFont(file: string): Promise<string> {
  if (!fontData.has(file)) {
    fontData.set(
      file,
      fetch(new URL(`pdf-fonts/${file}.ttf`, document.baseURI)).then(async (r) => {
        if (!r.ok) throw new Error(`font ${file} not found`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      }),
    );
  }
  return fontData.get(file)!;
}

async function registerFonts(doc: JsPDF, elements: readonly El[], done: Set<string>) {
  const families = new Set<string>();
  for (const e of elements) if (e.type === "text") families.add(FAMILY_BY_ID[e.fontFamily] ?? "Excalifont");
  for (const family of families) {
    const file = FONT_FILES[family];
    if (!file || done.has(family)) continue;
    try {
      const data = await loadFont(file);
      doc.addFileToVFS(`${file}.ttf`, data);
      doc.addFont(`${file}.ttf`, family, "normal");
      done.add(family);
    } catch {
      /* falls back to a built-in PDF font */
    }
  }
}

/** svg2pdf draws PNG/JPEG only: turn other embedded images (SVG emojis, WebP, GIF...) into PNG. */
async function rasterizeImages(svg: SVGSVGElement) {
  const images = Array.from(svg.querySelectorAll("image"));
  await Promise.all(
    images.map(async (img) => {
      const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
      if (!href.startsWith("data:") || /^data:image\/(png|jpe?g);/i.test(href)) return;
      const w = parseFloat(img.getAttribute("width") || "0") || 256;
      const h = parseFloat(img.getAttribute("height") || "0") || 256;
      const pic = new Image();
      pic.src = href;
      try {
        await pic.decode();
      } catch {
        return;
      }
      const scale = Math.min(4, Math.max(1, 1024 / Math.max(w, h))); // keep small icons crisp
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(w * scale);
      canvas.height = Math.ceil(h * scale);
      canvas.getContext("2d")!.drawImage(pic, 0, 0, canvas.width, canvas.height);
      img.setAttribute("href", canvas.toDataURL("image/png"));
      img.removeAttribute("xlink:href");
    }),
  );
}

/**
 * Render frames to one PDF (one page per frame, each page the frame's size).
 * `elements` and `files` are the board's scene.
 */
export async function framesToPdf(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  frameIds: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]); // loaded on first use
  const live = elements.filter((e) => !e.isDeleted) as El[];
  const frames = frameIds
    .map((id) => live.find((e) => e.id === id))
    .filter((f): f is ExcalidrawFrameLikeElement => !!f && isFrame(f));
  if (!frames.length) throw new Error("No frame to export");

  let doc: JsPDF | null = null;
  const fonts = new Set<string>();
  const host = document.createElement("div"); // svg2pdf reads styles, so render attached but invisible
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
  document.body.appendChild(host);
  try {
    for (const [i, frame] of frames.entries()) {
      const els = elementsForFrame(live, frame);
      const svg = await exportToSvg({
        elements: els,
        appState: {
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
          exportWithDarkMode: false,
          frameRendering: { enabled: true, name: false, outline: false, clip: true },
        },
        files,
        exportPadding: 0,
        exportingFrame: frame,
        skipInliningFonts: true,
        reuseImages: false,
      });
      await rasterizeImages(svg);
      const wPx = parseFloat(svg.getAttribute("width") || "") || frame.width;
      const hPx = parseFloat(svg.getAttribute("height") || "") || frame.height;
      // Very large frames are scaled down to the maximum PDF page size
      const k = Math.min(PT_PER_PX, MAX_PT / wPx, MAX_PT / hPx);
      const w = wPx * k;
      const h = hPx * k;
      const orientation = w > h ? "landscape" : "portrait";
      if (!doc) doc = new jsPDF({ unit: "pt", format: [w, h], orientation, compress: true });
      else doc.addPage([w, h], orientation);
      await registerFonts(doc, els, fonts);
      host.replaceChildren(svg);
      await doc.svg(svg, { x: 0, y: 0, width: w, height: h });
      onProgress?.(i + 1, frames.length);
    }
  } finally {
    host.remove();
  }
  doc!.setProperties({ title: frames.length === 1 ? frameName(frames[0]) : `${frames.length} frames`, creator: "Tablo" });
  return doc!.output("blob");
}

export function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
