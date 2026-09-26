import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { WASM_STEM } from "./wasm-variant.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Module: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kernel: any;

beforeAll(async () => {
    const wasmPath = resolve(__dirname, `../dist/${WASM_STEM}.wasm`);
    const jsPath = resolve(__dirname, `../dist/${WASM_STEM}.js`);
    const createOcctWasm = (await import(jsPath)).default;
    Module = await createOcctWasm({
        locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
    });
    kernel = new Module.OcctKernel();
}, 30_000);

afterAll(() => {
    try {
        kernel?.releaseAll();
        kernel?.delete();
    } catch {
        // XCAF document cleanup may cause memory issues — ignore
    }
});

interface Accessor {
    min?: number[];
    max?: number[];
}

/** The JSON chunk of a binary glTF file. */
function gltfJson(glb: Uint8Array): {
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: Accessor[];
} {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const length = view.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}

/** The extent of the positions of every primitive, on X, Y, and Z. */
function extent(glb: Uint8Array): number[] {
    const json = gltfJson(glb);
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (const mesh of json.meshes) {
        for (const primitive of mesh.primitives) {
            const accessor = json.accessors[primitive.attributes.POSITION];
            for (let i = 0; i < 3; i++) {
                low[i] = Math.min(low[i], accessor?.min?.[i] ?? Infinity);
                high[i] = Math.max(high[i], accessor?.max?.[i] ?? -Infinity);
            }
        }
    }
    return high.map((h, i) => h - low[i]);
}

describe("glTF export", () => {
    it("writes millimeters as meters, and turns Z up into the Y up of glTF", () => {
        const docId = kernel.xcafNewDocument();
        const box = kernel.makeBox(100, 50, 20);
        kernel.xcafAddShape(docId, box);
        const path: string = kernel.xcafExportGLTF(docId, 0.1, 0.5);
        const glb: Uint8Array = Module.FS.readFile(path);
        Module.FS.unlink(path);
        const [x, y, z] = extent(glb);
        expect(x).toBeCloseTo(0.1, 6);
        // The 20 mm of Z is the height, and glTF has Y up.
        expect(y).toBeCloseTo(0.02, 6);
        expect(z).toBeCloseTo(0.05, 6);
        kernel.release(box);
        kernel.xcafClose(docId);
    });
});

/** The IGES text of a document that holds `shape`, in `unit`. */
function igesOf(shape: number, unit: string): string {
    const docId = kernel.xcafNewDocument();
    try {
        const tag = kernel.xcafAddShape(docId, shape);
        kernel.xcafSetName(docId, tag, "cube");
        const path: string = kernel.xcafExportIGES(docId, unit);
        const text = new TextDecoder().decode(Module.FS.readFile(path));
        Module.FS.unlink(path);
        return text;
    } finally {
        kernel.xcafClose(docId);
    }
}

describe("IGES", () => {
    it("writes trimmed surfaces with NekoCAD as the product, and reads them back as one shape", () => {
        const box = kernel.makeBox(10, 10, 10);
        const text = igesOf(box, "MM");
        // The start section, then the global section with the product name.
        expect(text.split("\n")[0]?.charAt(72)).toBe("S");
        expect(text).toContain("7HNekoCAD");
        // Mode 0: trimmed surfaces (type 144), not a BRep solid (type 186).
        expect(text).toMatch(/^\s+144\s/m);
        expect(text).not.toMatch(/^\s+186\s/m);
        const read = kernel.importIges(text);
        const faces = kernel.getSubShapes(read, "face");
        expect(faces.size()).toBe(6);
        faces.delete();
        // Loose faces: a solid comes from them only after sewing, which the caller does.
        const solid = kernel.sewAndSolidify(kernel.getSubShapes(read, "face"), 1e-6);
        expect(kernel.getVolume(solid)).toBeCloseTo(1000, 3);
    });

    it("writes inches, and the reader gives millimeters back", () => {
        const box = kernel.makeBox(25.4, 25.4, 25.4);
        const text = igesOf(box, "IN");
        // The unit flag 1 and the name of the inch in the global section.
        expect(text).toMatch(/,1,4HINCH,/);
        const read = kernel.importIges(text);
        const box2 = kernel.getBoundingBox(read, true);
        expect(box2.xmax - box2.xmin).toBeCloseTo(25.4, 4);
    });

    it("refuses a unit other than MM or IN, and data that is not IGES", () => {
        const box = kernel.makeBox(1, 1, 1);
        expect(() => igesOf(box, "M")).toThrow();
        expect(() => kernel.importIges("this is not an IGES file")).toThrow();
    });
});
