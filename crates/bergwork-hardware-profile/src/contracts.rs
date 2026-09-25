use serde::{Deserialize, Serialize};

/// Host operating system relevant to probing and reviewed quirks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostOperatingSystem {
    /// Microsoft Windows.
    Windows,
    /// Desktop Linux.
    Linux,
    /// Android, including desktop-class Googlebooks.
    Android,
    /// Apple macOS, retained for portable policy consumers.
    #[serde(rename = "macos")]
    MacOs,
    /// A host not known by this version of the module.
    Other,
}

/// CPU architecture relevant to native artifacts and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostArchitecture {
    /// 64-bit x86.
    #[serde(rename = "x86_64")]
    X86_64,
    /// 64-bit Arm.
    #[serde(rename = "aarch64")]
    Aarch64,
    /// Another architecture.
    Other,
}

/// Embedded browser runtime used by a berg:work shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebViewRuntime {
    /// Microsoft Edge `WebView2` on Windows.
    #[serde(rename = "webview2")]
    WebView2,
    /// `WebKitGTK` on Linux.
    #[serde(rename = "webkitgtk")]
    WebKitGtk,
    /// Android System `WebView`.
    #[serde(rename = "android-webview")]
    AndroidWebView,
    /// Electron, if it is selected as a desktop fallback in the future.
    Electron,
    /// A regular browser or an otherwise unknown runtime.
    Other,
}

/// Stable host identity. Human-readable names are diagnostic and never policy keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareIdentity {
    /// Host operating system.
    pub operating_system: HostOperatingSystem,
    /// Native CPU architecture.
    pub architecture: HostArchitecture,
    /// Product model when the OS exposes one.
    pub device_model: Option<String>,
    /// Human-readable CPU name for diagnostics.
    pub cpu_name: Option<String>,
}

/// CPU inventory used for compute scheduling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuCapabilities {
    /// Physical core count, or the best conservative estimate available.
    pub physical_cores: u16,
    /// Logical processor count available to this process.
    pub logical_cores: u16,
    /// Whether AVX2 instructions are available on x86.
    pub supports_avx2: bool,
}

/// Memory snapshot used to derive bounded caches and compute jobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCapabilities {
    /// Physical memory visible to the operating system.
    pub physical_bytes: u64,
    /// Memory currently available without swapping, when known.
    pub available_bytes: Option<u64>,
}

/// Renderer selected for an editor surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RendererBackend {
    /// WebGPU.
    #[serde(rename = "webgpu")]
    WebGpu,
    /// WebGL 2.
    #[serde(rename = "webgl2")]
    WebGl2,
    /// CPU-backed canvas or another software rasterizer.
    Software,
}

/// Broad graphics-device class used by capability policy and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    /// Discrete GPU with dedicated memory.
    DiscreteGpu,
    /// Integrated or unified-memory GPU.
    IntegratedGpu,
    /// Virtualized GPU.
    VirtualGpu,
    /// CPU or software adapter.
    Cpu,
    /// Adapter class was not reported.
    Other,
}

/// Structured graphics adapter identity for diagnostics and reviewed quirk matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsAdapterIdentity {
    /// Human-readable adapter name for diagnostics only.
    pub name: String,
    /// Numeric PCI vendor identifier, when exposed.
    pub vendor_id: Option<u32>,
    /// Numeric PCI device identifier, when exposed.
    pub device_id: Option<u32>,
    /// Driver name, when exposed.
    pub driver: Option<String>,
    /// Driver version or implementation detail, when exposed.
    pub driver_version: Option<String>,
}

/// Optional device feature used to select fast or compatible document paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceFeature {
    /// General compute shaders are available.
    ComputeShaders,
    /// Fragment shaders may write storage resources.
    FragmentWritableStorage,
    /// Half-float textures can be filtered and blended.
    Float16Textures,
    /// GPU timestamp queries are available and reliable.
    TimestampQueries,
    /// BC-family block-compressed textures are available.
    TextureCompressionBc,
    /// ETC2/EAC block-compressed textures are available.
    TextureCompressionEtc2,
    /// ASTC block-compressed textures are available.
    TextureCompressionAstc,
}

/// Measured capabilities of the adapter actually used by one editor surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    /// Structured adapter identity.
    pub adapter: GraphicsAdapterIdentity,
    /// Physical device class.
    pub device_kind: DeviceKind,
    /// Active renderer backend.
    pub backend: RendererBackend,
    /// Whether the API identified this as a fallback/software adapter.
    pub is_fallback_adapter: bool,
    /// Supported optional features.
    pub features: Vec<DeviceFeature>,
    /// Maximum two-dimensional texture edge.
    pub max_texture_dimension_2d: u32,
    /// Maximum buffer size in bytes, when meaningful for this backend.
    pub max_buffer_size: u64,
    /// Dedicated graphics memory, when the platform exposes it.
    pub dedicated_memory_bytes: Option<u64>,
}

impl DeviceCapabilities {
    /// Returns whether an optional feature is available.
    #[must_use]
    pub fn supports(&self, feature: DeviceFeature) -> bool {
        self.features.contains(&feature)
    }

    /// Returns true only for a GPU backend on a non-fallback adapter.
    #[must_use]
    pub const fn is_hardware_accelerated(&self) -> bool {
        !self.is_fallback_adapter && !matches!(self.backend, RendererBackend::Software)
    }
}

/// Compute backend exposed by a packaged native or WASM implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputeBackend {
    /// A platform NPU execution provider.
    #[serde(rename = "npu")]
    Npu,
    /// Windows `DirectML`.
    #[serde(rename = "directml")]
    DirectMl,
    /// Android Neural Networks API.
    #[serde(rename = "nnapi")]
    Nnapi,
    /// Apple Core ML.
    #[serde(rename = "coreml")]
    CoreMl,
    /// NVIDIA CUDA.
    Cuda,
    /// Vulkan compute.
    Vulkan,
    /// CPU execution.
    Cpu,
}

/// One observed compute accelerator. Names are diagnostic and not policy inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeAccelerator {
    /// Backend implemented by the packaged runtime.
    pub backend: ComputeBackend,
    /// Human-readable accelerator or execution-provider name.
    pub name: String,
    /// Dedicated memory when the provider exposes it.
    pub dedicated_memory_bytes: Option<u64>,
}

/// Immutable snapshot consumed by all resource policy functions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInventory {
    /// Stable host identity.
    pub identity: HardwareIdentity,
    /// CPU capabilities.
    pub cpu: CpuCapabilities,
    /// Physical and currently available memory.
    pub memory: MemoryCapabilities,
    /// Graphics adapters observed by the host or renderer.
    pub graphics_adapters: Vec<GraphicsAdapterIdentity>,
    /// Available native compute providers.
    pub compute_accelerators: Vec<ComputeAccelerator>,
}
