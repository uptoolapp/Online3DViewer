import { Coord3D } from '../geometry/coord3d.js';

// The BREP faces of the viewer's model, as the analysis overlays sample and paint them.

/**
 * Lists the BREP faces of the model: every mesh instance in model order, each mesh's faces in the
 * order occt-import-js reports them.
 * @param {Model} model The viewer's model.
 * @returns {object[]} Per face its meshInstance and its first and last triangle. A face that
 * didn't triangulate has first > last.
 */
export function GetModelFaces (model)
{
    let faces = [];
    model.EnumerateMeshInstances ((meshInstance) => {
        for (let brepFace of meshInstance.GetMesh ().GetBrepFaces ()) {
            faces.push ({ meshInstance : meshInstance, first : brepFace.first, last : brepFace.last });
        }
    });
    return faces;
}

/**
 * Collects the triangles of a face in model coordinates, with a vertex per position and normal
 * pair.
 * @param {Mesh} mesh The face's mesh.
 * @param {Transformation} transformation Transformation of the mesh instance.
 * @param {number} firstTriangle First triangle of the face.
 * @param {number} lastTriangle Last triangle of the face.
 * @returns {{positions: number[], normals: number[], triangles: number[]}}
 */
export function CollectFaceGeometry (mesh, transformation, firstTriangle, lastTriangle)
{
    let isIdentity = transformation.IsIdentity ();
    let vertexMap = new Map ();
    let positions = [];
    let normals = [];
    let triangles = [];

    function AddVertex (vertexIndex, normalIndex)
    {
        let key = vertexIndex.toString () + '/' + (normalIndex === null ? '' : normalIndex.toString ());
        let index = vertexMap.get (key);
        if (index !== undefined) {
            return index;
        }
        let vertex = mesh.GetVertex (vertexIndex);
        let normal = normalIndex === null ? new Coord3D (0.0, 0.0, 0.0) : mesh.GetNormal (normalIndex);
        if (!isIdentity) {
            let tip = transformation.TransformCoord3D (new Coord3D (vertex.x + normal.x, vertex.y + normal.y, vertex.z + normal.z));
            vertex = transformation.TransformCoord3D (vertex);
            normal = new Coord3D (tip.x - vertex.x, tip.y - vertex.y, tip.z - vertex.z);
        }
        let length = Math.sqrt (normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
        if (length > 0.0) {
            normal = new Coord3D (normal.x / length, normal.y / length, normal.z / length);
        }
        index = positions.length / 3;
        positions.push (vertex.x, vertex.y, vertex.z);
        normals.push (normal.x, normal.y, normal.z);
        vertexMap.set (key, index);
        return index;
    }

    for (let i = firstTriangle; i <= lastTriangle; i++) {
        let triangle = mesh.GetTriangle (i);
        triangles.push (
            AddVertex (triangle.v0, triangle.n0),
            AddVertex (triangle.v1, triangle.n1),
            AddVertex (triangle.v2, triangle.n2)
        );
    }

    return { positions, normals, triangles };
}
