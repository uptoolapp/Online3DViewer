import { TriangleGrid, TriangleGridHit } from '../geometry/trianglegrid.js';
import { GetBoundingBox } from '../model/modelutils.js';
import { Unit, convertUnit } from '../model/unit.js';
import { ParseHexColor } from '../surfacestrain/surfacestraincolor.js';
import { SurfaceStrainUnitCandidates, SurfaceStrainUnitToString } from '../surfacestrain/surfacestrainunits.js';

// Coloured polylines drawn on the model, for example the risky edges of a frequency analysis.
// The polylines come from the host in a known unit (mm in the STEP's own frame) and are converted
// to the model unit. They are tessellation vertices of the part's own edges, so every point must
// lie on the model's surface. That catches edges of another part, and edges in a unit that is too
// large, because they grow off the part. Edges in a unit that is too small shrink toward the origin
// and can land on the surface there, loosely. A fit counts only if the edges keep a real size, a
// set collapsed to a point says nothing about the unit. If the edges fit in the declared unit they
// are accepted, even if they fit in another unit too, because an edge on a line or face through the
// origin stays on it when scaled. They are refused only if another unit fits much more closely,
// which is how a wrongly shrunk set that lands loosely on the surface shows up.

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

// The bounding box and surface index of a model are built once and reused by later calls, for
// example to recolor or filter the edges.
const ModelSurfaceCache = new WeakMap ();

/**
 * @returns {{box: Box3D, index: TriangleGrid}|null} Null for an empty model.
 */
function GetModelSurface (model)
{
    let surface = ModelSurfaceCache.get (model);
    if (surface !== undefined) {
        return surface;
    }

    let box = GetBoundingBox (model);
    if (box === null) {
        return null;
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
    // Every three consecutive vertices form a triangle, so no index array, and no normals.
    let bboxMin = [box.min.x, box.min.y, box.min.z];
    let bboxSize = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
    let largestSize = Math.max (bboxSize[0], bboxSize[1], bboxSize[2]);
    let cellSize = largestSize > 0.0 ? largestSize / 128.0 : 1.0;
    let index = new TriangleGrid (positions, null, bboxMin, bboxSize, cellSize, false);
    surface = { box : box, index : index };
    ModelSurfaceCache.set (model, surface);
    return surface;
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

// Another unit must fit this many times more closely than the declared one to refuse it.
const CloserFitRatio = 4.0;

class SurfaceFit
{
    constructor (offSurface, maxDistance)
    {
        // The first point farther than the tolerance, or null if every point is on the surface.
        this.offSurface = offSurface;
        // Largest distance from the surface, valid only if every point is on it.
        this.maxDistance = maxDistance;
    }

    Fits ()
    {
        return this.offSurface === null;
    }
}

/**
 * Measures how closely the points lie on the model's surface when the coordinates are multiplied
 * by scale.
 * @returns {SurfaceFit}
 */
function MeasureSurfaceFit (edges, scale, index, box, tolerance)
{
    let hit = new TriangleGridHit ();
    let maxDistance = 0.0;
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
            if (!insideBox || !index.FindClosest (x, y, z, 0.0, 0.0, 0.0, tolerance, hit)) {
                return new SurfaceFit ({ edgeIndex : edgeIndex, pointIndex : i }, Infinity);
            }
            maxDistance = Math.max (maxDistance, hit.distance);
        }
    }
    return new SurfaceFit (null, maxDistance);
}

function OffSurfaceReason (offSurface)
{
    return 'edge ' + offSurface.edgeIndex.toString () + ': point ' + offSurface.pointIndex.toString () + ' is not on the model';
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
    let surface = GetModelSurface (model);
    if (surface === null) {
        return 'the model is empty';
    }
    let box = surface.box;
    let index = surface.index;
    let largestSize = Math.max (box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    let tolerance = largestSize * params.surfaceTolerance;
    let modelUnit = model.GetUnit ();

    // Without a model unit there is nothing to convert to, the coordinates are used as they are.
    if (!SurfaceStrainUnitCandidates.includes (modelUnit)) {
        let fit = MeasureSurfaceFit (edges, 1.0, index, box, tolerance);
        if (!fit.Fits ()) {
            return OffSurfaceReason (fit.offSurface) + ', the edges may belong to another part';
        }
        return null;
    }

    let extent = GetExtent (edges);
    let IsCollapsed = (scale) => extent * scale <= 2.0 * tolerance;

    let scale = GetScale (params.unit, modelUnit);
    let fit = MeasureSurfaceFit (edges, scale, index, box, tolerance);
    let collapsed = IsCollapsed (scale);
    let unitName = SurfaceStrainUnitToString (params.unit);

    // The other units that fit with a real size, the largest first, so a reason names the unit
    // with the most spread out fit.
    let otherUnits = SurfaceStrainUnitCandidates.filter ((unit) => unit !== params.unit);
    otherUnits.sort ((a, b) => GetScale (b, modelUnit) - GetScale (a, modelUnit));
    let FindFittingUnit = (isBetterFit) => otherUnits.find ((unit) => {
        let otherScale = GetScale (unit, modelUnit);
        if (IsCollapsed (otherScale)) {
            return false;
        }
        let otherFit = MeasureSurfaceFit (edges, otherScale, index, box, tolerance);
        return otherFit.Fits () && isBetterFit (otherFit);
    });

    if (!fit.Fits ()) {
        let fittingUnit = FindFittingUnit (() => true);
        if (fittingUnit !== undefined) {
            return OffSurfaceReason (fit.offSurface) + ', the edges fit the model only if they were in ' + SurfaceStrainUnitToString (fittingUnit) + ', not ' + unitName;
        }
        return OffSurfaceReason (fit.offSurface) + ', the edges may belong to another part';
    }

    if (collapsed) {
        // A collapsed set lies on the surface by chance, any other unit that fits explains it.
        let fittingUnit = FindFittingUnit (() => true);
        if (fittingUnit !== undefined) {
            return 'the edges collapse to a point in ' + unitName + ', they fit the model only if they were in ' + SurfaceStrainUnitToString (fittingUnit);
        }
        return null;
    }

    // A fit within a quarter of the tolerance is as close as the tessellation allows.
    if (fit.maxDistance > tolerance / CloserFitRatio) {
        let closerUnit = FindFittingUnit ((otherFit) => otherFit.maxDistance * CloserFitRatio < fit.maxDistance);
        if (closerUnit !== undefined) {
            return 'the edges lie on the model only loosely in ' + unitName + ', they fit it much more closely in ' + SurfaceStrainUnitToString (closerUnit);
        }
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
