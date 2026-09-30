# Surface strain hot zones: architecture

How the viewer paints the vibration strain from `surface_strain.bin` onto the STEP it displays.
The file format and the mapping rules are defined in
[`frequency-analysis-surface-contract.md`](../../../frequency-analysis-surface-contract.md). This
document describes how the viewer implements them.

Two points drive the design:

- **Mapping direction.** The strain goes from the FE surface in the bin to the viewer's BREP
  surface mesh. The FE surface is never displayed. Every vertex of every BREP face (after
  refinement) samples the FE surface.
- **Units.** The bin is always in metres. The viewer's model is in its own unit. For STEP and IGES
  that is always millimetres, because `ImporterOcct` asks occt-import-js for `linearUnit: 'millimeter'`
  and OCCT converts from the STEP's declared unit. Every length in the bin is converted to
  `model.GetUnit()` once, right after decoding, and the result is checked against the model's
  bounding box before anything is painted.

## Diagram

```
 HOST APP (uptool)
 ─────────────────────────────────────────────────────────────────────────────
   embeddedViewer.LoadModelFromUrlList([step])          ──► (existing load path)
   embeddedViewer.ShowSurfaceStrain(binArrayBuffer)     ──► Promise<SurfaceStrainResult>
   viewer.GetSurfaceStrainUnderMouse(xy) / SetSurfaceStrainHighlightedMode(k)
                                   │
 ══════════════════════════════════╪═════════════════════════════════════════
 IMPORT (existing, one change)     │
                                   │
   STEP bytes ─► occt-import-js ─► ImporterOcct.ImportMesh
                (linearUnit: mm)        │  NEW: mesh.SetBrepFaces([{first,last},...])
                                        ▼
                                  OV.Model  (unit = mm, triangles in BREP-face order)
                                        │
 ═══════════════════════════════════════╪════════════════════════════════════
 PURE PIPELINE   source/engine/surfacestrain/        surfacestrain.js:PrepareSurfaceStrain
                                        │
   surface_strain.bin                   │
        │                               │
        ▼                               │
   ① DecodeSurfaceStrain               │          surfacestraindecoder.js
      UPSF / v1 / header / slice()      │
      → positions (m), triangles,       │
        log10Strain, driving            │
        │                               │
        ▼                               ▼
   ② MatchSurfaceStrainFrame(header, GetBoundingBox(model), model.GetUnit())
      bbox_m × scale(m→mm = 1000)  vs  viewer bbox     surfacestrainframe.js
      |Δsize|, |Δmin| ≤ 2·mesh_size  ──✗──► {ok:false, reason:"unit mismatch…"}
        │ ✓ unit = mm                                  (nothing is painted)
        ▼
   ③ ConvertSurfaceStrainToUnit(data, mm)             surfacestrainunits.js
      positions ×1000, bbox ×1000, meshSize = 2 mm
      ── from here on, everything is in model units; no metres ──
        │
        ▼
   ④ MapSurfaceStrainToModel(model, geometry)          surfacestrainsampler.js
      │
      ├─ SurfaceStrainIndex: uniform grid (cell = meshSize) over FE triangles,
      │                      outward normals precomputed
      │
      └─ for each MeshInstance ─► for each BREP face range:
            CollectFaceGeometry  (apply node transform, per-face normals)
                  │
                  ▼
            RefineTriangles      longest-edge bisection ≤ meshSize   surfacestrainrefine.js
            (shared midpoints → no T-junctions, 4M vertex budget)
                  │
                  ▼
            index.Sample(p, n) per refined vertex
              rings of grid cells out to 2·meshSize
              skip FE tris with dot(nFE, n) ≤ 0   ← thin-wall guard
              closest point (Ericson) → barycentric log10 strain
              driving mode = nearest FE corner    (categorical)
              none found → NaN, counted as failure
      │
      ▼
   SurfaceStrainMapping { meshes[ positions, normals, indices, log10[], mode[] ],
                          vertexCount, failedCount, capped }
      failed > 0.5% ──► {ok:false}
        │
        ▼
   ⑤ SurfaceStrainColorScale                           surfacestraincolor.js
      viridis LUT, absolute −6 … −4.3 (1–50 µε) or relative
        │
 ═══════╪════════════════════════════════════════════════════════════════════
 VIEWER │         source/engine/viewer/
        ▼
   Viewer.SetSurfaceStrain(mapping, header, colorScale)             viewer.js
     ├─ surfaceStrainModel  (own ViewerModel, separate from extraModel,
     │                       so the measure tool's ClearExtra won't wipe it)
     │     └─ ViewerSurfaceStrain.CreateThreeObject    viewersurfacestrain.js
     │          one indexed BufferGeometry per instance, color attribute,
     │          userData.surfaceStrain = mesh result (for picking)
     ├─ SetMainMeshesVisible(false)   original meshes hidden, edges kept
     ├─ SetSurfaceStrainHighlightedMode(k) → rewrite colors, dim mode ≠ k
     └─ GetSurfaceStrainUnderMouse → raycast overlay → barycentric log10
                                     → {microstrain, mode, frequencyHz}
```

## Walkthrough

### Import

OCCT tessellates in millimetres. `ImporterOcct.ImportMesh` now also stores the triangle range of
every BREP face on the mesh (`Mesh.SetBrepFaces`, copied by `Mesh.Clone`). Model finalization never
reorders triangles, so the ranges stay valid on the `Model`. The three.js conversion (`threeconverter.js`)
does reorder triangles by material, so every later step reads the `Model`, not the three.js geometry.
A mesh without face ranges (any non-OCCT importer) is treated as a single face.

### ① Decode: `surfacestraindecoder.js`

`DecodeSurfaceStrain` ports the contract's decoder:

- It checks the magic `UPSF`, rejects any version other than 1, and ignores header keys it doesn't know.
- Every section is copied out with `buffer.slice()`, because an odd header length leaves the arrays unaligned.
- It throws if the file length disagrees with the header.

Positions are still in **metres** here. Strain is kept as `log10` from here on.

### ② Frame and unit check: `surfacestrainframe.js`

This step runs before any conversion or mapping. It uses the bin's `bbox_min_m`, `bbox_size_m` and
`mesh_size_m`:

- `scale = convertUnit(1 m → model.GetUnit())`, which is 1000 for STEP.
- Scaled bin size and model size must agree on every axis within `2 × mesh_size`.
- Scaled bin minimum and model minimum must agree the same way. Neither side is ever re-centred.
- On failure it tries the other supported units (m, mm, cm, in, ft), only to write a clear reason,
  for example `unit mismatch, the artifact fits the model only if the model were in m, but the model is in mm`.
- For a model with an unknown unit, it infers the unit by trying each candidate in turn.

Nothing downstream runs unless this passes, so a wrongly scaled or foreign artifact is never
painted. `IsSurfaceStrainSourceFile(bytes, input_sha256)` is available for the stronger SHA-256 check.

### ③ Convert once: `surfacestrainunits.js`

`ConvertSurfaceStrainToUnit` multiplies every length into model units in one place: positions,
bounding box and `meshSize`. Strain is dimensionless and is not scaled. Refinement, search radius and
failure distance all use `geometry.meshSize` in model units, so no other code deals with metres.

### ④ Map onto BREP faces: `surfacestrainsampler.js`, `surfacestrainrefine.js`

`MapSurfaceStrainToModel` walks every mesh instance and every BREP face range:

1. **Collect.** It gathers the face's vertices with the node transform applied, keeping per-face normals.
2. **Refine.** `RefineTriangles` splits each triangle along its longest edge until no edge is longer
   than `meshSize`. Midpoints are cached per edge, so neighbouring triangles share them and there
   are no T-junctions. A shared 4M-vertex budget guards against huge parts, and when it runs out
   the result reports `capped`. Refining face by face keeps normals from being averaged across
   face edges, and it gives hot spots in the middle of flat walls a vertex to land on.
3. **Sample.** `SurfaceStrainIndex` is a uniform grid with cell size `meshSize` over the FE triangles.
   A triangle only goes into the cells its plane passes through. Without that, large slanted
   triangles filled their whole 3D bounding box, and one test file took 207 s instead of under 1 s.
   For each refined vertex `p` with normal `n`:
   - It searches rings of grid cells out to `2 × meshSize`, and stops early once no unexamined
     triangle can be closer.
   - It skips FE triangles whose outward normal disagrees with `n`. This guards thin walls.
   - The closest point on a triangle (Ericson) gives barycentric weights, and the three corners'
     `log10` strain values are interpolated with them.
   - The driving mode comes from the FE corner nearest the closest point. It is categorical, so it
     isn't interpolated.
   - A vertex with no candidate gets `NaN` and counts as a failure.

If more than 0.5% of the vertices fail, the whole result is `{ok: false}`.

### ⑤ Colour: `surfacestraincolor.js`

This is a sequential viridis scale, never a rainbow. By default the range is fixed across parts
(`log10` −6 to −4.3, which is 1–50 µε) and values outside it are clamped. The relative range uses
the part's own `strain_log10_low..high` and must be labelled as relative in the UI. Failed vertices
are grey.

### Viewer overlay: `viewer.js`, `viewersurfacestrain.js`

`Viewer.SetSurfaceStrain` builds one indexed `BufferGeometry` per mesh instance, with position,
normal and colour attributes, and adds them to a dedicated `surfaceStrainModel`. That model is
separate from `extraModel`, so the measure tool's `ClearExtra` doesn't remove the overlay. The
original meshes are hidden and the edges stay visible. `ClearSurfaceStrain()` removes the overlay
and shows the originals again. Nothing in the model is changed.

- `SetSurfaceStrainHighlightedMode(k)` rewrites the colour attribute and greys out vertices whose
  driving mode isn't `k`.
- `GetSurfaceStrainUnderMouse(xy)` raycasts the overlay, interpolates `log10` at the hit with the
  hit triangle's barycentrics, and returns `{ log10Strain, microstrain, mode, frequencyHz }`.

## Host API

```js
let result = await embeddedViewer.ShowSurfaceStrain (binArrayBuffer, params);  // params: OV.SurfaceStrainParams, optional
if (!result.ok) {
    console.warn (result.reason);          // nothing is painted
} else {
    result.header.modes;                   // mode table: frequency_hz, peak_strain
    result.header.stats;                   // risk badge: p999, volume_fraction_above
    result.header.element_type;            // "C3D8" means lower confidence
}
embeddedViewer.GetViewer ().SetSurfaceStrainHighlightedMode (2);
embeddedViewer.GetViewer ().GetSurfaceStrainUnderMouse ({ x, y });
embeddedViewer.ClearSurfaceStrain ();
```

The host owns the UI text. Use wording like "relative vibration strain at 10 g", never "stress" or
"failure". Take numeric peaks from `header.stats` and `header.modes`, not from the painted surface.

## Design notes

- **Testable.** Steps ① to ⑤ are pure JavaScript with no THREE or DOM code. They run in mocha
  (`test/tests/surfacestrain_test.js`) and in Node against real OCCT tessellations.
- **Fails safe.** Every failure path returns `{ok: false, reason}` before anything is drawn.
- **Small footprint.** The only existing code touched is `ImporterOcct` (face ranges), `Mesh` (the
  field and its clone), and the `Viewer` and `EmbeddedViewer` APIs.

## Known limitations

- The mapping runs on the main thread, so very large parts block the page for a few seconds.
  Moving it into a Web Worker would fix that.
- While the overlay is shown, the original meshes are hidden, so ordinary picking and the measure
  tool don't hit them. Use `GetSurfaceStrainUnderMouse` on the overlay instead.
- It has been verified with synthetic artifacts and OCCT tessellations standing in for the FE
  surface, but not yet with a `surface_strain.bin` from the analysis service.

## Trying it

```
npm run build_engine_dev && npx http-server
```

Open `sandbox/embed_surface_strain.html`, then choose a STEP file and its `surface_strain.bin`.
