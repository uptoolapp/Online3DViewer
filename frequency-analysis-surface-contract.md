# Surface strain artifact: frontend contract

How a viewer decodes `surface_strain.bin` and paints its vibration strain onto the part it
displays. The producer is `frequency_analysis/app/surface.py`; `surface.read` there is the
reference decoder, and this document must change with it.

## What the data is

For every node on the exterior of the analysis mesh, the file holds:

- **strain**: the worst von Mises equivalent strain over all returned elastic modes, each mode
  scaled so its peak nodal acceleration equals `reference_acceleration_m_s2` (default 10 g).
  Dimensionless; 1e-6 is one microstrain.
- **driving mode**: which mode set that worst value, 1-based.

It ranks where a part strains when it vibrates. It is **not** a predicted strain or stress: the
analysis has no fixture, excitation or damping. UI copy should say something like "relative
vibration strain at 10 g", never "stress" or "failure".

The geometry is the finite-element surface: a triangulation of the same STEP the analysis ran on,
in that STEP's own coordinate frame, in **metres**. It is not the mesh the viewer shows. The viewer
maps the strain from this surface onto its own tessellation (see [Mapping](#mapping-onto-the-viewers-mesh)).

## Binary layout

All integers are little-endian. Sections follow each other with no padding.

| Section           | Type                                    | Count                               |
| ----------------- | --------------------------------------- | ----------------------------------- |
| magic             | 4 ASCII bytes `UPSF`                    | 1                                   |
| version           | `u32`                                   | 1                                   |
| header length `L` | `u32`                                   | 1                                   |
| header            | UTF-8 JSON                              | `L` bytes                           |
| positions         | `u16`                                   | `node_count × 3` (x, y, z per node) |
| triangles         | `u16` if `index_bytes == 2`, else `u32` | `triangle_count × 3`                |
| strain codes      | `u16`                                   | `node_count`                        |
| driving mode      | `u8`                                    | `node_count`                        |

The file ends right after the driving-mode bytes. If it doesn't, the reader has the layout wrong.

**Alignment:** `L` can be any length, so the arrays after the header are generally _not_ aligned.
`new Uint16Array(buffer, offset, n)` throws a `RangeError` at an odd offset. Copy each section out
first (`new Uint16Array(buffer.slice(offset, offset + 2 * n))`) or read it through a `DataView`.

**Versioning:** reject any `version` other than `1`. Header keys you don't recognise must be
ignored, because a later version may add some.

### Header

```jsonc
{
  "element_type": "C3D10", // "C3D10" tets, or "C3D8I" / "C3D8" octree hexes (see Caveats)
  "length_unit": "m", // always metres
  "mesh_size_m": 0.002, // FE edge length used away from features; drives the refinement below
  "reference_acceleration_m_s2": 98.0665,
  "modes": [
    // one per elastic mode, in order; driving mode k is modes[k - 1]
    {
      "frequency_hz": 412.7,
      "maximum_displacement": 0.83, // at the solver's eigenvector scale, not metres
      "peak_acceleration_m_s2": 5.58e6,
      "scale": 1.76e-5,
      "strain_energy_j": 2.1e-7, // at the reference acceleration
      "peak_strain": 1.2e-5, // largest element strain of this mode, whole solid
    },
  ],
  "stats": {
    // volume-weighted over the whole solid, not the surface
    "max": 1.2e-5,
    "p50": 4e-7,
    "p90": 1.9e-6,
    "p99": 5.1e-6,
    "p999": 8.8e-6,
    "volume_fraction_above": [
      { "strain": 2e-6, "volume_fraction": 0.09 } /* 5, 10, 20, 50 µε */,
    ],
    "volume_for_70pct_energy_mode1": 0.12,
  },
  "bbox_min_m": [-0.05, -0.01, 0.0], // position dequantization, and a unit/frame check
  "bbox_size_m": [0.1, 0.02, 0.004],
  "node_count": 18234,
  "triangle_count": 36464,
  "index_bytes": 2,
  "strain_log10_low": -8.1, // strain dequantization range, log10
  "strain_log10_high": -4.92,
}
```

`modes` and `stats` are the same records the analysis response carries, so a viewer that only has
the artifact can still show the mode table and the risk summary.

### Decoding

```
position[i][axis] = code / 65535 * bbox_size_m[axis] + bbox_min_m[axis]           // metres
strain[i]         = 10 ** (code / 65535 * (strain_log10_high - strain_log10_low) + strain_log10_low)
driving[i]        = byte                                                          // 1-based index into header.modes
```

- Position precision is `bbox_size_m / 65535` per axis, about 1.5 µm on a 100 mm part.
- Strain precision is about 0.02% relative, since it is quantized in log space.
- Nodes with exactly zero strain are stored at the smallest positive strain, `10 ** strain_log10_low`.
  Every decoded strain is positive and finite, so `log10` is safe.
- Triangles are wound counter-clockwise seen from outside, so their normals point out of the solid.

A TypeScript sketch:

```ts
const QUANTUM = 65535;

export function decodeSurfaceStrain(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (new TextDecoder().decode(buffer.slice(0, 4)) !== "UPSF")
    throw new Error("not a surface strain file");
  const version = view.getUint32(4, true);
  if (version !== 1)
    throw new Error(`unsupported surface strain version ${version}`);
  const length = view.getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder().decode(buffer.slice(12, 12 + length)),
  );
  let offset = 12 + length;
  const take = <T>(
    Ctor: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number },
    count: number,
  ): T => {
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    const array = new Ctor(buffer.slice(offset, offset + bytes)); // slice: the section may be unaligned
    offset += bytes;
    return array;
  };
  const n = header.node_count;
  const posCodes = take(Uint16Array, n * 3);
  const triangles = take(
    header.index_bytes === 2 ? Uint16Array : Uint32Array,
    header.triangle_count * 3,
  );
  const strainCodes = take(Uint16Array, n);
  const driving = take(Uint8Array, n);
  if (offset !== buffer.byteLength)
    throw new Error("surface strain file length disagrees with its header");

  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const axis = i % 3;
    positions[i] =
      (posCodes[i] / QUANTUM) * header.bbox_size_m[axis] +
      header.bbox_min_m[axis];
  }
  const span = header.strain_log10_high - header.strain_log10_low;
  const log10Strain = new Float32Array(n);
  for (let i = 0; i < n; i++)
    log10Strain[i] =
      (strainCodes[i] / QUANTUM) * span + header.strain_log10_low;
  return { header, positions, triangles, log10Strain, driving };
}
```

Keep strain as `log10` from here on. Interpolation and colouring both happen in log space.

## Mapping onto the viewer's mesh

The viewer shows its own tessellation of the STEP (Online3DViewer through occt-import-js), and that
tessellation shares no vertices with the FE surface. The strain has to be sampled onto the viewer's
vertices.

### 1. Same part, same units, same frame

The artifact is in metres and in the STEP's own frame. The viewer's mesh is in whatever unit the
importer produced (the STEP's declared unit, or millimetres). Don't assume which. Compare the
viewer mesh's bounding box with `bbox_min_m` / `bbox_size_m`:

- The size ratio should be one of 1 (m), 1000 (mm), 100 (cm), 39.37 (in), 3.281 (ft), the same on
  all three axes to within tessellation tolerance. Scale the viewer's positions to metres by it.
- After scaling, the minima should agree to within about `mesh_size_m`. The frame is not moved or
  re-centred on either side.

If no ratio fits, or the minima disagree, the artifact doesn't belong to this model. Show nothing,
not a wrong heat map. Two likely causes: the analysis ran on a different STEP for the node, or the
viewer re-centred the model. The analysis response's `input_sha256` identifies the analysed STEP;
comparing it with a SHA-256 of the bytes the viewer loaded (`crypto.subtle.digest`) is the direct
check.

### 2. Refine the viewer's triangles to the mesh size (required)

A CAD tessellation puts vertices only where curvature needs them. A flat face can be two triangles
across its whole length, so a hot spot in the middle of a wall or rib has no vertex to land on and
disappears. On a free-free beam, an 8-vertex tessellation recovered 0% of the peak strain. The same
beam refined to the mesh size recovered 100%.

Before sampling, split every viewer triangle by **longest-edge bisection** until no edge is longer
than `mesh_size_m` (converted to viewer units). Cache each edge's midpoint by its sorted vertex pair,
so neighbouring triangles share it and no T-junctions appear. Do this per face (per mesh in the
viewer's model), and cap the total vertex count as a guard against huge, finely meshed parts.
Refinement only adds vertices on the existing triangles. It doesn't change the displayed shape.

### 3. Sample each viewer vertex

For each (refined) viewer vertex `p` with normal `n`:

1. Find the closest point on the FE surface triangles, **considering only triangles whose outward
   normal agrees with `n`** (dot product > 0). Without that filter, a vertex on one side of a wall
   thinner than the FE facet deviation can snap to the triangle on the other side.
2. Interpolate `log10Strain` at the closest point with its barycentric weights.
3. Take the driving mode from the triangle corner nearest the closest point. It is categorical, so
   don't interpolate it.

Use a spatial index. The FE surface can have tens of thousands of triangles, and the viewer, after
refinement, several times that many vertices. A uniform grid with cell size `mesh_size_m` over the
FE triangles works, and so does a BVH.

Expected distances: tets have straight edges, so on a curved face the FE surface sits inside the
BREP by up to the chord sag, well under `mesh_size_m`. On the octree tier (`C3D8I` / `C3D8`) the
surface is a staircase, with distances up to about one cell. Treat a vertex farther than
`2 × mesh_size_m` from any candidate triangle as a mapping failure. More than a handful of those
means step 1 went wrong.

### 4. Colour

Map `log10Strain` to colour per vertex and let the GPU interpolate across triangles. Use a
sequential colour scale, never a rainbow one.

**Scale range, recommended:** use a fixed absolute range across parts, e.g. 1 µε to 50 µε
(`log10` −6 to −4.3), clamping outside it. Scaling to a common reference acceleration exists so
that parts and modes compare on one scale. The backend's stat thresholds (2, 5, 10, 20, 50 µε)
bracket the range where parts separate: on the 105-part corpus, 10 µε at p99.9 flagged 16 of 100
parts, all with a first mode below 1 kHz. Auto-scaling each part to its own
`strain_log10_low..high` makes every part look equally hot, so if you offer it, label it as relative.

**Edges on top:** the refined mesh lies exactly on the BREP faces, so feature edges drawn from the
same tessellation sit at the same depth as the coloured surface and flicker against it. Draw the
coloured surface with a polygon offset (or the equivalent depth bias) so the edges stay on top.

## Showing the modes

- **Hover or pick:** show the strain at the vertex in microstrain, and the driving mode's
  `frequency_hz` from `modes[driving - 1]`.
- **Mode table:** `modes` in order, with `frequency_hz` and `peak_strain`. Selecting a mode can
  highlight the vertices it drives (`driving == k`). The file holds only the envelope, so per-mode
  strain fields and mode-shape animation are not available from it.
- **Summary:** `stats.p999` and `stats.volume_fraction_above` are volume-weighted over the whole
  solid. They are the right numbers for a risk badge. Don't recompute them from the surface.

## Caveats a viewer should respect

- **Surface peaks can be lower than `stats.max` / `peak_strain`.** Those are over the whole solid,
  and the worst strain can be inside it. Take numeric peaks from the header, not from the painted
  surface.
- **Single-node spikes.** Re-entrant corners are singular, and the octree tier's staircase
  boundary adds mesh-dependent local values. A hot spot of one or two nodes with `stats.max` more
  than twice `stats.p999` is likely a spike, so consider saturating the colour scale at a
  percentile rather than at the max.
- **`C3D8` understates bending strain** because it shear-locks. It is the octree tier's fallback
  when the solver can't factor `C3D8I`. When `element_type` is `C3D8`, consider a
  "lower confidence" note.
