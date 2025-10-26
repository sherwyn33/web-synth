# Sample Recorder Demo

This directory is a minimal, copy-pasteable showcase of the audio recording
pipeline that powers the granulator module. It gathers the exact runtime pieces
from the main app and wraps them in a tiny static demo so you can experiment
with multi-channel PCM capture, preview the incoming waveform, and export a WAV
file suitable for use in other tools (e.g. a SoundFont editor).

## Layout

```
public/
  GranulatorWorkletProcessor.js  <-- copied verbatim from /public
  demo.js                        <-- lightweight UI wiring for the demo
  index.html                     <-- static page that hosts the demo
engine/
  common/                        <-- copied verbatim from /engine/common
  dsp/                           <-- copied verbatim from /engine/dsp
  granular/                      <-- copied verbatim from /engine/granular
README.md                        <-- this file
```

The Rust crates are duplicated so you can build a `granular.wasm` artifact in
isolation. The worklet file is likewise duplicated so the demo can host the
same AudioWorklet that the main app uses.

## Building the Wasm module

The worklet expects to receive the `granular.wasm` binary that exports the
sample-recorder functions. Build it from this directory with the standard Rust
toolchain:

```bash
rustup target add wasm32-unknown-unknown
cd demo/sample-recorder/engine
cargo build --release --target wasm32-unknown-unknown -p granular
cp target/wasm32-unknown-unknown/release/granular.wasm ../public/
```

(You can repeat the copy step whenever you rebuild the crate.)

## Running the browser demo

Serve the `public/` folder with any static file server:

```bash
cd demo/sample-recorder/public
npx serve .
```

Then open the printed URL in a modern browser (Chromium, Firefox, or Safari
with AudioWorklet support). Use the UI to initialize audio, pick whether you
want automatic channel detection or to force mono/stereo, and start recording.
Each incoming block is downmixed for the preview canvas while the interleaved
multi-channel PCM stays in Wasm memory so the WAV export retains the recorded
layout and sample rate. The "Export" button triggers the Rust encoder and the
download link appears when encoding completes.

## Re-using the pipeline in your own project

* Copy `public/GranulatorWorkletProcessor.js` into your app and post three
  messages to its `MessagePort`: `setWasmBytes` (once at init), `startRecording`
  with your desired sample rate/channel count, and `stopRecording` /
  `exportRecording` as needed. The worklet posts `recordingBlock` messages
  containing mono preview data plus metadata, and `encodedRecording` with the
  WAV bytes.
* Build `granular.wasm` from the duplicated crates (or from the upstream engine
  workspace) and serve it alongside the worklet bundle so you can feed the raw
  bytes to the worklet via `setWasmBytes`.
* If you only care about recording, you may ignore the rest of the granulator
  DSP exports—just avoid calling them from the UI.

The demo page’s `demo.js` shows how to combine `getUserMedia`, an
`AudioWorkletNode`, and the message flow into a standalone recorder without the
rest of the synth UI.
