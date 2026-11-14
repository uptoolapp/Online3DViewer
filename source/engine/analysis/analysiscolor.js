/**
 * Parses a hex color like '#ff0000' or 'ff0000'.
 * @param {string} value The color.
 * @param {string} what Name of the value in the error message.
 * @returns {number[]} Float r, g, b in 0..1.
 */
export function ParseHexColor (value, what)
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
