#!/usr/bin/env bash
set -euo pipefail

result_path="${1:-/tmp/a4d-tauri.json}"
curve_path="${2:-/tmp/a4d-tauri-memory.csv}"
binary="${A4D_TAURI_BINARY:-src-tauri/target/release/fernwork-bildeditor}"
cache_dir="${A4D_TAURI_CACHE:-/tmp/a4d-tauri-cache}"
config_dir="${A4D_TAURI_CONFIG:-/tmp/a4d-tauri-config}"
archive_path="${A4D_TAURI_ARCHIVE:-/tmp/a4d-tauri.fwimg}"
progress_path="${A4D_TAURI_PROGRESS:-/tmp/a4d-tauri-progress.jsonl}"

free_bytes=$(df --output=avail -B1 / | tail -1 | tr -d ' ')
if (( free_bytes < 10 * 1024 * 1024 * 1024 )); then
  echo "A4D needs at least 10 GiB free (found ${free_bytes} bytes)." >&2
  exit 1
fi
if [[ ! -x "$binary" ]]; then
  echo "Missing measurement release binary: $binary (build with VITE_FERNWORK_MEASUREMENT=1 npm run tauri:build -- --features measurement --no-bundle)" >&2
  exit 1
fi

mkdir -p "$cache_dir" "$config_dir"
find "$cache_dir" -mindepth 1 -delete
find "$config_dir" -mindepth 1 -delete
rm -f -- "$archive_path" "$result_path" "$curve_path" "$progress_path"
printf '%s\n' 'seconds,total_rss_bytes,total_pss_bytes,anonymous_bytes,file_bytes,shared_bytes,shell_rss_bytes,web_rss_bytes,network_rss_bytes,gpu_rss_bytes,scratch_bytes,archive_bytes,disk_free_bytes' > "$curve_path"

source scripts/tauri-env.sh
XDG_CACHE_HOME="$cache_dir" XDG_CONFIG_HOME="$config_dir" FERNWORK_A4C_ACCEPTANCE=1 \
  FERNWORK_A4C_ARCHIVE="$archive_path" FERNWORK_MATRIX_RESULT="$result_path" FERNWORK_A4D_PROGRESS="$progress_path" \
  xvfb-run -a "$binary" &
launcher_pid=$!
started=$(date +%s)

descendants() {
  local roots=" $1 " changed=1
  while (( changed )); do
    changed=0
    while read -r pid parent; do
      if [[ "$roots" == *" $parent "* && "$roots" != *" $pid "* ]]; then roots+="$pid "; changed=1; fi
    done < <(ps -e -o pid=,ppid=)
  done
  printf '%s\n' "$roots"
}

cleanup() {
  kill "$launcher_pid" 2>/dev/null || true
  wait "$launcher_pid" 2>/dev/null || true
  find "$cache_dir" -depth -delete 2>/dev/null || true
  find "$config_dir" -depth -delete 2>/dev/null || true
  rm -f -- "$archive_path"
}
trap cleanup EXIT INT TERM

root_pid=''
for _ in $(seq 1 100); do
  for candidate in $(descendants "$launcher_pid"); do
    if [[ -r "/proc/$candidate/status" ]] && grep -q '^Name:[[:space:]]*fernwork-bilded' "/proc/$candidate/status"; then
      root_pid=$candidate
      break 2
    fi
  done
  sleep 0.1
done
if [[ -z "$root_pid" ]]; then
  echo 'A4D could not find the Tauri application process.' >&2
  exit 1
fi

while kill -0 "$launcher_pid" 2>/dev/null; do
  pids=$(descendants "$root_pid")
  total_rss=0; total_pss=0; anonymous=0; file_bytes=0; shared=0
  shell_rss=0; web_rss=0; network_rss=0; gpu_rss=0
  for pid in $pids; do
    [[ -r "/proc/$pid/status" ]] || continue
    status_values=$(awk '
      /^VmRSS:/ { rss=$2 }
      /^RssAnon:/ { anon=$2 }
      /^RssFile:/ { file=$2 }
      /^RssShmem:/ { shmem=$2 }
      END { print rss+0, anon+0, file+0, shmem+0 }
    ' "/proc/$pid/status" 2>/dev/null || true)
    [[ -n "$status_values" ]] || continue
    read -r rss_kib anon_kib file_kib shmem_kib <<< "$status_values"
    rss_bytes=$(( ${rss_kib:-0} * 1024 )); total_rss=$((total_rss + rss_bytes))
    anonymous=$((anonymous + anon_kib * 1024))
    file_bytes=$((file_bytes + file_kib * 1024))
    shared=$((shared + shmem_kib * 1024))
    name=$(awk '/^Name:/ { print $2 }' "/proc/$pid/status")
    case "$name" in
      fernwork-bilded) shell_rss=$((shell_rss + rss_bytes)) ;;
      WebKitWebProces) web_rss=$((web_rss + rss_bytes)) ;;
      WebKitNetworkPr) network_rss=$((network_rss + rss_bytes)) ;;
      WebKitGPUProces) gpu_rss=$((gpu_rss + rss_bytes)) ;;
    esac
    if [[ -r "/proc/$pid/smaps_rollup" ]]; then
      pss_kib=$(awk '
        /^Pss:/ { pss=$2 }
        END { print pss+0 }
      ' "/proc/$pid/smaps_rollup" 2>/dev/null || echo 0)
      total_pss=$((total_pss + pss_kib * 1024))
    fi
  done
  scratch_bytes=$(stat -c %s "$cache_dir/de.fernwork.bildeditor/scratch/scratch.bin" 2>/dev/null || echo 0)
  archive_bytes=$(stat -c %s "$archive_path" 2>/dev/null || echo 0)
  disk_free=$(df --output=avail -B1 / | tail -1 | tr -d ' ')
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$(( $(date +%s) - started ))" "$total_rss" "$total_pss" "$anonymous" "$file_bytes" "$shared" \
    "$shell_rss" "$web_rss" "$network_rss" "$gpu_rss" "$scratch_bytes" "$archive_bytes" "$disk_free" >> "$curve_path"
  if (( disk_free < 10 * 1024 * 1024 * 1024 )); then
    echo 'A4D stopped: disk free space fell below 10 GiB.' >&2
    exit 1
  fi
  [[ -s "$result_path" ]] && break
  sleep 1
done

if [[ ! -s "$result_path" ]]; then
  echo 'A4D Tauri process exited without a result.' >&2
  exit 1
fi
echo "Result: $result_path"
echo "Memory curve: $curve_path"
