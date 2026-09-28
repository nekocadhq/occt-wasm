/**
 * The npm build that the suite loads from `dist/`: `occt-wasm` by default, the
 * threaded `occt-wasm-mt` when `OCCT_WASM_THREADS=1`, and the 64-bit
 * `occt-wasm64` and `occt-wasm64-mt` when `OCCT_WASM64=1` too. CI runs the
 * suite for each, since they link different allocators and OCCT libs.
 */
const bits = process.env["OCCT_WASM64"] === "1" ? "64" : "";
const threads = process.env["OCCT_WASM_THREADS"] === "1" ? "-mt" : "";

export const WASM_STEM = `occt-wasm${bits}${threads}`;
