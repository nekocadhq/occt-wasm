/**
 * The history of a step: historyBegin, historyEnd, historyImages, and
 * historyRelease. Each maker between the first two records what it did, and
 * historyImages follows the faces and the edges of the inputs to the result
 * by their index in getSubShapes, with no hash.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WASM_STEM } from "./wasm-variant.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kernel: any;

beforeAll(async () => {
    const jsPath = resolve(__dirname, `../dist/${WASM_STEM}.js`);
    const wasmPath = resolve(__dirname, `../dist/${WASM_STEM}.wasm`);
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

type Box = { xmin: number; xmax: number; ymin: number; ymax: number; zmin: number; zmax: number };

/** The index of the one face of `shape` whose box passes `test`. */
function faceWhere(shape: number, test: (b: Box) => boolean): number {
    const hits = kernel
        .getSubShapes(shape, "face")
        .map((f: number, i: number) => [i, kernel.getBoundingBox(f)] as const)
        .filter(([, b]: readonly [number, Box]) => test(b));
    expect(hits).toHaveLength(1);
    return hits[0][0];
}

/** Runs `make` inside a history, and gives its result with the id of the history. */
function recorded(make: () => number): { result: number; history: number } {
    kernel.historyBegin();
    let result = 0;
    let history = 0;
    try {
        result = make();
    } finally {
        history = kernel.historyEnd();
    }
    return { result, history };
}

const TOP = (b: Box) => b.zmin > 10 - 1e-6;

describe("historyImages", () => {
    it("gives both halves of a face that a slot cuts across", () => {
        const box = kernel.makeBox(30, 20, 10);
        const top = kernel.getSubShapes(box, "face")[faceWhere(box, TOP)];
        const slot = kernel.translate(kernel.makeBox(4, 40, 5), 13, -10, 6);
        const { result, history } = recorded(() => kernel.cut(box, slot));
        const [images] = kernel.historyImages(history, [top], result, "face");
        const faces = kernel.getSubShapes(result, "face");
        expect(images.modified).toHaveLength(2);
        expect(images.generated).toEqual([]);
        for (const i of images.modified) expect(kernel.getBoundingBox(faces[i]).zmin).toBeCloseTo(10, 9);
    });

    it("gives the face that a fillet makes as a generated image of its edge, through unifySameDomain", () => {
        const box = kernel.makeBox(30, 20, 10);
        const edge = kernel.getSubShapes(box, "edge").find((e: number) => {
            const b = kernel.getBoundingBox(e);
            return b.zmin > 10 - 1e-6 && b.ymin > 20 - 1e-6;
        });
        const top = kernel.getSubShapes(box, "face")[faceWhere(box, TOP)];
        const { result, history } = recorded(() => kernel.unifySameDomain(kernel.fillet(box, [edge], 2)));
        const [round, face] = kernel.historyImages(history, [edge, top], result, "face");
        const faces = kernel.getSubShapes(result, "face");
        expect(round.modified).toEqual([]);
        expect(round.generated).toHaveLength(1);
        expect(kernel.surfaceType(faces[round.generated[0]])).toBe("cylinder");
        expect(face.modified).toHaveLength(1);
        expect(kernel.getBoundingBox(faces[face.modified[0]]).ymax).toBeCloseTo(18, 6);
    });

    it("gives the inner faces of a shell as generated images of the outer faces", () => {
        const box = kernel.makeBox(30, 20, 10);
        const faces = kernel.getSubShapes(box, "face");
        const top = faces[faceWhere(box, TOP)];
        const { result, history } = recorded(() => kernel.shell(box, [top], 1, 1e-6));
        const bottom = faces[faceWhere(box, (b) => b.zmax < 1e-6)];
        const [images] = kernel.historyImages(history, [bottom], result, "face");
        const out = kernel.getSubShapes(result, "face");
        expect(images.modified).toHaveLength(1);
        expect(kernel.getBoundingBox(out[images.modified[0]]).zmax).toBeCloseTo(0, 6);
        expect(images.generated).toHaveLength(1);
        expect(kernel.getBoundingBox(out[images.generated[0]]).zmin).toBeCloseTo(1, 6);
    });

    it("gives one face for two faces that a fuse and unifySameDomain merge, and none for a face inside", () => {
        const a = kernel.makeBox(30, 20, 10);
        const b = kernel.translate(kernel.makeBox(30, 20, 10), 30, 0, 0);
        const topA = kernel.getSubShapes(a, "face")[faceWhere(a, TOP)];
        const topB = kernel.getSubShapes(b, "face")[faceWhere(b, TOP)];
        const inside = kernel.getSubShapes(a, "face")[faceWhere(a, (x) => x.xmin > 30 - 1e-6)];
        const { result, history } = recorded(() => kernel.unifySameDomain(kernel.fuse(a, b)));
        const [fromA, fromB, gone] = kernel.historyImages(history, [topA, topB, inside], result, "face");
        expect(fromA.modified).toHaveLength(1);
        expect(fromB.modified).toEqual(fromA.modified);
        expect(gone).toEqual({ modified: [], generated: [] });
    });

    it("keeps the order of the faces through a mirror and a rotation", () => {
        const box = kernel.makeBox(30, 20, 10);
        const faces = kernel.getSubShapes(box, "face");
        const { result, history } = recorded(() =>
            kernel.rotate(kernel.mirror(box, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), {
                point: { x: 0, y: 0, z: 0 },
                direction: { x: 0, y: 0, z: 1 },
            }, 1),
        );
        const images = kernel.historyImages(history, faces, result, "face");
        expect(images.map((i: { modified: number[] }) => i.modified)).toEqual(faces.map((_: number, i: number) => [i]));
    });

    it("follows the edges too: a slot cuts the top edge along X in two", () => {
        const box = kernel.makeBox(30, 20, 10);
        const edge = kernel.getSubShapes(box, "edge").find((e: number) => {
            const b = kernel.getBoundingBox(e);
            return b.zmin > 10 - 1e-6 && b.ymax < 1e-6;
        });
        const slot = kernel.translate(kernel.makeBox(4, 40, 5), 13, -10, 6);
        const { result, history } = recorded(() => kernel.cut(box, slot));
        const [images] = kernel.historyImages(history, [edge], result, "edge");
        expect(images.modified).toHaveLength(2);
    });

    it("records only between historyBegin and historyEnd, and a history inside a history records on its own", () => {
        const box = kernel.makeBox(30, 20, 10);
        const top = kernel.getSubShapes(box, "face")[faceWhere(box, TOP)];
        const slot = kernel.translate(kernel.makeBox(4, 40, 5), 13, -10, 6);
        const cutOutside = kernel.cut(box, slot);
        kernel.historyBegin();
        kernel.historyBegin();
        const cutInside = kernel.cut(box, slot);
        const inner = kernel.historyEnd();
        const outer = kernel.historyEnd();
        const none = { modified: [], generated: [] };
        expect(kernel.historyImages(outer, [top], cutInside, "face")).toEqual([none]);
        expect(kernel.historyImages(inner, [top], cutInside, "face")[0].modified).toHaveLength(2);
        expect(kernel.historyImages(outer, [top], cutOutside, "face")).toEqual([none]);
        kernel.historyRelease(inner);
        expect(() => kernel.historyImages(inner, [top], cutInside, "face")).toThrow(/invalid history/);
        expect(() => kernel.historyEnd()).toThrow(/no history/);
    });
});
