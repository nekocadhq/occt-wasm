#include "occt_kernel.h"

#include <BRepGProp.hxx>
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_CurveRepresentation.hxx>
#include <BRep_TEdge.hxx>
#include <BRep_TFace.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <IMeshTools_Parameters.hxx>
#include <NCollection_Vec3.hxx>
#include <OSD.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_Triangulation.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <XCAFApp_Application.hxx>
#include <cstdlib>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <OSD_ThreadPool.hxx>
#include <emscripten/em_js.h>
#endif
#ifdef OCCT_WASM_MIMALLOC
#include <malloc.h>
#endif
#include <algorithm>
#include <optional>
#include <stdexcept>
#include <unordered_set>
#include <vector>

// --- XCAF helpers (used by generated xcaf methods) ---

const Handle(TDocStd_Application) & getXCAFApp() {
    static Handle(TDocStd_Application) app;
    if (app.IsNull()) {
        app = XCAFApp_Application::GetApplication();
    }
    return app;
}

TDF_Label lookupLabel(const std::map<int, TDF_Label>& registry, int labelId) {
    auto it = registry.find(labelId);
    if (it == registry.end()) {
        throw std::runtime_error("invalid label ID: " + std::to_string(labelId));
    }
    return it->second;
}

int OcctKernel::registerLabel(XCAFDocRecord& record, const TDF_Label& label) {
    auto known = record.labelIds.find(label);
    if (known != record.labelIds.end()) {
        return known->second;
    }
    int facadeId = record.nextLabelId++;
    record.labelRegistry[facadeId] = label;
    record.labelIds.emplace(label, facadeId);
    return facadeId;
}

// --- Threads ---

#ifdef __EMSCRIPTEN_PTHREADS__
// The Web Workers that the glue started before the module ran (PTHREAD_POOL_SIZE in
// xtask/src/build.rs). A new Worker starts only after this thread returns to its event
// loop, so a thread that OCCT starts past these would never run while OCCT waits for it.
EM_JS(int, occtWorkerPoolSize, (), { return PThread.unusedWorkers.length; });
#endif

#ifdef OCCT_WASM_MIMALLOC
// The npm builds link mimalloc, which has no mallinfo(). Only OSD_MemInfo, a report of the
// memory in use, calls it; the report then gives zeros instead of a failed link.
extern "C" struct mallinfo mallinfo() {
    return {};
}
#endif

namespace {

// Give OCCT's default thread pool one thread for each Web Worker, plus this thread, which
// OCCT uses as well. This must occur before the first parallel algorithm: the pool is made
// one time, and by default it takes the count of logical processors.
void sizeThreadPool() {
#ifdef __EMSCRIPTEN_PTHREADS__
    static const bool sized = [] {
        OSD_ThreadPool::DefaultPool(occtWorkerPoolSize() + 1);
        return true;
    }();
    (void)sized;
#endif
}

} // namespace

// --- Mesh helpers (used by generated tessellation and STL methods) ---

bool meshInParallel(const TopoDS_Shape& shape) {
#ifdef __EMSCRIPTEN_PTHREADS__
    // Measured on the models of NekoCAD: 12 faces meshed in 25 ms with threads and 6 ms
    // without, and 87 to 192 faces meshed 1.8 to 2 times faster with threads.
    constexpr int kMinFaces = 32;
    int faces = 0;
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More() && faces < kMinFaces; ex.Next()) {
        ++faces;
    }
    return faces >= kMinFaces;
#else
    (void)shape;
    return false;
#endif
}

void meshShapeAt(const TopoDS_Shape& shape, double linearDeflection, double angularDeflection,
                 bool relative, bool force) {
    // The same parameters as the (shape, deflection, relative, angle, parallel) constructor.
    IMeshTools_Parameters params;
    params.Deflection = linearDeflection;
    params.Angle = angularDeflection;
    params.Relative = relative;
    params.InParallel = meshInParallel(shape);
    if (force) {
        // The mesher reuses a triangulation by its linear deflection alone, so a finer one, or
        // one with a different angle, stays. Remove it, and mesh from nothing.
        BRepTools::Clean(shape);
        params.AllowQualityDecrease = true;
    }
    BRepMesh_IncrementalMesh mesher(shape, params);
    if (!mesher.IsDone()) {
        throw std::runtime_error("meshing failed");
    }
}

struct MeshSnapshot::Saved {
    struct Face {
        Handle(BRep_TFace) tface;
        NCollection_List<Handle(Poly_Triangulation)> triangulations;
        Handle(Poly_Triangulation) active;
    };
    struct Edge {
        Handle(BRep_TEdge) tedge;
        NCollection_List<Handle(BRep_CurveRepresentation)> curves;
        // The mesher changes a 3D polygon in its representation instead of replacing it.
        std::vector<std::pair<Handle(BRep_CurveRepresentation), Handle(Poly_Polygon3D)>> polygons;
    };
    std::vector<Face> faces;
    std::vector<Edge> edges;
};

MeshSnapshot::MeshSnapshot(const TopoDS_Shape& shape) : saved_(std::make_unique<Saved>()) {
    std::unordered_set<const TopoDS_TShape*> seen;
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
        Handle(BRep_TFace) tface = Handle(BRep_TFace)::DownCast(ex.Current().TShape());
        if (tface.IsNull() || !seen.insert(tface.get()).second)
            continue;
        saved_->faces.push_back({tface, tface->Triangulations(), tface->ActiveTriangulation()});
    }
    for (TopExp_Explorer ex(shape, TopAbs_EDGE); ex.More(); ex.Next()) {
        Handle(BRep_TEdge) tedge = Handle(BRep_TEdge)::DownCast(ex.Current().TShape());
        if (tedge.IsNull() || !seen.insert(tedge.get()).second)
            continue;
        Saved::Edge edge{tedge, tedge->Curves(), {}};
        for (const auto& curve : edge.curves) {
            if (curve->IsPolygon3D())
                edge.polygons.emplace_back(curve, curve->Polygon3D());
        }
        saved_->edges.push_back(std::move(edge));
    }
}

MeshSnapshot::~MeshSnapshot() {
    for (auto& face : saved_->faces) {
        if (face.triangulations.IsEmpty())
            face.tface->Triangulation(Handle(Poly_Triangulation)(), true);
        else
            face.tface->Triangulations(face.triangulations, face.active);
    }
    for (auto& edge : saved_->edges) {
        edge.tedge->ChangeCurves() = edge.curves;
        for (auto& [curve, polygon] : edge.polygons)
            curve->Polygon3D(polygon);
    }
}

// --- MeshData implementation ---

MeshData::~MeshData() {
    std::free(positions);
    std::free(normals);
    std::free(uvs);
    std::free(indices);
    std::free(faceGroups);
}

MeshData::MeshData(const MeshData& other)
    : positions(other.positions), normals(other.normals), uvs(other.uvs), indices(other.indices),
      faceGroups(other.faceGroups), positionCount(other.positionCount),
      normalCount(other.normalCount), uvCount(other.uvCount), indexCount(other.indexCount),
      faceGroupCount(other.faceGroupCount) {
    auto& mut = const_cast<MeshData&>(other);
    mut.positions = nullptr;
    mut.normals = nullptr;
    mut.uvs = nullptr;
    mut.indices = nullptr;
    mut.faceGroups = nullptr;
}

int MeshData::getPositionsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(positions));
}

int MeshData::getNormalsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(normals));
}

int MeshData::getUvsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(uvs));
}

int MeshData::getIndicesPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(indices));
}

int MeshData::getFaceGroupsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(faceGroups));
}

// --- OcctKernel implementation ---

OcctKernel::OcctKernel() {
    OSD::SetSignal(false);
    sizeThreadPool();
}

OcctKernel::~OcctKernel() {
    releaseAll();
}

// --- The history of a step ---

// Follows each shape of `fromIds` through the makers of a step, in order, to the shapes of
// `type` in `result`. A maker that does not name a shape leaves it as it is. A shape that a
// maker generates from a shape stays generated through each maker after it. For each input
// the answer is the count of the modified images and their indices, then the same for the
// generated images. An index is the place of the image in TopExp::MapShapes of `result`, the
// order of getSubShapes, and an input that is in `result` unchanged is its own image.
std::vector<int> OcctKernel::imagesOf(const std::vector<Handle(BRepTools_History)>& steps,
                                      const std::vector<uint32_t>& fromIds,
                                      const TopoDS_Shape& result, TopAbs_ShapeEnum type) const {
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> targets;
    TopExp::MapShapes(result, type, targets);
    std::vector<int> out;
    for (uint32_t fromId : fromIds) {
        // Each shape that the input is now, and whether a maker generated it.
        std::vector<std::pair<TopoDS_Shape, bool>> now{{get(fromId), false}};
        for (const Handle(BRepTools_History) & step : steps) {
            std::vector<std::pair<TopoDS_Shape, bool>> next;
            NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> seen;
            auto add = [&](const TopoDS_Shape& shape, bool generated) {
                if (seen.Add(shape) > static_cast<int>(next.size()))
                    next.emplace_back(shape, generated);
            };
            for (const auto& [shape, generated] : now) {
                const NCollection_List<TopoDS_Shape>& modified = step->Modified(shape);
                if (!step->IsRemoved(shape)) {
                    if (modified.IsEmpty())
                        add(shape, generated);
                    for (const TopoDS_Shape& image : modified)
                        add(image, generated);
                }
                for (const TopoDS_Shape& image : step->Generated(shape))
                    add(image, true);
            }
            now = std::move(next);
        }
        std::vector<int> modified;
        std::vector<int> generated;
        for (const auto& [shape, isGenerated] : now) {
            if (shape.ShapeType() != type)
                continue;
            const int index = targets.FindIndex(shape);
            if (index > 0)
                (isGenerated ? generated : modified).push_back(index - 1);
        }
        for (std::vector<int>* images : {&modified, &generated}) {
            std::sort(images->begin(), images->end());
            images->erase(std::unique(images->begin(), images->end()), images->end());
            out.push_back(static_cast<int>(images->size()));
            out.insert(out.end(), images->begin(), images->end());
        }
    }
    return out;
}

uint32_t OcctKernel::store(const TopoDS_Shape& shape) {
    uint32_t id = nextId_++;
    arena_.emplace(id, shape);
    return id;
}

const TopoDS_Shape& OcctKernel::get(uint32_t id) const {
    auto it = arena_.find(id);
    if (it == arena_.end()) {
        throw std::runtime_error("Invalid shape ID: " + std::to_string(id));
    }
    return it->second;
}

// A profile face whose normal opposes the sweep direction yields an inside-out
// (negative-volume) solid. Upstream OpenCascade's boolean tolerated these, but
// occt-wasm's strict BOP rejects them (returns empty) -- notably for engraved
// text, where glyph faces carry arbitrary winding. Reverse any negative-volume
// solid to outward orientation, recursing into compounds so multi-shell sweep
// results (e.g. a compound profile) are normalized member by member.
TopoDS_Shape OcctKernel::normalizeSolidOrientation(const TopoDS_Shape& shape) {
    if (shape.ShapeType() == TopAbs_SOLID) {
        GProp_GProps props;
        BRepGProp::VolumeProperties(shape, props);
        if (props.Mass() < 0.0) {
            TopoDS_Shape reversed = shape;
            reversed.Reverse();
            return reversed;
        }
        return shape;
    }
    if (shape.ShapeType() == TopAbs_COMPOUND) {
        TopoDS_Compound rebuilt;
        BRep_Builder builder;
        builder.MakeCompound(rebuilt);
        for (TopoDS_Iterator it(shape); it.More(); it.Next()) {
            builder.Add(rebuilt, normalizeSolidOrientation(it.Value()));
        }
        return rebuilt;
    }
    return shape;
}

// Shared mesh builder for tessellate(), tessellateRelative() and meshShapeForced().
// `relative` selects per-edge size-relative deflection vs. absolute. `force` meshes at
// the requested deflection even where the shape holds a finer triangulation.
MeshData OcctKernel::buildMeshData(const TopoDS_Shape& shape, double linearDeflection,
                                   double angularDeflection, bool relative, bool force) {
    // A forced mesh puts the triangulation of the shape back after the data is read.
    std::optional<MeshSnapshot> snapshot;
    if (force)
        snapshot.emplace(shape);
    meshShapeAt(shape, linearDeflection, angularDeflection, relative, force);

    // Cache each face's triangulation during this single traversal so the fill
    // pass below reuses it instead of re-exploring the shape and re-fetching
    // every triangulation handle a second time.
    struct FaceEntry {
        Handle(Poly_Triangulation) tri;
        TopLoc_Location loc;
        TopoDS_Face face;
    };
    std::vector<FaceEntry> faces;

    int totalNodes = 0;
    int totalTris = 0;
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face& face = TopoDS::Face(ex.Current());
        TopLoc_Location loc;
        auto tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull())
            continue;
        totalNodes += tri->NbNodes();
        totalTris += tri->NbTriangles();
        faces.push_back({tri, loc, face});
    }
    int totalFaces = static_cast<int>(faces.size());

    MeshData result;
    result.positionCount = totalNodes * 3;
    result.normalCount = totalNodes * 3;
    result.uvCount = totalNodes * 2;
    result.indexCount = totalTris * 3;

    result.positions = static_cast<float*>(std::malloc(result.positionCount * sizeof(float)));
    result.normals = static_cast<float*>(std::malloc(result.normalCount * sizeof(float)));
    result.uvs = static_cast<float*>(std::malloc(result.uvCount * sizeof(float)));
    result.indices = static_cast<uint32_t*>(std::malloc(result.indexCount * sizeof(uint32_t)));
    result.faceGroupCount = totalFaces * 3;
    result.faceGroups = static_cast<int32_t*>(std::malloc(result.faceGroupCount * sizeof(int32_t)));

    if ((!result.positions && result.positionCount > 0) ||
        (!result.normals && result.normalCount > 0) || (!result.uvs && result.uvCount > 0) ||
        (!result.indices && result.indexCount > 0) ||
        (!result.faceGroups && result.faceGroupCount > 0)) {
        throw std::runtime_error("tessellate: memory allocation failed");
    }

    int vertexOffset = 0;
    int triOffset = 0;
    int faceGroupIdx = 0;

    for (const auto& entry : faces) {
        const TopoDS_Face& face = entry.face;
        const TopLoc_Location& loc = entry.loc;
        Handle(Poly_Triangulation) tri = entry.tri;

        const auto& trsf = loc.Transformation();
        bool identityLoc = loc.IsIdentity();
        int nbNodes = tri->NbNodes();
        int nbTri = tri->NbTriangles();

        if (identityLoc) {
            for (int i = 1; i <= nbNodes; i++) {
                const gp_Pnt& p = tri->Node(i);
                int base = (vertexOffset + i - 1) * 3;
                result.positions[base + 0] = static_cast<float>(p.X());
                result.positions[base + 1] = static_cast<float>(p.Y());
                result.positions[base + 2] = static_cast<float>(p.Z());
            }
        } else {
            for (int i = 1; i <= nbNodes; i++) {
                gp_Pnt p = tri->Node(i).Transformed(trsf);
                int base = (vertexOffset + i - 1) * 3;
                result.positions[base + 0] = static_cast<float>(p.X());
                result.positions[base + 1] = static_cast<float>(p.Y());
                result.positions[base + 2] = static_cast<float>(p.Z());
            }
        }

        bool hasUV = tri->HasUVNodes();
        for (int i = 1; i <= nbNodes; i++) {
            int uvBase = (vertexOffset + i - 1) * 2;
            if (hasUV) {
                const gp_Pnt2d& uv = tri->UVNode(i);
                result.uvs[uvBase + 0] = static_cast<float>(uv.X());
                result.uvs[uvBase + 1] = static_cast<float>(uv.Y());
            } else {
                result.uvs[uvBase + 0] = 0.0f;
                result.uvs[uvBase + 1] = 0.0f;
            }
        }

        // Triangulation normals are surface normals: ComputeNormals ignores the
        // face orientation, and the Poly_Triangulation is shared by every face
        // using this surface, so the flip must happen here, not in the cache.
        bool isReversed = (face.Orientation() == TopAbs_REVERSED);
        if (!tri->HasNormals()) {
            BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri);
        }
        bool hasNormals = tri->HasNormals();
        for (int i = 1; i <= nbNodes; i++) {
            gp_Dir d(0, 0, 1);
            if (hasNormals) {
                NCollection_Vec3<float> nv;
                tri->Normal(i, nv);
                if (nv.x() != 0.0f || nv.y() != 0.0f || nv.z() != 0.0f) {
                    d = gp_Dir(nv.x(), nv.y(), nv.z());
                }
            }
            if (isReversed) {
                d.Reverse();
            }
            if (!identityLoc) {
                d = d.Transformed(trsf);
            }
            int base = (vertexOffset + i - 1) * 3;
            result.normals[base + 0] = static_cast<float>(d.X());
            result.normals[base + 1] = static_cast<float>(d.Y());
            result.normals[base + 2] = static_cast<float>(d.Z());
        }

        for (int t = 1; t <= nbTri; t++) {
            const auto& triangle = tri->Triangle(t);
            int n1 = triangle.Value(1);
            int n2 = triangle.Value(2);
            int n3 = triangle.Value(3);

            if (isReversed) {
                int tmp = n1;
                n1 = n2;
                n2 = tmp;
            }

            result.indices[triOffset + 0] = static_cast<uint32_t>(n1 - 1 + vertexOffset);
            result.indices[triOffset + 1] = static_cast<uint32_t>(n2 - 1 + vertexOffset);
            result.indices[triOffset + 2] = static_cast<uint32_t>(n3 - 1 + vertexOffset);
            triOffset += 3;
        }

        int faceTriStart = triOffset - nbTri * 3;
        int faceHash = static_cast<int>(TopTools_ShapeMapHasher{}(face) % 2147483647);
        result.faceGroups[faceGroupIdx + 0] = faceTriStart;
        result.faceGroups[faceGroupIdx + 1] = nbTri * 3;
        result.faceGroups[faceGroupIdx + 2] = faceHash;
        faceGroupIdx += 3;

        vertexOffset += nbNodes;
    }

    return result;
}

// --- MeshBatchData implementation ---

MeshBatchData::~MeshBatchData() {
    std::free(positions);
    std::free(normals);
    std::free(indices);
    std::free(shapeOffsets);
}

MeshBatchData::MeshBatchData(const MeshBatchData& other)
    : positions(other.positions), normals(other.normals), indices(other.indices),
      shapeOffsets(other.shapeOffsets), positionCount(other.positionCount),
      normalCount(other.normalCount), indexCount(other.indexCount), shapeCount(other.shapeCount) {
    auto& mut = const_cast<MeshBatchData&>(other);
    mut.positions = nullptr;
    mut.normals = nullptr;
    mut.indices = nullptr;
    mut.shapeOffsets = nullptr;
}

int MeshBatchData::getPositionsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(positions));
}

int MeshBatchData::getNormalsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(normals));
}

int MeshBatchData::getIndicesPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(indices));
}

int MeshBatchData::getShapeOffsetsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(shapeOffsets));
}

// --- EdgeData implementation ---

EdgeData::~EdgeData() {
    std::free(points);
    std::free(edgeGroups);
}

EdgeData::EdgeData(const EdgeData& other)
    : points(other.points), edgeGroups(other.edgeGroups), pointCount(other.pointCount),
      edgeGroupCount(other.edgeGroupCount) {
    auto& mut = const_cast<EdgeData&>(other);
    mut.points = nullptr;
    mut.edgeGroups = nullptr;
}

int EdgeData::getPointsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(points));
}

int EdgeData::getEdgeGroupsPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(edgeGroups));
}
