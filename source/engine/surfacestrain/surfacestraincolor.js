// Colouring of log10 strain. There are two kinds of scale:
// - SurfaceStrainColorScale: continuous and sequential (viridis), never a rainbow. By default the
//   range is fixed across parts, 1 µε to 50 µε, so parts and modes compare on one scale.
// - SurfaceStrainThresholdScale: discrete bands. Every point takes the color of the highest
//   threshold it reaches, and points below every threshold take a neutral color.

export const SurfaceStrainColorRange =
{
    Absolute : 1,
    Relative : 2
};

export const SurfaceStrainAbsoluteLog10Low = -6.0;
export const SurfaceStrainAbsoluteLog10High = Math.log10 (50e-6);

// Viridis, sampled at ten evenly spaced stops, as float RGB.
const ViridisStops = [
    [0.267, 0.005, 0.329],
    [0.283, 0.141, 0.458],
    [0.254, 0.265, 0.530],
    [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558],
    [0.128, 0.567, 0.551],
    [0.135, 0.659, 0.518],
    [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318],
    [0.993, 0.906, 0.144]
];

export const SurfaceStrainMissingColor = [0.6, 0.6, 0.6];

export class SurfaceStrainColorScale
{
    constructor (log10Low, log10High)
    {
        this.log10Low = log10Low;
        this.log10High = log10High;
    }

    /**
     * Creates the color scale for the given range type.
     * @param {SurfaceStrainColorRange} range Range type.
     * @param {object} header Surface strain header, used for the relative range.
     * @returns {SurfaceStrainColorScale}
     */
    static Create (range, header)
    {
        if (range === SurfaceStrainColorRange.Relative) {
            return new SurfaceStrainColorScale (header.strain_log10_low, header.strain_log10_high);
        }
        return new SurfaceStrainColorScale (SurfaceStrainAbsoluteLog10Low, SurfaceStrainAbsoluteLog10High);
    }

    /**
     * Writes the float RGB color of a log10 strain value into target at offset.
     */
    GetColor (log10Strain, target, offset)
    {
        if (Number.isNaN (log10Strain)) {
            target[offset] = SurfaceStrainMissingColor[0];
            target[offset + 1] = SurfaceStrainMissingColor[1];
            target[offset + 2] = SurfaceStrainMissingColor[2];
            return;
        }
        let span = this.log10High - this.log10Low;
        let t = span > 0.0 ? (log10Strain - this.log10Low) / span : 1.0;
        t = Math.min (Math.max (t, 0.0), 1.0);
        let position = t * (ViridisStops.length - 1);
        let index = Math.min (Math.floor (position), ViridisStops.length - 2);
        let fraction = position - index;
        let from = ViridisStops[index];
        let to = ViridisStops[index + 1];
        for (let i = 0; i < 3; i++) {
            target[offset + i] = from[i] + (to[i] - from[i]) * fraction;
        }
    }
}

export const SurfaceStrainMaxThresholdCount = 16;
export const SurfaceStrainDefaultBelowThresholdColor = '#c8c8c8';

function ParseHexColor (value, what)
{
    if (typeof value !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test (value)) {
        throw new Error (what + ' must be a hex color like #ff0000, got ' + JSON.stringify (value));
    }
    let hex = value.charAt (0) === '#' ? value.substring (1) : value;
    return [
        parseInt (hex.substring (0, 2), 16) / 255.0,
        parseInt (hex.substring (2, 4), 16) / 255.0,
        parseInt (hex.substring (4, 6), 16) / 255.0
    ];
}

export class SurfaceStrainThreshold
{
    constructor (color, microstrain)
    {
        // Float RGB in 0..1.
        this.color = color;
        this.microstrain = microstrain;
        this.log10Strain = Math.log10 (microstrain * 1.0e-6);
    }
}

export class SurfaceStrainThresholdScale
{
    /**
     * @param {SurfaceStrainThreshold[]} thresholds Thresholds in any order.
     * @param {number[]} belowColor Float RGB for points below every threshold, or not mapped.
     */
    constructor (thresholds, belowColor)
    {
        // Highest threshold first, so the first one reached takes precedence.
        this.thresholds = thresholds.slice ().sort ((a, b) => b.microstrain - a.microstrain);
        this.belowColor = belowColor;
    }

    /**
     * Creates a threshold scale from host input, and validates it.
     * @param {{color: string, strain: number}[]} thresholds Hex color and threshold strain in
     * microstrain. Any order, the highest threshold reached takes precedence.
     * @param {string} [belowColor] Hex color for points below every threshold.
     * @returns {SurfaceStrainThresholdScale}
     */
    static Create (thresholds, belowColor)
    {
        if (!Array.isArray (thresholds) || thresholds.length === 0) {
            throw new Error ('thresholds must be a non-empty list');
        }
        if (thresholds.length > SurfaceStrainMaxThresholdCount) {
            throw new Error ('at most ' + SurfaceStrainMaxThresholdCount.toString () + ' thresholds are supported');
        }
        let parsed = [];
        let seen = new Set ();
        thresholds.forEach ((threshold, index) => {
            let what = 'threshold ' + (index + 1).toString ();
            if (threshold === null || typeof threshold !== 'object') {
                throw new Error (what + ' must be an object with color and strain');
            }
            let color = ParseHexColor (threshold.color, what + ' color');
            let strain = threshold.strain;
            if (typeof strain !== 'number' || !Number.isFinite (strain) || strain <= 0.0) {
                throw new Error (what + ' strain must be a positive number of microstrain, got ' + JSON.stringify (strain));
            }
            if (seen.has (strain)) {
                throw new Error (what + ' repeats the strain ' + strain.toString ());
            }
            seen.add (strain);
            parsed.push (new SurfaceStrainThreshold (color, strain));
        });
        let below = ParseHexColor (belowColor === undefined || belowColor === null ? SurfaceStrainDefaultBelowThresholdColor : belowColor, 'below threshold color');
        return new SurfaceStrainThresholdScale (parsed, below);
    }

    /**
     * Returns the index of the highest threshold the strain reaches, or -1.
     */
    GetThresholdIndex (log10Strain)
    {
        if (Number.isNaN (log10Strain)) {
            return -1;
        }
        for (let i = 0; i < this.thresholds.length; i++) {
            if (log10Strain >= this.thresholds[i].log10Strain) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Writes the float RGB color of a log10 strain value into target at offset.
     */
    GetColor (log10Strain, target, offset)
    {
        let index = this.GetThresholdIndex (log10Strain);
        let color = index === -1 ? this.belowColor : this.thresholds[index].color;
        target[offset] = color[0];
        target[offset + 1] = color[1];
        target[offset + 2] = color[2];
    }
}

/**
 * Creates the color scale described by the parameters.
 * @param {SurfaceStrainParams} params Parameters, thresholds take precedence over colorRange.
 * @param {object} header Surface strain header, used for the relative range.
 * @returns {SurfaceStrainColorScale|SurfaceStrainThresholdScale}
 */
export function CreateSurfaceStrainColorScale (params, header)
{
    if (Array.isArray (params.thresholds) && params.thresholds.length > 0) {
        return SurfaceStrainThresholdScale.Create (params.thresholds, params.belowThresholdColor);
    }
    return SurfaceStrainColorScale.Create (params.colorRange, header);
}
