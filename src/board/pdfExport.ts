// Export Excalidraw frames to vector PDF, one page per frame.
//
// Each frame is rendered by Excalidraw to SVG (clipped to the frame), then drawn into the PDF
// by svg2pdf.js: lines stay sharp and text stays selectable text. Excalidraw's fonts are
// embedded from public/pdf-fonts (TrueType copies made by scripts/build-pdf-fonts.py).
//
// A PDF font only draws the characters it has, while the browser silently borrows missing ones
// from other fonts. So each character is given a font that has it: the text's own font, else
// Liberation Sans, else DejaVu Sans (Greek, maths, arrows...). A line with characters none of
// them has (Chinese, emoji...) is drawn by the browser and placed as a sharp image instead.
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

const FALLBACKS = ["Liberation", "DejaVuSans"];
/** Name of a font inside the PDF: unique, so it never collides with the PDF's built-in Helvetica etc. */
const pdfFontName = (file: string) => `Tablo-${file}`;

const fontData = new Map<string, Promise<string>>();
/**
 * Load a font file: returns it as base64 for jsPDF, and also adds it to the page under its PDF
 * name, because svg2pdf measures text with the browser (to place centred and mixed-font text).
 */
function loadFont(file: string): Promise<string> {
  if (!fontData.has(file)) {
    const p = fetch(new URL(`pdf-fonts/${file}.ttf`, document.baseURI)).then(async (r) => {
      if (!r.ok) throw new Error(`font ${file} not found`);
      const buffer = await r.arrayBuffer();
      try {
        const face = new FontFace(pdfFontName(file), buffer);
        document.fonts.add(await face.load());
      } catch {
        /* measuring falls back to another font: positions may be slightly off */
      }
      const bytes = new Uint8Array(buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    });
    p.catch(() => fontData.delete(file)); // try again next time
    fontData.set(file, p);
  }
  return fontData.get(file)!;
}

type Coverage = Map<string, Uint32Array>; // font file -> sorted [start, end, start, end...]
let coverage: Promise<Coverage> | null = null;
function loadCoverage(): Promise<Coverage> {
  coverage ??= fetch(new URL("pdf-fonts/coverage.json", document.baseURI))
    .then((r) => (r.ok ? r.json() : {}))
    .then((json: Record<string, [number, number][]>) => new Map(Object.entries(json).map(([k, v]) => [k, Uint32Array.from(v.flat())])))
    .catch(() => {
      coverage = null;
      return new Map();
    });
  return coverage;
}

function covers(cov: Coverage, file: string, cp: number) {
  const r = cov.get(file);
  if (!r) return false;
  let lo = 0, hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[mid * 2]) hi = mid - 1;
    else if (cp > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Embed a font in the PDF (once per document). */
function registerFont(doc: JsPDF, file: string, done: Map<string, Promise<boolean>>) {
  if (!done.has(file))
    done.set(
      file,
      loadFont(file).then(
        (data) => {
          doc.addFileToVFS(`${file}.ttf`, data);
          doc.addFont(`${file}.ttf`, pdfFontName(file), "normal");
          return true;
        },
        () => false,
      ),
    );
  return done.get(file)!;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// characters that take the font of their neighbours (spaces, joiners, variation selectors...)
const NEUTRAL = /^[\s\u200b-\u200f\u2028-\u202f\u2060\ufe00-\ufe0f]$/u;

/** Give every character of every text a font that has it (see the note at the top). */
async function prepareText(svg: SVGSVGElement, doc: JsPDF, done: Map<string, Promise<boolean>>) {
  const cov = await loadCoverage();
  for (const t of Array.from(svg.querySelectorAll("text"))) {
    const cssFamily = t.getAttribute("font-family") || "";
    const first = cssFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    const chain = [...new Set([FONT_FILES[first] ?? "Liberation", ...FALLBACKS])];
    const text = t.textContent ?? "";
    const runs: { file: string | null; text: string }[] = [];
    for (const ch of text) {
      const last = runs[runs.length - 1];
      const file = NEUTRAL.test(ch) && last ? last.file : (chain.find((f) => covers(cov, f, ch.codePointAt(0)!)) ?? null);
      if (last && last.file === file) last.text += ch;
      else runs.push({ file, text: ch });
    }
    const ok = runs.every((r) => r.file !== null) && (await Promise.all(runs.map((r) => registerFont(doc, r.file!, done)))).every(Boolean);
    if (!ok || !cov.size) {
      if (cov.size) await textToImage(t, cssFamily);
      else if (await registerFont(doc, chain[0], done)) t.setAttribute("font-family", pdfFontName(chain[0]));
      continue;
    }
    if (runs.length === 1) {
      t.setAttribute("font-family", pdfFontName(runs[0].file!));
      continue;
    }
    t.setAttribute("font-family", pdfFontName(runs[0].file!));
    t.setAttribute("xml:space", "preserve"); // keep the spaces where one font hands over to the next
    t.replaceChildren(
      ...runs.map((r) => {
        const span = document.createElementNS(SVG_NS, "tspan");
        span.setAttribute("font-family", pdfFontName(r.file!));
        span.setAttribute("xml:space", "preserve");
        span.textContent = r.text;
        return span;
      }),
    );
  }
}

/** Draw one line of text with the browser (which has every font) and put it in as an image. */
async function textToImage(t: SVGTextElement, cssFamily: string) {
  const text = t.textContent ?? "";
  const size = parseFloat(t.getAttribute("font-size") || "") || 16;
  const font = `${size}px ${cssFamily || "sans-serif"}`;
  try {
    await document.fonts.load(font, text);
  } catch {
    /* draw with whatever is available */
  }
  const anchor = t.getAttribute("text-anchor") || "start";
  const align: CanvasTextAlign = anchor === "middle" ? "center" : anchor === "end" ? "end" : "start";
  const rtl = t.getAttribute("direction") === "rtl";
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.direction = rtl ? "rtl" : "ltr";
  const m = ctx.measureText(text);
  const pad = Math.ceil(size * 0.1);
  const left = Math.ceil(m.actualBoundingBoxLeft) + pad;
  const width = left + Math.ceil(m.actualBoundingBoxRight) + pad;
  const ascent = Math.ceil(Math.max(m.actualBoundingBoxAscent, m.fontBoundingBoxAscent || 0)) + pad;
  const height = ascent + Math.ceil(Math.max(m.actualBoundingBoxDescent, m.fontBoundingBoxDescent || 0)) + pad;
  if (width <= 0 || height <= 0) return t.remove();
  const scale = 6; // ~ 450 dpi at 100 %
  const canvas = ctx.canvas;
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.textAlign = align;
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.fillStyle = t.getAttribute("fill") || "#000";
  ctx.fillText(text, left, ascent);
  const img = document.createElementNS(SVG_NS, "image");
  const x = parseFloat(t.getAttribute("x") || "0");
  const y = parseFloat(t.getAttribute("y") || "0");
  img.setAttribute("x", String(x - left));
  img.setAttribute("y", String(y - ascent));
  img.setAttribute("width", String(width));
  img.setAttribute("height", String(height));
  img.setAttribute("preserveAspectRatio", "none");
  img.setAttribute("href", canvas.toDataURL("image/png"));
  t.replaceWith(img);
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
  const fonts = new Map<string, Promise<boolean>>();
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
      await prepareText(svg, doc, fonts);
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
