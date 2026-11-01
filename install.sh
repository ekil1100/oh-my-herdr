#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

for tool in node npm herdr-app hc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Install it and rerun ./install.sh.\n' "$tool" >&2
    exit 1
  fi
done

node --input-type=module <<'JS'
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major > 24)) {
  console.error('Node.js 22.21+ (22.x) or 24.5+ is required.');
  process.exit(1);
}
JS

if ! herdr-app status >/dev/null; then
  printf 'Start Herdr App, then rerun ./install.sh.\n' >&2
  exit 1
fi

printf 'Installing dependencies...\n'
npm ci --no-audit --no-fund
node scripts/setup.mjs
