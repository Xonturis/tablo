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
host (GitHub Pages, Netlify, Cloudflare Pages).

### Publishing on GitHub Pages

`.github/workflows/deploy.yml` builds and publishes the site on every push to `main`.
One-time setup in the GitHub repository: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The site then lives at `https://<user>.github.io/<repo>/`. Optional relay
settings (see *Configuration*) go under **Settings → Secrets and variables → Actions →
Variables**, using the same names as in `.env`.

Projects are stored per website address: to move projects from `localhost` to the published
site, use *Back up project* on one and *Import* on the other. It needs **HTTPS** (or localhost) for the
offline/installable features. Once you open it, use the browser's *Install app* button to get
an app window.

## Using it

- **Home**: create a project, import `.excalidraw` files (each file becomes a board), paste a
  share link to join a project, or restore a project backup.
- **Project sidebar**: switch boards, *+ New* board, double-click a board to rename it,
  hover a board to see the delete button, *Import .excalidraw…*, *Export board* (an
  `.excalidraw` file), *Back up project* (a `.tablo.json` file with every board).
- **Share project…**: asks for your name (shown next to your cursor), then gives you a link.
  Anyone with the link can see and edit **every board in that project**. Treat it like a password.

Your Miro exports converted with `miro_export.py` import directly.

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
- **Some networks block direct connections** (strict campus or corporate Wi-Fi, some mobile
  networks). If two people can't connect, add a TURN relay (see configuration below).
- The public Nostr relays are run by volunteers. If peers stop finding each other, set your
  own list of relays.
- Deleting a project only removes it from your device. There is no way to revoke a link you
  have shared, other than creating a new project.

## Configuration (optional)

Create a `.env` file next to `package.json` before `npm run build`:

```bash
# Nostr relays used to find peers (comma-separated). Default: Trystero's built-in list.
VITE_NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol
# TURN relay for networks that block direct connections
VITE_TURN_URLS=turn:turn.example.org:3478
VITE_TURN_USERNAME=me
VITE_TURN_CREDENTIAL=secret
```

## Tests

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
| `src/board/importExport.ts` | `.excalidraw` import/export, project backups |
| `src/ui/` | Home page, project view, dialogs, styles |
| `tests/e2e.mjs` | Two-browser end-to-end test |

## Ideas for later

- An optional small always-on peer (a "sync buddy" on a home server or Raspberry Pi) that
  stays in your rooms, so collaborators sync even when you're offline.
- Read-only share links.
- Desktop wrapper (Tauri) that saves boards as files in a folder.

Built on Excalidraw (MIT), Yjs (MIT), y-indexeddb (MIT) and Trystero (MIT).
