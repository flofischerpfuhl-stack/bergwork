#!/usr/bin/env bash
set -u

# FIX-PERF bisect runner. It intentionally builds nothing: Vite is started by Playwright.
# Values are 3x the known-good measurements (brush 5.7 ms, styles 9.1 ms); the
# pan/zoom lane uses 3x its 33 ms budget because the archived good record only says it passed.
browser_path=${PLAYWRIGHT_BROWSERS_PATH:-/home/oem/.local/share/fernwork-compositor-lab/browser-cache}
port=${E2E_PORT:-5952}
output_root=${BISECT_OUTPUT:-/tmp/pw-out-fperf/bisect}
revision=$(git rev-parse --short HEAD)
run_root="$output_root/$revision"
mkdir -p "$run_root"

uptime | tee "$run_root/uptime.txt"

run_spec() {
  local spec=$1 timeout_seconds=$2 log=$3
  PLAYWRIGHT_BROWSERS_PATH="$browser_path" E2E_PORT="$port" timeout "${timeout_seconds}s" \
    npx playwright test --project=perf-gpu "$spec" --output="$run_root/playwright" 2>&1 | tee "$log"
  return "${PIPESTATUS[0]}"
}

if [[ -f tests/e2e/effects-performance.spec.ts ]]; then
  effects_log="$run_root/effects.log"
  run_spec tests/e2e/effects-performance.spec.ts 120 "$effects_log"
  effects_status=$?
  if [[ $effects_status -eq 124 ]]; then exit 1; fi
  if [[ $effects_status -ne 0 ]]; then
    node -e '
      const text = require("node:fs").readFileSync(process.argv[1], "utf8");
      const values = [...text.matchAll(/p95:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
      if (!values.length || values.at(-1) > 27.3) process.exit(1);
    ' "$effects_log" || exit 1
  fi
fi

performance_log="$run_root/performance.log"
rm -f artifacts/performance/browser-perf-gpu.json
run_spec tests/e2e/performance.spec.ts 180 "$performance_log"
performance_status=$?
if [[ $performance_status -eq 124 ]]; then exit 1; fi
if [[ $performance_status -ne 0 ]]; then
  node -e '
    const fs = require("node:fs"), path = "artifacts/performance/browser-perf-gpu.json";
    if (!fs.existsSync(path)) process.exit(1);
    const r = JSON.parse(fs.readFileSync(path, "utf8"));
    const slow = r.brushFeedbackMs.p95 > 17.1 || r.brushFeedbackIrregularMs.p95 > 17.1
      || r.panMs.p95 > 99 || r.zoomMs.p95 > 99 || r.panAt200PercentMs.p95 > 99;
    if (slow) process.exit(1);
  ' || exit 1
fi

exit 0
