#!/bin/bash
# Download prebuilt native binaries for node-datachannel for all target platforms.
# Called in CI before `pnpm publish` so the npm tarball ships with all prebuilds.
#
# Binaries go to packages/cli/prebuilds/{platform}-{arch}/node_datachannel.node
# and our webrtc-transfer.ts copies the correct one to node-datachannel's
# build/Release/ directory at first use.

set -euo pipefail

# Read actual installed version (not the semver range from package.json)
NDC_VERSION=$(node -e "const m=require.resolve('node-datachannel');const r=m.substring(0,m.indexOf('node-datachannel')+16);const p=JSON.parse(require('fs').readFileSync(r+'/package.json','utf8'));console.log(p.version)")
echo "node-datachannel target version: $NDC_VERSION"

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
