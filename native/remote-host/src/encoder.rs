use std::mem::ManuallyDrop;
use std::ptr;
use std::slice;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, Level, Profile,
    RateControlMode, UsageType, VuiConfig,
};
use openh264::formats::{YUVBuffer, YUVSource};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFMediaBuffer, IMFMediaEventGenerator, IMFSample, IMFTransform,
    METransformHaveOutput, METransformNeedInput, MF_E_NO_EVENTS_AVAILABLE,
    MF_E_TRANSFORM_NEED_MORE_INPUT, MF_EVENT_FLAG_NO_WAIT, MF_LOW_LATENCY,
    MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC_UNLOCK,
    MF_VERSION, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFMediaType_Video,
    MFSTARTUP_FULL, MFShutdown, MFStartup, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, eAVEncH264VProfile_Base,
};
use windows::Win32::System::Com::{
    COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::core::Interface;

use crate::protocol::EncoderBackend;

const MEDIA_FOUNDATION_EVENT_WAIT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy)]
pub struct VideoEncoderSettings {
    pub width: usize,
    pub height: usize,
    pub target_bitrate: u32,
    pub frames_per_second: f32,
    pub clarity: bool,
}

enum VideoEncoderInner {
    MediaFoundation(MediaFoundationEncoder),
    OpenH264(Box<Encoder>),
}

/// Hardware-first H.264 encoder with a bounded, in-process OpenH264 fallback.
/// The backend accessor always reports the encoder that produced the current
/// frame rather than the one that was merely requested.
pub struct VideoEncoder {
    inner: VideoEncoderInner,
    settings: VideoEncoderSettings,
}

impl VideoEncoder {
    pub fn new(settings: VideoEncoderSettings) -> Result<Self> {
        let inner = match MediaFoundationEncoder::new(settings) {
            Ok(encoder) => VideoEncoderInner::MediaFoundation(encoder),
            Err(_) => VideoEncoderInner::OpenH264(Box::new(openh264_encoder(settings)?)),
        };
        Ok(Self { inner, settings })
    }

    pub fn backend(&self) -> EncoderBackend {
        match &self.inner {
            VideoEncoderInner::MediaFoundation(_) => EncoderBackend::MediaFoundationHardware,
            VideoEncoderInner::OpenH264(_) => EncoderBackend::Openh264Software,
        }
    }

    pub fn encode(&mut self, yuv: &YUVBuffer) -> Result<Vec<u8>> {
        if matches!(&self.inner, VideoEncoderInner::MediaFoundation(_)) {
            let hardware_result = match &mut self.inner {
                VideoEncoderInner::MediaFoundation(encoder) => encoder.encode(yuv),
                VideoEncoderInner::OpenH264(_) => unreachable!(),
            };
            match hardware_result {
                Ok(encoded) => return Ok(encoded),
                Err(_) => {
                    self.inner =
                        VideoEncoderInner::OpenH264(Box::new(openh264_encoder(self.settings)?));
                }
            }
        }
        match &mut self.inner {
            VideoEncoderInner::MediaFoundation(_) => unreachable!(),
            VideoEncoderInner::OpenH264(encoder) => Ok(encoder.encode(yuv)?.to_vec()),
        }
    }
}

fn openh264_encoder(settings: VideoEncoderSettings) -> Result<Encoder> {
    let complexity = if settings.clarity {
        Complexity::Medium
    } else {
        Complexity::Low
    };
    let config = EncoderConfig::new()
        .usage_type(UsageType::ScreenContentRealTime)
        .bitrate(BitRate::from_bps(settings.target_bitrate))
        .max_frame_rate(FrameRate::from_hz(settings.frames_per_second))
        .rate_control_mode(RateControlMode::Bitrate)
        .profile(Profile::Baseline)
        .level(Level::Level_4_0)
        .complexity(complexity)
        .intra_frame_period(IntraFramePeriod::from_num_frames(
            settings.frames_per_second.round().max(1.0) as u32,
        ))
        .vui(VuiConfig::bt709_full())
        .skip_frames(true);
    Ok(Encoder::with_api_config(
        OpenH264API::from_source(),
        config,
    )?)
}

struct MediaFoundationRuntime;

impl MediaFoundationRuntime {
    fn start() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .context("initializing COM for Media Foundation failed")?;
        if let Err(error) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            unsafe { CoUninitialize() };
            return Err(error).context("starting Media Foundation failed");
        }
        Ok(Self)
    }
}

impl Drop for MediaFoundationRuntime {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
        unsafe { CoUninitialize() };
    }
}

struct MediaFoundationEncoder {
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    output_provides_samples: bool,
    output_buffer_size: u32,
    width: usize,
    height: usize,
    frame_duration_100ns: i64,
    frame_index: i64,
    need_input: u32,
    _runtime: MediaFoundationRuntime,
}

impl MediaFoundationEncoder {
    fn new(settings: VideoEncoderSettings) -> Result<Self> {
        if settings.width == 0
            || settings.height == 0
            || !settings.width.is_multiple_of(2)
            || !settings.height.is_multiple_of(2)
        {
            bail!("Media Foundation H.264 requires non-zero even dimensions");
        }
        let runtime = MediaFoundationRuntime::start()?;
        let transform = activate_hardware_encoder()?;
        let attributes = unsafe { transform.GetAttributes() }
            .context("reading hardware encoder attributes failed")?;
        unsafe {
            attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
        }

        let fps = settings.frames_per_second.round().clamp(1.0, 240.0) as u32;
        let output_type = video_type(MFVideoFormat_H264, settings.width, settings.height, fps)?;
        unsafe {
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, settings.target_bitrate)?;
            output_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
            output_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps)?;
            transform.SetOutputType(0, &output_type, 0)?;
        }
        let input_type = video_type(MFVideoFormat_NV12, settings.width, settings.height, fps)?;
        unsafe {
            input_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, settings.width as u32)?;
            input_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            transform.SetInputType(0, &input_type, 0)?;
        }

        let output_info = unsafe { transform.GetOutputStreamInfo(0) }
            .context("reading hardware encoder output stream info failed")?;
        let sample_flags =
            (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0) as u32;
        let events = transform
            .cast::<IMFMediaEventGenerator>()
            .context("hardware encoder is not asynchronous")?;
        unsafe {
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        }
        Ok(Self {
            transform,
            events,
            output_provides_samples: output_info.dwFlags & sample_flags != 0,
            output_buffer_size: output_info
                .cbSize
                .max((settings.width * settings.height * 2).min(u32::MAX as usize) as u32),
            width: settings.width,
            height: settings.height,
            frame_duration_100ns: (10_000_000.0 / fps as f64).round() as i64,
            frame_index: 0,
            need_input: 0,
            _runtime: runtime,
        })
    }

    fn encode(&mut self, yuv: &YUVBuffer) -> Result<Vec<u8>> {
        if yuv.dimensions() != (self.width, self.height) {
            bail!("hardware encoder frame dimensions changed without reconfiguration");
        }
        let mut encoded = Vec::new();
        while self.need_input == 0 {
            self.handle_next_event(&mut encoded)?;
        }
        let sample = self.input_sample(yuv)?;
        unsafe { self.transform.ProcessInput(0, &sample, 0) }
            .context("hardware encoder rejected an input frame")?;
        self.need_input -= 1;
        self.frame_index += 1;

        while encoded.is_empty() && self.need_input == 0 {
            self.handle_next_event(&mut encoded)?;
        }
        Ok(normalize_h264(encoded))
    }

    fn handle_next_event(&mut self, encoded: &mut Vec<u8>) -> Result<()> {
        let deadline = Instant::now() + MEDIA_FOUNDATION_EVENT_WAIT;
        loop {
            match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => {
                    let status = unsafe { event.GetStatus() }?;
                    status
                        .ok()
                        .context("hardware encoder emitted a failed event")?;
                    let event_type = unsafe { event.GetType() }?;
                    if event_type == METransformNeedInput.0 as u32 {
                        self.need_input = self.need_input.saturating_add(1);
                    } else if event_type == METransformHaveOutput.0 as u32 {
                        encoded.extend(self.process_output()?);
                    }
                    return Ok(());
                }
                Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    if Instant::now() >= deadline {
                        bail!("hardware encoder event wait exceeded its frame budget");
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => return Err(error).context("reading hardware encoder events failed"),
            }
        }
    }

    fn input_sample(&self, yuv: &YUVBuffer) -> Result<IMFSample> {
        let byte_len = self.width * self.height * 3 / 2;
        let buffer = unsafe { MFCreateMemoryBuffer(byte_len as u32) }
            .context("allocating a hardware encoder input buffer failed")?;
        let mut target = ptr::null_mut();
        unsafe { buffer.Lock(&mut target, None, None) }
            .context("locking a hardware encoder input buffer failed")?;
        let copy_result = (|| -> Result<()> {
            if target.is_null() {
                bail!("hardware encoder input buffer has no memory");
            }
            let target = unsafe { slice::from_raw_parts_mut(target, byte_len) };
            let y_len = self.width * self.height;
            target[..y_len].copy_from_slice(yuv.y());
            let chroma = &mut target[y_len..];
            for ((pair, u), v) in chroma
                .chunks_exact_mut(2)
                .zip(yuv.u().iter())
                .zip(yuv.v().iter())
            {
                pair[0] = *u;
                pair[1] = *v;
            }
            Ok(())
        })();
        let unlock_result = unsafe { buffer.Unlock() };
        copy_result?;
        unlock_result.context("unlocking a hardware encoder input buffer failed")?;
        unsafe { buffer.SetCurrentLength(byte_len as u32) }?;
        let sample = unsafe { MFCreateSample() }?;
        unsafe {
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(self.frame_index.saturating_mul(self.frame_duration_100ns))?;
            sample.SetSampleDuration(self.frame_duration_100ns)?;
        }
        Ok(sample)
    }

    fn process_output(&self) -> Result<Vec<u8>> {
        let supplied_sample = if self.output_provides_samples {
            None
        } else {
            Some(output_sample(self.output_buffer_size)?)
        };
        let mut output = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(supplied_sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        };
        let mut status = 0;
        let result = unsafe {
            self.transform
                .ProcessOutput(0, slice::from_mut(&mut output), &mut status)
        };
        let sample = unsafe { ManuallyDrop::take(&mut output.pSample) };
        let events = unsafe { ManuallyDrop::take(&mut output.pEvents) };
        drop(events);
        if let Err(error) = result {
            if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Ok(Vec::new());
            }
            return Err(error).context("hardware encoder failed to produce output");
        }
        let Some(sample) = sample else {
            return Ok(Vec::new());
        };
        sample_bytes(&sample)
    }
}

impl Drop for MediaFoundationEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
    }
}

fn activate_hardware_encoder() -> Result<IMFTransform> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut activates: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &mut activates,
            &mut count,
        )
    }
    .context("enumerating hardware H.264 encoders failed")?;
    if activates.is_null() || count == 0 {
        if !activates.is_null() {
            unsafe { CoTaskMemFree(Some(activates.cast())) };
        }
        bail!("no Media Foundation hardware H.264 encoder is available");
    }
    let mut owned = Vec::with_capacity(count as usize);
    for index in 0..count as usize {
        if let Some(activate) = unsafe { ptr::read(activates.add(index)) } {
            owned.push(activate);
        }
    }
    unsafe { CoTaskMemFree(Some(activates.cast())) };
    let activate = owned
        .into_iter()
        .next()
        .context("Media Foundation returned no usable H.264 activation")?;
    unsafe { activate.ActivateObject::<IMFTransform>() }
        .context("activating the Media Foundation hardware H.264 encoder failed")
}

fn video_type(
    subtype: windows::core::GUID,
    width: usize,
    height: usize,
    fps: u32,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType> {
    let media_type = unsafe { MFCreateMediaType() }?;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack_ratio(width as u32, height as u32))?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps, 1))?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_ratio(1, 1))?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    }
    Ok(media_type)
}

fn pack_ratio(numerator: u32, denominator: u32) -> u64 {
    ((numerator as u64) << 32) | denominator as u64
}

fn output_sample(size: u32) -> Result<IMFSample> {
    let sample = unsafe { MFCreateSample() }?;
    let buffer = unsafe { MFCreateMemoryBuffer(size.max(1)) }?;
    unsafe { sample.AddBuffer(&buffer) }?;
    Ok(sample)
}

fn sample_bytes(sample: &IMFSample) -> Result<Vec<u8>> {
    let buffer: IMFMediaBuffer = unsafe { sample.ConvertToContiguousBuffer() }?;
    let mut data = ptr::null_mut();
    let mut length = 0;
    unsafe { buffer.Lock(&mut data, None, Some(&mut length)) }?;
    let bytes = if data.is_null() || length == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(data, length as usize) }.to_vec()
    };
    unsafe { buffer.Unlock() }?;
    Ok(bytes)
}

fn normalize_h264(data: Vec<u8>) -> Vec<u8> {
    if data.starts_with(&[0, 0, 0, 1]) || data.starts_with(&[0, 0, 1]) || data.is_empty() {
        return data;
    }
    let mut offset = 0;
    let mut annex_b = Vec::with_capacity(data.len() + 16);
    while offset + 4 <= data.len() {
        let length = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if length == 0 || offset + length > data.len() {
            return data;
        }
        annex_b.extend_from_slice(&[0, 0, 0, 1]);
        annex_b.extend_from_slice(&data[offset..offset + length]);
        offset += length;
    }
    if offset == data.len() { annex_b } else { data }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_length_prefixed_h264_to_annex_b() {
        assert_eq!(
            normalize_h264(vec![0, 0, 0, 3, 0x67, 1, 2, 0, 0, 0, 2, 0x65, 3]),
            vec![0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x65, 3],
        );
    }

    #[test]
    fn preserves_annex_b_and_unknown_payloads() {
        let annex_b = vec![0, 0, 0, 1, 0x65, 1];
        assert_eq!(normalize_h264(annex_b.clone()), annex_b);
        let unknown = vec![1, 2, 3, 4, 5];
        assert_eq!(normalize_h264(unknown.clone()), unknown);
    }
}
