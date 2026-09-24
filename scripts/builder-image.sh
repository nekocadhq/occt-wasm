#!/usr/bin/env bash
# Build and push the occt-wasm-builder Docker image to GHCR.
# This image contains pre-built OCCT static libs so CI skips the ~50 min compile.
#
# Usage:
#   ./scripts/builder-image.sh          # Build for linux/amd64 + linux/arm64 and push
#   ./scripts/builder-image.sh --build  # Build for this machine only, into the local images
#
# The OCCT libs compile once, natively, whatever the platforms (see the `occt`
# stage of Dockerfile.builder), so the amd64 image costs no emulated compile on
# an Apple silicon Mac, and the arm64 image runs `docker:*` builds natively.
#
# Rebuild when: OCCT submodule, Dockerfile.builder, cmake flags, or emsdk version change.
set -euo pipefail

IMAGE="ghcr.io/nekocadhq/occt-wasm-builder"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Detect if running inside distrobox
DOCKER="docker"
if command -v distrobox-host-exec &>/dev/null && [ -f /run/.containerenv ]; then
    DOCKER="distrobox-host-exec docker"
fi

# Tag with OCCT submodule short rev
OCCT_REV=$(git rev-parse --short HEAD:occt)
TAG="${OCCT_REV}"

echo "Building ${IMAGE}:${TAG}"
echo "  OCCT rev: ${OCCT_REV}"
echo "  Docker:   ${DOCKER}"
echo ""

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

if [[ "${1:-}" == "--build" ]]; then
    # --load takes one platform: the one of this machine.
    $DOCKER buildx build \
        -f Dockerfile.builder \
        --progress=plain \
        --load \
        -t "${IMAGE}:${TAG}" \
        -t "${IMAGE}:latest" \
        .
    echo ""
    echo "Built: ${IMAGE}:${TAG}"
    echo "Built: ${IMAGE}:latest"
    echo "Skipping push (--build flag)."
    exit 0
fi

# Login to GHCR via gh CLI token
echo "Logging into GHCR via gh CLI..."
gh auth token | $DOCKER login ghcr.io -u "$(gh api user --jq .login)" --password-stdin

# A multi-platform image goes straight to the registry: the local image store
# holds one platform only.
$DOCKER buildx build \
    -f Dockerfile.builder \
    --progress=plain \
    --platform "${PLATFORMS}" \
    --push \
    -t "${IMAGE}:${TAG}" \
    -t "${IMAGE}:latest" \
    .

echo ""
echo "Pushed: ${IMAGE}:${TAG} (${PLATFORMS})"
echo "Pushed: ${IMAGE}:latest (${PLATFORMS})"
echo ""
echo "CI will now use this image. No OCCT recompilation needed."
