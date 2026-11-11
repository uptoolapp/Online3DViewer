import { ShadingType } from '../threejs/threeutils.js';

import * as THREE from 'three';

/**
 * Three.js overlay that paints the long reach faces over the model. The painted triangles are the
 * model's own, so they lie on the same surface as the meshes and the surface strain overlay. They
 * are pulled forward by a polygon offset to win the depth test against them, see
 * {@link ViewerLongReach#SetPolygonOffset}. The geometry is built once, a limit only changes how
 * many of its indices are drawn.
 */
export class ViewerLongReach
{
    constructor (prepared)
    {
        this.prepared = prepared;
        this.rootObject = null;
    }

    CreateThreeObject (shadingType)
    {
        this.rootObject = new THREE.Object3D ();
        for (let instance of this.prepared) {
            let geometry = new THREE.BufferGeometry ();
            geometry.setAttribute ('position', new THREE.BufferAttribute (instance.positions, 3));
            geometry.setAttribute ('normal', new THREE.BufferAttribute (instance.normals, 3));
            geometry.setIndex (new THREE.BufferAttribute (instance.indices, 1));

            let materialParams = {
                color : 0xffffff,
                side : THREE.DoubleSide,
                polygonOffset : true,
                polygonOffsetFactor : -1,
                polygonOffsetUnits : -1
            };
            let material = null;
            if (shadingType === ShadingType.Physical) {
                material = new THREE.MeshStandardMaterial (materialParams);
            } else {
                material = new THREE.MeshPhongMaterial (materialParams);
            }

            let threeMesh = new THREE.Mesh (geometry, material);
            threeMesh.userData = {
                longReach : instance
            };
            this.rootObject.add (threeMesh);
        }
        return this.rootObject;
    }

    /**
     * Chooses the painted faces and their color.
     * @param {number} limit Faces of groups above this length to diameter are painted.
     * @param {boolean} show False paints nothing.
     * @param {number[]} color Float r, g, b in 0..1.
     */
    SetDisplay (limit, show, color)
    {
        for (let threeMesh of this.rootObject.children) {
            let count = (show ? threeMesh.userData.longReach.IndexCount (limit) : 0);
            threeMesh.geometry.setDrawRange (0, count);
            threeMesh.material.color.setRGB (color[0], color[1], color[2]);
        }
    }

    /**
     * The meshes and the surface strain overlay are pushed back by units 1 and the given factor
     * when they need a polygon offset. The painted faces take one factor less and units -1, so
     * they stay in front of the triangles they cover by one depth slope as well as a unit. Drawn by
     * another shader, the same triangle rasterizes at a slightly different depth, and that
     * difference grows with the slope of the face: a units offset alone loses to it on faces seen
     * at a steep angle, which flicker. One factor less still keeps them behind thick edge
     * highlights, whose factor on the meshes has a margin of one.
     * @param {number} factor Polygon offset factor of the meshes, 0 if they have none.
     */
    SetPolygonOffset (factor)
    {
        for (let threeMesh of this.rootObject.children) {
            threeMesh.material.polygonOffsetFactor = factor - 1;
        }
    }
}
