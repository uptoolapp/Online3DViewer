import { SurfaceStrainDimmedColor } from '../surfacestrain/surfacestraincolor.js';
import { ShadingType } from '../threejs/threeutils.js';

import * as THREE from 'three';

/**
 * Three.js overlay that shows a mapped surface strain field instead of the model's own meshes.
 */
export class ViewerSurfaceStrain
{
    constructor (mapping, header, colorScale)
    {
        this.mapping = mapping;
        this.header = header;
        this.colorScale = colorScale;
        this.highlightedMode = null;
        this.rootObject = null;
    }

    CreateThreeObject (shadingType)
    {
        this.rootObject = new THREE.Object3D ();
        for (let meshResult of this.mapping.meshes) {
            let geometry = new THREE.BufferGeometry ();
            geometry.setAttribute ('position', new THREE.BufferAttribute (meshResult.positions, 3));
            geometry.setAttribute ('normal', new THREE.BufferAttribute (meshResult.normals, 3));
            geometry.setAttribute ('color', new THREE.BufferAttribute (new Float32Array (meshResult.positions.length), 3));
            geometry.setIndex (new THREE.BufferAttribute (meshResult.indices, 1));

            let materialParams = {
                color : 0xffffff,
                vertexColors : true,
                side : THREE.DoubleSide
            };
            let material = null;
            if (shadingType === ShadingType.Physical) {
                material = new THREE.MeshStandardMaterial (materialParams);
            } else {
                material = new THREE.MeshPhongMaterial (materialParams);
            }

            let threeMesh = new THREE.Mesh (geometry, material);
            threeMesh.userData = {
                surfaceStrain : meshResult
            };
            this.rootObject.add (threeMesh);
        }
        this.UpdateColors ();
        return this.rootObject;
    }

    SetHighlightedMode (mode)
    {
        this.highlightedMode = mode;
        this.UpdateColors ();
    }

    UpdateColors ()
    {
        if (this.rootObject === null) {
            return;
        }
        for (let threeMesh of this.rootObject.children) {
            let meshResult = threeMesh.userData.surfaceStrain;
            let colorAttribute = threeMesh.geometry.getAttribute ('color');
            let colors = colorAttribute.array;
            for (let i = 0; i < meshResult.VertexCount (); i++) {
                if (this.highlightedMode !== null && meshResult.mode[i] !== this.highlightedMode) {
                    colors[i * 3] = SurfaceStrainDimmedColor[0];
                    colors[i * 3 + 1] = SurfaceStrainDimmedColor[1];
                    colors[i * 3 + 2] = SurfaceStrainDimmedColor[2];
                } else {
                    this.colorScale.GetColor (meshResult.log10Strain[i], colors, i * 3);
                }
            }
            colorAttribute.needsUpdate = true;
        }
    }

    /**
     * Returns the strain at a raycaster intersection with the overlay, or null.
     */
    GetValueAtIntersection (intersection)
    {
        let meshResult = intersection.object.userData.surfaceStrain;
        if (!meshResult || !intersection.face) {
            return null;
        }
        let face = intersection.face;
        let positions = meshResult.positions;
        let corners = [face.a, face.b, face.c];
        let triangle = new THREE.Triangle (
            new THREE.Vector3 ().fromArray (positions, face.a * 3),
            new THREE.Vector3 ().fromArray (positions, face.b * 3),
            new THREE.Vector3 ().fromArray (positions, face.c * 3)
        );
        let localPoint = intersection.object.worldToLocal (intersection.point.clone ());
        let bary = new THREE.Vector3 ();
        if (triangle.getBarycoord (localPoint, bary) === null) {
            return null;
        }

        let weights = [bary.x, bary.y, bary.z];
        let log10Strain = 0.0;
        for (let i = 0; i < 3; i++) {
            log10Strain += weights[i] * meshResult.log10Strain[corners[i]];
        }
        if (Number.isNaN (log10Strain)) {
            return null;
        }
        let nearest = weights.indexOf (Math.max (...weights));
        let mode = meshResult.mode[corners[nearest]];
        let modeData = (mode > 0 && this.header.modes) ? this.header.modes[mode - 1] : null;
        return {
            log10Strain : log10Strain,
            microstrain : Math.pow (10.0, log10Strain) * 1.0e6,
            mode : mode,
            frequencyHz : modeData ? modeData.frequency_hz : null
        };
    }
}
