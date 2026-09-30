import { Coord3D } from '../geometry/coord3d.js';
import { RefineTriangles, RefinementBudget } from './surfacestrainrefine.js';

// Samples the FE surface strain onto the viewer's own tessellation. Every length here is in the
// model unit, the artifact has already been converted by ConvertSurfaceStrainToUnit.

export class SurfaceStrainSample
{
    constructor ()
    {
        this.log10Strain = NaN;
        this.mode = 0;
        this.distance = Infinity;
    }
}

/**
 * Uniform grid over the FE surface triangles for closest point queries.
 */
export class SurfaceStrainIndex
{
    /**
     * @param {SurfaceStrainGeometry} geometry FE surface in model units.
     */
    constructor (geometry)
    {
        this.geometry = geometry;
        let positions = geometry.positions;
        let triangles = geometry.triangles;
        let triangleCount = triangles.length / 3;

        let largestSize = Math.max (geometry.bboxSize[0], geometry.bboxSize[1], geometry.bboxSize[2]);
        this.cellSize = geometry.meshSize > 0.0 ? geometry.meshSize : largestSize / 100.0;
        if (!(this.cellSize > 0.0)) {
            this.cellSize = 1.0;
        }
        // Keep the grid resolution sane even if the header's mesh size is tiny compared to the part.
        this.cellSize = Math.max (this.cellSize, largestSize / 1024.0);

        this.origin = [];
        this.dims = [];
        for (let axis = 0; axis < 3; axis++) {
            this.origin.push (geometry.bboxMin[axis] - this.cellSize);
            this.dims.push (Math.ceil (geometry.bboxSize[axis] / this.cellSize) + 3);
        }

        this.normals = new Float64Array (triangleCount * 3);
        this.cells = new Map ();
        this.visitStamps = new Uint32Array (triangleCount);
        this.currentStamp = 0;

        for (let t = 0; t < triangleCount; t++) {
            let a = triangles[t * 3] * 3;
            let b = triangles[t * 3 + 1] * 3;
            let c = triangles[t * 3 + 2] * 3;

            let abx = positions[b] - positions[a];
            let aby = positions[b + 1] - positions[a + 1];
            let abz = positions[b + 2] - positions[a + 2];
            let acx = positions[c] - positions[a];
            let acy = positions[c + 1] - positions[a + 1];
            let acz = positions[c + 2] - positions[a + 2];
            let nx = aby * acz - abz * acy;
            let ny = abz * acx - abx * acz;
            let nz = abx * acy - aby * acx;
            let length = Math.sqrt (nx * nx + ny * ny + nz * nz);
            if (length > 0.0) {
                this.normals[t * 3] = nx / length;
                this.normals[t * 3 + 1] = ny / length;
                this.normals[t * 3 + 2] = nz / length;
            }

            let min = [];
            let max = [];
            for (let axis = 0; axis < 3; axis++) {
                let lo = Math.min (positions[a + axis], positions[b + axis], positions[c + axis]);
                let hi = Math.max (positions[a + axis], positions[b + axis], positions[c + axis]);
                min.push (this.CellCoord (lo, axis));
                max.push (this.CellCoord (hi, axis));
            }
            // A slanted triangle's bounding box covers far more cells than the triangle itself,
            // so only keep the cells the triangle's plane passes through.
            let planeNormal = [this.normals[t * 3], this.normals[t * 3 + 1], this.normals[t * 3 + 2]];
            let checkPlane = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1) > 8;
            let halfDiagonal = this.cellSize * Math.sqrt (3.0) * 0.5;
            for (let ix = min[0]; ix <= max[0]; ix++) {
                for (let iy = min[1]; iy <= max[1]; iy++) {
                    for (let iz = min[2]; iz <= max[2]; iz++) {
                        if (checkPlane) {
                            let dx = this.origin[0] + (ix + 0.5) * this.cellSize - positions[a];
                            let dy = this.origin[1] + (iy + 0.5) * this.cellSize - positions[a + 1];
                            let dz = this.origin[2] + (iz + 0.5) * this.cellSize - positions[a + 2];
                            if (Math.abs (planeNormal[0] * dx + planeNormal[1] * dy + planeNormal[2] * dz) > halfDiagonal) {
                                continue;
                            }
                        }
                        let key = this.CellKey (ix, iy, iz);
                        let cell = this.cells.get (key);
                        if (cell === undefined) {
                            cell = [];
                            this.cells.set (key, cell);
                        }
                        cell.push (t);
                    }
                }
            }
        }

        this.barycentric = new Float64Array (3);
    }

    CellCoord (value, axis)
    {
        let coord = Math.floor ((value - this.origin[axis]) / this.cellSize);
        return Math.min (Math.max (coord, 0), this.dims[axis] - 1);
    }

    CellKey (ix, iy, iz)
    {
        return ix + this.dims[0] * (iy + this.dims[1] * iz);
    }

    /**
     * Finds the closest FE triangle whose outward normal agrees with the given normal, and
     * interpolates the strain there.
     * @param {number} px @param {number} py @param {number} pz Query point.
     * @param {number} nx @param {number} ny @param {number} nz Normal at the query point, a
     * zero normal disables the normal filter.
     * @param {number} maxDistance Triangles farther than this are ignored.
     * @param {SurfaceStrainSample} result Filled with the sample.
     * @returns {boolean} False if no candidate triangle is within maxDistance.
     */
    Sample (px, py, pz, nx, ny, nz, maxDistance, result)
    {
        let positions = this.geometry.positions;
        let triangles = this.geometry.triangles;
        let normals = this.normals;
        let bary = this.barycentric;

        this.currentStamp += 1;
        if (this.currentStamp === 0xFFFFFFFF) {
            this.visitStamps.fill (0);
            this.currentStamp = 1;
        }
        let stamp = this.currentStamp;

        let cx = Math.floor ((px - this.origin[0]) / this.cellSize);
        let cy = Math.floor ((py - this.origin[1]) / this.cellSize);
        let cz = Math.floor ((pz - this.origin[2]) / this.cellSize);
        let maxRing = Math.ceil (maxDistance / this.cellSize) + 1;

        let bestDistanceSquared = maxDistance * maxDistance;
        let bestTriangle = -1;
        let bestU = 0.0, bestV = 0.0, bestW = 0.0;

        for (let ring = 0; ring <= maxRing; ring++) {
            for (let ix = cx - ring; ix <= cx + ring; ix++) {
                if (ix < 0 || ix >= this.dims[0]) {
                    continue;
                }
                for (let iy = cy - ring; iy <= cy + ring; iy++) {
                    if (iy < 0 || iy >= this.dims[1]) {
                        continue;
                    }
                    let onShellXY = (Math.abs (ix - cx) === ring || Math.abs (iy - cy) === ring);
                    let zStep = onShellXY ? 1 : 2 * ring;
                    for (let iz = cz - ring; iz <= cz + ring; iz += (zStep > 0 ? zStep : 1)) {
                        if (iz < 0 || iz >= this.dims[2]) {
                            continue;
                        }
                        let cell = this.cells.get (this.CellKey (ix, iy, iz));
                        if (cell === undefined) {
                            continue;
                        }
                        for (let t of cell) {
                            if (this.visitStamps[t] === stamp) {
                                continue;
                            }
                            this.visitStamps[t] = stamp;
                            if (normals[t * 3] * nx + normals[t * 3 + 1] * ny + normals[t * 3 + 2] * nz <= 0.0 && (nx !== 0.0 || ny !== 0.0 || nz !== 0.0)) {
                                continue;
                            }
                            let a = triangles[t * 3] * 3;
                            let b = triangles[t * 3 + 1] * 3;
                            let c = triangles[t * 3 + 2] * 3;
                            let distanceSquared = ClosestPointOnTriangle (positions, a, b, c, px, py, pz, bary);
                            if (distanceSquared < bestDistanceSquared) {
                                bestDistanceSquared = distanceSquared;
                                bestTriangle = t;
                                bestU = bary[0];
                                bestV = bary[1];
                                bestW = bary[2];
                            }
                        }
                    }
                }
            }
            // Every triangle not examined yet is outside the block of rings, at least ring cells away.
            if (bestTriangle !== -1 && bestDistanceSquared <= (ring * this.cellSize) * (ring * this.cellSize)) {
                break;
            }
        }

        if (bestTriangle === -1) {
            result.log10Strain = NaN;
            result.mode = 0;
            result.distance = Infinity;
            return false;
        }

        let i0 = triangles[bestTriangle * 3];
        let i1 = triangles[bestTriangle * 3 + 1];
        let i2 = triangles[bestTriangle * 3 + 2];
        let log10Strain = this.geometry.log10Strain;
        result.log10Strain = bestU * log10Strain[i0] + bestV * log10Strain[i1] + bestW * log10Strain[i2];
        result.distance = Math.sqrt (bestDistanceSquared);

        // The driving mode is categorical, take it from the corner nearest to the closest point.
        let qx = bestU * positions[i0 * 3] + bestV * positions[i1 * 3] + bestW * positions[i2 * 3];
        let qy = bestU * positions[i0 * 3 + 1] + bestV * positions[i1 * 3 + 1] + bestW * positions[i2 * 3 + 1];
        let qz = bestU * positions[i0 * 3 + 2] + bestV * positions[i1 * 3 + 2] + bestW * positions[i2 * 3 + 2];
        let nearestCorner = i0;
        let nearestDistance = Infinity;
        for (let corner of [i0, i1, i2]) {
            let dx = positions[corner * 3] - qx;
            let dy = positions[corner * 3 + 1] - qy;
            let dz = positions[corner * 3 + 2] - qz;
            let distance = dx * dx + dy * dy + dz * dz;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestCorner = corner;
            }
        }
        result.mode = this.geometry.driving[nearestCorner];
        return true;
    }
}

// Closest point on triangle (a, b, c) to p, from Ericson: Real-Time Collision Detection 5.1.5.
// a, b and c are offsets into positions. Writes the barycentric weights of the closest point
// into bary and returns the squared distance.
function ClosestPointOnTriangle (positions, a, b, c, px, py, pz, bary)
{
    let ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    let bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    let cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];

    let abx = bx - ax, aby = by - ay, abz = bz - az;
    let acx = cx - ax, acy = cy - ay, acz = cz - az;
    let apx = px - ax, apy = py - ay, apz = pz - az;

    let u = 0.0, v = 0.0, w = 0.0;
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    let bpx = px - bx, bpy = py - by, bpz = pz - bz;
    let d3 = abx * bpx + aby * bpy + abz * bpz;
    let d4 = acx * bpx + acy * bpy + acz * bpz;
    let cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    let d5 = abx * cpx + aby * cpy + abz * cpz;
    let d6 = acx * cpx + acy * cpy + acz * cpz;
    let vc = d1 * d4 - d3 * d2;
    let vb = d5 * d2 - d1 * d6;
    let va = d3 * d6 - d5 * d4;

    if (d1 <= 0.0 && d2 <= 0.0) {
        u = 1.0;
    } else if (d3 >= 0.0 && d4 <= d3) {
        v = 1.0;
    } else if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
        v = d1 / (d1 - d3);
        u = 1.0 - v;
    } else if (d6 >= 0.0 && d5 <= d6) {
        w = 1.0;
    } else if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
        w = d2 / (d2 - d6);
        u = 1.0 - w;
    } else if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        v = 1.0 - w;
    } else {
        let denom = va + vb + vc;
        if (denom === 0.0) {
            // Degenerate triangle, fall back to the first corner.
            u = 1.0;
        } else {
            v = vb / denom;
            w = vc / denom;
            u = 1.0 - v - w;
        }
    }

    bary[0] = u;
    bary[1] = v;
    bary[2] = w;
    let qx = u * ax + v * bx + w * cx - px;
    let qy = u * ay + v * by + w * cy - py;
    let qz = u * az + v * bz + w * cz - pz;
    return qx * qx + qy * qy + qz * qz;
}

export class SurfaceStrainMeshResult
{
    constructor (meshInstanceId)
    {
        this.meshInstanceId = meshInstanceId;
        // Refined geometry in model coordinates, the node transformation is already applied.
        this.positions = null;
        this.normals = null;
        this.indices = null;
        // Per refined vertex, NaN and 0 where the mapping failed.
        this.log10Strain = null;
        this.mode = null;
        this.failedCount = 0;
    }

    VertexCount ()
    {
        return this.log10Strain.length;
    }
}

export class SurfaceStrainMapping
{
    constructor ()
    {
        this.meshes = [];
        this.vertexCount = 0;
        this.failedCount = 0;
        this.capped = false;
        this.maxDistance = 0.0;
    }

    FailedFraction ()
    {
        return this.vertexCount > 0 ? this.failedCount / this.vertexCount : 0.0;
    }
}

export class SurfaceStrainMappingParams
{
    constructor ()
    {
        // Guard against huge, finely meshed parts.
        this.maxVertexCount = 4000000;
        // A vertex farther than this many FE mesh sizes from any candidate triangle is a failure.
        this.maxDistanceFactor = 2.0;
    }
}

function CollectFaceGeometry (mesh, transformation, firstTriangle, lastTriangle)
{
    let isIdentity = transformation.IsIdentity ();
    let vertexMap = new Map ();
    let positions = [];
    let normals = [];
    let triangles = [];

    function AddVertex (vertexIndex, normalIndex)
    {
        let key = vertexIndex.toString () + '/' + (normalIndex === null ? '' : normalIndex.toString ());
        let index = vertexMap.get (key);
        if (index !== undefined) {
            return index;
        }
        let vertex = mesh.GetVertex (vertexIndex);
        let normal = normalIndex === null ? new Coord3D (0.0, 0.0, 0.0) : mesh.GetNormal (normalIndex);
        if (!isIdentity) {
            let tip = transformation.TransformCoord3D (new Coord3D (vertex.x + normal.x, vertex.y + normal.y, vertex.z + normal.z));
            vertex = transformation.TransformCoord3D (vertex);
            normal = new Coord3D (tip.x - vertex.x, tip.y - vertex.y, tip.z - vertex.z);
        }
        let length = Math.sqrt (normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
        if (length > 0.0) {
            normal = new Coord3D (normal.x / length, normal.y / length, normal.z / length);
        }
        index = positions.length / 3;
        positions.push (vertex.x, vertex.y, vertex.z);
        normals.push (normal.x, normal.y, normal.z);
        vertexMap.set (key, index);
        return index;
    }

    for (let i = firstTriangle; i <= lastTriangle; i++) {
        let triangle = mesh.GetTriangle (i);
        triangles.push (
            AddVertex (triangle.v0, triangle.n0),
            AddVertex (triangle.v1, triangle.n1),
            AddVertex (triangle.v2, triangle.n2)
        );
    }

    return { positions, normals, triangles };
}

function GetMeshFaceRanges (mesh)
{
    let triangleCount = mesh.TriangleCount ();
    let brepFaces = mesh.GetBrepFaces ();
    if (brepFaces.length === 0) {
        return triangleCount > 0 ? [{ first : 0, last : triangleCount - 1 }] : [];
    }
    return brepFaces.filter ((face) => face.first <= face.last && face.last < triangleCount);
}

/**
 * Maps the FE surface strain onto the viewer's model. Every BREP face of every mesh instance is
 * refined to the FE mesh size, then every refined vertex samples the FE surface.
 * @param {Model} model The viewer's model.
 * @param {SurfaceStrainGeometry} geometry FE surface converted to the model unit.
 * @param {SurfaceStrainMappingParams} [params] Mapping parameters.
 * @returns {SurfaceStrainMapping}
 */
export function MapSurfaceStrainToModel (model, geometry, params)
{
    if (!params) {
        params = new SurfaceStrainMappingParams ();
    }

    let index = new SurfaceStrainIndex (geometry);
    let budget = new RefinementBudget (params.maxVertexCount);
    let maxDistance = params.maxDistanceFactor * geometry.meshSize;
    let sample = new SurfaceStrainSample ();

    let mapping = new SurfaceStrainMapping ();
    mapping.maxDistance = maxDistance;

    model.EnumerateMeshInstances ((meshInstance) => {
        let mesh = meshInstance.GetMesh ();
        let transformation = meshInstance.GetTransformation ();
        let positions = [];
        let normals = [];
        let indices = [];
        for (let faceRange of GetMeshFaceRanges (mesh)) {
            let face = CollectFaceGeometry (mesh, transformation, faceRange.first, faceRange.last);
            let refined = RefineTriangles (face.positions, face.normals, face.triangles, geometry.meshSize, budget);
            let offset = positions.length / 3;
            for (let i = 0; i < refined.positions.length; i++) {
                positions.push (refined.positions[i]);
                normals.push (refined.normals[i]);
            }
            for (let i = 0; i < refined.triangles.length; i++) {
                indices.push (refined.triangles[i] + offset);
            }
        }
        if (indices.length === 0) {
            return;
        }

        let result = new SurfaceStrainMeshResult (meshInstance.GetId ());
        result.positions = new Float32Array (positions);
        result.normals = new Float32Array (normals);
        result.indices = new Uint32Array (indices);
        let vertexCount = positions.length / 3;
        result.log10Strain = new Float32Array (vertexCount);
        result.mode = new Uint8Array (vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            let found = index.Sample (
                positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
                normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2],
                maxDistance, sample
            );
            result.log10Strain[i] = sample.log10Strain;
            result.mode[i] = sample.mode;
            if (!found) {
                result.failedCount += 1;
            }
        }

        mapping.meshes.push (result);
        mapping.vertexCount += vertexCount;
        mapping.failedCount += result.failedCount;
    });

    mapping.capped = budget.capped;
    return mapping;
}
