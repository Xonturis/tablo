// Network test: switching boards, and collaborating from a network that blocks direct
// connections (Bob's browser is only allowed to send relayed traffic, as on a strict
// company network).
//
// Checks that both people are told what is wrong and, if coturn (`turnserver`) is
// installed, that Bob gets through once he sets up a relay in the Connection dialog.
// Runs offline like the e2e test. Uses your installed Google Chrome, or set CHROMIUM_PATH.
//
//   npm run test:net
import { build } from "vite";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-net");
const RELAY_PORT = 7778;
const HTTP_PORT = 4176;
const TURN_PORT = 3479;
const URL = `http://127.0.0.1:${HTTP_PORT}/`;

// ---- test build pointing at a local Nostr relay
process.env.VITE_NOSTR_RELAYS = `ws://127.0.0.1:${RELAY_PORT}`;
await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } });

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

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const http = createServer(async (req, res) => {
  const url = new globalThis.URL(req.url, URL);
  // stand-in for a TURN provider's credentials link (same format as Metered's)
  if (url.pathname === "/turn/credentials") {
    if (url.searchParams.get("apiKey") !== "good") return res.writeHead(401, { "Access-Control-Allow-Origin": "*" }).end('{"error":"Invalid API key"}');
    const auth = { username: "tablo", credential: "secret" };
    return res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }).end(JSON.stringify([
      { urls: "stun:127.0.0.1:" + TURN_PORT },
      { urls: `turn:127.0.0.1:${TURN_PORT}`, ...auth },
      { urls: `turn:127.0.0.1:${TURN_PORT}?transport=tcp`, ...auth },
      { urls: "turns:127.0.0.1:5399?transport=tcp", ...auth }, // nothing listens there: "blocked"
    ]));
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  try {
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(await readFile(join(outDir, path)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => http.listen(HTTP_PORT, "127.0.0.1", r));

// ---- optional local TURN relay (coturn). It relays from this machine's LAN address,
// which is where the other browser's direct candidates point.
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
const hasCoturn = spawnSync("turnserver", ["--version"]).error === undefined && !!lanIp;
const turn = hasCoturn
  ? spawn("turnserver", ["-n", "--listening-ip=127.0.0.1", `--relay-ip=${lanIp}`, `--listening-port=${TURN_PORT}`, "--min-port=49300", "--max-port=49400",
      "--lt-cred-mech", "--user=tablo:secret", "--realm=tablo.test", "--no-tls", "--no-dtls", "--allow-loopback-peers", "--no-cli"], { stdio: "ignore" })
  : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(250);
  }
  return false;
};
const boards = (p) => p.$$eval(".board-row", (rows) => rows.map((r) => r.querySelector(".board-name")?.textContent));
const text = (p, sel) => p.textContent(sel).catch(() => "");
let failures = 0;
const errors = [];
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${extra}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome" }),
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection"],
});
try {
  const A = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage();
  const ctxB = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  // Bob's network blocks direct connections: only relayed traffic gets out
  await ctxB.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(c = {}) { super({ ...c, iceTransportPolicy: "relay" }); }
    };
  });
  const B = await ctxB.newPage();
  for (const [n, p] of [["Alice", A], ["Bob", B]]) p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));

  await A.goto(URL);
  await A.fill('input[aria-label="Project name"]', "Réseau");
  await A.click("button:has-text('Create')");
  await A.waitForSelector(".excalidraw");
  await A.click("button:has-text('+ New')");
  await sleep(500);

  // --- the address bar gets out of step with the app: clicking a board must still open it
  const names = await boards(A);
  await A.click(".board-row >> nth=0 >> .board-open");
  await sleep(300);
  const first = await A.evaluate(() => location.hash);
  await A.click(".board-row >> nth=1 >> .board-open");
  await sleep(300);
  await A.evaluate((h) => history.replaceState(null, "", h), first);
  await A.click(".board-row >> nth=0 >> .board-open");
  await sleep(400);
  check("clicking a board always switches to it", (await text(A, ".board-row.active .board-name")) === names[0]);

  await A.click("button:has-text('Share project…')");
  await A.fill('input[aria-label="Your name"]', "Alice");
  await A.click("button:has-text('Save')");
  const link = await A.inputValue("#share-link");
  await A.click("button:has-text('Done')");

  // --- Bob joins from the blocked network
  await B.goto(link);
  await B.fill('input[aria-label="Your name"]', "Bob");
  await B.click("button:has-text('Save')");
  check("Bob is told his network blocks direct connections",
    await waitFor(async () => /blocks direct connections/.test(await text(B, ".waiting-box")), 60000));
  check("Alice sees the connection failed", await waitFor(async () => /Couldn't connect/.test(await text(A, ".status")), 30000), await text(A, ".status"));

  if (!turn) {
    console.log("SKIP  relay checks (install coturn to run them)");
  } else {
    await B.click(".waiting-box button:has-text('Set up a relay')");
    const notice = () => text(B, ".net-settings .notice");
    const test = async () => {
      await B.click(".net-settings button:has-text('Test')");
      await B.waitForSelector(".net-settings button:has-text('Test'):not([disabled])", { timeout: 40000 });
      return notice();
    };
    // a relay typed in by hand, with a wrong password
    await B.check(".net-settings input[type=radio] >> nth=2");
    // (UDP: Chrome reports the refusal over UDP, not over TCP)
    await B.fill('input[aria-label="TURN URLs"]', `turn:127.0.0.1:${TURN_PORT}`);
    await B.fill('input[aria-label="TURN username"]', "tablo");
    await B.fill('input[aria-label="TURN password"]', "wrong");
    const wrong = await test();
    check("a wrong relay password is reported as refused credentials", /refused the credentials/.test(wrong), wrong.slice(0, 120));
    // a credentials link, as given by Metered
    await B.check(".net-settings input[type=radio] >> nth=1");
    await B.fill('input[aria-label="Credentials link"]', `http://127.0.0.1:${HTTP_PORT}/turn/credentials?apiKey=bad`);
    const bad = await test();
    check("a wrong API key in the link is reported", /HTTP 401/.test(bad), bad);
    await B.fill('input[aria-label="Credentials link"]', `http://127.0.0.1:${HTTP_PORT}/turn/credentials?apiKey=good`);
    const good = await test();
    check("the relay test says which addresses get through",
      /relay works/.test(good) && /✓ UDP 3479/.test(good) && /✓ TCP 3479/.test(good) && /✗ TLS 5399/.test(good), good);
    await B.screenshot({ path: join(outDir, "relay-test.png") });
    await B.click(".net-settings button:has-text('Save')");
    check("through the relay, Bob receives the project",
      await waitFor(async () => JSON.stringify(await boards(B)) === JSON.stringify(await boards(A)) && (await boards(B)).length === 2, 60000));
    check("Bob's status says the connection goes through the relay", await waitFor(async () => /via relay/.test(await text(B, ".status")), 10000), await text(B, ".status"));
  }
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  turn?.kill();
  relay.close();
  http.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
