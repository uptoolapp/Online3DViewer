import { GetBoundingBox } from '../model/modelutils.js';
import { Unit, convertUnit } from '../model/unit.js';
import { ParseHexColor } from '../surfacestrain/surfacestraincolor.js';

// Coloured polylines drawn on the model, for example the risky edges of a frequency analysis.
// The polylines come from the host in a known unit (mm in the STEP's own frame), they are
// converted to the model unit and checked against the model's bounding box, so edges of another
// part or in the wrong unit are never drawn.

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
        // Every point must lie inside the model's bounding box grown by this fraction of its diagonal.
        this.frameTolerance = 0.01;
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

function GetUnitScale (fromUnit, toUnit)
{
    if (fromUnit === Unit.Unknown || toUnit === Unit.Unknown || fromUnit === toUnit) {
        return 1.0;
    }
    return convertUnit ({ value : 1.0, fromUnit : fromUnit, toUnit : toUnit });
}

function IsValidWidth (width)
{
    return typeof width === 'number' && Number.isFinite (width) && width > 0.0;
}

function PrepareEdge (edge, params, scale, box, tolerance)
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
            positions[i * 3 + axis] = value * scale;
        }
        let x = positions[i * 3];
        let y = positions[i * 3 + 1];
        let z = positions[i * 3 + 2];
        if (x < box.min.x - tolerance || x > box.max.x + tolerance ||
            y < box.min.y - tolerance || y > box.max.y + tolerance ||
            z < box.min.z - tolerance || z > box.max.z + tolerance) {
            throw new Error ('point ' + i.toString () + ' is outside the model, the edges may belong to another part or be in another unit');
        }
    }
    return new PreparedEdgeHighlight (positions, color, width);
}

/**
 * Validates the edges, converts them to the model unit and checks that they lie on the model.
 * Either every edge is prepared or none.
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
    if (!IsValidWidth (params.width)) {
        result.reason = 'width must be a positive number, got ' + JSON.stringify (params.width);
        return { result, prepared : null };
    }
    if (typeof params.frameTolerance !== 'number' || !(params.frameTolerance >= 0.0)) {
        result.reason = 'frameTolerance must be a non-negative number, got ' + JSON.stringify (params.frameTolerance);
        return { result, prepared : null };
    }

    let prepared = [];
    if (edges.length > 0) {
        let box = GetBoundingBox (model);
        if (box === null) {
            result.reason = 'the model is empty';
            return { result, prepared : null };
        }
        let diagonal = Math.hypot (box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
        let tolerance = diagonal * params.frameTolerance;
        let scale = GetUnitScale (params.unit, model.GetUnit ());
        for (let i = 0; i < edges.length; i++) {
            try {
                prepared.push (PrepareEdge (edges[i], params, scale, box, tolerance));
            } catch (error) {
                result.reason = 'edge ' + i.toString () + ': ' + error.message;
                return { result, prepared : null };
            }
        }
    }

    result.ok = true;
    result.edgeCount = prepared.length;
    return { result, prepared };
}
