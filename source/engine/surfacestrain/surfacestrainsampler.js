import { TriangleGrid, TriangleGridHit } from '../geometry/trianglegrid.js';
import { CollectFaceGeometry } from '../analysis/analysisfaces.js';
import { RefineTriangles, RefinementBudget } from './surfacestrainrefine.js';

// Samples the FE surface strain onto the viewer's own tessellation. Every length here is in the
// model unit, the artifact has already been converted by ConvertSurfaceStrainToUnit.

export class SurfaceStrainSample
{
    constructor ()
    {
        this.log10Strain = NaN;
        this.distance = Infinity;
    }
}

/**
 * Closest point queries on the FE surface, interpolating the strain at the closest point.
 */
export class SurfaceStrainIndex
{
    /**
     * @param {SurfaceStrainGeometry} geometry FE surface in model units.
     */
    constructor (geometry)
    {
        this.geometry = geometry;

        let largestSize = Math.max (geometry.bboxSize[0], geometry.bboxSize[1], geometry.bboxSize[2]);
        let cellSize = geometry.meshSize > 0.0 ? geometry.meshSize : largestSize / 100.0;
        if (!(cellSize > 0.0)) {
            cellSize = 1.0;
        }
        // Keep the grid resolution sane even if the header's mesh size is tiny compared to the part.
        cellSize = Math.max (cellSize, largestSize / 1024.0);

        this.grid = new TriangleGrid (geometry.positions, geometry.triangles, geometry.bboxMin, geometry.bboxSize, cellSize, true);
        this.hit = new TriangleGridHit ();
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
        let hit = this.hit;
        if (!this.grid.FindClosest (px, py, pz, nx, ny, nz, maxDistance, hit)) {
            result.log10Strain = NaN;
            result.distance = Infinity;
            return false;
        }

        let log10Strain = this.geometry.log10Strain;
        let i0 = this.grid.VertexIndex (hit.triangle, 0);
        let i1 = this.grid.VertexIndex (hit.triangle, 1);
        let i2 = this.grid.VertexIndex (hit.triangle, 2);
        result.log10Strain = hit.u * log10Strain[i0] + hit.v * log10Strain[i1] + hit.w * log10Strain[i2];
        result.distance = hit.distance;
        return true;
    }
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
        // Per refined vertex, NaN where the mapping failed.
        this.log10Strain = null;
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
        for (let i = 0; i < vertexCount; i++) {
            let found = index.Sample (
                positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
                normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2],
                maxDistance, sample
            );
            result.log10Strain[i] = sample.log10Strain;
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
