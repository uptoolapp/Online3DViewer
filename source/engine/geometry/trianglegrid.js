// Uniform grid over a triangle soup for closest point queries. Used by the surface strain mapping
// (FE triangles) and the edge highlights (the model's own triangles), so it holds geometry only.

export class TriangleGridHit
{
    constructor ()
    {
        this.triangle = -1;
        // Barycentric weights of the closest point, for the triangle's three corners.
        this.u = 0.0;
        this.v = 0.0;
        this.w = 0.0;
        this.distance = Infinity;
    }
}

/**
 * Uniform grid over a triangle soup that finds the closest point of the triangles to a point.
 */
export class TriangleGrid
{
    /**
     * @param {Float32Array|Float64Array} positions x, y, z of the vertices.
     * @param {Uint32Array|Uint16Array|null} triangles Three vertex indices per triangle. Null means
     * every three consecutive vertices form a triangle, which saves the index array.
     * @param {number[]} bboxMin Minimum of the bounding box of the triangles.
     * @param {number[]} bboxSize Size of the bounding box of the triangles.
     * @param {number} cellSize Grid cell size.
     * @param {boolean} storeNormals Keep the triangle normals for the normal filter of FindClosest.
     */
    constructor (positions, triangles, bboxMin, bboxSize, cellSize, storeNormals)
    {
        this.positions = positions;
        this.triangles = triangles;
        let triangleCount = (triangles !== null ? triangles.length : positions.length / 3) / 3;
        this.cellSize = cellSize;

        this.origin = [];
        this.dims = [];
        for (let axis = 0; axis < 3; axis++) {
            this.origin.push (bboxMin[axis] - this.cellSize);
            this.dims.push (Math.ceil (bboxSize[axis] / this.cellSize) + 3);
        }

        this.normals = storeNormals ? new Float64Array (triangleCount * 3) : null;
        this.cells = new Map ();
        this.visitStamps = new Uint32Array (triangleCount);
        this.currentStamp = 0;

        let planeNormal = [0.0, 0.0, 0.0];
        for (let t = 0; t < triangleCount; t++) {
            let a = this.VertexOffset (t, 0);
            let b = this.VertexOffset (t, 1);
            let c = this.VertexOffset (t, 2);

            let abx = positions[b] - positions[a];
            let aby = positions[b + 1] - positions[a + 1];
            let abz = positions[b + 2] - positions[a + 2];
            let acx = positions[c] - positions[a];
            let acy = positions[c + 1] - positions[a + 1];
            let acz = positions[c + 2] - positions[a + 2];
            let nx = aby * acz - abz * acy;
            let ny = abz * acx - abx * acz;
            let nz = abx * acy - aby * acx;
            let length = Math.sqrt (nx * nx + ny * ny + nz * nz);
            planeNormal[0] = 0.0;
            planeNormal[1] = 0.0;
            planeNormal[2] = 0.0;
            if (length > 0.0) {
                planeNormal[0] = nx / length;
                planeNormal[1] = ny / length;
                planeNormal[2] = nz / length;
            }
            if (this.normals !== null) {
                this.normals[t * 3] = planeNormal[0];
                this.normals[t * 3 + 1] = planeNormal[1];
                this.normals[t * 3 + 2] = planeNormal[2];
            }

            let min = [];
            let max = [];
            for (let axis = 0; axis < 3; axis++) {
                let lo = Math.min (positions[a + axis], positions[b + axis], positions[c + axis]);
                let hi = Math.max (positions[a + axis], positions[b + axis], positions[c + axis]);
                min.push (this.CellCoord (lo, axis));
                max.push (this.CellCoord (hi, axis));
            }
            // A slanted triangle's bounding box covers far more cells than the triangle itself,
            // so only keep the cells the triangle's plane passes through.
            let checkPlane = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1) > 8;
            let halfDiagonal = this.cellSize * Math.sqrt (3.0) * 0.5;
            for (let ix = min[0]; ix <= max[0]; ix++) {
                for (let iy = min[1]; iy <= max[1]; iy++) {
                    for (let iz = min[2]; iz <= max[2]; iz++) {
                        if (checkPlane) {
                            let dx = this.origin[0] + (ix + 0.5) * this.cellSize - positions[a];
                            let dy = this.origin[1] + (iy + 0.5) * this.cellSize - positions[a + 1];
                            let dz = this.origin[2] + (iz + 0.5) * this.cellSize - positions[a + 2];
                            if (Math.abs (planeNormal[0] * dx + planeNormal[1] * dy + planeNormal[2] * dz) > halfDiagonal) {
                                continue;
                            }
                        }
                        let key = this.CellKey (ix, iy, iz);
                        let cell = this.cells.get (key);
                        if (cell === undefined) {
                            cell = [];
                            this.cells.set (key, cell);
                        }
                        cell.push (t);
                    }
                }
            }
        }

        this.barycentric = new Float64Array (3);
    }

    /**
     * Returns the index of a triangle's corner vertex.
     */
    VertexIndex (triangle, corner)
    {
        return this.triangles !== null ? this.triangles[triangle * 3 + corner] : triangle * 3 + corner;
    }

    VertexOffset (triangle, corner)
    {
        return this.VertexIndex (triangle, corner) * 3;
    }

    CellCoord (value, axis)
    {
        let coord = Math.floor ((value - this.origin[axis]) / this.cellSize);
        return Math.min (Math.max (coord, 0), this.dims[axis] - 1);
    }

    CellKey (ix, iy, iz)
    {
        return ix + this.dims[0] * (iy + this.dims[1] * iz);
    }

    /**
     * Finds the closest triangle, optionally only among the triangles whose normal agrees with
     * the given normal.
     * @param {number} px @param {number} py @param {number} pz Query point.
     * @param {number} nx @param {number} ny @param {number} nz Normal at the query point, a zero
     * normal disables the normal filter. The grid must store normals to use the filter.
     * @param {number} maxDistance Triangles farther than this are ignored.
     * @param {TriangleGridHit} hit Filled with the closest point.
     * @returns {boolean} False if no candidate triangle is within maxDistance.
     */
    FindClosest (px, py, pz, nx, ny, nz, maxDistance, hit)
    {
        let positions = this.positions;
        let normals = this.normals;
        let bary = this.barycentric;
        let filterNormals = (normals !== null && (nx !== 0.0 || ny !== 0.0 || nz !== 0.0));

        this.currentStamp += 1;
        if (this.currentStamp === 0xFFFFFFFF) {
            this.visitStamps.fill (0);
            this.currentStamp = 1;
        }
        let stamp = this.currentStamp;

        let cx = Math.floor ((px - this.origin[0]) / this.cellSize);
        let cy = Math.floor ((py - this.origin[1]) / this.cellSize);
        let cz = Math.floor ((pz - this.origin[2]) / this.cellSize);
        let maxRing = Math.ceil (maxDistance / this.cellSize) + 1;

        let bestDistanceSquared = maxDistance * maxDistance;
        let bestTriangle = -1;
        let bestU = 0.0, bestV = 0.0, bestW = 0.0;

        for (let ring = 0; ring <= maxRing; ring++) {
            for (let ix = cx - ring; ix <= cx + ring; ix++) {
                if (ix < 0 || ix >= this.dims[0]) {
                    continue;
                }
                for (let iy = cy - ring; iy <= cy + ring; iy++) {
                    if (iy < 0 || iy >= this.dims[1]) {
                        continue;
                    }
                    let onShellXY = (Math.abs (ix - cx) === ring || Math.abs (iy - cy) === ring);
                    let zStep = onShellXY ? 1 : 2 * ring;
                    for (let iz = cz - ring; iz <= cz + ring; iz += (zStep > 0 ? zStep : 1)) {
                        if (iz < 0 || iz >= this.dims[2]) {
                            continue;
                        }
                        let cell = this.cells.get (this.CellKey (ix, iy, iz));
                        if (cell === undefined) {
                            continue;
                        }
                        for (let t of cell) {
                            if (this.visitStamps[t] === stamp) {
                                continue;
                            }
                            this.visitStamps[t] = stamp;
                            if (filterNormals && normals[t * 3] * nx + normals[t * 3 + 1] * ny + normals[t * 3 + 2] * nz <= 0.0) {
                                continue;
                            }
                            let a = this.VertexOffset (t, 0);
                            let b = this.VertexOffset (t, 1);
                            let c = this.VertexOffset (t, 2);
                            let distanceSquared = ClosestPointOnTriangle (positions, a, b, c, px, py, pz, bary);
                            if (distanceSquared < bestDistanceSquared) {
                                bestDistanceSquared = distanceSquared;
                                bestTriangle = t;
                                bestU = bary[0];
                                bestV = bary[1];
                                bestW = bary[2];
                            }
                        }
                    }
                }
            }
            // Every triangle not examined yet is outside the block of rings, at least ring cells away.
            if (bestTriangle !== -1 && bestDistanceSquared <= (ring * this.cellSize) * (ring * this.cellSize)) {
                break;
            }
        }

        hit.triangle = bestTriangle;
        if (bestTriangle === -1) {
            hit.distance = Infinity;
            return false;
        }
        hit.u = bestU;
        hit.v = bestV;
        hit.w = bestW;
        hit.distance = Math.sqrt (bestDistanceSquared);
        return true;
    }
}

// Closest point on triangle (a, b, c) to p, from Ericson: Real-Time Collision Detection 5.1.5.
// a, b and c are offsets into positions. Writes the barycentric weights of the closest point
// into bary and returns the squared distance.
function ClosestPointOnTriangle (positions, a, b, c, px, py, pz, bary)
{
    let ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    let bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    let cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];

    let abx = bx - ax, aby = by - ay, abz = bz - az;
    let acx = cx - ax, acy = cy - ay, acz = cz - az;
    let apx = px - ax, apy = py - ay, apz = pz - az;

    let u = 0.0, v = 0.0, w = 0.0;
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    let bpx = px - bx, bpy = py - by, bpz = pz - bz;
    let d3 = abx * bpx + aby * bpy + abz * bpz;
    let d4 = acx * bpx + acy * bpy + acz * bpz;
    let cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    let d5 = abx * cpx + aby * cpy + abz * cpz;
    let d6 = acx * cpx + acy * cpy + acz * cpz;
    let vc = d1 * d4 - d3 * d2;
    let vb = d5 * d2 - d1 * d6;
    let va = d3 * d6 - d5 * d4;

    if (d1 <= 0.0 && d2 <= 0.0) {
        u = 1.0;
    } else if (d3 >= 0.0 && d4 <= d3) {
        v = 1.0;
    } else if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
        v = d1 / (d1 - d3);
        u = 1.0 - v;
    } else if (d6 >= 0.0 && d5 <= d6) {
        w = 1.0;
    } else if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
        w = d2 / (d2 - d6);
        u = 1.0 - w;
    } else if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        v = 1.0 - w;
    } else {
        let denom = va + vb + vc;
        if (denom === 0.0) {
            // Degenerate triangle, fall back to the first corner.
            u = 1.0;
        } else {
            v = vb / denom;
            w = vc / denom;
            u = 1.0 - v - w;
        }
    }

    bary[0] = u;
    bary[1] = v;
    bary[2] = w;
    let qx = u * ax + v * bx + w * cx - px;
    let qy = u * ay + v * by + w * cy - py;
    let qz = u * az + v * bz + w * cz - pz;
    return qx * qx + qy * qy + qz * qz;
}
