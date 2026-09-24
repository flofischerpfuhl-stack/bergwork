//! Measurement-only A6 prototypes. This module is unreachable without `--features a6-spike`.

use serde::Serialize;
use std::{
    env, fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

const TILE: usize = 256;
const BATCH_HEADER: usize = 40;
static CAPTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone, Default)]
pub(crate) struct FrameClockProbe(Arc<Mutex<FrameClockState>>);

#[derive(Default)]
struct FrameClockState {
    active: bool,
    samples: Vec<FrameClockSample>,
}

#[derive(Clone)]
struct FrameClockSample {
    counter: i64,
    frame_time_us: i64,
    presentation_time_us: Option<u64>,
    refresh_interval_us: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentedFrames {
    samples: usize,
    presentation_timestamps: usize,
    interval_ms: Distribution,
    dropped_frames: u64,
    refresh_interval_ms: f64,
    source: &'static str,
}

#[tauri::command]
pub(crate) fn a6_frame_clock_reset(probe: tauri::State<'_, FrameClockProbe>) {
    if let Ok(mut state) = probe.0.lock() {
        state.samples.clear();
        state.active = true;
    }
}

#[tauri::command]
pub(crate) fn a6_frame_clock_take(probe: tauri::State<'_, FrameClockProbe>) -> PresentedFrames {
    let samples = if let Ok(mut state) = probe.0.lock() {
        state.active = false;
        std::mem::take(&mut state.samples)
    } else {
        Vec::new()
    };
    summarize_presented_frames(&samples)
}

fn summarize_presented_frames(samples: &[FrameClockSample]) -> PresentedFrames {
    let presentation_timestamps = samples
        .iter()
        .filter(|sample| sample.presentation_time_us.is_some())
        .count();
    let source = if presentation_timestamps > 0 {
        "GdkFrameClock.after-paint/frame_time (presentation timestamps diagnostic only)"
    } else {
        "GdkFrameClock.after-paint/frame_time"
    };
    let timestamp = |sample: &FrameClockSample| -> u64 { sample.frame_time_us.max(0) as u64 };
    let mut intervals = Vec::with_capacity(samples.len().saturating_sub(1));
    let mut dropped_by_time = 0_u64;
    let mut dropped_by_counter = 0_u64;
    let refresh_us = samples
        .iter()
        .filter_map(|sample| sample.refresh_interval_us)
        .next()
        .unwrap_or(16_667);
    for pair in samples.windows(2) {
        let delta = timestamp(&pair[1]).saturating_sub(timestamp(&pair[0]));
        if delta > 0 {
            intervals.push(delta as f64 / 1_000.0);
            dropped_by_time +=
                (delta.saturating_add(refresh_us / 2) / refresh_us).saturating_sub(1);
        }
        dropped_by_counter += pair[1].counter.saturating_sub(pair[0].counter + 1).max(0) as u64;
    }
    PresentedFrames {
        samples: samples.len(),
        presentation_timestamps,
        interval_ms: distribution(intervals),
        dropped_frames: dropped_by_time.max(dropped_by_counter),
        refresh_interval_ms: refresh_us as f64 / 1_000.0,
        source,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSettings {
    hardware_acceleration_policy: String,
    accelerated_2d_canvas: bool,
    disable_dmabuf_renderer: bool,
    force_dmabuf_shm: bool,
    show_damage: bool,
    render_only: bool,
    run_label: String,
}

#[tauri::command]
pub(crate) fn a6_runtime_settings() -> RuntimeSettings {
    RuntimeSettings {
        hardware_acceleration_policy: env::var("FERNWORK_A6_HARDWARE_POLICY")
            .unwrap_or_else(|_| "on-demand".to_string()),
        accelerated_2d_canvas: env::var("FERNWORK_A6_ACCELERATED_2D").as_deref() != Ok("0"),
        disable_dmabuf_renderer: env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
        force_dmabuf_shm: env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_some(),
        show_damage: env::var_os("WEBKIT_SHOW_DAMAGE").is_some(),
        render_only: env::var_os("FERNWORK_A6_RENDER_ONLY").is_some(),
        run_label: env::var("FERNWORK_A6_RUN_LABEL").unwrap_or_else(|_| "manual".to_string()),
    }
}

#[tauri::command]
pub(crate) fn a6_write_result(result: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = env::var_os("FERNWORK_A6_RESULT")
        .map(PathBuf::from)
        .ok_or_else(|| "FERNWORK_A6_RESULT is not set".to_string())?;
    fs::write(path, result).map_err(|error| error.to_string())?;
    app.exit(0);
    Ok(())
}

/// Accepts the generated fixture as a raw IPC body; setup time is excluded from every result.
#[tauri::command]
pub(crate) fn a6_store_jpeg(request: Request<'_>, app: tauri::AppHandle) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("a6_store_jpeg requires a raw byte body".to_string());
    };
    let path = env::temp_dir().join(format!("fernwork-a6-{}.jpg", std::process::id()));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    app.fs_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn a6_store_capture(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("a6_store_capture requires a raw byte body".to_string());
    };
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Err("a6_store_capture requires PNG bytes".to_string());
    }
    let label = env::var("FERNWORK_A6_RUN_LABEL").unwrap_or_else(|_| "manual".to_string());
    if !label
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("FERNWORK_A6_RUN_LABEL contains unsafe filename characters".to_string());
    }
    let directory = env::var_os("FERNWORK_A6_RESULT")
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(env::temp_dir);
    let sequence = CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = directory.join(format!("canvas-{label}-{sequence}.png"));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDecodeReport {
    width: usize,
    height: usize,
    tile_count: usize,
    encoded_bytes: usize,
    rgba_bytes: usize,
    file_read_ms: f64,
    decode_and_ycbcr_ms: f64,
    rgb_to_rgba_ms: f64,
    tile_copy_ms: f64,
    binary_channel_ms: f64,
    native_total_ms: f64,
}

#[tauri::command]
pub(crate) async fn a6_decode_jpeg(
    path: String,
    on_tile: Channel<Response>,
) -> Result<NativeDecodeReport, String> {
    tauri::async_runtime::spawn_blocking(move || decode_and_stream_tiles(path, on_tile))
        .await
        .map_err(|error| error.to_string())?
}

/// One raw IPC response: a 40-byte little-endian header followed by row-major RGBA8.
#[tauri::command]
pub(crate) async fn a6_decode_jpeg_batch(path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || decode_jpeg_batch(path))
        .await
        .map_err(|error| error.to_string())?
        .map(Response::new)
}

fn decode_jpeg_batch(path: String) -> Result<Vec<u8>, String> {
    use zune_jpeg::{
        zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions},
        JpegDecoder,
    };

    let stage = Instant::now();
    let encoded = fs::read(path).map_err(|error| error.to_string())?;
    let file_us = stage.elapsed().as_micros() as u64;
    let stage = Instant::now();
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(encoded.as_slice()), options);
    let rgb = decoder.decode().map_err(|error| error.to_string())?;
    let (width, height) = decoder
        .dimensions()
        .ok_or_else(|| "zune-jpeg returned no dimensions".to_string())?;
    let decode_us = stage.elapsed().as_micros() as u64;
    if rgb.len() != width * height * 3 {
        return Err(format!("unexpected decoded byte count: {}", rgb.len()));
    }
    let stage = Instant::now();
    let rgba_len = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "decoded JPEG is too large".to_string())?;
    let mut response = vec![0_u8; BATCH_HEADER + rgba_len];
    for pixel in 0..width * height {
        let source = pixel * 3;
        let target = BATCH_HEADER + pixel * 4;
        response[target] = rgb[source];
        response[target + 1] = rgb[source + 1];
        response[target + 2] = rgb[source + 2];
        response[target + 3] = 255;
    }
    let rgba_us = stage.elapsed().as_micros() as u64;
    response[0..4].copy_from_slice(b"FWJ1");
    response[4..8].copy_from_slice(&(width as u32).to_le_bytes());
    response[8..12].copy_from_slice(&(height as u32).to_le_bytes());
    response[12..16].copy_from_slice(&(encoded.len() as u32).to_le_bytes());
    response[16..24].copy_from_slice(&file_us.to_le_bytes());
    response[24..32].copy_from_slice(&decode_us.to_le_bytes());
    response[32..40].copy_from_slice(&rgba_us.to_le_bytes());
    Ok(response)
}

fn decode_and_stream_tiles(
    path: String,
    on_tile: Channel<Response>,
) -> Result<NativeDecodeReport, String> {
    use zune_jpeg::{
        zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions},
        JpegDecoder,
    };

    let total_start = Instant::now();
    let stage = Instant::now();
    let encoded = fs::read(&path).map_err(|error| error.to_string())?;
    let file_read_ms = ms(stage.elapsed());

    let stage = Instant::now();
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(encoded.as_slice()), options);
    let rgb = decoder.decode().map_err(|error| error.to_string())?;
    let (width, height) = decoder
        .dimensions()
        .ok_or_else(|| "zune-jpeg returned no dimensions".to_string())?;
    let decode_and_ycbcr_ms = ms(stage.elapsed());
    if rgb.len() != width * height * 3 {
        return Err(format!("unexpected decoded byte count: {}", rgb.len()));
    }

    let stage = Instant::now();
    let mut rgba = vec![0_u8; width * height * 4];
    for pixel in 0..width * height {
        let source = pixel * 3;
        let target = pixel * 4;
        rgba[target] = rgb[source];
        rgba[target + 1] = rgb[source + 1];
        rgba[target + 2] = rgb[source + 2];
        rgba[target + 3] = 255;
    }
    let rgb_to_rgba_ms = ms(stage.elapsed());
    drop(rgb);

    let cols = width.div_ceil(TILE);
    let rows = height.div_ceil(TILE);
    let mut tile_copy_ms = 0.0;
    let channel_start = Instant::now();
    for row in 0..rows {
        for col in 0..cols {
            let copy_start = Instant::now();
            let tile_width = TILE.min(width - col * TILE);
            let tile_height = TILE.min(height - row * TILE);
            let mut tile = vec![0_u8; tile_width * tile_height * 4];
            for y in 0..tile_height {
                let source = ((row * TILE + y) * width + col * TILE) * 4;
                let target = y * tile_width * 4;
                tile[target..target + tile_width * 4]
                    .copy_from_slice(&rgba[source..source + tile_width * 4]);
            }
            tile_copy_ms += ms(copy_start.elapsed());
            on_tile
                .send(Response::new(tile))
                .map_err(|error| format!("binary tile channel failed: {error}"))?;
        }
    }
    let binary_channel_ms = ms(channel_start.elapsed()) - tile_copy_ms;
    let report = NativeDecodeReport {
        width,
        height,
        tile_count: cols * rows,
        encoded_bytes: encoded.len(),
        rgba_bytes: rgba.len(),
        file_read_ms,
        decode_and_ycbcr_ms,
        rgb_to_rgba_ms,
        tile_copy_ms,
        binary_channel_ms: binary_channel_ms.max(0.0),
        native_total_ms: ms(total_start.elapsed()),
    };
    Ok(report)
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn a6_capture_window(name: String, app: tauri::AppHandle) -> Result<String, String> {
    use gtk::prelude::*;

    if !name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("capture name must contain only letters, numbers, '-' or '_'".to_string());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let gdk_window = gtk_window
        .window()
        .ok_or_else(|| "GTK window is not realised".to_string())?;
    let width = gtk_window.allocated_width();
    let height = gtk_window.allocated_height();
    let pixbuf = gdk_window
        .pixbuf(0, 0, width, height)
        .ok_or_else(|| "GDK window capture failed".to_string())?;
    let bytes = pixbuf
        .save_to_bufferv("png", &[])
        .map_err(|error| error.to_string())?;
    let directory = env::var_os("FERNWORK_A6_RESULT")
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(env::temp_dir);
    let path = directory.join(format!("{name}.png"));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn a6_capture_window(_name: String, _app: tauri::AppHandle) -> Result<String, String> {
    Err("native capture is implemented only for the Linux A6 harness".to_string())
}

fn ms(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[cfg(target_os = "linux")]
pub(crate) fn configure_webkit(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use gtk::prelude::*;
    use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};

    let policy = match env::var("FERNWORK_A6_HARDWARE_POLICY").as_deref() {
        Ok("always") => HardwareAccelerationPolicy::Always,
        Ok("never") => HardwareAccelerationPolicy::Never,
        _ => HardwareAccelerationPolicy::OnDemand,
    };
    let accelerated_2d = env::var("FERNWORK_A6_ACCELERATED_2D").as_deref() != Ok("0");
    let probe = window.state::<FrameClockProbe>().inner().clone();
    window.with_webview(move |webview| {
        if let Some(settings) = WebViewExt::settings(&webview.inner()) {
            settings.set_hardware_acceleration_policy(policy);
            #[allow(deprecated)]
            settings.set_enable_accelerated_2d_canvas(accelerated_2d);
        }
        if let Some(clock) = webview.inner().frame_clock() {
            clock.connect_after_paint(move |clock| {
                let Ok(mut state) = probe.0.lock() else {
                    return;
                };
                if !state.active {
                    return;
                }
                let current_counter = clock.frame_counter();
                let timings = clock.current_timings();
                let previous = clock.timings(current_counter - 1);
                let measured = timings
                    .as_ref()
                    .filter(|value| value.presentation_time().is_some())
                    .or(previous.as_ref())
                    .or(timings.as_ref());
                state.samples.push(FrameClockSample {
                    counter: current_counter,
                    frame_time_us: clock.frame_time(),
                    presentation_time_us: measured
                        .and_then(|value| value.presentation_time())
                        .map(u64::from),
                    refresh_interval_us: measured
                        .and_then(|value| value.refresh_interval())
                        .map(u64::from),
                });
            });
        }
    })
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn configure_webkit(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Distribution {
    p95: f64,
    median: f64,
    max: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WgpuReport {
    adapter: String,
    backend: String,
    surface_width: u32,
    surface_height: u32,
    layer_size: u32,
    layers: usize,
    texture_mib: usize,
    frame_ms: Distribution,
    acquire_ms: Distribution,
    encode_submit_ms: Distribution,
    gpu_wait_ms: Distribution,
    present_call_ms: Distribution,
    note: &'static str,
}

/// Runs the surface prototype in a webview-free Tauri window.
pub(crate) fn run_wgpu() {
    tauri::Builder::default()
        .setup(|app| {
            let window = tauri::window::WindowBuilder::new(app, "a6-wgpu")
                .title("Fernwork A6 native wgpu spike")
                .inner_size(1440.0, 900.0)
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let result = tauri::async_runtime::block_on(wgpu_measure(window));
                let json = match result {
                    Ok(report) => serde_json::to_string_pretty(&report)
                        .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}")),
                    Err(error) => serde_json::json!({ "error": error }).to_string(),
                };
                if let Some(path) = env::var_os("FERNWORK_A6_RESULT") {
                    let _ = fs::write(path, json);
                }
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("A6 native wgpu spike failed");
}

async fn wgpu_measure(window: tauri::Window) -> Result<WgpuReport, String> {
    const LAYER_SIZE: u32 = 4096;
    const LAYERS: usize = 10;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let surface = instance
        .create_surface(window)
        .map_err(|error| error.to_string())?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
            apply_limit_buckets: false,
        })
        .await
        .map_err(|error| error.to_string())?;
    let info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("Fernwork A6 device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut config = surface
        .get_default_config(&adapter, size.width, size.height)
        .ok_or_else(|| "surface has no default configuration".to_string())?;
    config.present_mode = wgpu::PresentMode::Fifo;
    config.desired_maximum_frame_latency = 1;
    surface.configure(&device, &config);

    let texture_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("A6 texture layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    let view_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("A6 view layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let view_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("A6 pan zoom"),
        size: 16,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let view_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("A6 view bind group"),
        layout: &view_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: view_buffer.as_entire_binding(),
        }],
    });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("A6 linear sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let mut pixels = vec![0_u8; (LAYER_SIZE * LAYER_SIZE * 4) as usize];
    let mut texture_groups = Vec::with_capacity(LAYERS);
    let mut textures = Vec::with_capacity(LAYERS);
    for layer in 0..LAYERS {
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            let x = index % LAYER_SIZE as usize;
            let y = index / LAYER_SIZE as usize;
            pixel[0] = ((x * (layer + 1)) & 255) as u8;
            pixel[1] = ((y * (layer + 2)) & 255) as u8;
            pixel[2] = (((x ^ y) * (layer + 3)) & 255) as u8;
            pixel[3] = if layer == 0 { 255 } else { 176 };
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("A6 4096 layer"),
            size: wgpu::Extent3d {
                width: LAYER_SIZE,
                height: LAYER_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(LAYER_SIZE * 4),
                rows_per_image: Some(LAYER_SIZE),
            },
            wgpu::Extent3d {
                width: LAYER_SIZE,
                height: LAYER_SIZE,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([]);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| error.to_string())?;
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        texture_groups.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("A6 layer bind group"),
            layout: &texture_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        }));
        textures.push(texture);
    }
    drop(pixels);

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("A6 textured quad shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("a6_quad.wgsl").into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("A6 pipeline layout"),
        bind_group_layouts: &[Some(&view_layout), Some(&texture_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("A6 ten layer pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: config.format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let mut totals = Vec::new();
    let mut acquires = Vec::new();
    let mut submits = Vec::new();
    let mut waits = Vec::new();
    let mut presents = Vec::new();
    for frame in 0..105 {
        let total_start = Instant::now();
        let stage = Instant::now();
        let output = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                continue
            }
            state => return Err(format!("surface acquire failed: {state:?}")),
        };
        let acquire = ms(stage.elapsed());
        let zoom = 0.82 + (frame as f32 / 9.0).sin() * 0.08;
        let pan = (frame as f32 / 7.0).sin() * 0.03;
        let mut uniform = [0_u8; 16];
        for (index, value) in [pan, 0.0_f32, zoom, zoom].iter().enumerate() {
            uniform[index * 4..index * 4 + 4].copy_from_slice(&value.to_ne_bytes());
        }
        queue.write_buffer(&view_buffer, 0, &uniform);
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("A6 frame encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("A6 ten layer pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &view_group, &[]);
            for group in &texture_groups {
                pass.set_bind_group(1, group, &[]);
                pass.draw(0..6, 0..1);
            }
        }
        queue.submit([encoder.finish()]);
        let submit = ms(stage.elapsed()) - acquire;
        let stage = Instant::now();
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| error.to_string())?;
        let wait = ms(stage.elapsed());
        let stage = Instant::now();
        queue.present(output);
        let present = ms(stage.elapsed());
        if frame >= 15 {
            totals.push(ms(total_start.elapsed()));
            acquires.push(acquire);
            submits.push(submit.max(0.0));
            waits.push(wait);
            presents.push(present);
        }
    }

    Ok(WgpuReport {
        adapter: info.name,
        backend: format!("{:?}", info.backend),
        surface_width: size.width,
        surface_height: size.height,
        layer_size: LAYER_SIZE,
        layers: LAYERS,
        texture_mib: LAYERS * LAYER_SIZE as usize * LAYER_SIZE as usize * 4 / 1_048_576,
        frame_ms: distribution(totals),
        acquire_ms: distribution(acquires),
        encode_submit_ms: distribution(submits),
        gpu_wait_ms: distribution(waits),
        present_call_ms: distribution(presents),
        note: "90 measured frames after 15 warm-up frames; FIFO surface, maximum frame latency 1; each frame draws ten 4096x4096 RGBA textured quads with source-alpha blending.",
    })
}

fn distribution(mut values: Vec<f64>) -> Distribution {
    values.sort_by(f64::total_cmp);
    let index = |fraction: f64| {
        ((values.len().saturating_sub(1) as f64 * fraction).ceil() as usize)
            .min(values.len().saturating_sub(1))
    };
    Distribution {
        p95: values.get(index(0.95)).copied().unwrap_or(0.0),
        median: values.get(index(0.5)).copied().unwrap_or(0.0),
        max: values.last().copied().unwrap_or(0.0),
    }
}
