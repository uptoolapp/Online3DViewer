import { GetBoundingBox } from '../model/modelutils.js';
import { CreateSurfaceStrainColorScale, SurfaceStrainColorRange } from './surfacestraincolor.js';
import { DecodeSurfaceStrain } from './surfacestraindecoder.js';
import { MatchSurfaceStrainFrame } from './surfacestrainframe.js';
import { MapSurfaceStrainToModel, SurfaceStrainMappingParams } from './surfacestrainsampler.js';
import { ConvertSurfaceStrainToUnit } from './surfacestrainunits.js';

export class SurfaceStrainParams
{
    constructor ()
    {
        // Absolute (fixed 1-50 µε) or relative (the part's own range, must be labelled as relative).
        this.colorRange = SurfaceStrainColorRange.Absolute;
        // Discrete bands instead of the continuous scale: a list of { color : '#rrggbb', strain : µε }.
        // Every point takes the color of the highest threshold it reaches, in any order. Null or an
        // empty list keeps the continuous scale.
        this.thresholds = null;
        // Hex color of the points below every threshold, used only with thresholds.
        this.belowThresholdColor = null;
        // Allowed bounding box difference between the artifact and the model, in FE mesh sizes.
        this.frameToleranceFactor = 2.0;
        // The mapping fails if more than this fraction of the viewer's vertices find no FE triangle.
        this.maxFailedFraction = 0.005;
        this.mappingParams = new SurfaceStrainMappingParams ();
    }
}

export class SurfaceStrainResult
{
    constructor ()
    {
        this.ok = false;
        this.reason = null;
        // Header records for the mode table and risk summary. Numeric peaks must come from here,
        // not from the painted surface.
        this.header = null;
        this.unit = null;
        this.mapping = null;
        this.colorScale = null;
    }
}

/**
 * Decodes a surface_strain.bin, converts it from metres to the model unit, checks that it
 * belongs to the model, and maps it onto the model's BREP faces.
 * @param {Model} model The viewer's model.
 * @param {ArrayBuffer} buffer Content of surface_strain.bin.
 * @param {SurfaceStrainParams} [params] Parameters.
 * @returns {SurfaceStrainResult} On failure ok is false and reason says why, nothing must be shown.
 */
export function PrepareSurfaceStrain (model, buffer, params)
{
    if (!params) {
        params = new SurfaceStrainParams ();
    }

    let result = new SurfaceStrainResult ();
    let data = null;
    try {
        data = DecodeSurfaceStrain (buffer);
    } catch (error) {
        result.reason = error.message;
        return result;
    }
    result.header = data.header;

    // Validate the colors before the expensive mapping.
    let colorScale = null;
    try {
        colorScale = CreateSurfaceStrainColorScale (params, data.header);
    } catch (error) {
        result.reason = error.message;
        return result;
    }

    let viewerBox = GetBoundingBox (model);
    if (viewerBox === null) {
        result.reason = 'the model is empty';
        return result;
    }

    // The artifact is in metres, the model is in its own unit (mm for STEP). Find and verify the
    // unit before any mapping, a wrongly scaled artifact must never be painted.
    let frame = MatchSurfaceStrainFrame (data.header, viewerBox, model.GetUnit (), params.frameToleranceFactor);
    if (!frame.ok) {
        result.reason = frame.reason;
        return result;
    }
    result.unit = frame.unit;

    let geometry = ConvertSurfaceStrainToUnit (data, frame.unit);
    let mapping = MapSurfaceStrainToModel (model, geometry, params.mappingParams);
    if (mapping.vertexCount === 0) {
        result.reason = 'the model has no triangles to map onto';
        return result;
    }
    if (mapping.FailedFraction () > params.maxFailedFraction) {
        result.reason = mapping.failedCount.toString () + ' of ' + mapping.vertexCount.toString () + ' vertices are farther than ' + mapping.maxDistance.toPrecision (3) + ' from the FE surface';
        return result;
    }

    result.ok = true;
    result.mapping = mapping;
    result.colorScale = colorScale;
    return result;
}
