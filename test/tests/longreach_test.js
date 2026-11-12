import * as assert from 'assert';
import * as OV from '../../source/engine/main.js';

export default function suite ()
{

// A 100 x 20 x 10 mm box from the origin with a BREP face per side, two triangles each: bottom,
// front (y = 0), right (x = 100), back, left, top.
function CreateBoxMesh ()
{
    let mesh = OV.GenerateCuboid (null, 100.0, 20.0, 10.0);
    let brepFaces = [];
    for (let i = 0; i < 6; i++) {
        brepFaces.push ({ first : i * 2, last : i * 2 + 1 });
    }
    mesh.SetBrepFaces (brepFaces);
    return mesh;
}

function CreateBoxModel ()
{
    let model = new OV.Model ();
    model.SetUnit (OV.Unit.Millimeter);
    let meshIndex = model.AddMesh (CreateBoxMesh ());
    model.GetRootNode ().AddMeshIndex (meshIndex);
    return model;
}

// The analysis numbers the box's faces its own way: the file's face of each model face.
const FileFaceOfModelFace = [3, 5, 0, 4, 1, 2];
const Top = 5;
const Right = 2;

// Encodes long_reach.bin as freecad/app/long_reach_surface.py writes it.
function EncodeLongReach (options)
{
    let positions = options.positionsM;
    let nodeCount = positions.length / 3;
    let triangleCount = options.triangles.length / 3;
    let faceCount = options.faceCount;
    let low = [Infinity, Infinity, Infinity];
    let high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
        low[i % 3] = Math.min (low[i % 3], positions[i]);
        high[i % 3] = Math.max (high[i % 3], positions[i]);
    }
    let size = high.map ((value, axis) => Math.max (value - low[axis], 1e-12));
    let header = {
        length_unit : 'm',
        mesh_size_m : options.meshSizeM,
        bbox_min_m : low,
        bbox_size_m : size,
        node_count : nodeCount,
        triangle_count : triangleCount,
        face_count : faceCount,
        index_bytes : 4,
        groups : options.groups,
        holes : options.holes || []
    };
    let headerBytes = new TextEncoder ().encode (JSON.stringify (header));
    let codes = new Uint16Array (nodeCount * 3);
    for (let i = 0; i < positions.length; i++) {
        codes[i] = Math.round ((positions[i] - low[i % 3]) / size[i % 3] * 65535);
    }
    let sections = [
        codes,
        new Uint32Array (options.triangles),
        new Uint32Array (options.triangleFace),
        new Uint8Array (options.faceAccess),
        new Int32Array (options.faceGroup),
        new Float32Array (options.faceLengthToDiameter),
        new Float32Array (faceCount).fill (NaN),
        new Float32Array (faceCount).fill (NaN),
        new Uint8Array (options.faceDeepHole)
    ];
    let length = 12 + headerBytes.length + sections.reduce ((sum, section) => sum + section.byteLength, 0);
    let bytes = new Uint8Array (length);
    let view = new DataView (bytes.buffer);
    bytes.set (new TextEncoder ().encode ('UPLR'), 0);
    view.setUint32 (4, 1, true);
    view.setUint32 (8, headerBytes.length, true);
    bytes.set (headerBytes, 12);
    let offset = 12 + headerBytes.length;
    for (let section of sections) {
        bytes.set (new Uint8Array (section.buffer, section.byteOffset, section.byteLength), offset);
        offset += section.byteLength;
    }
    return bytes.buffer;
}

// The box as the analysis sees it, in metres: its top in a group too long above 5 diameters, its
// right side in a deep hole, which the viewer doesn't paint. `shift` moves the file's box, `options` overrides the findings.
function BoxFile (options = {}, shift = 0.0)
{
    let mesh = CreateBoxMesh ();
    let positionsM = [];
    for (let i = 0; i < mesh.VertexCount (); i++) {
        let vertex = mesh.GetVertex (i);
        positionsM.push ((vertex.x + shift) / 1000.0, vertex.y / 1000.0, vertex.z / 1000.0);
    }
    let triangles = [];
    let triangleFace = [];
    for (let i = 0; i < mesh.TriangleCount (); i++) {
        let triangle = mesh.GetTriangle (i);
        triangles.push (triangle.v0, triangle.v1, triangle.v2);
        triangleFace.push (FileFaceOfModelFace[Math.floor (i / 2)]);
    }
    let faceGroup = new Array (6).fill (-1);
    faceGroup[FileFaceOfModelFace[Top]] = 0;
    let faceDeepHole = new Array (6).fill (0);
    faceDeepHole[FileFaceOfModelFace[Right]] = 1;
    let faceAccess = new Array (6).fill (OV.LongReachAccess.OnHull);
    faceAccess[FileFaceOfModelFace[Top]] = OV.LongReachAccess.EndMilling;
    faceAccess[FileFaceOfModelFace[Right]] = OV.LongReachAccess.Drilled;
    return EncodeLongReach (Object.assign ({
        positionsM : positionsM,
        triangles : triangles,
        triangleFace : triangleFace,
        faceCount : 6,
        meshSizeM : 0.0001,
        groups : [{ mode : 'end', face_count : 1, length_to_diameter : 5.0, max_diameter_mm : 4.0 }],
        holes : [{ face_indices : [FileFaceOfModelFace[Right]], diameter_mm : 2.0, depth_mm : 40.0, deep : true }],
        faceAccess : faceAccess,
        faceGroup : faceGroup,
        faceLengthToDiameter : new Array (6).fill (NaN),
        faceDeepHole : faceDeepHole
    }, options));
}

function Params (overrides = {})
{
    return Object.assign (new OV.LongReachParams (), overrides);
}

function Prepare (buffer, params)
{
    return OV.PrepareLongReach (CreateBoxModel (), buffer, params || Params ());
}

// The x of every vertex the first `count` indices draw.
function DrawnX (prepared, count)
{
    let values = new Set ();
    for (let i = 0; i < count; i++) {
        values.add (prepared.positions[prepared.indices[i] * 3]);
    }
    return Array.from (values).sort ((a, b) => a - b);
}

describe ('Long Reach', function () {
    it ('Decodes what freecad encodes', function () {
        let data = OV.DecodeLongReach (BoxFile ());
        assert.deepStrictEqual (
            [data.header.face_count, data.triangles.length / 3, data.FaceCount (), data.faceGroup[FileFaceOfModelFace[Top]]],
            [6, 12, 6, 0]
        );
    });

    it ('Refuses a file that is not long reach', function () {
        assert.throws (() => OV.DecodeLongReach (new TextEncoder ().encode ('UPSF' + '\0'.repeat (20)).buffer), /not a long reach file/);
    });

    it ('Refuses a file shorter than its header says', function () {
        assert.throws (() => OV.DecodeLongReach (BoxFile ().slice (0, -1)), /shorter than its header says/);
    });

    it ('Maps each model face onto the file face under it, whatever the file numbers it', function () {
        let prepared = Prepare (BoxFile ());
        assert.deepStrictEqual (Array.from (prepared.mapping.fileFaceOfModelFace), FileFaceOfModelFace);
    });

    it ('Collects the faces of groups, not of deep holes', function () {
        let prepared = Prepare (BoxFile ()).prepared;
        assert.deepStrictEqual (
            [prepared.length, prepared[0].indices.length, Array.from (prepared[0].faceLengthToDiameter)],
            [1, 6, [5]]
        );
    });

    it ('Draws the faces of a group too long under the limit', function () {
        let instance = Prepare (BoxFile ()).prepared[0];
        assert.deepStrictEqual ([instance.IndexCount (3.0), instance.IndexCount (5.0), instance.IndexCount (6.0)], [6, 0, 0]);
    });

    it ('Orders the faces by length to diameter, so a limit draws a prefix', function () {
        let faceGroup = new Array (6).fill (-1);
        faceGroup[FileFaceOfModelFace[Top]] = 0;
        faceGroup[FileFaceOfModelFace[Right]] = 1;
        let instance = Prepare (BoxFile ({
            groups : [{ face_count : 1, length_to_diameter : 5.0 }, { face_count : 1, length_to_diameter : 8.0 }],
            faceGroup : faceGroup
        })).prepared[0];
        // The right side at x = 100 first, then the top too.
        assert.deepStrictEqual (
            [DrawnX (instance, instance.IndexCount (6.0)), DrawnX (instance, instance.IndexCount (3.0))],
            [[100], [0, 100]]
        );
    });

    it ('Counts the faces the file says are too long', function () {
        let counts = Prepare (BoxFile ({ groups : [{ face_count : 4, length_to_diameter : 5.0 }] })).result.counts;
        assert.deepStrictEqual (counts, Object.assign (new OV.LongReachCounts (), { tooLongFaces : 4, tooLongGroups : 1 }));
    });

    it ('Refuses a file of a part in another place', function () {
        assert.match (Prepare (BoxFile ({}, 5.0)).result.reason, /bounding box position differs/);
    });

    it ('Refuses a limit that is not a positive number', function () {
        assert.match (Prepare (BoxFile (), Params ({ limit : 0 })).result.reason, /limit must be a positive number/);
    });

    it ('Refuses a color that is not hex', function () {
        assert.match (Prepare (BoxFile (), Params ({ color : 'violet' })).result.reason, /color must be a hex color/);
    });
});

describe ('Long Reach Overlays', function () {
    function CreateFakeViewer ()
    {
        return {
            shown : [],
            displays : [],
            longReach : null,
            SetLongReach (prepared, limit, show, color) {
                this.longReach = prepared;
                this.shown.push (prepared);
                this.displays.push ([limit, show, color]);
            },
            SetLongReachDisplay (limit, show, color) {
                this.displays.push ([limit, show, color]);
            },
            HasLongReach () {
                return this.longReach !== null;
            },
            ClearLongReach () {
                this.longReach = null;
            }
        };
    }

    function CreateOverlays ()
    {
        let viewer = CreateFakeViewer ();
        let overlays = new OV.ViewerOverlays (viewer);
        overlays.SetModel (CreateBoxModel ());
        return { viewer, overlays };
    }

    const Magenta = [0xa2 / 255, 0x1c / 255, 0xaf / 255];

    it ('Paints the findings it maps', async function () {
        let { viewer, overlays } = CreateOverlays ();
        let result = await overlays.ShowLongReach (BoxFile (), Params ());
        assert.deepStrictEqual ([result.ok, viewer.shown.length, viewer.displays, overlays.HasLongReach ()], [true, 1, [[3.0, true, Magenta]], true]);
    });

    it ('Repaints under new params without collecting the faces again', async function () {
        let { viewer, overlays } = CreateOverlays ();
        await overlays.ShowLongReach (BoxFile (), Params ());
        let result = overlays.SetLongReachParams (Params ({ limit : 6.0, showLongReach : false }));
        assert.deepStrictEqual (
            [result.counts.tooLongFaces, viewer.shown.length, viewer.displays[1]],
            [0, 1, [6.0, false, Magenta]]
        );
    });

    it ('Keeps the paint when new params are refused', async function () {
        let { viewer, overlays } = CreateOverlays ();
        await overlays.ShowLongReach (BoxFile (), Params ());
        let result = overlays.SetLongReachParams (Params ({ limit : -1 }));
        assert.deepStrictEqual ([result.ok, viewer.displays.length], [false, 1]);
    });

    it ('Refuses new params when nothing is shown', function () {
        let { overlays } = CreateOverlays ();
        assert.strictEqual (overlays.SetLongReachParams (Params ()).reason, 'no long reach is shown');
    });

    it ('Doesn\'t paint after the model changed', async function () {
        let { viewer, overlays } = CreateOverlays ();
        let showing = overlays.ShowLongReach (BoxFile (), Params ());
        overlays.SetModel (CreateBoxModel ());
        let result = await showing;
        assert.deepStrictEqual ([result.ok, viewer.shown.length], [false, 0]);
    });

    it ('Doesn\'t paint after it was cleared', async function () {
        let { viewer, overlays } = CreateOverlays ();
        let showing = overlays.ShowLongReach (BoxFile (), Params ());
        overlays.ClearLongReach ();
        let result = await showing;
        assert.deepStrictEqual ([result.reason, viewer.shown.length], ['the model changed or the long reach was cleared before it was shown', 0]);
    });

    it ('Clears what it painted', async function () {
        let { overlays } = CreateOverlays ();
        await overlays.ShowLongReach (BoxFile (), Params ());
        overlays.ClearLongReach ();
        assert.deepStrictEqual ([overlays.HasLongReach (), overlays.SetLongReachParams (Params ()).ok], [false, false]);
    });

    it ('Fails without a model', async function () {
        let overlays = new OV.ViewerOverlays (CreateFakeViewer ());
        let result = await overlays.ShowLongReach (BoxFile (), Params ());
        assert.strictEqual (result.reason, 'no model is loaded');
    });
});

}
