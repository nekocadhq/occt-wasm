/**
 * Each boolean builds one time, and it does not change its inputs.
 *
 * The two-shape constructor of `BRepAlgoAPI_Fuse` (and of Cut, Common, and
 * Section) builds at once, so a `Build()` after it clears the result and does
 * all the work again. The facade now starts each operator empty and builds it
 * one time. The codegen tests (`emitter.rs` and `config.rs`) count the builds,
 * since a time test fails at random on a loaded machine.
 *
 * Without `SetNonDestructive`, the boolean raises the tolerances of the edges
 * and the vertices of its inputs in place. A caller that keeps an input (a
 * cache of the body of each feature, for example) then gets a different shape
 * back. The loose bounding box grows with the tolerance of the shape, so it
 * shows that change: a cylinder that rests on the top of a box, 1e-7 above it,
 * raised the tolerance of the box by about 1e-7 before this repair.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WASM_STEM } from "./wasm-variant.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Module: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kernel: any;

beforeAll(async () => {
    const jsPath = resolve(__dirname, `../dist/${WASM_STEM}.js`);
    const wasmPath = resolve(__dirname, `../dist/${WASM_STEM}.wasm`);
    const createModule = (await import(jsPath)).default;
    Module = await createModule({
        locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
    });
    kernel = new Module.OcctKernel();
}, 30_000);

afterEach(() => {
    kernel.releaseAll();
});

afterAll(() => {
    kernel.releaseAll();
    kernel.delete();
});

function u32(values: number[]): unknown {
    const v = new Module.VectorUint32();
    for (const x of values) v.push_back(x);
    return v;
}

function i32(values: number[]): unknown {
    const v = new Module.VectorInt();
    for (const x of values) v.push_back(x);
    return v;
}

/** The bounding box that includes the tolerance of each sub-shape. */
function looseBox(id: number): number[] {
    const b = kernel.getBoundingBoxLoose(id, false);
    return [b.xmin, b.ymin, b.zmin, b.xmax, b.ymax, b.zmax];
}

/** A 20 x 20 x 10 box, and a cylinder that rests on its top, 1e-7 above it. */
function boxAndRoller(): [number, number] {
    const box = kernel.makeBox(20, 20, 10);
    const lying = kernel.rotate(kernel.makeCylinder(5, 20), 0, 0, 0, 1, 0, 0, Math.PI / 2);
    const roller = kernel.translate(lying, 0, 20, 15 + 1e-7);
    return [box, roller];
}

describe("a boolean does not change its inputs", () => {
    const ops: Record<string, (a: number, b: number) => unknown> = {
        fuse: (a, b) => kernel.fuse(a, b),
        cut: (a, b) => kernel.cut(a, b),
        common: (a, b) => kernel.common(a, b),
        section: (a, b) => kernel.section(a, b),
        fuseAll: (a, b) => kernel.fuseAll(u32([a, b])),
        cutAll: (a, b) => kernel.cutAll(a, u32([b])),
        fuseWithHistory: (a, b) => kernel.fuseWithHistory(a, b, i32([]), 1000),
        cutWithHistory: (a, b) => kernel.cutWithHistory(a, b, i32([]), 1000),
        intersectWithHistory: (a, b) => kernel.intersectWithHistory(a, b, i32([]), 1000),
        "booleanPipeline fuse": (a, b) => kernel.booleanPipeline(a, i32([0]), u32([b])),
        "booleanPipeline cut": (a, b) => kernel.booleanPipeline(a, i32([1]), u32([b])),
        "booleanPipeline intersect": (a, b) => kernel.booleanPipeline(a, i32([2]), u32([b])),
    };

    for (const [name, op] of Object.entries(ops)) {
        it(`${name} keeps the tolerances of the object and the tool`, () => {
            const [box, roller] = boxAndRoller();
            const boxBefore = looseBox(box);
            const rollerBefore = looseBox(roller);
            op(box, roller);
            const boxAfter = looseBox(box);
            const rollerAfter = looseBox(roller);
            for (let i = 0; i < 6; i++) {
                expect(Math.abs(boxAfter[i]! - boxBefore[i]!)).toBeLessThan(1e-10);
                expect(Math.abs(rollerAfter[i]! - rollerBefore[i]!)).toBeLessThan(1e-10);
            }
        });
    }
});

describe("a boolean with a half-space", () => {
    // An oriented box (SetUseOBB) of an infinite solid is empty, and the boolean then skips the half-space.
    it("common, cut, and cutAll keep the correct half of a box", () => {
        const upper = () => kernel.halfSpace(0, 0, 5, 0, 0, 1);
        expect(kernel.getVolume(kernel.common(kernel.makeBox(10, 10, 10), upper()))).toBeCloseTo(500, 3);
        expect(kernel.getVolume(kernel.cut(kernel.makeBox(10, 10, 10), upper()))).toBeCloseTo(500, 3);
        expect(kernel.getVolume(kernel.cutAll(kernel.makeBox(10, 10, 10), u32([upper()])))).toBeCloseTo(500, 3);
    });
});
