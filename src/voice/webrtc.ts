export type RtcSignalKind = "offer" | "answer" | "candidate";
export type SignalOut = (to: string, kind: RtcSignalKind, sdp?: string, candidate?: RTCIceCandidateInit) => void;

type PeerEntry = {
  pc: RTCPeerConnection;
  remoteSet: boolean;
  pending: RTCIceCandidateInit[];
  initiator: boolean;
  disconnectTimer: number | null;
  connectTimer: number | null;
};

const DISCONNECT_GRACE_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class PeerMesh {
  private peers = new Map<string, PeerEntry>();
  private iceServers = DEFAULT_ICE;
  private localStream: MediaStream | null = null;
  private mySid = "";

  constructor(
    private onSignal: SignalOut,
    private onTrack: (sid: string, stream: MediaStream) => void,
    private onGone: (sid: string) => void,
  ) {}

  setMySid(sid: string): void {
    this.mySid = sid;
  }

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = Array.isArray(servers) && servers.length ? servers : DEFAULT_ICE;
  }

  has(sid: string): boolean {
    return this.peers.has(sid);
  }

  setLocalStream(stream: MediaStream): void {
    this.localStream = stream;
    const track = stream.getAudioTracks()[0] ?? null;
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
      if (sender) {
        void sender.replaceTrack(track).catch(() => {});
      } else if (track) {
        try {
          pc.addTrack(track, stream);
        } catch {
        }
      }
    }
  }

  updateTargets(targets: Set<string>): void {
    for (const sid of targets) {
      if (sid !== this.mySid && !this.peers.has(sid)) this.createPeer(sid, this.mySid < sid);
    }
    for (const sid of [...this.peers.keys()]) {
      if (!targets.has(sid)) this.closePeer(sid);
    }
  }

  private createPeer(sid: string, initiator: boolean): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry: PeerEntry = { pc, remoteSet: false, pending: [], initiator, disconnectTimer: null, connectTimer: null };
    this.peers.set(sid, entry);
    if (this.localStream) {
      const track = this.localStream.getAudioTracks()[0];
      if (track) {
        try {
          pc.addTrack(track, this.localStream);
        } catch {
        }
      }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.onSignal(sid, "candidate", undefined, e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) this.onTrack(sid, stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected" && entry.connectTimer !== null) {
        window.clearTimeout(entry.connectTimer);
        entry.connectTimer = null;
      }
      if (st === "failed" || st === "closed") {
        this.closePeer(sid);
        return;
      }
      if (st === "disconnected") {
        if (entry.disconnectTimer === null) {
          entry.disconnectTimer = window.setTimeout(() => {
            entry.disconnectTimer = null;
            if (this.peers.get(sid) !== entry) return;
            if (pc.connectionState !== "disconnected") return;
            if (entry.initiator) {
              try {
                pc.restartIce();
              } catch {
              }
              void this.makeOffer(sid, entry);
            } else {
              this.closePeer(sid);
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (entry.disconnectTimer !== null) {
        window.clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = null;
      }
    };
    entry.connectTimer = window.setTimeout(() => {
      entry.connectTimer = null;
      if (this.peers.get(sid) !== entry) return;
      if (pc.connectionState === "connected") return;
      this.peers.delete(sid);
      if (entry.disconnectTimer !== null) {
        window.clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = null;
      }
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
      }
      this.createPeer(sid, true);
    }, CONNECT_TIMEOUT_MS);
    if (initiator) void this.makeOffer(sid, entry);
    return entry;
  }

  private async makeOffer(sid: string, entry: PeerEntry): Promise<void> {
    try {
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      this.onSignal(sid, "offer", entry.pc.localDescription?.sdp);
    } catch {
    }
  }

  async handleSignal(from: string, kind: RtcSignalKind, sdp?: string, candidate?: RTCIceCandidateInit): Promise<void> {
    if (from === this.mySid) return;
    let entry = this.peers.get(from);

    if (kind === "offer") {
      if (!entry) entry = this.createPeer(from, false);
      try {
        await entry.pc.setRemoteDescription({ type: "offer", sdp });
      } catch {
        this.closePeer(from);
        entry = this.createPeer(from, false);
        try {
          await entry.pc.setRemoteDescription({ type: "offer", sdp });
        } catch {
          return;
        }
      }
      try {
        entry.remoteSet = true;
        await this.flush(entry);
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        this.onSignal(from, "answer", entry.pc.localDescription?.sdp);
      } catch {
      }
      return;
    }

    if (!entry) return;

    if (kind === "answer") {
      try {
        await entry.pc.setRemoteDescription({ type: "answer", sdp });
        entry.remoteSet = true;
        await this.flush(entry);
      } catch {
      }
      return;
    }

    if (candidate) {
      if (!entry.remoteSet) {
        entry.pending.push(candidate);
        return;
      }
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
      }
    }
  }

  private async flush(entry: PeerEntry): Promise<void> {
    const pending = entry.pending;
    entry.pending = [];
    for (const c of pending) {
      try {
        await entry.pc.addIceCandidate(c);
      } catch {
      }
    }
  }

  private closePeer(sid: string): void {
    const entry = this.peers.get(sid);
    if (!entry) return;
    this.peers.delete(sid);
    if (entry.disconnectTimer !== null) {
      window.clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
    }
    if (entry.connectTimer !== null) {
      window.clearTimeout(entry.connectTimer);
      entry.connectTimer = null;
    }
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    try {
      entry.pc.close();
    } catch {
    }
    this.onGone(sid);
  }

  closeAll(): void {
    for (const sid of [...this.peers.keys()]) this.closePeer(sid);
  }
}
