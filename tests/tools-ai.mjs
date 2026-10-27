// Tests the "Tablo tools" panel and the AI assistant (against a stand-in OpenAI-compatible server).
//
//   npm run test:tools        (uses your installed Google Chrome, or set CHROMIUM_PATH)
import { build } from "vite";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-e2e");
const FIXTURE = join(root, "tests/fixtures/sample.excalidraw");
const HTTP_PORT = 4174, AI_PORT = 4175;
const URL = `http://127.0.0.1:${HTTP_PORT}/`;

await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } });

// ---- stand-in AI server (OpenAI chat completions API)
const { default: http } = await import("node:http");
const log = [];
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
const reply = (res, content) => send(res, 200, { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
const aiServer = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" }); return res.end(); }
  if (req.url === "/log") return send(res, 200, log);
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const authed = req.headers.authorization === "Bearer test-key";
    if (req.method === "GET" && req.url.endsWith("/models")) {
      if (!authed) return send(res, 401, { error: { message: "Incorrect API key provided" } });
      return send(res, 200, { object: "list", data: [
        { id: "mock-model", name: "Mock: model", context_length: 128000, pricing: { prompt: "0", completion: "0" } },
        { id: "other/large-model", context_length: 32768, pricing: { prompt: "0.000002", completion: "0.000006" } },
        { id: "mock-mini" },
        { id: "text-embedding-3-small" },
      ] });
    }
    if (!req.url.endsWith("/chat/completions")) return send(res, 404, { error: { message: "not found" } });
    if (!authed) return send(res, 401, { error: { message: "Incorrect API key provided" } });
    const b = JSON.parse(body);
    if (!["mock-model", "mock-mini", "other/large-model"].includes(b.model)) return send(res, 404, { error: { message: `The model \`${b.model}\` does not exist`, code: "model_not_found" } }); const sys = b.messages[0].content; const user = b.messages[b.messages.length - 1].content;
    log.push({ model: b.model, sys: sys.slice(0, 60), user: user.slice(0, 200) });
    if (/single word: OK/.test(user)) return reply(res, "OK");
    if (/Mermaid diagram/.test(sys)) return reply(res, "```mermaid\nflowchart LR\n  U[Utilisateur] --> D[Appareil]\n  D --> C[(Cloud)]\n```");
    const items = JSON.parse(user.slice(user.indexOf("["), user.indexOf("\n\nRequest:")));
    const ids = items.filter((i) => i.kind === "note" || i.kind === "rectangle" || i.kind === "text").map((i) => i.id);
    if (/Group these items/.test(user)) {
      const half = Math.ceil(ids.length / 2);
      return reply(res, "Voici deux thèmes :\n```json\n" + JSON.stringify({ reply: "J'ai regroupé les notes en deux thèmes.", actions: [{ op: "group", groups: [{ name: "Thème A", ids: ids.slice(0, half) }, { name: "Thème B", ids: ids.slice(half) }] }] }) + "\n```");
    }
    return reply(res, JSON.stringify({ reply: "Done.", actions: [
      { op: "add_notes", group: "Idées", notes: [{ id: "n1", text: "Première idée", color: "green" }, { id: "n2", text: "Deuxième idée", color: "blue" }] },
      { op: "connect", from: "n1", to: "n2", label: "mène à" },
      { op: "add_text", text: "Résumé : deux idées." },
    ] }));
  });
});
await new Promise((r) => aiServer.listen(AI_PORT, "127.0.0.1", r));

// ---- static server for the build
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const site = createServer(async (req, res) => {
  let path = decodeURIComponent(new globalThis.URL(req.url, URL).pathname);
  if (path.endsWith("/")) path += "index.html";
  try {
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(await readFile(join(outDir, path)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => site.listen(HTTP_PORT, "127.0.0.1", r));

let fails = 0;
const check = (l, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${l} ${x}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome" }),
  env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
});
try {
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const scene = async () => { const [d] = await Promise.all([p.waitForEvent("download"), p.click("button:has-text('Export board')")]); return JSON.parse(readFileSync(await d.path(), "utf8")).elements.filter((e) => !e.isDeleted); };
  const focusCanvas = () => p.mouse.click(1000, 840);
  // Draw away from Excalidraw's style panel (left) and Tablo's panels (right)
  const draw = async (k, x1, y1, x2, y2) => { await focusCanvas(); await p.keyboard.press(k); await p.mouse.move(x1, y1); await p.mouse.down(); await p.mouse.move(x2, y2, { steps: 5 }); await p.mouse.up(); await p.keyboard.press("Escape"); await sleep(150); };
  await p.goto(URL);
  await p.fill('input[aria-label="Project name"]', "Tools"); await p.click("button:has-text('Create')"); await p.waitForSelector(".excalidraw"); await sleep(800);

  // ---------- properties panel
  await draw("r", 600, 150, 720, 230); await draw("r", 760, 200, 920, 250); await draw("r", 640, 380, 700, 520);
  await focusCanvas(); await p.keyboard.press("t"); await p.mouse.click(700, 650); await p.keyboard.type("Bonjour Tablo"); await p.keyboard.press("Escape"); await sleep(300);
  await focusCanvas(); await p.keyboard.press("Control+a"); await sleep(300);
  check("panel shows for the selection", (await p.$eval(".tools-panel header", (e) => e.textContent)).includes("4 selected"));
  await p.fill('.tools-panel input[aria-label="Size"]', "33"); await p.press('.tools-panel input[aria-label="Size"]', "Enter"); await sleep(300);
  let els = await scene(); let t = els.find((e) => e.type === "text");
  check("exact font size (33px)", t.fontSize === 33, `width ${Math.round(t.width)}px`);
  await p.selectOption('.tools-panel select[aria-label="Font"]', "6"); await sleep(200);
  check("font family (Nunito)", (await scene()).find((e) => e.type === "text").fontFamily === 6);
  await focusCanvas(); await p.keyboard.press("Control+a"); await sleep(200);
  await p.fill('.tools-panel input[aria-label="Gap"]', "30"); await p.press('.tools-panel input[aria-label="Gap"]', "Enter");
  await p.click(".tools-panel button:has-text('Column')"); await sleep(300);
  els = (await scene()).sort((a, b) => a.y - b.y);
  const gaps = els.slice(1).map((e, i) => Math.round(e.y - (els[i].y + els[i].height)));
  check("column with exact 30px gaps", gaps.length === 3 && gaps.every((g) => Math.abs(g - 30) <= 1), JSON.stringify(gaps));
  await focusCanvas(); await p.keyboard.press("Control+a"); await sleep(200);
  await p.click(".tools-panel button:has-text('Same width')"); await sleep(300);
  els = (await scene()).filter((e) => e.type === "rectangle");
  check("same width", new Set(els.map((e) => Math.round(e.width))).size === 1, JSON.stringify(els.map((e) => Math.round(e.width))));
  await focusCanvas(); await p.keyboard.press("Control+a"); await sleep(200);
  await p.click(".tools-panel button:has-text('Box around')"); await sleep(300);
  check("box around the selection", (await scene()).filter((e) => e.type === "rectangle").length === 4);
  
  // ---------- larger text inside a shape: re-wrapped, shape grows to fit
  await p.click("button:has-text('+ New')"); await sleep(800);
  await focusCanvas(); await p.keyboard.press("r"); await p.mouse.move(600, 200); await p.mouse.down(); await p.mouse.move(800, 300, { steps: 5 }); await p.mouse.up();
  await p.keyboard.press("Enter"); await p.keyboard.type("Une note avec un texte assez long pour passer à la ligne"); await p.keyboard.press("Escape"); await sleep(300);
  await focusCanvas(); await p.keyboard.press("Control+a"); await sleep(300);
  await p.click('.tools-panel .chip:has-text("36")'); await sleep(400);
  els = await scene();
  { const box = els.find((e) => e.type === "rectangle"), tx = els.find((e) => e.type === "text");
    const inside = tx.x >= box.x - 1 && tx.x + tx.width <= box.x + box.width + 1 && tx.y >= box.y - 1 && tx.y + tx.height <= box.y + box.height + 1;
    check("text in a shape re-wraps and the shape grows", tx.fontSize === 36 && inside && box.height > 200, `box ${Math.round(box.width)}x${Math.round(box.height)}, ${tx.text.split("\n").length} lines`); }

  // ---------- AI settings
  await p.click(".ai-toggle"); await p.click("button:has-text('Connect a model…')");
  await p.selectOption('select[aria-label="Provider"]', "custom");
  await p.fill('input[aria-label="API URL"]', `http://127.0.0.1:${AI_PORT}/v1`);
  const aiNotice = () => p.textContent(".ai-settings .notice");
  const listModels = async () => { await p.click(".ai-settings button:has-text('Check & list models')"); await p.waitForSelector(".ai-settings button:has-text('Check & list models'):not([disabled])"); };
  await p.fill('input[aria-label="API key"]', "wrong");
  await listModels();
  check("wrong key is reported when checking", /refused/.test(await aiNotice()), await aiNotice());
  await p.fill('input[aria-label="API key"]', "test-key");
  await listModels();
  check("check lists the models", /Connected to 127\.0\.0\.1:4175: 3 models available \(\+1 not for chat\)/.test(await aiNotice()), await aiNotice());
  const options = () => p.$$eval('[aria-label="Available models"] .model-id', (e) => e.map((x) => x.textContent));
  check("model list shows chat models with details", JSON.stringify(await options()) === '["mock-mini","mock-model","other/large-model"]' && /free · 128k tokens/.test(await p.textContent('[aria-label="Available models"]')), JSON.stringify(await options()));
  await p.fill('input[aria-label="Model"]', "large");
  check("typing filters the list", JSON.stringify(await options()) === '["other/large-model"]', JSON.stringify(await options()));
  await p.fill('input[aria-label="Model"]', "nope");
  check("unknown model name is flagged", /not in the provider's list/.test(await p.textContent(".ai-settings")));
  await p.click(".ai-settings button:has-text('Test model')"); await p.waitForSelector(".ai-settings .notice.bad");
  check("testing an unknown model explains it", /“nope” isn't available/.test(await aiNotice()), await aiNotice());
  await p.fill('input[aria-label="Model"]', "mock-mo");
  await p.click('[aria-label="Available models"] button:has-text("mock-model")');
  check("picking a model fills the field", (await p.inputValue('input[aria-label="Model"]')) === "mock-model");
  await p.click(".ai-settings button:has-text('Test model')"); await p.waitForSelector(".ai-settings .notice.ok");
  check("test connection succeeds", /“mock-model” works\. It replied “OK” in \d/.test(await aiNotice()), await aiNotice());
  await p.click(".ai-settings button:has-text('Browse the 3 models')");
  await p.screenshot({ path: join(outDir, "ai-settings.png") });
  await p.click(".ai-settings button:has-text('Save')");
  check("key kept on this device only", await p.evaluate(() => JSON.parse(localStorage.getItem("tablo.ai")).apiKey === "test-key"));

  // ---------- AI: group into themes on the imported sample board
  await p.setInputFiles(".sidebar input[type=file]", FIXTURE);
  await p.waitForFunction(() => [...document.querySelectorAll(".board-row .board-name")].some((e) => e.textContent === "sample")); await sleep(1500);
  // wait until the imported board is the one on screen, then select everything on it
  await p.waitForFunction(() => document.querySelector(".board-row.active .board-name")?.textContent === "sample");
  const many = async () => +((await p.textContent(".ai-scope")).match(/(\d+) selected/)?.[1] ?? 0) > 20;
  for (let i = 0; i < 20 && !(await many()); i++) {
    await focusCanvas(); await p.keyboard.press("Escape");
    await p.keyboard.press("Control+a"); await sleep(300);
  }
  check("scope line shows selection", await many(), await p.textContent(".ai-scope"));
  await p.click(".ai-panel button:has-text('Group into themes')");
  await p.waitForSelector(".ai-done", { timeout: 20000 });
  check("assistant reply shown", /deux thèmes/.test(await p.textContent(".ai-log")), (await p.textContent(".ai-log")).slice(0, 160));
  els = await scene();
  const frames = els.filter((e) => e.type === "frame").map((e) => e.name);
  const inA = els.filter((e) => e.frameId && els.find((f) => f.id === e.frameId)?.name === "Thème A").length;
  check("notes grouped into named frames", frames.includes("Thème A") && frames.includes("Thème B") && inA > 10, `frames=${JSON.stringify(frames)} itemsInA=${inA}`);
  
  // ---------- AI: free prompt -> notes in a frame, arrow, text
  await focusCanvas(); await p.keyboard.press("Escape"); await sleep(200);
  await p.fill('textarea[aria-label="Ask the AI"]', "Ajoute deux idées reliées"); await p.press('textarea[aria-label="Ask the AI"]', "Enter");
  await p.waitForFunction(() => document.querySelectorAll(".ai-done").length === 2, null, { timeout: 20000 });
  els = await scene();
  const ideas = els.filter((e) => e.type === "text" && /^(Première|Deuxième) idée$/.test(e.text));
  const arrow = els.find((e) => e.type === "arrow" && e.startBinding && e.endBinding);
  check("new notes, arrow and summary created", ideas.length === 2 && !!arrow && els.some((e) => e.type === "frame" && e.name === "Idées") && els.some((e) => e.type === "text" && /Résumé/.test(e.text)),
    `ideas=${ideas.length} arrow=${!!arrow}`);

  // ---------- Text to diagram (Excalidraw dialog, our model)
  const before = (await scene()).length;
  await p.click(".ai-panel button:has-text('Draw a diagram…')"); await sleep(800);
  const ta = await p.$(".ttd-dialog textarea, [role=dialog] textarea");
  if (ta) { await ta.fill("Un utilisateur synchronise son appareil avec le cloud"); }
  const gen = await p.$("button:has-text('Generate')");
  if (gen) { await gen.click(); await sleep(3000); }
  const ins = await p.$("button:has-text('Insert')");
  if (ins) { await ins.click(); await sleep(1500); }
  const after = (await scene());
  check("diagram inserted from the AI's Mermaid", after.length > before && after.some((e) => e.type === "text" && /Utilisateur/.test(e.text)), `${before} -> ${after.length}`);
  // ---------- PDF export of text with special characters (Greek, maths, Cyrillic, Chinese, emoji)
  await p.keyboard.press("Escape");
  await p.setInputFiles(".sidebar input[type=file]", join(root, "tests/fixtures/characters.excalidraw"));
  await p.waitForFunction(() => [...document.querySelectorAll(".board-row .board-name")].some((e) => e.textContent === "characters"));
  await p.click(".board-row:has-text('characters') .board-open"); await sleep(1500);
  await p.click("button:has-text('Export frames to PDF…')");
  const [pdfDl] = await Promise.all([p.waitForEvent("download"), p.click(".frame-list li >> nth=0 >> button")]);
  const pdf = readFileSync(await pdfDl.path());
  // unpack the PDF's compressed streams to look inside
  const raw = pdf.toString("latin1");
  let inside = raw;
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { inside += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { /* not compressed */ }
  }
  const fonts = [...new Set([...raw.matchAll(/\/BaseFont \/(Tablo-[\w]+)/g)].map((m) => m[1]))].sort();
  check("special characters get fonts that have them", ["Tablo-Excalifont", "Tablo-Liberation", "Tablo-Nunito", "Tablo-Virgil"].every((f) => fonts.includes(f)), fonts.join(", "));
  const mapped = (cp) => new RegExp(`<${cp.toString(16).padStart(4, "0")}>`, "i").test(inside);
  check("τ, →, ≤, ∑, Ω, ∞, λ, ℝ, ✓, Cyrillic are real text in the PDF", [0x3c4, 0x2192, 0x2264, 0x2211, 0x3a9, 0x221e, 0x3bb, 0x211d, 0x2713, 0x41f].every(mapped),
    [0x3c4, 0x2192, 0x2264, 0x2211, 0x3a9, 0x221e, 0x3bb, 0x211d, 0x2713, 0x41f].filter((c) => !mapped(c)).map((c) => String.fromCodePoint(c)).join(" "));
  check("the line with Chinese and emoji is kept as an image", /\/Subtype \/Image/.test(raw));
  check("no page errors", errs.length === 0, errs.join(" | "));
} finally {
  await b.close();
  aiServer.close();
  site.close();
}
console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
