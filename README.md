# Tablo

A small Miro-style whiteboard app for personal use: several **projects**, each holding several
**boards**, drawn with [Excalidraw](https://github.com/excalidraw/excalidraw). Everything is
stored in your browser, works offline, and a project can be **shared with a link**. Edits then
sync directly between the browsers (peer-to-peer), with no server of your own.

## Run it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install        # also copies Excalidraw's fonts into public/ for offline use
npm run dev        # http://localhost:5173
```

To build the static site: `npm run build`. The `dist/` folder can then be hosted on any static
host (GitHub Pages, Netlify, Cloudflare Pages). It needs **HTTPS** (or localhost) for the
offline/installable features. Once you open it, use the browser's *Install app* button to get
an app window.

### Publishing on GitHub Pages

`.github/workflows/deploy.yml` builds and publishes the site on every push to `main` or `master`.
One-time setup in the GitHub repository: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The site then lives at `https://<user>.github.io/<repo>/`. Optional relay
settings (see *Configuration*) go under **Settings → Secrets and variables → Actions →
Variables**, using the same names as in `.env`.

Projects are stored per website address: to move projects from `localhost` to the published
site, use *Back up project* on one and *Import* on the other.

## Using it

- **Home**: create a project, import `.excalidraw` files (each file becomes a board), paste a
  share link to join a project, or restore a project backup.
- **Project sidebar**: switch boards, *+ New* board, double-click a board to rename it,
  hover a board to see the delete button, *Import .excalidraw…*, *Export board* (an
  `.excalidraw` file), *Back up project* (a `.tablo.json` file with every board).
- **Export frames to PDF**: select a frame (or anything inside one) and click the
  *PDF of “frame name”* button in the sidebar for a one-click download, or use
  *Export frames to PDF…* to pick frames from a list: one PDF per frame, or one PDF with a
  page per frame. Files are named after their frames. The PDFs are vector (sharp at any
  zoom, small files) and their text is real, selectable text, so they work well as figures
  in LaTeX/Overleaf. Excalidraw's fonts are embedded from `public/pdf-fonts/`
  (regenerate with `python3 scripts/build-pdf-fonts.py` after upgrading Excalidraw).
  Characters a font lacks (Greek letters like τ, maths symbols, arrows, Cyrillic…) are taken
  from a fallback font (Liberation Sans, then DejaVu Sans), as the browser does on screen. A
  line containing Chinese/Japanese/Korean or emoji is placed as a high-resolution image.
- **Tablo tools** (panel on the right of the board, appears when something is selected):
  exact font size (any value, plus presets and ±10 %), any of Excalidraw's fonts, line
  height, exact stroke width and opacity, position/size/angle in numbers, *Row* / *Column*
  with an exact gap, *Same width* / *Same height*, *Box around* the selection, and *Use for
  new text / shapes* to make the current values the default. Text inside shapes re-wraps
  and the shape grows to fit.
- **AI assistant** (✨ AI, top right of the board): see below.
- **Share project…**: asks for your name (shown next to your cursor), then gives you a link.
  Anyone with the link can see and edit **every board in that project**. Treat it like a password.

Your Miro exports converted with `miro_export.py` import directly.

## AI assistant

Tablo can use any model that speaks the **OpenAI chat API** (the de facto standard): click
**✨ AI → Connect a model…**, enter the API URL and your key, then **Check & list models**: it
checks the URL and key and lists the provider's models (searchable, with context size and
free models marked on OpenRouter). Pick one, and **Test model** sends it a one-word question
to confirm it answers, and how fast. The settings
stay in this browser only: they are never put in the shared project, so collaborators never
see your key, and each person uses their own model.

What it can do (on the selection, or on the whole board if nothing is selected):

- **Group into themes**: arranges sticky notes into named frames.
- **Summarise**, **What's missing?**, **Turn into next steps**, or any question you type: it
  answers and can add notes, text, arrows, recolour or rewrite items.
- **Draw a diagram…**: describe a flowchart or sequence diagram; the model writes it in
  Mermaid and Excalidraw's *Text to diagram* dialog previews and inserts it.

Everything the AI changes is one step: **⌘Z / Ctrl+Z undoes it**. It never deletes anything.
The model does not place things itself; Tablo lays out what it creates.

| Provider | API URL | Notes |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | API key from platform.openai.com |
| Mistral | `https://api.mistral.ai/v1` | API key from console.mistral.ai |
| OpenRouter | `https://openrouter.ai/api/v1` | One key for many models (Claude, Llama, Mistral…) |
| Ollama (local) | `http://localhost:11434/v1` | No key. Nothing leaves your computer. See below. |
| LM Studio (local) | `http://localhost:1234/v1` | No key. Enable CORS in LM Studio's server settings. |

**Ollama** only answers web pages it trusts. On macOS, allow Tablo once, then restart Ollama
(the setting lasts until you log out):

```bash
launchctl setenv OLLAMA_ORIGINS "https://<user>.github.io,http://localhost:5173"
```

Use **Test** in the connection dialog to check everything works. What is sent: the text,
type, colour and position of the selected items (or the whole board), and your request,
to the address you configured, nothing else.

## How the sync works

```
 Alice's browser                                   Bob's browser
 ┌──────────────────┐   encrypted WebRTC channel   ┌──────────────────┐
 │ Excalidraw       │◀════════════════════════════▶│ Excalidraw       │
 │   ⇅              │   board changes (Yjs updates)│   ⇅              │
 │ Yjs document     │                              │ Yjs document     │
 │   ⇅              │                              │   ⇅              │
 │ IndexedDB (disk) │                              │ IndexedDB (disk) │
 └──────────────────┘                              └──────────────────┘
          ╲                                               ╱
           ╲  "who else is in room X?" (encrypted offers) ╱
            ╲──────────▶ public Nostr relays ◀───────────╱
```

- Each project is one [Yjs](https://yjs.dev) document (a CRDT), saved in the browser's
  IndexedDB. Each board element is one entry; when two people edit the same element, the
  same rule as Excalidraw's own collaboration applies (the more recent version wins).
  Deletions are kept as "tombstones" so they sync too.
- Browsers find each other through public **Nostr relays**, which only ever see connection
  offers encrypted with the project's secret (the secret is in the link's `#` part, which
  browsers never send to a server). The board content goes directly between browsers over
  WebRTC, which is encrypted.
- When peers connect they exchange what each one is missing, so edits made offline merge
  automatically.

### Limits of pure peer-to-peer

- **Both people must have the project open at the same time to sync.** Nothing is stored
  in the cloud. If Bob edits on Monday and Alice opens the project on Tuesday, she gets Bob's
  changes the next time they are both online.
- **Some networks block direct connections** (strict campus or corporate Wi-Fi, VPNs, some
  mobile networks). Tablo then says *Couldn't connect to a collaborator* and the browser
  console shows `ICE failed`. The fix is a relay server, see below.
- The public Nostr relays are run by volunteers. If peers stop finding each other, set your
  own list of relays.
- Deleting a project only removes it from your device. There is no way to revoke a link you
  have shared, other than creating a new project.

### When a network blocks direct connections: use a relay

A TURN relay passes the traffic along when two browsers can't reach each other. The data
stays end-to-end encrypted (the relay can't read your boards), and only the person on the
restrictive network needs one.

1. Create a free account at [Metered](https://www.metered.ca/stun-turn) (free tier:
   20 GB/month, plenty for boards) and copy the **ICE servers API link** from its dashboard
   (`https://<yourapp>.metered.live/api/v1/turn/credentials?apiKey=…`).
2. In Tablo, open the project and click **Connection…** (or *Set up a relay…* in the
   warning), choose *Relay from a credentials link*, paste the link, click **Test**, then
   **Save**. The status then reads *1 other person connected (via relay)*.

You can also enter any TURN server by hand (your own [coturn](https://github.com/coturn/coturn),
Cloudflare Realtime TURN…). On the strictest networks, prefer a `turns:…:443` address.
These settings stay in your browser; they are never put in the shared project.

## Configuration (optional)

Create a `.env` file next to `package.json` before `npm run build`:

```bash
# Nostr relays used to find peers (comma-separated). Default: Trystero's built-in list.
VITE_NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol
# TURN relay for everyone using this build (people can also set one in the app)
VITE_TURN_URLS=turn:turn.example.org:3478
VITE_TURN_USERNAME=me
VITE_TURN_CREDENTIAL=secret
```

## Tests

`npm test` runs all three suites. `npm run test:net` checks board switching and what happens
on a network that blocks direct connections; if coturn (`turnserver`) is installed it also
checks that setting up a relay in the app gets the project through. `npm run test:tools` checks the Tablo tools panel and the AI
assistant against a stand-in AI server (no real model or key needed).
`npm run test:e2e` builds the app and drives two separate browser profiles ("Alice" and "Bob")
through: importing a board, sharing, live edits both ways, edits made while disconnected,
merging, reload, and deleting a board someone else is viewing. It runs entirely on your
machine (it starts its own Nostr relay). It uses your installed Google Chrome; set
`CHROMIUM_PATH` to use another Chromium.

## Code map

| Path | What it does |
|---|---|
| `src/store/library.ts` | The list of projects on this device, share links, your name |
| `src/store/project.ts` | One Yjs document per project: boards, elements, images |
| `src/board/BoardCanvas.tsx` | Excalidraw ↔ Yjs binding, cursors of collaborators |
| `src/sync/p2p.ts` | Peer-to-peer sync (Trystero + Nostr), presence |
| `src/sync/net.ts`, `src/ui/NetSettings.tsx` | Relay (TURN) settings, connection diagnostics |
| `src/board/importExport.ts` | `.excalidraw` import/export, project backups |
| `src/board/pdfExport.ts`, `src/ui/PdfDialog.tsx` | Frame → PDF export |
| `src/board/ToolsPanel.tsx`, `src/board/edit.ts` | Tablo tools panel, scene editing helpers |
| `src/ai/`, `src/board/AiPanel.tsx`, `src/ui/AiSettingsDialog.tsx` | AI connection and assistant |
| `src/ui/` | Home page, project view, dialogs, styles |
| `tests/e2e.mjs`, `tests/tools-ai.mjs`, `tests/network.mjs` | End-to-end tests |

## Ideas for later

- An optional small always-on peer (a "sync buddy" on a home server or Raspberry Pi) that
  stays in your rooms, so collaborators sync even when you're offline.
- Read-only share links.
- Desktop wrapper (Tauri) that saves boards as files in a folder.

## Credits

- Built on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT), Yjs (MIT),
  y-indexeddb (MIT), Trystero (MIT), jsPDF (MIT) and svg2pdf.js (MIT).
  The embedded fonts are Excalidraw's (SIL Open Font License, MIT for Comic Shanns), plus
  DejaVu Sans as a fallback in PDFs (Bitstream Vera license, see `public/pdf-fonts/`).
- The **Tablo tools** panel is inspired by the
  [Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) by
  Zsolt Viczián (zsviczian) and its community scripts (exact font size and family, set
  dimensions, fixed spacing, box selected elements, custom stroke defaults…). Thank you!
  Only the ideas were reused: the plugin is AGPL-3.0 licensed and none of its code is in Tablo.
