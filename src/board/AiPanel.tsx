import { useEffect, useReducer, useRef, useState } from "react";
import type { Api } from "./edit";
import { ask, scopeOf } from "../ai/assistant";
import { AiSettingsDialog, useAiSettings } from "../ui/AiSettingsDialog";

const QUICK: { label: string; prompt: string }[] = [
  { label: "Group into themes", prompt: "Group these items into a few meaningful themes (use the group operation, every item in one group) and give each theme a short name." },
  { label: "Summarise", prompt: "Summarise the content of these items in a few bullet points. Add the summary as a text block on the board." },
  { label: "What's missing?", prompt: "What is missing or unclear here? Answer briefly, and add up to 5 sticky notes with suggestions (color: orange)." },
  { label: "Turn into next steps", prompt: "Turn this into a short list of concrete next steps, added as sticky notes (color: green) in a group named “Next steps”." },
];

type Turn = { prompt: string; reply?: string; done?: string[]; error?: string };

export function AiPanel({ api, onClose }: { api: Api; onClose: () => void }) {
  const settings = useAiSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const abort = useRef<AbortController | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => api.onChange(() => rerender()), [api]); // keep the scope line current
  useEffect(() => () => abort.current?.abort(), []);

  const { els, selection } = scopeOf(api);
  const count = els.filter((e) => !(e.type === "text" && (e as { containerId?: string | null }).containerId)).length;
  const host = settings ? (() => { try { return new URL(settings.baseUrl).host; } catch { return settings.baseUrl; } })() : "";

  const run = async (p: string) => {
    if (!settings || !p.trim() || busy) return;
    setBusy(true);
    const turn: Turn = { prompt: p };
    setTurns((t) => [...t, turn]);
    abort.current = new AbortController();
    try {
      const { reply, done } = await ask(settings, api, p, abort.current.signal);
      turn.reply = reply;
      turn.done = done;
    } catch (e) {
      if ((e as Error).name !== "AbortError") turn.error = (e as Error).message;
    } finally {
      setTurns((t) => [...t]);
      setBusy(false);
      setPrompt("");
    }
  };

  return (
    <aside className="ai-panel" aria-label="AI assistant" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <strong>AI assistant</strong>
        <span className="row">
          <button className="ghost icon" onClick={() => setShowSettings(true)} title="AI connection settings" aria-label="AI settings">⚙</button>
          <button className="ghost icon" onClick={onClose} title="Close" aria-label="Close AI assistant">×</button>
        </span>
      </header>

      {!settings ? (
        <div className="ai-empty">
          <p className="small">Connect a model to get help with your boards: grouping notes into themes, summarising, drawing diagrams from a description…</p>
          <button className="primary" onClick={() => setShowSettings(true)}>Connect a model…</button>
        </div>
      ) : (
        <>
          <p className="muted small ai-scope">
            Working on {selection ? `${count} selected item${count > 1 ? "s" : ""}` : `the whole board (${count} items)`}. Sent to <b>{host}</b>.
          </p>
          <div className="tt-chips">
            {QUICK.map((q) => (
              <button key={q.label} className="chip" disabled={busy || count === 0} onClick={() => run(q.prompt)}>{q.label}</button>
            ))}
            <button
              className="chip"
              disabled={busy}
              title="Describe a diagram and insert it (flowchart, sequence…)"
              onClick={() => api.updateScene({ appState: { ...api.getAppState(), openDialog: { name: "ttd", tab: "text-to-diagram" } } })}
            >
              Draw a diagram…
            </button>
          </div>
          <div className="ai-log">
            {turns.map((t, i) => (
              <div key={i} className="ai-turn">
                <div className="ai-q">{t.prompt.length > 140 ? t.prompt.slice(0, 140) + "…" : t.prompt}</div>
                {t.error && <div className="notice small bad">{t.error}</div>}
                {t.reply && <div className="ai-a">{t.reply}</div>}
                {t.done && t.done.length > 0 && (
                  <ul className="ai-done small">
                    {t.done.map((d, j) => <li key={j}>✓ {d}</li>)}
                    <li className="muted">Undo with ⌘Z / Ctrl+Z</li>
                  </ul>
                )}
                {!t.reply && !t.error && !t.done && <div className="muted small">Thinking…</div>}
              </div>
            ))}
          </div>
          <form
            className="ai-input"
            onSubmit={(e) => {
              e.preventDefault();
              run(prompt);
            }}
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={selection ? "Ask something about the selection…" : "Ask something about this board…"}
              rows={2}
              aria-label="Ask the AI"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  run(prompt);
                }
              }}
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}>Stop</button>
            ) : (
              <button type="submit" className="primary" disabled={!prompt.trim()}>Ask</button>
            )}
          </form>
        </>
      )}
      {showSettings && <AiSettingsDialog onClose={() => setShowSettings(false)} />}
    </aside>
  );
}
