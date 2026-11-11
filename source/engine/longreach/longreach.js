import { GetBoundingBox } from '../model/modelutils.js';
import { TriangleGrid, TriangleGridHit } from '../geometry/trianglegrid.js';
import { FaceHighlight, GetModelFaces, PrepareFaceHighlights } from '../facehighlight/facehighlight.js';
import { ParseHexColor } from '../surfacestrain/surfacestraincolor.js';
import { MatchSurfaceStrainFrame } from '../surfacestrain/surfacestrainframe.js';
import { CollectFaceGeometry } from '../surfacestrain/surfacestrainsampler.js';
import { GetMetreToUnitScale } from '../surfacestrain/surfacestrainunits.js';

// Long reach findings from long_reach.bin, painted on the model's BREP faces. The reference writer
// and reader are freecad/app/long_reach_surface.py. The file carries a coarse mesh of the part
// with the BREP face each triangle belongs to, and every face's findings. The viewer never trusts
// that it numbers faces as the analysis did: each of its faces samples the file's mesh and takes
// the findings of the face most of its samples land on. A length-to-diameter limit then only
// chooses which faces to paint, so moving it never maps again.

const LongReachMagic = 'UPLR';
const LongReachVersion = 1;
const LongReachQuantum = 65535;

// How a face is cut, one byte per face in the file.
export const LongReachAccess =
{
    OnHull : 0,
    EndMilling : 1,
    FaceMilling : 2,
    Both : 3,
    Neither : 4,
    Drilled : 5,
    Threaded : 6,
    Chamfered : 7
};

export class LongReachData
{
    constructor ()
    {
        // Parsed JSON header, unknown keys are kept but never interpreted.
        this.header = null;
        // x, y, z per node, in metres straight from the decoder.
        this.positions = null;
        // Three node indices per triangle.
        this.triangles = null;
        // The BREP face of each triangle, an index into the face arrays.
        this.triangleFace = null;
        // Per face of the analysed STEP.
        this.faceAccess = null;
        // Index into header.groups, -1 for a face in no group.
        this.faceGroup = null;
        this.faceLengthToDiameter = null;
        this.faceMaxDiameter = null;
        this.faceReach = null;
        this.faceDeepHole = null;
    }

    FaceCount ()
    {
        return this.faceAccess.length;
    }
}

/**
 * Decodes the content of a long_reach.bin file.
 * @param {ArrayBuffer} buffer The file content.
 * @returns {LongReachData} The decoded data, positions are in metres.
 */
export function DecodeLongReach (buffer)
{
    if (!(buffer instanceof ArrayBuffer)) {
        throw new Error ('long reach content must be an ArrayBuffer');
    }
    if (buffer.byteLength < 12) {
        throw new Error ('long reach file is too short');
    }
    let textDecoder = new TextDecoder ();
    let view = new DataView (buffer);
    if (textDecoder.decode (buffer.slice (0, 4)) !== LongReachMagic) {
        throw new Error ('not a long reach file');
    }
    let version = view.getUint32 (4, true);
    if (version !== LongReachVersion) {
        throw new Error ('unsupported long reach version ' + version.toString ());
    }
    let headerLength = view.getUint32 (8, true);
    if (12 + headerLength > buffer.byteLength) {
        throw new Error ('long reach header is truncated');
    }
    let header = JSON.parse (textDecoder.decode (buffer.slice (12, 12 + headerLength)));

    let offset = 12 + headerLength;
    // The sections are unaligned (the header can have any length), so each is copied out.
    function Take (ArrayType, count)
    {
        let byteCount = count * ArrayType.BYTES_PER_ELEMENT;
        if (offset + byteCount > buffer.byteLength) {
            throw new Error ('long reach file is shorter than its header says');
        }
        let array = new ArrayType (buffer.slice (offset, offset + byteCount));
        offset += byteCount;
        return array;
    }

    let nodeCount = header.node_count;
    let triangleCount = header.triangle_count;
    let faceCount = header.face_count;
    let data = new LongReachData ();
    data.header = header;
    let codes = Take (Uint16Array, nodeCount * 3);
    data.positions = new Float32Array (nodeCount * 3);
    for (let i = 0; i < codes.length; i++) {
        let axis = i % 3;
        data.positions[i] = codes[i] / LongReachQuantum * header.bbox_size_m[axis] + header.bbox_min_m[axis];
    }
    data.triangles = Take (header.index_bytes === 2 ? Uint16Array : Uint32Array, triangleCount * 3);
    data.triangleFace = Take (Uint32Array, triangleCount);
    data.faceAccess = Take (Uint8Array, faceCount);
    data.faceGroup = Take (Int32Array, faceCount);
    data.faceLengthToDiameter = Take (Float32Array, faceCount);
    data.faceMaxDiameter = Take (Float32Array, faceCount);
    data.faceReach = Take (Float32Array, faceCount);
    data.faceDeepHole = Take (Uint8Array, faceCount);
    if (offset !== buffer.byteLength) {
        throw new Error ('long reach file is longer than its header says');
    }
    for (let face of data.triangleFace) {
        if (face >= faceCount) {
            throw new Error ('a long reach triangle names a face the file does not carry');
        }
    }
    return data;
}

export class LongReachParams
{
    constructor ()
    {
        // A group of faces is too long when the fewest diameters of reach its one tool needs are
        // above this.
        this.limit = 3.0;
        this.showLongReach = true;
        this.showDeepHoles = true;
        this.longReachColor = '#7c3aed';
        this.deepHoleColor = '#2563eb';
        // Allowed bounding box difference between the file and the model, in display mesh sizes.
        this.frameToleranceFactor = 2.0;
        // A sample farther than this many display mesh sizes from the file's mesh finds nothing.
        this.maxDistanceFactor = 2.0;
        // The mapping fails if more than this fraction of the samples find nothing.
        this.maxFailedFraction = 0.02;
    }
}

export class LongReachCounts
{
    constructor ()
    {
        // Faces of the analysed STEP, as the analysis counts them.
        this.tooLongFaces = 0;
        this.tooLongGroups = 0;
        this.deepHoleFaces = 0;
    }
}

export class LongReachResult
{
    constructor ()
    {
        this.ok = false;
        this.reason = null;
        this.header = null;
        this.unit = null;
        this.counts = null;
    }
}

/**
 * The model's faces mapped onto the file's faces.
 */
export class LongReachMapping
{
    constructor (data, modelFaceCount)
    {
        this.data = data;
        // The file's face each model face takes its findings from, -1 for none.
        this.fileFaceOfModelFace = new Int32Array (modelFaceCount).fill (-1);
        this.sampleCount = 0;
        this.failedCount = 0;
    }

    FailedFraction ()
    {
        return this.sampleCount > 0 ? this.failedCount / this.sampleCount : 0.0;
    }
}

function ValidateParams (params)
{
    if (typeof params.limit !== 'number' || !Number.isFinite (params.limit) || params.limit <= 0.0) {
        throw new Error ('limit must be a positive number, got ' + JSON.stringify (params.limit));
    }
    ParseHexColor (params.longReachColor, 'longReachColor');
    ParseHexColor (params.deepHoleColor, 'deepHoleColor');
}

function CreateGrid (data, scale)
{
    let positions = new Float32Array (data.positions.length);
    for (let i = 0; i < positions.length; i++) {
        positions[i] = data.positions[i] * scale;
    }
    let header = data.header;
    let bboxMin = header.bbox_min_m.map ((value) => value * scale);
    let bboxSize = header.bbox_size_m.map ((value) => value * scale);
    let meshSize = header.mesh_size_m * scale;
    let largestSize = Math.max (bboxSize[0], bboxSize[1], bboxSize[2]);
    // Keep the grid resolution sane even if the mesh size is tiny compared to the part.
    let cellSize = Math.max (meshSize > 0.0 ? meshSize : largestSize / 100.0, largestSize / 1024.0, 1e-9);
    return { grid : new TriangleGrid (positions, data.triangles, bboxMin, bboxSize, cellSize, true), meshSize : meshSize };
}

// Points inside each triangle of the face vote for the file's face their closest point lies on:
// its centre, and halfway from the centre to each corner. A corner lies on the face's border, as
// close to its neighbours as to itself, so corners never vote.
function MapFace (grid, data, geometry, maxDistance, hit, mapping)
{
    let votes = new Map ();
    function Vote (point, normal)
    {
        mapping.sampleCount += 1;
        if (!grid.FindClosest (point[0], point[1], point[2], normal[0], normal[1], normal[2], maxDistance, hit)) {
            mapping.failedCount += 1;
            return;
        }
        let face = data.triangleFace[hit.triangle];
        votes.set (face, (votes.get (face) || 0) + 1);
    }
    let positions = geometry.positions;
    let normals = geometry.normals;
    let triangles = geometry.triangles;
    for (let i = 0; i < triangles.length; i += 3) {
        let corners = [0, 1, 2].map ((corner) => triangles[i + corner] * 3);
        let centre = [0, 1, 2].map ((axis) => corners.reduce ((sum, c) => sum + positions[c + axis], 0.0) / 3.0);
        let normal = [0, 1, 2].map ((axis) => corners.reduce ((sum, c) => sum + normals[c + axis], 0.0));
        let length = Math.hypot (normal[0], normal[1], normal[2]);
        if (length > 0.0) {
            normal = normal.map ((value) => value / length);
        }
        Vote (centre, normal);
        for (let c of corners) {
            Vote ([0, 1, 2].map ((axis) => (centre[axis] + positions[c + axis]) / 2.0), normal);
        }
    }
    let best = -1;
    let bestVotes = 0;
    for (let [face, count] of votes) {
        if (count > bestVotes) {
            best = face;
            bestVotes = count;
        }
    }
    return best;
}

/**
 * Maps the model's BREP faces onto the faces of a decoded long_reach.bin, in the model's unit.
 * @param {Model} model The viewer's model.
 * @param {LongReachData} data Decoded file.
 * @param {number} scale Metre to model unit scale.
 * @param {LongReachParams} params Parameters.
 * @returns {LongReachMapping}
 */
export function MapLongReachToModel (model, data, scale, params)
{
    let { grid, meshSize } = CreateGrid (data, scale);
    let maxDistance = params.maxDistanceFactor * meshSize;
    let hit = new TriangleGridHit ();
    let modelFaces = GetModelFaces (model);
    let mapping = new LongReachMapping (data, modelFaces.length);
    for (let i = 0; i < modelFaces.length; i++) {
        let face = modelFaces[i];
        let mesh = face.meshInstance.GetMesh ();
        if (face.first > face.last || face.last >= mesh.TriangleCount ()) {
            continue;
        }
        let geometry = CollectFaceGeometry (mesh, face.meshInstance.GetTransformation (), face.first, face.last);
        mapping.fileFaceOfModelFace[i] = MapFace (grid, data, geometry, maxDistance, hit, mapping);
    }
    return mapping;
}

/**
 * How many of the file's faces are too long under the limit, and in deep holes.
 * @param {LongReachData} data Decoded file.
 * @param {number} limit Length-to-diameter limit.
 * @returns {LongReachCounts}
 */
export function CountLongReach (data, limit)
{
    let counts = new LongReachCounts ();
    for (let group of data.header.groups) {
        if (group.length_to_diameter > limit) {
            counts.tooLongFaces += group.face_count;
            counts.tooLongGroups += 1;
        }
    }
    for (let deep of data.faceDeepHole) {
        counts.deepHoleFaces += deep ? 1 : 0;
    }
    return counts;
}

/**
 * The face highlights that paint the mapping under the params: every face of a too-long group in
 * one color, the faces of deep holes in another.
 * @param {LongReachMapping} mapping Model faces mapped onto the file's faces.
 * @param {LongReachParams} params Parameters.
 * @returns {FaceHighlight[]}
 */
export function LongReachHighlights (mapping, params)
{
    let data = mapping.data;
    let groups = data.header.groups;
    let tooLong = [];
    let deep = [];
    for (let modelFace = 0; modelFace < mapping.fileFaceOfModelFace.length; modelFace++) {
        let fileFace = mapping.fileFaceOfModelFace[modelFace];
        if (fileFace < 0) {
            continue;
        }
        if (params.showDeepHoles && data.faceDeepHole[fileFace]) {
            deep.push (modelFace);
            continue;
        }
        let group = data.faceGroup[fileFace];
        if (params.showLongReach && group >= 0 && groups[group].length_to_diameter > params.limit) {
            tooLong.push (modelFace);
        }
    }
    let highlights = [];
    if (tooLong.length > 0) {
        highlights.push (new FaceHighlight (tooLong, params.longReachColor));
    }
    if (deep.length > 0) {
        highlights.push (new FaceHighlight (deep, params.deepHoleColor));
    }
    return highlights;
}

/**
 * Decodes a long_reach.bin, converts it from metres to the model unit, checks that it belongs to
 * the model, and maps the model's faces onto its faces.
 * @param {Model} model The viewer's model.
 * @param {ArrayBuffer} buffer Content of long_reach.bin.
 * @param {LongReachParams} [params] Parameters.
 * @returns {{result: LongReachResult, mapping: LongReachMapping|null}} On failure result.ok is
 * false, result.reason says why, and nothing must be shown.
 */
export function PrepareLongReach (model, buffer, params)
{
    if (!params) {
        params = new LongReachParams ();
    }
    let result = new LongReachResult ();
    try {
        ValidateParams (params);
    } catch (error) {
        result.reason = error.message;
        return { result, mapping : null };
    }
    let data = null;
    try {
        data = DecodeLongReach (buffer);
    } catch (error) {
        result.reason = error.message;
        return { result, mapping : null };
    }
    result.header = data.header;

    let viewerBox = GetBoundingBox (model);
    if (viewerBox === null) {
        result.reason = 'the model is empty';
        return { result, mapping : null };
    }
    // The file is in metres, the model in its own unit (mm for STEP), and a wrongly scaled file
    // must never be painted. The header carries the same frame keys as the strain surface's.
    let frame = MatchSurfaceStrainFrame (data.header, viewerBox, model.GetUnit (), params.frameToleranceFactor);
    if (!frame.ok) {
        result.reason = frame.reason;
        return { result, mapping : null };
    }
    result.unit = frame.unit;

    let mapping = MapLongReachToModel (model, data, GetMetreToUnitScale (frame.unit), params);
    if (mapping.sampleCount === 0) {
        result.reason = 'the model has no faces to map onto';
        return { result, mapping : null };
    }
    if (mapping.FailedFraction () > params.maxFailedFraction) {
        result.reason = mapping.failedCount.toString () + ' of ' + mapping.sampleCount.toString () + ' samples found no face of the long reach mesh';
        return { result, mapping : null };
    }
    result.ok = true;
    result.counts = CountLongReach (data, params.limit);
    return { result, mapping };
}

/**
 * Prepares the face highlights of a mapping under the params, for {@link Viewer#SetFaceHighlights}.
 * @param {Model} model The viewer's model the mapping was made on.
 * @param {LongReachMapping} mapping Model faces mapped onto the file's faces.
 * @param {LongReachParams} params Parameters.
 * @returns {{result: LongReachResult, prepared: object[]|null}} The prepared face highlights.
 */
export function PrepareLongReachHighlights (model, mapping, params)
{
    let result = new LongReachResult ();
    try {
        ValidateParams (params);
    } catch (error) {
        result.reason = error.message;
        return { result, prepared : null };
    }
    let prepared = PrepareFaceHighlights (model, LongReachHighlights (mapping, params));
    if (!prepared.result.ok) {
        result.reason = prepared.result.reason;
        return { result, prepared : null };
    }
    result.ok = true;
    result.header = mapping.data.header;
    result.counts = CountLongReach (mapping.data, params.limit);
    return { result, prepared : prepared.prepared };
}
