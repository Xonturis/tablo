// The AI assistant: describes the selection (or board) to the model, asks for a small JSON
// "plan" of operations, and applies it as one undoable step. The model never deals with
// coordinates: Tablo lays out what it creates.
import { newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { type Api, type El, bounds, commit, frameAround, fromSkeleton, layoutText, moveBy, randomElementId, topLevel } from "../board/edit";
import { type AiSettings, type ChatMessage, chat, extractJson } from "./client";

export const NOTE_COLORS: Record<string, string> = {
  yellow: "#fff9b1", orange: "#ffd8a8", red: "#ffc9c9", pink: "#fcc2d7", purple: "#e5dbff",
  blue: "#a5d8ff", cyan: "#99e9f2", green: "#b2f2bb", lime: "#d8f5a2", gray: "#e9ecef", white: "#ffffff",
};
const colorOf = (c: unknown) =>
  typeof c === "string" ? (NOTE_COLORS[c.toLowerCase()] ?? (/^#[0-9a-f]{3,8}$/i.test(c) ? c : null)) : null;

type Item = { id: string; kind: string; text?: string; color?: string; frame?: string; from?: string; to?: string; x: number; y: number; w: number; h: number };

/** The elements the assistant works on: the selection, or the whole board if nothing is selected. */
export function scopeOf(api: Api): { els: El[]; selection: boolean } {
  const ids = api.getAppState().selectedElementIds;
  const scene = api.getSceneElements() as El[];
  const sel = scene.filter((e) => ids[e.id]);
  return sel.length ? { els: sel, selection: true } : { els: scene as El[], selection: false };
}

export function describe(api: Api, els: El[]): Item[] {
  const scene = api.getSceneElements() as El[];
  const byId = new Map(scene.map((e) => [e.id, e]));
  const textOf = (e: El): string | undefined => {
    if (e.type === "text") return (e as ExcalidrawTextElement).originalText || (e as ExcalidrawTextElement).text;
    const b = e.boundElements?.find((x) => x.type === "text");
    const t = b && byId.get(b.id);
    return t ? (t as ExcalidrawTextElement).originalText : e.type === "frame" ? (e as { name?: string }).name ?? undefined : undefined;
  };
  return topLevel(els)
    .slice(0, 400)
    .map((e) => {
      const it: Item = { id: e.id, kind: kindOf(e), x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) };
      const t = textOf(e);
      if (t) it.text = t.length > 400 ? t.slice(0, 400) + "…" : t;
      if (e.backgroundColor && e.backgroundColor !== "transparent") it.color = e.backgroundColor;
      if (e.frameId) it.frame = (byId.get(e.frameId) as { name?: string } | undefined)?.name ?? e.frameId;
      if (e.type === "arrow") {
        const a = e as unknown as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };
        if (a.startBinding) it.from = a.startBinding.elementId;
        if (a.endBinding) it.to = a.endBinding.elementId;
      }
      return it;
    });
}

function kindOf(e: El): string {
  if (e.type === "rectangle" && e.backgroundColor !== "transparent" && e.boundElements?.some((b) => b.type === "text")) return "note";
  return e.type;
}

const SYSTEM = `You are an assistant inside Tablo, a whiteboard app (Excalidraw). The user selected some items on the board; they are given as JSON (id, kind, text, color, frame, position/size; arrows have from/to ids).

Answer with ONE JSON object and nothing else:
{
  "reply": "short answer or explanation for the user (plain text, same language as the user)",
  "actions": [ ...zero or more operations... ]
}

Available operations (use only these; ids must be ids from the input, or ids you gave to new notes):
- {"op":"group","groups":[{"name":"Theme name","ids":["id1","id2"]}]}  -> arranges existing items into named frames (use it to cluster/categorise; every item should be in exactly one group)
- {"op":"add_notes","group":"optional frame name","notes":[{"id":"n1","text":"…","color":"yellow"}]}  -> creates sticky notes next to the selection (colors: yellow, orange, red, pink, purple, blue, cyan, green, lime, gray, white)
- {"op":"add_text","text":"…"}  -> adds a text block below the selection (summaries, conclusions)
- {"op":"connect","from":"id","to":"id","label":"optional"}  -> draws an arrow
- {"op":"update_text","id":"id","text":"new text"}  -> rewrites the text of an item
- {"op":"set_color","ids":["id1"],"color":"green"}  -> recolors items

Rules: do not invent ids; keep texts concise; if the user only asks a question, answer in "reply" with no actions. Never delete anything.`;

export type Plan = { reply?: string; actions?: Record<string, unknown>[] };

export async function ask(settings: AiSettings, api: Api, prompt: string, signal?: AbortSignal) {
  const { els, selection } = scopeOf(api);
  const items = describe(api, els);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `${selection ? "Selected items" : "All items on the board (nothing is selected)"}:\n${JSON.stringify(items)}\n\nRequest: ${prompt}`,
    },
  ];
  const raw = await chat(settings, messages, { signal });
  const plan = extractJson<Plan>(raw) ?? { reply: raw.trim(), actions: [] };
  const done = applyPlan(api, els, plan);
  return { reply: plan.reply ?? "", done };
}

/** Apply the model's operations. Returns a human-readable list of what changed. */
export function applyPlan(api: Api, scopeEls: El[], plan: Plan): string[] {
  const scene = api.getSceneElements() as El[];
  const byId = new Map(scene.map((e) => [e.id, e]));
  const changed = new Map<string, El>();
  const added: El[] = [];
  const done: string[] = [];
  const newIds = new Map<string, string>(); // model ids for new notes -> real ids
  const cur = (id: string) => changed.get(id) ?? added.find((e) => e.id === id) ?? byId.get(id);
  const put = (els: El[]) => els.forEach((e) => (added.some((a) => a.id === e.id) ? added.splice(added.findIndex((a) => a.id === e.id), 1, e) : changed.set(e.id, e)));
  const resolve = (id: unknown) => (typeof id === "string" ? newIds.get(id) ?? (byId.has(id) || added.some((a) => a.id === id) ? id : null) : null);

  const area = scopeEls.length ? bounds(topLevel(scopeEls)) : { x: 0, y: 0, width: 0, height: 0 };
  let nextX = area.x + area.width + 160; // new things go to the right of the selection
  const below = { x: area.x, y: area.y + area.height + 80 };

  const makeNotes = (notes: Record<string, unknown>[]) => {
    const W = 220, H = 140, G = 24;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(notes.length))));
    const els: El[] = [];
    notes.forEach((n, i) => {
      const id = randomElementId();
      if (typeof n.id === "string") newIds.set(n.id, id);
      els.push(
        ...fromSkeleton([
          {
            type: "rectangle", id, x: nextX + (i % cols) * (W + G), y: area.y + Math.floor(i / cols) * (H + G), width: W, height: H,
            backgroundColor: colorOf(n.color) ?? NOTE_COLORS.yellow, fillStyle: "solid", strokeColor: "transparent", roughness: 0,
            roundness: { type: 3 }, label: { text: String(n.text ?? "").slice(0, 600), fontSize: 18 },
          },
        ]),
      );
    });
    nextX += cols * (W + G) + 120;
    return els;
  };

  for (const a of plan.actions ?? []) {
    try {
      switch (a.op) {
        case "group": {
          const groups = (a.groups as { name?: string; ids?: unknown[] }[] | undefined) ?? [];
          let x = nextX;
          for (const g of groups) {
            const members = (g.ids ?? []).map(resolve).filter((id): id is string => !!id).map((id) => cur(id)!).filter(Boolean);
            if (!members.length) continue;
            // stack the members in a column, then frame them
            let y = area.y;
            const moved: El[] = [];
            let width = 0;
            for (const m of topLevel(members)) {
              const b = bounds([m]);
              const parts = moveBy([...scene, ...added], m, x - b.x, y - b.y);
              put(parts);
              moved.push(parts[0]);
              y += b.height + 20;
              width = Math.max(width, b.width);
            }
            const live = [...scene.map((e) => changed.get(e.id) ?? e), ...added];
            const { frame, children } = frameAround(live, moved, String(g.name ?? "Group"));
            put(children);
            added.push(frame);
            x += width + 140;
            done.push(`Grouped ${moved.length} item(s) into “${g.name ?? "Group"}”`);
          }
          nextX = x;
          break;
        }
        case "add_notes": {
          const notes = (a.notes as Record<string, unknown>[] | undefined) ?? [];
          if (!notes.length) break;
          const els = makeNotes(notes);
          added.push(...els);
          if (typeof a.group === "string" && a.group) {
            const rects = els.filter((e) => e.type === "rectangle");
            const { frame, children } = frameAround([...scene, ...added], rects, a.group);
            put(children);
            added.push(frame);
          }
          done.push(`Added ${notes.length} note(s)${a.group ? ` in “${a.group}”` : ""}`);
          break;
        }
        case "add_text": {
          const text = String(a.text ?? "").trim();
          if (!text) break;
          added.push(...fromSkeleton([{ type: "text", x: below.x, y: below.y, text, fontSize: 20 }]));
          below.y += 40 + text.split("\n").length * 26;
          done.push("Added a text block");
          break;
        }
        case "connect": {
          const from = resolve(a.from), to = resolve(a.to);
          if (!from || !to || from === to) break;
          const arrow = arrowBetween(cur(from)!, cur(to)!, typeof a.label === "string" ? a.label : undefined);
          added.push(...arrow.els);
          put([cur(from)!, cur(to)!].map((t) => newElementWith(t as never, { boundElements: [...(t.boundElements ?? []), { id: arrow.id, type: "arrow" }] } as never) as El));
          done.push("Connected two items");
          break;
        }
        case "update_text": {
          const id = resolve(a.id);
          if (!id || typeof a.text !== "string") break;
          const el = cur(id)!;
          const textId = el.type === "text" ? el.id : el.boundElements?.find((b) => b.type === "text")?.id;
          const t = textId && cur(textId);
          if (!t) break;
          const container = (t as ExcalidrawTextElement).containerId ? cur((t as ExcalidrawTextElement).containerId!) : undefined;
          const updated = newElementWith(t as never, { text: a.text, originalText: a.text } as never) as ExcalidrawTextElement;
          put([newElementWith(updated, layoutText(updated, container)) as El]);
          done.push("Rewrote a text");
          break;
        }
        case "set_color": {
          const color = colorOf(a.color);
          const ids = ((a.ids as unknown[]) ?? []).map(resolve).filter((id): id is string => !!id);
          if (!color || !ids.length) break;
          put(ids.map((id) => cur(id)!).filter((e) => e.type !== "text" && e.type !== "arrow").map((e) => newElementWith(e as never, { backgroundColor: color, fillStyle: "solid" } as never) as El));
          done.push(`Recolored ${ids.length} item(s)`);
          break;
        }
      }
    } catch (e) {
      console.warn("AI action skipped", a, e);
    }
  }
  if (changed.size || added.length) {
    const selectIds = added.filter((e) => e.type !== "text" || !(e as ExcalidrawTextElement).containerId).map((e) => e.id);
    commit(api, [...changed.values()], added, selectIds.length ? selectIds : undefined);
    // Bring the result into view (new or moved things often land outside the screen)
    const shown = [...added, ...changed.values()].filter((e) => e.type !== "text");
    if (shown.length) setTimeout(() => api.scrollToContent(shown as never, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true }), 50);
  }
  return done;
}

function arrowBetween(a: El, b: El, label?: string) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const edge = (el: El, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const t = Math.min(dx ? el.width / 2 / Math.abs(dx) : Infinity, dy ? el.height / 2 / Math.abs(dy) : Infinity, 1);
    return { x: from.x + dx * t, y: from.y + dy * t };
  };
  const s = edge(a, ca, cb), e = edge(b, cb, ca);
  const id = randomElementId();
  const els = fromSkeleton([
    {
      type: "arrow", id, x: s.x, y: s.y, width: Math.abs(e.x - s.x), height: Math.abs(e.y - s.y),
      points: [[0, 0], [e.x - s.x, e.y - s.y]], endArrowhead: "arrow", ...(label ? { label: { text: label, fontSize: 16 } } : {}),
    },
  ]).map((el) =>
    el.id === id
      ? (newElementWith(el as never, {
          startBinding: { elementId: a.id, focus: 0, gap: 4 },
          endBinding: { elementId: b.id, focus: 0, gap: 4 },
        } as never) as El)
      : el,
  );
  return { id, els };
}

// ---- text to diagram (Excalidraw's own dialog, with the user's model) ----------------------

const MERMAID_SYSTEM = `Convert the user's description into a Mermaid diagram.
Output ONLY valid Mermaid code: no explanation, no Markdown fences.
Prefer "flowchart TD" (or LR), "sequenceDiagram" or "classDiagram" depending on the request.
Keep labels short; write them in the user's language. Quote labels that contain special characters.`;

export async function textToMermaid(settings: AiSettings, description: string): Promise<string> {
  const raw = await chat(settings, [
    { role: "system", content: MERMAID_SYSTEM },
    { role: "user", content: description },
  ]);
  const fenced = raw.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}
