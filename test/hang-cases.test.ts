/**
 * Fillets and chamfers that did not end before the fork of OCCT bounded their loops. The BREP
 * files are failure cases of NekoCAD (B61): one edge of `pico-case`, and a chamfer of
 * `dice-set`.
 *
 * - `pico-case`: the chain of tangent edges reaches an edge with three faces.
 *   `ReorderFaces` (ChFi3d_Builder_1.cxx) walked around the vertex and repeated the same step
 *   with no end, inside `BRepFilletAPI_MakeFillet::Add`.
 * - `dice-set`: the chamfer builds, is not valid, and the repair of the facade runs
 *   `ShapeFix_IntersectionTool::FixIntersectingWires`. A cut that changed no range made it
 *   try the same two edges again with no end.
 *
 * Each case must now fail with an error in a short time and with no stop. The operation runs
 * in a thread of Node, so a hang fails the test and does not stop the suite. On the threaded
 * build, the same operation must also stop with Interrupted when the flag holds the token.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

type Kernel = import("../ts/src/index.ts").OcctKernel;

const __dirname = dirname(fileURLToPath(import.meta.url));
const threads = process.env["OCCT_WASM_THREADS"] === "1";
const memory64 = process.env["OCCT_WASM64"] === "1";
const lib = pathToFileURL(resolve(__dirname, "../ts/dist/index.js")).href;

/** The longest time that a case may take to fail. Each one takes less than 1 s on an M-series Mac. */
const FAIL_FAST_MS = 10_000;

interface HangCase {
    name: string;
    brep: () => string;
    operation: "fillet" | "chamfer";
    /** The index of the edge in getSubShapes(shape, "edge"). */
    edge: number;
    size: number;
}

const fixture = (name: string) => resolve(__dirname, "fixtures/hang", name);

const CASES: HangCase[] = [
    {
        name: "a fillet of one edge of pico-case",
        brep: () => readFileSync(fixture("pico-case.brep"), "utf8"),
        operation: "fillet",
        edge: 51,
        size: 2.25,
    },
    {
        name: "a chamfer of one edge of pico-case",
        brep: () => readFileSync(fixture("pico-case.brep"), "utf8"),
        operation: "chamfer",
        edge: 51,
        size: 1,
    },
    {
        name: "a chamfer of dice-set",
        brep: () => gunzipSync(readFileSync(fixture("dice-set.brep.gz"))).toString("utf8"),
        operation: "chamfer",
        edge: 24,
        size: 0.4835,
    },
];

/** The code of the error of `c` in a thread of Node, or "none", or "hang" after `limit` ms. */
async function runInThread(c: HangCase, limit: number): Promise<{ code: string; ms: number }> {
    const worker = new Worker(
        `const { parentPort, workerData: d } = require("node:worker_threads");
         (async () => {
             const { OcctKernel } = await import(d.lib);
             const k = await OcctKernel.init({ threads: d.threads, memory64: d.memory64 });
             const input = k.fromBREP(d.brep);
             const edge = k.getSubShapes(input, "edge")[d.edge];
             const start = performance.now();
             let code = "none";
             try {
                 if (d.operation === "fillet") k.fillet(input, [edge], d.size);
                 else k.chamfer(input, [edge], d.size);
             } catch (e) {
                 code = e.code ?? String(e);
             }
             parentPort.postMessage({ code, ms: performance.now() - start });
         })().catch((e) => parentPort.postMessage({ code: "setup: " + e, ms: 0 }));`,
        {
            eval: true,
            workerData: { lib, threads, memory64, brep: c.brep(), operation: c.operation, edge: c.edge, size: c.size },
        },
    );
    try {
        return await new Promise((done, failed) => {
            const timer = setTimeout(() => done({ code: "hang", ms: limit }), limit);
            worker.once("message", (m: { code: string; ms: number }) => {
                clearTimeout(timer);
                done(m);
            });
            worker.once("error", (e) => {
                clearTimeout(timer);
                failed(e);
            });
        });
    } finally {
        await worker.terminate();
    }
}

describe("fillets and chamfers that hung", () => {
    for (const c of CASES) {
        it(`${c.name} fails fast with no stop`, async () => {
            const { code, ms } = await runInThread(c, 60_000);
            expect(code).not.toBe("hang");
            expect(code).not.toBe("none");
            expect(code).not.toBe("INTERRUPTED");
            expect(code).not.toMatch(/^setup/);
            expect(ms).toBeLessThan(FAIL_FAST_MS);
        }, 90_000);
    }
});

describe.skipIf(!threads)("fillets and chamfers that hung, with a stop", () => {
    let OcctKernel: typeof import("../ts/src/index.ts").OcctKernel;
    let OcctErrorCode: typeof import("../ts/src/index.ts").OcctErrorCode;
    let kernel: Kernel;

    beforeAll(async () => {
        const mod = await import(lib);
        OcctKernel = mod.OcctKernel;
        OcctErrorCode = mod.OcctErrorCode;
        kernel = await OcctKernel.init({ threads, memory64 });
    }, 60_000);

    afterEach(() => {
        kernel.setBreakToken(0);
        Atomics.store(kernel.interruptFlag()!, 0, 0);
        kernel.releaseAll();
    });

    afterAll(() => {
        kernel?.[Symbol.dispose]();
    });

    for (const c of CASES) {
        it(`${c.name} stops with Interrupted when the flag holds the token, and adds no handle`, () => {
            const input = kernel.fromBREP(c.brep());
            const edge = kernel.getSubShapes(input, "edge")[c.edge]!;
            const handles = kernel.shapeCount;
            Atomics.store(kernel.interruptFlag()!, 0, 21);
            kernel.setBreakToken(21);
            let code = "none";
            try {
                if (c.operation === "fillet") kernel.fillet(input, [edge], c.size);
                else kernel.chamfer(input, [edge], c.size);
            } catch (e) {
                code = (e as { code: string }).code;
            }
            expect(code).toBe(OcctErrorCode.Interrupted);
            expect(kernel.shapeCount).toBe(handles);
        });
    }
});
