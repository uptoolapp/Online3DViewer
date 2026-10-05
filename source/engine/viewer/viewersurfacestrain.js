import { SurfaceStrainThresholdScale } from '../surfacestrain/surfacestraincolor.js';
import { ShadingType } from '../threejs/threeutils.js';

import * as THREE from 'three';

// Value written for vertices that could not be mapped, below any threshold.
const UnmappedLog10Strain = -1000.0;

// Threshold bands are resolved per fragment from the interpolated log10 strain, so band borders are
// crisp contour lines instead of colors blended across every triangle.
function AddThresholdShader (material, colorScale)
{
    let thresholds = colorScale.thresholds;
    material.defines = {
        SURFACE_STRAIN_THRESHOLD_COUNT : thresholds.length
    };
    let uniforms = {
        surfaceStrainThresholds : { value : thresholds.map ((threshold) => threshold.log10Strain) },
        surfaceStrainColors : { value : thresholds.map ((threshold) => new THREE.Vector3 (threshold.color[0], threshold.color[1], threshold.color[2])) },
        surfaceStrainBelowColor : { value : new THREE.Vector3 (colorScale.belowColor[0], colorScale.belowColor[1], colorScale.belowColor[2]) }
    };
    material.onBeforeCompile = (shader) => {
        Object.assign (shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace ('#include <common>', [
                '#include <common>',
                'attribute float surfaceStrainLog10;',
                'varying float vSurfaceStrainLog10;'
            ].join ('\n'))
            .replace ('#include <begin_vertex>', [
                '#include <begin_vertex>',
                'vSurfaceStrainLog10 = surfaceStrainLog10;'
            ].join ('\n'));
        shader.fragmentShader = shader.fragmentShader
            .replace ('#include <common>', [
                '#include <common>',
                'uniform float surfaceStrainThresholds[SURFACE_STRAIN_THRESHOLD_COUNT];',
                'uniform vec3 surfaceStrainColors[SURFACE_STRAIN_THRESHOLD_COUNT];',
                'uniform vec3 surfaceStrainBelowColor;',
                'varying float vSurfaceStrainLog10;'
            ].join ('\n'))
            .replace ('#include <color_fragment>', [
                '#include <color_fragment>',
                // Thresholds are sorted highest first, walk up from the lowest so the highest one
                // reached wins.
                'vec3 surfaceStrainColor = surfaceStrainBelowColor;',
                'for (int i = SURFACE_STRAIN_THRESHOLD_COUNT - 1; i >= 0; i--) {',
                '    if (vSurfaceStrainLog10 >= surfaceStrainThresholds[i]) {',
                '        surfaceStrainColor = surfaceStrainColors[i];',
                '    }',
                '}',
                'diffuseColor.rgb = surfaceStrainColor;'
            ].join ('\n'));
    };
    material.customProgramCacheKey = () => {
        return 'surfacestrain_threshold_' + thresholds.length.toString ();
    };
}

/**
 * Three.js overlay that shows a mapped surface strain field instead of the model's own meshes.
 */
export class ViewerSurfaceStrain
{
    constructor (mapping, colorScale)
    {
        this.mapping = mapping;
        this.colorScale = colorScale;
        this.rootObject = null;
    }

    CreateThreeObject (shadingType)
    {
        let isThreshold = (this.colorScale instanceof SurfaceStrainThresholdScale);
        this.rootObject = new THREE.Object3D ();
        for (let meshResult of this.mapping.meshes) {
            let geometry = new THREE.BufferGeometry ();
            geometry.setAttribute ('position', new THREE.BufferAttribute (meshResult.positions, 3));
            geometry.setAttribute ('normal', new THREE.BufferAttribute (meshResult.normals, 3));
            geometry.setIndex (new THREE.BufferAttribute (meshResult.indices, 1));
            if (isThreshold) {
                let log10Strain = new Float32Array (meshResult.VertexCount ());
                for (let i = 0; i < log10Strain.length; i++) {
                    let value = meshResult.log10Strain[i];
                    log10Strain[i] = Number.isNaN (value) ? UnmappedLog10Strain : value;
                }
                geometry.setAttribute ('surfaceStrainLog10', new THREE.BufferAttribute (log10Strain, 1));
            } else {
                let colors = new Float32Array (meshResult.positions.length);
                for (let i = 0; i < meshResult.VertexCount (); i++) {
                    this.colorScale.GetColor (meshResult.log10Strain[i], colors, i * 3);
                }
                geometry.setAttribute ('color', new THREE.BufferAttribute (colors, 3));
            }

            let materialParams = {
                color : 0xffffff,
                vertexColors : !isThreshold,
                side : THREE.DoubleSide,
                // The edges stay visible on top of the overlay and lie on the same surface, so push
                // the overlay back like the main meshes, otherwise the edges flicker.
                polygonOffset : true,
                polygonOffsetFactor : 1,
                polygonOffsetUnits : 1
            };
            let material = null;
            if (shadingType === ShadingType.Physical) {
                material = new THREE.MeshStandardMaterial (materialParams);
            } else {
                material = new THREE.MeshPhongMaterial (materialParams);
            }
            if (isThreshold) {
                AddThresholdShader (material, this.colorScale);
            }

            let threeMesh = new THREE.Mesh (geometry, material);
            threeMesh.userData = {
                surfaceStrain : meshResult
            };
            this.rootObject.add (threeMesh);
        }
        return this.rootObject;
    }
}
