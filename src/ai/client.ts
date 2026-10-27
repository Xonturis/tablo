// Minimal client for the OpenAI-compatible "chat completions" API, which most providers and
// local servers speak (OpenAI, Mistral, OpenRouter, Groq, Ollama, LM Studio, vLLM...).
// Settings live only in this browser (localStorage): never in the shared project document.

export type AiSettings = { baseUrl: string; apiKey: string; model: string };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const KEY = "tablo.ai";

export const PRESETS: { name: string; baseUrl: string; keyNeeded: boolean; note?: string }[] = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyNeeded: true },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyNeeded: true },
  { name: "OpenRouter (many models)", baseUrl: "https://openrouter.ai/api/v1", keyNeeded: true },
  { name: "Ollama (on this computer)", baseUrl: "http://localhost:11434/v1", keyNeeded: false, note: "Ollama must allow this site: see the README" },
  { name: "LM Studio (on this computer)", baseUrl: "http://localhost:1234/v1", keyNeeded: false },
];

export function loadAiSettings(): AiSettings | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    return s && s.baseUrl && s.model ? s : null;
  } catch {
    return null;
  }
}

export function saveAiSettings(s: AiSettings | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: settings last for this session only */
  }
  window.dispatchEvent(new Event("tablo-ai-settings"));
}

const endpoint = (base: string, path: string) => base.replace(/\/+$/, "") + path;

function headers(s: AiSettings): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
  return h;
}

export class AiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Fetch an API path and return the parsed JSON body, with readable errors. */
async function request(s: Pick<AiSettings, "baseUrl" | "apiKey">, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  let host = s.baseUrl;
  try {
    host = new URL(s.baseUrl).host;
  } catch {
    throw new AiError("The API URL is not a valid address.");
  }
  try {
    res = await fetch(endpoint(s.baseUrl, path), { ...init, headers: headers(s as AiSettings) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AiError(
      `Could not reach ${host}. Check the URL, your connection, and that the server allows requests from this site (CORS).`,
    );
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = body.slice(0, 300);
    try {
      const err = JSON.parse(body).error;
      msg = (typeof err === "string" ? err : err?.message) ?? msg;
    } catch {
      /* not JSON */
    }
    const what = res.status === 401 || res.status === 403 ? "The API key was refused" : `Error ${res.status}`;
    throw new AiError(`${what}: ${msg || res.statusText}`, res.status);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new AiError("Unexpected answer from the server (not JSON). Is this the API URL, usually ending in /v1?");
  }
}

/** One chat completion; returns the assistant's text. */
export async function chat(s: AiSettings, messages: ChatMessage[], opts: { temperature?: number; signal?: AbortSignal } = {}): Promise<string> {
  const data = (await request(s, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: s.model, messages, temperature: opts.temperature ?? 0.2, stream: false }),
    signal: opts.signal,
  })) as { choices?: { message?: { content?: unknown } }[] };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: { text?: string }) => c.text ?? "").join("");
  throw new AiError("Unexpected answer from the server (not an OpenAI-compatible chat completion).");
}

/** Quick check of a model: a tiny chat, timed. */
export async function testConnection(s: AiSettings): Promise<{ reply: string; seconds: number }> {
  const t = performance.now();
  try {
    const reply = await chat(s, [{ role: "user", content: "Reply with the single word: OK" }], { temperature: 0 });
    return { reply: reply.trim().slice(0, 80) || "(empty reply)", seconds: (performance.now() - t) / 1000 };
  } catch (e) {
    if (e instanceof AiError && (e.status === 404 || (e.status === 400 && /model/i.test(e.message))))
      throw new AiError(`The model “${s.model}” isn't available here. ${e.message}`, e.status);
    throw e;
  }
}

export type ModelInfo = {
  id: string;
  /** display name, when the provider gives one */
  name?: string;
  /** context window, in tokens */
  context?: number;
  free?: boolean;
  /** probably not a chat model (embeddings, audio, images...) */
  nonChat?: boolean;
};

const NON_CHAT = /embed|whisper|tts|dall-e|gpt-image|moderation|transcri|rerank|^babbage|^davinci|sora|-ocr|imagen/i;

/** The models this provider offers (GET /models). Works with OpenAI, Mistral, OpenRouter, Groq, Ollama, LM Studio... */
export async function listModels(s: Pick<AiSettings, "baseUrl" | "apiKey">): Promise<ModelInfo[]> {
  let data: unknown;
  try {
    data = await request(s, "/models");
  } catch (e) {
    if (e instanceof AiError && (e.status === 404 || e.status === 405))
      throw new AiError("This server doesn't list its models. Type the model name given by your provider.", e.status);
    throw e;
  }
  const d = data as { data?: unknown; models?: unknown };
  const raw = (Array.isArray(data) ? data : Array.isArray(d?.data) ? d.data : Array.isArray(d?.models) ? d.models : null) as
    | Record<string, unknown>[]
    | null;
  if (!raw) throw new AiError("Unexpected answer from the server: no model list.");
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const m of raw) {
    const id = String(m.id ?? m.model ?? m.name ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const pricing = m.pricing as { prompt?: string; completion?: string } | undefined;
    const caps = m.capabilities as { completion_chat?: boolean } | undefined;
    const context = Number(m.context_length ?? m.max_context_length ?? m.context_window ?? 0) || undefined;
    models.push({
      id,
      name: typeof m.name === "string" && m.name !== id ? m.name : undefined,
      context,
      free: pricing ? Number(pricing.prompt) === 0 && Number(pricing.completion) === 0 : undefined,
      nonChat: caps?.completion_chat === false || NON_CHAT.test(id),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1)) as T;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
