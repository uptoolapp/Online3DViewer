// Longest-edge bisection of a triangle mesh until no edge is longer than a given length.
//
// A CAD tessellation has vertices only where curvature needs them, so a hot spot in the middle of
// a flat wall has no vertex to land on. Refining the viewer's triangles to the FE mesh size gives
// every hot spot a vertex. Only edges longer than the limit are ever split, and every such edge is
// split in every triangle that uses it, at the same cached midpoint, so the result is conforming
// (no T-junctions). The shape doesn't change, new vertices are on the existing triangles.

const MidpointKeyBase = 67108864; // 2^26, keeps min * base + max below 2^53

export class RefinementBudget
{
    constructor (maxVertexCount)
    {
        this.maxVertexCount = maxVertexCount;
        this.vertexCount = 0;
        this.capped = false;
    }

    CanAddVertex ()
    {
        if (this.vertexCount >= this.maxVertexCount) {
            this.capped = true;
            return false;
        }
        return true;
    }
}

export class RefinedTriangles
{
    constructor (positions, normals, triangles)
    {
        this.positions = positions;
        this.normals = normals;
        this.triangles = triangles;
    }

    VertexCount ()
    {
        return this.positions.length / 3;
    }
}

/**
 * Refines triangles by longest-edge bisection.
 * @param {number[]} positions Vertex positions, x, y, z per vertex.
 * @param {number[]} normals Vertex normals, x, y, z per vertex.
 * @param {number[]} triangles Vertex indices, three per triangle.
 * @param {number} maxEdgeLength No edge of the result is longer than this.
 * @param {RefinementBudget} [budget] Shared vertex budget, refinement stops when it runs out.
 * @returns {RefinedTriangles}
 */
export function RefineTriangles (positions, normals, triangles, maxEdgeLength, budget)
{
    let outPositions = Array.from (positions);
    let outNormals = Array.from (normals);
    let outTriangles = [];
    let midpoints = new Map ();
    let maxEdgeLengthSquared = maxEdgeLength * maxEdgeLength;
    if (budget) {
        budget.vertexCount += positions.length / 3;
    }

    function EdgeLengthSquared (a, b)
    {
        let dx = outPositions[a * 3] - outPositions[b * 3];
        let dy = outPositions[a * 3 + 1] - outPositions[b * 3 + 1];
        let dz = outPositions[a * 3 + 2] - outPositions[b * 3 + 2];
        return dx * dx + dy * dy + dz * dz;
    }

    function GetMidpoint (a, b)
    {
        let key = (a < b) ? a * MidpointKeyBase + b : b * MidpointKeyBase + a;
        let index = midpoints.get (key);
        if (index !== undefined) {
            return index;
        }
        if (budget && !budget.CanAddVertex ()) {
            return null;
        }
        index = outPositions.length / 3;
        for (let i = 0; i < 3; i++) {
            outPositions.push ((outPositions[a * 3 + i] + outPositions[b * 3 + i]) * 0.5);
        }
        let nx = outNormals[a * 3] + outNormals[b * 3];
        let ny = outNormals[a * 3 + 1] + outNormals[b * 3 + 1];
        let nz = outNormals[a * 3 + 2] + outNormals[b * 3 + 2];
        let length = Math.sqrt (nx * nx + ny * ny + nz * nz);
        if (length > 0.0) {
            outNormals.push (nx / length, ny / length, nz / length);
        } else {
            outNormals.push (outNormals[a * 3], outNormals[a * 3 + 1], outNormals[a * 3 + 2]);
        }
        midpoints.set (key, index);
        if (budget) {
            budget.vertexCount += 1;
        }
        return index;
    }

    let stack = [];
    for (let i = triangles.length - 3; i >= 0; i -= 3) {
        stack.push (triangles[i], triangles[i + 1], triangles[i + 2]);
    }
    while (stack.length > 0) {
        let c = stack.pop ();
        let b = stack.pop ();
        let a = stack.pop ();
        let ab = EdgeLengthSquared (a, b);
        let bc = EdgeLengthSquared (b, c);
        let ca = EdgeLengthSquared (c, a);
        let longest = Math.max (ab, bc, ca);
        if (longest <= maxEdgeLengthSquared) {
            outTriangles.push (a, b, c);
            continue;
        }
        // Rotate so the longest edge is a-b, which keeps the winding of the children.
        if (bc === longest) {
            [a, b, c] = [b, c, a];
        } else if (ca === longest) {
            [a, b, c] = [c, a, b];
        }
        let m = GetMidpoint (a, b);
        if (m === null) {
            outTriangles.push (a, b, c);
            continue;
        }
        stack.push (a, m, c);
        stack.push (m, b, c);
    }

    return new RefinedTriangles (outPositions, outNormals, outTriangles);
}
