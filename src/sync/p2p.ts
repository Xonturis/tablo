// Peer-to-peer sync of one project's Yjs document over WebRTC.
//
// Peers find each other through public Nostr relays (Trystero's default), which only
// see encrypted connection offers: the project secret is the encryption password.
// Board data then travels directly between browsers over encrypted WebRTC channels.
// No server stores anything; peers catch up with each other whenever they meet.
import * as Y from "yjs";
import { joinRoom, selfId, type JsonValue, type Room } from "trystero/nostr";
import type { ConnectionMonitor, TurnServer } from "./net";

const APP_ID = "tablo-v1";
const RELAYS = (import.meta.env.VITE_NOSTR_RELAYS as string | undefined)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FLUSH_MS = 40; // batch rapid local edits (dragging) into one message

export type Presence = {
  name: string;
  boardId: string | null;
  pointer: { x: number; y: number } | null;
  button: "up" | "down";
  selected: string[];
};

export type PeerState = { id: string; presence: Presence | null };

type Listener = () => void;

const toU8 = (d: unknown): Uint8Array =>
  d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as ArrayBufferLike);

export class P2PSync {
  readonly selfId = selfId;
  private room: Room;
  private peers = new Map<string, PeerState>();
  private listeners = new Set<Listener>();
  private pending: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private presence: Presence;
  private sendUpdate: (u: Uint8Array, target?: string) => void;
  private sendStateVector: (sv: Uint8Array, target: string) => void;
  private sendPresence: (p: Presence, target?: string) => void;

  constructor(
    private doc: Y.Doc,
    projectId: string,
    secret: string,
    userName: string,
    net: { relays: TurnServer[]; monitor?: ConnectionMonitor } = { relays: [] },
  ) {
    this.presence = { name: userName, boardId: null, pointer: null, button: "up", selected: [] };
    this.room = joinRoom(
      {
        appId: APP_ID,
        password: secret,
        ...(RELAYS?.length ? { relayConfig: { urls: RELAYS } } : {}),
        ...(net.relays.length ? { turnConfig: net.relays } : {}),
        ...(net.monitor ? { rtcPolyfill: net.monitor.Polyfill } : {}),
      },
      projectId,
    );

    // "y": a Yjs update (incremental change, or everything a peer is missing)
    const yAction = this.room.makeAction<Uint8Array>("y", {
      onMessage: (data) => Y.applyUpdate(this.doc, toU8(data), this),
    });
    // "sv": a peer tells us what it already has; we answer with only what it lacks
    const svAction = this.room.makeAction<Uint8Array>("sv", {
      onMessage: (sv, { peerId }) => {
        const diff = Y.encodeStateAsUpdate(this.doc, toU8(sv));
        void yAction.send(diff, { target: peerId });
      },
    });
    // "pres": cursor position, selection, current board
    const presAction = this.room.makeAction<JsonValue>("pres", {
      onMessage: (p, { peerId }) => {
        const peer = this.peers.get(peerId) ?? { id: peerId, presence: null };
        this.peers.set(peerId, { ...peer, presence: p as unknown as Presence });
        this.emit();
      },
    });

    this.sendUpdate = (u, target) => void yAction.send(u, target ? { target } : undefined);
    this.sendStateVector = (sv, target) => void svAction.send(sv, { target });
    this.sendPresence = (p, target) =>
      void presAction.send(p as unknown as JsonValue, target ? { target } : undefined);

    this.room.onPeerJoin = (peerId) => {
      this.peers.set(peerId, { id: peerId, presence: null });
      this.sendStateVector(Y.encodeStateVector(this.doc), peerId);
      this.sendPresence(this.presence, peerId);
      this.emit();
    };
    this.room.onPeerLeave = (peerId) => {
      this.peers.delete(peerId);
      this.emit();
    };

    this.doc.on("update", this.onDocUpdate);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.peers.size === 0) return; // offline edits sync on next join
    this.pending.push(update);
    if (!this.flushTimer) this.flushTimer = setTimeout(this.flush, FLUSH_MS);
  };

  private flush = () => {
    this.flushTimer = null;
    if (!this.pending.length) return;
    const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
    this.pending = [];
    this.sendUpdate(merged);
  };

  setPresence(patch: Partial<Presence>) {
    this.presence = { ...this.presence, ...patch };
    if (this.peers.size) this.sendPresence(this.presence);
  }

  getPeers(): PeerState[] {
    return Array.from(this.peers.values());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  async leave() {
    this.flush();
    this.doc.off("update", this.onDocUpdate);
    this.listeners.clear();
    await this.room.leave();
  }
}
