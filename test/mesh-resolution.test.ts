/**
 * The resolution of a mesh: the angle of an STL export, and a forced mesh
 * that ignores a finer triangulation the shape already holds.
 *
 * BRepMesh_IncrementalMesh keeps a triangulation that is finer than the one
 * it is asked for, so a coarse mesh after a fine one used to come out fine.
 * A forced mesh gives the requested resolution and puts the triangulation of
 * the shape back afterwards, so a display mesh of the same shape is kept.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kernel: any;

beforeAll(async () => {
    const jsPath = resolve(__dirname, "../dist/occt-wasm.js");
    const wasmPath = resolve(__dirname, "../dist/occt-wasm.wasm");
    const createModule = (await import(jsPath)).default;
    const Module = await createModule({
        locateFile: (p: string) => (p.endsWith(".wasm") ? wasmPath : p),
    });
    const mod = await import(resolve(__dirname, "../ts/src/index.ts"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kernel = new (mod.OcctKernel as any)(Module);
}, 30_000);

afterEach(() => kernel.releaseAll());
afterAll(() => kernel[Symbol.dispose]());

const stlTriangles = (stl: Uint8Array) =>
    new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
const asciiTriangles = (stl: string) => stl.split("facet normal").length - 1;
const cylinder = () => kernel.makeCylinder(10, 10);

// A linear deflection this large never limits a 10 mm cylinder, so the angle decides.
const LOOSE = 5;
const FINE = { linearDeflection: 0.01, angularDeflection: 0.05 };
const COARSE = { linearDeflection: 1, angularDeflection: 0.8 };

describe("exportStl: angular deflection", () => {
    it("a smaller angle gives more triangles", () => {
        const wide = stlTriangles(
            kernel.exportStl(cylinder(), { linearDeflection: LOOSE, angularDeflection: 0.8 }),
        );
        const narrow = stlTriangles(
            kernel.exportStl(cylinder(), { linearDeflection: LOOSE, angularDeflection: 0.1 }),
        );
        expect(narrow).toBeGreaterThan(4 * wide);
    });

    it("the old call shape keeps the angle of 0.5 rad", () => {
        const old = stlTriangles(kernel.exportStl(cylinder(), LOOSE));
        const same = stlTriangles(
            kernel.exportStl(cylinder(), { linearDeflection: LOOSE, angularDeflection: 0.5 }),
        );
        expect(old).toBe(same);
        expect(kernel.exportStl(cylinder(), LOOSE, true)).toMatch(/^solid/);
    });

    it("the ascii form takes the angle too", () => {
        const wide = asciiTriangles(
            kernel.exportStl(cylinder(), { linearDeflection: LOOSE, angularDeflection: 0.8, ascii: true }),
        );
        const narrow = asciiTriangles(
            kernel.exportStl(cylinder(), { linearDeflection: LOOSE, angularDeflection: 0.1, ascii: true }),
        );
        expect(narrow).toBeGreaterThan(4 * wide);
    });
});

describe("meshShape: force", () => {
    it("without force, a coarse mesh after a fine one stays fine", () => {
        const shape = cylinder();
        const fine = kernel.meshShape(shape, FINE).indices.length;
        expect(kernel.meshShape(shape, COARSE).indices.length).toBe(fine);
    });

    it("a forced coarse mesh after a fine one is coarse", () => {
        const coarse = kernel.meshShape(cylinder(), COARSE).indices.length;
        const shape = cylinder();
        const fine = kernel.meshShape(shape, FINE).indices.length;
        expect(fine).toBeGreaterThan(4 * coarse);
        expect(kernel.meshShape(shape, { ...COARSE, force: true }).indices.length).toBe(coarse);
    });

    it("a forced mesh keeps the triangulation that the shape had", () => {
        const fineShape = cylinder();
        const fine = kernel.meshShape(fineShape, FINE).indices.length;
        kernel.meshShape(fineShape, { ...COARSE, force: true });
        // A plain coarse request reuses what the shape holds, so it shows which triangulation that is.
        expect(kernel.meshShape(fineShape, COARSE).indices.length).toBe(fine);

        const coarseShape = cylinder();
        const coarse = kernel.meshShape(coarseShape, COARSE).indices.length;
        expect(kernel.meshShape(coarseShape, { ...FINE, force: true }).indices.length).toBe(fine);
        expect(kernel.meshShape(coarseShape, COARSE).indices.length).toBe(coarse);
    });

    it("a shape with no triangulation has none after a forced mesh", () => {
        const shape = cylinder();
        kernel.meshShape(shape, { ...COARSE, force: true });
        expect(kernel.hasTriangulation(shape)).toBe(false);
    });

    it("a forced mesh of a solid inside a compound leaves the compound as it was", () => {
        const a = cylinder();
        const b = kernel.translate(cylinder(), 30, 0, 0);
        const both = kernel.makeCompound([a, b]);
        const fine = kernel.meshShape(both, FINE).indices.length;
        const [first] = kernel.getSubShapes(both, "solid");
        expect(kernel.meshShape(first, { ...COARSE, force: true }).indices.length).toBeLessThan(fine / 4);
        expect(kernel.meshShape(both, COARSE).indices.length).toBe(fine);
    });
});

describe("exportStl: force", () => {
    it("a forced coarse STL after a fine mesh is coarse", () => {
        const coarse = stlTriangles(kernel.exportStl(cylinder(), COARSE));
        const shape = cylinder();
        kernel.meshShape(shape, FINE);
        expect(stlTriangles(kernel.exportStl(shape, COARSE))).toBeGreaterThan(4 * coarse);
        expect(stlTriangles(kernel.exportStl(shape, { ...COARSE, force: true }))).toBe(coarse);
    });
});
