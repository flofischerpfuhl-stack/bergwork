//! Portable hardware identity, capabilities, quirks, and resource policy for document editors.
//!
//! The policy core is WASM-safe. Read-only host probes are compiled only for native targets and
//! do not participate in policy decisions once an inventory snapshot has been captured.

#![deny(missing_docs, rust_2018_idioms, unsafe_op_in_unsafe_fn)]
#![forbid(unsafe_code)]

mod compute;
mod contracts;
mod generated_quirks;
mod quirks;

#[cfg(not(target_arch = "wasm32"))]
pub mod native;

pub use compute::{
    adaptive_job_concurrency, available_compute_backends, default_job_concurrency,
    derive_compute_budget, derive_memory_budget, memory_os_ui_reserve_bytes,
    usable_compute_memory_bytes, BackendResourcePlan, DocumentMemoryBudget,
};
pub use contracts::{
    ComputeAccelerator, ComputeBackend, CpuCapabilities, DeviceCapabilities, DeviceFeature,
    DeviceKind, GraphicsAdapterIdentity, HardwareIdentity, HardwareInventory, HostArchitecture,
    HostOperatingSystem, MemoryCapabilities, RendererBackend, WebViewRuntime,
};
pub use quirks::{
    matching_quirks, resolve_quirks, reviewed_quirks, HardwareQuirk, HardwareQuirkActions,
    HardwareQuirkFacts, HardwareQuirkMatch, HardwareQuirkResolution, HardwareQuirkValidationError,
    HardwareQuirkVersion,
};
