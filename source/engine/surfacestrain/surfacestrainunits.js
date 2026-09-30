import { Unit, convertUnit } from '../model/unit.js';

// The surface strain artifact is always in metres, while the viewer's model is in its own unit
// (millimetres for every STEP and IGES, because occt-import-js is asked to tessellate in mm).
// Every length of the artifact is converted to the model unit once, right after decoding, so the
// mapping code never deals with metres.

export const SurfaceStrainUnitCandidates = [
    Unit.Meter,
    Unit.Millimeter,
    Unit.Centimeter,
    Unit.Inch,
    Unit.Foot
];

export function SurfaceStrainUnitToString (unit)
{
    switch (unit) {
        case Unit.Millimeter: return 'mm';
        case Unit.Centimeter: return 'cm';
        case Unit.Meter: return 'm';
        case Unit.Inch: return 'in';
        case Unit.Foot: return 'ft';
    }
    return 'unknown unit';
}

/**
 * Returns the factor that converts metres to the given unit, or null for an unknown unit.
 * @param {Unit} unit Target unit.
 * @returns {number|null}
 */
export function GetMetreToUnitScale (unit)
{
    if (!SurfaceStrainUnitCandidates.includes (unit)) {
        return null;
    }
    return convertUnit ({ value : 1.0, fromUnit : Unit.Meter, toUnit : unit });
}

export class SurfaceStrainGeometry
{
    constructor ()
    {
        this.header = null;
        this.unit = Unit.Unknown;
        this.scale = 1.0;
        this.positions = null;
        this.triangles = null;
        this.log10Strain = null;
        this.driving = null;
        this.bboxMin = null;
        this.bboxSize = null;
        this.meshSize = null;
    }

    NodeCount ()
    {
        return this.log10Strain.length;
    }

    TriangleCount ()
    {
        return this.triangles.length / 3;
    }
}

/**
 * Converts decoded surface strain data from metres to the given unit.
 * @param {SurfaceStrainData} data Decoded data in metres.
 * @param {Unit} unit Target unit, the unit of the viewer's model.
 * @returns {SurfaceStrainGeometry}
 */
export function ConvertSurfaceStrainToUnit (data, unit)
{
    let scale = GetMetreToUnitScale (unit);
    if (scale === null) {
        throw new Error ('can not convert surface strain to an unknown unit');
    }

    let header = data.header;
    let positions = new Float32Array (data.positions.length);
    for (let i = 0; i < positions.length; i++) {
        positions[i] = data.positions[i] * scale;
    }

    let geometry = new SurfaceStrainGeometry ();
    geometry.header = header;
    geometry.unit = unit;
    geometry.scale = scale;
    geometry.positions = positions;
    geometry.triangles = data.triangles;
    geometry.log10Strain = data.log10Strain;
    geometry.driving = data.driving;
    geometry.bboxMin = header.bbox_min_m.map ((value) => value * scale);
    geometry.bboxSize = header.bbox_size_m.map ((value) => value * scale);
    geometry.meshSize = header.mesh_size_m * scale;
    return geometry;
}
