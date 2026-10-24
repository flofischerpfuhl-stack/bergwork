#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
binary="$repo_dir/src-tauri/target/release/fernwork-bildeditor"
duration="${1:-300}"
result="${2:-/tmp/fernwork-offline-probe.txt}"
source "$repo_dir/scripts/tauri-env.sh"

if [[ ! -x "$binary" ]]; then
  echo "missing $binary; build the release binary first" >&2
  exit 2
fi

"$binary" &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 - "$pid" "$duration" "$result" <<'PY'
import os
import pathlib
import sys
import time

root = int(sys.argv[1])
duration = float(sys.argv[2])
output = pathlib.Path(sys.argv[3])
observed = set()
polls = 0

def descendants(parent):
    result = {parent}
    changed = True
    while changed:
        changed = False
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit() or int(entry.name) in result:
                continue
            try:
                fields = (entry / 'stat').read_text().split()
                ppid = int(fields[3])
            except (OSError, ValueError, IndexError):
                continue
            if ppid in result:
                result.add(int(entry.name))
                changed = True
    return result

def socket_inodes(pids):
    result = set()
    for process in pids:
        try:
            links = (pathlib.Path('/proc') / str(process) / 'fd').iterdir()
            for link in links:
                try:
                    target = os.readlink(link)
                except OSError:
                    continue
                if target.startswith('socket:['):
                    result.add(target[8:-1])
        except OSError:
            pass
    return result

def inspect(table, protocol, inodes):
    try:
        lines = pathlib.Path(table).read_text().splitlines()[1:]
    except OSError:
        return
    for line in lines:
        fields = line.split()
        if len(fields) < 10 or fields[9] not in inodes:
            continue
        remote, state = fields[2], fields[3]
        # Ignore TCP listeners and sockets without a remote endpoint. UDP sends through an
        # unconnected socket are a stated limit of this /proc snapshot probe.
        if state == '0A' or remote.endswith(':0000'):
            continue
        observed.add((protocol, fields[1], remote, state, fields[9]))

deadline = time.monotonic() + duration
while time.monotonic() < deadline and pathlib.Path(f'/proc/{root}').exists():
    pids = descendants(root)
    inodes = socket_inodes(pids)
    inspect('/proc/net/tcp', 'tcp4', inodes)
    inspect('/proc/net/tcp6', 'tcp6', inodes)
    inspect('/proc/net/udp', 'udp4', inodes)
    inspect('/proc/net/udp6', 'udp6', inodes)
    polls += 1
    time.sleep(0.2)

lines = [f'root_pid={root}', f'duration_seconds={duration:g}', f'polls={polls}',
         f'network_connections={len(observed)}']
for row in sorted(observed):
    lines.append(' '.join(row))
output.write_text('\n'.join(lines) + '\n')
print('\n'.join(lines))
sys.exit(1 if observed else 0)
PY
