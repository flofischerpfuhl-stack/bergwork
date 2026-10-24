use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawOptions {
    exposure: Option<f64>,
    white_balance: Option<String>,
    temperature: Option<f64>,
    tint: Option<f64>,
    highlight_recovery: Option<bool>,
}

#[derive(Debug)]
pub struct RawImage {
    width: u32,
    height: u32,
    rgba: Vec<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBinaryHeader {
    options: RawOptions,
    allow_system_libraw: bool,
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{RawImage, RawOptions};
    use libloading::{Library, Symbol};
    use std::{ffi::{c_int, c_uint, c_void}, sync::OnceLock};

    const CANDIDATES: &[&str] = &["libraw.so.23", "libraw.so.22", "libraw.so.21", "libraw.so.20", "libraw.so"];
    type Init = unsafe extern "C" fn(c_uint) -> *mut c_void;
    type OpenBuffer = unsafe extern "C" fn(*mut c_void, *const c_void, usize) -> c_int;
    type Simple = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Close = unsafe extern "C" fn(*mut c_void);
    type SetInt = unsafe extern "C" fn(*mut c_void, c_int);
    type SetFloat = unsafe extern "C" fn(*mut c_void, f32);
    type SetGamma = unsafe extern "C" fn(*mut c_void, c_int, f32);
    type GetMul = unsafe extern "C" fn(*mut c_void, c_int) -> f32;
    type SetMul = unsafe extern "C" fn(*mut c_void, c_int, f32);

    #[repr(C)]
    struct ProcessedImage {
        image_type: c_int,
        height: u16,
        width: u16,
        colors: u16,
        bits: u16,
        data_size: c_uint,
        data: [u8; 1],
    }
    type MakeImage = unsafe extern "C" fn(*mut c_void, *mut c_int) -> *mut ProcessedImage;
    type ClearImage = unsafe extern "C" fn(*mut ProcessedImage);

    fn library() -> Result<&'static Library, String> {
        static LIBRARY: OnceLock<Result<Library, String>> = OnceLock::new();
        LIBRARY.get_or_init(|| {
            for name in CANDIDATES {
                // SAFETY: loading is explicitly user-enabled. Keep the handle for process lifetime: some LibRaw builds
                // retain an OpenMP worker pool after processing, so dlclose would invalidate its worker entry points.
                if let Ok(value) = unsafe { Library::new(name) } { return Ok(value); }
            }
            Err("System LibRaw was not found. Install your distribution’s LibRaw package (for example `libraw23`) and try again.".into())
        }).as_ref().map_err(Clone::clone)
    }

    pub fn available() -> bool { library().is_ok() }

    pub fn decode(bytes: &[u8], options: &RawOptions) -> Result<RawImage, String> {
        let lib = library()?;
        // SAFETY: each signature below is the stable LibRaw C API. The input remains alive until libraw_close,
        // and the processed buffer is copied before libraw_dcraw_clear_mem.
        unsafe {
            let init: Symbol<Init> = lib.get(b"libraw_init\0").map_err(|e| e.to_string())?;
            let open: Symbol<OpenBuffer> = lib.get(b"libraw_open_buffer\0").map_err(|e| e.to_string())?;
            let unpack: Symbol<Simple> = lib.get(b"libraw_unpack\0").map_err(|e| e.to_string())?;
            let process: Symbol<Simple> = lib.get(b"libraw_dcraw_process\0").map_err(|e| e.to_string())?;
            let make: Symbol<MakeImage> = lib.get(b"libraw_dcraw_make_mem_image\0").map_err(|e| e.to_string())?;
            let clear: Symbol<ClearImage> = lib.get(b"libraw_dcraw_clear_mem\0").map_err(|e| e.to_string())?;
            let close: Symbol<Close> = lib.get(b"libraw_close\0").map_err(|e| e.to_string())?;
            let set_bps: Symbol<SetInt> = lib.get(b"libraw_set_output_bps\0").map_err(|e| e.to_string())?;
            let set_color: Symbol<SetInt> = lib.get(b"libraw_set_output_color\0").map_err(|e| e.to_string())?;
            let set_demosaic: Symbol<SetInt> = lib.get(b"libraw_set_demosaic\0").map_err(|e| e.to_string())?;
            let no_auto: Symbol<SetInt> = lib.get(b"libraw_set_no_auto_bright\0").map_err(|e| e.to_string())?;
            let set_highlight: Symbol<SetInt> = lib.get(b"libraw_set_highlight\0").map_err(|e| e.to_string())?;
            let set_bright: Symbol<SetFloat> = lib.get(b"libraw_set_bright\0").map_err(|e| e.to_string())?;
            let set_gamma: Symbol<SetGamma> = lib.get(b"libraw_set_gamma\0").map_err(|e| e.to_string())?;
            let get_cam_mul: Symbol<GetMul> = lib.get(b"libraw_get_cam_mul\0").map_err(|e| e.to_string())?;
            let get_pre_mul: Symbol<GetMul> = lib.get(b"libraw_get_pre_mul\0").map_err(|e| e.to_string())?;
            let set_user_mul: Symbol<SetMul> = lib.get(b"libraw_set_user_mul\0").map_err(|e| e.to_string())?;
            let raw = init(0);
            if raw.is_null() { return Err("LibRaw could not allocate a decoder.".into()); }
            struct Guard(*mut c_void, Close);
            impl Drop for Guard { fn drop(&mut self) { unsafe { (self.1)(self.0) } } }
            let _guard = Guard(raw, *close);
            let status = open(raw, bytes.as_ptr().cast(), bytes.len());
            if status != 0 { return Err(format!("LibRaw could not open this camera file (error {status}).")); }
            let status = unpack(raw);
            if status != 0 { return Err(format!("LibRaw could not unpack this camera file (error {status}).")); }
            // Linear ProPhoto RGB preserves the developed gamut. The frontend then runs this through the same
            // Little CMS transform as tagged 16-bit PNG/TIFF instead of accepting LibRaw's private sRGB conversion.
            set_bps(raw, 16); set_color(raw, 4); set_demosaic(raw, 3); no_auto(raw, 1); // ProPhoto, AHD, no hidden exposure
            set_gamma(raw, 0, 1.0); set_gamma(raw, 1, 1.0);
            set_highlight(raw, if options.highlight_recovery.unwrap_or(true) { 3 } else { 0 });
            set_bright(raw, 2.0_f32.powf(options.exposure.unwrap_or(0.0).clamp(-5.0, 5.0) as f32));
            let mode = options.white_balance.as_deref().unwrap_or("as-shot");
            for channel in 0..4 {
                let multiplier = if mode == "auto" { get_pre_mul(raw, channel) }
                    else if mode == "custom" {
                        let kelvin = options.temperature.unwrap_or(6500.0).clamp(2000.0, 12000.0) as f32;
                        let tint = options.tint.unwrap_or(0.0).clamp(-150.0, 150.0) as f32;
                        match channel { 0 => 6500.0 / kelvin, 1 => 2.0_f32.powf(tint / 300.0), 2 => kelvin / 6500.0, _ => 1.0 }
                    } else { get_cam_mul(raw, channel) };
                if multiplier.is_finite() && multiplier > 0.0 { set_user_mul(raw, channel, multiplier); }
            }
            let status = process(raw);
            if status != 0 { return Err(format!("LibRaw could not develop this camera file (error {status}).")); }
            let mut image_error = 0;
            let image = make(raw, &mut image_error);
            if image.is_null() { return Err(format!("LibRaw produced no image (error {image_error}).")); }
            struct ImageGuard(*mut ProcessedImage, ClearImage);
            impl Drop for ImageGuard { fn drop(&mut self) { unsafe { (self.1)(self.0) } } }
            let _image_guard = ImageGuard(image, *clear);
            let value = &*image;
            if value.image_type != 2 || value.bits != 16 || value.colors < 3 { return Err("LibRaw did not produce a 16-bit RGB bitmap.".into()); }
            let pixels = value.width as usize * value.height as usize;
            let required = pixels.checked_mul(value.colors as usize).and_then(|v| v.checked_mul(2)).ok_or("RAW image is too large")?;
            if required > value.data_size as usize { return Err("LibRaw returned a truncated bitmap.".into()); }
            let source = std::slice::from_raw_parts(value.data.as_ptr(), required);
            let mut rgba = vec![0u16; pixels * 4];
            for p in 0..pixels {
                for c in 0..3 { rgba[p * 4 + c] = u16::from_ne_bytes([source[(p * value.colors as usize + c) * 2], source[(p * value.colors as usize + c) * 2 + 1]]); }
                rgba[p * 4 + 3] = u16::MAX;
            }
            Ok(RawImage { width: value.width as u32, height: value.height as u32, rgba })
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{RawImage, RawOptions};
    use std::ptr::null;
    use windows::core::Interface;
    use windows::Win32::Graphics::Imaging::{CLSID_WICImagingFactory, GUID_WICPixelFormat64bppRGBA,
        IWICBitmapSource, IWICDevelopRaw, IWICImagingFactory, WICAsShotParameterSet, WICAutoAdjustedParameterSet,
        WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad, WICRawRenderModeBestQuality,
        WICUserAdjustedParameterSet};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    pub fn available() -> bool { true }

    pub fn decode(bytes: &[u8], options: &RawOptions) -> Result<RawImage, String> {
        // WIC's installed RAW codec performs camera colour conversion. Microsoft's Raw Image Extension supplies codecs
        // for current cameras without adding a redistributable library to Fernwork.
        unsafe {
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            struct ComGuard(bool); impl Drop for ComGuard { fn drop(&mut self) { if self.0 { unsafe { CoUninitialize() } } } }
            let _com = ComGuard(initialized);
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| "Windows Imaging Component is unavailable.".to_string())?;
            let stream = factory.CreateStream().map_err(|e| e.to_string())?;
            stream.InitializeFromMemory(bytes).map_err(|e| e.to_string())?;
            let decoder = factory.CreateDecoderFromStream(&stream, null(), WICDecodeMetadataCacheOnLoad)
                .map_err(|_| "Windows has no codec for this camera RAW. Install Microsoft Raw Image Extension and try again.".to_string())?;
            let frame = decoder.GetFrame(0).map_err(|e| e.to_string())?;
            let developed = frame.cast::<IWICDevelopRaw>().map_err(|_| "The installed WIC codec does not expose RAW development controls.".to_string())?;
            let mode = options.white_balance.as_deref().unwrap_or("as-shot");
            developed.LoadParameterSet(if mode == "auto" { WICAutoAdjustedParameterSet } else if mode == "custom" { WICUserAdjustedParameterSet } else { WICAsShotParameterSet }).map_err(|e| e.to_string())?;
            developed.SetRenderMode(WICRawRenderModeBestQuality).map_err(|e| e.to_string())?;
            developed.SetExposureCompensation(options.exposure.unwrap_or(0.0).clamp(-5.0, 5.0)).map_err(|e| e.to_string())?;
            if mode == "custom" {
                developed.SetWhitePointKelvin(options.temperature.unwrap_or(6500.0).clamp(2000.0, 12000.0) as u32).map_err(|e| e.to_string())?;
                developed.SetTint(options.tint.unwrap_or(0.0).clamp(-150.0, 150.0)).map_err(|e| e.to_string())?;
            }
            let converter = factory.CreateFormatConverter().map_err(|e| e.to_string())?;
            converter.Initialize(&developed, &GUID_WICPixelFormat64bppRGBA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
                .map_err(|e| format!("The WIC RAW codec cannot produce 16-bit RGBA: {e}"))?;
            let source: IWICBitmapSource = converter.cast().map_err(|e| e.to_string())?;
            let (mut width, mut height) = (0, 0); source.GetSize(&mut width, &mut height).map_err(|e| e.to_string())?;
            let stride = width.checked_mul(8).ok_or("RAW image is too wide")?;
            let size = stride.checked_mul(height).ok_or("RAW image is too large")? as usize;
            let mut packed = vec![0u8; size]; source.CopyPixels(null(), stride, &mut packed).map_err(|e| e.to_string())?;
            let mut rgba = Vec::with_capacity(size / 2);
            for pair in packed.chunks_exact(2) { rgba.push(u16::from_le_bytes([pair[0], pair[1]])); }
            if options.highlight_recovery.unwrap_or(true) {
                for pixel in rgba.chunks_exact_mut(4) {
                    let maximum = pixel[0].max(pixel[1]).max(pixel[2]);
                    if maximum == u16::MAX { // Basic hue-preserving shoulder for clipped WIC output.
                        let scale = 65534.0 / maximum as f64;
                        for channel in &mut pixel[..3] { *channel = (*channel as f64 * scale).round() as u16; }
                    }
                }
            }
            Ok(RawImage { width, height, rgba })
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod platform {
    use super::{RawImage, RawOptions};
    pub fn available() -> bool { false }
    pub fn decode(_: &[u8], _: &RawOptions) -> Result<RawImage, String> { Err("Camera RAW decoding is unavailable on this platform.".into()) }
}

#[tauri::command]
pub fn raw_codec_available() -> bool { platform::available() }

/** Binary IPC avoids serialising camera files and 16-bit output as millions of JSON numbers. */
#[tauri::command]
pub fn decode_raw_binary(request: Request<'_>) -> Result<Response, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("decode_raw_binary needs a binary IPC body".into()),
    };
    if body.len() < 4 { return Err("truncated RAW request".into()); }
    let header_length = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    if header_length > 64 * 1024 || body.len() < 4 + header_length {
        return Err("invalid RAW request header".into());
    }
    let header: RawBinaryHeader = serde_json::from_slice(&body[4..4 + header_length])
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    if !header.allow_system_libraw { return Ok(Response::new(Vec::new())); }
    #[cfg(not(target_os = "linux"))]
    let _ = header.allow_system_libraw;
    let image = platform::decode(&body[4 + header_length..], &header.options)?;
    let mut output = Vec::with_capacity(8 + image.rgba.len() * 2);
    output.extend_from_slice(&image.width.to_le_bytes());
    output.extend_from_slice(&image.height.to_le_bytes());
    for sample in image.rgba { output.extend_from_slice(&sample.to_le_bytes()); }
    Ok(Response::new(output))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[derive(Clone)]
    struct Field { tag: u16, kind: u16, count: u32, bytes: Vec<u8> }
    fn short(tag: u16, values: &[u16]) -> Field { Field { tag, kind: 3, count: values.len() as u32,
        bytes: values.iter().flat_map(|v| v.to_le_bytes()).collect() } }
    fn long(tag: u16, values: &[u32]) -> Field { Field { tag, kind: 4, count: values.len() as u32,
        bytes: values.iter().flat_map(|v| v.to_le_bytes()).collect() } }
    fn byte(tag: u16, values: &[u8]) -> Field { Field { tag, kind: 1, count: values.len() as u32, bytes: values.to_vec() } }
    fn rational(tag: u16, values: &[f64], signed: bool) -> Field {
        let mut bytes = Vec::new();
        for value in values {
            let numerator = (value * 1_000_000.0).round() as i32;
            bytes.extend_from_slice(&numerator.to_le_bytes()); bytes.extend_from_slice(&1_000_000_i32.to_le_bytes());
        }
        Field { tag, kind: if signed { 10 } else { 5 }, count: values.len() as u32, bytes }
    }
    fn generated_dng() -> Vec<u8> {
        const W: usize = 64; const H: usize = 64;
        let matrix = [3.1338560476, -1.6168664939, -0.4906147860, -0.9787682523, 1.9161413676,
            0.0334540738, 0.0719452886, -0.2289913726, 1.4052426768];
        let mut image = Vec::with_capacity(W * H * 2);
        let pattern = [0usize, 1, 1, 2];
        let patches = [[0.72, 0.015, 0.012], [0.015, 0.68, 0.018], [0.012, 0.018, 0.74]];
        for y in 0..H { for x in 0..W {
            let patch = patches[(x * 3 / W).min(2)];
            let value = (patch[pattern[(y & 1) * 2 + (x & 1)]] * 65535.0_f64).round() as u16;
            image.extend_from_slice(&value.to_le_bytes());
        }}
        let mut fields = vec![long(256, &[W as u32]), long(257, &[H as u32]), short(258, &[16]), short(259, &[1]),
            short(262, &[32803]), long(273, &[0]), short(274, &[1]), short(277, &[1]), long(278, &[H as u32]),
            long(279, &[image.len() as u32]), short(284, &[1]), short(33421, &[2, 2]), byte(33422, &[0, 1, 1, 2]),
            byte(50706, &[1, 4, 0, 0]), rational(50714, &[0.0], false), long(50717, &[65535]),
            rational(50721, &matrix, true), rational(50728, &[1.0, 1.0, 1.0], false)];
        fields.sort_by_key(|field| field.tag);
        let ifd_bytes = 2 + fields.len() * 12 + 4;
        let extra_bytes: usize = fields.iter().filter(|field| field.bytes.len() > 4).map(|field| field.bytes.len()).sum();
        let image_offset = 8 + ifd_bytes + extra_bytes;
        fields.iter_mut().find(|field| field.tag == 273).unwrap().bytes = (image_offset as u32).to_le_bytes().to_vec();
        let mut output = vec![0u8; image_offset + image.len()]; output[..8].copy_from_slice(&[0x49, 0x49, 42, 0, 8, 0, 0, 0]);
        output[8..10].copy_from_slice(&(fields.len() as u16).to_le_bytes());
        let mut extra_at = 8 + ifd_bytes;
        for (index, field) in fields.iter().enumerate() {
            let at = 10 + index * 12;
            output[at..at + 2].copy_from_slice(&field.tag.to_le_bytes());
            output[at + 2..at + 4].copy_from_slice(&field.kind.to_le_bytes());
            output[at + 4..at + 8].copy_from_slice(&field.count.to_le_bytes());
            if field.bytes.len() <= 4 { output[at + 8..at + 8 + field.bytes.len()].copy_from_slice(&field.bytes); }
            else {
                output[at + 8..at + 12].copy_from_slice(&(extra_at as u32).to_le_bytes());
                output[extra_at..extra_at + field.bytes.len()].copy_from_slice(&field.bytes); extra_at += field.bytes.len();
            }
        }
        output[image_offset..].copy_from_slice(&image); output
    }

    #[test]
    fn system_libraw_path_is_exercised_when_installed() {
        if !super::platform::available() { eprintln!("skipped: no system LibRaw installed"); return; }
        let image = super::platform::decode(&generated_dng(), &Default::default()).expect("system LibRaw decodes generated DNG");
        assert_eq!((image.width, image.height, image.rgba.len()), (64, 64, 64 * 64 * 4));
        let red = &image.rgba[(32 * 64 + 8) * 4..][..3];
        let green = &image.rgba[(32 * 64 + 32) * 4..][..3];
        let blue = &image.rgba[(32 * 64 + 56) * 4..][..3];
        assert!(red[0] > red[1] * 2 && green[1] > green[0] * 2 && blue[2] > blue[1] * 2,
            "unexpected developed patches: {red:?} {green:?} {blue:?}");
    }
}
