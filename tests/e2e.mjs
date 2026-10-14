// End-to-end test: two browsers ("Alice" and "Bob", separate storage = separate devices)
// share a project, edit live, edit while disconnected, then merge.
//
// Runs fully offline: it starts a tiny local Nostr relay for peer discovery and serves a
// test build of the app. Uses your installed Google Chrome, or set CHROMIUM_PATH.
//
//   npm run test:e2e
import { build } from "vite";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-e2e");
const FIXTURE = join(root, "tests/fixtures/sample.excalidraw");
const RELAY_PORT = 7777;
const HTTP_PORT = 4173;
const URL = `http://127.0.0.1:${HTTP_PORT}/`;

// ---- 1. test build pointing at the local relay
process.env.VITE_NOSTR_RELAYS = `ws://127.0.0.1:${RELAY_PORT}`;
await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } });

// ---- 2. minimal Nostr relay: forwards events to matching subscriptions, stores nothing
const relay = new WebSocketServer({ port: RELAY_PORT });
const subs = new Map();
const matches = (f, ev) =>
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  Object.keys(f).every((k) => !k.startsWith("#") || ev.tags.some((t) => t[0] === k.slice(1) && f[k].includes(t[1])));
relay.on("connection", (ws) => {
  subs.set(ws, new Map());
  ws.on("close", () => subs.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg[0] === "REQ") { subs.get(ws).set(msg[1], msg.slice(2)); ws.send(JSON.stringify(["EOSE", msg[1]])); }
    else if (msg[0] === "CLOSE") subs.get(ws).delete(msg[1]);
    else if (msg[0] === "EVENT") {
      const ev = msg[1];
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      for (const [c, m] of subs) for (const [sid, fs] of m) if (fs.some((f) => matches(f, ev))) c.send(JSON.stringify(["EVENT", sid, ev]));
    }
  });
});

// ---- 3. static server for the build
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const http = createServer(async (req, res) => {
  let path = decodeURIComponent(new globalThis.URL(req.url, URL).pathname);
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(outDir, path));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => http.listen(HTTP_PORT, "127.0.0.1", r));

// ---- 4. the scenario
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(250);
  }
  return false;
};
const boards = (p) =>
  p.$$eval(".board-row", (rows) =>
    rows.map((r) => ({
      name: r.querySelector(".board-name")?.textContent,
      count: +(r.querySelector(".board-open .muted")?.textContent ?? -1),
      active: r.classList.contains("active"),
    })),
  );
const status = (p) => p.$eval(".status", (e) => e.textContent).catch(() => null);
const key = (bs) => JSON.stringify(bs.map((b) => [b.name, b.count]));
const same = (a, b, ms = 30000) => waitFor(async () => key(await boards(a)) === key(await boards(b)), ms);
let failures = 0;
let pageErrors = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${extra}`);
  if (!ok) failures++;
};
async function draw(p, k, x1, y1, x2, y2) {
  await p.mouse.click(1300, 860);
  await p.keyboard.press(k);
  await p.mouse.move(x1, y1);
  await p.mouse.down();
  await p.mouse.move(x2, y2, { steps: 6 });
  await p.mouse.up();
  await p.keyboard.press("Escape");
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome" }),
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection"],
});
try {
  const A = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const B = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  for (const [n, p] of [["Alice", A], ["Bob", B]])
    p.on("pageerror", (e) => { pageErrors++; console.log(`  [${n} page error]`, e.message); });

  await A.goto(URL);
  await A.fill('input[aria-label="Project name"]', "Focus Group");
  await A.click("button:has-text('Create')");
  await A.waitForSelector(".excalidraw");
  await A.setInputFiles(".sidebar input[type=file]", FIXTURE);
  check("import .excalidraw as a new board", await waitFor(async () => (await boards(A)).length === 2), key(await boards(A)));
  await A.click(".board-row >> nth=0 >> .board-open");
  await sleep(500);
  await draw(A, "r", 500, 300, 700, 450);
  check("drawing adds an element", await waitFor(async () => (await boards(A))[0].count === 1));

  await A.click("button:has-text('Share project…')");
  await A.fill('input[aria-label="Your name"]', "Alice");
  await A.click("button:has-text('Save')");
  const link = await A.inputValue("#share-link");
  check("share link generated", /#\/join\/[a-z0-9]+\/[a-z0-9]+\//.test(link));
  await A.click("button:has-text('Done')");

  await B.goto(link);
  await B.fill('input[aria-label="Your name"]', "Bob");
  await B.click("button:has-text('Save')");
  check("Bob receives every board and element", await same(A, B, 45000), key(await boards(B)));
  check("Alice sees Bob online", await waitFor(async () => /1 other person/.test(await status(A))));

  await B.click(".board-row >> nth=0 >> .board-open");
  await sleep(800);
  await draw(B, "o", 800, 300, 950, 420);
  check("Bob's edit reaches Alice", (await same(A, B, 15000)) && (await boards(A))[0].count === 2);
  await draw(A, "d", 500, 550, 650, 700);
  check("Alice's edit reaches Bob", (await same(A, B, 15000)) && (await boards(B))[0].count === 3);

  await B.click("button:has-text('Share link…')");
  await B.click("button:has-text('Stop sharing on this device')");
  check("Bob disconnects", await waitFor(async () => /nobody else/.test(await status(A)), 20000));
  await draw(A, "r", 900, 550, 1050, 700);
  await A.dblclick(".board-row >> nth=0 >> .board-open");
  await A.fill('input[aria-label="Board name"]', "Session 1");
  await A.keyboard.press("Enter");
  await B.click(".board-row >> nth=1 >> .board-open");
  await sleep(1500);
  await draw(B, "r", 600, 600, 700, 700);
  await B.click("button:has-text('+ New')");
  await sleep(500);
  await B.click("button:has-text('Share project…')");
  await B.click("button:has-text('Done')");
  check("offline edits on both sides merge", await same(A, B, 45000), key(await boards(A)));
  const merged = await boards(A);
  check("nothing lost in the merge", merged.length === 3 && merged[0].name === "Session 1" && merged[0].count === 4, key(merged));

  await B.reload();
  await B.waitForSelector(".board-row");
  check("Bob's copy survives a reload", await same(A, B, 30000));

  const bobOn = (await boards(B)).find((b) => b.active)?.name;
  const idx = (await boards(A)).findIndex((b) => b.name === bobOn);
  await A.hover(`.board-row >> nth=${idx}`);
  await A.click(`.board-row >> nth=${idx} >> [aria-label^="Delete"]`);
  await A.click(`.board-row >> nth=${idx} >> button:has-text("Delete?")`);
  check("a board deleted by a peer disappears cleanly", await waitFor(async () => (await boards(B)).length === 2 && (await boards(B)).some((b) => b.active)));
  check("no uncaught page errors", pageErrors === 0, String(pageErrors));
} finally {
  await browser.close();
  relay.close();
  http.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
