#!/bin/bash
# Download prebuilt native binaries for node-datachannel for all target platforms.
# Called in CI before `pnpm publish` so the npm tarball ships with all prebuilds.
#
# Binaries go to packages/cli/prebuilds/{platform}-{arch}/node_datachannel.node
# and our webrtc-transfer.ts copies the correct one to node-datachannel's
# build/Release/ directory at first use.

set -euo pipefail

# Read the resolved version from pnpm-lock.yaml
NDC_VERSION=$(node -e "
  const fs = require('fs');
  const lock = fs.readFileSync('pnpm-lock.yaml', 'utf8');
  // Match: node-datachannel@X.Y.Z: (the resolved package entry)
  const match = lock.match(/node-datachannel@(\\d+\\.\\d+\\.\\d+):/);
  if (match) { console.log(match[1]); process.exit(0); }
  // Fallback: strip semver range from package.json
  const pkg = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf8'));
  console.log(pkg.dependencies['node-datachannel'].replace(/[\\^~>=<]/g, ''));
")
echo "node-datachannel version: $NDC_VERSION"

PREBUILDS_DIR="./packages/cli/prebuilds"
PLATFORMS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")
REPO="murat-dogan/node-datachannel"

rm -rf "$PREBUILDS_DIR"

for platform in "${PLATFORMS[@]}"; do
  tarball="node-datachannel-v${NDC_VERSION}-napi-v8-${platform}.tar.gz"
  url="https://github.com/${REPO}/releases/download/v${NDC_VERSION}/${tarball}"
  dest="${PREBUILDS_DIR}/${platform}"

  echo "Downloading ${platform}..."
  mkdir -p "$dest"

  if curl -fsSL "$url" | tar xz -C "$dest" --strip-components=2 2>/dev/null; then
    echo "  OK: $(ls -lh "${dest}/node_datachannel.node" | awk '{print $5}')"
  else
    echo "  WARN: Failed to download prebuilt for ${platform} (non-fatal)"
  fi
done

echo ""
echo "Prebuilds bundled:"
find "$PREBUILDS_DIR" -name "*.node" -exec ls -lh {} \;
