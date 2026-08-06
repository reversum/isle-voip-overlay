import { SnapshotClient } from "./snapshots";
import { distanceWorld, METERS_TO_WORLD, positionPanner, setListener, WORLD_TO_AUDIO } from "./spatial";
import { VoiceTransport } from "./transport";
import type { ConnState, Participant, Snapshot, SnapshotPlayer, Vec3 } from "./types";
import { PeerMesh } from "./webrtc";

export type InputMode = "open" | "vad" | "ptt";

const SAMPLE_RATE = 48000;
const SPEAKING_HOLD_MS = 300;
const SPEAK_RMS = 0.02;
const PEER_CONNECT_W = 25000;
const PEER_DISCONNECT_W = 33000;

function radiusWorldOf(p?: SnapshotPlayer): number {
  const m = p ? Number(p.radiusM) : NaN;
  const meters = Number.isFinite(m) && m > 0 ? m : (p?.radius ?? 40);
  return meters * METERS_TO_WORLD;
}

class Speaker {
  private panner: PannerNode;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;
  private src: MediaStreamAudioSourceNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private lastAudioAt = 0;
  private spatial = true;
  private userVolume = 1;
  private proximityFactor = 1;
  private audible = 1;

  constructor(
    private ctx: AudioContext,
    output: AudioNode,
  ) {
    this.gain = ctx.createGain();
    this.panner = ctx.createPanner();
    this.panner.panningModel = "HRTF";
    this.panner.distanceModel = "linear";
    this.panner.refDistance = 1;
    this.panner.rolloffFactor = 1;
    this.panner.maxDistance = 40 * WORLD_TO_AUDIO;
    this.panner.connect(this.gain);
    this.gain.connect(output);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  setStream(stream: MediaStream): void {
    this.clearStream();
    // Ohne ein HTMLMediaElement liefert MediaStreamAudioSourceNode in Chromium
    // bei WebRTC-Remote-Streams Stille. Das gemutete Element haelt den Stream am
    // Laufen, der eigentliche Ton kommt aus dem WebAudio-Panner.
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
    this.audioEl = el;
    try {
      this.src = this.ctx.createMediaStreamSource(stream);
      this.src.connect(this.panner);
      this.src.connect(this.analyser);
    } catch {
    }
  }

  private clearStream(): void {
    if (this.src) {
      try {
        this.src.disconnect();
      } catch {
      }
      this.src = null;
    }
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.srcObject = null;
      } catch {
      }
      this.audioEl = null;
    }
  }

  private applyGain(): void {
    const v = this.userVolume * this.proximityFactor * this.audible;
    try {
      this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    } catch {
      this.gain.gain.value = v;
    }
  }

  setUserVolume(v: number): void {
    this.userVolume = Math.max(0, Math.min(2, v));
    this.applyGain();
  }

  sampleActivity(): void {
    if (!this.src) return;
    try {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i += 1) sum += this.buf[i] * this.buf[i];
      if (Math.sqrt(sum / this.buf.length) > SPEAK_RMS) this.lastAudioAt = performance.now();
    } catch {
    }
  }

  setSpatial(enabled: boolean): void {
    this.spatial = enabled;
    if (enabled) {
      this.panner.panningModel = "HRTF";
      this.panner.distanceModel = "linear";
      this.panner.rolloffFactor = 1;
      this.proximityFactor = 1;
    } else {
      this.panner.panningModel = "equalpower";
      this.panner.rolloffFactor = 0;
      positionPanner(this.panner, [0, 0, 0]);
    }
    this.applyGain();
  }

  setPosition(pos: Vec3, radius: number): void {
    if (!this.spatial) return;
    positionPanner(this.panner, pos);
    this.panner.maxDistance = Math.max(2, radius * WORLD_TO_AUDIO);
  }

  setProximity(inRange: boolean): void {
    if (this.spatial) return;
    this.proximityFactor = inRange ? 1 : 0;
    this.applyGain();
  }

  setAudible(on: boolean): void {
    this.audible = on ? 1 : 0;
    this.applyGain();
  }

  isSpeaking(): boolean {
    return performance.now() - this.lastAudioAt < SPEAKING_HOLD_MS;
  }

  destroy(): void {
    this.clearStream();
    try {
      this.panner.disconnect();
      this.gain.disconnect();
      this.analyser.disconnect();
    } catch {
    }
  }
}

class MicCapture {
  private stream: MediaStream | null = null;
  private outStream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private inGain: GainNode | null = null;
  private gate: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private monitorGain: GainNode | null = null;
  private monitorOut: AudioNode | null = null;
  private buf = new Float32Array(512);
  private gateTimer: number | null = null;
  private running = false;
  private lastVoiced = 0;
  private lastTransmitAt = 0;
  private deviceId: string | null = null;

  muted = false;
  pushMuteActive = false;
  mode: InputMode = "open";
  pttActive = false;
  vadThreshold = 0.012;
  inputGain = 1;
  noiseSuppression = true;
  autoGainControl = true;
  monitorEnabled = false;
  onLevel: (rms: number) => void = () => {};
  onStream: (stream: MediaStream) => void = () => {};

  setContext(ctx: AudioContext): void {
    this.ctx = ctx;
  }

  private gateOpen(rms: number): boolean {
    if (this.muted || this.pushMuteActive) return false;
    if (this.mode === "ptt") return this.pttActive;
    if (this.mode === "vad") {
      const now = performance.now();
      if (rms > this.vadThreshold) this.lastVoiced = now;
      return now - this.lastVoiced < 200;
    }
    return true;
  }

  async start(deviceId: string | null): Promise<void> {
    this.stop();
    this.deviceId = deviceId;
    const constraints = (id: string | null): MediaStreamConstraints => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: false,
        noiseSuppression: this.noiseSuppression,
        autoGainControl: this.autoGainControl,
      },
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (err) {
      if (!deviceId) throw err;
      this.deviceId = null;
      stream = await navigator.mediaDevices.getUserMedia(constraints(null));
    }
    this.stream = stream;
    this.running = true;
    const micTrack = stream.getAudioTracks()[0];
    if (micTrack) {
      micTrack.onended = () => {
        if (this.running && this.stream === stream) void this.reinit();
      };
    }
    const ctx = this.ctx;
    if (!ctx) return;
    this.src = ctx.createMediaStreamSource(stream);
    this.inGain = ctx.createGain();
    this.inGain.gain.value = this.inputGain;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.gate = ctx.createGain();
    this.gate.gain.value = this.mode === "open" ? 1 : 0;
    this.dest = ctx.createMediaStreamDestination();
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = this.monitorEnabled ? 1 : 0;
    this.src.connect(this.inGain);
    this.inGain.connect(this.analyser);
    this.inGain.connect(this.gate);
    this.gate.connect(this.dest);
    this.inGain.connect(this.monitorGain);
    if (this.monitorOut) this.monitorGain.connect(this.monitorOut);
    this.outStream = this.dest.stream;
    this.onStream(this.outStream);
    this.startGate();
  }

  private startGate(): void {
    if (this.gateTimer !== null) window.clearInterval(this.gateTimer);
    this.gateTimer = window.setInterval(() => {
      let rms = 0;
      if (this.analyser) {
        try {
          this.analyser.getFloatTimeDomainData(this.buf);
          let sum = 0;
          for (let i = 0; i < this.buf.length; i += 1) sum += this.buf[i] * this.buf[i];
          rms = Math.sqrt(sum / this.buf.length);
        } catch {
        }
      }
      this.onLevel(rms);
      const open = this.gateOpen(rms);
      if (this.gate && this.ctx) {
        try {
          this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.015);
        } catch {
          this.gate.gain.value = open ? 1 : 0;
        }
      }
      if (open && rms > 0.01) this.lastTransmitAt = performance.now();
    }, 40);
  }

  getStream(): MediaStream | null {
    return this.outStream;
  }

  async reinit(): Promise<void> {
    if (this.running) await this.start(this.deviceId);
  }

  setInputGain(g: number): void {
    this.inputGain = g;
    if (this.inGain) this.inGain.gain.value = g;
  }

  setMonitorTarget(ctx: AudioContext, out: AudioNode): void {
    this.ctx = ctx;
    this.monitorOut = out;
    if (this.monitorGain) {
      try {
        this.monitorGain.disconnect();
      } catch {
      }
      this.monitorGain.connect(out);
    }
  }

  setSelfMonitor(enabled: boolean): void {
    this.monitorEnabled = enabled;
    if (this.monitorGain) this.monitorGain.gain.value = enabled ? 1 : 0;
  }

  isTransmitting(): boolean {
    return performance.now() - this.lastTransmitAt < SPEAKING_HOLD_MS;
  }

  stop(): void {
    this.running = false;
    if (this.gateTimer !== null) {
      window.clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
    for (const node of [this.src, this.inGain, this.analyser, this.gate, this.monitorGain]) {
      if (node) {
        try {
          node.disconnect();
        } catch {
        }
      }
    }
    this.src = null;
    this.inGain = null;
    this.analyser = null;
    this.gate = null;
    this.monitorGain = null;
    this.dest = null;
    this.outStream = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}

export type ConnectParams = {
  centralUrl: string;
  hash: string;
  ticket: string;
  mySid: string;
  micDeviceId: string | null;
  outputDeviceId?: string | null;
  inputMode: InputMode;
  nameMode?: "steam" | "nickname" | "none";
  hideNearby?: boolean;
  masterVolume?: number;
  channel?: string;
  groupPassword?: string;
  inputVolume?: number;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  selfMonitor?: boolean;
  vadThreshold?: number;
  getTicket?: () => Promise<{ ticket: string } | { error: string }>;
};

export class VoiceEngine {
  private ctx: AudioContext | null = null;
  private transport = new VoiceTransport();
  private snapshots = new SnapshotClient();
  private mic = new MicCapture();
  private mesh: PeerMesh | null = null;
  private speakers = new Map<string, Speaker>();
  private latestSnapshot: Snapshot | null = null;
  private mySid = "";
  private ticker: number | null = null;
  private voiceState: ConnState = "idle";
  private listenState: ConnState = "idle";
  private premium = false;
  private spatial = false;
  private channelSpatial = true;
  private roster = new Set<string>();
  private rosterNicknames = new Map<string, string>();
  private nameMode: "steam" | "nickname" | "none" = "steam";
  private hideNearby = false;
  private lastParticipantsSig = "";
  private lastSelfIngame = false;
  private masterGain: GainNode | null = null;
  private masterVolume = 1;
  private speakerVolumes = new Map<string, number>();
  private connectCtx: {
    centralUrl: string;
    hash: string;
    ticket: string;
    channel: string;
    groupPassword?: string;
    getTicket?: () => Promise<{ ticket: string } | { error: string }>;
  } | null = null;
  private voiceIntentional = false;
  private voiceAttempts = 0;
  private voiceReconnectTimer: number | null = null;

  onParticipants: ((list: Participant[]) => void) | null = null;
  onSelfIngame: ((ingame: boolean) => void) | null = null;
  onStatus: ((status: { voice: ConnState; listen: ConnState }) => void) | null = null;
  onError: ((error: string) => void) | null = null;

  setNickname(nickname: string): void {
    this.transport.sendNickname(nickname);
  }

  async connect(params: ConnectParams): Promise<void> {
    this.disconnect();
    this.mySid = params.mySid;
    this.nameMode = params.nameMode ?? "steam";
    this.hideNearby = params.hideNearby ?? false;
    this.connectCtx = {
      centralUrl: params.centralUrl,
      hash: params.hash,
      ticket: params.ticket,
      channel: params.channel ?? "prox",
      groupPassword: params.groupPassword,
      getTicket: params.getTicket,
    };
    this.voiceIntentional = false;
    this.voiceAttempts = 0;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.ctx.onstatechange = () => {
      const c = this.ctx;
      if (c && c.state === "suspended") void c.resume();
    };
    await this.applyOutputDevice(params.outputDeviceId ?? null);
    this.masterVolume = params.masterVolume ?? this.masterVolume;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.masterVolume;
    this.masterGain.connect(this.ctx.destination);

    this.mesh = new PeerMesh(
      (to, kind, sdp, candidate) => this.transport.sendSignal(to, kind, sdp, candidate),
      (sid, stream) => this.onPeerTrack(sid, stream),
      (sid) => this.onPeerGone(sid),
    );
    this.mesh.setMySid(this.mySid);

    this.snapshots.onState = (s) => {
      this.listenState = s;
      this.emitStatus();
    };
    this.snapshots.onSnapshot = (snap) => this.applySnapshot(snap);
    this.snapshots.onLicense = (lic) => {
      this.premium = Boolean(lic.features?.premium);
      this.recomputeSpatial();
      this.emitParticipants();
    };
    this.snapshots.connect(
      params.centralUrl,
      params.hash,
      params.ticket,
      params.getTicket ? () => this.freshTicket() : undefined,
    );

    this.transport.onState = (s) => {
      this.voiceState = s;
      this.emitStatus();
      if (s === "open") {
        this.voiceAttempts = 0;
      } else if (s === "closed" && !this.voiceIntentional && this.connectCtx) {
        this.mesh?.closeAll();
        this.scheduleVoiceReconnect();
      }
    };
    this.transport.onRoster = (sids, names) => {
      this.roster = new Set(sids);
      this.rosterNicknames = new Map(Object.entries(names));
      this.recomputePeers();
      this.emitParticipants();
    };
    this.transport.onIceServers = (servers) => this.mesh?.setIceServers(servers);
    this.transport.onSignal = (from, kind, sdp, candidate) => {
      void this.mesh?.handleSignal(from, kind, sdp, candidate);
    };
    this.transport.onChannelInfo = (spatial) => {
      this.channelSpatial = spatial;
      this.recomputeSpatial();
      this.emitParticipants();
    };
    this.transport.onError = (e) => {
      if (e === "update_required") this.voiceIntentional = true;
      this.onError?.(e);
    };
    this.transport.connect(
      params.centralUrl,
      params.hash,
      params.ticket,
      params.channel ?? "prox",
      params.groupPassword,
    );

    this.mic.mode = params.inputMode;
    this.mic.inputGain = params.inputVolume ?? 1;
    this.mic.vadThreshold = params.vadThreshold ?? 0.012;
    this.mic.noiseSuppression = params.noiseSuppression ?? true;
    this.mic.autoGainControl = params.autoGainControl ?? true;
    this.mic.onStream = (stream) => this.mesh?.setLocalStream(stream);
    this.mic.setContext(this.ctx);
    await this.mic.start(params.micDeviceId);
    if (this.ctx && this.masterGain) {
      this.mic.setMonitorTarget(this.ctx, this.masterGain);
      this.mic.setSelfMonitor(params.selfMonitor ?? false);
    }

    this.ticker = window.setInterval(() => this.emitParticipants(), 120);
    this.emitStatus();
  }

  setMuted(muted: boolean): void {
    this.mic.muted = muted;
  }

  setInputVolume(value: number): void {
    this.mic.setInputGain(value);
  }

  setVadThreshold(value: number): void {
    this.mic.vadThreshold = value;
  }

  private async applyOutputDevice(deviceId: string | null): Promise<void> {
    if (!this.ctx) return;
    const sink = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (!sink.setSinkId) return;
    try {
      await sink.setSinkId(deviceId ?? "");
    } catch {
      if (deviceId) {
        try {
          await sink.setSinkId("");
        } catch {
          /* */
        }
      }
    }
  }

  async setOutputDevice(deviceId: string | null): Promise<void> {
    await this.applyOutputDevice(deviceId);
  }

  async setInputDevice(deviceId: string | null): Promise<void> {
    await this.mic.start(deviceId);
  }

  setSelfMonitor(enabled: boolean): void {
    this.mic.setSelfMonitor(enabled);
  }

  setAudioConstraints(noiseSuppression: boolean, autoGainControl: boolean): void {
    this.mic.noiseSuppression = noiseSuppression;
    this.mic.autoGainControl = autoGainControl;
    void this.mic.reinit();
  }

  setPushMute(active: boolean): void {
    this.mic.pushMuteActive = active;
  }

  setInputMode(mode: InputMode): void {
    this.mic.mode = mode;
  }

  setPttActive(active: boolean): void {
    this.mic.pttActive = active;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1.5, v));
    if (this.masterGain) this.masterGain.gain.value = this.masterVolume;
  }

  setSpeakerVolume(sid: string, v: number): void {
    this.speakerVolumes.set(sid, v);
    this.speakers.get(sid)?.setUserVolume(v);
    this.emitParticipants();
  }

  private findPlayer(sid: string): SnapshotPlayer | undefined {
    return this.latestSnapshot?.players.find((p) => p.sid === sid);
  }

  private applySpeakerState(sid: string, speaker: Speaker): void {
    const me = this.findPlayer(this.mySid);
    const p = this.findPlayer(sid);
    const radiusW = radiusWorldOf(p);
    if (!me || !p) {
      speaker.setAudible(false);
    } else {
      speaker.setAudible(true);
      const dist = distanceWorld(me.pos, p.pos);
      if (this.spatial) speaker.setPosition(p.pos, radiusW);
      else speaker.setProximity(dist <= radiusW);
    }
    const vol = this.speakerVolumes.get(sid);
    if (vol !== undefined) speaker.setUserVolume(vol);
  }

  private recomputeSpatial(): void {
    this.spatial = this.premium && this.channelSpatial && this.latestSnapshot?.spatialVoice !== false;
    for (const [sid, speaker] of this.speakers) {
      speaker.setSpatial(this.spatial);
      this.applySpeakerState(sid, speaker);
    }
  }

  private recomputePeers(): void {
    if (!this.mesh || !this.connectCtx) return;
    const isGroup = this.connectCtx.channel !== "prox";
    const me = this.findPlayer(this.mySid);
    const targets = new Set<string>();
    for (const sid of this.roster) {
      if (sid === this.mySid) continue;
      if (isGroup) {
        targets.add(sid);
        continue;
      }
      const p = this.findPlayer(sid);
      if (!me || !p) continue;
      const dist = distanceWorld(me.pos, p.pos);
      const limit = this.mesh.has(sid) ? PEER_DISCONNECT_W : PEER_CONNECT_W;
      if (dist <= limit) targets.add(sid);
    }
    this.mesh.updateTargets(targets);
  }

  private applySnapshot(snap: Snapshot): void {
    this.latestSnapshot = snap;
    this.recomputeSpatial();
    this.recomputePeers();
    const me = this.findPlayer(this.mySid);
    if (me && this.ctx && this.spatial) setListener(this.ctx, me.pos, me.rot?.[0] ?? 0);
    this.emitParticipants();
  }

  private onPeerTrack(sid: string, stream: MediaStream): void {
    if (sid === this.mySid || !this.ctx || !this.masterGain) return;
    let speaker = this.speakers.get(sid);
    if (!speaker) {
      speaker = new Speaker(this.ctx, this.masterGain);
      speaker.setSpatial(this.spatial);
      this.speakers.set(sid, speaker);
    }
    speaker.setStream(stream);
    this.applySpeakerState(sid, speaker);
    const vol = this.speakerVolumes.get(sid);
    if (vol !== undefined) speaker.setUserVolume(vol);
  }

  private onPeerGone(sid: string): void {
    const speaker = this.speakers.get(sid);
    if (speaker) {
      speaker.destroy();
      this.speakers.delete(sid);
    }
    if (this.voiceState === "open") this.recomputePeers();
    this.emitParticipants();
  }

  private emitStatus(): void {
    this.onStatus?.({ voice: this.voiceState, listen: this.listenState });
  }

  private pickName(sid: string, player?: SnapshotPlayer): string | undefined {
    if (this.nameMode === "none") return undefined;
    if (this.nameMode === "nickname") {
      const n = this.rosterNicknames.get(sid);
      return n && n.trim() ? n.trim() : undefined;
    }
    const n = player?.name?.trim();
    return n ? n : undefined;
  }

  private emitParticipants(): void {
    for (const speaker of this.speakers.values()) speaker.sampleActivity();
    const me = this.findPlayer(this.mySid);
    // Solange man selbst nicht in-game ist (keine Position im Snapshot), niemanden
    // zeigen. Proximity-Voice ergibt ohne eigene Position keinen Sinn.
    const ingame = !!me;
    if (ingame !== this.lastSelfIngame) {
      this.lastSelfIngame = ingame;
      this.onSelfIngame?.(ingame);
    }
    if (!ingame) {
      if (this.lastParticipantsSig !== "") {
        this.lastParticipantsSig = "";
        this.onParticipants?.([]);
      }
      return;
    }
    const ids = new Set<string>([this.mySid, ...this.roster, ...this.speakers.keys()]);
    const list: Participant[] = [];
    for (const sid of ids) {
      const isSelf = sid === this.mySid;
      // Server-Einstellung "Nearby verstecken": nur der eigene Eintrag bleibt.
      // Gilt fuer Proximity und alle Custom-Kanaele, weil beide hier durchlaufen.
      if (this.hideNearby && !isSelf) continue;
      const p = this.findPlayer(sid);
      // Andere die nicht in-game sind (keine Position) werden nicht angezeigt.
      if (!isSelf && !p) continue;
      const dist = isSelf ? 0 : p ? distanceWorld(me!.pos, p.pos) : null;
      const radiusW = radiusWorldOf(p);
      const inRange = isSelf || !this.channelSpatial || (dist !== null && dist <= radiusW);
      const heard = isSelf ? this.mic.isTransmitting() : (this.speakers.get(sid)?.isSpeaking() ?? false);
      list.push({
        sid,
        name: this.pickName(sid, isSelf ? me : p),
        isSelf,
        speaking: heard,
        hasAudio: !isSelf,
        inRange,
        distance: dist === null ? null : dist / METERS_TO_WORLD,
        volume: isSelf ? 1 : (this.speakerVolumes.get(sid) ?? 1),
      });
    }
    list.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
      return a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0;
    });

    const sig = list
      .map((p) => `${p.sid}:${p.name ?? ""}:${p.isSelf ? 1 : 0}:${p.speaking ? 1 : 0}:${p.inRange ? 1 : 0}:${p.distance === null ? "n" : "d"}:${p.volume}`)
      .join("|");
    if (sig === this.lastParticipantsSig) return;
    this.lastParticipantsSig = sig;
    this.onParticipants?.(list);
  }

  private scheduleVoiceReconnect(): void {
    if (this.voiceIntentional || !this.connectCtx || this.voiceReconnectTimer !== null) return;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.voiceAttempts, 4));
    this.voiceAttempts += 1;
    this.voiceReconnectTimer = window.setTimeout(() => {
      this.voiceReconnectTimer = null;
      void this.reconnectVoice();
    }, delay);
  }

  private async freshTicket(): Promise<string> {
    const ctx = this.connectCtx;
    if (!ctx?.getTicket) return ctx?.ticket ?? "";
    try {
      const res = await ctx.getTicket();
      if ("ticket" in res && res.ticket) {
        ctx.ticket = res.ticket;
        return res.ticket;
      }
    } catch {
    }
    return ctx.ticket;
  }

  private async reconnectVoice(): Promise<void> {
    const ctx = this.connectCtx;
    if (this.voiceIntentional || !ctx) return;
    const ticket = await this.freshTicket();
    if (this.voiceIntentional || this.connectCtx !== ctx) return;
    this.transport.connect(ctx.centralUrl, ctx.hash, ticket, ctx.channel, ctx.groupPassword);
  }

  disconnect(): void {
    this.voiceIntentional = true;
    this.connectCtx = null;
    if (this.voiceReconnectTimer !== null) {
      window.clearTimeout(this.voiceReconnectTimer);
      this.voiceReconnectTimer = null;
    }
    if (this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
    this.mic.stop();
    if (this.mesh) {
      this.mesh.closeAll();
      this.mesh = null;
    }
    this.transport.close();
    this.snapshots.close();
    for (const speaker of this.speakers.values()) speaker.destroy();
    this.speakers.clear();
    this.latestSnapshot = null;
    this.roster.clear();
    this.lastParticipantsSig = "";
    this.lastSelfIngame = false;
    this.premium = false;
    this.spatial = false;
    this.channelSpatial = true;
    this.speakerVolumes.clear();
    this.masterGain = null;
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
      }
      this.ctx = null;
    }
    this.voiceState = "idle";
    this.listenState = "idle";
  }

  micLevelSubscribe(cb: (rms: number) => void): void {
    this.mic.onLevel = cb;
  }
}
