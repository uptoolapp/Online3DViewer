import { GetBoundingBox } from '../model/modelutils.js';
import { Unit, convertUnit } from '../model/unit.js';
import { ParseHexColor } from '../surfacestrain/surfacestraincolor.js';
import { SurfaceStrainIndex, SurfaceStrainSample } from '../surfacestrain/surfacestrainsampler.js';
import { SurfaceStrainUnitCandidates, SurfaceStrainUnitToString } from '../surfacestrain/surfacestrainunits.js';

// Coloured polylines drawn on the model, for example the risky edges of a frequency analysis.
// The polylines come from the host in a known unit (mm in the STEP's own frame) and are converted
// to the model unit. They are tessellation vertices of the part's own edges, so every point must
// lie on the model's surface. That catches edges of another part, and edges in a unit that is too
// large, because they grow off the part. Edges in a unit that is too small shrink toward the origin
// and can still touch the surface near it, so the larger units are tried too: if the edges also
// fit in one of them, they are refused. A fit counts only if the edges keep a real size, a set
// collapsed to a point says nothing about the unit.

export class EdgeHighlight
{
    constructor (polyline, color, width)
    {
        // Ordered list of [x, y, z] points, at least two.
        this.polyline = polyline;
        // Hex color like '#ff0000'.
        this.color = color;
        // Line width in pixels, null uses EdgeHighlightParams.width.
        this.width = (width === undefined ? null : width);
    }
}

export class EdgeHighlightParams
{
    constructor ()
    {
        // Unit of the polyline coordinates, they are converted to the model unit.
        this.unit = Unit.Millimeter;
        // Default line width in CSS pixels.
        this.width = 4.0;
        // Every point must lie this close to the model's surface, as a fraction of the largest
        // size of the model's bounding box. The viewer tessellates STEP with a deflection of 0.1%
        // of the bounding box, so points of curved edges sit up to that far from its triangles.
        this.surfaceTolerance = 0.002;
    }
}

export class EdgeHighlightResult
{
    constructor ()
    {
        this.ok = false;
        this.reason = null;
        this.edgeCount = 0;
    }
}

export class PreparedEdgeHighlight
{
    constructor (positions, color, width)
    {
        // Float32Array of x, y, z in model units.
        this.positions = positions;
        // Float RGB in 0..1.
        this.color = color;
        // Line width in CSS pixels.
        this.width = width;
    }

    PointCount ()
    {
        return this.positions.length / 3;
    }
}

// The surface index of a model is built once and reused by later calls with other colors.
const SurfaceIndexCache = new WeakMap ();

function GetSurfaceIndex (model, box)
{
    let index = SurfaceIndexCache.get (model);
    if (index !== undefined) {
        return index;
    }

    let positions = new Float32Array (model.TriangleCount () * 9);
    let offset = 0;
    model.EnumerateMeshInstances ((meshInstance) => {
        meshInstance.EnumerateTriangleVertices ((v0, v1, v2) => {
            for (let vertex of [v0, v1, v2]) {
                positions[offset++] = vertex.x;
                positions[offset++] = vertex.y;
                positions[offset++] = vertex.z;
            }
        });
    });
    let triangles = new Uint32Array (positions.length / 3);
    for (let i = 0; i < triangles.length; i++) {
        triangles[i] = i;
    }

    // The closest point grid of the surface strain mapping, over the model's own triangles.
    let bboxMin = [box.min.x, box.min.y, box.min.z];
    let bboxSize = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
    index = new SurfaceStrainIndex ({
        positions : positions,
        triangles : triangles,
        log10Strain : new Float32Array (triangles.length),
        bboxMin : bboxMin,
        bboxSize : bboxSize,
        meshSize : Math.max (bboxSize[0], bboxSize[1], bboxSize[2]) / 128.0
    });
    SurfaceIndexCache.set (model, index);
    return index;
}

function IsValidWidth (width)
{
    return typeof width === 'number' && Number.isFinite (width) && width > 0.0;
}

function ParseEdge (edge, params)
{
    if (edge === null || typeof edge !== 'object') {
        throw new Error ('must be an object with polyline and color');
    }
    let polyline = edge.polyline;
    if (!Array.isArray (polyline) || polyline.length < 2) {
        throw new Error ('polyline needs at least 2 points');
    }
    let color = ParseHexColor (edge.color, 'color');
    let width = params.width;
    if (edge.width !== undefined && edge.width !== null) {
        if (!IsValidWidth (edge.width)) {
            throw new Error ('width must be a positive number, got ' + JSON.stringify (edge.width));
        }
        width = edge.width;
    }

    let positions = new Float32Array (polyline.length * 3);
    for (let i = 0; i < polyline.length; i++) {
        let point = polyline[i];
        if (!Array.isArray (point) || point.length !== 3) {
            throw new Error ('point ' + i.toString () + ' must be [x, y, z]');
        }
        for (let axis = 0; axis < 3; axis++) {
            let value = point[axis];
            if (typeof value !== 'number' || !Number.isFinite (value)) {
                throw new Error ('point ' + i.toString () + ' has a coordinate that is not a finite number');
            }
            positions[i * 3 + axis] = value;
        }
    }
    return new PreparedEdgeHighlight (positions, color, width);
}

/**
 * Returns the first point that is farther than tolerance from the model's surface when the
 * coordinates are multiplied by scale, or null if every point lies on the surface.
 */
function FindPointOffSurface (edges, scale, index, box, tolerance)
{
    let sample = new SurfaceStrainSample ();
    for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
        let positions = edges[edgeIndex].positions;
        for (let i = 0; i < positions.length / 3; i++) {
            let x = positions[i * 3] * scale;
            let y = positions[i * 3 + 1] * scale;
            let z = positions[i * 3 + 2] * scale;
            let insideBox = (
                x >= box.min.x - tolerance && x <= box.max.x + tolerance &&
                y >= box.min.y - tolerance && y <= box.max.y + tolerance &&
                z >= box.min.z - tolerance && z <= box.max.z + tolerance
            );
            if (!insideBox || !index.Sample (x, y, z, 0.0, 0.0, 0.0, tolerance, sample)) {
                return { edgeIndex : edgeIndex, pointIndex : i };
            }
        }
    }
    return null;
}

function GetExtent (edges)
{
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let edge of edges) {
        for (let i = 0; i < edge.positions.length; i++) {
            min[i % 3] = Math.min (min[i % 3], edge.positions[i]);
            max[i % 3] = Math.max (max[i % 3], edge.positions[i]);
        }
    }
    return Math.hypot (max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function GetScale (fromUnit, toUnit)
{
    return convertUnit ({ value : 1.0, fromUnit : fromUnit, toUnit : toUnit });
}

function CheckOnSurface (model, edges, params)
{
    let box = GetBoundingBox (model);
    if (box === null) {
        return 'the model is empty';
    }
    let largestSize = Math.max (box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    let tolerance = largestSize * params.surfaceTolerance;
    let index = GetSurfaceIndex (model, box);
    let modelUnit = model.GetUnit ();

    // Without a model unit there is nothing to convert to, the coordinates are used as they are.
    if (!SurfaceStrainUnitCandidates.includes (modelUnit)) {
        let offSurface = FindPointOffSurface (edges, 1.0, index, box, tolerance);
        if (offSurface !== null) {
            return 'edge ' + offSurface.edgeIndex.toString () + ': point ' + offSurface.pointIndex.toString () + ' is not on the model, the edges may belong to another part';
        }
        return null;
    }

    let extent = GetExtent (edges);
    let IsCollapsed = (scale) => extent * scale <= 2.0 * tolerance;

    let scale = GetScale (params.unit, modelUnit);
    let offSurface = FindPointOffSurface (edges, scale, index, box, tolerance);
    // Largest unit first, so the reason names the unit with the most spread out fit.
    let otherUnits = SurfaceStrainUnitCandidates.filter ((unit) => unit !== params.unit);
    otherUnits.sort ((a, b) => GetScale (b, modelUnit) - GetScale (a, modelUnit));
    if (offSurface === null) {
        otherUnits = otherUnits.filter ((unit) => GetScale (unit, modelUnit) > scale);
    }
    let fittingUnit = otherUnits.find ((unit) => {
        let otherScale = GetScale (unit, modelUnit);
        return !IsCollapsed (otherScale) && FindPointOffSurface (edges, otherScale, index, box, tolerance) === null;
    });
    let unitName = SurfaceStrainUnitToString (params.unit);
    if (offSurface !== null) {
        let reason = 'edge ' + offSurface.edgeIndex.toString () + ': point ' + offSurface.pointIndex.toString () + ' is not on the model';
        if (fittingUnit !== undefined) {
            return reason + ', the edges fit the model only if they were in ' + SurfaceStrainUnitToString (fittingUnit) + ', not ' + unitName;
        }
        return reason + ', the edges may belong to another part';
    }
    if (fittingUnit !== undefined) {
        if (IsCollapsed (scale)) {
            return 'the edges collapse to a point in ' + unitName + ', they fit the model only if they were in ' + SurfaceStrainUnitToString (fittingUnit);
        }
        return 'the edges fit the model both in ' + unitName + ' and in ' + SurfaceStrainUnitToString (fittingUnit) + ', the unit is ambiguous';
    }
    return null;
}

/**
 * Validates the edges, converts them to the model unit and checks that they lie on the model's
 * surface. Either every edge is prepared or none.
 * @param {Model} model The viewer's model.
 * @param {EdgeHighlight[]} edges Edges to show.
 * @param {EdgeHighlightParams} [params] Parameters.
 * @returns {{result: EdgeHighlightResult, prepared: PreparedEdgeHighlight[]|null}} On failure
 * result.ok is false, result.reason says why, and nothing must be shown.
 */
export function PrepareEdgeHighlights (model, edges, params)
{
    if (!params) {
        params = new EdgeHighlightParams ();
    }

    let result = new EdgeHighlightResult ();
    if (!Array.isArray (edges)) {
        result.reason = 'edges must be a list';
        return { result, prepared : null };
    }
    if (!SurfaceStrainUnitCandidates.includes (params.unit)) {
        result.reason = 'unit must be one of the OV.Unit values mm, cm, m, in or ft, got ' + JSON.stringify (params.unit);
        return { result, prepared : null };
    }
    if (!IsValidWidth (params.width)) {
        result.reason = 'width must be a positive number, got ' + JSON.stringify (params.width);
        return { result, prepared : null };
    }
    if (!IsValidWidth (params.surfaceTolerance)) {
        result.reason = 'surfaceTolerance must be a positive number, got ' + JSON.stringify (params.surfaceTolerance);
        return { result, prepared : null };
    }

    let prepared = [];
    for (let i = 0; i < edges.length; i++) {
        try {
            prepared.push (ParseEdge (edges[i], params));
        } catch (error) {
            result.reason = 'edge ' + i.toString () + ': ' + error.message;
            return { result, prepared : null };
        }
    }

    if (prepared.length > 0) {
        let reason = CheckOnSurface (model, prepared, params);
        if (reason !== null) {
            result.reason = reason;
            return { result, prepared : null };
        }
        let modelUnit = model.GetUnit ();
        if (SurfaceStrainUnitCandidates.includes (modelUnit) && modelUnit !== params.unit) {
            let scale = GetScale (params.unit, modelUnit);
            for (let edge of prepared) {
                for (let i = 0; i < edge.positions.length; i++) {
                    edge.positions[i] *= scale;
                }
            }
        }
    }

    result.ok = true;
    result.edgeCount = prepared.length;
    return { result, prepared };
}
