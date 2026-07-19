export class MockDictationMediaRecorder extends EventTarget {
  static isTypeSupported(): boolean {
    return true;
  }

  readonly mimeType = "audio/webm;codecs=opus";
  state: "inactive" | "recording" | "paused" = "inactive";

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
  }
}

export function overrideTestProperty(target: object, key: PropertyKey, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  return () => {
    if (original) {
      Object.defineProperty(target, key, original);
    } else {
      Reflect.deleteProperty(target, key);
    }
  };
}

export function installDictationMediaMocks(options: {
  readonly getUserMedia: () => Promise<MediaStream>;
}): { readonly restore: () => void } {
  const restoreMediaRecorder = overrideTestProperty(
    globalThis,
    "MediaRecorder",
    MockDictationMediaRecorder,
  );
  const restoreGetUserMedia = overrideTestProperty(
    navigator.mediaDevices,
    "getUserMedia",
    options.getUserMedia,
  );
  let restored = false;

  return {
    restore: () => {
      if (restored) return;
      restored = true;
      restoreGetUserMedia();
      restoreMediaRecorder();
    },
  };
}
