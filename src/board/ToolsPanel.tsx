// "Tablo tools": exact values for what Excalidraw only offers as presets, plus arrange tools.
// Ideas inspired by the Obsidian Excalidraw plugin by Zsolt Viczián (zsviczian) and its script
// library (Set Font Family, Set Dimensions, Fixed spacing, Box selected elements...).
// No code from the plugin is used.
import { useEffect, useReducer, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import {
  type Api,
  type El,
  FONTS,
  bounds,
  commit,
  fromSkeleton,
  moveBy,
  patchElements,
  selectedElements,
  selectedTexts,
  topLevel,
} from "./edit";

const SIZE_PRESETS = [12, 14, 16, 20, 24, 28, 36, 48, 64, 96];
const isLinear = (e: El) => e.type === "arrow" || e.type === "line" || e.type === "freedraw";

/** Common value of a property across elements, or null when mixed. */
function common<T>(els: readonly El[], get: (e: El) => T): T | null {
  if (!els.length) return null;
  const v = get(els[0]);
  return els.every((e) => get(e) === v) ? v : null;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Number input that applies on Enter or when leaving the field (not on every keystroke). */
function NumField(props: {
  label: string;
  value: number | null;
  onApply: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  title?: string;
}) {
  const shown = props.value === null ? "" : String(round(props.value, 2));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const apply = () => {
    const v = parseFloat(draft.replace(",", "."));
    if (!Number.isFinite(v) || draft === shown) return setDraft(shown);
    const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
    props.onApply(clamped);
  };
  return (
    <label className="tt-field" title={props.title}>
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        placeholder={props.value === null ? "mixed" : undefined}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep Excalidraw shortcuts out of the field
          if (e.key === "Enter") apply();
          if (e.key === "Escape") setDraft(shown);
        }}
        aria-label={props.label}
      />
      {props.suffix && <em>{props.suffix}</em>}
    </label>
  );
}

export function ToolsPanel({ api }: { api: Api }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [collapsed, setCollapsed] = useState(false);
  const [gap, setGap] = useState(20);
  const [padding, setPadding] = useState(20);

  // Follow selection and edits made with Excalidraw's own tools
  useEffect(() => {
    let raf = 0;
    const unsub = api.onChange(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(rerender);
    });
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [api]);

  const appState = api.getAppState();
  const sel = selectedElements(api);
  if (!sel.length || appState.editingTextElement || appState.newElement) return null;
  const texts = selectedTexts(api);
  const shapes = topLevel(sel);
  const single = shapes.length === 1 ? shapes[0] : null;
  const strokeTargets = sel.filter((e) => e.type !== "text");

  if (collapsed)
    return (
      <button className="tt-reopen" onClick={() => setCollapsed(false)} title="Show Tablo tools">
        ⚙ Tools
      </button>
    );

  const setText = (patch: Partial<ExcalidrawTextElement>) => patchElements(api, texts, () => patch);
  const resize = (targets: El[], patch: (e: El) => Record<string, number>) => {
    // Containers keep their text wrapped and centred: re-measure the bound text too
    const ids = new Set(targets.map((e) => e.id));
    const scene = api.getSceneElements();
    const bound = scene.filter((e) => e.type === "text" && (e as ExcalidrawTextElement).containerId && ids.has((e as ExcalidrawTextElement).containerId!));
    const geometry = new Map(targets.map((e) => [e.id, patch(e)]));
    patchElements(api, [...targets, ...bound], (e) => geometry.get(e.id) ?? {});
  };

  const tx = (e: El) => e as ExcalidrawTextElement;
  const fontSize = common(texts, (t) => tx(t).fontSize);
  const fontFamily = common(texts, (t) => tx(t).fontFamily);
  const lineHeight = common(texts, (t) => tx(t).lineHeight as number);

  // ---- arrange
  const arrange = (dir: "row" | "column") => {
    const items = [...shapes].sort((a, b) => (dir === "row" ? a.x - b.x : a.y - b.y));
    const scene = api.getSceneElements();
    let cursor = dir === "row" ? bounds([items[0]]).x : bounds([items[0]]).y;
    const changed: El[] = [];
    for (const el of items) {
      const b = bounds([el]);
      const dx = dir === "row" ? cursor - b.x : 0;
      const dy = dir === "column" ? cursor - b.y : 0;
      changed.push(...moveBy(scene, el, dx, dy));
      cursor += (dir === "row" ? b.width : b.height) + gap;
    }
    commit(api, changed);
  };
  const sameSize = (dim: "width" | "height") => {
    const targets = shapes.filter((e) => !isLinear(e) && e.type !== "text");
    const v = Math.max(...targets.map((e) => e[dim]));
    resize(targets, () => ({ [dim]: v }));
  };
  const boxAround = () => {
    const b = bounds(shapes);
    const [box] = fromSkeleton([
      {
        type: "rectangle",
        x: b.x - padding,
        y: b.y - padding,
        width: b.width + padding * 2,
        height: b.height + padding * 2,
        strokeColor: appState.currentItemStrokeColor,
        backgroundColor: "transparent",
        strokeWidth: appState.currentItemStrokeWidth,
        roughness: appState.currentItemRoughness,
        roundness: { type: 3 },
        frameId: common(shapes, (e) => e.frameId),
      },
    ]);
    // Insert the box just below the lowest selected element so it stays behind them
    const all = api.getSceneElementsIncludingDeleted() as El[];
    const first = all.findIndex((e) => shapes.some((s) => s.id === e.id));
    const elements = [...all.slice(0, first), box, ...all.slice(first)];
    api.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };

  return (
    <aside className="tools-panel" aria-label="Tablo tools" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <strong>Tablo tools</strong>
        <span className="muted small">{shapes.length} selected</span>
        <button className="ghost icon" onClick={() => setCollapsed(true)} title="Hide" aria-label="Hide Tablo tools">×</button>
      </header>

      {texts.length > 0 && (
        <section>
          <h3>Text</h3>
          <div className="tt-row">
            <NumField label="Size" value={fontSize} min={4} max={1000} onApply={(v) => setText({ fontSize: v })} suffix="px" />
            <button className="small" title="Smaller (10%)" onClick={() => patchElements(api, texts, (t) => ({ fontSize: Math.max(4, round((t as ExcalidrawTextElement).fontSize / 1.1)) }))}>−</button>
            <button className="small" title="Larger (10%)" onClick={() => patchElements(api, texts, (t) => ({ fontSize: round((t as ExcalidrawTextElement).fontSize * 1.1) }))}>+</button>
          </div>
          <div className="tt-chips">
            {SIZE_PRESETS.map((s) => (
              <button key={s} className={`chip ${fontSize === s ? "on" : ""}`} onClick={() => setText({ fontSize: s })}>{s}</button>
            ))}
          </div>
          <label className="tt-field wide">
            <span>Font</span>
            <select value={fontFamily ?? ""} onChange={(e) => setText({ fontFamily: Number(e.target.value) as never })} aria-label="Font">
              {fontFamily === null && <option value="">mixed</option>}
              {FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <div className="tt-row">
            <NumField label="Line height" value={lineHeight} step={0.05} min={0.8} max={3} onApply={(v) => setText({ lineHeight: v as never })} />
          </div>
          <button
            className="ghost small"
            title="New text will use this size and font"
            onClick={() =>
              api.updateScene({
                appState: {
                  ...appState,
                  ...(fontSize ? { currentItemFontSize: fontSize } : {}),
                  ...(fontFamily ? { currentItemFontFamily: fontFamily } : {}),
                },
              })
            }
          >
            Use for new text
          </button>
        </section>
      )}

      {strokeTargets.length > 0 && (
        <section>
          <h3>Stroke &amp; opacity</h3>
          <div className="tt-row">
            <NumField label="Stroke" value={common(strokeTargets, (e) => e.strokeWidth)} step={0.5} min={0} max={50} suffix="px"
              onApply={(v) => patchElements(api, strokeTargets, () => ({ strokeWidth: v }))} />
            <NumField label="Opacity" value={common(sel, (e) => e.opacity)} min={0} max={100} suffix="%"
              onApply={(v) => patchElements(api, sel, () => ({ opacity: Math.round(v) }))} />
          </div>
          <button
            className="ghost small"
            title="New shapes will use this stroke width and opacity"
            onClick={() => {
              const sw = common(strokeTargets, (e) => e.strokeWidth);
              const op = common(sel, (e) => e.opacity);
              api.updateScene({ appState: { ...appState, ...(sw !== null ? { currentItemStrokeWidth: sw } : {}), ...(op !== null ? { currentItemOpacity: op } : {}) } });
            }}
          >
            Use for new shapes
          </button>
        </section>
      )}

      {single && (
        <section>
          <h3>Position &amp; size</h3>
          <div className="tt-grid">
            <NumField label="X" value={single.x} onApply={(v) => commit(api, moveBy(api.getSceneElements(), single, v - single.x, 0))} />
            <NumField label="Y" value={single.y} onApply={(v) => commit(api, moveBy(api.getSceneElements(), single, 0, v - single.y))} />
            <NumField label="W" value={single.width} min={1} disabled={isLinear(single) || single.type === "text"}
              title={single.type === "text" ? "Text width follows its content: change the font size instead" : undefined}
              onApply={(v) => resize([single], () => ({ width: v }))} />
            <NumField label="H" value={single.height} min={1} disabled={isLinear(single) || single.type === "text"}
              onApply={(v) => resize([single], () => ({ height: v }))} />
            <NumField label="Angle" value={round((single.angle * 180) / Math.PI, 1)} suffix="°"
              onApply={(v) => patchElements(api, [single], () => ({ angle: (((v % 360) + 360) % 360) * Math.PI / 180 }))} />
          </div>
        </section>
      )}

      {shapes.length > 1 && (
        <section>
          <h3>Arrange</h3>
          <div className="tt-row">
            <NumField label="Gap" value={gap} min={0} onApply={setGap} suffix="px" />
            <button className="small" onClick={() => arrange("row")} title="Line up left to right with this exact gap">Row</button>
            <button className="small" onClick={() => arrange("column")} title="Stack top to bottom with this exact gap">Column</button>
          </div>
          <div className="tt-row">
            <button className="small" onClick={() => sameSize("width")}>Same width</button>
            <button className="small" onClick={() => sameSize("height")}>Same height</button>
          </div>
        </section>
      )}

      <section>
        <h3>Box</h3>
        <div className="tt-row">
          <NumField label="Padding" value={padding} min={0} onApply={setPadding} suffix="px" />
          <button className="small" onClick={boxAround} title="Draw a rectangle around the selection">Box around</button>
        </div>
      </section>
      <footer className="muted small">Ideas from the Obsidian Excalidraw plugin.</footer>
    </aside>
  );
}
