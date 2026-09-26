//! Build pipeline: OCCT static libs → facade compilation → linking → wasm-opt.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use xshell::{Shell, cmd};

use crate::util::{
    bytes_to_mb, ccache_env, find_occt_lib_dir, find_wasm_opt, project_root, run_parallel,
};

/// Emscripten's default stack is 64 KB and it sits directly above the static
/// data segment, so an overflow silently overwrites globals instead of
/// trapping: a variable-radius fillet on a box needs ~75 KB and left every
/// later BREP/STEP write in the session faulting (#306). OCCT is developed
/// against native 8 MB stacks, so give it the same headroom; untouched pages
/// cost nothing.
pub const WASM_STACK_SIZE: u32 = 8 * 1024 * 1024;

/// The stack of each OCCT worker thread in the threaded build. Emscripten's
/// default is 64 KB, which a fillet already overruns on the main thread (see
/// [`WASM_STACK_SIZE`]). The stacks come from the heap, one for each worker.
const PTHREAD_STACK_SIZE: u32 = 2 * 1024 * 1024;

/// The number of Web Workers that the threaded glue starts before the module
/// runs: one fewer than the logical processors, from 1 to 10. The caller's thread
/// is the last one. It is a JavaScript expression, because the glue evaluates it.
/// On a 16-core machine, 10 workers rebuild a modeled thread 5% faster than 7,
/// and 15 only 2% faster than 10, for about 13 MB of memory for each worker.
///
/// OCCT must not start more threads than this. A Web Worker starts only after
/// the thread that made it returns to its event loop, and an OCCT thread pool
/// blocks that thread until its jobs are done, so one more thread is a
/// deadlock. The facade reads the size of this pool when it sizes OCCT's pool
/// (`facade/src/kernel.cpp`).
const PTHREAD_POOL_SIZE: &str =
    "Math.min(Math.max((globalThis.navigator?.hardwareConcurrency??2)-1,1),10)";

/// Whether a build uses Emscripten pthreads.
///
/// The threaded build needs a `SharedArrayBuffer`, so it runs only on a page
/// that is cross-origin isolated (COOP and COEP headers). It has its own OCCT
/// static libs, because every object in a threaded link must be compiled with
/// `-pthread`, and its own output file, so a package ships both builds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Threads {
    /// One thread. Runs everywhere.
    Off,
    /// OCCT's parallel algorithms on a pool of Web Workers.
    On,
}

impl Threads {
    /// The C and C++ flags of OCCT and of the facade.
    const fn cflags(self) -> &'static [&'static str] {
        match self {
            Self::Off => &[
                "-fwasm-exceptions",
                "-O3",
                "-msimd128",
                "-DIGNORE_NO_ATOMICS=1",
                "-DOCCT_NO_PLUGINS",
            ],
            Self::On => &[
                "-fwasm-exceptions",
                "-O3",
                "-msimd128",
                "-pthread",
                "-DOCCT_NO_PLUGINS",
            ],
        }
    }

    /// The OCCT build tree of this variant.
    pub fn occt_build_dir(self, root: &Path) -> PathBuf {
        root.join(match self {
            Self::Off => "occt/build",
            Self::On => "occt/build-mt",
        })
    }

    /// The directory of the facade objects of this variant.
    fn object_dir(self, root: &Path) -> PathBuf {
        root.join(match self {
            Self::Off => "build",
            Self::On => "build-mt",
        })
    }

    /// The file name of the glue and the `.wasm`, without the extension.
    const fn output_stem(self) -> &'static str {
        match self {
            Self::Off => "occt-wasm",
            Self::On => "occt-wasm-mt",
        }
    }
}

/// Step 1: Build OCCT static libraries via emcmake cmake.
pub fn build_occt(threads: Threads) -> Result<()> {
    let root = project_root()?;
    let occt_dir = root.join("occt");
    let build_dir = threads.occt_build_dir(&root);

    if !occt_dir.join("CMakeLists.txt").exists() {
        bail!(
            "OCCT source not found at {}. Run: git submodule update --init",
            occt_dir.display()
        );
    }

    let sh = Shell::new()?;
    sh.create_dir(&build_dir)?;
    sh.change_dir(&build_dir);
    for (key, value) in ccache_env(&root) {
        sh.set_var(key, value);
    }

    // Skip if already configured
    if build_dir.join("build.ninja").exists() {
        eprintln!("Step 1a: OCCT already configured, skipping cmake.");
    } else {
        eprintln!("Step 1a: Configuring OCCT ({threads:?} threads) with emcmake cmake...");

        let c_flags = threads.cflags().join(" ");
        let cxx_flags = &c_flags;
        let rapidjson_inc = root.join("3rdparty/rapidjson").display().to_string();

        cmd!(
            sh,
            "emcmake cmake {occt_dir}
            -G Ninja
            -DCMAKE_BUILD_TYPE=Release
            -DBUILD_MODULE_FoundationClasses=TRUE
            -DBUILD_MODULE_ModelingData=TRUE
            -DBUILD_MODULE_ModelingAlgorithms=TRUE
            -DBUILD_MODULE_DataExchange=TRUE
            -DBUILD_MODULE_ApplicationFramework=TRUE
            -DBUILD_MODULE_Visualization=FALSE
            -DBUILD_MODULE_Draw=FALSE
            -DBUILD_LIBRARY_TYPE=Static
            -DUSE_FREETYPE=OFF
            -DUSE_RAPIDJSON=ON
            -D3RDPARTY_RAPIDJSON_INCLUDE_DIR={rapidjson_inc}
            -DCMAKE_C_FLAGS={c_flags}
            -DCMAKE_CXX_FLAGS={cxx_flags}
            -Wno-dev"
        )
        .run()?;
    }

    eprintln!("Step 1b: Building OCCT...");
    cmd!(sh, "cmake --build . --parallel").run()?;

    eprintln!("OCCT static libs built successfully.");
    Ok(())
}

/// Step 2: Compile facade C++ files with emcc, all at the same time.
fn compile_facade(root: &Path, threads: Threads) -> Result<Vec<PathBuf>> {
    let build_dir = threads.object_dir(root);
    std::fs::create_dir_all(&build_dir)?;

    let occt_inc = threads.occt_build_dir(root).join("include/opencascade");
    let facade_inc = root.join("facade/include");

    if !occt_inc.exists() {
        bail!(
            "OCCT include dir not found at {}. Run `cargo xtask build-occt` first.",
            occt_inc.display()
        );
    }

    let mut sources: Vec<PathBuf> = std::fs::read_dir(root.join("facade/src"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "cpp"))
        .collect();

    // Also compile generated facade files (kernel_<category>.cpp + bindings.cpp).
    // Exclude wasi_exports.cpp: it's the C-ABI export layer for the standalone
    // WASI build (cargo xtask build-wasi), not the Embind/npm path, so linking it
    // here only adds ~60 KB of dead code.
    let gen_dir = root.join("facade/generated");
    if gen_dir.is_dir() {
        let gen_sources: Vec<PathBuf> = std::fs::read_dir(&gen_dir)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "cpp"))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.starts_with("wasi_"))
            })
            .collect();
        sources.extend(gen_sources);
    }

    // Sort for deterministic compilation order across platforms.
    sources.sort();

    // Track header mtimes: if any header changed, all objects are stale.
    let newest_header = newest_header_mtime(&facade_inc)?;
    let ccache = ccache_env(root);

    let mut objects = Vec::new();
    let mut compiles = Vec::new();
    for src in &sources {
        let name = src.file_stem().context("no file stem")?.to_string_lossy();
        let is_generated = src.starts_with(&gen_dir);
        let prefix = if is_generated { "gen_" } else { "" };
        let obj = build_dir.join(format!("{prefix}{name}.o"));
        objects.push(obj.clone());

        // Skip if .o is newer than both the .cpp and all facade headers.
        if obj.exists() {
            let src_modified = std::fs::metadata(src)?.modified()?;
            let newest_dep = newest_header.map_or(src_modified, |h| h.max(src_modified));
            let obj_modified = std::fs::metadata(&obj)?.modified()?;
            if obj_modified >= newest_dep {
                continue;
            }
        }

        let mut command = std::process::Command::new("em++");
        command
            .arg("-std=c++17")
            .args(threads.cflags())
            // The link below uses mimalloc (see `link_wasm`).
            .arg("-DOCCT_WASM_MIMALLOC=1")
            .arg("-I")
            .arg(&occt_inc)
            .arg("-I")
            .arg(&facade_inc)
            .args(["-w", "-c"])
            .arg(src)
            .arg("-o")
            .arg(&obj)
            .envs(ccache.iter().map(|(k, v)| (k, v)));
        compiles.push((format!("{prefix}{name}.cpp"), command));
    }
    run_parallel(compiles)?;

    Ok(objects)
}

/// OCCT static libraries not used by the facade — excluded from linking.
const EXCLUDED_LIBS: &[&str] = &[
    // Persistence / serialization
    "libTKStd.a",
    "libTKStdL.a",
    "libTKBin.a",
    "libTKBinL.a",
    "libTKBinXCAF.a",
    "libTKBinTObj.a",
    "libTKXml.a",
    "libTKXmlL.a",
    "libTKXmlXCAF.a",
    "libTKXmlTObj.a",
    "libTKTObj.a",
    // Note: TKVCAF NOT excluded — TKXCAF depends on TPrsStd_Driver from TKVCAF
    // Unused exchange formats
    "libTKDEVRML.a",
    "libTKDEOBJ.a",
    "libTKDEPLY.a",
    "libTKDECascade.a",
    "libTKXMesh.a",
    // Note: TKV3d and TKService NOT excluded — TKXCAF depends on Graphic3d_* from TKService
    // Features not used by facade
    "libTKFeat.a",
    "libTKHelix.a",
];

/// Step 3: Link facade objects + OCCT static libs → .wasm + .js
fn link_wasm(
    root: &Path,
    objects: &[PathBuf],
    threads: Threads,
    release: bool,
    size: bool,
) -> Result<()> {
    let dist_dir = root.join("dist");
    std::fs::create_dir_all(&dist_dir)?;

    let occt_lib_dir = find_occt_lib_dir(&threads.occt_build_dir(root))?;

    // Collect all OCCT static lib paths, filtering out unused libraries.
    let mut all_libs: Vec<PathBuf> = std::fs::read_dir(&occt_lib_dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "a"))
        .collect();
    all_libs.sort(); // Deterministic link order across platforms.
    let total = all_libs.len();

    let occt_libs: Vec<String> = all_libs
        .into_iter()
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned());
            !name.is_some_and(|n| EXCLUDED_LIBS.contains(&n.as_str()))
        })
        .map(|p| p.display().to_string())
        .collect();

    let excluded = total - occt_libs.len();
    eprintln!("  Excluded {excluded}/{total} unused OCCT libs from link.");

    let obj_strs: Vec<String> = objects.iter().map(|p| p.display().to_string()).collect();
    let output = dist_dir.join(format!("{}.js", threads.output_stem()));
    let output_str = output.display().to_string();
    let post_js = root.join("scripts/symbol_dispose.js");
    let post_js_str = post_js.display().to_string();

    let opt_level = if release && size {
        "-Oz"
    } else if release {
        "-O3"
    } else {
        "-O2"
    };

    // Build the full args list
    let mut args: Vec<String> = vec![
        "-lembind".into(),
        "-fwasm-exceptions".into(),
        "-msimd128".into(),
        "-mtail-call".into(),
        opt_level.into(),
        "-sINITIAL_MEMORY=134217728".into(),
        "-sMAXIMUM_MEMORY=4294967296".into(),
        "-sALLOW_MEMORY_GROWTH=1".into(),
        format!("-sSTACK_SIZE={WASM_STACK_SIZE}"),
        "-sEXPORT_ES6=1".into(),
        "-sWASM_BIGINT".into(),
        "-sMODULARIZE=1".into(),
        "-sEXPORT_NAME=createOcctWasm".into(),
        "-sEXPORTED_RUNTIME_METHODS=[\"FS\",\"HEAP32\",\"HEAPF32\",\"HEAPU32\",\"wasmMemory\"]"
            .into(),
        "-sEXPORT_EXCEPTION_HANDLING_HELPERS=1".into(),
        "--no-entry".into(),
        format!("--post-js={post_js_str}"),
    ];

    // mimalloc instead of dlmalloc: OCCT allocates many small objects, and
    // mimalloc made booleans and STEP export 4-10% faster with one thread. With
    // threads it matters more, since dlmalloc takes one global lock for each
    // allocation and OCCT allocates in every parallel job.
    args.push("-sMALLOC=mimalloc".into());

    // Threads: a pool of Web Workers made before the module runs.
    // EVAL_CTORS runs the static constructors at link time. Emscripten does not
    // support it with pthreads, whose data segments are passive.
    if threads == Threads::Off {
        args.push("-sEVAL_CTORS=2".into());
    }
    if threads == Threads::On {
        args.extend([
            "-pthread".into(),
            format!("-sPTHREAD_POOL_SIZE={PTHREAD_POOL_SIZE}"),
            format!("-sDEFAULT_PTHREAD_STACK_SIZE={PTHREAD_STACK_SIZE}"),
        ]);
    }

    // Debug builds trap in the prologue of any function that would overrun the
    // stack, turning a silent static-data overwrite into a loud failure.
    if !release {
        args.push("-sSTACK_OVERFLOW_CHECK=2".into());
    }

    // No -flto. The facade objects and the prebuilt OCCT static libs are both
    // compiled without -flto, so nothing in the link is LTO bitcode and the flag
    // buys no optimization. Worse, passing it drives an Emscripten/Binaryen
    // LTO-path miscompile that corrupts the heap (#293): a wild pointer planted
    // during a boolean/fillet-heavy sequence that only surfaces later as an
    // out-of-bounds trap in an unrelated clone. Dropping it is a pure win.

    // Add object files
    args.extend(obj_strs);
    // Add OCCT static libs
    args.extend(occt_libs);
    // Output
    args.push("-o".into());
    args.push(output_str);

    eprintln!("Step 3: Linking WASM ({opt_level})...");

    // xshell cmd! doesn't support dynamic arg lists well, use std::process::Command
    let status = std::process::Command::new("em++")
        .args(&args)
        .status()
        .context("failed to run em++")?;

    if !status.success() {
        bail!("em++ linking failed with status: {status}");
    }

    Ok(())
}

/// Emscripten's ES6 glue reaches for `node:module` to build a `require` for the
/// Node path. Webpack resolves that specifier even though the branch guarding it
/// is dead in a browser build, and hard-fails with `UnhandledSchemeError`. The
/// `webpackIgnore` marker leaves the import as a runtime import, which never
/// evaluates outside Node — that is what lets the TS wrapper import the glue
/// with a plain, bundler-visible `import("./occt-wasm.js")` so webpack (and
/// Next.js) can emit the glue chunk and rewrite the `.wasm` asset URL.
///
/// The threaded glue also imports `node:worker_threads` for its Node pthreads,
/// so every `node:` import gets the marker.
fn patch_glue_for_bundlers(root: &Path, threads: Threads) -> Result<()> {
    const TARGET: &str = "import(\"node:";
    const MARKER: &str = "import(/* webpackIgnore: true */ \"node:";
    const REQUIRED: &str = "import(/* webpackIgnore: true */ \"node:module\")";

    let glue = root.join(format!("dist/{}.js", threads.output_stem()));
    let source = std::fs::read_to_string(&glue)
        .with_context(|| format!("failed to read {}", glue.display()))?;
    let patched = source.replace(TARGET, MARKER);

    if !patched.contains(REQUIRED) {
        bail!(
            "{} contains no `import(\"node:module\")` to mark for bundlers. Emscripten \
             likely changed how the ES6 glue loads Node builtins — check the new shape \
             against a webpack build and update `patch_glue_for_bundlers`.",
            glue.display()
        );
    }

    if patched != source {
        std::fs::write(&glue, patched)
            .with_context(|| format!("failed to write {}", glue.display()))?;
    }
    Ok(())
}

/// Step 4: Run wasm-opt on the output.
fn optimize_wasm(sh: &Shell, root: &Path, threads: Threads) -> Result<()> {
    let wasm = root.join(format!("dist/{}.wasm", threads.output_stem()));
    let wasm_str = wasm.display().to_string();

    let wasm_opt_bin = find_wasm_opt();

    // Deliberately NOT translating legacy `try`/`catch` to the new
    // `try_table`/`exnref` encoding here (cf. `convert_eh` in build_wasi.rs).
    // Firefox emits a deprecation warning for legacy EH, but it still runs it;
    // exnref, by contrast, is rejected by Node's V8 without
    // --experimental-wasm-exnref and post-dates the Chrome 114 / Safari 17.2
    // floor. The crate build can use exnref only because wasmtime is configured
    // to accept it; the npm build targets unmodified browsers AND Node, so
    // legacy EH stays. Revisit once exnref is default across the support matrix.
    let threads_flag: &[&str] = match threads {
        Threads::Off => &[],
        Threads::On => &["--enable-threads"],
    };
    eprintln!("Step 4: Running wasm-opt...");
    cmd!(
        sh,
        "{wasm_opt_bin} -O4 --strip-debug --strip-producers
        --converge --gufa
        --enable-bulk-memory --enable-sign-ext
        --enable-nontrapping-float-to-int --enable-mutable-globals
        --enable-exception-handling --enable-simd --enable-tail-call
        {threads_flag...}
        {wasm_str} -o {wasm_str}"
    )
    .run()?;

    Ok(())
}

/// Find the newest mtime among all `.h`, `.hxx`, and `.hpp` files in a
/// directory tree (recursive).
///
/// Returns `None` if the directory doesn't exist or contains no headers.
fn newest_header_mtime(include_dir: &Path) -> Result<Option<std::time::SystemTime>> {
    if !include_dir.is_dir() {
        return Ok(None);
    }
    let mut newest = None;
    let mut stack = vec![include_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)?.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let is_header = path
                .extension()
                .is_some_and(|e| e == "h" || e == "hxx" || e == "hpp");
            if is_header {
                let mtime = std::fs::metadata(&path)?.modified()?;
                newest = Some(newest.map_or(mtime, |prev: std::time::SystemTime| prev.max(mtime)));
            }
        }
    }
    Ok(newest)
}

/// Full build: OCCT + facade + link + wasm-opt.
pub fn build(release: bool, size: bool, threads: Threads) -> Result<()> {
    let root = project_root()?;
    let sh = Shell::new()?;

    // Step 1: Build OCCT static libs (skip if already built)
    let occt_lib_dir = find_occt_lib_dir(&threads.occt_build_dir(&root));
    if occt_lib_dir.is_err() {
        eprintln!("Step 1: OCCT static libs not found, building...");
        build_occt(threads)?;
    } else {
        eprintln!("Step 1: OCCT static libs found, skipping.");
    }

    // Step 1b: Run codegen if generated facade is missing
    let gen_kernel = root.join("facade/generated/kernel_primitives.cpp");
    if !gen_kernel.exists() {
        eprintln!("Step 1b: Generated facade not found, running codegen...");
        crate::codegen::run::run()?;
    }

    // Step 2: Compile facade
    eprintln!("Step 2: Compiling facade...");
    let objects = compile_facade(&root, threads)?;
    eprintln!("  {} object files ready.", objects.len());

    // Step 3: Link
    link_wasm(&root, &objects, threads, release, size)?;
    patch_glue_for_bundlers(&root, threads)?;

    // Step 4: wasm-opt (release only)
    if release {
        optimize_wasm(&sh, &root, threads)?;
    }

    // Report
    let wasm_path = root.join(format!("dist/{}.wasm", threads.output_stem()));
    if wasm_path.exists() {
        let size_mb = bytes_to_mb(std::fs::metadata(&wasm_path)?.len());
        eprintln!(
            "Build complete: dist/{}.wasm ({size_mb:.1}MB)",
            threads.output_stem()
        );
    }

    Ok(())
}

/// Remove all build artifacts.
pub fn clean(keep_generated: bool) -> Result<()> {
    let root = project_root()?;
    let sh = Shell::new()?;

    let mut dirs_to_clean = vec![
        Threads::Off.occt_build_dir(&root),
        Threads::On.occt_build_dir(&root),
        Threads::Off.object_dir(&root),
        Threads::On.object_dir(&root),
        root.join("dist"),
    ];
    if !keep_generated {
        dirs_to_clean.push(root.join("facade/generated"));
    }

    for dir in &dirs_to_clean {
        if dir.exists() {
            eprintln!("Removing {}", dir.display());
            sh.remove_path(dir)?;
        }
    }

    eprintln!("Clean complete.");
    Ok(())
}

/// Run integration tests.
pub fn test(watch: bool) -> Result<()> {
    let root = project_root()?;
    let sh = Shell::new()?;

    if !root.join("dist/occt-wasm.wasm").exists() {
        bail!("WASM not built. Run `cargo xtask build` first.");
    }

    sh.change_dir(root.join("ts"));
    if watch {
        cmd!(sh, "npx vitest --watch").run()?;
    } else {
        cmd!(sh, "npx vitest run").run()?;
    }

    Ok(())
}
