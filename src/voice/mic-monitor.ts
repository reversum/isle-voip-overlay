export type MonitorOpts = {
  deviceId: string | null;
  outputDeviceId?: string | null;
  inputVolume: number;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export class MicMonitor {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private opts: MonitorOpts | null = null;

  get active(): boolean {
    return this.stream != null;
  }

  async start(opts: MonitorOpts): Promise<void> {
    await this.stop();
    this.opts = opts;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        channelCount: 1,
        noiseSuppression: opts.noiseSuppression,
        echoCancellation: false,
        autoGainControl: opts.autoGainControl,
      },
    });
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (opts.outputDeviceId) {
      try {
        await (this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(opts.outputDeviceId);
      } catch {
        /* */
      }
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.gain = this.ctx.createGain();
    this.gain.gain.value = opts.inputVolume;
    this.source.connect(this.gain).connect(this.ctx.destination);
  }

  setGain(value: number): void {
    if (this.opts) this.opts.inputVolume = value;
    if (this.gain) this.gain.gain.value = value;
  }

  async restart(opts: MonitorOpts): Promise<void> {
    if (this.active) await this.start(opts);
  }

  async stop(): Promise<void> {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* */
      }
      this.source = null;
    }
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        /* */
      }
      this.gain = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* */
      }
      this.ctx = null;
    }
  }
}
