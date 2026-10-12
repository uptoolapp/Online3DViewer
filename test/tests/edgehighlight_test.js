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
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[0, 0, 0], [0.1, 0.02, 0.01]], color : '#0000ff' }], params);
        assert.ok (prepared.result.ok);
        let positions = prepared.prepared[0].positions;
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
        assert.ok (prepared.result.reason.indexOf ('edge 0: point 1 is outside the model') === 0);
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
        Check ({ polyline : [[0, 0, 0], [200, 0, 0]], color : '#ff0000' }, 'point 1 is outside the model');
    });

    it ('Allows points slightly outside the bounding box', function () {
        let model = CreateBoxModel (OV.Unit.Millimeter);
        let prepared = OV.PrepareEdgeHighlights (model, [{ polyline : [[-0.5, 0, 0], [100.5, 0, 0]], color : '#ff0000' }]);
        assert.ok (prepared.result.ok);
    });

    it ('Refuses invalid params and an empty model', function () {
        let params = new OV.EdgeHighlightParams ();
        params.width = -1;
        let prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), [], params);
        assert.ok (!prepared.result.ok);
        assert.ok (prepared.result.reason.indexOf ('width') === 0);

        prepared = OV.PrepareEdgeHighlights (CreateBoxModel (OV.Unit.Millimeter), 'nope');
        assert.ok (!prepared.result.ok);

        prepared = OV.PrepareEdgeHighlights (new OV.Model (), [BoxEdge ('#ff0000')]);
        assert.ok (!prepared.result.ok);
        assert.strictEqual (prepared.result.reason, 'the model is empty');
    });
});

}
