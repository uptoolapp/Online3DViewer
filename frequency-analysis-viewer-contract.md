# Surface strain in the viewer: host integration contract

What the frontend (the host app) must do to show the frequency-analysis hot zones on a part, and
what the Online3DViewer package guarantees in return. The file format and the mapping rules are in
[`frequency-analysis-surface-contract.md`](frequency-analysis-surface-contract.md). How the viewer
implements them is in [`source/engine/surfacestrain/README.md`](source/engine/surfacestrain/README.md).
This document must change with the public API described below.

## Scope

| Integration path                                                                                        | Surface strain                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| npm package, `import * as OV from "online-3d-viewer"`, `OV.EmbeddedViewer` (`CadModelViewerLite` in `CadModel.tsx`) | **Supported.** This contract.           |
| Prebuilt website in iframes (`/Online3DViewer/build/package/website/index.html#model=…`: Files panel, `popup.html`) | **Not supported.** No hash parameter, no UI. |
| Hidden iframe that reads the website's `ov_*` cookies                                                   | Unaffected.                             |

The website build contains the new engine code, but it has no way to receive a strain artifact.
Adding one (for example `#model=…$strain=<url>`) would be a separate change.

## Packaging

- Rebuild the package tarball the same way as today, then update `online-3d-viewer.tgz` and its
  integrity hash in `pnpm-lock.yaml`. Bump the package `version` (currently `0.0.11`) so the two
  builds can be told apart.
- `occt-import-js` stays at `0.0.22`. The `vite-plugin-static-copy` setup, the `/occt-import-js/`
  location and `OV.SetExternalLibLocation ("occt-import-js", "/occt-import-js/")` don't change.
- There are no new runtime dependencies. The TypeScript declarations (`o3dv.module.d.ts`) include
  every API below.

## Preconditions (host responsibilities)

1. **Same STEP.** The model loaded with `LoadModelFromUrlList([fileUrl])` must be the exact STEP the
   analysis ran on. The viewer checks the bounding boxes and refuses a mismatch, but two revisions of
   a part with the same bounding box would pass that check. For certainty, compare the analysis
   response's `input_sha256` with the loaded bytes: `await OV.IsSurfaceStrainSourceFile(stepArrayBuffer, input_sha256)`.
   This needs the STEP bytes, so the host fetches `fileUrl` itself for that check.
2. **Loaded through OCCT.** The part must be STEP or IGES (`.stp`, `.step`, `.igs`, `.iges`), so the
   model is in millimetres and carries BREP face ranges. Other formats still work if the model's unit
   is known or can be inferred, but they are mapped as one face per mesh.
3. **Model finished loading.** Call `ShowSurfaceStrain` only after the `onModelLoaded` callback of
   `OV.EmbeddedViewer` has fired. Before that, the call resolves with `ok: false`.
4. **The host fetches the artifact.** The viewer never fetches `surface_strain.bin`. The host
   downloads it with its own auth (`fetch(url).then(r => r.arrayBuffer())`) and passes the `ArrayBuffer`.
5. **Don't move the model.** Don't apply transforms to the loaded model. The artifact is in the
   STEP's own frame, and the check relies on that. Camera changes (`SetCamera`, projection mode,
   up vector) are fine.
6. **No unit handling.** The artifact is always in metres. The viewer converts it to the model's unit
   (mm for STEP, whatever unit the STEP declares) and checks the result. The host must not scale or
   convert anything.

## API

All names are exported from `online-3d-viewer`.

### `EmbeddedViewer.ShowSurfaceStrain (buffer, params?) → Promise<SurfaceStrainResult>`

- `buffer`: `ArrayBuffer`, the content of `surface_strain.bin`.
- `params`: optional `OV.SurfaceStrainParams`.

  | Field                   | Default                               | Meaning                                                                                         |
  | ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
  | `colorRange`            | `OV.SurfaceStrainColorRange.Absolute` | Fixed 1–50 µε scale across parts. `Relative` uses the part's own range and must be labelled as relative. |
  | `frameToleranceFactor`  | `2.0`                                 | Allowed bounding box difference, in FE mesh sizes.                                               |
  | `maxFailedFraction`     | `0.005`                               | The mapping fails if more vertices than this can't reach the FE surface.                         |
  | `mappingParams.maxVertexCount` | `4000000`                      | Refinement budget.                                                                               |

- The promise **never rejects**. Failures resolve with `ok: false`.
- Any previous overlay is removed first.

`SurfaceStrainResult`:

| Field        | Type                           | Meaning                                                                                  |
| ------------ | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `ok`         | `boolean`                      | `true` means the overlay is shown.                                                        |
| `reason`     | `string \| null`               | Why nothing is shown. English text for logs, not for end users.                           |
| `header`     | `object \| null`               | The artifact's JSON header, set whenever decoding succeeded, even when `ok` is `false`.   |
| `unit`       | `OV.Unit \| null`              | The unit the artifact was converted to, `OV.Unit.Millimeter` for STEP.                    |
| `mapping`    | `SurfaceStrainMapping \| null` | `vertexCount`, `failedCount`, `capped`. For diagnostics.                                  |
| `colorScale` | `SurfaceStrainColorScale \| null` | Use it to draw the legend, see [Legend](#legend).                                      |

Failure reasons the host may see (the texts aren't stable, don't parse them):

- The file is invalid: bad magic, unsupported version, or a length that disagrees with the header.
- `no model is loaded`, or `the model is empty`.
- `unit mismatch, …`: the artifact fits the model only in another unit.
- `bounding box size differs …`, or `bounding box position differs …`: another part, or a moved model.
- `N of M vertices are farther than …`: the surfaces don't line up.

When `ok` is `false`, **show nothing on the model**. Show a neutral message such as "Vibration map
unavailable for this file". Never fall back to a guessed heat map.

### `EmbeddedViewer.ClearSurfaceStrain ()`

Removes the overlay and shows the model's own colours again. Safe to call at any time.

### `EmbeddedViewer.GetViewer ().SetSurfaceStrainHighlightedMode (mode)`

`mode` is a 1-based index into `header.modes`, or `null` for every mode. Vertices driven by other
modes turn light grey. Does nothing without an overlay.

### `EmbeddedViewer.GetViewer ().GetSurfaceStrainUnderMouse ({ x, y }) → value | null`

`x` and `y` are **CSS pixels relative to the viewer canvas** (for example
`event.clientX - canvas.getBoundingClientRect ().left`). Returns `null` off the part or without an
overlay. Otherwise it returns:

```ts
{ log10Strain: number, microstrain: number, mode: number, frequencyHz: number | null }
```

### `OV.IsSurfaceStrainSourceFile (stepArrayBuffer, sha256Hex) → Promise<boolean>`

This is the optional SHA-256 check from precondition 1.

## Lifecycle

```
new OV.EmbeddedViewer (container, { onModelLoaded })
        │
LoadModelFromUrlList ([fileUrl])
        │
onModelLoaded ──► fetch surface_strain.bin ──► ShowSurfaceStrain (buffer)
                                                    │
                                   ok ──► legend, mode table, hover
                                   !ok ─► neutral message, log reason
        │
LoadModelFromUrlList (another file)  ──► the overlay is cleared automatically
Destroy ()                           ──► everything is freed
```

- Loading a new model always clears the overlay. Call `ShowSurfaceStrain` again after the next
  `onModelLoaded`.
- Applying edge settings or projection mode from the `ov_*` cookies is safe before or after
  `ShowSurfaceStrain`. Edges stay visible on top of the overlay.
- While the overlay is shown, the model's own meshes are hidden. `GetMeshUserDataUnderMouse`,
  `GetMeshIntersectionUnderMouse` and the measure tool don't hit anything. Use
  `GetSurfaceStrainUnderMouse` instead.

## Performance

The mapping runs on the main thread after one `setTimeout`, so the page can paint a loading state
first. Measured on a 5 m assembly with 18 meshes: 1–2 s at a 20 mm FE mesh size, and about 6 s
at 1 mm, where the 4M-vertex budget is reached (`mapping.capped` is `true`). Show a spinner until
the promise resolves. Typical parts with a few mm mesh size fall between those numbers.

## Legend

Draw the legend from the returned scale, so it always matches the overlay:

```ts
const { log10Low, log10High } = result.colorScale;   // absolute: -6 and log10(50e-6)
const rgb = [0, 0, 0];
result.colorScale.GetColor (log10Value, rgb, 0);      // float RGB in 0..1
```

- Label the ends in microstrain, `10 ** log10 * 1e6`: 1 µε and 50 µε for the absolute range.
  Values outside the range are clamped.
- Grey (`OV.SurfaceStrainMissingColor`) marks vertices that couldn't be mapped. Light grey
  (`OV.SurfaceStrainDimmedColor`) marks vertices dimmed by mode highlighting.

## UI requirements

These come from the artifact contract, and the host owns them:

- **Wording.** Use "Relative vibration strain at 10 g", computed from
  `header.reference_acceleration_m_s2 / 9.80665`. Never say "stress", "failure" or "predicted strain".
- **Mode table.** Show `header.modes` in order, with `frequency_hz` and `peak_strain`. Selecting a
  row calls `SetSurfaceStrainHighlightedMode (index + 1)`.
- **Risk badge.** Use `header.stats.p999` and `header.stats.volume_fraction_above`. These are
  volume-weighted over the whole solid. Never recompute peaks from the painted surface or the hover
  values.
- **Hover.** Show `microstrain` (2 significant digits) and the driving mode's `frequencyHz`.
- **Low confidence.** When `header.element_type === "C3D8"`, show a lower-confidence note.
- **Relative range.** If offered, it must be labelled as relative.

## Example (CadModelViewerLite)

```ts
import * as OV from "online-3d-viewer";

const viewer = new OV.EmbeddedViewer(container, {
  onModelLoaded: async () => {
    const buffer = await fetch(strainUrl, { credentials: "include" }).then((r) => r.arrayBuffer());
    const result = await viewer.ShowSurfaceStrain(buffer);
    if (!result.ok) {
      console.warn("surface strain not shown:", result.reason);
      setStrainState({ status: "unavailable" });
      return;
    }
    setStrainState({ status: "shown", header: result.header, scale: result.colorScale });
  },
});
viewer.LoadModelFromUrlList([fileUrl]);

const canvas = container.querySelector("canvas")!;
canvas.addEventListener("mousemove", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const value = viewer.GetViewer().GetSurfaceStrainUnderMouse({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  setHover(value); // null clears the tooltip
});
```

## Compatibility

- **Non-breaking.** Existing calls behave as before. The OCCT importer now also stores the BREP face
  ranges on each mesh (`Mesh.GetBrepFaces ()`), which changes nothing else.
- **Versioning.** Only artifact version `1` is accepted. A newer artifact version resolves with
  `ok: false`, and it needs a package update. New header keys are ignored.
