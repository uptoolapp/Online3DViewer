import * as assert from 'assert';
import * as OV from '../../source/engine/main.js';

export default function suite ()
{

// Encodes a surface_strain.bin the same way frequency_analysis/app/surface.py does.
function EncodeSurfaceStrain (params)
{
    let positions = params.positions;
    let nodeCount = positions.length / 3;
    let triangleCount = params.triangles.length / 3;
    let indexBytes = params.indexBytes || 2;

    let bboxMin = [Infinity, Infinity, Infinity];
    let bboxMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nodeCount * 3; i++) {
        bboxMin[i % 3] = Math.min (bboxMin[i % 3], positions[i]);
        bboxMax[i % 3] = Math.max (bboxMax[i % 3], positions[i]);
    }
    let bboxSize = [0, 1, 2].map ((axis) => bboxMax[axis] - bboxMin[axis]);
    let log10Low = Math.min (...params.log10Strain);
    let log10High = Math.max (...params.log10Strain);

    let header = {
        element_type : 'C3D10',
        length_unit : 'm',
        mesh_size_m : params.meshSizeM,
        reference_acceleration_m_s2 : 98.0665,
        modes : [
            { frequency_hz : 412.7, peak_strain : 1.2e-5 },
            { frequency_hz : 988.1, peak_strain : 3.4e-6 }
        ],
        stats : { max : 1.2e-5, p999 : 8.8e-6 },
        bbox_min_m : params.bboxMinM || bboxMin,
        bbox_size_m : params.bboxSizeM || bboxSize,
        node_count : nodeCount,
        triangle_count : triangleCount,
        index_bytes : indexBytes,
        strain_log10_low : log10Low,
        strain_log10_high : log10High,
        some_future_key : { ignored : true }
    };
    let headerText = JSON.stringify (header);
    let headerBytes = new TextEncoder ().encode (headerText);
    if (params.oddHeader && headerBytes.length % 2 === 0) {
        headerBytes = new TextEncoder ().encode (headerText + ' ');
    }

    let byteLength = 12 + headerBytes.length + nodeCount * 6 + triangleCount * 3 * indexBytes + nodeCount * 2 + nodeCount + (params.extraBytes || 0);
    let buffer = new ArrayBuffer (byteLength);
    let view = new DataView (buffer);
    let bytes = new Uint8Array (buffer);
    bytes.set (new TextEncoder ().encode ('UPSF'), 0);
    view.setUint32 (4, params.version || 1, true);
    view.setUint32 (8, headerBytes.length, true);
    bytes.set (headerBytes, 12);
    let offset = 12 + headerBytes.length;
    for (let i = 0; i < nodeCount * 3; i++) {
        let axis = i % 3;
        let code = bboxSize[axis] > 0.0 ? Math.round ((positions[i] - bboxMin[axis]) / bboxSize[axis] * 65535) : 0;
        view.setUint16 (offset, code, true);
        offset += 2;
    }
    for (let i = 0; i < triangleCount * 3; i++) {
        if (indexBytes === 2) {
            view.setUint16 (offset, params.triangles[i], true);
        } else {
            view.setUint32 (offset, params.triangles[i], true);
        }
        offset += indexBytes;
    }
    let span = log10High - log10Low;
    for (let i = 0; i < nodeCount; i++) {
        let code = span > 0.0 ? Math.round ((params.log10Strain[i] - log10Low) / span * 65535) : 0;
        view.setUint16 (offset, code, true);
        offset += 2;
    }
    for (let i = 0; i < nodeCount; i++) {
        view.setUint8 (offset, params.driving[i]);
        offset += 1;
    }
    return buffer;
}

// Triangulates the surface of an axis aligned box with the given number of cells per face side,
// counter-clockwise seen from outside. Calls onFace with positions, outward normal and triangles.
function TriangulateBox (min, size, cells, onFace)
{
    for (let axis = 0; axis < 3; axis++) {
        for (let side = 0; side < 2; side++) {
            let u = (axis + 1) % 3;
            let v = (axis + 2) % 3;
            let outward = [0, 0, 0];
            outward[axis] = side === 0 ? -1 : 1;
            let positions = [];
            for (let j = 0; j <= cells; j++) {
                for (let i = 0; i <= cells; i++) {
                    let point = [0, 0, 0];
                    point[axis] = min[axis] + side * size[axis];
                    point[u] = min[u] + size[u] * i / cells;
                    point[v] = min[v] + size[v] * j / cells;
                    positions.push (...point);
                }
            }
            let triangles = [];
            let row = cells + 1;
            // (u, v, axis) is right handed, so this winding points along +axis.
            for (let j = 0; j < cells; j++) {
                for (let i = 0; i < cells; i++) {
                    let a = j * row + i;
                    let b = a + 1;
                    let c = a + row + 1;
                    let d = a + row;
                    if (side === 1) {
                        triangles.push (a, b, c, a, c, d);
                    } else {
                        triangles.push (a, c, b, a, d, c);
                    }
                }
            }
            onFace (positions, outward, triangles);
        }
    }
}

function CreateFeBox (minM, sizeM, cells, strainFunction, modeFunction)
{
    let positions = [];
    let triangles = [];
    TriangulateBox (minM, sizeM, cells, (facePositions, outward, faceTriangles) => {
        let offset = positions.length / 3;
        positions.push (...facePositions);
        triangles.push (...faceTriangles.map ((index) => index + offset));
    });
    let log10Strain = [];
    let driving = [];
    for (let i = 0; i < positions.length / 3; i++) {
        let point = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        log10Strain.push (strainFunction (point));
        driving.push (modeFunction (point));
    }
    return { positions, triangles, log10Strain, driving };
}

// A viewer model like occt-import-js creates: one mesh, one BREP face per box side, flat normals,
// and only two triangles per side.
function CreateViewerBox (minMm, sizeMm, unit)
{
    let model = new OV.Model ();
    model.SetUnit (unit);
    let mesh = new OV.Mesh ();
    let brepFaces = [];
    TriangulateBox (minMm, sizeMm, 1, (positions, outward, triangles) => {
        let vertexOffset = mesh.VertexCount ();
        for (let i = 0; i < positions.length / 3; i++) {
            mesh.AddVertex (new OV.Coord3D (positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
            mesh.AddNormal (new OV.Coord3D (outward[0], outward[1], outward[2]));
        }
        let first = mesh.TriangleCount ();
        for (let i = 0; i < triangles.length; i += 3) {
            let v0 = triangles[i] + vertexOffset;
            let v1 = triangles[i + 1] + vertexOffset;
            let v2 = triangles[i + 2] + vertexOffset;
            mesh.AddTriangle (new OV.Triangle (v0, v1, v2).SetNormals (v0, v1, v2));
        }
        brepFaces.push ({ first : first, last : mesh.TriangleCount () - 1 });
    });
    mesh.SetBrepFaces (brepFaces);
    let meshIndex = model.AddMesh (mesh);
    model.GetRootNode ().AddMeshIndex (meshIndex);
    return model;
}

const BoxMinM = [-0.05, -0.01, 0.0];
const BoxSizeM = [0.1, 0.02, 0.004];
const BoxMinMm = BoxMinM.map ((value) => value * 1000.0);
const BoxSizeMm = BoxSizeM.map ((value) => value * 1000.0);

// Strain grows linearly along x. The driving mode is still encoded, the file format requires it.
function LinearStrain (pointM)
{
    return -7.0 + 20.0 * (pointM[0] - BoxMinM[0]);
}

function HalfMode (pointM)
{
    return pointM[0] < 0.0 ? 1 : 2;
}

function CreateBoxArtifact (extra)
{
    let fe = CreateFeBox (BoxMinM, BoxSizeM, 20, LinearStrain, HalfMode);
    return EncodeSurfaceStrain (Object.assign ({
        positions : fe.positions,
        triangles : fe.triangles,
        log10Strain : fe.log10Strain,
        driving : fe.driving,
        meshSizeM : 0.002,
        oddHeader : true
    }, extra || {}));
}

describe ('Surface Strain Decoder', function () {
    it ('Decodes unaligned sections with 2 and 4 byte indices', function () {
        for (let indexBytes of [2, 4]) {
            let buffer = EncodeSurfaceStrain ({
                positions : [0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0, 0.02, 0.004],
                triangles : [0, 1, 2],
                log10Strain : [-8.0, -6.0, -5.0],
                driving : [1, 2, 1],
                meshSizeM : 0.002,
                indexBytes : indexBytes,
                oddHeader : true
            });
            let headerLength = new DataView (buffer).getUint32 (8, true);
            assert.strictEqual (headerLength % 2, 1);

            let data = OV.DecodeSurfaceStrain (buffer);
            assert.strictEqual (data.NodeCount (), 3);
            assert.strictEqual (data.TriangleCount (), 1);
            assert.ok (data.triangles instanceof (indexBytes === 2 ? Uint16Array : Uint32Array));
            assert.deepStrictEqual (Array.from (data.triangles), [0, 1, 2]);
            assert.ok (Math.abs (data.positions[3] - 0.1) < 1e-6);
            assert.ok (Math.abs (data.positions[7] - 0.02) < 1e-6);
            assert.ok (Math.abs (data.positions[8] - 0.004) < 1e-6);
            assert.ok (Math.abs (data.log10Strain[0] + 8.0) < 1e-4);
            assert.ok (Math.abs (data.log10Strain[1] + 6.0) < 1e-3);
            assert.ok (Math.abs (data.log10Strain[2] + 5.0) < 1e-4);
            assert.deepStrictEqual (Array.from (data.driving), [1, 2, 1]);
            assert.strictEqual (data.header.length_unit, 'm');
        }
    });

    it ('Rejects wrong files', function () {
        let params = {
            positions : [0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0, 0.02, 0.0],
            triangles : [0, 1, 2],
            log10Strain : [-8.0, -6.0, -5.0],
            driving : [1, 1, 1],
            meshSizeM : 0.002
        };
        assert.throws (() => OV.DecodeSurfaceStrain (EncodeSurfaceStrain (Object.assign ({}, params, { version : 2 }))), /version 2/);
        assert.throws (() => OV.DecodeSurfaceStrain (EncodeSurfaceStrain (Object.assign ({}, params, { extraBytes : 1 }))), /length disagrees/);
        let buffer = EncodeSurfaceStrain (params);
        new Uint8Array (buffer)[0] = 0x58;
        assert.throws (() => OV.DecodeSurfaceStrain (buffer), /not a surface strain file/);
        assert.throws (() => OV.DecodeSurfaceStrain (EncodeSurfaceStrain (params).slice (0, 40)));
    });
});

describe ('Surface Strain Units', function () {
    it ('Metre to model unit scale', function () {
        assert.strictEqual (OV.GetMetreToUnitScale (OV.Unit.Meter), 1.0);
        assert.ok (Math.abs (OV.GetMetreToUnitScale (OV.Unit.Millimeter) - 1000.0) < 1e-9);
        assert.ok (Math.abs (OV.GetMetreToUnitScale (OV.Unit.Centimeter) - 100.0) < 1e-9);
        assert.ok (Math.abs (OV.GetMetreToUnitScale (OV.Unit.Inch) - 39.3700787) < 1e-6);
        assert.ok (Math.abs (OV.GetMetreToUnitScale (OV.Unit.Foot) - 3.2808399) < 1e-6);
        assert.strictEqual (OV.GetMetreToUnitScale (OV.Unit.Unknown), null);
    });

    it ('Converts every length to millimetres', function () {
        let data = OV.DecodeSurfaceStrain (CreateBoxArtifact ());
        let geometry = OV.ConvertSurfaceStrainToUnit (data, OV.Unit.Millimeter);
        assert.strictEqual (geometry.unit, OV.Unit.Millimeter);
        assert.ok (Math.abs (geometry.meshSize - 2.0) < 1e-9);
        for (let axis = 0; axis < 3; axis++) {
            assert.ok (Math.abs (geometry.bboxMin[axis] - BoxMinMm[axis]) < 1e-6);
            assert.ok (Math.abs (geometry.bboxSize[axis] - BoxSizeMm[axis]) < 1e-6);
        }
        for (let i = 0; i < data.positions.length; i++) {
            assert.ok (Math.abs (geometry.positions[i] - data.positions[i] * 1000.0) < 1e-3);
        }
        // Strain is dimensionless, it is not scaled.
        assert.strictEqual (geometry.log10Strain, data.log10Strain);
    });
});

describe ('Surface Strain Frame', function () {
    let header = OV.DecodeSurfaceStrain (CreateBoxArtifact ()).header;
    let viewerBox = OV.GetBoundingBox (CreateViewerBox (BoxMinMm, BoxSizeMm, OV.Unit.Millimeter));

    it ('Metre artifact matches millimetre model', function () {
        let result = OV.MatchSurfaceStrainFrame (header, viewerBox, OV.Unit.Millimeter);
        assert.ok (result.ok, result.reason);
        assert.strictEqual (result.unit, OV.Unit.Millimeter);
    });

    it ('Infers the unit of a model without unit', function () {
        let result = OV.MatchSurfaceStrainFrame (header, viewerBox, OV.Unit.Unknown);
        assert.ok (result.ok);
        assert.strictEqual (result.unit, OV.Unit.Millimeter);
    });

    it ('Detects an artifact that is not in metres', function () {
        let wrongHeader = Object.assign ({}, header, {
            bbox_min_m : BoxMinMm,
            bbox_size_m : BoxSizeMm,
            mesh_size_m : 2.0
        });
        let result = OV.MatchSurfaceStrainFrame (wrongHeader, viewerBox, OV.Unit.Millimeter);
        assert.ok (!result.ok);
        assert.ok (result.reason.indexOf ('unit mismatch') !== -1, result.reason);
    });

    it ('Detects a moved model', function () {
        let movedBox = OV.GetBoundingBox (CreateViewerBox ([BoxMinMm[0] + 10.0, BoxMinMm[1], BoxMinMm[2]], BoxSizeMm, OV.Unit.Millimeter));
        let result = OV.MatchSurfaceStrainFrame (header, movedBox, OV.Unit.Millimeter);
        assert.ok (!result.ok);
        assert.ok (result.reason.indexOf ('position differs on x') !== -1, result.reason);
    });
});

describe ('Surface Strain Refinement', function () {
    it ('Refines a square to the edge length without T-junctions', function () {
        let positions = [0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0];
        let normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
        let triangles = [0, 1, 2, 0, 2, 3];
        let refined = OV.RefineTriangles (positions, normals, triangles, 2.0);

        let area = 0.0;
        let edgeCounts = new Map ();
        let p = refined.positions;
        for (let i = 0; i < refined.triangles.length; i += 3) {
            let corners = [refined.triangles[i], refined.triangles[i + 1], refined.triangles[i + 2]];
            let ax = p[corners[1] * 3] - p[corners[0] * 3];
            let ay = p[corners[1] * 3 + 1] - p[corners[0] * 3 + 1];
            let bx = p[corners[2] * 3] - p[corners[0] * 3];
            let by = p[corners[2] * 3 + 1] - p[corners[0] * 3 + 1];
            let signedArea = (ax * by - ay * bx) / 2.0;
            assert.ok (signedArea > 0.0, 'winding is kept');
            area += signedArea;
            for (let e = 0; e < 3; e++) {
                let a = corners[e];
                let b = corners[(e + 1) % 3];
                let dx = p[a * 3] - p[b * 3];
                let dy = p[a * 3 + 1] - p[b * 3 + 1];
                assert.ok (Math.sqrt (dx * dx + dy * dy) <= 2.0 + 1e-9);
                let key = Math.min (a, b).toString () + '_' + Math.max (a, b).toString ();
                edgeCounts.set (key, (edgeCounts.get (key) || 0) + 1);
            }
        }
        assert.ok (Math.abs (area - 10000.0) < 1e-6);

        // Conforming: every edge is shared by two triangles, except the edges on the boundary,
        // and those add up to the perimeter exactly.
        let boundaryLength = 0.0;
        for (let [key, count] of edgeCounts) {
            assert.ok (count === 1 || count === 2);
            if (count === 1) {
                let [a, b] = key.split ('_').map ((value) => parseInt (value, 10));
                boundaryLength += Math.hypot (p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]);
            }
        }
        assert.ok (Math.abs (boundaryLength - 400.0) < 1e-6);
        for (let i = 0; i < refined.normals.length; i += 3) {
            assert.deepStrictEqual (refined.normals.slice (i, i + 3), [0, 0, 1]);
        }
    });

    it ('Stops at the vertex budget', function () {
        let budget = new OV.RefinementBudget (100);
        let refined = OV.RefineTriangles ([0, 0, 0, 100, 0, 0, 0, 100, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2], 1.0, budget);
        assert.ok (budget.capped);
        assert.ok (refined.VertexCount () <= 100);
    });
});

describe ('Surface Strain Mapping', function () {
    it ('Maps a metre artifact onto a coarse millimetre BREP box', function () {
        let model = CreateViewerBox (BoxMinMm, BoxSizeMm, OV.Unit.Millimeter);
        let result = OV.PrepareSurfaceStrain (model, CreateBoxArtifact ());
        assert.ok (result.ok, result.reason);
        assert.strictEqual (result.unit, OV.Unit.Millimeter);
        assert.strictEqual (result.header.modes.length, 2);

        let mapping = result.mapping;
        assert.strictEqual (mapping.failedCount, 0);
        assert.strictEqual (mapping.meshes.length, 1);
        // The 12 triangles got refined to the 2 mm FE mesh size.
        let meshResult = mapping.meshes[0];
        assert.ok (meshResult.VertexCount () > 500);

        for (let i = 0; i < meshResult.VertexCount (); i++) {
            let xMm = meshResult.positions[i * 3];
            let expected = LinearStrain ([xMm / 1000.0, 0.0, 0.0]);
            assert.ok (Math.abs (meshResult.log10Strain[i] - expected) < 2e-3, 'strain at x = ' + xMm.toString ());
        }
        // The hot end of the part reaches the top of the range, even though the coarse
        // tessellation had no vertex in the middle of the long faces.
        let maximum = Math.max (...meshResult.log10Strain);
        assert.ok (Math.abs (maximum - LinearStrain ([BoxMinM[0] + BoxSizeM[0], 0.0, 0.0])) < 2e-3);
    });

    it ('Refuses an artifact of another part', function () {
        let model = CreateViewerBox (BoxMinMm, [BoxSizeMm[0] * 2.0, BoxSizeMm[1], BoxSizeMm[2]], OV.Unit.Millimeter);
        let result = OV.PrepareSurfaceStrain (model, CreateBoxArtifact ());
        assert.ok (!result.ok);
        assert.strictEqual (result.mapping, null);
    });

    it ('Normal filter picks the right side of a thin wall', function () {
        // Two FE plates 0.1 mm apart, the bottom one facing down, the top one facing up.
        let positions = [
            0.0, 0.0, 0.0, 0.01, 0.0, 0.0, 0.01, 0.01, 0.0, 0.0, 0.01, 0.0,
            0.0, 0.0, 0.0001, 0.01, 0.0, 0.0001, 0.01, 0.01, 0.0001, 0.0, 0.01, 0.0001
        ];
        let triangles = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7];
        let data = OV.DecodeSurfaceStrain (EncodeSurfaceStrain ({
            positions : positions,
            triangles : triangles,
            log10Strain : [-5, -5, -5, -5, -7, -7, -7, -7],
            driving : [1, 1, 1, 1, 2, 2, 2, 2],
            meshSizeM : 0.002
        }));
        let geometry = OV.ConvertSurfaceStrainToUnit (data, OV.Unit.Millimeter);
        let index = new OV.SurfaceStrainIndex (geometry);
        let sample = new OV.SurfaceStrainSample ();

        assert.ok (index.Sample (5.0, 5.0, 0.1, 0.0, 0.0, 1.0, 4.0, sample));
        assert.ok (Math.abs (sample.log10Strain + 7.0) < 1e-3);

        assert.ok (index.Sample (5.0, 5.0, 0.0, 0.0, 0.0, -1.0, 4.0, sample));
        assert.ok (Math.abs (sample.log10Strain + 5.0) < 1e-3);

        assert.ok (!index.Sample (50.0, 50.0, 0.0, 0.0, 0.0, 1.0, 4.0, sample));
    });
});

describe ('Surface Strain Thresholds', function () {
    function Log10Microstrain (microstrain)
    {
        return Math.log10 (microstrain * 1.0e-6);
    }

    function ColorOf (scale, microstrain)
    {
        let color = [0, 0, 0];
        scale.GetColor (Log10Microstrain (microstrain), color, 0);
        return color.map ((value) => Math.round (value * 255.0));
    }

    it ('Highest threshold reached takes precedence, in any order', function () {
        // Deliberately not sorted.
        let scale = OV.SurfaceStrainThresholdScale.Create ([
            { color : '#ffff00', strain : 25 },
            { color : '#ff0000', strain : 100 },
            { color : 'ffa500', strain : 50 }
        ]);
        assert.deepStrictEqual (scale.thresholds.map ((threshold) => threshold.microstrain), [100, 50, 25]);
        assert.deepStrictEqual (ColorOf (scale, 250), [255, 0, 0]);
        assert.deepStrictEqual (ColorOf (scale, 100), [255, 0, 0]);
        assert.deepStrictEqual (ColorOf (scale, 99), [255, 165, 0]);
        assert.deepStrictEqual (ColorOf (scale, 50), [255, 165, 0]);
        assert.deepStrictEqual (ColorOf (scale, 30), [255, 255, 0]);
        assert.deepStrictEqual (ColorOf (scale, 25), [255, 255, 0]);
        assert.deepStrictEqual (ColorOf (scale, 24), [200, 200, 200]);
        let unmapped = [0, 0, 0];
        scale.GetColor (NaN, unmapped, 0);
        assert.deepStrictEqual (unmapped.map ((value) => Math.round (value * 255.0)), [200, 200, 200]);
    });

    it ('Below threshold color can be set', function () {
        let scale = OV.SurfaceStrainThresholdScale.Create ([{ color : '#ff0000', strain : 10 }], '#000000');
        assert.deepStrictEqual (ColorOf (scale, 1), [0, 0, 0]);
    });

    it ('Rejects invalid thresholds', function () {
        let Create = (thresholds, below) => () => OV.SurfaceStrainThresholdScale.Create (thresholds, below);
        assert.throws (Create ([]), /non-empty/);
        assert.throws (Create ([{ color : 'red', strain : 10 }]), /threshold 1 color must be a hex color/);
        assert.throws (Create ([{ color : '#ff0000', strain : 0 }]), /positive number/);
        assert.throws (Create ([{ color : '#ff0000', strain : '10' }]), /positive number/);
        assert.throws (Create ([{ color : '#ff0000', strain : 10 }, { color : '#00ff00', strain : 10 }]), /threshold 2 repeats/);
        assert.throws (Create ([{ color : '#ff0000', strain : 10 }], '#12345'), /below threshold color/);
        let tooMany = [];
        for (let i = 1; i <= OV.SurfaceStrainMaxThresholdCount + 1; i++) {
            tooMany.push ({ color : '#ff0000', strain : i });
        }
        assert.throws (Create (tooMany), /at most/);
    });

    it ('Thresholds replace the continuous scale', function () {
        let params = new OV.SurfaceStrainParams ();
        assert.ok (OV.CreateSurfaceStrainColorScale (params, null) instanceof OV.SurfaceStrainColorScale);
        params.thresholds = [];
        assert.ok (OV.CreateSurfaceStrainColorScale (params, null) instanceof OV.SurfaceStrainColorScale);
        params.thresholds = [{ color : '#ff0000', strain : 100 }];
        assert.ok (OV.CreateSurfaceStrainColorScale (params, null) instanceof OV.SurfaceStrainThresholdScale);
    });

    it ('Maps with thresholds, and rejects bad ones before mapping', function () {
        let model = CreateViewerBox (BoxMinMm, BoxSizeMm, OV.Unit.Millimeter);
        let params = new OV.SurfaceStrainParams ();
        params.thresholds = [
            { color : '#ff0000', strain : 100 },
            { color : '#ffa500', strain : 50 },
            { color : '#ffff00', strain : 25 }
        ];
        let result = OV.PrepareSurfaceStrain (model, CreateBoxArtifact (), params);
        assert.ok (result.ok, result.reason);
        assert.ok (result.colorScale instanceof OV.SurfaceStrainThresholdScale);
        // The box field goes from 0.1 µε to 10 µε along x, so a 5 µε band covers the hot end.
        params.thresholds = [{ color : '#ff0000', strain : 5 }];
        result = OV.PrepareSurfaceStrain (model, CreateBoxArtifact (), params);
        let meshResult = result.mapping.meshes[0];
        let red = 0;
        for (let i = 0; i < meshResult.VertexCount (); i++) {
            if (result.colorScale.GetThresholdIndex (meshResult.log10Strain[i]) === 0) {
                red += 1;
                assert.ok (meshResult.positions[i * 3] > 30.0);
            }
        }
        assert.ok (red > 0);

        params.thresholds = [{ color : '#ff0000', strain : -1 }];
        result = OV.PrepareSurfaceStrain (model, CreateBoxArtifact (), params);
        assert.ok (!result.ok);
        assert.strictEqual (result.mapping, null);
        assert.ok (result.reason.indexOf ('positive number') !== -1);
    });
});

describe ('Surface Strain Color', function () {
    it ('Clamps to the absolute range', function () {
        let scale = OV.SurfaceStrainColorScale.Create (OV.SurfaceStrainColorRange.Absolute, null);
        let low = [0, 0, 0];
        let lower = [0, 0, 0];
        let high = [0, 0, 0];
        scale.GetColor (-6.0, low, 0);
        scale.GetColor (-9.0, lower, 0);
        scale.GetColor (-4.0, high, 0);
        assert.deepStrictEqual (low, lower);
        assert.ok (high[0] > 0.9 && high[1] > 0.85);
        let missing = [0, 0, 0];
        scale.GetColor (NaN, missing, 0);
        assert.deepStrictEqual (missing, OV.SurfaceStrainMissingColor);
    });
});

}
