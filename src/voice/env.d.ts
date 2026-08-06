export {};

declare global {
  const __APP_VERSION__: string;
}

declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }

  class MediaStreamTrackProcessor {
    constructor(init: MediaStreamTrackProcessorInit);
    readonly readable: ReadableStream<AudioData>;
  }
}
