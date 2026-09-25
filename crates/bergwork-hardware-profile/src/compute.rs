//! Deterministic memory and compute budget derivation for large 2D documents.

use serde::{Deserialize, Serialize};

use crate::{
    ComputeBackend, HardwareInventory, MemoryCapabilities, RendererBackend, WebViewRuntime,
};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// Memory ceilings consumed by tile, texture, scratch, and model owners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMemoryBudget {
    /// Total memory that berg:work may actively budget after OS/UI and running-job holds.
    pub usable_bytes: u64,
    /// Maximum decoded document-tile residency.
    pub tile_cache_bytes: u64,
    /// Maximum GPU texture residency.
    pub gpu_texture_bytes: u64,
    /// Maximum in-memory scratch and staging data.
    pub scratch_bytes: u64,
    /// Maximum model and inference working set.
    pub model_working_set_bytes: u64,
    /// Preferred square texture chunk edge.
    pub texture_chunk_edge: u32,
}

/// Hardware-sensitive limits for one compute backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendResourcePlan {
    /// Backend receiving these limits.
    pub backend: ComputeBackend,
    /// Tile edge in pixels.
    pub tile_edge_pixels: u32,
    /// Batch size.
    pub batch_size: u16,
    /// Maximum concurrent workers.
    pub max_concurrency: u16,
    /// CPU threads assigned per worker.
    pub cpu_threads_per_worker: u16,
    /// Maximum memory held by one worker.
    pub memory_per_worker_bytes: u64,
}

/// Returns available compute backends in capability-based preference order.
#[must_use]
pub fn available_compute_backends(inventory: &HardwareInventory) -> Vec<ComputeBackend> {
    const ORDER: [ComputeBackend; 6] = [
        ComputeBackend::Npu,
        ComputeBackend::DirectMl,
        ComputeBackend::Nnapi,
        ComputeBackend::CoreMl,
        ComputeBackend::Cuda,
        ComputeBackend::Vulkan,
    ];
    let mut result = Vec::with_capacity(inventory.compute_accelerators.len() + 1);
    for backend in ORDER {
        if inventory
            .compute_accelerators
            .iter()
            .any(|candidate| candidate.backend == backend)
        {
            result.push(backend);
        }
    }
    result.push(ComputeBackend::Cpu);
    result
}

/// Derives tile, batch, concurrency, and per-worker memory limits for one backend.
#[must_use]
pub fn derive_compute_budget(
    backend: ComputeBackend,
    inventory: &HardwareInventory,
    running_holds: u64,
) -> BackendResourcePlan {
    let host_usable = usable_compute_memory_bytes(inventory.memory, running_holds);
    let accelerator_memory = inventory
        .compute_accelerators
        .iter()
        .find(|candidate| candidate.backend == backend)
        .and_then(|candidate| candidate.dedicated_memory_bytes);
    let usable_bytes = accelerator_memory.unwrap_or(host_usable);
    let (tile_edge_pixels, batch_size, memory_concurrency) = if usable_bytes >= 16 * GIB {
        (4_096, 8, 8)
    } else if usable_bytes >= 8 * GIB {
        (3_072, 4, 4)
    } else if usable_bytes >= 4 * GIB {
        (2_048, 2, 2)
    } else {
        (1_024, 1, 1)
    };
    let logical_cores = inventory.cpu.logical_cores.max(1);
    let max_concurrency = memory_concurrency.min(logical_cores).max(1);
    let cpu_threads_per_worker = (logical_cores / max_concurrency).max(1);
    BackendResourcePlan {
        backend,
        tile_edge_pixels,
        batch_size,
        max_concurrency,
        cpu_threads_per_worker,
        memory_per_worker_bytes: usable_bytes / u64::from(max_concurrency),
    }
}

/// Derives cache ceilings for a document session without imposing a document-pixel limit.
///
/// The `WebKitGTK` caps preserve the image editor's measured 512 MiB tile/texture limits and
/// 1024-pixel texture chunks. Large documents continue to stream through scratch storage.
#[must_use]
pub fn derive_memory_budget(
    memory: MemoryCapabilities,
    dedicated_gpu_memory: Option<u64>,
    renderer: RendererBackend,
    runtime: WebViewRuntime,
    running_holds: u64,
) -> DocumentMemoryBudget {
    let usable = usable_compute_memory_bytes(memory, running_holds);
    let mut tile_cache = usable.saturating_mul(35) / 100;
    let mut gpu_texture = if renderer == RendererBackend::Software {
        0
    } else {
        dedicated_gpu_memory
            .map_or(usable / 5, |bytes| bytes / 2)
            .min(usable / 3)
    };
    let mut texture_chunk_edge = 2_048;
    if runtime == WebViewRuntime::WebKitGtk {
        tile_cache = tile_cache.min(512 * MIB);
        gpu_texture = gpu_texture.min(512 * MIB);
        texture_chunk_edge = 1_024;
    }
    DocumentMemoryBudget {
        usable_bytes: usable,
        tile_cache_bytes: tile_cache,
        gpu_texture_bytes: gpu_texture,
        scratch_bytes: usable.saturating_mul(30) / 100,
        model_working_set_bytes: usable.saturating_mul(20) / 100,
        texture_chunk_edge,
    }
}

/// OS/UI reserve deducted before document and compute budgets are assigned.
#[must_use]
pub const fn memory_os_ui_reserve_bytes(physical_memory_bytes: u64) -> u64 {
    let proportional = physical_memory_bytes / 8;
    let fixed = 4 * GIB;
    if fixed > proportional {
        fixed
    } else {
        proportional
    }
}

/// Remaining memory after current availability, OS/UI reserve, and running-job holds.
#[must_use]
pub const fn usable_compute_memory_bytes(memory: MemoryCapabilities, running_holds: u64) -> u64 {
    let after_reserve = memory
        .physical_bytes
        .saturating_sub(memory_os_ui_reserve_bytes(memory.physical_bytes));
    let available = match memory.available_bytes {
        Some(bytes) if bytes < after_reserve => bytes,
        _ => after_reserve,
    };
    available.saturating_sub(running_holds)
}

/// Default job concurrency derived from CPU topology, with a conservative 1..8 ceiling.
#[must_use]
pub fn default_job_concurrency(logical_cpus: usize, physical_cpus: usize) -> usize {
    physical_cpus
        .max(1)
        .min(logical_cpus.max(1))
        .div_ceil(2)
        .clamp(1, 8)
}

/// Combined CPU and memory concurrency policy for heavyweight OCR and model jobs.
#[must_use]
pub fn adaptive_job_concurrency(
    logical_cpus: usize,
    physical_cpus: usize,
    memory: MemoryCapabilities,
    running_holds: u64,
) -> usize {
    const RESERVED_PER_COMPUTE_JOB: u64 = 4 * GIB;
    let cpu_slots = default_job_concurrency(logical_cpus, physical_cpus);
    let memory_slots = usable_compute_memory_bytes(memory, running_holds)
        .checked_div(RESERVED_PER_COMPUTE_JOB)
        .unwrap_or(0)
        .max(1);
    cpu_slots
        .min(usize::try_from(memory_slots).unwrap_or(usize::MAX))
        .clamp(1, 8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ComputeAccelerator, CpuCapabilities, HardwareIdentity, HostArchitecture,
        HostOperatingSystem,
    };

    fn inventory() -> HardwareInventory {
        HardwareInventory {
            identity: HardwareIdentity {
                operating_system: HostOperatingSystem::Android,
                architecture: HostArchitecture::Aarch64,
                device_model: Some("test Googlebook".into()),
                cpu_name: None,
            },
            memory: MemoryCapabilities {
                physical_bytes: 32 * GIB,
                available_bytes: Some(18 * GIB),
            },
            cpu: CpuCapabilities {
                physical_cores: 8,
                logical_cores: 12,
                supports_avx2: false,
            },
            graphics_adapters: Vec::new(),
            compute_accelerators: vec![
                ComputeAccelerator {
                    backend: ComputeBackend::Vulkan,
                    name: "GPU".into(),
                    dedicated_memory_bytes: Some(8 * GIB),
                },
                ComputeAccelerator {
                    backend: ComputeBackend::Npu,
                    name: "NPU provider".into(),
                    dedicated_memory_bytes: None,
                },
            ],
        }
    }

    #[test]
    fn npu_precedes_gpu_and_cpu_without_vendor_checks() {
        assert_eq!(
            available_compute_backends(&inventory()),
            [
                ComputeBackend::Npu,
                ComputeBackend::Vulkan,
                ComputeBackend::Cpu
            ]
        );
        let plan = derive_compute_budget(ComputeBackend::Vulkan, &inventory(), 0);
        assert_eq!((plan.tile_edge_pixels, plan.batch_size), (3_072, 4));
    }

    #[test]
    fn usable_memory_respects_current_availability_and_holds() {
        let memory = MemoryCapabilities {
            physical_bytes: 32 * GIB,
            available_bytes: Some(10 * GIB),
        };
        assert_eq!(usable_compute_memory_bytes(memory, 2 * GIB), 8 * GIB);
        assert_eq!(adaptive_job_concurrency(16, 8, memory, 2 * GIB), 2);
    }

    #[test]
    fn webkitgtk_keeps_measured_large_document_caps() {
        let budget = derive_memory_budget(
            MemoryCapabilities {
                physical_bytes: 32 * GIB,
                available_bytes: Some(20 * GIB),
            },
            Some(8 * GIB),
            RendererBackend::WebGl2,
            WebViewRuntime::WebKitGtk,
            0,
        );
        assert_eq!(budget.tile_cache_bytes, 512 * MIB);
        assert_eq!(budget.gpu_texture_bytes, 512 * MIB);
        assert_eq!(budget.texture_chunk_edge, 1_024);
    }
}
