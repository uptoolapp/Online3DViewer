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
                depthTest : true,
                // The edges lie on the surface, pull them toward the camera so the part doesn't
                // cover half of their width. The quads are triangles, so the offset applies.
                polygonOffset : true,
                polygonOffsetFactor : -1,
                polygonOffsetUnits : -4
            });
            this.rootObject.add (new LineSegments2 (geometry, material));
        }
        return this.rootObject;
    }
}
