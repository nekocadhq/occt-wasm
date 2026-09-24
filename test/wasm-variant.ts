/**
 * The npm build that the suite loads from `dist/`: `occt-wasm` by default, and
 * the threaded `occt-wasm-mt` when `OCCT_WASM_THREADS=1`. CI runs the suite for
 * each, since the two link different allocators and OCCT libs.
 */
export const WASM_STEM = process.env["OCCT_WASM_THREADS"] === "1" ? "occt-wasm-mt" : "occt-wasm";
