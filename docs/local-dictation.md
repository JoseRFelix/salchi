# Local microphone dictation

Salchi can record from a browser or installed PWA and transcribe on the Salchi
server with `whisper.cpp`. Audio travels through Salchi's authenticated HTTP API;
the transcription process stays bound to loopback.

## Automatic setup

On Linux x64 and arm64, dictation is enabled by default and does not delay server
startup. After the server starts, Salchi downloads a pinned official
`whisper.cpp` release and the selected English model in the background. Small is
the default. If someone records during setup, the composer shows download
progress while that recording waits for the model.

Choose a model in **Settings → General → Dictation model**:

| Model         | Download | Approximate memory | Tradeoff                |
| ------------- | -------: | -----------------: | ----------------------- |
| Tiny English  |    75 MB |             273 MB | Fastest, lower accuracy |
| Base English  |   142 MB |             388 MB | Balanced                |
| Small English |   253 MB |             560 MB | More accurate (default) |

Small uses the official 8-bit quantized model to reduce its CPU and memory cost
while retaining the Small architecture. For canonical mono 16 kHz WAV uploads,
Salchi also selects an encoder context sized to the recording with one second of
padding. Longer or unrecognized recordings retain Whisper's full context.

Files are cached under Salchi's provider status cache, in its `dictation`
directory, so later starts and model switches check and reuse cached downloads.
Only the selected model is loaded. When the selection changes, Salchi starts the
new sidecar and then retires the replaced one. Every downloaded artifact has a
pinned size and SHA-256 digest and is moved into place only after verification.

The microphone remains usable during setup. If a recording finishes before the
model is ready, its authenticated upload waits on the server and is transcribed
as soon as the local sidecar is healthy. Recordings are converted in the browser
to mono 16 kHz WAV, so the managed server does not need `ffmpeg`.

To turn automatic installation off:

```bash
SALCHI_WHISPER_AUTO_PROVISION=false npx salchi@latest serve
```

## Use an existing sidecar

An explicit loopback server overrides automatic setup. For example:

```bash
SALCHI_WHISPER_SERVER_URL=http://127.0.0.1:8080 \
  npx salchi@latest serve --tailscale-serve
```

The URL must use HTTP or HTTPS and a loopback hostname. Keep the sidecar
unprivileged and do not expose its upload endpoint publicly. Salchi uses
`/inference` when the URL has no explicit path.

An existing `whisper-server` can be started like this:

```bash
whisper-server \
  --host 127.0.0.1 \
  --port 8080 \
  --threads 4 \
  --model /path/to/ggml-base.en.bin \
  --no-gpu
```

This override is also the fallback for platforms without an official managed
Linux artifact.

## Browser requirements

Tap the microphone once to record and again to stop. Salchi inserts the
transcript at the current cursor without sending the message.

Mobile browsers require a secure context for microphone access. Use HTTPS, such
as Tailscale Serve, when opening Salchi from another device.
