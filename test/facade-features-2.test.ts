/**
 * Tests for the second batch of facade additions: inertia tensor,
 * point-in-solid, binary BREP, clamped B-spline interpolation, project-point-
 * on-edge, relative tessellation, auxiliary-spine sweep, and intersection cells.
 *
 * Constructs the TS wrapper via its private constructor (init() can't run here)
 * to exercise the real shipping methods against real OCCT.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SweepMode: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SweepLaw: any;

beforeAll(async () => {
  const jsPath = resolve(__dirname, `../dist/${WASM_STEM}.js`);
  const wasmPath = resolve(__dirname, `../dist/${WASM_STEM}.wasm`);
  const createModule = (await import(jsPath)).default;
  Module = await createModule({
    locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
  });
  const mod = await import(resolve(__dirname, "../ts/src/index.ts"));
  SweepMode = mod.SweepMode;
  SweepLaw = mod.SweepLaw;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kernel = new (mod.OcctKernel as any)(Module);
}, 30_000);

afterEach(() => kernel.releaseAll());
afterAll(() => kernel[Symbol.dispose]());

describe("getInertia", () => {
  it("returns a symmetric 3x3 matrix with positive diagonal", () => {
    const box = kernel.makeBox(10, 20, 30);
    const m = kernel.getInertia(box);
    expect(m).toHaveLength(9);
    expect(m[1]).toBeCloseTo(m[3], 6); // symmetric
    expect(m[2]).toBeCloseTo(m[6], 6);
    expect(m[5]).toBeCloseTo(m[7], 6);
    expect(m[0]).toBeGreaterThan(0);
    expect(m[4]).toBeGreaterThan(0);
    expect(m[8]).toBeGreaterThan(0);
  });
});

describe("containsPoint", () => {
  it("classifies points inside vs outside a solid", () => {
    const box = kernel.makeBox(10, 10, 10); // [0,10]^3
    expect(kernel.containsPoint(box, { x: 5, y: 5, z: 5 })).toBe(true);
    expect(kernel.containsPoint(box, { x: 20, y: 5, z: 5 })).toBe(false);
    expect(kernel.containsPoint(box, { x: -1, y: 5, z: 5 })).toBe(false);
  });
});

describe("binary BREP I/O", () => {
  it("round-trips a shape through binary BREP", () => {
    const box = kernel.makeBox(12, 8, 6);
    const bytes = kernel.toBREPBinary(box);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    const restored = kernel.fromBREPBinary(bytes);
    expect(kernel.getVolume(restored)).toBeCloseTo(12 * 8 * 6, 3);
  });
});

describe("interpolatePointsWithTangents", () => {
  it("builds an edge through points with clamped end tangents", () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 5, z: 0 },
      { x: 10, y: 0, z: 0 },
    ];
    const edge = kernel.interpolatePointsWithTangents(
      pts,
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(kernel.isEdge(edge)).toBe(true);
    expect(kernel.curveLength(edge)).toBeGreaterThan(10);
    // Start tangent should follow the requested +Y direction.
    const t = kernel.curveTangent(edge, kernel.curveParameters(edge).first);
    expect(t.y).toBeGreaterThan(0);
  });
});

describe("projectPointOnEdge", () => {
  it("finds the closest point, tangent, and parameter on a line edge", () => {
    const edge = kernel.makeLineEdge(
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    );
    const r = kernel.projectPointOnEdge(edge, { x: 5, y: 4, z: 0 });
    expect(r.point.x).toBeCloseTo(5, 6);
    expect(r.point.y).toBeCloseTo(0, 6);
    expect(Math.abs(r.tangent.x)).toBeCloseTo(1, 6);
  });
});

describe("tessellate relative", () => {
  it("produces a valid mesh with scale-independent deflection", () => {
    const sphere = kernel.makeSphere(50);
    const mesh = kernel.tessellate(sphere, {
      linearDeflection: 0.01,
      relative: true,
    });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
  });
});

describe("sweepOriented auxiliary spine", () => {
  it("sweeps with an auxiliary guide wire", () => {
    const profile = kernel.makeWire([
      kernel.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2),
    ]);
    const spine = kernel.makeWire([
      kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 30 }),
    ]);
    const aux = kernel.makeWire([
      kernel.makeLineEdge({ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 30 }),
    ]);
    const solid = kernel.sweepOriented(
      profile,
      spine,
      SweepMode.Auxiliary,
      { x: 0, y: 1, z: 0 },
      aux,
    );
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeGreaterThan(0);
  });

  // A square swept along a straight spine with a guide parallel to it asks
  // for no rotation at all, so the answer is a prism with six planar faces
  // and an exact volume. Curvilinear equivalence used to be forced on, which
  // approximated two of those faces as B-splines; the error scaled with the
  // model until the sweep failed outright.
  const squarePrism = (f: number) => {
    const h = 2 * f;
    const l = 20 * f;
    const r = 5 * f;
    const corners = [
      { x: -h, y: -h, z: 0 },
      { x: h, y: -h, z: 0 },
      { x: h, y: h, z: 0 },
      { x: -h, y: h, z: 0 },
    ];
    return {
      profile: kernel.makeWire(
        corners.map((c: { x: number; y: number; z: number }, i: number) =>
          kernel.makeLineEdge(c, corners[(i + 1) % corners.length]),
        ),
      ),
      spine: kernel.makeWire([
        kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: l }),
      ]),
      guide: kernel.makeWire([
        kernel.makeLineEdge({ x: r, y: 0, z: 0 }, { x: r, y: 0, z: l }),
      ]),
      volume: 2 * h * (2 * h) * l,
    };
  };

  it("keeps planar faces exact for a non-rotating guide", () => {
    const { profile, spine, guide, volume } = squarePrism(1);
    const solid = kernel.sweepOriented(
      profile,
      spine,
      SweepMode.Auxiliary,
      undefined,
      guide,
    );
    const surfaces = kernel
      .getSubShapes(solid, "face")
      .map((f: number) => kernel.surfaceType(f));
    expect(surfaces).toEqual([
      "plane",
      "plane",
      "plane",
      "plane",
      "plane",
      "plane",
    ]);
    expect(Math.abs(kernel.getVolume(solid))).toBeCloseTo(volume, 9);
  });

  it("stays exact as the model scales up", () => {
    for (const f of [2, 10, 100]) {
      const { profile, spine, guide, volume } = squarePrism(f);
      const solid = kernel.sweepOriented(
        profile,
        spine,
        SweepMode.Auxiliary,
        undefined,
        guide,
      );
      expect(Math.abs(kernel.getVolume(solid)) / volume).toBeCloseTo(1, 9);
    }
  });

  it("still offers curvilinear equivalence when asked for it", () => {
    const { profile, spine, guide } = squarePrism(1);
    const solid = kernel.sweepOriented(
      profile,
      spine,
      SweepMode.Auxiliary,
      undefined,
      guide,
      { curvilinearEquivalence: true },
    );
    expect(kernel.isValid(solid)).toBe(true);
    const surfaces = kernel
      .getSubShapes(solid, "face")
      .map((f: number) => kernel.surfaceType(f));
    expect(surfaces.filter((s: string) => s === "bspline").length).toBe(2);
  });

  // A guide that only covers part of the spine leaves some section planes
  // with nothing to intersect. Curvilinear equivalence papers over that and
  // returns a solid roughly half the true volume; the guide-plane path says
  // so instead.
  it("reports a guide that does not span the spine", () => {
    const { profile, spine } = squarePrism(1);
    const shortGuide = kernel.makeWire([
      kernel.makeLineEdge({ x: 5, y: 0, z: 6 }, { x: 5, y: 0, z: 14 }),
    ]);
    expect(() =>
      kernel.sweepOriented(
        profile,
        spine,
        SweepMode.Auxiliary,
        undefined,
        shortGuide,
      ),
    ).toThrow(/does not intersect the guide wire/);
  });

  it("tolerates a guide that overhangs both ends of the spine", () => {
    const { profile, spine, volume } = squarePrism(1);
    const longGuide = kernel.makeWire([
      kernel.makeLineEdge({ x: 5, y: 0, z: -10 }, { x: 5, y: 0, z: 30 }),
    ]);
    const solid = kernel.sweepOriented(
      profile,
      spine,
      SweepMode.Auxiliary,
      undefined,
      longGuide,
    );
    expect(Math.abs(kernel.getVolume(solid))).toBeCloseTo(volume, 9);
  });

  // The point of a guide is to drive rotation, and volume alone can't show
  // that — a square prism has the same volume however much it twists. Measure
  // the section's angular orientation at each end instead.
  it("applies the rotation the guide encodes", () => {
    type Point = { x: number; y: number; z: number };
    const sectionAngleAtZ = (solid: number, z: number) => {
      let best: Point | null = null;
      let bestRadius = -1;
      for (const vertex of kernel.getSubShapes(solid, "vertex")) {
        const p: Point = kernel.vertexPosition(vertex);
        if (Math.abs(p.z - z) > 1e-6) continue;
        const radius = Math.hypot(p.x, p.y);
        if (radius > bestRadius) {
          bestRadius = radius;
          best = p;
        }
      }
      if (!best) throw new Error(`no vertex at z=${z}`);
      return (Math.atan2(best.y, best.x) * 180) / Math.PI;
    };

    const length = 20;
    for (const degrees of [0, 15, 30, 45]) {
      const guidePoints: Point[] = [];
      for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const a = ((degrees * Math.PI) / 180) * t;
        guidePoints.push({
          x: 5 * Math.cos(a),
          y: 5 * Math.sin(a),
          z: length * t,
        });
      }
      const corners = [
        { x: -2, y: -2, z: 0 },
        { x: 2, y: -2, z: 0 },
        { x: 2, y: 2, z: 0 },
        { x: -2, y: 2, z: 0 },
      ];
      const solid = kernel.sweepOriented(
        kernel.makeWire(
          corners.map((c: Point, i: number) =>
            kernel.makeLineEdge(c, corners[(i + 1) % corners.length]),
          ),
        ),
        kernel.makeWire([
          kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: length }),
        ]),
        SweepMode.Auxiliary,
        undefined,
        kernel.makeWire(
          guidePoints
            .slice(0, -1)
            .map((p: Point, i: number) =>
              kernel.makeLineEdge(p, guidePoints[i + 1]),
            ),
        ),
      );
      // The square's 4-fold symmetry means the furthest corner can be a
      // different one at each end, so fold the measurement into a quarter
      // turn. Every angle tested is under 45 degrees, so this is exact.
      let rotation = sectionAngleAtZ(solid, length) - sectionAngleAtZ(solid, 0);
      while (rotation > 45) rotation -= 90;
      while (rotation < -45) rotation += 90;
      expect(rotation).toBeCloseTo(degrees, 6);
      kernel.releaseAll();
    }
  });

  it("rejects an out-of-range contact mode", () => {
    const { profile, spine, guide } = squarePrism(1);
    expect(() =>
      kernel.sweepOriented(
        profile,
        spine,
        SweepMode.Auxiliary,
        undefined,
        guide,
        {
          contact: 7,
        },
      ),
    ).toThrow(/contact mode/);
  });
});

describe("sweepAdvanced profile placement", () => {
  // A circle of radius 2 centred 10 units off a straight Z spine.
  const straight = (options: Record<string, unknown>) => {
    const profile = kernel.makeWire([
      kernel.makeCircleEdge({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2),
    ]);
    const spine = kernel.makeWire([
      kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }),
    ]);
    return kernel.sweepAdvanced(profile, spine, options);
  };

  // Translating a profile along a straight spine does not change the volume,
  // so volume cannot tell contact from no-contact — assert where the tube
  // actually sits instead.
  it("leaves the profile where the caller placed it by default", () => {
    const bb = kernel.getBoundingBox(straight({}), false);
    expect(bb.xmin).toBeCloseTo(8, 6);
    expect(bb.xmax).toBeCloseTo(12, 6);
  });

  it("withContact translates the profile until it touches the spine", () => {
    const bb = kernel.getBoundingBox(straight({ withContact: true }), false);
    // The circle moves in until its near edge meets the spine, so the centre
    // lands one radius out rather than on the axis.
    expect(bb.xmin).toBeCloseTo(0, 6);
    expect(bb.xmax).toBeCloseTo(4, 6);
  });

  const tilted = (options: Record<string, unknown>) => {
    const profile = kernel.makeWire([
      kernel.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2),
    ]);
    const spine = kernel.makeWire([
      kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 20 }),
    ]);
    return kernel.sweepAdvanced(profile, spine, options);
  };

  // Correction rotates the section orthogonal to the spine tangent, turning
  // the swept cross-section back into a true circle. The volume then follows
  // the spine length instead of its Z extent.
  it("withCorrection reorients the section on a tilted spine", () => {
    expect(kernel.getVolume(tilted({}))).toBeCloseTo(Math.PI * 4 * 20, 3);
    expect(kernel.getVolume(tilted({ withCorrection: true }))).toBeCloseTo(
      Math.PI * 4 * Math.hypot(10, 20),
      3,
    );
  });

  it("accepts explicit tolerances", () => {
    const solid = straight({ tol3d: 1e-2, boundTol: 1e-2, tolAngular: 1e-1 });
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeCloseTo(Math.PI * 4 * 20, 3);
  });
});

describe("sweepAdvanced parity with the narrower entry points", () => {
  const profile = () =>
    kernel.makeWire([kernel.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2)]);
  const spine = () =>
    kernel.makeWire([kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 })]);

  // Defaults must reproduce sweepPipeShell(freenet=false, smooth=false), so
  // callers can migrate without the geometry shifting under them.
  it("matches sweepPipeShell at its defaults", () => {
    const viaOld = kernel.sweepPipeShell(profile(), spine(), false, false);
    const viaNew = kernel.sweepAdvanced(profile(), spine());
    expect(kernel.getVolume(viaNew)).toBeCloseTo(kernel.getVolume(viaOld), 9);
  });

  it("drives an auxiliary guide like sweepOriented", () => {
    const aux = () =>
      kernel.makeWire([kernel.makeLineEdge({ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 20 })]);
    const viaOld = kernel.sweepOriented(
      profile(),
      spine(),
      SweepMode.Auxiliary,
      { x: 0, y: 1, z: 0 },
      aux(),
    );
    const viaNew = kernel.sweepAdvanced(profile(), spine(), {
      mode: SweepMode.Auxiliary,
      up: { x: 0, y: 1, z: 0 },
      auxSpine: aux(),
    });
    expect(kernel.getVolume(viaNew)).toBeCloseTo(kernel.getVolume(viaOld), 9);
  });

  it("rejects an out-of-range transition mode", () => {
    expect(() => kernel.sweepAdvanced(profile(), spine(), { transitionMode: 7 })).toThrow(
      /transition mode/,
    );
  });
});

describe("sweepFull", () => {
  const profile = () =>
    kernel.makeWire([kernel.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5)]);
  const spine = () =>
    kernel.makeWire([kernel.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 })]);

  // Defaults must reproduce sweepAdvanced's, so callers can migrate without
  // the geometry shifting under them.
  it("matches sweepAdvanced at its defaults", () => {
    const viaOld = kernel.sweepAdvanced(profile(), spine());
    const viaNew = kernel.sweepFull(profile(), spine());
    expect(kernel.getVolume(viaNew)).toBeCloseTo(kernel.getVolume(viaOld), 9);
  });

  // A scaling law is the whole reason this entry point exists: without it the
  // sweep is a plain prism whatever endFactor says. r=5 over length 10 gives
  // pi*25*10 unscaled; a linear law to 2 sweeps a cone frustum instead, whose
  // volume is pi*h*(r^2 + r*R + R^2)/3 with R = 2r.
  it("scales the section along a linear law", () => {
    const plain = kernel.getVolume(kernel.sweepFull(profile(), spine()));
    expect(plain).toBeCloseTo(Math.PI * 25 * 10, 3);

    const scaled = kernel.getVolume(
      kernel.sweepFull(profile(), spine(), {
        law: SweepLaw.Linear,
        lawLength: 10,
        lawEndFactor: 2,
      }),
    );
    expect(scaled).toBeCloseTo((Math.PI * 10 * (25 + 50 + 100)) / 3, 2);
  });

  it("shrinks the section when the law ends below 1", () => {
    const shrunk = kernel.getVolume(
      kernel.sweepFull(profile(), spine(), {
        law: SweepLaw.Linear,
        lawLength: 10,
        lawEndFactor: 0.5,
      }),
    );
    // Same frustum formula with R = r/2.
    expect(shrunk).toBeCloseTo((Math.PI * 10 * (25 + 12.5 + 6.25)) / 3, 2);
  });

  it("applies an s-curve law", () => {
    const s = kernel.getVolume(
      kernel.sweepFull(profile(), spine(), {
        law: SweepLaw.SCurve,
        lawLength: 10,
        lawEndFactor: 2,
      }),
    );
    // Zero end derivatives make the S law linger near both end radii rather
    // than sweeping evenly between them. Volume integrates r^2, which is
    // convex, so weighting the extremes sweeps MORE than the linear ramp to
    // the same end factor: (1+4)/2 > 1.5^2.
    const linear = (Math.PI * 10 * (25 + 50 + 100)) / 3;
    expect(s).toBeGreaterThan(linear);
    expect(s).toBeLessThan(Math.PI * 10 * 25 * 2.5);
  });

  it("honours the approximation budget", () => {
    const solid = kernel.sweepFull(profile(), spine(), { maxDegree: 3, maxSegments: 5 });
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeCloseTo(Math.PI * 25 * 10, 3);
  });

  it("requires lawLength when a law is set", () => {
    expect(() => kernel.sweepFull(profile(), spine(), { law: SweepLaw.Linear })).toThrow(
      /lawLength/,
    );
  });

  // A planar support over a straight spine yields the same frame the default
  // mode already picks, so the swept volume is unchanged by design — this
  // asserts the support is accepted and drives a valid sweep, not that it
  // moves the geometry. A support only redirects the frame when the surface
  // curves away from it.
  it("accepts a spine support surface", () => {
    const corners = [
      { x: -5, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
      { x: 5, y: 0, z: 10 },
      { x: -5, y: 0, z: 10 },
    ];
    const supportFace = kernel.makeFace(
      kernel.makeWire(
        corners.map((c: { x: number; y: number; z: number }, i: number) =>
          kernel.makeLineEdge(c, corners[(i + 1) % corners.length]),
        ),
      ),
    );
    const solid = kernel.sweepFull(profile(), spine(), { support: supportFace });
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeCloseTo(Math.PI * 25 * 10, 3);
  });
});

describe("intersectionCells", () => {
  it("extracts the overlap region of two boxes", () => {
    const a = kernel.makeBox(10, 10, 10); // [0,10]^3
    const b = kernel.translate(kernel.makeBox(10, 10, 10), 5, 5, 5); // [5,15]^3
    const overlap = kernel.intersectionCells([a, b]);
    // Overlap is [5,10]^3 = 125.
    expect(kernel.getVolume(overlap)).toBeCloseTo(125, 2);
  });
});

describe("makeHelixWireHanded", () => {
  const ORIGIN = { x: 0, y: 0, z: 0 };
  const AXIS = { x: 0, y: 0, z: 1 };
  const PITCH = 5;
  const HEIGHT = 5; // exactly one turn
  const RADIUS = 3;

  // Fractional sampling of the wire: the pcurve is linear in the cylinder's
  // angle, so frac maps straight onto the turn (0.25 -> a quarter turn).
  function sample(wire: number, frac: number) {
    const { first, last } = kernel.curveParameters(wire);
    return kernel.curvePointAtParam(wire, first + (last - first) * frac);
  }

  function helix(leftHanded: boolean) {
    return kernel.makeHelixWireHanded(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS, leftHanded);
  }

  it("winds the opposite way for left-handed", () => {
    // A quarter turn up a right-handed helix lands on +Y, a left-handed one
    // on -Y. Both have climbed a quarter of the pitch.
    const right = sample(helix(false), 0.25);
    const left = sample(helix(true), 0.25);
    expect(right.x).toBeCloseTo(0, 6);
    expect(right.y).toBeCloseTo(RADIUS, 6);
    expect(left.x).toBeCloseTo(0, 6);
    expect(left.y).toBeCloseTo(-RADIUS, 6);
    expect(left.z).toBeCloseTo(right.z, 6);
    expect(right.z).toBeCloseTo(PITCH / 4, 6);
  });

  it("mirrors across the axis plane without changing pitch, height or radius", () => {
    const right = helix(false);
    const left = helix(true);
    for (const frac of [0, 0.1, 0.375, 0.6, 0.9, 1]) {
      const r = sample(right, frac);
      const l = sample(left, frac);
      expect(l.x).toBeCloseTo(r.x, 6);
      expect(l.y).toBeCloseTo(-r.y, 6);
      expect(l.z).toBeCloseTo(r.z, 6);
    }
    expect(kernel.curveLength(left)).toBeCloseTo(kernel.curveLength(right), 6);
    // One turn of radius 3 over a pitch of 5.
    expect(kernel.curveLength(right)).toBeCloseTo(
      Math.hypot(2 * Math.PI * RADIUS, PITCH),
      3,
    );
  });

  it("matches makeHelixWire when right-handed", () => {
    const handed = helix(false);
    const plain = kernel.makeHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS);
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const h = sample(handed, frac);
      const p = sample(plain, frac);
      expect(h.x).toBeCloseTo(p.x, 9);
      expect(h.y).toBeCloseTo(p.y, 9);
      expect(h.z).toBeCloseTo(p.z, 9);
    }
  });

  it("sweeps a profile into a valid solid either way", () => {
    for (const leftHanded of [false, true]) {
      const spine = helix(leftHanded);
      const profile = kernel.makeWire([
        kernel.makeCircleEdge({ x: RADIUS, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5),
      ]);
      const solid = kernel.sweepPipeShell(profile, spine, true, true);
      expect(kernel.isValid(solid)).toBe(true);
      expect(kernel.getVolume(solid)).toBeGreaterThan(0);
    }
  });

  // Both helices carry a 3D curve, not just the pcurve on the cylinder. A
  // spine without one drives every sweep into a bare failure.
  it("sweeps along the plain makeHelixWire too", () => {
    const spine = kernel.makeHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS);
    const profile = kernel.makeWire([
      kernel.makeCircleEdge({ x: RADIUS, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5),
    ]);
    const solid = kernel.sweepPipeShell(profile, spine, true, true);
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeGreaterThan(0);
  });
});

describe("makeConicalHelixWire", () => {
  const ORIGIN = { x: 0, y: 0, z: 0 };
  const AXIS = { x: 0, y: 0, z: 1 };
  const PITCH = 2;
  const HEIGHT = 10; // five turns
  const RADIUS = 10;
  // The taper of a pipe thread: 1 in 16 on the diameter.
  const SEMI = Math.atan(1 / 32);

  // The pcurve is a line in the angle of the cone, so frac maps straight onto the turns.
  function sample(wire: number, frac: number) {
    const { first, last } = kernel.curveParameters(wire);
    return kernel.curvePointAtParam(wire, first + (last - first) * frac);
  }

  it("climbs one pitch per turn and widens by tan(semiAngle) per unit of height", () => {
    const wire = kernel.makeConicalHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS, SEMI);
    expect(kernel.getShapeType(wire)).toBe("wire");
    for (const frac of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      const p = sample(wire, frac);
      expect(p.z).toBeCloseTo(HEIGHT * frac, 4);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(RADIUS + p.z * Math.tan(SEMI), 4);
    }
    // A quarter of a turn is a climb of a quarter of the pitch, and lands on +Y.
    const quarter = sample(wire, 0.25 / 5);
    expect(quarter.x).toBeCloseTo(0, 4);
    expect(quarter.z).toBeCloseTo(PITCH / 4, 4);
  });

  it("narrows with a negative semi-angle, and winds the other way when left-handed", () => {
    const right = kernel.makeConicalHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS, -SEMI);
    const left = kernel.makeConicalHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS, -SEMI, true);
    const end = sample(right, 1);
    expect(Math.hypot(end.x, end.y)).toBeCloseTo(RADIUS - HEIGHT * Math.tan(SEMI), 4);
    const r = sample(right, 0.05);
    const l = sample(left, 0.05);
    expect(l.x).toBeCloseTo(r.x, 4);
    expect(l.y).toBeCloseTo(-r.y, 4);
    expect(l.z).toBeCloseTo(r.z, 4);
  });

  it("refuses a flat angle and a cone that closes inside the helix", () => {
    expect(() => kernel.makeConicalHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, RADIUS, 0)).toThrow();
    expect(() => kernel.makeConicalHelixWire(ORIGIN, AXIS, PITCH, HEIGHT, 1, -Math.PI / 4)).toThrow();
  });
});

describe("chamferOnFaces", () => {
  // The edge of a 20 mm box at y = 0, z = 20, along X. Its faces are the top
  // (z = 20) and the front (y = 0).
  function topFront(box: number) {
    const edge = kernel.getSubShapes(box, "edge").find((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.xmax - b.xmin > 19 && b.ymax < 1e-6 && b.zmin > 20 - 1e-6;
    });
    const face = (test: (b: { ymax: number; zmin: number }) => boolean) =>
      kernel.getSubShapes(box, "face").find((f: number) => test(kernel.getBoundingBox(f)));
    return {
      edge,
      top: face((b) => b.zmin > 20 - 1e-6),
      front: face((b) => b.ymax < 1e-6),
    };
  }

  // The bevel face: the one face of the result that is neither at y = 0 nor at z = 20
  // and that touches both. Its extent gives the set-back on each face.
  function bevel(solid: number) {
    const b = kernel
      .getSubShapes(solid, "face")
      .map((f: number) => kernel.getBoundingBox(f))
      .find((b: { ymin: number; ymax: number; zmin: number; zmax: number }) =>
        b.ymax - b.ymin > 1e-6 && b.zmax - b.zmin > 1e-6 && b.ymax < 19 && b.zmin > 1);
    return { onTop: b.ymax - b.ymin, onFront: b.zmax - b.zmin };
  }

  it("sets `distance` back on the given face and `second` on the other", () => {
    const box = kernel.makeBox(20, 20, 20);
    const { edge, top, front } = topFront(box);
    const onTop = kernel.chamferOnFaces(box, [edge], [top], 1, 3);
    expect(kernel.isValid(onTop)).toBe(true);
    // The prism that goes: ½ × 1 × 3 × 20.
    expect(kernel.getVolume(onTop)).toBeCloseTo(8000 - 30, 6);
    expect(bevel(onTop).onTop).toBeCloseTo(1, 6);
    expect(bevel(onTop).onFront).toBeCloseTo(3, 6);

    const onFront = kernel.chamferOnFaces(box, [edge], [front], 1, 3);
    expect(kernel.getVolume(onFront)).toBeCloseTo(8000 - 30, 6);
    expect(bevel(onFront).onTop).toBeCloseTo(3, 6);
    expect(bevel(onFront).onFront).toBeCloseTo(1, 6);
  });

  it("reads `second` as degrees with byAngle", () => {
    const box = kernel.makeBox(20, 20, 20);
    const { edge, top } = topFront(box);
    const solid = kernel.chamferOnFaces(box, [edge], [top], 2, 30, true);
    const { onTop, onFront } = bevel(solid);
    expect(onTop).toBeCloseTo(2, 6);
    // The angle is between the bevel and the reference face, so the other face gets 2 × tan(30°).
    expect(onFront).toBeCloseTo(2 * Math.tan(Math.PI / 6), 6);
  });

  it("finds the same first face as chamferDistAngle, from the order of getSubShapes", () => {
    const box = kernel.makeBox(20, 20, 20);
    const { edge } = topFront(box);
    const first = kernel
      .getSubShapes(box, "face")
      .find((f: number) => kernel.getSubShapes(f, "edge").some((e: number) => kernel.isSame(e, edge)));
    const ours = bevel(kernel.chamferOnFaces(box, [edge], [first], 2, 30, true));
    const theirs = bevel(kernel.chamferDistAngle(box, [edge], 2, 30));
    expect(ours.onTop).toBeCloseTo(theirs.onTop, 9);
    expect(ours.onFront).toBeCloseTo(theirs.onFront, 9);
    expect(ours.onTop).not.toBeCloseTo(ours.onFront, 3);
  });

  it("chamfers two edges that meet at a corner in one maker", () => {
    const box = kernel.makeBox(20, 20, 20);
    const edges = kernel.getSubShapes(box, "edge").filter((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.zmin > 20 - 1e-6 && (b.ymax < 1e-6 || b.xmax < 1e-6);
    });
    const top = topFront(box).top;
    const solid = kernel.chamferOnFaces(box, edges, [top, top], 1, 3);
    expect(edges).toHaveLength(2);
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeLessThan(8000 - 30);
  });

  it("refuses a face that does not hold its edge, and a count that does not match", () => {
    const box = kernel.makeBox(20, 20, 20);
    const { edge, top } = topFront(box);
    const bottom = kernel.getSubShapes(box, "face").find((f: number) => kernel.getBoundingBox(f).zmax < 1e-6);
    expect(() => kernel.chamferOnFaces(box, [edge], [bottom], 1, 3)).toThrow(/not adjacent/);
    expect(() => kernel.chamferOnFaces(box, [edge], [top, top], 1, 3)).toThrow(/one face/);
  });
});

describe("filletLaw", () => {
  // The volume that a round from r1 to r2 takes off a straight edge of length l: the corner of a square less a
  // quarter disk, with a side that grows along the edge. A variable round is not a true quarter circle, thus 3 %.
  const loss = (l: number, r1: number, r2: number) => ((1 - Math.PI / 4) * l * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;

  // The edge of a 20 mm box at y = 0, z = 20, along X.
  function topFront(box: number) {
    return kernel.getSubShapes(box, "edge").find((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.xmax - b.xmin > 19 && b.ymax < 1e-6 && b.zmin > 20 - 1e-6;
    });
  }

  // How far the round reaches into the top face (z = 20) at x = 0 and at x = 20.
  function widths(solid: number) {
    const top = kernel.getSubShapes(solid, "vertex").map((v: number) => kernel.vertexPosition(v))
      .filter((p: { z: number }) => Math.abs(p.z - 20) < 1e-6);
    const at = (x: number) =>
      Math.min(...top.filter((p: { x: number }) => Math.abs(p.x - x) < 1e-6).map((p: { y: number }) => p.y));
    return [at(0), at(20)];
  }

  it("grows the radius from the end nearest to the start point", () => {
    const box = kernel.makeBox(20, 20, 20);
    const edge = topFront(box);
    const up = kernel.filletLaw(box, [edge], [0, 0, 20], [2], [0, 1], [1, 3]);
    expect(kernel.isValid(up)).toBe(true);
    expect(8000 - kernel.getVolume(up)).toBeCloseTo(loss(20, 1, 3), 0);
    expect(Math.abs(8000 - kernel.getVolume(up) - loss(20, 1, 3)) / loss(20, 1, 3)).toBeLessThan(0.03);
    const [w0, w20] = widths(up);
    expect(w0).toBeCloseTo(1, 6);
    expect(w20).toBeCloseTo(3, 6);

    const down = kernel.filletLaw(box, [edge], [20, 0, 20], [2], [0, 1], [1, 3]);
    expect(kernel.getVolume(down)).toBeCloseTo(kernel.getVolume(up), 6);
    const [d0, d20] = widths(down);
    expect(d0).toBeCloseTo(3, 6);
    expect(d20).toBeCloseTo(1, 6);
  });

  it("goes through each point of the law", () => {
    const box = kernel.makeBox(20, 20, 20);
    const edge = topFront(box);
    const solid = kernel.filletLaw(box, [edge], [0, 0, 20], [3], [0, 0.5, 1], [1, 3, 1]);
    expect(kernel.isValid(solid)).toBe(true);
    const [w0, w20] = widths(solid);
    expect(w0).toBeCloseTo(1, 6);
    expect(w20).toBeCloseTo(1, 6);
    // OpenCascade draws a smooth curve through the points (Law_Interpol), not straight lines. Thus the round takes
    // more than two straight halves from 1 to 3, and less than a constant 3.
    const taken = 8000 - kernel.getVolume(solid);
    expect(taken).toBeGreaterThan(2 * loss(10, 1, 3));
    expect(taken).toBeLessThan(loss(20, 3, 3));
    // The curve is flat at its top, thus a thin slice at x = 10 is a true quarter circle of radius 3.
    const slab = kernel.translate(kernel.makeBox(0.1, 20, 20), 9.95, 0, 0);
    const slice = kernel.getVolume(kernel.common(solid, slab)) / 0.1;
    expect(400 - slice).toBeCloseTo((1 - Math.PI / 4) * 9, 2);
  });

  it("spreads the law over a contour of tangent edges, and not over its first edge only", () => {
    // The top rim of a box of 20 x 20 x 10 with a round of 5 on the vertical edge at x = 20, y = 0: a line along X,
    // a quarter arc, and a line along Y, all tangent. The contour runs from (0, 0, 10) to (20, 20, 10).
    const box = kernel.makeBox(20, 20, 10);
    const corner = kernel.getSubShapes(box, "edge").find((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.xmin > 20 - 1e-6 && b.ymax < 1e-6;
    });
    const rounded = kernel.fillet(box, [corner], 5);
    const front = kernel.getSubShapes(rounded, "edge").find((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.ymax < 1e-6 && b.zmin > 10 - 1e-6 && b.xmax - b.xmin > 14;
    });
    const solid = kernel.filletLaw(rounded, [front], [0, 0, 10], [2], [0, 1], [1, 3]);
    expect(kernel.isValid(solid)).toBe(true);
    const top = kernel.getSubShapes(solid, "vertex").map((v: number) => kernel.vertexPosition(v))
      .filter((p: { z: number }) => Math.abs(p.z - 10) < 1e-6);
    // The start: 1 mm into the top face at x = 0. The end: 3 mm into the top face at y = 20.
    expect(top.some((p: { x: number; y: number }) => Math.abs(p.x) < 1e-6 && Math.abs(p.y - 1) < 1e-3)).toBe(true);
    expect(top.some((p: { x: number; y: number }) => Math.abs(p.y - 20) < 1e-6 && Math.abs(p.x - 17) < 1e-3)).toBe(true);
  });

  it("rounds two edges with the same law, and skips a second edge of one contour", () => {
    const box = kernel.makeBox(20, 20, 20);
    const edges = kernel.getSubShapes(box, "edge").filter((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.xmax - b.xmin > 19 && b.zmin > 20 - 1e-6;
    });
    expect(edges).toHaveLength(2);
    const solid = kernel.filletLaw(box, edges, [0, 0, 20, 0, 20, 20], [2, 2], [0, 1, 0, 1], [1, 2, 1, 2]);
    expect(kernel.isValid(solid)).toBe(true);
    expect(8000 - kernel.getVolume(solid)).toBeGreaterThan(1.9 * loss(20, 1, 2));
    // The same edge two times is one contour, thus one round.
    const once = kernel.filletLaw(box, [edges[0], edges[0]], [0, 0, 20, 0, 0, 20], [2, 2], [0, 1, 0, 1], [1, 2, 1, 2]);
    expect(Math.abs(8000 - kernel.getVolume(once) - loss(20, 1, 2)) / loss(20, 1, 2)).toBeLessThan(0.03);
  });

  it("needs the same radius at the start and the end of a closed contour", () => {
    const cylinder = kernel.makeCylinder(10, 20);
    const rim = kernel.getSubShapes(cylinder, "edge").find((e: number) => {
      const b = kernel.getBoundingBox(e);
      return b.zmin > 20 - 1e-6 && b.xmax - b.xmin > 19;
    });
    const solid = kernel.filletLaw(cylinder, [rim], [10, 0, 20], [3], [0, 0.5, 1], [2, 4, 2]);
    expect(kernel.isValid(solid)).toBe(true);
    expect(kernel.getVolume(solid)).toBeLessThan(Math.PI * 100 * 20);
    expect(() => kernel.filletLaw(cylinder, [rim], [10, 0, 20], [2], [0, 1], [2, 3])).toThrow(/same radius/);
  });

  it("refuses counts that do not match", () => {
    const box = kernel.makeBox(20, 20, 20);
    const edge = topFront(box);
    expect(() => kernel.filletLaw(box, [edge], [0, 0], [2], [0, 1], [1, 3])).toThrow(/start point/);
    expect(() => kernel.filletLaw(box, [edge], [0, 0, 20], [3], [0, 1], [1, 3])).toThrow(/counts/);
    expect(() => kernel.filletLaw(box, [edge], [0, 0, 20], [2], [0.2, 1], [1, 3])).toThrow(/from 0 to 1/);
  });
});
