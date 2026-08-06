import type { ConnState } from "./types";
import type { RtcSignalKind } from "./webrtc";

const KEEPALIVE_MS = 25_000;

export class VoiceTransport {
  private ws: WebSocket | null = null;
  private keepaliveTimer: number | null = null;
  onState: ((state: ConnState) => void) | null = null;
  onRoster: ((sids: string[], names: Record<string, string>) => void) | null = null;
  onChannelInfo: ((spatial: boolean) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onSignal: ((from: string, kind: RtcSignalKind, sdp?: string, candidate?: RTCIceCandidateInit) => void) | null = null;
  onIceServers: ((servers: RTCIceServer[]) => void) | null = null;

  connect(centralUrl: string, hash: string, ticket: string, channel = "prox", password?: string): void {
    this.close();
    const base = centralUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({ t: ticket, v: __APP_VERSION__ });
    if (channel && channel !== "prox") {
      params.set("ch", channel);
      if (password) params.set("pw", password);
    }
    const ws = new WebSocket(`${base}/voice/${hash}?${params.toString()}`);
    this.ws = ws;
    this.onState?.("connecting");

    ws.onopen = () => {
      this.onState?.("open");
      this.startKeepalive(ws);
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.stopKeepalive();
        this.ws = null;
        this.onState?.("closed");
      }
    };
    ws.onerror = () => {
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: {
        type?: string;
        sids?: unknown;
        names?: unknown;
        spatial?: unknown;
        error?: unknown;
        from?: unknown;
        kind?: unknown;
        sdp?: unknown;
        candidate?: unknown;
        servers?: unknown;
      };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "rtc" && typeof msg.from === "string" && typeof msg.kind === "string") {
        this.onSignal?.(
          msg.from,
          msg.kind as RtcSignalKind,
          typeof msg.sdp === "string" ? msg.sdp : undefined,
          (msg.candidate as RTCIceCandidateInit | undefined) ?? undefined,
        );
      } else if (msg.type === "ice_servers" && Array.isArray(msg.servers)) {
        this.onIceServers?.(msg.servers as RTCIceServer[]);
      } else if (msg.type === "roster" && Array.isArray(msg.sids)) {
        this.onRoster?.(
          msg.sids.map((s) => String(s)),
          msg.names && typeof msg.names === "object" ? (msg.names as Record<string, string>) : {},
        );
      } else if (msg.type === "channel_info") {
        this.onChannelInfo?.(Boolean(msg.spatial));
      } else if (msg.type === "error" && typeof msg.error === "string") {
        this.onError?.(msg.error);
      }
    };
  }

  sendSignal(to: string, kind: RtcSignalKind, sdp?: string, candidate?: RTCIceCandidateInit): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "rtc", to, kind, sdp, candidate }));
  }

  sendNickname(nickname: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_nickname", nickname }));
  }

  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.keepaliveTimer = window.setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.stopKeepalive();
        return;
      }
      try {
        ws.send('{"type":"noop"}');
      } catch {
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  close(): void {
    this.stopKeepalive();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
  }
}
