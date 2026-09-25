use std::cmp::Ordering;
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{HostOperatingSystem, RendererBackend, WebViewRuntime};

/// Comparable dotted numeric version retained without name-based matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HardwareQuirkVersion(pub String);

/// Exact, structured hardware and `WebView` facts used by reviewed rules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardwareQuirkMatch {
    /// Operating system identifier.
    pub os: Option<String>,
    /// Numeric PCI vendor identifier.
    pub vendor_id: Option<u32>,
    /// Numeric PCI device identifier.
    pub device_id: Option<u32>,
    /// Inclusive minimum driver version.
    pub driver_min: Option<HardwareQuirkVersion>,
    /// Inclusive maximum driver version.
    pub driver_max: Option<HardwareQuirkVersion>,
    /// Selected renderer backend.
    pub backend: Option<String>,
    /// Display session type such as `wayland` or `x11`.
    pub session_type: Option<String>,
    /// `WebView` runtime.
    pub webview: Option<String>,
    /// Inclusive minimum `WebView` version.
    pub webview_version_min: Option<HardwareQuirkVersion>,
    /// Inclusive maximum `WebView` version.
    pub webview_version_max: Option<HardwareQuirkVersion>,
}

/// Actions produced by a matched reviewed rule.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardwareQuirkActions {
    /// Renderer backends excluded for this exact match.
    pub disable_backends: Vec<String>,
    /// Whether this exact match must start on the software renderer.
    pub force_software: Option<bool>,
    /// Render-memory multiplier in the inclusive range 0.1..=1.0.
    pub render_budget_scale: Option<f32>,
    /// Compute-memory multiplier in the inclusive range 0.1..=1.0.
    pub compute_budget_scale: Option<f32>,
}

/// One version-one reviewed hardware quirk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardwareQuirk {
    /// Stable lowercase identifier.
    pub id: String,
    /// Higher values resolve first.
    pub priority: i32,
    /// Structured match fields.
    #[serde(rename = "match")]
    pub matcher: HardwareQuirkMatch,
    /// Deterministic actions.
    pub actions: HardwareQuirkActions,
    /// Reviewed human-readable rationale.
    pub reason: String,
    /// ISO date after which the rule must be reviewed.
    pub expires: String,
}

/// Runtime facts against which reviewed quirks are matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareQuirkFacts<'a> {
    /// Host operating system.
    pub operating_system: HostOperatingSystem,
    /// Numeric adapter vendor identifier, when exposed.
    pub vendor_id: Option<u32>,
    /// Numeric adapter device identifier, when exposed.
    pub device_id: Option<u32>,
    /// Dotted numeric driver version, when exposed.
    pub driver_version: Option<&'a str>,
    /// Selected renderer backend.
    pub backend: RendererBackend,
    /// Display session type, when exposed.
    pub session_type: Option<&'a str>,
    /// Active `WebView` runtime.
    pub webview: WebViewRuntime,
    /// Dotted numeric `WebView` version, when exposed.
    pub webview_version: Option<&'a str>,
}

/// Fully merged deterministic quirk result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HardwareQuirkResolution {
    /// Rules that contributed actions, in priority/id order.
    pub matched_ids: Vec<String>,
    /// Disabled renderer backends with stable ordering.
    pub disable_backends: Vec<String>,
    /// Whether any matched rule forces software rendering.
    pub force_software: bool,
    /// Product of matched render scales.
    pub render_budget_scale: f32,
    /// Product of matched compute scales.
    pub compute_budget_scale: f32,
}

/// Rejected quirk registry, fact set, or conflicting resolution.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum HardwareQuirkValidationError {
    /// Stable id is absent or malformed.
    #[error("hardware quirk id is invalid: {0}")]
    InvalidId(String),
    /// Two entries reuse one stable id.
    #[error("duplicate hardware quirk id: {0}")]
    DuplicateId(String),
    /// A required descriptive field is absent or malformed.
    #[error("hardware quirk {id} has an invalid {field}")]
    InvalidField {
        /// Rule id.
        id: String,
        /// Invalid field.
        field: &'static str,
    },
    /// Scale lies outside the accepted range.
    #[error("hardware quirk {id} has an invalid {field}")]
    InvalidScale {
        /// Rule id.
        id: String,
        /// Invalid scale field.
        field: &'static str,
    },
    /// A version is not dotted numeric notation.
    #[error("hardware quirk {id} has an invalid {field} version")]
    InvalidVersion {
        /// Rule id.
        id: String,
        /// Invalid version field.
        field: &'static str,
    },
    /// An inclusive version range is reversed.
    #[error("hardware quirk {id} has a reversed {field} range")]
    ReversedVersionRange {
        /// Rule id.
        id: String,
        /// Reversed version field.
        field: &'static str,
    },
}

/// Returns the checked-in rules generated from the canonical JSON registry.
#[must_use]
pub fn reviewed_quirks() -> Vec<HardwareQuirk> {
    crate::generated_quirks::generated_quirks()
}

/// Validates a registry and returns only rules matching the supplied structured facts.
pub fn matching_quirks(
    rules: &[HardwareQuirk],
    facts: &HardwareQuirkFacts<'_>,
) -> Result<Vec<HardwareQuirk>, HardwareQuirkValidationError> {
    validate(rules)?;
    Ok(rules
        .iter()
        .filter(|rule| rule_matches(&rule.matcher, facts))
        .cloned()
        .collect())
}

/// Validates and deterministically merges already-matched rules.
pub fn resolve_quirks(
    rules: &[HardwareQuirk],
) -> Result<HardwareQuirkResolution, HardwareQuirkValidationError> {
    validate(rules)?;
    let mut ordered = rules.to_vec();
    ordered.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut disabled = BTreeSet::new();
    let mut result = HardwareQuirkResolution {
        render_budget_scale: 1.0,
        compute_budget_scale: 1.0,
        ..HardwareQuirkResolution::default()
    };
    for rule in ordered {
        result.matched_ids.push(rule.id);
        disabled.extend(rule.actions.disable_backends);
        result.force_software |= rule.actions.force_software.unwrap_or(false);
        result.render_budget_scale *= rule.actions.render_budget_scale.unwrap_or(1.0);
        result.compute_budget_scale *= rule.actions.compute_budget_scale.unwrap_or(1.0);
    }
    result.disable_backends = disabled.into_iter().collect();
    Ok(result)
}

fn rule_matches(matcher: &HardwareQuirkMatch, facts: &HardwareQuirkFacts<'_>) -> bool {
    exact(matcher.os.as_deref(), os_name(facts.operating_system))
        && optional_number(matcher.vendor_id, facts.vendor_id)
        && optional_number(matcher.device_id, facts.device_id)
        && version_in_range(
            facts.driver_version,
            matcher.driver_min.as_ref(),
            matcher.driver_max.as_ref(),
        )
        && exact(matcher.backend.as_deref(), backend_name(facts.backend))
        && optional_text(matcher.session_type.as_deref(), facts.session_type)
        && exact(matcher.webview.as_deref(), webview_name(facts.webview))
        && version_in_range(
            facts.webview_version,
            matcher.webview_version_min.as_ref(),
            matcher.webview_version_max.as_ref(),
        )
}

fn exact(expected: Option<&str>, actual: &str) -> bool {
    expected.is_none_or(|value| value == actual)
}

fn optional_text(expected: Option<&str>, actual: Option<&str>) -> bool {
    expected.is_none_or(|value| actual == Some(value))
}

fn optional_number(expected: Option<u32>, actual: Option<u32>) -> bool {
    expected.is_none_or(|value| actual == Some(value))
}

fn version_in_range(
    actual: Option<&str>,
    minimum: Option<&HardwareQuirkVersion>,
    maximum: Option<&HardwareQuirkVersion>,
) -> bool {
    if minimum.is_none() && maximum.is_none() {
        return true;
    }
    let Some(actual) = actual else {
        return false;
    };
    if parse_version(actual).is_none() {
        return false;
    }
    if minimum.is_some_and(|minimum| compare_versions(actual, &minimum.0) == Ordering::Less) {
        return false;
    }
    maximum.is_none_or(|maximum| compare_versions(actual, &maximum.0) != Ordering::Greater)
}

fn validate(rules: &[HardwareQuirk]) -> Result<(), HardwareQuirkValidationError> {
    let mut ids = BTreeSet::new();
    for rule in rules {
        if !valid_id(&rule.id) {
            return Err(HardwareQuirkValidationError::InvalidId(rule.id.clone()));
        }
        if !ids.insert(rule.id.clone()) {
            return Err(HardwareQuirkValidationError::DuplicateId(rule.id.clone()));
        }
        if rule.reason.trim().is_empty() {
            return Err(HardwareQuirkValidationError::InvalidField {
                id: rule.id.clone(),
                field: "reason",
            });
        }
        if !valid_date(&rule.expires) {
            return Err(HardwareQuirkValidationError::InvalidField {
                id: rule.id.clone(),
                field: "expires",
            });
        }
        for (field, value, accepted) in [
            (
                "os",
                rule.matcher.os.as_deref(),
                &["windows", "linux", "android", "macos", "other"][..],
            ),
            (
                "backend",
                rule.matcher.backend.as_deref(),
                &["webgpu", "webgl2", "software"][..],
            ),
            (
                "webview",
                rule.matcher.webview.as_deref(),
                &[
                    "webview2",
                    "webkitgtk",
                    "android-webview",
                    "electron",
                    "other",
                ][..],
            ),
        ] {
            if value.is_some_and(|value| !accepted.contains(&value)) {
                return Err(HardwareQuirkValidationError::InvalidField {
                    id: rule.id.clone(),
                    field,
                });
            }
        }
        if rule
            .actions
            .disable_backends
            .iter()
            .any(|value| !["webgpu", "webgl2", "software"].contains(&value.as_str()))
        {
            return Err(HardwareQuirkValidationError::InvalidField {
                id: rule.id.clone(),
                field: "disableBackends",
            });
        }
        for (field, scale) in [
            ("renderBudgetScale", rule.actions.render_budget_scale),
            ("computeBudgetScale", rule.actions.compute_budget_scale),
        ] {
            if scale.is_some_and(|value| !value.is_finite() || !(0.1..=1.0).contains(&value)) {
                return Err(HardwareQuirkValidationError::InvalidScale {
                    id: rule.id.clone(),
                    field,
                });
            }
        }
        validate_range(
            &rule.id,
            "driver",
            rule.matcher.driver_min.as_ref(),
            rule.matcher.driver_max.as_ref(),
        )?;
        validate_range(
            &rule.id,
            "webview",
            rule.matcher.webview_version_min.as_ref(),
            rule.matcher.webview_version_max.as_ref(),
        )?;
    }
    Ok(())
}

fn validate_range(
    id: &str,
    field: &'static str,
    minimum: Option<&HardwareQuirkVersion>,
    maximum: Option<&HardwareQuirkVersion>,
) -> Result<(), HardwareQuirkValidationError> {
    for version in [minimum, maximum].into_iter().flatten() {
        if parse_version(&version.0).is_none() {
            return Err(HardwareQuirkValidationError::InvalidVersion {
                id: id.to_owned(),
                field,
            });
        }
    }
    if minimum
        .zip(maximum)
        .is_some_and(|(minimum, maximum)| compare_versions(&minimum.0, &maximum.0).is_gt())
    {
        return Err(HardwareQuirkValidationError::ReversedVersionRange {
            id: id.to_owned(),
            field,
        });
    }
    Ok(())
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left = parse_version(left).expect("validated version");
    let right = parse_version(right).expect("validated version");
    let length = left.len().max(right.len());
    (0..length)
        .map(|index| {
            left.get(index)
                .copied()
                .unwrap_or(0)
                .cmp(&right.get(index).copied().unwrap_or(0))
        })
        .find(|ordering| !ordering.is_eq())
        .unwrap_or(Ordering::Equal)
}

fn parse_version(value: &str) -> Option<Vec<u64>> {
    if value.is_empty() {
        return None;
    }
    value
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                None
            } else {
                part.parse().ok()
            }
        })
        .collect()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit()))
    {
        return false;
    }
    let year = value[0..4].parse::<u32>().expect("date digits");
    let month = value[5..7].parse::<u32>().expect("date digits");
    let day = value[8..10].parse::<u32>().expect("date digits");
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

const fn os_name(value: HostOperatingSystem) -> &'static str {
    match value {
        HostOperatingSystem::Windows => "windows",
        HostOperatingSystem::Linux => "linux",
        HostOperatingSystem::Android => "android",
        HostOperatingSystem::MacOs => "macos",
        HostOperatingSystem::Other => "other",
    }
}

const fn backend_name(value: RendererBackend) -> &'static str {
    match value {
        RendererBackend::WebGpu => "webgpu",
        RendererBackend::WebGl2 => "webgl2",
        RendererBackend::Software => "software",
    }
}

const fn webview_name(value: WebViewRuntime) -> &'static str {
    match value {
        WebViewRuntime::WebView2 => "webview2",
        WebViewRuntime::WebKitGtk => "webkitgtk",
        WebViewRuntime::AndroidWebView => "android-webview",
        WebViewRuntime::Electron => "electron",
        WebViewRuntime::Other => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, priority: i32) -> HardwareQuirk {
        HardwareQuirk {
            id: id.into(),
            priority,
            matcher: HardwareQuirkMatch {
                os: Some("android".into()),
                webview: Some("android-webview".into()),
                webview_version_min: Some(HardwareQuirkVersion("150.0".into())),
                ..HardwareQuirkMatch::default()
            },
            actions: HardwareQuirkActions {
                disable_backends: vec!["webgpu".into()],
                render_budget_scale: Some(0.5),
                ..HardwareQuirkActions::default()
            },
            reason: "test".into(),
            expires: "2099-01-01".into(),
        }
    }

    #[test]
    fn matches_structured_android_webview_facts_and_resolves_priority() {
        let facts = HardwareQuirkFacts {
            operating_system: HostOperatingSystem::Android,
            vendor_id: None,
            device_id: None,
            driver_version: None,
            backend: RendererBackend::WebGpu,
            session_type: None,
            webview: WebViewRuntime::AndroidWebView,
            webview_version: Some("150.0.1"),
        };
        let matched = matching_quirks(&[rule("lower", 1), rule("higher", 2)], &facts)
            .expect("valid registry");
        let resolved = resolve_quirks(&matched).expect("valid matched rules");
        assert_eq!(resolved.matched_ids, ["higher", "lower"]);
        assert_eq!(resolved.disable_backends, ["webgpu"]);
        assert!((resolved.render_budget_scale - 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn missing_fact_does_not_match_a_constrained_rule() {
        let facts = HardwareQuirkFacts {
            operating_system: HostOperatingSystem::Android,
            vendor_id: None,
            device_id: None,
            driver_version: None,
            backend: RendererBackend::WebGpu,
            session_type: None,
            webview: WebViewRuntime::AndroidWebView,
            webview_version: None,
        };
        assert!(matching_quirks(&[rule("requires-version", 1)], &facts)
            .expect("valid registry")
            .is_empty());
    }

    #[test]
    fn generated_registry_is_valid_and_currently_empty() {
        let resolved = resolve_quirks(&reviewed_quirks()).expect("generated rules");
        assert!(resolved.matched_ids.is_empty());
        assert!((resolved.render_budget_scale - 1.0).abs() < f32::EPSILON);
    }
}
