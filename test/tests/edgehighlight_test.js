import * as assert from 'assert';
import * as OV from '../../source/engine/main.js';

export default function suite ()
{

// A 100 x 20 x 10 box from the origin, in the given unit.
function CreateBoxModel (unit)
{
    let model = new OV.Model ();
    model.SetUnit (unit);
    let mesh = OV.GenerateCuboid (null, 100.0, 20.0, 10.0);
    let meshIndex = model.AddMesh (mesh);
    model.GetRootNode ().AddMeshIndex (meshIndex);
    return model;
}

function BoxEdge (color)
{
    return { polyline : [[0, 0, 0], [50, 0, 0], [100, 0, 0]], color : color };
}

describe ('Edge Highlight', function () {
    it ('Prepares valid edges', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let edges = [
            BoxEdge ('#ff0000'),
            { polyline : [[0, 20, 10], [100, 20, 10]], color : '00ff00', width : 6 }
        ];
        let prepared = OV.PrepareEdgeHighlights (model, edges);
        assert.ok (prepared.result.ok);
        assert.strictEqual (prepared.result.reason, null);
        assert.strictEqual (prepared.result.edgeCount, 2);
        assert.strictEqual (prepared.prepared[0].PointCount (), 3);
        assert.deepStrictEqual (prepared.prepared[0].color, [1, 0, 0]);
        assert.strictEqual (prepared.prepared[0].width, 4);
        assert.deepStrictEqual (prepared.prepared[1].color, [0, 1, 0]);
        assert.strictEqual (prepared.prepared[1].width, 6);
        assert.deepStrictEqual (Array.from (prepared.prepared[1].positions), [0, 20, 10, 100, 20, 10]);
    });

    it ('Accepts an empty list', function () {
        let prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), []);
        assert.ok (prepared.result.ok);
        assert.strictEqual (prepared.result.edgeCount, 0);
        assert.deepStrictEqual (prepared.prepared, []);
    });

    it ('Converts to the model unit', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let params = new OV.EdgeHighlightParams ();
        params.unit = OV.Unit.Meter;
        // Read as mm these collapse onto the corner at the origin, which must not count as a fit.
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[0.05, 0.02, 0.01], [0.1, 0.02, 0.01]], color : '#0000ff' }], params);
        assert.ok (prepared.result.ok, prepared.result.reason);
        let positions = prepared.prepared[0].positions;
        assert.ok (Math.abs (positions[0] - 50.0) < 1e-4);
        assert.ok (Math.abs (positions[3] - 100.0) < 1e-4);
        assert.ok (Math.abs (positions[4] - 20.0) < 1e-4);
        assert.ok (Math.abs (positions[5] - 10.0) < 1e-4);
    });

    it ('Uses the coordinates as they are for an unknown model unit', function () {
        let model = CreateBoxModel (OV.Unit.Unknown);
        let prepared = OV.PrepareEdgeHighlights (model, [BoxEdge ('#ff0000')]);
        assert.ok (prepared.result.ok);
        assert.strictEqual (prepared.prepared[0].positions[6], 100);
    });

    it ('Refuses edges in the wrong unit', function () {
        // Millimetre coordinates passed as metres end up 1000 times too large.
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let params = new OV.EdgeHighlightParams ();
        params.unit = OV.Unit.Meter;
        let prepared = OV.PrepareEdgeHighlights (model, [BoxEdge ('#ff0000')], params);
        assert.ok (!prepared.result.ok);
        assert.strictEqual (prepared.prepared, null);
        assert.strictEqual (prepared.result.reason, 'edge 0: point 1 is not on the model, the edges fit the model only if they were in mm, not m');
    });

    it ('Refuses edges that collapse onto the origin in a wrong unit', function () {
        // Metre coordinates passed as mm shrink onto the box corner at the origin.
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let edges = [{ polyline : [[0, 0, 0], [0.05, 0, 0], [0.1, 0, 0]], color : '#ff0000' }];
        let prepared = OV.PrepareEdgeHighlights (model, edges);
        assert.ok (!prepared.result.ok);
        assert.strictEqual (prepared.result.reason, 'the edges collapse to a point in mm, they fit the model only if they were in m');
    });

    it ('Refuses edges that are inside the box but not on the surface', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let edges = [BoxEdge ('#ff0000'), { polyline : [[10, 10, 5], [90, 10, 5]], color : '#ff0000' }];
        let prepared = OV.PrepareEdgeHighlights (model, edges);
        assert.ok (!prepared.result.ok);
        assert.strictEqual (prepared.result.reason, 'edge 1: point 0 is not on the model, the edges may belong to another part');
    });

    it ('Refuses edges that fit the model in two units', function () {
        // A short edge along the x axis from the corner at the origin stays on the box edge when
        // it is scaled up by 10.
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[0, 0, 0], [5, 0, 0]], color : '#ff0000' }]);
        assert.ok (!prepared.result.ok);
        assert.strictEqual (prepared.result.reason, 'the edges fit the model both in mm and in cm, the unit is ambiguous');
    });

    it ('Accepts a short edge away from the origin', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[60, 0, 10], [60.2, 0, 10]], color : '#ff0000' }]);
        assert.ok (prepared.result.ok, prepared.result.reason);
    });

    it ('Accepts edges on a face, not only on the box edges', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[30, 5, 10], [60, 15, 10]], color : '#ff0000' }]);
        assert.ok (prepared.result.ok, prepared.result.reason);
    });

    it ('Refuses invalid edges with the edge index', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        function Check (edge, expected)
        {
            let prepared = OV.PrepareEdgeHighlights (model, [BoxEdge ('#ff0000'), edge]);
            assert.ok (!prepared.result.ok);
            assert.strictEqual (prepared.result.edgeCount, 0);
            assert.strictEqual (prepared.prepared, null);
            assert.ok (prepared.result.reason.indexOf ('edge 1: ' + expected) === 0, prepared.result.reason);
        }
        Check (null, 'must be an object');
        Check ({ polyline : [[0, 0, 0]], color : '#ff0000' }, 'polyline needs at least 2 points');
        Check ({ polyline : [[0, 0, 0], [1, NaN, 0]], color : '#ff0000' }, 'point 1 has a coordinate that is not a finite number');
        Check ({ polyline : [[0, 0, 0], [1, 0]], color : '#ff0000' }, 'point 1 must be [x, y, z]');
        Check ({ polyline : [[0, 0, 0], [1, 0, 0]], color : 'red' }, 'color must be a hex color');
        Check ({ polyline : [[0, 0, 0], [1, 0, 0]], color : '#ff0000', width : 0 }, 'width must be a positive number');
    });

    it ('Allows points slightly outside the bounding box', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[-0.15, 0, 0], [100.15, 0, 0]], color : '#ff0000' }]);
        assert.ok (prepared.result.ok);
    });

    it ('Refuses invalid params and an empty model', function () {
        let params = new OV.EdgeHighlightParams ();
        params.width = -1;
        let prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), [], params);
        assert.ok (!prepared.result.ok);
        assert.ok (prepared.result.reason.indexOf ('width') === 0);

        for (let unit of [undefined, 'mm', OV.Unit.Unknown, 42]) {
            params = new OV.EdgeHighlightParams ();
            params.unit = unit;
            prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), [BoxEdge ('#ff0000')], params);
            assert.ok (!prepared.result.ok);
            assert.ok (prepared.result.reason.indexOf ('unit must be') === 0);
        }
        prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), [BoxEdge ('#ff0000')], { width : 3, surfaceTolerance : 0.005 });
        assert.ok (!prepared.result.ok);
        assert.ok (prepared.result.reason.indexOf ('unit must be') === 0);

        prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), 'nope');
        assert.ok (!prepared.result.ok);

        prepared = OV.PrepareEdgeHighlights (new OV.Model (), [BoxEdge ('#ff0000')]);
        assert.ok (!prepared.result.ok);
        assert.strictEqual (prepared.result.reason, 'the model is empty');
    });
});

}
