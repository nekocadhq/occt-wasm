/**
 * A stop from another thread: the interrupt flag, setBreakToken, and the
 * OcctErrorCode.Interrupted that a stopped call throws.
 *
 * Only a threaded build has a heap that another thread can write during a
 * call, so most of these tests run only with OCCT_WASM_THREADS=1. They load
 * the built ts/dist, as raw-access.test.ts does, to test the wrapper.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

type Kernel = import("../ts/src/index.ts").OcctKernel;
type Shape = import("../ts/src/index.ts").ShapeHandle;

const __dirname = dirname(fileURLToPath(import.meta.url));
const threads = process.env["OCCT_WASM_THREADS"] === "1";
const memory64 = process.env["OCCT_WASM64"] === "1";

let OcctKernel: typeof import("../ts/src/index.ts").OcctKernel;
let OcctError: typeof import("../ts/src/index.ts").OcctError;
let OcctErrorCode: typeof import("../ts/src/index.ts").OcctErrorCode;
let kernel: Kernel;

beforeAll(async () => {
    const mod = await import(resolve(__dirname, "../ts/dist/index.js"));
    OcctKernel = mod.OcctKernel;
    OcctError = mod.OcctError;
    OcctErrorCode = mod.OcctErrorCode;
    kernel = await OcctKernel.init({ threads, memory64 });
}, 60_000);

afterEach(() => {
    kernel.setBreakToken(0);
    const flag = kernel.interruptFlag();
    if (flag) Atomics.store(flag, 0, 0);
    kernel.releaseAll();
});

afterAll(() => {
    kernel?.[Symbol.dispose]();
});

/** The code of the OcctError that `run` throws, or "none" when it returns. */
function codeOf(run: () => unknown): string {
    try {
        run();
        return "none";
    } catch (e) {
        expect(e).toBeInstanceOf(OcctError);
        return (e as InstanceType<typeof OcctError>).code;
    }
}

/** A box with a grid of cylinders in it: each case below takes these inputs. */
function plate(k: Kernel, count: number, radius = 3): { body: Shape; tools: Shape[] } {
    const body = k.makeBox(10 * count + 10, 10 * count + 10, 10);
    const tools: Shape[] = [];
    for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
            tools.push(k.translate(k.makeCylinder(radius, 20), 10 * i + 10, 10 * j + 10, -5));
        }
    }
    return { body, tools };
}

interface Case {
    name: string;
    /** Runs the operation, and gives what must be the same after a stop. */
    run: (k: Kernel) => number[];
}

const CASES: Case[] = [
    {
        name: "a boolean",
        run: (k) => {
            const { body, tools } = plate(k, 3);
            const result = k.cutAll(body, tools);
            return [k.getVolume(result), k.getSubShapes(result, "face").length];
        },
    },
    {
        name: "a shell",
        run: (k) => {
            const box = k.makeBox(20, 20, 20);
            const top = k.getSubShapes(box, "face")[5]!;
            const result = k.shell(box, [top], 2, 1e-6);
            return [k.getVolume(result), k.getSubShapes(result, "face").length];
        },
    },
    {
        name: "a mesh",
        run: (k) => {
            const sphere = k.makeSphere(10);
            const mesh = k.tessellate(sphere, { linearDeflection: 0.05 });
            return [mesh.positions.length, mesh.indices.length];
        },
    },
];

describe.skipIf(!threads)("a stop on the threaded build", () => {
    it("gives an Int32Array on the shared heap", () => {
        const flag = kernel.interruptFlag();
        expect(flag).toBeInstanceOf(Int32Array);
        expect(flag!.buffer).toBeInstanceOf(SharedArrayBuffer);
        expect(flag!.length).toBe(1);
        expect(Atomics.load(flag!, 0)).toBe(0);
    });

    for (const c of CASES) {
        describe(c.name, () => {
            it("throws Interrupted when the flag holds the token before the call", () => {
                const before = c.run(kernel);
                kernel.releaseAll();
                const handles = kernel.shapeCount;
                Atomics.store(kernel.interruptFlag()!, 0, 7);
                kernel.setBreakToken(7);
                // The inputs come before the token, so only the operation can stop.
                expect(codeOf(() => c.run(kernel))).toBe(OcctErrorCode.Interrupted);
                expect(before.length).toBeGreaterThan(0);
                expect(handles).toBe(0);
            });

            it("finishes when the flag holds another token", () => {
                const expected = c.run(kernel);
                Atomics.store(kernel.interruptFlag()!, 0, 8);
                kernel.setBreakToken(7);
                expect(c.run(kernel)).toEqual(expected);
            });

            it("gives the same result as a new kernel after a stop, and leaves no handle", async () => {
                const fresh = await OcctKernel.init({ threads, memory64 });
                let expected: number[];
                try {
                    expected = c.run(fresh);
                } finally {
                    fresh[Symbol.dispose]();
                }

                const flag = kernel.interruptFlag()!;
                // The inputs do not stop, because they use no algorithm that asks for a break.
                const handles = kernel.shapeCount;
                Atomics.store(flag, 0, 9);
                kernel.setBreakToken(9);
                expect(codeOf(() => c.run(kernel))).toBe(OcctErrorCode.Interrupted);
                kernel.setBreakToken(0);
                Atomics.store(flag, 0, 0);
                kernel.releaseAll();
                expect(kernel.shapeCount).toBe(handles);

                expect(c.run(kernel)).toEqual(expected);
            });
        });
    }

    it("keeps the handles of the inputs, and adds none, when a call stops", () => {
        const { body, tools } = plate(kernel, 3);
        const handles = kernel.shapeCount;
        Atomics.store(kernel.interruptFlag()!, 0, 3);
        kernel.setBreakToken(3);
        expect(codeOf(() => kernel.cutAll(body, tools))).toBe(OcctErrorCode.Interrupted);
        expect(kernel.shapeCount).toBe(handles);
        kernel.setBreakToken(0);
        const volume = kernel.getVolume(kernel.cutAll(body, tools));
        expect(volume).toBeGreaterThan(0);
    });

    it("stops a slow boolean less than 100 ms after another thread writes the flag", async () => {
        // The cylinders cut each other too: about 1 s on an M-series Mac.
        const { body, tools } = plate(kernel, 14, 6);
        // How long the boolean takes with no stop: it must outlast the write.
        const start = performance.now();
        kernel.cutAll(body, tools);
        const full = performance.now() - start;
        expect(full).toBeGreaterThan(300);

        const flag = kernel.interruptFlag()!;
        // [0] the time of the write, from the other thread.
        const written = new Float64Array(new SharedArrayBuffer(8));
        const worker = new Worker(
            `const { parentPort, workerData } = require("node:worker_threads");
             parentPort.once("message", () => {
                 setTimeout(() => {
                     workerData.written[0] = performance.timeOrigin + performance.now();
                     Atomics.store(workerData.flag, 0, 11);
                     parentPort.postMessage("done");
                 }, 20);
             });`,
            { eval: true, workerData: { flag, written } },
        );
        try {
            await new Promise((ready) => worker.once("online", ready));
            kernel.setBreakToken(11);
            worker.postMessage("go");
            expect(codeOf(() => kernel.cutAll(body, tools))).toBe(OcctErrorCode.Interrupted);
            const stopped = performance.timeOrigin + performance.now();
            expect(written[0]).toBeGreaterThan(0);
            expect(stopped - written[0]!).toBeLessThan(100);
        } finally {
            await worker.terminate();
        }
    }, 60_000);
});

describe.skipIf(threads)("a stop on a build without threads", () => {
    it("has no interrupt flag", () => {
        expect(kernel.interruptFlag()).toBeNull();
    });

    it("runs each call to its end, with a token or not", () => {
        kernel.setBreakToken(5);
        const box = kernel.makeBox(10, 10, 10);
        const cut = kernel.cut(box, kernel.makeSphere(4));
        expect(kernel.getVolume(cut)).toBeGreaterThan(0);
    });
});
