//! Shared utilities for the xtask build tool.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Project root (parent of xtask/).
pub fn project_root() -> Result<PathBuf> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
    let root = Path::new(&manifest_dir)
        .parent()
        .context("xtask must be inside the workspace")?
        .to_path_buf();
    Ok(root)
}

/// Locate the OCCT static-lib directory in an Emscripten build tree.
///
/// emsdk's wasm32 target is detected by OCCT's build as 32-bit Linux, so the
/// libs land in `lin32/clang/lib`. The other entries are fallbacks for alternate
/// layouts; the specific clang paths are tried before the bare `lib/` so a stray
/// top-level `lib/` can't shadow the real build output. The npm and WASI builds
/// share this one ordering so they always resolve to the same directory.
pub fn find_occt_lib_dir(occt_build: &Path) -> Result<PathBuf> {
    let candidates = [
        occt_build.join("lin32/clang/lib"),
        occt_build.join("lin/clang/lib"),
        occt_build.join("wasm32/clang/lib"),
        occt_build.join("lib"),
    ];
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .with_context(|| {
            format!(
                "OCCT static libs not found under {}; tried: {}",
                occt_build.display(),
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

/// Path to `wasm-opt`, preferring emsdk's bundled copy (which has the correct
/// feature flags) over whatever happens to be on `PATH`.
pub fn find_wasm_opt() -> PathBuf {
    if let Some(p) = std::env::var("EMSDK")
        .ok()
        .map(|e| PathBuf::from(e).join("upstream/bin/wasm-opt"))
        .filter(|p| p.exists())
    {
        return p;
    }
    if let Some(p) = home_dir()
        .map(|h| h.join("emsdk/upstream/bin/wasm-opt"))
        .filter(|p| p.exists())
    {
        return p;
    }
    PathBuf::from("wasm-opt")
}

/// The user's home directory from `$HOME`, if set.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// Convert a byte count to mebibytes for human-readable build output.
#[allow(clippy::cast_precision_loss)] // file sizes fit in an f64 mantissa
pub fn bytes_to_mb(n: u64) -> f64 {
    n as f64 / 1_048_576.0
}

/// The environment that sends each Emscripten compile through ccache, or
/// nothing when ccache is not installed.
///
/// `CC=ccache` does not work here: emcmake replaces the compiler with `emcc`,
/// and ccache does not know the arguments of `emcc`. Emscripten's own
/// `EM_COMPILER_WRAPPER` puts ccache in front of the clang that `emcc` runs,
/// and ccache knows clang. `CCACHE_BASEDIR` makes the paths relative, so a
/// second checkout, or the builder container, hits the same cache. A wrapper
/// that the caller already set stays.
pub fn ccache_env(root: &Path) -> Vec<(&'static str, String)> {
    if std::env::var_os("EM_COMPILER_WRAPPER").is_some() || find_on_path("ccache").is_none() {
        return Vec::new();
    }
    vec![
        ("EM_COMPILER_WRAPPER", "ccache".to_owned()),
        ("CCACHE_BASEDIR", root.display().to_string()),
        ("CCACHE_NOHASHDIR", "1".to_owned()),
    ]
}

/// The first executable called `name` on `PATH`.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// Run the commands at the same time, no more than one for each processor, and
/// fail when one of them fails. `label` names each command in the log.
pub fn run_parallel(commands: Vec<(String, Command)>) -> Result<()> {
    let limit = std::thread::available_parallelism().map_or(4, std::num::NonZeroUsize::get);
    let mut pending = commands.into_iter();
    let mut running = Vec::new();
    let mut failed = Vec::new();
    loop {
        while running.len() < limit {
            let Some((label, mut command)) = pending.next() else {
                break;
            };
            eprintln!("  Compiling {label}...");
            let child = command
                .spawn()
                .with_context(|| format!("failed to start the compile of {label}"))?;
            running.push((label, child));
        }
        if running.is_empty() {
            break;
        }
        let (label, mut child) = running.remove(0);
        if !child.wait()?.success() {
            failed.push(label);
        }
    }
    if !failed.is_empty() {
        bail!("compile failed: {}", failed.join(", "));
    }
    Ok(())
}
