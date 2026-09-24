# syntax=docker/dockerfile:1
# Pre-built OCCT static libs for CI. Push to ghcr.io/nekocadhq/occt-wasm-builder.
# Rebuild only when OCCT submodule, emsdk version, or cmake flags change.
#
# The image is multi-arch (linux/amd64 for CI, linux/arm64 for Apple silicon),
# but OCCT compiles only once: the libs are WebAssembly, the same bytes for any
# host, so the `occt` stage runs on the platform of the machine that builds
# ($BUILDPLATFORM) and each image copies its output. No compile runs under
# emulation.

# --- OCCT static libs, compiled natively on the build machine ---
FROM --platform=$BUILDPLATFORM emscripten/emsdk:5.0.3 AS occt

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake ninja-build ccache \
    && rm -rf /var/lib/apt/lists/*

# emcmake replaces the compiler with emcc, so CC=ccache would never apply.
# Emscripten's own wrapper puts ccache in front of the clang that emcc runs.
ENV EM_COMPILER_WRAPPER=ccache \
    CCACHE_DIR=/cache/ccache \
    CCACHE_BASEDIR=/workspace \
    CCACHE_NOHASHDIR=1

WORKDIR /workspace

# RapidJSON headers
COPY scripts/fetch-rapidjson.sh scripts/
RUN bash scripts/fetch-rapidjson.sh

# OCCT source + build: `build` without threads, `build-mt` with pthreads.
# ~50 min each on a cold cache; a few minutes when ccache has the objects.
# These flags must match `Threads::cflags` in xtask/src/build.rs.
COPY occt/ occt/
RUN --mount=type=cache,target=/cache/ccache \
    for variant in build build-mt; do \
        if [ "$variant" = build-mt ]; then \
            flags="-fwasm-exceptions -O3 -msimd128 -pthread -DOCCT_NO_PLUGINS"; \
        else \
            flags="-fwasm-exceptions -O3 -msimd128 -DIGNORE_NO_ATOMICS=1 -DOCCT_NO_PLUGINS"; \
        fi; \
        mkdir -p "occt/$variant" && cd "occt/$variant" \
        && emcmake cmake .. \
            -G Ninja \
            -DCMAKE_BUILD_TYPE=Release \
            -DBUILD_MODULE_FoundationClasses=TRUE \
            -DBUILD_MODULE_ModelingData=TRUE \
            -DBUILD_MODULE_ModelingAlgorithms=TRUE \
            -DBUILD_MODULE_DataExchange=TRUE \
            -DBUILD_MODULE_ApplicationFramework=TRUE \
            -DBUILD_MODULE_Visualization=FALSE \
            -DBUILD_MODULE_Draw=FALSE \
            -DBUILD_LIBRARY_TYPE=Static \
            -DUSE_FREETYPE=OFF \
            -DUSE_RAPIDJSON=ON \
            -D3RDPARTY_RAPIDJSON_INCLUDE_DIR=/workspace/3rdparty/rapidjson \
            "-DCMAKE_C_FLAGS=$flags" \
            "-DCMAKE_CXX_FLAGS=$flags" \
            -Wno-dev \
        && cmake --build . --parallel \
        && echo "OCCT $variant: $(ls -1 lin32/clang/lib/*.a 2>/dev/null | wc -l) static libs" \
        && cd /workspace || exit 1; \
    done

# --- The image that CI runs, one for each target platform ---
FROM emscripten/emsdk:5.0.3

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake ninja-build ccache \
    && rm -rf /var/lib/apt/lists/*

# Rust (needed for xtask)
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain "$(grep channel /tmp/rust-toolchain.toml | cut -d'"' -f2)" \
    && rm /tmp/rust-toolchain.toml
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /workspace

# The OCCT headers in build*/include are stubs that include /workspace/occt/src,
# so the source comes along with the libs.
COPY --from=occt /workspace/3rdparty 3rdparty
COPY --from=occt /workspace/occt occt
