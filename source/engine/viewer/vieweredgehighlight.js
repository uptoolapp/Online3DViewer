import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Three.js overlay that draws prepared edge highlights as thick screen-space lines. WebGL lines
 * are always one pixel wide, so the polylines are drawn as quads with a width in CSS pixels.
 * LineSegments2 sets the material's resolution from the viewport before every render.
 */
export class ViewerEdgeHighlight
{
    constructor (prepared)
    {
        this.prepared = prepared;
        this.rootObject = null;
    }

    CreateThreeObject ()
    {
        // One draw call per line width.
        let groups = new Map ();
        for (let edge of this.prepared) {
            if (!groups.has (edge.width)) {
                groups.set (edge.width, []);
            }
            groups.get (edge.width).push (edge);
        }

        this.rootObject = new THREE.Object3D ();
        for (let [width, edges] of groups) {
            let segmentCount = 0;
            for (let edge of edges) {
                segmentCount += edge.PointCount () - 1;
            }
            let positions = new Float32Array (segmentCount * 6);
            let colors = new Float32Array (segmentCount * 6);
            let offset = 0;
            for (let edge of edges) {
                for (let i = 0; i < edge.PointCount () - 1; i++) {
                    for (let j = 0; j < 6; j++) {
                        positions[offset + j] = edge.positions[i * 3 + j];
                        colors[offset + j] = edge.color[j % 3];
                    }
                    offset += 6;
                }
            }

            let geometry = new LineSegmentsGeometry ();
            geometry.setPositions (positions);
            geometry.setColors (colors);
            let material = new LineMaterial ({
                color : 0xffffff,
                vertexColors : true,
                linewidth : width,
                depthTest : true
            });
            this.rootObject.add (new LineSegments2 (geometry, material));
        }
        return this.rootObject;
    }

    /**
     * The polygon offset factor the meshes need so that no wall next to a line covers it. A wall
     * rises toward the camera by its depth slope per pixel, at most sqrt (2) times the slope the
     * polygon offset uses, over the line's half width. One more for rasterization.
     */
    GetMeshPolygonOffsetFactor ()
    {
        let maxWidth = 0.0;
        for (let edge of this.prepared) {
            maxWidth = Math.max (maxWidth, edge.width);
        }
        return Math.ceil (maxWidth * 0.5 * Math.SQRT2) + 1;
    }
}
