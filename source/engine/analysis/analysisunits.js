import { Unit, convertUnit } from '../model/unit.js';

// The analysis artifacts are always in metres, while the viewer's model is in its own unit
// (millimetres for every STEP and IGES, because occt-import-js is asked to tessellate in mm).

export const AnalysisUnitCandidates = [
    Unit.Meter,
    Unit.Millimeter,
    Unit.Centimeter,
    Unit.Inch,
    Unit.Foot
];

export function AnalysisUnitToString (unit)
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
    if (!AnalysisUnitCandidates.includes (unit)) {
        return null;
    }
    return convertUnit ({ value : 1.0, fromUnit : Unit.Meter, toUnit : unit });
}
