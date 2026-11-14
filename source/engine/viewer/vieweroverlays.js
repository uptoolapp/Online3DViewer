import { EdgeHighlightResult, PrepareEdgeHighlights } from '../edgehighlight/edgehighlight.js';
import { CountLongReach, LongReachParams, LongReachResult, ParseLongReachDisplay, PrepareLongReach } from '../longreach/longreach.js';
import { PrepareSurfaceStrain, SurfaceStrainParams, SurfaceStrainResult } from '../surfacestrain/surfacestrain.js';
import { CreateSurfaceStrainColorScale } from '../surfacestrain/surfacestraincolor.js';

/**
 * Draws the surface strain, the long reach findings and the edge highlights of a model on a
 * {@link Viewer}. It is shared by {@link EmbeddedViewer} and the website, see their methods with
 * the same names for details.
 */
export class ViewerOverlays
{
    /**
     * @param {Viewer} viewer The viewer to draw on.
     */
    constructor (viewer)
    {
        this.viewer = viewer;
        this.model = null;
        this.surfaceStrainHeader = null;
        // The decoded file of the long reach findings shown.
        this.longReachData = null;
        // Per overlay that maps on the model, bumped whenever its pending show must not paint
        // anymore: the model changed, the overlay was cleared, or the viewer was destroyed.
        this.requests = {
            surfaceStrain : 0,
            longReach : 0
        };
    }

    /**
     * Sets the model the overlays belong to. It must be called with null when a new model starts
     * loading and with the model when it is shown. The viewer is cleared by its owner.
     * @param {Model} model The shown model or null.
     */
    SetModel (model)
    {
        this.model = model;
        this.surfaceStrainHeader = null;
        this.longReachData = null;
        for (let kind of Object.keys (this.requests)) {
            this.requests[kind] += 1;
        }
    }

    /**
     * @returns {boolean} True if a model is set.
     */
    HasModel ()
    {
        return this.model !== null;
    }

    /**
     * Runs an overlay's mapping on the model once the browser had a chance to render, because the
     * mapping blocks the main thread. The promise never rejects: a missing model, a model change
     * or a clear of the overlay in the meantime, and an exception resolve with ok false.
     * @param {string} kind Key of this.requests.
     * @param {string} name Name of the overlay in the reasons.
     * @param {Function} ResultClass Result class, with ok and reason.
     * @param {Function} run Gets the model and returns the result.
     * @returns {Promise}
     */
    RunMapping (kind, name, ResultClass, run)
    {
        return new Promise ((resolve) => {
            let Fail = (reason) => {
                let result = new ResultClass ();
                result.reason = reason;
                resolve (result);
            };
            if (this.model === null) {
                Fail ('no model is loaded');
                return;
            }
            let model = this.model;
            let request = this.requests[kind];
            setTimeout (() => {
                if (request !== this.requests[kind] || this.model !== model) {
                    Fail ('the model changed or the ' + name + ' was cleared before it was shown');
                    return;
                }
                try {
                    resolve (run (model));
                } catch (error) {
                    Fail (error.message);
                }
            }, 0);
        });
    }

    /**
     * See {@link EmbeddedViewer#ShowSurfaceStrain}.
     * @param {ArrayBuffer} buffer Content of surface_strain.bin.
     * @param {SurfaceStrainParams} [params] Parameters.
     * @returns {Promise<SurfaceStrainResult>} Resolves with ok false and a reason on failure.
     */
    ShowSurfaceStrain (buffer, params)
    {
        return this.RunMapping ('surfaceStrain', 'surface strain', SurfaceStrainResult, (model) => {
            let result = PrepareSurfaceStrain (model, buffer, params);
            if (result.ok) {
                this.surfaceStrainHeader = result.header;
                this.viewer.SetSurfaceStrain (result.mapping, result.colorScale);
            }
            return result;
        });
    }

    /**
     * See {@link EmbeddedViewer#SetSurfaceStrainColors}.
     * @param {SurfaceStrainParams} params Color parameters.
     * @returns {{ok: boolean, reason: string|null, colorScale: object|null}} On failure the
     * current colors stay.
     */
    SetSurfaceStrainColors (params)
    {
        if (!this.viewer.HasSurfaceStrain () || this.surfaceStrainHeader === null) {
            return { ok : false, reason : 'no surface strain is shown', colorScale : null };
        }
        let colorScale = null;
        try {
            colorScale = CreateSurfaceStrainColorScale (params || new SurfaceStrainParams (), this.surfaceStrainHeader);
        } catch (error) {
            return { ok : false, reason : error.message, colorScale : null };
        }
        this.viewer.SetSurfaceStrainColorScale (colorScale);
        return { ok : true, reason : null, colorScale : colorScale };
    }

    /**
     * See {@link EmbeddedViewer#ClearSurfaceStrain}.
     */
    ClearSurfaceStrain ()
    {
        this.viewer.ClearSurfaceStrain ();
        this.surfaceStrainHeader = null;
        this.requests.surfaceStrain += 1;
    }

    /**
     * See {@link EmbeddedViewer#ShowLongReach}.
     * @param {ArrayBuffer} buffer Content of long_reach.bin.
     * @param {LongReachParams} [params] Parameters.
     * @returns {Promise<LongReachResult>} Resolves with ok false and a reason on failure.
     */
    ShowLongReach (buffer, params)
    {
        params = params || new LongReachParams ();
        return this.RunMapping ('longReach', 'long reach', LongReachResult, (model) => {
            let prepared = PrepareLongReach (model, buffer, params);
            if (prepared.result.ok) {
                let display = ParseLongReachDisplay (params);
                this.longReachData = prepared.mapping.data;
                this.viewer.SetLongReach (prepared.prepared, display.limit, display.show, display.color);
            }
            return prepared.result;
        });
    }

    /**
     * See {@link EmbeddedViewer#SetLongReachParams}.
     * @param {LongReachParams} params Parameters.
     * @returns {LongReachResult} On failure the current paint stays.
     */
    SetLongReachParams (params)
    {
        let result = new LongReachResult ();
        if (this.longReachData === null || !this.viewer.HasLongReach ()) {
            result.reason = 'no long reach is shown';
            return result;
        }
        let display = null;
        try {
            display = ParseLongReachDisplay (params);
        } catch (error) {
            result.reason = error.message;
            return result;
        }
        this.viewer.SetLongReachDisplay (display.limit, display.show, display.color);
        result.ok = true;
        result.header = this.longReachData.header;
        result.counts = CountLongReach (this.longReachData, display.limit);
        return result;
    }

    /**
     * See {@link EmbeddedViewer#ClearLongReach}.
     */
    ClearLongReach ()
    {
        this.viewer.ClearLongReach ();
        this.longReachData = null;
        this.requests.longReach += 1;
    }

    /**
     * See {@link EmbeddedViewer#HasLongReach}.
     * @returns {boolean}
     */
    HasLongReach ()
    {
        return this.viewer.HasLongReach ();
    }

    /**
     * See {@link EmbeddedViewer#ShowEdgeHighlights}.
     * @param {EdgeHighlight[]} edges Edges with polyline, color and an optional width in pixels.
     * @param {EdgeHighlightParams} [params] Parameters.
     * @returns {EdgeHighlightResult} On failure ok is false and reason says why.
     */
    ShowEdgeHighlights (edges, params)
    {
        if (this.model === null) {
            let result = new EdgeHighlightResult ();
            result.reason = 'no model is loaded';
            return result;
        }
        try {
            let prepared = PrepareEdgeHighlights (this.model, edges, params);
            if (prepared.result.ok) {
                this.viewer.SetEdgeHighlights (prepared.prepared);
            }
            return prepared.result;
        } catch (error) {
            let result = new EdgeHighlightResult ();
            result.reason = error.message;
            return result;
        }
    }

    /**
     * See {@link EmbeddedViewer#ClearEdgeHighlights}.
     */
    ClearEdgeHighlights ()
    {
        this.viewer.ClearEdgeHighlights ();
    }

    /**
     * See {@link EmbeddedViewer#SetModelOpacity}.
     * @param {number} opacity In (0, 1], 1 shows the model solid.
     * @returns {{ok: boolean, reason: string|null}} On failure nothing changes.
     */
    SetModelOpacity (opacity)
    {
        if (!this.viewer.SetModelOpacity (opacity)) {
            return { ok : false, reason : 'opacity must be a number in (0, 1]' };
        }
        return { ok : true, reason : null };
    }
}
