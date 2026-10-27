import { useEffect, useState, useSyncExternalStore } from "react";
import { type ConnectionMonitor, type NetSettings, type NetStatus, type TurnServer, loadNetSettings, resolveRelays, saveNetSettings } from "../sync/net";

const none = () => () => {};

export function useNetStatus(monitor: ConnectionMonitor | null): NetStatus | null {
  return useSyncExternalStore(
    monitor ? (cb) => monitor.subscribe(cb) : none,
    () => monitor?.status ?? null,
  );
}

/** Short explanation under the sharing status when connecting goes wrong. */
export function NetHint({ net, onSetup }: { net: NetStatus; onSetup: () => void }) {
  if (net.relayError)
    return (
      <p className="net-hint bad small">
        {net.relayError}. <button className="link small" onClick={onSetup}>Check relay settings</button>
      </p>
    );
  if (net.failed === 0) return null;
  return (
    <p className="net-hint bad small">
      {net.relays
        ? "A collaborator was found but the connection failed, even through the relay. Check the relay settings, or try another network."
        : "A collaborator was found but your network (or theirs) blocks direct connections, as company or university Wi-Fi and VPNs often do."}{" "}
      <button className="link small" onClick={onSetup}>{net.relays ? "Relay settings…" : "Set up a relay…"}</button>
    </p>
  );
}

export function NetSettingsDialog({ onClose }: { onClose: () => void }) {
  const initial = loadNetSettings();
  const [mode, setMode] = useState<NetSettings["mode"]>(initial.mode);
  const [credentialsUrl, setCredentialsUrl] = useState(initial.mode === "url" ? initial.credentialsUrl : "");
  const [urls, setUrls] = useState(initial.mode === "manual" ? initial.urls : "");
  const [username, setUsername] = useState(initial.mode === "manual" ? initial.username : "");
  const [credential, setCredential] = useState(initial.mode === "manual" ? initial.credential : "");
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCheck(null), [mode, credentialsUrl, urls]);

  const current = (): NetSettings =>
    mode === "url"
      ? { mode, credentialsUrl: credentialsUrl.trim() }
      : mode === "manual"
        ? { mode, urls: urls.trim(), username: username.trim(), credential }
        : { mode: "direct" };
  const valid = mode === "direct" || (mode === "url" ? /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/]).+/.test(credentialsUrl.trim()) : /turns?:/i.test(urls));

  const test = async () => {
    setBusy(true);
    setCheck(null);
    const result = await testRelay(current());
    setCheck(result);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal net-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="net-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          saveNetSettings(current());
          onClose();
        }}
      >
        <h2 id="net-title">Connection</h2>
        <p className="muted small">
          Collaborators connect directly to each other. Some networks (company or university Wi-Fi, VPNs) block that; a
          <b> relay server</b> (TURN) then passes the traffic along. It stays end-to-end encrypted: the relay cannot read
          your boards. This setting is for this device only.
        </p>
        <label className="radio">
          <input type="radio" name="mode" checked={mode === "direct"} onChange={() => setMode("direct")} />
          <span><b>Direct only</b> (default)</span>
        </label>
        <label className="radio">
          <input type="radio" name="mode" checked={mode === "url"} onChange={() => setMode("url")} />
          <span>
            <b>Relay from a credentials link</b>, e.g. a free <a href="https://www.metered.ca/stun-turn" target="_blank" rel="noreferrer">Metered</a> account
            (20 GB/month free): paste the “ICE servers” API link from its dashboard.
          </span>
        </label>
        {mode === "url" && (
          <input value={credentialsUrl} onChange={(e) => setCredentialsUrl(e.target.value)} placeholder="https://yourapp.metered.live/api/v1/turn/credentials?apiKey=…" aria-label="Credentials link" />
        )}
        <label className="radio">
          <input type="radio" name="mode" checked={mode === "manual"} onChange={() => setMode("manual")} />
          <span><b>Relay server</b> (your own coturn, or any TURN service)</span>
        </label>
        {mode === "manual" && (
          <div className="net-manual">
            <input value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="turns:turn.example.org:443?transport=tcp" aria-label="TURN URLs" />
            <span className="row">
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" aria-label="TURN username" autoComplete="off" />
              <input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="password" aria-label="TURN password" autoComplete="off" />
            </span>
          </div>
        )}
        <p className="muted small">
          Tip: a relay on port 443 (<code>turns:…:443</code>) gets through the strictest networks. Only one of the two people needs
          one, usually whoever is on the restrictive network.
        </p>
        {check && (
          <div className={`notice small ${check.ok ? "ok" : "bad"}`}>
            {check.text}
            {check.probes && (
              <ul className="net-probes">
                {check.probes.map((p) => (
                  <li key={p.url} title={p.url}>
                    {p.ok ? "✓" : "✗"} {p.label}{" "}
                    <span className="muted">
                      {p.ok ? "reachable" : p.refused ? "credentials refused" : "no answer"}
                      {p.detail ? ` (${p.detail})` : ""} · {p.url.replace(/^turns?:/i, "").replace(/\?.*$/, "")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <span className="row">
            {mode !== "direct" && (
              <button type="button" onClick={test} disabled={!valid || busy}>{busy ? "Testing… (up to 15 s)" : "Test"}</button>
            )}
            <button type="submit" className="primary" disabled={!valid}>Save</button>
          </span>
        </div>
      </form>
    </div>
  );
}

type Probe = { url: string; label: string; ok: boolean; refused?: boolean; detail?: string };
type Check = { ok: boolean; text: string; probes?: Probe[] };

/** "TLS 443", "TCP 80", "UDP 3478": how this relay address is reached. */
function describe(url: string) {
  const secure = /^turns:/i.test(url);
  const tcp = /transport=tcp/i.test(url);
  const port = url.replace(/\?.*$/, "").match(/:(\d+)$/)?.[1] ?? (secure ? "5349" : "3478");
  return `${secure ? "TLS" : tcp ? "TCP" : "UDP"} ${port}`;
}

/** Ask one relay address for a relayed address: proves it is reachable and accepts the credentials. */
async function probe(server: TurnServer, url: string): Promise<Probe> {
  const label = describe(url);
  const pc = new RTCPeerConnection({ iceServers: [{ ...server, urls: [url] }], iceTransportPolicy: "relay" });
  try {
    pc.createDataChannel("test");
    let refused = false;
    let detail = "";
    // some browsers say why a server failed (e.g. Chrome: 401 for wrong credentials over UDP)
    pc.addEventListener("icecandidateerror", (e) => {
      const err = e as RTCPeerConnectionIceErrorEvent;
      if (err.errorCode === 401 || err.errorCode === 403 || err.errorCode === 441) refused = true;
      detail = err.errorText || detail;
    });
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      pc.addEventListener("icecandidate", (e) => {
        if (e.candidate?.candidate.includes(" typ relay")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") setTimeout(() => resolve(false), 300);
      });
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve(false));
    });
    return { url, label, ok, refused: !ok && refused, detail: ok ? undefined : detail || undefined };
  } catch (e) {
    return { url, label, ok: false, detail: (e as Error).message };
  } finally {
    pc.close();
  }
}

/** Test every relay address separately, so the user sees what their network lets through. */
async function testRelay(settings: NetSettings): Promise<Check> {
  const { servers, error } = await resolveRelays(settings);
  if (error) return { ok: false, text: error };
  const jobs = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).map((u) => probe(s, u)));
  if (!jobs.length) return { ok: false, text: "No relay server configured." };
  const probes = await Promise.all(jobs);
  const working = probes.filter((p) => p.ok);
  if (working.length)
    return {
      ok: true,
      text: `The relay works from this network (${[...new Set(working.map((p) => p.label))].join(", ")}). Save, and collaborators who can't connect directly will go through it.`,
      probes,
    };
  if (probes.some((p) => p.refused))
    return {
      ok: false,
      text: "The relay answered but refused the credentials. If you just created them, wait two minutes and test again; otherwise check they are still active in your relay account.",
      probes,
    };
  return {
    ok: false,
    text: "No relay address answered: this network seems to block the relay too. To check the relay itself, test from another network (a phone hotspot, home Wi-Fi). In Firefox, about:webrtc shows the details.",
    probes,
  };
}
