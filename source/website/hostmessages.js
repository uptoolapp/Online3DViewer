import { IsDefined } from '../engine/core/core.js';
import { LongReachParams } from '../engine/longreach/longreach.js';
import { SurfaceStrainParams } from '../engine/surfacestrain/surfacestrain.js';

export const HostMessageType =
{
    EdgeHighlightsShow : 'o3dv:edge-highlights:show',
    EdgeHighlightsClear : 'o3dv:edge-highlights:clear',
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

// The host sends only what it chooses: the limit and whether to show the findings. The color and
// the mapping tolerances stay the viewer's.
function CreateLongReachParams (settings)
{
    let params = new LongReachParams ();
    if (settings !== null && typeof settings === 'object') {
        for (let key of ['limit', 'showLongReach']) {
            if (settings[key] !== undefined) {
                params[key] = settings[key];
            }
        }
    }
    return params;
}

// The overlays that map a file onto the model. A show is asynchronous, and its settings (strain
// thresholds, long reach limit) can change while it maps and are applied when it is done.
const MappedOverlays = {
    strain : {
        name : 'surface strain',
        showType : HostMessageType.SurfaceStrainShow,
        Show : (overlays, buffer, settings) => overlays.ShowSurfaceStrain (buffer, CreateSurfaceStrainParams (settings)),
        Update : (overlays, settings) => overlays.SetSurfaceStrainColors (CreateSurfaceStrainParams (settings)),
        Clear : (overlays) => overlays.ClearSurfaceStrain ()
    },
    longReach : {
        name : 'long reach',
        showType : HostMessageType.LongReachShow,
        Show : (overlays, buffer, settings) => overlays.ShowLongReach (buffer, CreateLongReachParams (settings)),
        Update : (overlays, settings) => overlays.SetLongReachParams (CreateLongReachParams (settings)),
        Clear : (overlays) => overlays.ClearLongReach ()
    }
};

/**
 * Lets the page that embeds the website in an iframe draw the DFM overlays (edge highlights, face
 * long reach and surface strain) over postMessage. It keeps the last requested overlays and draws
 * them again after every model load, so a command may arrive before the model and is applied when it is
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
        // Per key of MappedOverlays, { buffer, settings } of the last requested overlay.
        this.mapped = {};
        // Per key of MappedOverlays, the promise of the overlay being shown, it resolves with the
        // result.
        this.showing = {};
        for (let kind of Object.keys (MappedOverlays)) {
            this.mapped[kind] = null;
            this.showing[kind] = null;
        }
        // Commands that arrived without a model, they are answered when it is shown.
        this.pending = {
            edges : [],
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

        for (let kind of Object.keys (MappedOverlays)) {
            let pending = this.TakePending (kind);
            if (this.mapped[kind] !== null) {
                this.ShowMapped (kind).then ((result) => {
                    this.AnswerAll (pending, MappedOverlays[kind].showType, result);
                });
            }
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
        } else if (message.type === HostMessageType.LongReachShow) {
            this.OnMappedShow ('longReach', command, message.buffer, message.params);
        } else if (message.type === HostMessageType.LongReachParams) {
            this.OnMappedUpdate ('longReach', command, message.params);
        } else if (message.type === HostMessageType.LongReachClear) {
            this.OnMappedClear ('longReach', command);
        } else if (message.type === HostMessageType.SurfaceStrainShow) {
            this.OnMappedShow ('strain', command, message.buffer, message.thresholds);
        } else if (message.type === HostMessageType.SurfaceStrainColors) {
            this.OnMappedUpdate ('strain', command, message.thresholds);
        } else if (message.type === HostMessageType.SurfaceStrainClear) {
            this.OnMappedClear ('strain', command);
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

    OnMappedShow (kind, command, buffer, settings)
    {
        this.mapped[kind] = {
            buffer : buffer,
            settings : settings
        };
        if (!this.overlays.HasModel ()) {
            this.Supersede (kind, 'replaced by a later command before the model loaded');
            this.pending[kind].push (command);
            return;
        }
        this.ShowMapped (kind).then ((result) => {
            this.Answer (command, result);
        });
    }

    OnMappedUpdate (kind, command, settings)
    {
        let mapped = this.mapped[kind];
        if (mapped === null) {
            this.Answer (command, { ok : false, reason : 'no ' + MappedOverlays[kind].name + ' is shown' });
            return;
        }
        mapped.settings = settings;
        if (!this.overlays.HasModel ()) {
            this.pending[kind].push (command);
        } else if (this.showing[kind] !== null) {
            // ShowMapped applies the new settings when the mapping is done.
            this.showing[kind].then ((result) => {
                this.Answer (command, result);
            });
        } else {
            this.Answer (command, MappedOverlays[kind].Update (this.overlays, settings));
        }
    }

    OnMappedClear (kind, command)
    {
        this.mapped[kind] = null;
        this.Supersede (kind, 'the ' + MappedOverlays[kind].name + ' was cleared before the model loaded');
        MappedOverlays[kind].Clear (this.overlays);
        this.Answer (command, { ok : true, reason : null });
    }

    // A viewer setting, not an overlay: the viewer keeps it through model loads, so it is applied
    // and answered at once, with or without a model.
    OnModelOpacitySet (command, opacity)
    {
        this.Answer (command, this.overlays.SetModelOpacity (opacity));
    }

    ShowMapped (kind)
    {
        let overlay = MappedOverlays[kind];
        let mapped = this.mapped[kind];
        let settings = mapped.settings;
        let showing = overlay.Show (this.overlays, mapped.buffer, settings).then ((result) => {
            if (this.showing[kind] === showing) {
                this.showing[kind] = null;
            }
            // The settings changed while the mapping ran.
            if (result.ok && this.mapped[kind] === mapped && mapped.settings !== settings) {
                result = overlay.Update (this.overlays, mapped.settings);
            }
            return result;
        });
        this.showing[kind] = showing;
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
