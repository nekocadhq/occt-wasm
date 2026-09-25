# occt-wasm for NekoCAD

This is the NekoCAD fork of [andymai/occt-wasm](https://github.com/andymai/occt-wasm). It publishes `@nekocad/occt-wasm` to npm, and NekoCAD installs it under the name `occt-wasm` through an npm alias, so a change to the facade reaches the app.

## Branches and versions

- `main` follows upstream. `nekocad-build` holds the NekoCAD changes on top of it.
- A NekoCAD version is a prerelease of the upstream version it is built on: `5.1.1-nekocad.1`, then `5.1.1-nekocad.2`. After a merge of upstream 5.2.0, the next one is `5.2.0-nekocad.1`.
- The `occt` submodule is on `nekocadhq/OCCT`. A new OCCT commit also needs a new builder image (see below).

## Build from scratch

Prerequisites: emsdk 5.0.3 (`~/emsdk`, then `source ~/emsdk/emsdk_env.sh`), Rust, Node, `ninja`, and `ccache` (`brew install ninja ccache`), and Docker for the builder image. On an Apple silicon Mac, a native build of the OCCT libs takes about 5 minutes; the old amd64 builder image took about an hour under emulation.

```bash
git submodule update --init
bash scripts/fetch-rapidjson.sh
npm ci --ignore-scripts && (cd ts && npm ci)
cargo xtask build-occt          # only on a new checkout or a new OCCT commit
cargo xtask build-occt --threads
cargo xtask build --release
cargo xtask build --release --threads
(cd ts && npm run build)        # the raw-access tests load ts/dist
cargo xtask test
OCCT_WASM_THREADS=1 npx vitest run  # the same suite on the threaded build
cargo xtask build-wasi --release  # after a facade change, so the crate stale-check passes
```

## Make a release

`./scripts/publish-nekocad.sh` does steps 2 to 4 after you set and commit the version. It checks the npm login first, builds, packs, publishes under the `nekocad` dist-tag, then tags and pushes. `--dry-run` publishes nothing, `--no-build` uses the WASM already in `dist/`, and `--otp CODE` passes a two-factor code. The upstream `scripts/publish.sh` publishes to `latest` and builds one variant only, so do not use it here.

1. Set the version: `cd ts && npm version 5.1.1-nekocad.N --no-git-tag-version`.
2. Build and test as above, then `cd ts && npm pack` and check the tarball.
3. Commit the version, tag `v5.1.1-nekocad.N`, and push the branch and the tag.
4. Publish from `ts/`, logged in to npm as a member of `@nekocad`:

   ```bash
   cd ts && npm publish nekocad-occt-wasm-5.1.1-nekocad.N.tgz --access public --tag nekocad
   ```

   `--tag nekocad` keeps `latest` off a prerelease version.

5. In the NekoCAD platform repository:
   `pnpm --dir packages/kernel add occt-wasm@npm:@nekocad/occt-wasm@5.1.1-nekocad.N`.
   `pnpm-workspace.yaml` excludes `@nekocad/*` from the release age wait, so a new version installs at once.

The npm publish, release-please, and crates.io workflows of upstream only run in `andymai/occt-wasm`, so pushing here publishes nothing.

## Builder image

CI links against `ghcr.io/nekocadhq/occt-wasm-builder`, which bakes the OCCT static libraries: `occt/build` and, for the threaded build, `occt/build-mt`. Rebuild and push it after a change to the OCCT commit, emsdk, or the CMake flags:

```bash
./scripts/builder-image.sh --build   # build for this machine only
./scripts/builder-image.sh           # build for linux/amd64 and linux/arm64, and push (needs a token with write:packages)
```

The image is multi-arch, but the libs compile once, natively on the machine that builds. They are WebAssembly, so each platform's image copies the same files.

## Threads and NekoCAD

The package holds a threaded build, `occt-wasm-mt`, which `OcctKernel.init()` loads when the page is cross-origin isolated. The NekoCAD desktop app sends the COOP and COEP headers with each response of its `nekocad://` protocol, and the Vite dev server sends them too. The README section "Threads" gives the rules.
