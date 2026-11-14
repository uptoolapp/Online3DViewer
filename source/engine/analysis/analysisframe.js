import { Unit } from '../model/unit.js';
import { GetMetreToUnitScale, AnalysisUnitCandidates, AnalysisUnitToString } from './analysisunits.js';

// An analysis artifact (surface_strain.bin, long_reach.bin) and the viewer's model must describe
// the same part in the same frame. The artifact is in metres, the model is in its own unit, so the
// artifact's bounding box is converted to the model unit and compared with the model's bounding
// box: sizes and minima must agree to within the artifact's mesh size. Neither side is ever moved
// or re-centred. The header carries bbox_min_m, bbox_size_m and mesh_size_m.

const AxisNames = ['x', 'y', 'z'];

export class AnalysisFrameResult
{
    constructor (ok, unit, reason)
    {
        this.ok = ok;
        this.unit = unit;
        this.reason = reason;
    }
}

function GetBoxArrays (box)
{
    return {
        min : [box.min.x, box.min.y, box.min.z],
        size : [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
    };
}

/**
 * Checks if the artifact's bounding box matches the model's bounding box when the artifact is
 * converted with the given metre to model unit scale.
 * @returns {string|null} null if it matches, the reason otherwise.
 */
export function CheckAnalysisFrameAtScale (header, viewerBox, scale, toleranceFactor)
{
    let viewer = GetBoxArrays (viewerBox);
    let tolerance = header.mesh_size_m * scale * toleranceFactor;
    for (let axis = 0; axis < 3; axis++) {
        let size = header.bbox_size_m[axis] * scale;
        if (Math.abs (viewer.size[axis] - size) > tolerance) {
            return 'bounding box size differs on ' + AxisNames[axis] + ' (model ' + viewer.size[axis].toPrecision (6) + ', artifact ' + size.toPrecision (6) + ')';
        }
    }
    for (let axis = 0; axis < 3; axis++) {
        let min = header.bbox_min_m[axis] * scale;
        if (Math.abs (viewer.min[axis] - min) > tolerance) {
            return 'bounding box position differs on ' + AxisNames[axis] + ' (model ' + viewer.min[axis].toPrecision (6) + ', artifact ' + min.toPrecision (6) + '), the model may have been moved or the artifact belongs to another STEP';
        }
    }
    return null;
}

/**
 * Finds the unit in which the artifact matches the model's frame.
 * @param {object} header Artifact header, lengths are in metres.
 * @param {Box3D} viewerBox Bounding box of the viewer's model in model units.
 * @param {Unit} modelUnit Unit of the viewer's model, may be unknown.
 * @param {number} [toleranceFactor] Allowed difference in artifact mesh sizes.
 * @returns {AnalysisFrameResult}
 */
export function MatchAnalysisFrame (header, viewerBox, modelUnit, toleranceFactor = 2.0)
{
    let modelScale = GetMetreToUnitScale (modelUnit);
    if (modelScale === null) {
        // The model doesn't know its unit, infer it from the bounding box ratio.
        for (let unit of AnalysisUnitCandidates) {
            if (CheckAnalysisFrameAtScale (header, viewerBox, GetMetreToUnitScale (unit), toleranceFactor) === null) {
                return new AnalysisFrameResult (true, unit, null);
            }
        }
        return new AnalysisFrameResult (false, Unit.Unknown, 'the artifact matches the model in none of the supported units');
    }

    let reason = CheckAnalysisFrameAtScale (header, viewerBox, modelScale, toleranceFactor);
    if (reason === null) {
        return new AnalysisFrameResult (true, modelUnit, null);
    }
    for (let unit of AnalysisUnitCandidates) {
        if (unit === modelUnit) {
            continue;
        }
        if (CheckAnalysisFrameAtScale (header, viewerBox, GetMetreToUnitScale (unit), toleranceFactor) === null) {
            reason = 'unit mismatch, the artifact fits the model only if the model were in ' + AnalysisUnitToString (unit) + ', but the model is in ' + AnalysisUnitToString (modelUnit);
            break;
        }
    }
    return new AnalysisFrameResult (false, modelUnit, reason);
}

/**
 * Checks the SHA-256 of the loaded model file against the analysis response's input_sha256.
 * @param {ArrayBuffer} fileContent Content of the model file loaded to the viewer.
 * @param {string} expectedSha256 Hex encoded SHA-256 of the analysed STEP.
 * @returns {Promise<boolean>}
 */
export function IsAnalysisSourceFile (fileContent, expectedSha256)
{
    return crypto.subtle.digest ('SHA-256', fileContent).then ((digest) => {
        let hex = Array.from (new Uint8Array (digest), (byte) => byte.toString (16).padStart (2, '0')).join ('');
        return hex === expectedSha256.toLowerCase ();
    });
}
