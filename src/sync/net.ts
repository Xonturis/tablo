// Network settings (relay server) and connection diagnostics for peer-to-peer sync.
//
// Browsers first try to connect directly. Some networks (company or university Wi-Fi, VPNs)
// block that; a TURN relay then passes the (still end-to-end encrypted) traffic along.
// Relay settings are per device: they live in this browser only.

export type NetSettings =
  | { mode: "direct" }
  | { mode: "url"; credentialsUrl: string }
  | { mode: "manual"; urls: string; username: string; credential: string };

const KEY = "tablo.net";
const EVENT = "tablo-net-settings";

export function loadNetSettings(): NetSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s?.mode === "url" && s.credentialsUrl) return s;
    if (s?.mode === "manual" && s.urls) return s;
  } catch {
    /* ignore */
  }
  return { mode: "direct" };
}

export function saveNetSettings(s: NetSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onNetSettingsChange(fn: () => void) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

export type TurnServer = { urls: string | string[]; username?: string; credential?: string };

// Relay set at build time (.env), kept for compatibility
const ENV_URLS = (import.meta.env.VITE_TURN_URLS as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean);
const ENV_TURN: TurnServer[] = ENV_URLS?.length
  ? [{ urls: ENV_URLS, username: import.meta.env.VITE_TURN_USERNAME as string | undefined, credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined }]
  : [];

const isTurn = (u: string) => /^turns?:/i.test(u);

/** Relay servers to use, from the settings. Credentials URLs (e.g. Metered) are fetched now. */
export async function resolveRelays(s: NetSettings = loadNetSettings()): Promise<{ servers: TurnServer[]; error?: string }> {
  const servers = [...ENV_TURN];
  if (s.mode === "manual") {
    const urls = s.urls.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
    if (urls.length) servers.push({ urls, username: s.username || undefined, credential: s.credential || undefined });
  } else if (s.mode === "url") {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(s.credentialsUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: TurnServer[] = Array.isArray(data) ? data : Array.isArray(data?.iceServers) ? data.iceServers : [];
      // keep only TURN entries (the app already has STUN servers)
      for (const e of list) {
        const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter((u): u is string => typeof u === "string" && isTurn(u));
        if (urls.length) servers.push({ urls, username: e.username, credential: e.credential });
      }
      if (!servers.length) throw new Error("no TURN server in the answer");
    } catch (e) {
      return { servers, error: `Couldn't get relay credentials (${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message})` };
    }
  }
  return { servers };
}

// ---- diagnostics ------------------------------------------------------------------------

export type NetStatus = {
  /** connection attempts in progress */
  checking: number;
  /** attempts that failed since the last successful connection */
  failed: number;
  /** a live connection goes through a relay */
  viaRelay: boolean;
  /** relays configured for this session */
  relays: number;
  relayError?: string;
};

const CONNECT_DEADLINE_MS = 20000;

/** Watches the WebRTC connections Trystero opens, to explain failures to the user. */
export class ConnectionMonitor {
  status: NetStatus;
  private listeners = new Set<() => void>();
  private checking = new Set<RTCPeerConnection>();
  readonly Polyfill: typeof RTCPeerConnection;

  constructor(relays: number, relayError?: string) {
    this.status = { checking: 0, failed: 0, viaRelay: false, relays, relayError };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const monitor = this;
    this.Polyfill = class MonitoredPeerConnection extends RTCPeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config);
        const update = () => monitor.track(this);
        this.addEventListener("iceconnectionstatechange", update);
        this.addEventListener("signalingstatechange", update);
        this.addEventListener("connectionstatechange", update);
      }
    };
  }

  private outcome = new WeakMap<RTCPeerConnection, "pending" | "done">();

  private track(pc: RTCPeerConnection) {
    const ice = pc.iceConnectionState;
    if (pc.signalingState === "closed" || ice === "closed") {
      this.settle(pc, null);
    } else if (ice === "connected" || ice === "completed") {
      this.settle(pc, "connected");
    } else if (ice === "failed" || pc.connectionState === "failed") {
      this.settle(pc, "failed");
    } else if (pc.signalingState === "stable" && pc.remoteDescription && !this.outcome.has(pc)) {
      // offer and answer exchanged: the two browsers now try to reach each other.
      // Some blocked networks end in "failed", others never get past "new": give it a deadline.
      this.outcome.set(pc, "pending");
      this.checking.add(pc);
      setTimeout(() => {
        if (this.outcome.get(pc) === "pending") this.settle(pc, pc.signalingState === "closed" ? null : "failed");
      }, CONNECT_DEADLINE_MS);
      this.publish();
    }
  }

  private settle(pc: RTCPeerConnection, result: "connected" | "failed" | null) {
    const was = this.outcome.get(pc);
    this.checking.delete(pc);
    if (result === "connected") {
      this.outcome.set(pc, "done");
      this.status = { ...this.status, failed: 0 };
      void this.checkRelay(pc);
    } else if (result === "failed" && was !== "done") {
      this.outcome.set(pc, "done");
      this.status = { ...this.status, failed: this.status.failed + 1 };
    } else if (result === null) {
      this.outcome.set(pc, "done");
    }
    this.publish();
  }

  private publish() {
    if (this.status.checking !== this.checking.size) this.status = { ...this.status, checking: this.checking.size };
    this.emit();
  }

  private async checkRelay(pc: RTCPeerConnection) {
    try {
      const stats = await pc.getStats();
      let pairId = "";
      stats.forEach((r) => {
        if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let local = "";
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && (r.id === pairId || (!pairId && r.selected))) local = r.localCandidateId;
      });
      let relay = false;
      stats.forEach((r) => {
        if (r.id === local && r.candidateType === "relay") relay = true;
      });
      if (relay !== this.status.viaRelay) {
        this.status = { ...this.status, viaRelay: relay };
        this.emit();
      }
    } catch {
      /* stats unavailable */
    }
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
