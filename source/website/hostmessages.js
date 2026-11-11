import { IsDefined } from '../engine/core/core.js';
import { FaceHighlightParams } from '../engine/facehighlight/facehighlight.js';
import { LongReachParams } from '../engine/longreach/longreach.js';
import { SurfaceStrainParams } from '../engine/surfacestrain/surfacestrain.js';

export const HostMessageType =
{
    EdgeHighlightsShow : 'o3dv:edge-highlights:show',
    EdgeHighlightsClear : 'o3dv:edge-highlights:clear',
    FaceHighlightsShow : 'o3dv:face-highlights:show',
    FaceHighlightsClear : 'o3dv:face-highlights:clear',
    LongReachShow : 'o3dv:long-reach:show',
    LongReachParams : 'o3dv:long-reach:params',
    LongReachClear : 'o3dv:long-reach:clear',
    SurfaceStrainShow : 'o3dv:surface-strain:show',
    SurfaceStrainColors : 'o3dv:surface-strain:colors',
    SurfaceStrainClear : 'o3dv:surface-strain:clear',
    ModelOpacitySet : 'o3dv:model-opacity:set',
    Ready : 'o3dv:ready',
    ModelLoaded : 'o3dv:model-loaded',
    ModelLoadFailed : 'o3dv:model-load-failed',
    Result : 'o3dv:result'
};

function CreateSurfaceStrainParams (thresholds)
{
    let params = new SurfaceStrainParams ();
    params.thresholds = (thresholds === undefined ? null : thresholds);
    return params;
}

// The host sends only what it chooses: the limit and which findings to show. Colors and the
// mapping tolerances stay the viewer's.
function CreateLongReachParams (settings)
{
    let params = new LongReachParams ();
    if (settings !== null && typeof settings === 'object') {
        for (let key of ['limit', 'showLongReach', 'showDeepHoles']) {
            if (settings[key] !== undefined) {
                params[key] = settings[key];
            }
        }
    }
    return params;
}

function CreateFaceHighlightParams (expectedFaceCount)
{
    let params = new FaceHighlightParams ();
    params.expectedFaceCount = (expectedFaceCount === undefined ? null : expectedFaceCount);
    return params;
}

/**
 * Lets the page that embeds the website in an iframe draw the DFM overlays (edge highlights, face
 * highlights, long reach and surface strain) over postMessage. It keeps the last requested overlays and draws them again
 * after every model load, so a command may arrive before the model and is applied when it is
 * shown. It also sets the model opacity, a viewer setting that is applied at once and that the
 * viewer keeps through model loads. Only messages from the parent window on the website's own
 * origin are accepted.
 */
export class HostMessageHandler
{
    /**
     * @param {Window} ownWindow The website's window.
     * @param {ViewerOverlays} overlays Overlays of the website's viewer.
     */
    constructor (ownWindow, overlays)
    {
        this.ownWindow = ownWindow;
        this.overlays = overlays;
        this.origin = null;
        // Last requested overlays, null if none.
        this.edges = null;
        // { highlights, expectedFaceCount }
        this.faces = null;
        this.strain = null;
        // Promise of the surface strain being shown, it resolves with the result.
        this.strainShowing = null;
        // { buffer, settings }
        this.longReach = null;
        // Promise of the long reach being shown, it resolves with the result.
        this.longReachShowing = null;
        // Commands that arrived without a model, they are answered when it is shown.
        this.pending = {
            edges : [],
            faces : [],
            longReach : [],
            strain : []
        };
    }

    /**
     * Starts listening if the website is in an iframe, otherwise it does nothing.
     * @returns {boolean} True if the listener is installed.
     */
    Install ()
    {
        if (this.ownWindow.parent === this.ownWindow) {
            return false;
        }
        this.origin = this.ownWindow.location.origin;
        this.ownWindow.addEventListener ('message', (event) => {
            this.OnMessage (event);
        });
        this.Post ({ type : HostMessageType.Ready });
        return true;
    }

    IsInstalled ()
    {
        return this.origin !== null;
    }

    /**
     * Must be called after a model is shown and set on the overlays.
     */
    OnModelLoaded ()
    {
        if (!this.IsInstalled ()) {
            return;
        }
        this.Post ({ type : HostMessageType.ModelLoaded });

        let edgesPending = this.TakePending ('edges');
        if (this.edges !== null) {
            let result = this.overlays.ShowEdgeHighlights (this.edges);
            this.AnswerAll (edgesPending, HostMessageType.EdgeHighlightsShow, result);
        }

        let facesPending = this.TakePending ('faces');
        if (this.faces !== null) {
            let result = this.ShowFaces ();
            this.AnswerAll (facesPending, HostMessageType.FaceHighlightsShow, result);
        }

        let longReachPending = this.TakePending ('longReach');
        if (this.longReach !== null) {
            this.ShowLongReach ().then ((result) => {
                this.AnswerAll (longReachPending, HostMessageType.LongReachShow, result);
            });
        }

        let strainPending = this.TakePending ('strain');
        if (this.strain !== null) {
            this.ShowStrain ().then ((result) => {
                this.AnswerAll (strainPending, HostMessageType.SurfaceStrainShow, result);
            });
        }
    }

    OnModelLoadFailed ()
    {
        if (!this.IsInstalled ()) {
            return;
        }
        this.Post ({ type : HostMessageType.ModelLoadFailed });
    }

    OnMessage (event)
    {
        if (event.source !== this.ownWindow.parent || event.origin !== this.origin) {
            return;
        }
        let message = event.data;
        if (message === null || typeof message !== 'object' || typeof message.type !== 'string') {
            return;
        }
        let command = {
            type : message.type,
            requestId : (message.requestId === undefined ? null : message.requestId)
        };
        if (message.type === HostMessageType.EdgeHighlightsShow) {
            this.OnEdgeHighlightsShow (command, message.edges);
        } else if (message.type === HostMessageType.EdgeHighlightsClear) {
            this.OnEdgeHighlightsClear (command);
        } else if (message.type === HostMessageType.FaceHighlightsShow) {
            this.OnFaceHighlightsShow (command, message.highlights, message.expectedFaceCount);
        } else if (message.type === HostMessageType.FaceHighlightsClear) {
            this.OnFaceHighlightsClear (command);
        } else if (message.type === HostMessageType.LongReachShow) {
            this.OnLongReachShow (command, message.buffer, message.params);
        } else if (message.type === HostMessageType.LongReachParams) {
            this.OnLongReachParams (command, message.params);
        } else if (message.type === HostMessageType.LongReachClear) {
            this.OnLongReachClear (command);
        } else if (message.type === HostMessageType.SurfaceStrainShow) {
            this.OnSurfaceStrainShow (command, message.buffer, message.thresholds);
        } else if (message.type === HostMessageType.SurfaceStrainColors) {
            this.OnSurfaceStrainColors (command, message.thresholds);
        } else if (message.type === HostMessageType.SurfaceStrainClear) {
            this.OnSurfaceStrainClear (command);
        } else if (message.type === HostMessageType.ModelOpacitySet) {
            this.OnModelOpacitySet (command, message.opacity);
        }
    }

    OnEdgeHighlightsShow (command, edges)
    {
        this.edges = edges;
        if (!this.overlays.HasModel ()) {
            this.Supersede ('edges', 'replaced by a later command before the model loaded');
            this.pending.edges.push (command);
            return;
        }
        this.Answer (command, this.overlays.ShowEdgeHighlights (edges));
    }

    OnEdgeHighlightsClear (command)
    {
        this.edges = null;
        this.Supersede ('edges', 'the edge highlights were cleared before the model loaded');
        this.overlays.ClearEdgeHighlights ();
        this.Answer (command, { ok : true, reason : null });
    }

    OnFaceHighlightsShow (command, highlights, expectedFaceCount)
    {
        this.faces = {
            highlights : highlights,
            expectedFaceCount : expectedFaceCount
        };
        if (!this.overlays.HasModel ()) {
            this.Supersede ('faces', 'replaced by a later command before the model loaded');
            this.pending.faces.push (command);
            return;
        }
        this.Answer (command, this.ShowFaces ());
    }

    OnFaceHighlightsClear (command)
    {
        this.faces = null;
        this.Supersede ('faces', 'the face highlights were cleared before the model loaded');
        this.overlays.ClearFaceHighlights ();
        this.Answer (command, { ok : true, reason : null });
    }

    OnLongReachShow (command, buffer, settings)
    {
        this.longReach = {
            buffer : buffer,
            settings : settings
        };
        if (!this.overlays.HasModel ()) {
            this.Supersede ('longReach', 'replaced by a later command before the model loaded');
            this.pending.longReach.push (command);
            return;
        }
        this.ShowLongReach ().then ((result) => {
            this.Answer (command, result);
        });
    }

    OnLongReachParams (command, settings)
    {
        if (this.longReach === null) {
            this.Answer (command, { ok : false, reason : 'no long reach is shown' });
            return;
        }
        this.longReach.settings = settings;
        if (!this.overlays.HasModel ()) {
            this.pending.longReach.push (command);
        } else if (this.longReachShowing !== null) {
            // ShowLongReach applies the new params when the mapping is done.
            this.longReachShowing.then ((result) => {
                this.Answer (command, result);
            });
        } else {
            this.Answer (command, this.overlays.SetLongReachParams (CreateLongReachParams (settings)));
        }
    }

    OnLongReachClear (command)
    {
        this.longReach = null;
        this.Supersede ('longReach', 'the long reach was cleared before the model loaded');
        this.overlays.ClearLongReach ();
        this.Answer (command, { ok : true, reason : null });
    }

    OnSurfaceStrainShow (command, buffer, thresholds)
    {
        this.strain = {
            buffer : buffer,
            thresholds : thresholds
        };
        if (!this.overlays.HasModel ()) {
            this.Supersede ('strain', 'replaced by a later command before the model loaded');
            this.pending.strain.push (command);
            return;
        }
        this.ShowStrain ().then ((result) => {
            this.Answer (command, result);
        });
    }

    OnSurfaceStrainColors (command, thresholds)
    {
        if (this.strain === null) {
            this.Answer (command, { ok : false, reason : 'no surface strain is shown' });
            return;
        }
        this.strain.thresholds = thresholds;
        if (!this.overlays.HasModel ()) {
            this.pending.strain.push (command);
        } else if (this.strainShowing !== null) {
            // ShowStrain applies the new colors when the mapping is done.
            this.strainShowing.then ((result) => {
                this.Answer (command, result);
            });
        } else {
            this.Answer (command, this.overlays.SetSurfaceStrainColors (CreateSurfaceStrainParams (thresholds)));
        }
    }

    OnSurfaceStrainClear (command)
    {
        this.strain = null;
        this.Supersede ('strain', 'the surface strain was cleared before the model loaded');
        this.overlays.ClearSurfaceStrain ();
        this.Answer (command, { ok : true, reason : null });
    }

    // A viewer setting, not an overlay: the viewer keeps it through model loads, so it is applied
    // and answered at once, with or without a model.
    OnModelOpacitySet (command, opacity)
    {
        this.Answer (command, this.overlays.SetModelOpacity (opacity));
    }

    ShowFaces ()
    {
        return this.overlays.ShowFaceHighlights (this.faces.highlights, CreateFaceHighlightParams (this.faces.expectedFaceCount));
    }

    ShowLongReach ()
    {
        let longReach = this.longReach;
        let settings = longReach.settings;
        let showing = this.overlays.ShowLongReach (longReach.buffer, CreateLongReachParams (settings)).then ((result) => {
            if (this.longReachShowing === showing) {
                this.longReachShowing = null;
            }
            // The params changed while the mapping ran.
            if (result.ok && this.longReach === longReach && longReach.settings !== settings) {
                result = this.overlays.SetLongReachParams (CreateLongReachParams (longReach.settings));
            }
            return result;
        });
        this.longReachShowing = showing;
        return showing;
    }

    ShowStrain ()
    {
        let strain = this.strain;
        let thresholds = strain.thresholds;
        let showing = this.overlays.ShowSurfaceStrain (strain.buffer, CreateSurfaceStrainParams (thresholds)).then ((result) => {
            if (this.strainShowing === showing) {
                this.strainShowing = null;
            }
            // The colors changed while the mapping ran.
            if (result.ok && this.strain === strain && strain.thresholds !== thresholds) {
                result = this.overlays.SetSurfaceStrainColors (CreateSurfaceStrainParams (strain.thresholds));
            }
            return result;
        });
        this.strainShowing = showing;
        return showing;
    }

    TakePending (kind)
    {
        let pending = this.pending[kind];
        this.pending[kind] = [];
        return pending;
    }

    Supersede (kind, reason)
    {
        for (let command of this.TakePending (kind)) {
            this.Answer (command, { ok : false, reason : reason });
        }
    }

    // Answers the commands that waited for the model, or reports the reapplied overlay.
    AnswerAll (commands, reappliedType, result)
    {
        if (commands.length === 0) {
            commands = [{ type : reappliedType, requestId : null }];
        }
        for (let command of commands) {
            this.Answer (command, result);
        }
    }

    Answer (command, result)
    {
        let reason = null;
        if (!result.ok) {
            reason = (IsDefined (result.reason) ? String (result.reason) : 'unknown error');
        }
        this.Post ({
            type : HostMessageType.Result,
            requestId : command.requestId,
            command : command.type,
            ok : result.ok,
            reason : reason
        });
    }

    Post (message)
    {
        this.ownWindow.parent.postMessage (message, this.origin);
    }
}
