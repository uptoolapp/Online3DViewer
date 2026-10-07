// Decoder for surface_strain.bin, see frequency-analysis-surface-contract.md.
// The reference decoder is frequency_analysis/app/surface.py (surface.read).

const SurfaceStrainMagic = 'UPSF';
const SurfaceStrainVersion = 1;
const SurfaceStrainQuantum = 65535;

export class SurfaceStrainData
{
    constructor (header, positions, triangles, log10Strain, driving)
    {
        // Parsed JSON header, unknown keys are kept but never interpreted.
        this.header = header;
        // Node positions, x, y, z per node. Metres straight from the decoder.
        this.positions = positions;
        // Triangle node indices, three per triangle, counter-clockwise seen from outside.
        this.triangles = triangles;
        // log10 of the envelope strain per node, always finite.
        this.log10Strain = log10Strain;
        // 1-based index into header.modes per node.
        this.driving = driving;
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
 * Decodes the content of a surface_strain.bin file.
 * @param {ArrayBuffer} buffer The file content.
 * @returns {SurfaceStrainData} The decoded data, positions are in metres.
 */
export function DecodeSurfaceStrain (buffer)
{
    if (!(buffer instanceof ArrayBuffer)) {
        throw new Error ('surface strain content must be an ArrayBuffer');
    }
    if (buffer.byteLength < 12) {
        throw new Error ('surface strain file is too short');
    }

    let textDecoder = new TextDecoder ();
    let view = new DataView (buffer);
    if (textDecoder.decode (buffer.slice (0, 4)) !== SurfaceStrainMagic) {
        throw new Error ('not a surface strain file');
    }
    let version = view.getUint32 (4, true);
    if (version !== SurfaceStrainVersion) {
        throw new Error ('unsupported surface strain version ' + version.toString ());
    }
    let headerLength = view.getUint32 (8, true);
    if (12 + headerLength > buffer.byteLength) {
        throw new Error ('surface strain header is truncated');
    }
    let header = JSON.parse (textDecoder.decode (buffer.slice (12, 12 + headerLength)));

    let offset = 12 + headerLength;
    // The sections are generally unaligned (the header can have any length), so every section
    // is copied out with slice instead of creating a typed array view at an odd offset.
    function Take (ArrayType, count)
    {
        let byteCount = count * ArrayType.BYTES_PER_ELEMENT;
        if (offset + byteCount > buffer.byteLength) {
            throw new Error ('surface strain file is shorter than its header says');
        }
        let array = new ArrayType (buffer.slice (offset, offset + byteCount));
        offset += byteCount;
        return array;
    }

    let nodeCount = header.node_count;
    let triangleCount = header.triangle_count;
    let positionCodes = Take (Uint16Array, nodeCount * 3);
    let triangles = Take (header.index_bytes === 2 ? Uint16Array : Uint32Array, triangleCount * 3);
    let strainCodes = Take (Uint16Array, nodeCount);
    let driving = Take (Uint8Array, nodeCount);
    if (offset !== buffer.byteLength) {
        throw new Error ('surface strain file length disagrees with its header');
    }

    let bboxMin = header.bbox_min_m;
    let bboxSize = header.bbox_size_m;
    let positions = new Float32Array (nodeCount * 3);
    for (let i = 0; i < nodeCount * 3; i++) {
        let axis = i % 3;
        positions[i] = positionCodes[i] / SurfaceStrainQuantum * bboxSize[axis] + bboxMin[axis];
    }

    let log10Low = header.strain_log10_low;
    let log10Span = header.strain_log10_high - log10Low;
    let log10Strain = new Float32Array (nodeCount);
    for (let i = 0; i < nodeCount; i++) {
        log10Strain[i] = strainCodes[i] / SurfaceStrainQuantum * log10Span + log10Low;
    }

    return new SurfaceStrainData (header, positions, triangles, log10Strain, driving);
}
