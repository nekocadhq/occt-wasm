#!/usr/bin/env bash
# Publish the NekoCAD build to npm as @nekocad/occt-wasm, under the dist-tag `nekocad`, then tag and push the release.
# The steps are the "Make a release" steps of NEKOCAD.md. Set the version in ts/package.json and commit it first.
#
# Usage: ./scripts/publish-nekocad.sh [--dry-run] [--no-build] [--otp CODE]
#   --dry-run   build, pack, and check, but publish, tag, and push nothing
#   --no-build  use the WASM already in dist/ (skip the two cargo xtask builds)
#   --otp CODE  the one-time code of npm two-factor authentication
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
BUILD=1
OTP=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) BUILD=0 ;;
    --otp) OTP=(--otp "${2:?--otp needs a code}"); shift ;;
    *) echo "Error: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

fail() { echo "Error: $*" >&2; exit 1; }

NAME=$(node -p "require('./ts/package.json').name")
VERSION=$(node -p "require('./ts/package.json').version")
TAG="v$VERSION"
[ "$NAME" = "@nekocad/occt-wasm" ] || fail "ts/package.json names $NAME, not @nekocad/occt-wasm"
[[ "$VERSION" == *-nekocad.* ]] || fail "version $VERSION is not a NekoCAD version (<upstream>-nekocad.<n>)"

# npm answers a publish from a logged-out user with a 404, so check the login first.
NPM_USER=$(npm whoami 2>/dev/null) || fail "not logged in to npm. The token in ~/.npmrc may have expired. Run: npm login"
npm view "$NAME" maintainers --json | grep -q "\"$NPM_USER " \
  || fail "npm user $NPM_USER is not a maintainer of $NAME. Log in as a maintainer: npm login"
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  fail "$NAME@$VERSION is already on npm. Set a new version: cd ts && npm version <upstream>-nekocad.<n+1> --no-git-tag-version"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Warning: the working tree has changes that are not committed:" >&2
  git status --short --untracked-files=no >&2
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && [ "$(git rev-parse "$TAG^{commit}")" != "$(git rev-parse HEAD)" ]; then
  fail "tag $TAG exists on a different commit than HEAD"
fi

echo "Publishing $NAME@$VERSION as $NPM_USER"

if [ "$BUILD" = 1 ]; then
  echo "Building the WASM (release, and release with threads)..."
  cargo xtask build --release
  cargo xtask build --release --threads
fi

echo "Building and packing the TypeScript package..."
(cd ts && npm run build)
TARBALL="./ts/$(cd ts && npm pack --silent | tail -1)"
PACKED=$(tar -xOzf "$TARBALL" package/package.json | node -p "const p = JSON.parse(require('fs').readFileSync(0)); p.name + '@' + p.version")
[ "$PACKED" = "$NAME@$VERSION" ] || fail "$TARBALL holds $PACKED, not $NAME@$VERSION"

# The path starts with ./, because npm reads ts/<file>.tgz as a GitHub user/repo name.
# Provenance needs a CI runner with an identity. ts/.npmrc turns it on, so a local publish turns it off.
PUBLISH_ARGS=(--access public --tag nekocad --provenance=false ${OTP[@]+"${OTP[@]}"})

if [ "$DRY_RUN" = 1 ]; then
  npm publish "$TARBALL" --dry-run "${PUBLISH_ARGS[@]}"
  echo "Dry run: nothing was published, tagged, or pushed."
  exit 0
fi

read -r -p "Publish $TARBALL to npm as $NPM_USER? [y/N] " ANSWER
[ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ] || fail "stopped before the publish"

npm publish "$TARBALL" "${PUBLISH_ARGS[@]}"
echo "Published $NAME@$VERSION under the dist-tag nekocad"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag "$TAG"
git push origin HEAD "$TAG"

echo
echo "Next, in the NekoCAD platform repository:"
echo "  pnpm --dir packages/kernel add occt-wasm@npm:$NAME@$VERSION"
