import { ParseHexColor } from '../analysis/analysiscolor.js';
import { CollectFaceGeometry, GetModelFaces } from '../analysis/analysisfaces.js';
import { MatchAnalysisFrame } from '../analysis/analysisframe.js';
import { GetMetreToUnitScale } from '../analysis/analysisunits.js';
import { TriangleGrid, TriangleGridHit } from '../geometry/trianglegrid.js';
import { GetBoundingBox } from '../model/modelutils.js';

// Long reach findings from long_reach.bin, painted on the model's BREP faces. The reference writer
// and reader are freecad/app/long_reach_surface.py. The file carries a coarse mesh of the part
// with the BREP face each triangle belongs to, and every face's findings. The viewer never trusts
// that it numbers faces as the analysis did: each of its faces samples the file's mesh and takes
// the findings of the face most of its samples land on. The faces in a group are collected once,
// ordered by their group's length to diameter, so a limit only chooses how many of them to draw.

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
    // The deep hole flag of each face, the viewer doesn't paint deep holes.
    Take (Uint8Array, faceCount);
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
        this.color = '#a21caf';
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

/**
 * The painted faces of one mesh instance, in model coordinates. The faces are ordered by the
 * length to diameter of their group, highest first, so the faces too long under any limit are the
 * first {@link PreparedLongReach#IndexCount} indices.
 */
export class PreparedLongReach
{
    constructor (meshInstanceId)
    {
        this.meshInstanceId = meshInstanceId;
        // Float32Array of x, y, z.
        this.positions = null;
        // Float32Array of unit normals.
        this.normals = null;
        // Uint32Array, three vertex indices per triangle.
        this.indices = null;
        // Float32Array, the length to diameter of each face's group, descending.
        this.faceLengthToDiameter = null;
        // Uint32Array, the number of indices up to the end of each face.
        this.faceIndexEnd = null;
    }

    /**
     * @param {number} limit Length-to-diameter limit.
     * @returns {number} The number of indices of the faces too long under the limit.
     */
    IndexCount (limit)
    {
        let count = 0;
        for (let i = 0; i < this.faceLengthToDiameter.length && this.faceLengthToDiameter[i] > limit; i++) {
            count = this.faceIndexEnd[i];
        }
        return count;
    }
}

/**
 * Checks the params that choose what to paint.
 * @param {LongReachParams} params Parameters.
 * @returns {{limit: number, show: boolean, color: number[]}} The limit, whether to paint, and the
 * float color.
 */
export function ParseLongReachDisplay (params)
{
    if (typeof params.limit !== 'number' || !Number.isFinite (params.limit) || params.limit <= 0.0) {
        throw new Error ('limit must be a positive number, got ' + JSON.stringify (params.limit));
    }
    return {
        limit : params.limit,
        show : params.showLongReach !== false,
        color : ParseHexColor (params.color, 'color')
    };
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
 * How many of the file's faces are too long under the limit.
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
    return counts;
}

function PrepareMeshInstance (meshInstance, faces)
{
    faces.sort ((a, b) => b.lengthToDiameter - a.lengthToDiameter);
    let mesh = meshInstance.GetMesh ();
    let transformation = meshInstance.GetTransformation ();
    let positions = [];
    let normals = [];
    let indices = [];
    let faceLengthToDiameter = [];
    let faceIndexEnd = [];
    for (let face of faces) {
        let geometry = CollectFaceGeometry (mesh, transformation, face.first, face.last);
        let offset = positions.length / 3;
        for (let i = 0; i < geometry.positions.length; i++) {
            positions.push (geometry.positions[i]);
            normals.push (geometry.normals[i]);
        }
        for (let vertexIndex of geometry.triangles) {
            indices.push (vertexIndex + offset);
        }
        faceLengthToDiameter.push (face.lengthToDiameter);
        faceIndexEnd.push (indices.length);
    }
    let prepared = new PreparedLongReach (meshInstance.GetId ());
    prepared.positions = new Float32Array (positions);
    prepared.normals = new Float32Array (normals);
    prepared.indices = new Uint32Array (indices);
    prepared.faceLengthToDiameter = new Float32Array (faceLengthToDiameter);
    prepared.faceIndexEnd = new Uint32Array (faceIndexEnd);
    return prepared;
}

/**
 * Collects the triangles of every model face that takes its findings from a face in a group, per
 * mesh instance, for {@link Viewer#SetLongReach}. Which of them are painted is chosen later by the
 * limit, without collecting them again.
 * @param {Model} model The viewer's model the mapping was made on.
 * @param {LongReachMapping} mapping Model faces mapped onto the file's faces.
 * @returns {PreparedLongReach[]}
 */
export function PrepareLongReachFaces (model, mapping)
{
    let data = mapping.data;
    let groups = data.header.groups;
    let modelFaces = GetModelFaces (model);
    let facesOfInstances = new Map ();
    for (let i = 0; i < modelFaces.length; i++) {
        let fileFace = mapping.fileFaceOfModelFace[i];
        if (fileFace < 0) {
            continue;
        }
        let group = data.faceGroup[fileFace];
        if (group < 0 || !Number.isFinite (groups[group].length_to_diameter)) {
            continue;
        }
        let face = modelFaces[i];
        if (!facesOfInstances.has (face.meshInstance)) {
            facesOfInstances.set (face.meshInstance, []);
        }
        facesOfInstances.get (face.meshInstance).push ({ first : face.first, last : face.last, lengthToDiameter : groups[group].length_to_diameter });
    }
    let prepared = [];
    for (let [meshInstance, faces] of facesOfInstances) {
        prepared.push (PrepareMeshInstance (meshInstance, faces));
    }
    return prepared;
}

/**
 * Decodes a long_reach.bin, converts it from metres to the model unit, checks that it belongs to
 * the model, maps the model's faces onto its faces, and collects the faces to paint.
 * @param {Model} model The viewer's model.
 * @param {ArrayBuffer} buffer Content of long_reach.bin.
 * @param {LongReachParams} [params] Parameters.
 * @returns {{result: LongReachResult, mapping: LongReachMapping|null, prepared: PreparedLongReach[]|null}}
 * On failure result.ok is false, result.reason says why, and nothing must be shown.
 */
export function PrepareLongReach (model, buffer, params)
{
    if (!params) {
        params = new LongReachParams ();
    }
    let result = new LongReachResult ();
    let Fail = (reason) => {
        result.reason = reason;
        return { result, mapping : null, prepared : null };
    };
    try {
        ParseLongReachDisplay (params);
    } catch (error) {
        return Fail (error.message);
    }
    let data = null;
    try {
        data = DecodeLongReach (buffer);
    } catch (error) {
        return Fail (error.message);
    }
    result.header = data.header;

    let viewerBox = GetBoundingBox (model);
    if (viewerBox === null) {
        return Fail ('the model is empty');
    }
    // The file is in metres, the model in its own unit (mm for STEP), and a wrongly scaled file
    // must never be painted. The header carries the same frame keys as the strain surface's.
    let frame = MatchAnalysisFrame (data.header, viewerBox, model.GetUnit (), params.frameToleranceFactor);
    if (!frame.ok) {
        return Fail (frame.reason);
    }
    result.unit = frame.unit;

    let mapping = MapLongReachToModel (model, data, GetMetreToUnitScale (frame.unit), params);
    if (mapping.sampleCount === 0) {
        return Fail ('the model has no faces to map onto');
    }
    if (mapping.FailedFraction () > params.maxFailedFraction) {
        return Fail (mapping.failedCount.toString () + ' of ' + mapping.sampleCount.toString () + ' samples found no face of the long reach mesh');
    }
    result.ok = true;
    result.counts = CountLongReach (data, params.limit);
    return { result, mapping, prepared : PrepareLongReachFaces (model, mapping) };
}
