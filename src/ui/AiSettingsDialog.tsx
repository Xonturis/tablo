import { useEffect, useState } from "react";
import { type AiSettings, type ModelInfo, PRESETS, listModels, loadAiSettings, saveAiSettings, testConnection } from "../ai/client";

export function useAiSettings(): AiSettings | null {
  const [s, setS] = useState(loadAiSettings);
  useEffect(() => {
    const on = () => setS(loadAiSettings());
    window.addEventListener("tablo-ai-settings", on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener("tablo-ai-settings", on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return s;
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const initial = loadAiSettings();
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"models" | "test" | null>(null);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const preset = PRESETS.find((p) => p.baseUrl === baseUrl.replace(/\/+$/, ""));
  const current = (): AiSettings => ({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
  const urlOk = /^https?:\/\/.+/.test(baseUrl.trim());
  const valid = urlOk && model.trim().length > 0;

  // a different server or key: the model list no longer applies
  useEffect(() => {
    setModels(null);
    setStatus(null);
  }, [baseUrl, apiKey]);

  /** Check the URL and key by asking for the model list (no model needed). */
  const loadModels = async (quiet = false) => {
    setBusy("models");
    if (!quiet) setStatus(null);
    try {
      const list = await listModels(current());
      setModels(list);
      setListOpen(true);
      const chat = list.filter((m) => !m.nonChat).length;
      if (!quiet)
        setStatus({
          ok: true,
          text: `Connected to ${new URL(baseUrl.trim()).host}: ${chat} model${chat === 1 ? "" : "s"} available${list.length > chat ? ` (+${list.length - chat} not for chat)` : ""}.${model.trim() ? "" : " Pick one below."}`,
        });
    } catch (e) {
      setModels(null);
      if (!quiet) setStatus({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // already set up: fetch the list quietly so it is there to browse
  useEffect(() => {
    if (initial) void loadModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const test = async () => {
    setBusy("test");
    setStatus(null);
    try {
      const { reply, seconds } = await testConnection(current());
      setStatus({ ok: true, text: `“${model.trim()}” works. It replied “${reply}” in ${seconds.toFixed(1)} s.` });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const q = model.trim().toLowerCase();
  const exact = models?.some((m) => m.id === model.trim());
  const usable = models?.filter((m) => showAll || !m.nonChat) ?? [];
  const shown = exact || !q ? usable : usable.filter((m) => m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
  const unknownModel = models && models.length > 0 && q && !exact;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal ai-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          saveAiSettings(current());
          onClose();
        }}
      >
        <h2 id="ai-title">AI connection</h2>
        <p className="muted small">
          Any service that speaks the OpenAI chat API works: OpenAI, Mistral, OpenRouter, or a model running on your computer
          (Ollama, LM Studio). These settings stay in this browser only and are never shared with collaborators.
        </p>
        <label className="field">
          <span>Provider</span>
          <select
            value={preset?.baseUrl ?? "custom"}
            onChange={(e) => e.target.value !== "custom" && setBaseUrl(e.target.value)}
            aria-label="Provider"
          >
            {PRESETS.map((p) => <option key={p.baseUrl} value={p.baseUrl}>{p.name}</option>)}
            <option value="custom">Other (custom URL)</option>
          </select>
        </label>
        <label className="field">
          <span>API URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" aria-label="API URL" />
        </label>
        <label className="field">
          <span>API key {preset && !preset.keyNeeded && <em className="muted">(not needed)</em>}</span>
          <span className="row">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" aria-label="API key" />
            <button type="button" className="nowrap" onClick={() => loadModels()} disabled={!urlOk || busy !== null}>
              {busy === "models" ? "Checking…" : "Check & list models"}
            </button>
          </span>
        </label>
        <div className="field">
          <label htmlFor="ai-model">Model</label>
          <input
            id="ai-model"
            value={model}
            onChange={(e) => { setModel(e.target.value); setListOpen(true); }}
            onFocus={() => setListOpen(true)}
            placeholder={models ? "search or pick a model below" : "the model name from your provider"}
            aria-label="Model"
            autoComplete="off"
          />
          {models && listOpen && (
            <div className="model-picker">
              <ul role="listbox" aria-label="Available models">
                {shown.map((m) => (
                  <li key={m.id} role="option" aria-selected={m.id === model.trim()}>
                    <button type="button" onClick={() => { setModel(m.id); setListOpen(false); setStatus(null); }}>
                      <span className="model-id">{m.id}</span>
                      <span className="muted">
                        {[m.free ? "free" : "", m.context ? `${tokens(m.context)} tokens` : "", m.nonChat ? "not for chat" : ""].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
                {!shown.length && <li className="muted small empty">No model matches “{model.trim()}”.</li>}
              </ul>
              <div className="model-picker-foot muted small">
                <span>{shown.length} of {usable.length} models</span>
                {models.some((m) => m.nonChat) && (
                  <label><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show embeddings, audio…</label>
                )}
                <button type="button" className="link small" onClick={() => setListOpen(false)}>Hide list</button>
              </div>
            </div>
          )}
          {models && !listOpen && (
            <button type="button" className="link small model-browse" onClick={() => setListOpen(true)}>Browse the {usable.length} models</button>
          )}
          {unknownModel && <span className="small warn">This name is not in the provider's list.</span>}
        </div>
        {preset?.note && <p className="muted small">{preset.note}</p>}
        {status && <div className={`notice small ${status.ok ? "ok" : "bad"}`} role="status">{status.text}</div>}
        <div className="modal-actions">
          <span className="row">
            {initial && (
              <button type="button" className="ghost small" onClick={() => { saveAiSettings(null); onClose(); }}>
                Disconnect
              </button>
            )}
          </span>
          <span className="row">
            <button type="button" onClick={test} disabled={!valid || busy !== null}>{busy === "test" ? "Testing…" : "Test model"}</button>
            <button type="submit" className="primary" disabled={!valid}>Save</button>
          </span>
        </div>
      </form>
    </div>
  );
}
