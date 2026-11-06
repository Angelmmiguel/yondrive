# Spike B: streaming

Question: do framed encryption, a service worker and range requests play and download large files (PLAN 5.2, 5.5)?

## What was tested

- `@noble/ciphers` 2.4.0, XChaCha20-Poly1305, pure JS, on a Linux x86-64 desktop (8 cores), single thread.
- Container: frames of `FR` bytes of plaintext, each stored as `nonce(24) || ciphertext || tag(16)`, so the stride is fixed
  and a plaintext offset maps to a ciphertext byte range with one division. AAD binds an index and a final flag.
- A throwaway page and service worker over `http://localhost`, with a static server that only knows `Range`. The service
  worker maps a `Range` request to frames, fetches each frame from the server with its own `Range`, decrypts, and answers
  `206` from a `ReadableStream` that decrypts one frame per pull. Open-ended ranges (`bytes=N-`) are capped at 16 MiB, which
  is what lets a media element start without the worker decrypting the whole file.
- Test file: **500 MiB (524,275,655 bytes, 125 frames), not 4 GB**, to keep time and disk small. It is a WAV file, because
  no video encoder was available in the flake. A `<audio>` element exercises the same range and seek pattern as `<video>`
  (metadata probe, then seeks that become new range requests), but codec behaviour is not covered.
- Engines: Node 22, Chromium 156 and Firefox 157 (the Playwright builds in the flake; `PLAYWRIGHT_BROWSERS_PATH` also holds
  WebKit 27.2).

## Numbers

Raw cipher throughput (encrypt and decrypt are within a few percent of each other; MB/s, 64 to 128 MiB per size):

| Frame | Node | Chromium | Firefox |
| --- | --- | --- | --- |
| 256 KiB | 126 | 133 | 59 |
| 1 MiB | 127 | 130 | 63 |
| 4 MiB | 125 | 130 | 64 |
| 16 MiB | 136 | 129 | 65 |

Frame size does not change throughput. A 4 MiB frame takes about 31 ms to decrypt in Chromium and 62 ms in Firefox, which
is the floor for the delay after a seek.

Through the service worker (500 MiB):

| | Chromium | Firefox |
| --- | --- | --- |
| Full streaming download, end to end | 70 MB/s (7.1 s) | 40 MB/s (12.4 s) |
| Range fetch, 100 bytes | 52 to 76 ms | 87 to 112 ms |
| Range fetch, 12 MiB across 4 frames | 398 ms | 358 ms |
| `<audio>` seek, until playable | 67 to 278 ms | 181 to 190 ms |

Correctness: every range response (first bytes, frame boundary, mid file, last bytes, multi-frame) matched the expected bytes;
the full download was the exact length with every frame start sampled correctly; the media element reached duration 2972 s,
seeked to 10%, 50% and 90% positions and played from them in both engines. The server saw only `Range` requests for whole
frames.

Memory: the Chromium page heap peaked at 141 MB while streaming 500 MiB, so the stream is not buffered. Firefox browser
processes together peaked at about 1.7 GB RSS during the whole run, including the benchmark buffers; the cause was not
isolated. Chromium process RSS was not captured.

## What could not be tested

- **WebKit and Safari.** WebKit 27.2 does not start in this environment (`Could not create EGL display`), so neither the
  cipher throughput nor service worker streaming and `<video>` seeking were verified there. Safari support remains
  unvalidated; PLAN's pass criterion for Safari is open.
- **A 4 GB real video.** Only 500 MiB of WAV. Frame arithmetic is 64-bit-safe in JS up to 2^53, but nothing larger than
  500 MiB was run.
- **Phones.** None available. Extrapolation, clearly an assumption and not a measurement: a mid-range phone core is
  commonly 2 to 4 times slower than a desktop core in pure JS, which would put decrypt at roughly 20 to 60 MB/s. That is
  enough for video bitrates (a 4K stream is about 6 MB/s) and slower for bulk download. Needs a real device.
- Memory on a phone, a service worker being killed mid-stream, background throttling, and Chrome's behaviour with video
  containers whose index is at the end of the file.

## What it means for the design

- **A service worker path is viable** in Chromium and Firefox over a secure context: range requests map to frames
  cleanly and seeking works. Keep it as the plan describes, with the Blob fallback for insecure contexts.
- **Keep 4 MiB frames.** Throughput is independent of frame size, the per-frame overhead (40 bytes) is negligible at any
  size, and 4 MiB bounds the post-seek delay to 30 to 60 ms of decrypt. Smaller frames would only help phones with very
  little memory, and cost more requests; revisit after a phone measurement.
- **CPU is the limit**, not the network: 40 to 130 MB/s single-threaded. For downloads, decrypting several frames in
  parallel in workers is a likely improvement (not tested). Video does not need it.
- The service worker must cap open-ended ranges, as the spike does, or a `bytes=0-` request decrypts the entire file.
- The worker needs the content key. It has to be handed over from the page by message and kept in memory only; its
  lifetime (browsers stop idle workers) means it must be re-sent when the worker restarts. This was not exercised.
- Not a plan change so far, but the Safari criterion cannot be marked passed until WebKit is run on a machine where it
  starts, and the phone criterion needs a device.
