// Colouring of log10 strain. The scale is sequential (viridis), never a rainbow. By default the
// range is fixed across parts, 1 µε to 50 µε, so parts and modes compare on one scale.

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
export const SurfaceStrainDimmedColor = [0.85, 0.85, 0.85];

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
