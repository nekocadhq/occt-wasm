# occt-wasm for NekoCAD

This is the NekoCAD fork of [andymai/occt-wasm](https://github.com/andymai/occt-wasm). NekoCAD installs the npm package from a tarball on a GitHub release of this repository, so a change to the facade reaches the app without the npm registry.

## Branches and versions

- `main` follows upstream. `nekocad-build` holds the NekoCAD changes on top of it.
- A NekoCAD version is a prerelease of the upstream version it is built on: `5.0.0-nekocad.1`, then `5.0.0-nekocad.2`. After a merge of upstream 5.1.0, the next one is `5.1.0-nekocad.1`.
- The `occt` submodule is on `nekocadhq/OCCT`. A new OCCT commit also needs a new builder image (see below).

## Build from scratch

Prerequisites: emsdk 5.0.3 (`~/emsdk`, then `source ~/emsdk/emsdk_env.sh`), Rust, Node, and Docker for the builder image.

```bash
git submodule update --init
bash scripts/fetch-rapidjson.sh
npm ci --ignore-scripts && (cd ts && npm ci)
cargo xtask build-occt          # only on a new checkout or a new OCCT commit
cargo xtask build --release
(cd ts && npm run build)        # the raw-access tests load ts/dist
cargo xtask test
cargo xtask build-wasi --release  # after a facade change, so the crate stale-check passes
```

## Make a release

1. Set the version: `cd ts && npm version 5.0.0-nekocad.N --no-git-tag-version`.
2. Build and test as above, then `cd ts && npm pack`. The result is `ts/occt-wasm-5.0.0-nekocad.N.tgz`.
3. Commit the version, tag `v5.0.0-nekocad.N`, and push the branch and the tag.
4. Make the release with the tarball:

   ```bash
   gh release create v5.0.0-nekocad.N ts/occt-wasm-5.0.0-nekocad.N.tgz \
     --repo nekocadhq/occt-wasm --target nekocad-build --prerelease \
     --title "occt-wasm 5.0.0-nekocad.N" --notes "..."
   ```

5. In the NekoCAD platform repository, set `occt-wasm` in `packages/kernel/package.json` to
   `https://github.com/nekocadhq/occt-wasm/releases/download/v5.0.0-nekocad.N/occt-wasm-5.0.0-nekocad.N.tgz`,
   then run `pnpm install`. The release workflow there runs `just wasm` and packs the new wasm.

The npm publish, release-please, and crates.io workflows only run in `andymai/occt-wasm`, so a release here publishes nothing to a registry.

## Builder image

CI links against `ghcr.io/nekocadhq/occt-wasm-builder`, which bakes the OCCT static libraries. Rebuild and push it after a change to the OCCT commit, emsdk, or the CMake flags:

```bash
./scripts/builder-image.sh --build   # build only
./scripts/builder-image.sh           # build and push (needs a token with write:packages)
```
