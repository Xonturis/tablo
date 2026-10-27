// Helpers to change the scene from outside Excalidraw's own UI (properties panel, AI).
// Every change goes through updateScene as one undoable step, and through BoardCanvas's
// onChange it is synced to collaborators like any other edit.
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";

export type Api = ExcalidrawImperativeAPI;
export type El = ExcalidrawElement;
type AnyPatch = Record<string, unknown>;

const BOUND_TEXT_PADDING = 5;

// Font stacks exactly as Excalidraw uses them (font family id -> CSS font-family)
const FONT_STACKS: Record<number, string> = {
  1: "Virgil, Segoe UI Emoji", 2: "Helvetica, Segoe UI Emoji", 3: "Cascadia, Segoe UI Emoji",
  5: "Excalifont, Xiaolai, Segoe UI Emoji", 6: "Nunito, Segoe UI Emoji", 7: "Lilita One, Segoe UI Emoji",
  8: "Comic Shanns, Segoe UI Emoji", 9: "Liberation Sans, Segoe UI Emoji",
};
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, fontSize: number, fontFamily: number) {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `${fontSize}px ${FONT_STACKS[fontFamily] ?? FONT_STACKS[5]}`;
  return measureCtx.measureText(text).width;
}

/** Width available to text inside a container (same rules as Excalidraw). */
function containerMaxWidth(c: El) {
  const w = c.width;
  if (c.type === "ellipse") return Math.round((w / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
  if (c.type === "diamond") return Math.round(w / 2) - BOUND_TEXT_PADDING * 2;
  return w - BOUND_TEXT_PADDING * 2;
}

function wrapLines(text: string, maxWidth: number, fontSize: number, fontFamily: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const candidate = line + w;
      if (!line || textWidth(candidate.trimEnd(), fontSize, fontFamily) <= maxWidth) {
        line = candidate;
        continue;
      }
      out.push(line.trimEnd());
      line = w.trimStart();
      // a single word longer than the line: break it by characters
      while (line && textWidth(line, fontSize, fontFamily) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), fontSize, fontFamily) > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Measure (and wrap, inside a container) a text element after its content or font changed. */
export function layoutText(t: ExcalidrawTextElement, container?: El) {
  const lh = (t.lineHeight as number) || 1.25;
  const source = t.originalText ?? t.text;
  const lines = container
    ? wrapLines(source, Math.max(1, containerMaxWidth(container)), t.fontSize, t.fontFamily)
    : t.autoResize === false
      ? wrapLines(source, Math.max(1, t.width), t.fontSize, t.fontFamily)
      : source.split("\n");
  const width = Math.max(1, ...lines.map((l) => textWidth(l, t.fontSize, t.fontFamily)));
  return { text: lines.join("\n"), width: t.autoResize === false && !container ? t.width : width, height: lines.length * t.fontSize * lh };
}

/** Height a container needs to hold a text of this height. */
function containerHeightFor(c: El, textHeight: number) {
  const h = textHeight + BOUND_TEXT_PADDING * 2;
  if (c.type === "ellipse") return Math.round(h / Math.SQRT1_2);
  if (c.type === "diamond") return h * 2;
  return h;
}

export const FONTS: { id: number; name: string }[] = [
  { id: 5, name: "Excalifont (hand-drawn)" },
  { id: 1, name: "Virgil (hand-drawn, classic)" },
  { id: 8, name: "Comic Shanns" },
  { id: 6, name: "Nunito" },
  { id: 2, name: "Helvetica" },
  { id: 9, name: "Liberation Sans" },
  { id: 7, name: "Lilita One" },
  { id: 3, name: "Cascadia (code)" },
];

export const randomElementId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(36).padStart(2, "0")).join("");

export function selectedElements(api: Api): El[] {
  const ids = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter((e) => ids[e.id]);
}

/** Selected elements plus the text bound inside selected shapes (what users mean by "the text"). */
export function selectedTexts(api: Api): ExcalidrawTextElement[] {
  const sel = selectedElements(api);
  const ids = new Set(sel.map((e) => e.id));
  return (api.getSceneElements() as readonly El[]).filter(
    (e): e is ExcalidrawTextElement =>
      e.type === "text" && (ids.has(e.id) || (!!(e as ExcalidrawTextElement).containerId && ids.has((e as ExcalidrawTextElement).containerId!))),
  );
}

/** Replace elements (by id) and add new ones, as a single undoable step. */
export function commit(api: Api, changed: El[], added: El[] = [], select?: string[]) {
  const byId = new Map(changed.map((e) => [e.id, e]));
  const elements = [...api.getSceneElementsIncludingDeleted().map((e) => byId.get(e.id) ?? e), ...added];
  api.updateScene({
    elements,
    ...(select ? { appState: { ...api.getAppState(), selectedElementIds: Object.fromEntries(select.map((id) => [id, true as const])) } } : {}),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** Apply a patch to elements; text changes re-measure the text and grow its container if needed. */
export function patchElements(api: Api, targets: El[], patch: (el: El) => AnyPatch | null) {
  const scene = api.getSceneElements();
  const byId = new Map(scene.map((e) => [e.id, e]));
  const changed = new Map<string, El>();
  for (const el of targets) {
    const p = patch(el);
    if (p) changed.set(el.id, newElementWith(el as never, p as never) as El);
  }
  // Re-measure changed texts (font size, family, line height...)
  for (const [id, el] of changed) {
    if (el.type !== "text") continue;
    const text = el as ExcalidrawTextElement;
    const container = text.containerId ? changed.get(text.containerId) ?? byId.get(text.containerId) : undefined;
    let t = newElementWith(text, layoutText(text, container));
    if (container) {
      let c = container;
      const needH = containerHeightFor(c, t.height);
      if (c.height < needH) {
        c = newElementWith(c as never, { height: needH } as never) as El;
        changed.set(c.id, c);
      }
      t = newElementWith(t, placeInContainer(t, c));
    }
    changed.set(id, t);
  }
  commit(api, [...changed.values()]);
}

function placeInContainer(t: ExcalidrawTextElement, c: El) {
  const innerW = c.width - BOUND_TEXT_PADDING * 2;
  const x =
    t.textAlign === "left" ? c.x + BOUND_TEXT_PADDING
    : t.textAlign === "right" ? c.x + c.width - BOUND_TEXT_PADDING - t.width
    : c.x + BOUND_TEXT_PADDING + (innerW - t.width) / 2;
  const y =
    t.verticalAlign === "top" ? c.y + BOUND_TEXT_PADDING
    : t.verticalAlign === "bottom" ? c.y + c.height - BOUND_TEXT_PADDING - t.height
    : c.y + (c.height - t.height) / 2;
  return { x, y };
}

/** Move elements by (dx, dy), carrying their bound text along. */
export function moveBy(scene: readonly El[], el: El, dx: number, dy: number): El[] {
  const out = [newElementWith(el as never, { x: el.x + dx, y: el.y + dy } as never) as El];
  for (const b of el.boundElements ?? []) {
    if (b.type !== "text") continue;
    const t = scene.find((e) => e.id === b.id);
    if (t) out.push(newElementWith(t as never, { x: t.x + dx, y: t.y + dy } as never) as El);
  }
  return out;
}

export function bounds(els: readonly El[]) {
  const [x1, y1, x2, y2] = getCommonBounds(els as never);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Top-level elements of a selection: drop text that lives inside a selected container. */
export function topLevel(els: readonly El[]): El[] {
  const ids = new Set(els.map((e) => e.id));
  return els.filter((e) => !(e.type === "text" && (e as ExcalidrawTextElement).containerId && ids.has((e as ExcalidrawTextElement).containerId!)));
}

/** Build new elements from Excalidraw's "skeleton" format (handles labels, wrapping, defaults). */
export function fromSkeleton(skeleton: unknown[]): El[] {
  return convertToExcalidrawElements(skeleton as never, { regenerateIds: false }) as unknown as El[];
}

/** A frame around the given elements; returns the frame and the elements re-parented into it. */
export function frameAround(scene: readonly El[], els: readonly El[], name: string, padding = 40): { frame: El; children: El[] } {
  const b = bounds(els);
  const [frame] = restoreElements(
    [{ type: "frame", id: randomElementId(), x: b.x - padding, y: b.y - padding, width: b.width + padding * 2, height: b.height + padding * 2, name } as never],
    null,
  ) as El[];
  const ids = new Set(els.map((e) => e.id));
  const withText = scene.filter((e) => ids.has(e.id) || (e.type === "text" && (e as ExcalidrawTextElement).containerId && ids.has((e as ExcalidrawTextElement).containerId!)));
  const children = withText.map((e) => newElementWith(e as never, { frameId: frame.id } as never) as El);
  return { frame, children };
}
