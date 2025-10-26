const clamp = (min, max, val) => Math.min(Math.max(min, val), max);

const BYTES_PER_F32 = 4;
const FRAME_SIZE = 128;
class GranulatorWorkletProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'start_sample',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'end_sample',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'grain_size',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'voice_1_samples_between_grains',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'voice_2_samples_between_grains',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'sample_speed_ratio',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'voice_1_filter_cutoff',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'voice_2_filter_cutoff',
        defaultValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'linear_slope_length',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'slope_linearity',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'voice_1_movement_samples_per_sample',
        defaultValue: 0,
        minValue: 0,
        automationRate: 'k-rate',
      },
      {
        name: 'voice_2_movement_samples_per_sample',
        defaultValue: 0,
        minValue: 0,
        automationRate: 'k-rate',
      },
    ];
  }

  async initWasm(wasmBytes) {
    const importObject = {
      env: {
        log_err: (ptr, len) => {
          const memory = new Uint8Array(this.wasmInstance.exports.memory.buffer);
          const str = Array.from(memory.subarray(ptr, ptr + len))
            .map(v => String.fromCharCode(v))
            .join('');
          console.error(str);
        },
      },
    };

    const compiledModule = await WebAssembly.compile(wasmBytes);
    this.wasmInstance = await WebAssembly.instantiate(compiledModule, importObject);
    if (this.samples) {
      this.initGranularCtx();
    }
    // We'll set the samples when we receive them if we haven't already

    this.wasmMemory = new Float32Array(this.wasmInstance.exports.memory.buffer);
  }

  initGranularCtx() {
    this.granularInstCtxPtr = this.wasmInstance.exports.create_granular_instance();
    const waveformPtr = this.wasmInstance.exports.get_granular_waveform_ptr(
      this.granularInstCtxPtr,
      this.samples.length
    );
    new Float32Array(this.wasmInstance.exports.memory.buffer).set(
      this.samples,
      waveformPtr / BYTES_PER_F32
    );
  }

  constructor() {
    super();

    this.samples = null;
    this.i = 0;
    this.isRecording = false;
    this.isShutdown = false;
    // Pointer to the recording context in Wasm memory
    this.sampleRecorderCtxPtr = 0;
    // Number of frames that have been recorded since a block of samples was sent to the main thread
    this.recordedFramesSinceLastReported = 0;
    // Index of the current recording block, used to order them on the UI thread
    this.recordingBlockIndex = 0;
    // The absolute frame index of the last block sent to the main thread; the next block should start here.
    this.lastSentRecordingBlockEndFrame = 0;
    this.recorderSampleRate = Math.round(sampleRate);
    this.recorderChannelCount = 1;
    this.recordingBlockFrameCount = Math.max(1, Math.round(this.recorderSampleRate / 3));
    this.pendingRecorderConfig = null;

    this.port.onmessage = evt => {
      switch (evt.data.type) {
        case 'setSamples': {
          this.samples = evt.data.samples;
          if (this.wasmInstance && this.samples) {
            this.initGranularCtx();
          }
          break;
        }
        case 'setWasmBytes': {
          this.initWasm(evt.data.wasmBytes);
          break;
        }
        case 'shutdown': {
          this.isShutdown = true;
          break;
        }
        case 'startRecording': {
          this.isRecording = true;
          this.recordedFramesSinceLastReported = 0;
          this.recordingBlockIndex = 0;
          this.lastSentRecordingBlockEndFrame = 0;
          if (this.sampleRecorderCtxPtr) {
            this.wasmInstance.exports.free_sample_recording_ctx(this.sampleRecorderCtxPtr);
          }
          this.sampleRecorderCtxPtr = 0;
          this.pendingRecorderConfig = {
            sampleRate:
              typeof evt.data.sampleRate === 'number'
                ? Math.max(1, Math.round(evt.data.sampleRate))
                : Math.round(sampleRate),
            channelCount:
              typeof evt.data.channelCount === 'number' && evt.data.channelCount > 0
                ? Math.floor(evt.data.channelCount)
                : null,
          };
          this.recorderSampleRate = this.pendingRecorderConfig.sampleRate;
          this.recordingBlockFrameCount = Math.max(1, Math.round(this.recorderSampleRate / 3));
          break;
        }
        case 'stopRecording': {
          // Send one final block of all remaining samples
          this.sendRecordingBlock();
          this.isRecording = false;
          break;
        }
        case 'exportRecording': {
          this.exportRecording(evt.data.format, evt.data.startSampleIx, evt.data.endSampleIx);
          break;
        }
        default: {
          console.warn('Unhandled msg event type in granulator AWP: ', evt.data.type);
        }
      }
    };
  }

  ensureSampleRecorderCtx(inputs) {
    if (!this.isRecording || !this.wasmInstance) {
      return false;
    }

    if (this.sampleRecorderCtxPtr) {
      return true;
    }

    const inputChannels = inputs[0] ?? [];
    const availableChannels = inputChannels.length;
    const requestedChannels = this.pendingRecorderConfig?.channelCount ?? null;

    let channelCount = requestedChannels ?? availableChannels;
    if ((!channelCount || channelCount <= 0) && availableChannels === 0) {
      // Wait until we have buffers to infer the channel count when none was specified.
      return false;
    }
    if (!channelCount || channelCount <= 0) {
      channelCount = availableChannels;
    }
    if (availableChannels > 0 && channelCount > availableChannels) {
      channelCount = availableChannels;
    }
    if (!channelCount || channelCount <= 0) {
      channelCount = 1;
    }

    this.recorderChannelCount = channelCount;
    this.sampleRecorderCtxPtr = this.wasmInstance.exports.create_sample_recorder_ctx(
      this.recorderSampleRate,
      this.recorderChannelCount
    );
    this.recordingBlockFrameCount = Math.max(1, Math.round(this.recorderSampleRate / 3));
    this.pendingRecorderConfig = null;
    return true;
  }

  exportRecording(format, startSampleIx, endSampleIx) {
    if (!this.wasmInstance || !this.sampleRecorderCtxPtr) {
      console.error('Tried to export recording w/o wasm instance and/or recording ctx');
      return;
    } else if (typeof startSampleIx !== 'number' || typeof endSampleIx !== 'number') {
      console.error(
        'Missing or invalid start and/or end sample index when encoding sample; expecting numbers'
      );
      return;
    } else if (typeof format !== 'number') {
      console.error('Missing or invalid format provided when encoding sample; expected number');
      return;
    }

    const encodedLengthBytes = this.wasmInstance.exports.sample_recorder_encode(
      this.sampleRecorderCtxPtr,
      format,
      startSampleIx,
      endSampleIx
    );
    const encodedOutputPtr = this.wasmInstance.exports.sample_recorder_get_encoded_output_ptr(
      this.sampleRecorderCtxPtr
    );
    const encoded = this.wasmInstance.exports.memory.buffer.slice(
      encodedOutputPtr,
      encodedOutputPtr + encodedLengthBytes
    );
    console.log('Successfully encoded recording; posting to port...');
    this.port.postMessage({ type: 'encodedRecording', encoded });
  }

  getWasmMemory() {
    if (this.wasmMemory.buffer !== this.wasmInstance.exports.memory.buffer) {
      this.wasmMemory = new Float32Array(this.wasmInstance.exports.memory.buffer);
    }
    return this.wasmMemory;
  }

  sendRecordingBlock() {
    if (!this.sampleRecorderCtxPtr || this.recordedFramesSinceLastReported <= 0) {
      return;
    }
    const blockStartPtr = this.wasmInstance.exports.sample_recorder_get_samples_ptr(
      this.sampleRecorderCtxPtr,
      this.lastSentRecordingBlockEndFrame
    );

    const wasmMemory = this.getWasmMemory();
    const frameCount = this.recordedFramesSinceLastReported;
    const totalSampleCount = frameCount * this.recorderChannelCount;
    const interleaved = wasmMemory.subarray(
      blockStartPtr / BYTES_PER_F32,
      blockStartPtr / BYTES_PER_F32 + totalSampleCount
    );
    const block = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
      let mix = 0;
      for (let ch = 0; ch < this.recorderChannelCount; ch++) {
        mix += interleaved[frame * this.recorderChannelCount + ch];
      }
      block[frame] = mix / this.recorderChannelCount;
    }

    this.port.postMessage(
      {
        type: 'recordingBlock',
        block,
        index: this.recordingBlockIndex,
        channelCount: this.recorderChannelCount,
        sampleRate: this.recorderSampleRate,
        frameCount,
      },
      [block.buffer]
    );

    this.lastSentRecordingBlockEndFrame += frameCount;
    this.recordedFramesSinceLastReported = 0;
    this.recordingBlockIndex += 1;
  }

  updateRecording(inputs) {
    const inputChannels = inputs[0];
    if (!inputChannels || inputChannels.length === 0) {
      return;
    }
    if (!this.ensureSampleRecorderCtx(inputs)) {
      return;
    }

    const frameCount = inputChannels[0]?.length ?? 0;
    if (!frameCount) {
      return;
    }

    this.recordedFramesSinceLastReported += frameCount;

    // Copy the samples into the Wasm buffer which holds the main recording
    const ptr = this.wasmInstance.exports.sample_recorder_record(
      this.sampleRecorderCtxPtr,
      frameCount
    );
    const wasmMemory = this.getWasmMemory();
    let writeIx = ptr / BYTES_PER_F32;
    const availableChannels = Math.min(this.recorderChannelCount, inputChannels.length);
    for (let frame = 0; frame < frameCount; frame++) {
      for (let channel = 0; channel < availableChannels; channel++) {
        wasmMemory[writeIx++] = inputChannels[channel][frame];
      }
      for (let channel = availableChannels; channel < this.recorderChannelCount; channel++) {
        wasmMemory[writeIx++] = 0;
      }
    }

    // If we've written enough frames to warrant a new chunk being sent to the main thread,
    // do so and update our counters accordingly
    if (this.recordedFramesSinceLastReported >= this.recordingBlockFrameCount) {
      this.sendRecordingBlock();
    }
  }

  process(inputs, outputs, params) {
    if (this.isShutdown) {
      return false;
    }

    if (this.isRecording) {
      this.updateRecording(inputs);
    }

    if (outputs.length === 0 || !this.samples || !this.wasmInstance || !this.granularInstCtxPtr) {
      return true;
    } else if (outputs[0].length === 0) {
      throw new Error('Output 0 must have at least one channel for impl detail reasons');
    }

    const selectionStartSampleIx = clamp(0, this.samples.length, params['start_sample'][0]);
    const selectionEndSampleIx = clamp(
      selectionStartSampleIx,
      this.samples.length,
      params['end_sample'][0]
    );
    if (selectionEndSampleIx <= selectionStartSampleIx) {
      return true;
    }

    const grainSize = params['grain_size'][0];
    const voice1SamplesBetweenGrains = params['voice_1_samples_between_grains'][0];
    const voice2SamplesBetweenGrains = params['voice_2_samples_between_grains'][0];
    const sampleSpeedRatio = params['sample_speed_ratio'][0];
    const voice1FilterCutoff = params['voice_1_filter_cutoff'][0];
    const voice2FilterCutoff = params['voice_2_filter_cutoff'][0];
    const linearSlopeLength = params['linear_slope_length'][0];
    const slopeLinearity = params['slope_linearity'][0];
    const voice1MovementSamplesPerSample = params['voice_1_movement_samples_per_sample'][0];
    const voice2MovementSamplesPerSample = params['voice_2_movement_samples_per_sample'][0];

    // Render
    const outputBufPtr = this.wasmInstance.exports.render_granular(
      this.granularInstCtxPtr,
      selectionStartSampleIx,
      selectionEndSampleIx,
      grainSize,
      voice1FilterCutoff,
      voice2FilterCutoff,
      linearSlopeLength,
      slopeLinearity,
      voice1MovementSamplesPerSample,
      voice2MovementSamplesPerSample,
      sampleSpeedRatio,
      sampleSpeedRatio, // TODO: separate per voice
      voice1SamplesBetweenGrains,
      voice2SamplesBetweenGrains
    );

    // Fill the first output buffer and then copy them to all other outputs
    const dstBuffer = outputs[0][0];
    const output = new Float32Array(this.wasmInstance.exports.memory.buffer).subarray(
      outputBufPtr / BYTES_PER_F32,
      outputBufPtr / BYTES_PER_F32 + FRAME_SIZE
    );
    dstBuffer.set(output);

    for (let outputIx = 0; outputIx < outputs.length; outputIx++) {
      for (let channelIx = 0; channelIx < outputs[outputIx].length; channelIx++) {
        if (outputIx === 0 && channelIx === 0) {
          continue;
        }

        outputs[outputIx][channelIx].set(dstBuffer);
      }
    }

    return true;
  }
}

registerProcessor('granulator-audio-worklet-processor', GranulatorWorkletProcessor);
