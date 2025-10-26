use std::io::Cursor;

#[derive(Default)]
pub struct SampleRecorderContext {
  pub samples: Vec<f32>,
  pub encoded: Vec<u8>,
  pub channel_count: u16,
  pub sample_rate: u32,
}

#[no_mangle]
pub extern "C" fn create_sample_recorder_ctx(
  sample_rate: u32,
  channel_count: u32,
) -> *const SampleRecorderContext {
  let channel_count = channel_count.max(1) as u16;
  Box::into_raw(Box::new(SampleRecorderContext {
    samples: Vec::new(),
    encoded: Vec::new(),
    channel_count,
    sample_rate,
  }))
}

/// Given the number of frames to be written, returns a pointer to the spot in memory where they
/// can be written to. The pointer points to exactly the point where the *new* samples are to be
/// written and has enough space for the provided frame count multiplied by the channel count.
#[no_mangle]
pub unsafe extern "C" fn sample_recorder_record(
  ctx: *mut SampleRecorderContext,
  frame_count_to_write: usize,
) -> *mut f32 {
  let ctx = &mut *ctx;
  let sample_count_to_write = frame_count_to_write * ctx.channel_count as usize;
  let write_start = ctx.samples.len();
  ctx.samples.reserve(sample_count_to_write);
  ctx.samples.set_len(write_start + sample_count_to_write);
  ctx.samples.as_mut_ptr().add(write_start)
}

/// Returns a pointer to the sample buffer for the provided context with an offset of `frame_offset`
/// frames. The pointer is advanced by `frame_offset * channel_count` samples.
#[no_mangle]
pub unsafe extern "C" fn sample_recorder_get_samples_ptr(
  ctx: *const SampleRecorderContext,
  frame_offset: usize,
) -> *const f32 {
  let ctx = &*ctx;
  ctx
    .samples
    .as_ptr()
    .add(frame_offset * ctx.channel_count as usize)
}

fn encode_to_wav(samples: &[f32], sample_rate: u32, channel_count: u16) -> Vec<u8> {
  let spec = hound::WavSpec {
    channels: channel_count,
    sample_rate,
    bits_per_sample: 32,
    sample_format: hound::SampleFormat::Float,
  };
  let mut encoded_buf = Vec::new();
  let mut writer = hound::WavWriter::new(Cursor::new(&mut encoded_buf), spec).unwrap();
  for sample in samples {
    writer.write_sample(*sample).unwrap();
  }
  writer.finalize().unwrap();
  encoded_buf
}

/// Encodes the sample into the specified format and writes it into a buffer.  Returns the length of
/// that buffer in bytes.  Call `sample_recorder_get_encoded_output_ptr` with the same context you
/// passed to this function to retrieve the pointer to that buffer.
#[no_mangle]
pub unsafe extern "C" fn sample_recorder_encode(
  ctx: *mut SampleRecorderContext,
  format: u32,
  start_frame_ix: usize,
  end_frame_ix: usize,
) -> usize {
  let ctx = &mut *ctx;
  // wav is all we support currently
  if format != 0 {
    panic!("Unsupported encoding format");
  }

  let channel_count = ctx.channel_count as usize;
  let start_sample_ix = start_frame_ix * channel_count;
  let end_sample_ix = end_frame_ix * channel_count;
  ctx.encoded = encode_to_wav(
    &ctx.samples[start_sample_ix..end_sample_ix],
    ctx.sample_rate,
    ctx.channel_count,
  );
  ctx.encoded.len()
}

#[no_mangle]
pub unsafe extern "C" fn sample_recorder_get_encoded_output_ptr(
  ctx: *const SampleRecorderContext,
) -> *const u8 {
  (*ctx).encoded.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn free_sample_recording_ctx(ctx: *mut SampleRecorderContext) {
  drop(Box::from_raw(ctx))
}
