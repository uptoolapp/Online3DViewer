export const Unit =
{
    Unknown : 0,
    Millimeter : 1,
    Centimeter : 2,
    Meter : 3,
    Inch : 4,
    Foot : 5
};

const LENGTH_CONVERSIONS = {
    1: 0.001,
    2: 0.01,
    3: 1,
    4: 0.0254,
    5: 0.3048,
};

export function convertUnit(value, fromUnit, toUnit) {
    return (value * LENGTH_CONVERSIONS[fromUnit]) / LENGTH_CONVERSIONS[toUnit];
}
