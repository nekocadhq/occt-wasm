//! Build orchestration for occt-wasm.
//!
//! Compiles OCCT C++ to WASM via Emscripten, builds the C++ facade,
//! and packages the output as `@occt-wasm/core`.

use anyhow::Result;
use clap::Parser;

mod build;
mod build_wasi;
mod codegen;
mod util;

/// occt-wasm build tool.
#[derive(Parser)]
#[command(name = "xtask", version, about)]
enum Cli {
    /// Build OCCT static libs + facade → .wasm + .js + .d.ts
    Build {
        /// Enable release optimizations (-O3 + wasm-opt -O4)
        #[arg(long)]
        release: bool,
        /// Optimize for size (-Oz) instead of speed (-O3); requires --release
        #[arg(long)]
        size: bool,
        /// Build the threaded variant (pthreads) → dist/occt-wasm-mt.{js,wasm}
        #[arg(long)]
        threads: bool,
    },
    /// Build only OCCT static libraries (Milestone 0)
    BuildOcct {
        /// Build the pthreads libs into occt/build-mt instead of occt/build
        #[arg(long)]
        threads: bool,
    },
    /// Build WASI target for Rust crate (requires wasi-sdk)
    BuildWasi {
        /// Enable release optimizations (-O3 + wasm-opt)
        #[arg(long)]
        release: bool,
    },
    /// Run the facade code generator (v0.1.1)
    Codegen,
    /// Remove all build artifacts
    Clean {
        /// Keep facade/generated/ (avoid re-running codegen)
        #[arg(long)]
        keep_generated: bool,
    },
    /// Run integration tests (requires built WASM)
    Test {
        /// Run in watch mode (re-runs on file changes)
        #[arg(long)]
        watch: bool,
    },
}

const fn threads_of(threads: bool) -> build::Threads {
    if threads {
        build::Threads::On
    } else {
        build::Threads::Off
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli {
        Cli::Build {
            release,
            size,
            threads,
        } => build::build(release, size, threads_of(threads)),
        Cli::BuildOcct { threads } => build::build_occt(threads_of(threads)),
        Cli::BuildWasi { release } => build_wasi::build_wasi(release),
        Cli::Codegen => codegen::run::run(),
        Cli::Clean { keep_generated } => build::clean(keep_generated),
        Cli::Test { watch } => build::test(watch),
    }
}
