export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_CHANNELS = 1;
export const OPUS_FRAME_US = 20000;
export const OPUS_BITRATE = 24000;

export function hasWebCodecsOpus(): boolean {
  return (
    typeof globalThis.AudioEncoder !== "undefined" &&
    typeof globalThis.AudioDecoder !== "undefined"
  );
}

export async function isOpusSupported(): Promise<boolean> {
  if (!hasWebCodecsOpus()) return false;
  try {
    const enc = await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: OPUS_CHANNELS,
      bitrate: OPUS_BITRATE,
    });
    const dec = await AudioDecoder.isConfigSupported({
      codec: "opus",
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: OPUS_CHANNELS,
    });
    return Boolean(enc.supported && dec.supported);
  } catch {
    return false;
  }
}

export function makeEncoder(
  onChunk: (chunk: EncodedAudioChunk) => void,
  onError: (err: Error) => void,
): AudioEncoder {
  const encoder = new AudioEncoder({
    output: (chunk) => onChunk(chunk),
    error: (err) => onError(err as unknown as Error),
  });
  encoder.configure({
    codec: "opus",
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: OPUS_CHANNELS,
    bitrate: OPUS_BITRATE,
    opus: { frameDuration: OPUS_FRAME_US, application: "voip" },
  } as AudioEncoderConfig);
  return encoder;
}

export function makeDecoder(
  onData: (data: AudioData) => void,
  onError: (err: Error) => void,
): AudioDecoder {
  const decoder = new AudioDecoder({
    output: (data) => onData(data),
    error: (err) => onError(err as unknown as Error),
  });
  decoder.configure({
    codec: "opus",
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: OPUS_CHANNELS,
  });
  return decoder;
}
