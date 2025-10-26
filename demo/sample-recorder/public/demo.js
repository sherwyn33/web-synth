const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const waveformCanvas = document.getElementById('waveform');
const channelSelect = document.getElementById('channelSelect');
const sampleRateInput = document.getElementById('sampleRate');
const downloadLink = document.getElementById('download');

const initBtn = document.getElementById('init');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const exportBtn = document.getElementById('export');

let audioCtx = null;
let workletNode = null;
let micSource = null;
let recorderSampleRate = 44100;
let recorderChannelCount = 1;
let recordedFrameCount = 0;
let previewSamples = new Float32Array(0);
let isRecording = false;
let isInitialized = false;

const appendLog = message => {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${message}\n` + logEl.textContent;
};

const setStatus = text => {
  statusEl.textContent = `status: ${text}`;
};

const resetPreview = () => {
  previewSamples = new Float32Array(0);
  recordedFrameCount = 0;
  drawWaveform();
};

const drawWaveform = () => {
  const ctx2d = waveformCanvas.getContext('2d');
  ctx2d.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  if (!previewSamples.length) {
    return;
  }

  const width = waveformCanvas.width;
  const height = waveformCanvas.height;
  const step = Math.ceil(previewSamples.length / width);

  ctx2d.strokeStyle = '#1976d2';
  ctx2d.lineWidth = 1;

  for (let x = 0; x < width; x++) {
    const start = x * step;
    const end = Math.min(start + step, previewSamples.length);
    let min = 1;
    let max = -1;

    for (let i = start; i < end; i++) {
      const sample = previewSamples[i];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }

    const yTop = ((1 - max) / 2) * height;
    const yBottom = ((1 - min) / 2) * height;

    ctx2d.beginPath();
    ctx2d.moveTo(x + 0.5, yTop);
    ctx2d.lineTo(x + 0.5, yBottom);
    ctx2d.stroke();
  }
};

const growPreview = block => {
  const next = new Float32Array(previewSamples.length + block.length);
  next.set(previewSamples);
  next.set(block, previewSamples.length);
  previewSamples = next;
  drawWaveform();
};

const handlePortMessage = evt => {
  const data = evt.data;
  switch (data.type) {
    case 'recordingBlock': {
      recorderSampleRate = data.sampleRate ?? recorderSampleRate;
      recorderChannelCount = data.channelCount ?? recorderChannelCount;
      recordedFrameCount += data.frameCount ?? data.block.length;
      growPreview(data.block);
      setStatus(
        `recording – received block ${data.index} (${recordedFrameCount} frames @ ${recorderSampleRate} Hz, ${recorderChannelCount} ch)`
      );
      break;
    }
    case 'encodedRecording': {
      const blob = new Blob([data.encoded], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.style.display = 'inline-block';
      downloadLink.textContent = 'download recording';
      appendLog(
        `received encoded recording (${(blob.size / 1024).toFixed(1)} KiB) – link updated`
      );
      setStatus('encoding complete – ready to download');
      break;
    }
    default: {
      appendLog(`unhandled message from worklet: ${JSON.stringify(data)}`);
    }
  }
};

const ensureInitialized = async () => {
  if (isInitialized) {
    return;
  }

  if (!('mediaDevices' in navigator)) {
    throw new Error('MediaDevices API not available in this browser');
  }

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('./GranulatorWorkletProcessor.js');
  const wasmBytes = await fetch('./granular.wasm').then(res => res.arrayBuffer());

  workletNode = new AudioWorkletNode(audioCtx, 'granulator-audio-worklet-processor', {
    channelCount: 2,
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  workletNode.port.onmessage = handlePortMessage;
  workletNode.port.postMessage({ type: 'setWasmBytes', wasmBytes });

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(workletNode);

  // Mute the worklet output so we do not feed the synthesized signal to the speakers.
  const muteGain = audioCtx.createGain();
  muteGain.gain.value = 0;
  workletNode.connect(muteGain).connect(audioCtx.destination);

  isInitialized = true;
  appendLog('audio graph ready – microphone connected to worklet');
  setStatus('ready');
};

const startRecording = async () => {
  await ensureInitialized();
  await audioCtx.resume();

  resetPreview();
  downloadLink.style.display = 'none';
  downloadLink.removeAttribute('href');

  const sampleRate = Number.parseInt(sampleRateInput.value, 10) || Math.round(audioCtx.sampleRate);
  const channelValue = channelSelect.value;

  const payload = {
    type: 'startRecording',
    sampleRate,
  };
  if (channelValue !== 'auto') {
    payload.channelCount = Number.parseInt(channelValue, 10);
  }

  workletNode.port.postMessage(payload);
  isRecording = true;
  setStatus(`recording – configured for ${payload.sampleRate} Hz (${payload.channelCount ?? 'auto'} ch)`);
  appendLog('recording started');
};

const stopRecording = () => {
  if (!isRecording || !workletNode) {
    return;
  }
  workletNode.port.postMessage({ type: 'stopRecording' });
  isRecording = false;
  setStatus('stopped – ready to export');
  appendLog(`recording stopped after ${recordedFrameCount} frames`);
};

const exportRecording = () => {
  if (!recordedFrameCount || !workletNode) {
    appendLog('nothing to export yet – record something first');
    return;
  }
  workletNode.port.postMessage({
    type: 'exportRecording',
    format: 0,
    startSampleIx: 0,
    endSampleIx: recordedFrameCount,
  });
  setStatus('encoding…');
  appendLog('requested WAV encoding');
};

initBtn.addEventListener('click', () => {
  ensureInitialized().catch(err => {
    console.error(err);
    setStatus('error');
    appendLog(`initialization failed: ${err.message}`);
  });
});

startBtn.addEventListener('click', () => {
  startRecording().catch(err => {
    console.error(err);
    setStatus('error');
    appendLog(`start failed: ${err.message}`);
  });
});

stopBtn.addEventListener('click', stopRecording);
exportBtn.addEventListener('click', exportRecording);

setStatus('idle – click "initialize audio" to begin');
appendLog('demo ready – build granular.wasm and place it next to this HTML file');
