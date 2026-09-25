//! Read-only native host probes. This module is absent from WASM builds.

#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::process::Command;
#[cfg(any(target_os = "linux", target_os = "android", test))]
use std::{collections::BTreeSet, fs};

use thiserror::Error;

use crate::{
    ComputeAccelerator, ComputeBackend, CpuCapabilities, GraphicsAdapterIdentity, HardwareIdentity,
    HardwareInventory, HostArchitecture, HostOperatingSystem, MemoryCapabilities,
};

const MIB: u64 = 1024 * 1024;

/// Probe failures leave policy selection to a caller-provided conservative inventory.
#[derive(Debug, Error)]
pub enum HardwareProbeError {
    /// Physical RAM could not be read.
    #[error("host memory could not be determined")]
    MissingMemory,
    /// No usable logical CPU was reported.
    #[error("host has no available CPU threads")]
    MissingCpu,
    /// Native command or procfs I/O failed.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Captures one immutable native inventory for later capability-based policy decisions.
///
/// Android uses procfs and `getprop` only; it does not require desktop helper binaries. NPU and
/// renderer capabilities are intentionally augmented by the Tauri platform adapter because no
/// portable, truthful OS probe exists for the actual ONNX execution provider or `WebView` adapter.
pub fn probe_hardware() -> Result<HardwareInventory, HardwareProbeError> {
    let logical = u16::try_from(std::thread::available_parallelism()?.get())
        .unwrap_or(u16::MAX)
        .max(1);
    let (memory, physical, cpu_name) = host_memory_cpu_and_name(logical)?;
    let (graphics_adapters, compute_accelerators) = probe_desktop_accelerators();
    Ok(HardwareInventory {
        identity: HardwareIdentity {
            operating_system: operating_system(),
            architecture: architecture(),
            device_model: probe_device_model(),
            cpu_name,
        },
        memory,
        cpu: CpuCapabilities {
            physical_cores: physical.max(1).min(logical),
            logical_cores: logical,
            supports_avx2: supports_avx2(),
        },
        graphics_adapters,
        compute_accelerators,
    })
}

fn host_memory_cpu_and_name(
    logical: u16,
) -> Result<(MemoryCapabilities, u16, Option<String>), HardwareProbeError> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let meminfo = fs::read_to_string("/proc/meminfo")?;
        let memory = parse_linux_memory(&meminfo).ok_or(HardwareProbeError::MissingMemory)?;
        let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let physical = parse_linux_physical_cores(&cpuinfo).unwrap_or_else(|| (logical / 2).max(1));
        let cpu_name = parse_linux_cpu_name(&cpuinfo);
        return Ok((memory, physical, cpu_name));
    }
    #[cfg(target_os = "windows")]
    {
        let memory = probe_windows_memory()?;
        return Ok((memory, (logical / 2).max(1), None));
    }
    #[allow(unreachable_code)]
    Err(HardwareProbeError::MissingMemory)
}

#[cfg(target_os = "windows")]
fn probe_windows_memory() -> Result<MemoryCapabilities, HardwareProbeError> {
    let wmic = Command::new("wmic")
        .args([
            "OS",
            "get",
            "TotalVisibleMemorySize,FreePhysicalMemory",
            "/value",
        ])
        .output();
    let wmic_memory = wmic
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_windows_memory(&String::from_utf8_lossy(&output.stdout)));
    if let Some(memory) = wmic_memory {
        return Ok(memory);
    }

    // WMIC is optional on current Windows releases. CIM through Windows PowerShell is the
    // no-extra-dependency fallback available to the packaged desktop shell.
    let powershell = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$os=Get-CimInstance Win32_OperatingSystem; Write-Output \"TotalVisibleMemorySize=$($os.TotalVisibleMemorySize)\"; Write-Output \"FreePhysicalMemory=$($os.FreePhysicalMemory)\"",
        ])
        .output();
    let powershell_memory = powershell
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_windows_memory(&String::from_utf8_lossy(&output.stdout)));
    if let Some(memory) = powershell_memory {
        return Ok(memory);
    }
    Err(HardwareProbeError::MissingMemory)
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn parse_linux_memory(text: &str) -> Option<MemoryCapabilities> {
    let value = |name: &str| {
        text.lines().find_map(|line| {
            let mut fields = line.split_ascii_whitespace();
            if fields.next()? != name {
                return None;
            }
            fields.next()?.parse::<u64>().ok()?.checked_mul(1024)
        })
    };
    Some(MemoryCapabilities {
        physical_bytes: value("MemTotal:")?,
        available_bytes: value("MemAvailable:"),
    })
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_memory(text: &str) -> Option<MemoryCapabilities> {
    let kib = |name: &str| {
        text.lines()
            .find_map(|line| line.trim().strip_prefix(name))
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|value| value.checked_mul(1024))
    };
    Some(MemoryCapabilities {
        physical_bytes: kib("TotalVisibleMemorySize=")?,
        available_bytes: kib("FreePhysicalMemory="),
    })
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn parse_linux_physical_cores(text: &str) -> Option<u16> {
    let mut package = None;
    let mut core = None;
    let mut identities = BTreeSet::new();
    for line in text.lines().chain(std::iter::once("")) {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(package), Some(core)) = (package.take(), core.take()) {
                identities.insert((package, core));
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "physical id" => package = value.trim().parse::<u32>().ok(),
            "core id" => core = value.trim().parse::<u32>().ok(),
            _ => {}
        }
    }
    u16::try_from(identities.len())
        .ok()
        .filter(|count| *count > 0)
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn parse_linux_cpu_name(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        matches!(key.trim(), "model name" | "Hardware" | "Processor")
            .then(|| value.trim().to_owned())
            .filter(|value| !value.is_empty() && value.len() <= 256)
    })
}

fn probe_desktop_accelerators() -> (Vec<GraphicsAdapterIdentity>, Vec<ComputeAccelerator>) {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let mut graphics = Vec::new();
        let mut compute = Vec::new();
        if let Some((adapter, accelerator)) = probe_nvidia() {
            graphics.push(adapter);
            compute.push(accelerator);
        }
        if let Some((adapter, accelerator)) = probe_vulkan() {
            if !graphics
                .iter()
                .any(|existing| existing.name == adapter.name)
            {
                graphics.push(adapter);
            }
            compute.push(accelerator);
        }
        return (graphics, compute);
    }
    #[allow(unreachable_code)]
    (Vec::new(), Vec::new())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn probe_nvidia() -> Option<(GraphicsAdapterIdentity, ComputeAccelerator)> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_nvidia_line(String::from_utf8_lossy(&output.stdout).lines().next()?)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn parse_nvidia_line(line: &str) -> Option<(GraphicsAdapterIdentity, ComputeAccelerator)> {
    let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
    let [name, memory_mib, driver_version] = fields.as_slice() else {
        return None;
    };
    if name.is_empty() || name.len() > 256 || driver_version.is_empty() {
        return None;
    }
    let memory = memory_mib.parse::<u64>().ok()?.checked_mul(MIB)?;
    Some((
        GraphicsAdapterIdentity {
            name: (*name).to_owned(),
            vendor_id: Some(0x10de),
            device_id: None,
            driver: Some("NVIDIA".into()),
            driver_version: Some((*driver_version).to_owned()),
        },
        ComputeAccelerator {
            backend: ComputeBackend::Cuda,
            name: (*name).to_owned(),
            dedicated_memory_bytes: Some(memory),
        },
    ))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn probe_vulkan() -> Option<(GraphicsAdapterIdentity, ComputeAccelerator)> {
    let output = Command::new("vulkaninfo").arg("--summary").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_vulkan_summary(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn parse_vulkan_summary(text: &str) -> Option<(GraphicsAdapterIdentity, ComputeAccelerator)> {
    let value = |key: &str, limit: usize| {
        text.lines().find_map(|line| {
            line.split_once(key)
                .and_then(|(_, value)| value.split_once('=').map(|(_, value)| value.trim()))
                .filter(|value| !value.is_empty() && value.len() <= limit)
        })
    };
    let name = value("deviceName", 256)?.to_owned();
    let api_version = value("apiVersion", 64)?.to_owned();
    Some((
        GraphicsAdapterIdentity {
            name: name.clone(),
            vendor_id: None,
            device_id: None,
            driver: Some("Vulkan".into()),
            driver_version: Some(api_version),
        },
        ComputeAccelerator {
            backend: ComputeBackend::Vulkan,
            name,
            dedicated_memory_bytes: None,
        },
    ))
}

fn probe_device_model() -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let output = std::process::Command::new("getprop")
            .arg("ro.product.model")
            .output()
            .ok()?;
        return bounded_text(&String::from_utf8_lossy(&output.stdout));
    }
    #[cfg(target_os = "linux")]
    {
        return fs::read_to_string("/sys/devices/virtual/dmi/id/product_name")
            .ok()
            .and_then(|value| bounded_text(&value));
    }
    #[allow(unreachable_code)]
    None
}

fn bounded_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 256).then(|| value.to_owned())
}

const fn operating_system() -> HostOperatingSystem {
    if cfg!(target_os = "windows") {
        HostOperatingSystem::Windows
    } else if cfg!(target_os = "android") {
        HostOperatingSystem::Android
    } else if cfg!(target_os = "linux") {
        HostOperatingSystem::Linux
    } else if cfg!(target_os = "macos") {
        HostOperatingSystem::MacOs
    } else {
        HostOperatingSystem::Other
    }
}

const fn architecture() -> HostArchitecture {
    if cfg!(target_arch = "x86_64") {
        HostArchitecture::X86_64
    } else if cfg!(target_arch = "aarch64") {
        HostArchitecture::Aarch64
    } else {
        HostArchitecture::Other
    }
}

fn supports_avx2() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        return std::is_x86_feature_detected!("avx2");
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_and_android_procfs_facts() {
        let memory =
            parse_linux_memory("MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\n")
                .expect("memory");
        assert_eq!(memory.physical_bytes, 16 * 1024 * MIB);
        assert_eq!(memory.available_bytes, Some(8 * 1024 * MIB));
        let cpu =
            "physical id : 0\ncore id : 0\nmodel name : Test CPU\n\nphysical id : 0\ncore id : 1\n";
        assert_eq!(parse_linux_physical_cores(cpu), Some(2));
        assert_eq!(parse_linux_cpu_name(cpu).as_deref(), Some("Test CPU"));
    }

    #[test]
    fn parses_windows_memory_and_desktop_accelerators() {
        let memory =
            parse_windows_memory("FreePhysicalMemory=4194304\nTotalVisibleMemorySize=16777216\n")
                .expect("memory");
        assert_eq!(memory.physical_bytes, 16 * 1024 * MIB);
        let (adapter, cuda) = parse_nvidia_line("Test GPU, 8192, 600.1").expect("NVIDIA line");
        assert_eq!(adapter.vendor_id, Some(0x10de));
        assert_eq!(cuda.dedicated_memory_bytes, Some(8192 * MIB));
        let (_, vulkan) =
            parse_vulkan_summary("GPU0:\n\tapiVersion = 1.3.280\n\tdeviceName = Test Graphics\n")
                .expect("Vulkan summary");
        assert_eq!(vulkan.backend, ComputeBackend::Vulkan);
    }
}
