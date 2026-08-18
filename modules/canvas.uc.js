// Zen Easel — canvas controller.
//
// Owns the viewport transform, all pointer and keyboard input, the selection, and the
// undo stack. Painting belongs to ZenEaselRenderer; this module decides *when* to paint
// and *what* is currently live.
//
// Two ideas do most of the work for responsiveness:
//
//   1. One rAF-throttled paint. Input handlers mutate the model as fast as the device
//      reports, and painting happens once per frame no matter how many events arrived.
//   2. Objects under an active gesture move to the active canvas and are skipped by the
//      static pass. Dragging then costs O(selection) per frame instead of O(scene), and
//      extending a stroke never repaints the board.
//
// Hit-testing runs in JS against the model (see ZenEaselObjects.hitTest) rather than
// through DOM dispatch, which is why removing the DOM cost nothing here.

"use strict";

(function () {
    if (window.ZenEaselCanvas) return;

    const MIN_ZOOM = 0.1;
    const MAX_ZOOM = 4;
    const ZOOM_STEP = 1.15;
    const UNDO_LIMIT = 100;
    const HANDLE_TOLERANCE = 3;
    // The board is a page, not an unbounded plane: fixed width, top edge at y = 0, and
    // unbounded downward. An infinite canvas in every direction means there is no
    // "home" and nothing to anchor a layout to — you can always be lost in blank space.
    const PAGE_WIDTH = window.ZenEaselObjects.PAGE_WIDTH;

    // Where an easel's heading sits — Arc's defaultTitleFrame. Far enough down that the
    // lettering is not jammed against the top edge, and never above y = 0, which the page
    // cannot scroll past.
    const TITLE_TOP = 140;
    const TITLE_MIN_TOP = 24;
    const TITLE_GAP = 80;
    // Arc's defaultTitle. Kept in step with the store's createDocument default, which is
    // what a document arrives carrying.
    const DEFAULT_TITLE = "Untitled Easel";

    // Controls that float over the canvas inside the viewport. Pointer events landing
    // on any of these belong to them, not to the board.
    // Anything added to the viewport that the user is meant to click has to be listed
    // here, or _onPointerDown treats a press on it as a press on the board: the marquee
    // starts behind the control, the selection it was describing is cleared, and its own
    // click never fires because preventDefault suppressed it. The control then looks
    // present but dead.
    const FLOATING_UI = [
        ".easel-menu",
        ".easel-text-editor",
        ".easel-text-controls",
        ".easel-shape-controls",
        ".easel-font-panel"
    ].join(",");

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const deepCopy = obj => JSON.parse(JSON.stringify(obj));

    class ZenEaselCanvas {
        constructor(host, root) {
            this.host = host;
            this.root = root;                 // .easel-viewport
            this.renderer = host.renderer;
            this.Objects = window.ZenEaselObjects;
            this.log = window.ZenEaselUtil.log;

            this.doc = null;
            this.view = { panX: 0, panY: 0, zoom: 1 };

            this.selection = new Set();
            this._drag = null;
            this._pending = null;
            this._spaceHeld = false;
            this._clipboard = [];
            // The string written to the system clipboard when _clipboard was last filled.
            // Comparing it against what is on the clipboard now is how paste decides whether
            // our objects are still the most recent copy. See copySelection.
            this._clipboardToken = null;
            this._undo = [];
            this._redo = [];

            this._staticDirty = true;
            this._index = null;               // id -> object; see _byId
            this._indexOf = null;             // the array _index was built from
            this._activeIds = new Set();      // drawn on the active canvas, skipped by static
            this._hiddenId = null;            // skipped by both: the textarea is showing it
            this._marquee = null;             // screen-space rect

            this._paint = window.ZenEaselUtil.throttleRAF(() => this._paintNow());
            // Owned by the canvas rather than the host: guides exist only for the
            // duration of a drag, and the drag lives here.
            this.guides = window.ZenEaselGuides ? new window.ZenEaselGuides(this.host) : null;

            // Pan and zoom mutate the view per event but paint once per frame. The
            // separate name keeps the intent readable at the call sites.
            this._paintViewport = () => {
                this._staticDirty = true;
                this._paint();
            };

            this._bind();
        }

        /* -------------------------------------------------------------- wiring */

        _bind() {
            this._onPointerDown = this._onPointerDown.bind(this);
            this._onPointerMove = this._onPointerMove.bind(this);
            this._onPointerUp = this._onPointerUp.bind(this);
            this._onWheel = this._onWheel.bind(this);
            this._onDblClick = this._onDblClick.bind(this);
            this._onContextMenu = this._onContextMenu.bind(this);
            this._onDragOver = this._onDragOver.bind(this);
            this._onDrop = this._onDrop.bind(this);
            this._onKeyUp = this._onKeyUp.bind(this);
            this._onKeyDown = this._onKeyDown.bind(this);
            this._onPaste = this._onPaste.bind(this);
            this._pasteFallbackTimer = null;

            this.root.addEventListener("pointerdown", this._onPointerDown);
            this.root.addEventListener("pointermove", this._onPointerMove);
            this.root.addEventListener("pointerup", this._onPointerUp);
            this.root.addEventListener("pointercancel", this._onPointerUp);
            // Non-passive: wheel zoom must be preventDefault-able or Zen zooms its own
            // UI out from under the canvas.
            this.root.addEventListener("wheel", this._onWheel, { passive: false });
            this.root.addEventListener("dblclick", this._onDblClick);
            this.root.addEventListener("contextmenu", this._onContextMenu);
            this.root.addEventListener("dragover", this._onDragOver);
            this.root.addEventListener("drop", this._onDrop);
            // The easel owns the keyboard now that it is a document of its own. When it
            // was an overlay this was routed from the controller's window listener,
            // which had to work out whether each keystroke was meant for the canvas or
            // for Zen's URL bar; here the whole window is the easel, so the canvas takes
            // the events directly. Capture phase, so a focused toolbar button does not
            // swallow a canvas shortcut before it is seen.
            window.addEventListener("keydown", this._onKeyDown, true);
            window.addEventListener("keyup", this._onKeyUp, true);
            // The clipboard arrives here, not through the keydown. See _onPaste.
            window.addEventListener("paste", this._onPaste, true);

            if (typeof ResizeObserver === "function") {
                this._resizeObserver = new ResizeObserver(() => {
                    if (!this.renderer.resize()) return;
                    // In Arc's verticallyScrolling mode the document *is* the window width,
                    // so a resize relays the board out rather than just re-clamping it.
                    this._reflowToCanvasWidth();
                    // A narrower window changes where the page edges fall.
                    this._clampView();
                    this._paintViewport();
                });
                this._resizeObserver.observe(this.root);
            }
        }

        destroy() {
            this._paint.cancel();
            if (this._resizeObserver) this._resizeObserver.disconnect();
            this.root.removeEventListener("pointerdown", this._onPointerDown);
            this.root.removeEventListener("pointermove", this._onPointerMove);
            this.root.removeEventListener("pointerup", this._onPointerUp);
            this.root.removeEventListener("pointercancel", this._onPointerUp);
            this.root.removeEventListener("wheel", this._onWheel);
            this.root.removeEventListener("dblclick", this._onDblClick);
            this.root.removeEventListener("contextmenu", this._onContextMenu);
            this.root.removeEventListener("dragover", this._onDragOver);
            this.root.removeEventListener("drop", this._onDrop);
            window.removeEventListener("keydown", this._onKeyDown, true);
            window.removeEventListener("keyup", this._onKeyUp, true);
            window.removeEventListener("paste", this._onPaste, true);
            if (this._pasteFallbackTimer) window.clearTimeout(this._pasteFallbackTimer);
        }

        /* ------------------------------------------------------------ document */

        setDocument(doc) {
            this.doc = doc;
            this.selection.clear();
            this._undo = [];
            this._redo = [];
            this._activeIds.clear();
            this._marquee = null;
            if (this.host.textEditor) this.host.textEditor.destroy();

            this.view = doc ? doc.viewport : { panX: 0, panY: 0, zoom: 1 };
            if (this.host.store) this.host.store.onAssetLoaded = () => this.invalidate();
            this.renderer.releaseImages();
            // The <img> elements belong to the board being left behind, and the blob
            // URLs behind them are revoked as part of the switch.
            if (this.host.media) this.host.media.clear();

            this.root.classList.toggle("is-empty-document", !doc);
            this.renderer.resize();
            this._clampView();       // a saved viewport may predate the page bounds
            this._applyBackground();

            // Heights in the file were measured by whatever renderer wrote them; canvas
            // metrics differ, so they are recomputed rather than trusted.
            if (doc) {
                for (const obj of doc.objects) {
                    if (obj.type === "text") obj.h = this.renderer.measureTextHeight(obj);
                }
                // Only a document that has never had a heading gets one. An id that no
                // longer resolves means the heading was deleted deliberately, and a board
                // someone cleared must not have one grow back on it.
                if (doc.titleObjectId === undefined) {
                    const wasEmpty = doc.objects.length === 0;
                    this._ensureTitleHeading(doc);
                    if (this.host.store) this.host.store.markDirty();

                    // A brand new easel opens with its heading ready to type into, the way
                    // a new text box does. Deferred past this call so the board paints
                    // first and the editor positions itself against a settled viewport.
                    // A board that merely gained a heading by migration is left alone.
                    if (wasEmpty) {
                        const id = doc.titleObjectId;
                        window.setTimeout(() => {
                            if (this.doc === doc && this._byId(id)) {
                                this.startEditing(id, { selectAll: true });
                            }
                        }, 0);
                    }
                }
            }
            this._paintViewport();
        }

        get objects() { return this.doc ? this.doc.objects : []; }

        // id -> object, rebuilt whenever the object list changes shape.
        //
        // This used to be an Array.find, which is fine until you notice where it is
        // called from: once per selected object per pointer event during a drag, and
        // three more times per painted frame from _selected(), the text controls and the
        // live layer. On a board of several hundred objects that is a linear scan in the
        // innermost loop of every gesture.
        //
        // Correctness rests on _indexObjects being called wherever doc.objects is
        // replaced or spliced. The generation counter is what makes a miss loud rather
        // than silent: the map is rebuilt on demand if anything mutated the array
        // without saying so.
        _byId(id) {
            if (this._index === null || this._indexOf !== this.objects) this._indexObjects();
            return this._index.get(id) || null;
        }

        // Cheap enough to call liberally — it is one pass over an array that any of the
        // callers was about to walk anyway.
        _indexObjects() {
            const objects = this.objects;
            const index = new Map();
            for (const obj of objects) index.set(obj.id, obj);
            this._index = index;
            // Held so _byId can notice a wholesale replacement (undo, redo, paste-over,
            // reorder) without every one of those paths having to remember to say so.
            this._indexOf = objects;
        }

        // Objects were mutated in place rather than replaced — spliced back in by an
        // undo, or pushed by a drawing tool — so the array identity check cannot see it.
        _invalidateIndex() {
            this._index = null;
        }

        _selected() { return [...this.selection].map(id => this._byId(id)).filter(Boolean); }

        _touch() {
            this._syncTitleFromHeading();
            if (this.host.store) this.host.store.markDirty();
        }

        /* --------------------------------------------------- live play / pause */

        // Hit-tested in world space against the same rect the renderer drew, so the two
        // cannot drift apart. A small pad keeps it clickable at low zoom, where the badge
        // is only a few device pixels across.
        _hitLiveBadge(obj, world) {
            const live = this.host.live;
            if (!live) return false;
            if (!live.isLive(obj.id) && !live.canGoLive(obj)) return false;

            const rect = this.renderer.webcardBadgeRect(obj);
            if (!rect) return false;

            // Same local-frame trick the object hit test uses: the badge is drawn inside
            // the object's rotated context, so the pointer is taken back out of that
            // rotation rather than the rectangle being rotated to meet it.
            const point = this.Objects.toLocal(obj, world.x, world.y);

            const pad = 4 / this.view.zoom;
            return point.x >= rect.x - pad && point.x <= rect.x + rect.w + pad &&
                point.y >= rect.y - pad && point.y <= rect.y + rect.h + pad;
        }

        _toggleLive(obj) {
            const live = this.host.live;
            if (!live) return;

            if (live.isLive(obj.id)) {
                live.makeStatic(obj);
                return;
            }
            live.requestLive(obj)
                .then(ok => { if (ok) this.invalidate(); })
                .catch(err => {
                    console.error("[zen-easel] could not go live:", err);
                    this.host.toast("This card could not be made live");
                });
        }

        /* -------------------------------------------------------------- export */

        // Arc exports an easel as a flat picture (EaselCanvasViewController+Export), and
        // that is the only sensible thing to export: the board is a drawing, not a
        // document with structure worth preserving.
        //
        // The pixels are rendered here and the file is written by the browser window, so
        // the page never learns a filesystem path.
        async exportImage(format = "png") {
            if (!this.doc || !this.doc.objects.length) {
                this.host.toast("There is nothing on this board to export");
                return;
            }

            const bridge = this.host.bridge;
            if (!bridge || typeof bridge.savePicture !== "function") {
                this.host.toast("Export is not available in this window");
                return;
            }

            const fill = this.Objects.backgroundFill(this.background);
            const bytes = await this.renderer.snapshot(this.doc.objects, {
                // Generous but bounded. An easel is a page, not a poster, and an
                // unbounded export of a board zoomed way out is a 200MB surprise.
                maxWidth: 4096,
                maxHeight: 4096,
                padding: 64,
                // JPEG has no transparency, so a background is not optional there — a
                // transparent or theme board exports as white rather than as black,
                // which is what an unpainted JPEG canvas would otherwise give.
                background: fill || (format === "jpeg" ? "#FFFFFF" : null),
                type: format === "jpeg" ? "image/jpeg" : "image/png",
                quality: 0.92
            });
            if (!bytes) return;

            // Slashes and the rest are the file picker's problem only if we hand them over.
            const safeTitle = (this.doc.title || "Easel").replace(/[\\/:*?"<>|]/g, "-").trim();
            const path = await bridge.savePicture(
                bytes, `${safeTitle}.${format === "jpeg" ? "jpg" : "png"}`, format
            );
            if (path) this.host.toast("Easel exported");
        }

        /* --------------------------------------------------------------- title */

        // Arc keeps the easel's name on the board rather than beside it: EaselDocument
        // carries a titleObjectID pointing at a text object, and serverTitle is the
        // denormalised copy the sidebar reads. doc.title plays serverTitle here — it is
        // already what index.json, the tab title and the library card read, so binding the
        // heading to it means none of those had to learn about any of this.

        get titleObject() {
            if (!this.doc || !this.doc.titleObjectId) return null;
            const obj = this._byId(this.doc.titleObjectId);
            return obj && obj.type === "text" ? obj : null;
        }

        // Runs on every mutation, so it catches typing, committing, undo, redo, paste and
        // deletion through one path instead of five. Both halves are a string compare on
        // the common case.
        _syncTitleFromHeading() {
            if (!this.doc || !this.doc.titleObjectId) return;

            const heading = this.titleObject;
            // The heading has been deleted. The id is deliberately left pointing at it
            // rather than cleared: undoing the delete brings the binding back with the
            // object, and reopening the easel finds a non-undefined id and so does not
            // grow a new heading over a board someone deliberately cleared.
            if (!heading) return;

            const text = heading.text.content.trim();
            // An empty heading keeps the last real name rather than renaming the easel to
            // nothing halfway through a retype.
            if (!text || text === this.doc.title) return;

            this.doc.title = text;
            if (this.host.onTitleChanged) this.host.onTitleChanged(text);
        }

        // The other direction: renamed from the topbar or the library, so the heading has
        // to follow. Silent when there is no heading — the easel simply has a name and no
        // lettering on the board, which is a state Arc allows too.
        applyTitleToHeading(title) {
            const heading = this.titleObject;
            if (!heading || heading.text.content === title) return;

            this.beginMutation([heading.id]);
            heading.text.content = title;
            heading.h = this.renderer.measureTextHeight(heading);
            this.commitMutation();
            this.invalidate();
        }

        // Derived rather than stored, so it cannot drift: a heading is "in default state"
        // exactly while it still reads the name every new easel is given.
        isPlaceholderTitle(obj) {
            return !!this.doc && obj.id === this.doc.titleObjectId &&
                obj.type === "text" && obj.text.content === DEFAULT_TITLE;
        }

        // Arc's updateTitleObject(_:) — point the binding at a different text object, which
        // is also how a deleted heading is restored.
        useAsTitle(obj) {
            if (!this.doc || !obj || obj.type !== "text") return;
            this.doc.titleObjectId = obj.id;
            this._touch();
        }

        // Every easel gets a centred heading. Created here rather than in the background
        // store because it needs the page's geometry and text measurement, and because
        // running it on open makes creation and migration the same code path: a board that
        // predates headings gets one the first time it is opened.
        _ensureTitleHeading(doc) {
            const Objects = this.Objects;
            // Measured against the page this board actually has: in verticallyScrolling
            // that is the window, not the 3600-unit sheet.
            const pageWidth = this._pageWidth();
            const width = Math.round(pageWidth * 0.6);
            const size = Objects.TEXT_STYLE_BY_KEY.get(Objects.TITLE_STYLE).size;

            const heading = Objects.createObject("text", {
                x: Math.round((pageWidth - width) / 2),
                y: TITLE_TOP,
                w: width,
                text: {
                    content: doc.title || "Untitled Easel",
                    fontSize: size,
                    fontFamily: "system",
                    align: "center",
                    fill: "none"
                }
            });
            heading.h = this.renderer.measureTextHeight(heading);

            // On an existing board, sit above whatever is already there rather than on top
            // of it. The page starts at y = 0 and cannot be panned above it, so there is a
            // floor: a board whose content already begins at the very top gets a heading
            // that overlaps, which the user can move, rather than one placed off-page.
            const existing = Objects.unionBounds(doc.objects);
            if (existing && existing.y < heading.y + heading.h + TITLE_GAP) {
                heading.y = Math.max(TITLE_MIN_TOP, existing.y - heading.h - TITLE_GAP);
            }

            // First in z-order: a heading should never come out on top of the captures it
            // names, and prepending keeps it behind everything already on the board.
            doc.objects.unshift(heading);
            doc.titleObjectId = heading.id;
            this._invalidateIndex();
        }

        /* --------------------------------------------------------------- paint */

        // Scene changed: the static canvas has to be redrawn.
        invalidate() {
            this._staticDirty = true;
            this._paint();
        }

        // Selection or marquee changed. The overlay is repainted on every frame anyway,
        // so this only needs to schedule one.
        invalidateOverlay() {
            this._paint();
        }

        // Kept because the store calls it when a late asset finishes loading.
        requestRender() { this.invalidate(); }

        render() { this._paintNow(); }

        _paintNow() {
            if (!this.doc) return;

            // The CSS grid is part of the frame, not a side effect of whichever handler
            // moved the view. It compares a signature first, so a board that is not
            // moving costs one string build per frame and no style write at all.
            this._applyGrid();

            if (this._staticDirty) {
                // Three reasons to skip an object: it is live on the active canvas, the
                // textarea is currently showing it and painting it underneath would
                // double every glyph, or it is a live web card, whose pixels come from a
                // real <browser> in the DOM layer rather than from us.
                const skip = new Set(this._activeIds);
                if (this._hiddenId) skip.add(this._hiddenId);
                this.renderer.renderStatic(this.objects, this.view, { skip });
                this._staticDirty = false;
            }

            if (this._activeIds.size) {
                const live = [...this._activeIds].map(id => this._byId(id)).filter(Boolean);
                this.renderer.renderActive(live, this.view);
            } else {
                this.renderer.clearActive();
            }

            this.renderer.renderOverlay(this._overlayState());

            // Animated images are <img> elements below the canvas; the compositor
            // animates them, so all that is needed here is to keep them over the right
            // part of the board. No repaint loop of any kind.
            if (this.host.media) this.host.media.sync();

            if (this.host.textEditor && this.host.textEditor.isEditing) {
                this.host.textEditor.reposition();
            }
            // The text stepper rides alongside its box, so it repositions on the same
            // frame as everything else rather than listening for pans of its own.
            if (this.host.textControls) this.host.textControls.sync();
            if (this.host.shapeControls) this.host.shapeControls.sync();
            // Live web cards are DOM, not canvas, so they need the same transform applied
            // to their layer — on this frame, or they would lag the board by one.
            if (this.host.live) this.host.live.sync();
            if (this.host.library) this.host.library.updateZoom();
        }

        _overlayState() {
            const editing = this.host.textEditor && this.host.textEditor.isEditing;
            const guides = this._screenGuides();

            // A live card is a website sitting above this document, so selection chrome
            // drawn for it would either be hidden behind the tile or, worse, float over the
            // page as a box that belongs to something you can no longer see the edges of.
            // A live card shows what it is by being live; it does not need an outline too.
            const live = this.host.live;
            // showsTile rather than isLive: a card whose tile is hidden behind an
            // open menu is being drawn by the canvas again, so it gets its outline
            // back for as long as that lasts.
            const selected = this._selected().filter(obj => !(live && live.showsTile(obj.id)));

            if (!selected.length) {
                return { marquee: this._marquee, selection: [], frame: null, editing, guides, rotation: 0 };
            }

            const toScreenBox = box => {
                const tl = this.toScreen(box.x, box.y);
                return { x: tl.x, y: tl.y, w: box.w * this.view.zoom, h: box.h * this.view.zoom };
            };

            return {
                marquee: this._marquee,
                selection: selected.map(obj => toScreenBox(this.Objects.bounds(obj))),
                frame: toScreenBox(this.Objects.unionBounds(selected)),
                editing,
                guides,
                rotation: this._selectionRotation(selected)
            };
        }

        // The angle the transform frame is drawn at. Only a single object has one: a
        // multi-selection's union box is axis-aligned by construction, and tilting it to
        // match whichever member happened to be rotated would draw a box that does not
        // contain what it claims to. Excalidraw draws a multi-selection upright for the
        // same reason, and rotating one still works — every member turns about the
        // union's centre, the box just stays square while it happens.
        _selectionRotation(selected) {
            return selected.length === 1 ? (selected[0].rotation || 0) : 0;
        }

        // Guides are computed in world coordinates and drawn in screen coordinates, the
        // same as the selection chrome, so they stay hairline-thin at any zoom.
        _screenGuides() {
            if (!this.guides || !this.guides.active.length) return [];
            return this.guides.active.map(guide => {
                if (guide.axis === "x") {
                    const a = this.toScreen(guide.position, guide.from);
                    const b = this.toScreen(guide.position, guide.to);
                    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
                }
                const a = this.toScreen(guide.from, guide.position);
                const b = this.toScreen(guide.to, guide.position);
                return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
            });
        }

        // Objects under an active gesture move to the active canvas. Static is redrawn
        // once without them, then left alone for the duration of the drag.
        _beginActive(ids) {
            this._activeIds = new Set(ids);
            // A live card hides for the duration and the cached screenshot on the active
            // canvas stands in as the drag proxy. Relaying out a remote frame at pointer
            // rate is not something to attempt, and this is why dragging a live card
            // needs no other changes in this file.
            if (this.host.live) this.host.live.beginGesture(this._activeIds);
            this._staticDirty = true;
            this._paint();
        }

        _endActive() {
            // The lines belong to the gesture that drew them.
            if (this.guides) this.guides.clear();
            this._lastDragSample = null;
            if (!this._activeIds.size) return;
            this._activeIds.clear();
            if (this.host.live) this.host.live.endGesture();
            this._staticDirty = true;
            this._paint();
        }

        /* ------------------------------------------------------ coordinate math */

        _screenPoint(e) {
            const r = this.root.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        toWorld(sx, sy) {
            return { x: (sx - this.view.panX) / this.view.zoom, y: (sy - this.view.panY) / this.view.zoom };
        }

        toScreen(wx, wy) {
            return { x: wx * this.view.zoom + this.view.panX, y: wy * this.view.zoom + this.view.panY };
        }

        _worldPoint(e) {
            const s = this._screenPoint(e);
            return this.toWorld(s.x, s.y);
        }

        // The grid stays a CSS background on the viewport rather than being painted:
        // the compositor can scroll it for free, and it never costs a canvas pass. The
        // board's own wash is layered underneath it as further background images, which
        // is why both are built here together — CSS takes one comma-separated list per
        // property, so they cannot be set independently.
        //
        // Called from the paint loop rather than from each of the eight places that
        // could move the view. It used to be the latter, and the grid could therefore
        // silently fall out of step with the transform if any path forgot. Driving it
        // from the same frame as everything else makes that unrepresentable, and the
        // signature check below means a still board writes nothing.
        _applyGrid() {
            const { panX, panY, zoom } = this.view;
            const prefs = window.ZenEaselUtil.prefs;
            const signature = `${panX}|${panY}|${zoom}|${this.background}|${prefs.grid}|${prefs["grid-size"]}`;
            if (signature === this._gridSignature) return;
            this._gridSignature = signature;

            const size = Math.max(4, prefs["grid-size"]) * zoom;
            const s = this.root.style;

            const preset = this.Objects.BACKGROUND_BY_KEY.get(this.background);
            // Already a list. It was a comma-joined string that had to be split back
            // apart here, and the splitter could not distinguish a separator from the
            // commas inside rgba() — every gradient came apart, the joined value was
            // invalid, and CSSOM discards an invalid assignment without complaint, so
            // the grid stopped moving from the first frame a wash was in force.
            const wash = (preset && Array.isArray(preset.image)) ? preset.image : [];

            const layers = [];
            const sizes = [];
            const positions = [];

            if (prefs.grid !== "none" && size >= 6) {
                if (prefs.grid === "lines") {
                    layers.push(
                        "linear-gradient(to right, var(--easel-grid) 1px, transparent 1px)",
                        "linear-gradient(to bottom, var(--easel-grid) 1px, transparent 1px)"
                    );
                    sizes.push(`${size}px ${size}px`, `${size}px ${size}px`);
                    positions.push(`${panX}px ${panY}px`, `${panX}px ${panY}px`);
                } else {
                    layers.push("radial-gradient(circle, var(--easel-grid) 1.2px, transparent 1.2px)");
                    sizes.push(`${size}px ${size}px`);
                    positions.push(`${panX}px ${panY}px`);
                }
            }

            // The wash is fixed to the viewport, not the canvas: it is lighting, not
            // content, so it must not slide around when you pan.
            for (const layer of wash) {
                layers.push(layer);
                sizes.push("100% 100%");
                positions.push("0 0");
            }

            // "none" rather than "": an empty string is also a valid removal, but
            // "none" states the intent and keeps the three lists the same length.
            s.backgroundImage = layers.length ? layers.join(", ") : "none";
            s.backgroundSize = sizes.length ? sizes.join(", ") : "auto";
            s.backgroundPosition = positions.length ? positions.join(", ") : "0 0";
        }

        /* ---------------------------------------------------------- background */

        get background() { return (this.doc && this.doc.background) || "arc"; }

        setBackground(key) {
            if (!this.doc) return;
            const previous = this.background;
            if (previous === key) return;

            const apply = value => () => {
                this.doc.background = value;
                this._applyBackground();
                // The wash is a grid layer, so the next paint picks it up: background
                // is part of the signature _applyGrid compares against.
                this._paintViewport();
            };
            apply(key)();
            this._push({ undo: apply(previous), redo: apply(key) });
            this._touch();
        }

        /* ---------------------------------------------------------- canvas mode */

        // Arc's CanvasMode is verticallyScrolling or fixed. In verticallyScrolling the
        // document has no intrinsic width at all: canvasWidth is the width of the view, and
        // the board is relaid out whenever that changes — which is why Arc keeps
        // lastLaidOutAtCanvasWidth and documentHeightAsFactorOfWidth on the controller.
        //
        // This mod's own model is the fixed one: a 3600-unit page, with fit-width as the
        // zoom-out limit. At fit-width the two look the same, and they part company as soon
        // as you resize the window — so the mode is per easel, defaulting to fixed, and the
        // two can be judged side by side rather than one being asserted over the other.
        get canvasMode() {
            return (this.doc && this.doc.canvasMode) === "verticallyScrolling"
                ? "verticallyScrolling" : "fixed";
        }

        get reflowing() {
            return this.canvasMode === "verticallyScrolling";
        }

        setCanvasMode(mode) {
            if (!this.doc) return;
            const previous = this.canvasMode;
            const next = mode === "verticallyScrolling" ? "verticallyScrolling" : "fixed";
            if (previous === next) return;

            this.doc.canvasMode = next;
            // Entering the mode adopts the current width as the layout width, so nothing
            // moves at the moment of the switch — only later resizes reflow.
            this.doc.lastLaidOutAtCanvasWidth = this.renderer.width || null;
            this._clampView();
            this._paintViewport();
            this._touch();
        }

        // The whole of the reflow: scale every object by how much the width changed, then
        // remember the new width. Arc's field names are the design — currentWidth against
        // lastLaidOutAtCanvasWidth — and coordinates stay in the units they were written
        // in, so nothing has to be migrated and the fixed mode is untouched.
        _reflowToCanvasWidth() {
            if (!this.doc || !this.reflowing) return;

            const width = this.renderer.width;
            if (!width) return;

            const previous = this.doc.lastLaidOutAtCanvasWidth;
            if (!previous) {
                this.doc.lastLaidOutAtCanvasWidth = width;
                return;
            }

            const factor = width / previous;
            // Sub-pixel resizes are noise, and rescaling on each of them would accumulate
            // rounding error across a drag of the window edge.
            if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.001) return;

            for (const obj of this.doc.objects) {
                obj.x *= factor;
                obj.y *= factor;
                obj.w *= factor;
                obj.h *= factor;

                if (obj.type === "ink") {
                    for (const point of obj.ink.points) {
                        point[0] *= factor;
                        point[1] *= factor;
                    }
                    obj.ink.strokeWidth *= factor;
                } else if (obj.type === "shape") {
                    obj.shape.strokeWidth *= factor;
                } else if (obj.type === "text") {
                    obj.text.fontSize *= factor;
                }
                // shape.a / shape.b are fractions of the object's own box, so they scale
                // with it for free — which is exactly why they were stored that way.
            }

            this.doc.lastLaidOutAtCanvasWidth = width;
            // Stored so a reopened document knows how long its page is before the first
            // object has been measured.
            this.doc.documentHeightAsFactorOfWidth = this._contentBottom() / width;

            this.renderer.invalidateInkCache();
            for (const obj of this.doc.objects) {
                if (obj.type === "text") obj.h = this.renderer.measureTextHeight(obj);
            }
            this._touch();
        }

        /* ------------------------------------------------------------- palette */

        get palette() {
            return (this.doc && this.doc.palette) || this.Objects.DEFAULT_PALETTE;
        }

        // Switching palette repaints every object at once: colour keys are shared between
        // the palettes, so nothing on the board is rewritten — the same object is "red" in
        // both and simply resolves to a different value.
        setPalette(name) {
            if (!this.doc) return;
            const previous = this.palette;
            if (previous === name || !this.Objects.PALETTES[name]) return;

            const apply = value => () => {
                this.doc.palette = value;
                this.Objects.setPalette(value);
                this.renderer.invalidateInkCache();
                this.invalidate();
                if (this.host.tools) this.host.tools.syncPalette();
            };
            apply(name)();
            this._push({ undo: apply(previous), redo: apply(name) });
            this._touch();
        }

        // Every board is a tint over Zen's window, so this decides two things at once:
        // what the viewport paints, and what colour the easel's own chrome takes. The
        // topbar, the toolbar and the popups are the board's colour at a higher alpha,
        // which is what makes them look like part of the board rather than a grey strip
        // parked on top of it.
        _applyBackground() {
            const preset = this.Objects.BACKGROUND_BY_KEY.get(this.background);
            this.root.style.backgroundColor = preset && preset.css ? preset.css : "";

            // Nothing behind the tint may paint, or the alpha buys nothing: the shadow
            // root's .easel-root and the page's <body> are both permanently transparent
            // for that reason, so there is no per-board switch to make there any more.
            //
            // What ends up behind it is Zen's window. That is only literally see-through
            // where browser.tabs.allow_transparent_browser is on — which Zen's own
            // transparency themes set, and which this mod deliberately does not touch.
            // Without the flag the board reads as the window's colour, which is a
            // reasonable result rather than a broken one.

            // The board's opaque colour. "theme" and "transparent" have none of their
            // own, so they borrow the scheme's — which is also what the stylesheet's
            // light-dark() default resolves to, so the chrome and the board agree.
            //
            // Read from the preset rather than from the painted result: a computed
            // rgba(…, 0.5) says nothing about what is behind it, and judging a tint by
            // its own colour is both cheaper and the answer we actually want.
            const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
            const solid = (preset && preset.swatch) || (prefersDark ? "#1B1B1D" : "#FBFBFA");
            const isLight = this.Objects.luminanceOf(solid) > 0.45;

            const rgb = this.Objects.rgbOf(solid) || [251, 251, 250];
            // Set on the host, not on the viewport: :host rules and the whole shadow
            // tree see a custom property set there, and the renderer reads its canvas
            // colours off the same element.
            const style = this.host.style;
            style.setProperty("--easel-tint", rgb.join(", "));
            style.setProperty("--easel-solid", solid);
            // Which ink the chrome uses, and the only thing that can answer it: a dark
            // board under a light OS theme needs light text, and light-dark() would
            // hand it dark text because it is answering a different question.
            //
            // An attribute rather than a stack of properties written from here, so the
            // palette stays in the stylesheet with the rest of it. Named for the
            // decision instead of toggled, so that "no board has been applied yet" is
            // its own state and the stylesheet can fall back to the OS scheme for the
            // frames before this first runs.
            this.host.setAttribute("data-easel-ink", isLight ? "light" : "dark");

            this.root.style.setProperty("--easel-grid", isLight ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.12)");
        }

        /* ---------------------------------------------------------- zoom & pan */

        // Zoom proportional to how hard you scrolled rather than a fixed step per
        // notch — a fixed multiplier makes a nudge and a flick identical, which is what
        // made zooming feel steppy. The log term widens steps as you zoom in; the
        // min(1, |delta|/20) factor damps that for the small deltas a trackpad emits.
        // Curve follows Excalidraw's, which solves the same problem.
        _nextZoom(deltaY) {
            const zoom = this.view.zoom;
            const sign = Math.sign(deltaY);
            const absDelta = Math.abs(deltaY);
            const MAX_STEP = 60;
            const delta = absDelta > MAX_STEP ? MAX_STEP * sign : deltaY;

            return zoom
                - delta / 100
                + Math.log10(Math.max(1, zoom)) * -sign * Math.min(1, absDelta / 20);
        }

        // Keeps the world point under (screenX, screenY) fixed across the scale change.
        // Zooming about the viewport centre instead is the classic bug — the canvas
        // appears to slide away from the pointer.
        // Zooming out stops at fit-width. Below that the page would no longer span the
        // window and you would be looking at a document floating in a void, which is
        // exactly what a PDF viewer refuses to do.
        _minZoom() {
            const width = this.renderer.width;
            // In verticallyScrolling the page is the window, so fit-width is 1 by
            // definition — there is no width to divide by.
            if (this.reflowing) return 1;
            return width ? Math.max(width / PAGE_WIDTH, 0.05) : MIN_ZOOM;
        }

        // The width of the page in world units, which is what the clamp and the grid are
        // measured against.
        _pageWidth() {
            return this.reflowing ? (this.renderer.width || PAGE_WIDTH) : PAGE_WIDTH;
        }

        // How far down the page currently runs: past the lowest object, plus room to
        // work into. The page grows as you add things lower down and never needs a
        // fixed length.
        _pageBottom() {
            const trailing = this.Objects.PAGE_TRAILING_SCREENS * this.renderer.height / this.view.zoom;
            return this._contentBottom() + trailing;
        }

        // The lowest point anything reaches, with no trailing room added. Split out because
        // documentHeightAsFactorOfWidth is a property of the content, not of the window it
        // happens to be shown in.
        _contentBottom() {
            let bottom = 0;
            for (const obj of this.objects) {
                const objBottom = obj.y + obj.h;
                if (objBottom > bottom) bottom = objBottom;
            }
            return bottom;
        }

        // Holds the view inside the page: pinned to both sides, to the top, and to the
        // current bottom. Because the minimum zoom is fit-width, the page always spans
        // the window exactly and there is never dead space beside it.
        _clampView() {
            const width = this.renderer.width;
            const height = this.renderer.height;
            if (!width || !height) return;

            this.view.zoom = clamp(this.view.zoom, this._minZoom(), MAX_ZOOM);

            const pageWidth = this._pageWidth() * this.view.zoom;
            this.view.panX = clamp(this.view.panX, Math.min(0, width - pageWidth), 0);

            // World y = 0 sits at screen y = panY, so panY > 0 would show blank space
            // above the top of the page. The lower bound puts the page's current bottom
            // at the bottom of the window; a page shorter than the window stays pinned
            // to the top instead.
            const lowest = height - this._pageBottom() * this.view.zoom;
            this.view.panY = clamp(this.view.panY, Math.min(0, lowest), 0);
        }

        zoomAt(screenX, screenY, nextZoom) {
            const zoom = clamp(nextZoom, this._minZoom(), MAX_ZOOM);
            if (zoom === this.view.zoom) return;
            const before = this.toWorld(screenX, screenY);
            this.view.zoom = zoom;
            this.view.panX = screenX - before.x * zoom;
            this.view.panY = screenY - before.y * zoom;
            this._clampView();
            this._paintViewport();
            this._touch();
        }

        zoomBy(factor) {
            this.zoomAt(this.renderer.width / 2, this.renderer.height / 2, this.view.zoom * factor);
        }

        resetZoom() {
            this.zoomAt(this.renderer.width / 2, this.renderer.height / 2, 1);
        }

        panBy(dx, dy) {
            this.view.panX += dx;
            this.view.panY += dy;
            this._clampView();
            this._paintViewport();
            this._touch();
        }

        zoomToFit(objects = this.objects) {
            const box = this.Objects.unionBounds(objects);
            const width = this.renderer.width;
            const height = this.renderer.height;
            if (!box || !width || !height) return;

            const padding = 80;
            const zoom = clamp(
                Math.min((width - padding) / Math.max(box.w, 1), (height - padding) / Math.max(box.h, 1)),
                this._minZoom(), MAX_ZOOM
            );
            this.view.zoom = zoom;
            this.view.panX = width / 2 - (box.x + box.w / 2) * zoom;
            this.view.panY = height / 2 - (box.y + box.h / 2) * zoom;
            this._clampView();
            this._paintViewport();
            this._touch();
        }

        /* --------------------------------------------------------- hit testing */

        // Top-most first: the array is in z order, so a reverse walk returns whatever
        // the user visually clicked rather than whatever was drawn first.
        _hitTest(wx, wy) {
            const tolerance = 6 / this.view.zoom;
            for (let i = this.objects.length - 1; i >= 0; i--) {
                if (this.Objects.hitTest(this.objects[i], wx, wy, tolerance)) return this.objects[i];
            }
            return null;
        }

        // Handles have no DOM node any more, so this tests the same rectangles the
        // renderer draws — the geometry lives in one place.
        _handleAt(screen) {
            const selected = this._selected();
            if (!selected.length || (this.host.textEditor && this.host.textEditor.isEditing)) return null;

            const frame = this._selectionFrame(selected);
            const rotation = this._selectionRotation(selected);

            // The renderer draws the handles inside a rotated context, so the pointer is
            // rotated back out of it before being compared against the upright
            // rectangles. Neither side ever has to build a rotated rectangle.
            const point = rotation
                ? this.Objects.rotatePoint(
                    screen.x, screen.y,
                    frame.x + frame.w / 2, frame.y + frame.h / 2, -rotation)
                : screen;

            // Reverse order, so the rotate grip — appended last — wins a near-miss
            // against the north handle it sits above.
            const handles = this.renderer.handleRects(frame);
            for (let i = handles.length - 1; i >= 0; i--) {
                const handle = handles[i];
                if (point.x >= handle.x - HANDLE_TOLERANCE &&
                    point.x <= handle.x + handle.w + HANDLE_TOLERANCE &&
                    point.y >= handle.y - HANDLE_TOLERANCE &&
                    point.y <= handle.y + handle.h + HANDLE_TOLERANCE) {
                    return handle.name;
                }
            }
            return null;
        }

        // The selection's union box in screen space. Three call sites needed it and
        // each was building it inline.
        _selectionFrame(selected = this._selected()) {
            const box = this.Objects.unionBounds(selected);
            if (!box) return null;
            const tl = this.toScreen(box.x, box.y);
            return { x: tl.x, y: tl.y, w: box.w * this.view.zoom, h: box.h * this.view.zoom };
        }

        /* ------------------------------------------------------------ selection */

        select(ids, additive = false) {
            if (!additive) this.selection.clear();
            for (const id of ids) this.selection.add(id);
            this.invalidateOverlay();
        }

        selectAll() { this.select(this.objects.map(o => o.id)); }

        clearSelection() {
            if (!this.selection.size) return false;
            this.selection.clear();
            this.invalidateOverlay();
            return true;
        }

        cycleSelection(direction) {
            if (!this.objects.length) return;
            const ids = this.objects.map(o => o.id);
            const current = [...this.selection][0];
            let index = ids.indexOf(current);
            index = index === -1
                ? (direction > 0 ? 0 : ids.length - 1)
                : (index + direction + ids.length) % ids.length;
            this.select([ids[index]]);
            this._scrollIntoView(this._byId(ids[index]));
        }

        _scrollIntoView(obj) {
            if (!obj) return;
            const tl = this.toScreen(obj.x, obj.y);
            const br = this.toScreen(obj.x + obj.w, obj.y + obj.h);
            const margin = 40;
            let dx = 0, dy = 0;
            if (tl.x < margin) dx = margin - tl.x;
            else if (br.x > this.renderer.width - margin) dx = (this.renderer.width - margin) - br.x;
            if (tl.y < margin) dy = margin - tl.y;
            else if (br.y > this.renderer.height - margin) dy = (this.renderer.height - margin) - br.y;
            if (dx || dy) this.panBy(dx, dy);
        }

        /* --------------------------------------------------------------- undo */

        _push(command) {
            this._undo.push(command);
            if (this._undo.length > UNDO_LIMIT) this._undo.shift();
            this._redo.length = 0;
        }

        undo() {
            const command = this._undo.pop();
            if (!command) return false;
            command.undo();
            this._redo.push(command);
            this._touch();
            this.invalidate();
            return true;
        }

        redo() {
            const command = this._redo.pop();
            if (!command) return false;
            command.redo();
            this._undo.push(command);
            this._touch();
            this.invalidate();
            return true;
        }

        addObjects(objs, { select = true } = {}) {
            const copies = objs.map(deepCopy);
            // select:false means "not selected", not "leave the selection alone" — an
            // id can already be in the set from before the object was rebuilt.
            if (!select) for (const obj of copies) this.selection.delete(obj.id);
            const apply = () => {
                for (const obj of copies) if (!this._byId(obj.id)) this.objects.push(deepCopy(obj));
                this._invalidateIndex();
            };
            const revert = () => {
                const ids = new Set(copies.map(o => o.id));
                this.doc.objects = this.objects.filter(o => !ids.has(o.id));
                for (const id of ids) this.selection.delete(id);
            };
            apply();
            if (select) this.select(copies.map(o => o.id));
            this._push({ undo: revert, redo: () => { apply(); this.select(copies.map(o => o.id)); } });
            this._touch();
            this.invalidate();
            return copies.map(o => o.id);
        }

        removeObjects(ids) {
            const set = new Set(ids);
            // Index is captured so undo restores each object to its original z position
            // rather than dumping everything on top.
            const removed = [];
            this.objects.forEach((obj, index) => {
                if (set.has(obj.id)) removed.push({ index, obj: deepCopy(obj) });
            });
            if (!removed.length) return;

            const apply = () => {
                this.doc.objects = this.objects.filter(o => !set.has(o.id));
                for (const id of set) this.selection.delete(id);
                // Told now, not on the next painted frame. A live card's tile is a real
                // <browser> owned by the browser window; leaving it to the orphan sweep
                // means a running website hangs over the board for at least a frame, and
                // indefinitely if the tab is hidden when the delete happens.
                if (this.host.live) this.host.live.releaseMany(set);
            };
            const revert = () => {
                for (const { index, obj } of removed) this.objects.splice(index, 0, deepCopy(obj));
                this._invalidateIndex();
                this.select(removed.map(r => r.obj.id));
            };
            apply();
            this._push({ undo: revert, redo: apply });
            this._touch();
            this.invalidate();
        }

        // Snapshot-based mutation: capture the objects about to change, let the caller
        // mutate them freely, then commit. Cheaper than a command per property, and it
        // survives interactions that touch several fields at once.
        beginMutation(ids) {
            this._pending = {
                ids: [...ids],
                before: [...ids].map(id => deepCopy(this._byId(id))).filter(Boolean)
            };
        }

        commitMutation() {
            const pending = this._pending;
            this._pending = null;
            if (!pending || !pending.before.length) return;

            const after = pending.ids.map(id => this._byId(id)).filter(Boolean).map(deepCopy);
            if (JSON.stringify(pending.before) === JSON.stringify(after)) return;

            const restore = snapshots => () => {
                for (const snapshot of snapshots) {
                    const index = this.objects.findIndex(o => o.id === snapshot.id);
                    if (index !== -1) this.objects[index] = deepCopy(snapshot);
                }
                // Elements were swapped in place, so the array is the same object and
                // the identity check cannot see it. Saying so is what keeps the id
                // index from handing back the objects that were just replaced.
                this._invalidateIndex();
            };
            this._push({ undo: restore(pending.before), redo: restore(after) });
            this._touch();
        }

        /* ------------------------------------------------------------ snapping */

        // Called twice per object per pointer event during a move. Both values come from
        // the observer-backed cache; these used to be XPCOM pref reads, which is to say
        // hundreds per second while dragging.
        _snap(value, e) {
            const prefs = window.ZenEaselUtil.prefs;
            // Grid snapping is now one of three modes rather than a standalone toggle.
            // snap-to-grid is still honoured so an existing profile keeps its behaviour
            // without needing to know the pref was replaced.
            const gridMode = prefs["snap"] === "grid" || prefs["snap-to-grid"];
            // Alt inverts the preference, so snapping is always one modifier away
            // whichever way the pref is set.
            const active = e && e.altKey ? !gridMode : gridMode;
            if (!active) return value;
            const size = Math.max(2, prefs["grid-size"]);
            return Math.round(value / size) * size;
        }

        // Objects the moving selection could align to. Restricted to what is on screen:
        // aligning to something a thousand pixels off the viewport is never what was
        // meant, and it keeps the comparison proportional to what is visible rather than
        // to the size of the document.
        _nearbyCandidates(movedBox, movingIds) {
            const rect = this.root.getBoundingClientRect();
            const topLeft = this.toWorld(0, 0);
            const bottomRight = this.toWorld(rect.width, rect.height);

            return this.objects.filter(obj => {
                if (movingIds.has(obj.id)) return false;
                const box = this.Objects.bounds(obj);
                return box.x + box.w >= topLeft.x && box.x <= bottomRight.x &&
                    box.y + box.h >= topLeft.y && box.y <= bottomRight.y;
            });
        }

        // World units per millisecond, smoothed over the last sample. Used only to decide
        // whether a drag is a placement or a throw.
        _dragVelocity(world) {
            const now = performance.now();
            const last = this._lastDragSample;
            this._lastDragSample = { x: world.x, y: world.y, time: now };
            if (!last) return 0;

            const elapsed = now - last.time;
            if (elapsed <= 0) return 0;
            return Math.hypot(world.x - last.x, world.y - last.y) / elapsed;
        }

        /* -------------------------------------------------------- pointer input */

        _onPointerDown(e) {
            if (!this.doc) return;
            if (e.button === 2) return;                     // context menu handles its own

            // Every floating control lives inside the viewport, so its clicks bubble
            // here. Letting them through starts a marquee behind the control and clears
            // the selection out from under it — and the preventDefault below suppresses
            // the compatibility click event, so the control never fires at all. That is
            // why the +/Aa/- stepper did nothing.
            if (e.target && e.target.closest && e.target.closest(FLOATING_UI)) return;

            this.root.focus({ preventScroll: true });
            const screen = this._screenPoint(e);
            const world = this.toWorld(screen.x, screen.y);
            const tool = this.host.tools ? this.host.tools.active : "pointer";

            // Panning wins over every tool: middle-drag and Space+drag must work while
            // the pen is selected, or there is no way to navigate mid-drawing.
            if (e.button === 1 || this._spaceHeld) {
                this._startDrag({ mode: "pan", screen, startPan: { x: this.view.panX, y: this.view.panY } }, e);
                return;
            }
            if (e.button !== 0) return;

            if (this.host.textEditor.isEditing) this.stopEditing();

            const handle = this._handleAt(screen);
            if (handle) {
                const selected = this._selected();
                const box = this.Objects.unionBounds(selected);
                this.beginMutation(selected.map(o => o.id));
                this._beginActive(selected.map(o => o.id));

                if (handle === "rotate") {
                    const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
                    this._startDrag({
                        mode: "rotate",
                        centre,
                        // Where the pointer started, as an angle. Every later sample is
                        // measured against this, so grabbing the grip does not snap the
                        // selection to wherever the pointer happened to be.
                        startAngle: Math.atan2(world.y - centre.y, world.x - centre.x),
                        originals: selected.map(deepCopy)
                    }, e);
                    return;
                }

                this._startDrag({
                    mode: "resize",
                    handle,
                    world,
                    box,
                    // A rotated object resizes in its own frame, so the pointer has to be
                    // taken into that frame too. Only meaningful for a single object —
                    // a mixed multi-selection has no one frame to be in.
                    rotation: this._selectionRotation(selected),
                    originals: selected.map(deepCopy)
                }, e);
                return;
            }

            if (tool === "pointer") return this._pointerToolDown(e, world);
            if (tool === "pen") return this._penDown(e, world);
            if (tool === "text") return this._textToolDown(e, world);
            return this._shapeToolDown(e, world, tool);
        }

        _pointerToolDown(e, world) {
            const hit = this._hitTest(world.x, world.y);

            // A pointerdown that reaches the canvas at all means it did not land on the
            // active live tile — that one takes its own events. So anything here steps
            // out of a live card, and clicking a live card a second time steps into it.
            if (this.host.live && this.host.live.activeId && this.host.live.activeId !== (hit && hit.id)) {
                this.host.live.deactivate();
            }

            if (!hit) {
                if (!e.shiftKey) this.clearSelection();
                this._startDrag({ mode: "marquee", world, additive: e.shiftKey, base: new Set(this.selection) }, e);
                return;
            }

            // Clicking a live card hands the pointer straight to the page inside it —
            // one click, because anything more makes the card feel dead. Shift and Ctrl
            // are excluded so multi-select and duplicate still reach the board.
            //
            // The card's footer strip is deliberately not covered by the tile, so
            // dragging a live card by its title bar still moves it, and Escape hands the
            // pointer back.
            // The play/pause control in the card's title strip, checked before anything
            // else that a click on a card can mean. It sits in the footer precisely so it
            // stays reachable once the tile covers the art — without it, turning a card
            // back into a picture means finding the context menu.
            if (hit.type === "webcard" && !e.shiftKey && !e.ctrlKey &&
                this._hitLiveBadge(hit, world)) {
                this.select([hit.id]);
                this._toggleLive(hit);
                return;
            }

            if (this.host.live && this.host.live.isLive(hit.id) && !e.shiftKey && !e.ctrlKey) {
                this.select([hit.id]);
                this.host.live.activate(hit.id);
                return;
            }

            // A webBrowser object has no screenshot to fall back on, so a plain click is
            // what loads it — there is nothing to opt in to that clicking does not already
            // say. The card that is drawn until then tells you so.
            if (hit.type === "webBrowser" && !e.shiftKey && !e.ctrlKey &&
                this.host.live && this.host.live.canGoLive(hit)) {
                this.select([hit.id]);
                // Loaded, but deliberately not activated. Activating on load would hand the
                // pointer to the site immediately, and since the tile covers the card there
                // would then be no way to drag the thing you just made — you would have to
                // know to press Escape first. A second click hands it the pointer.
                this.host.live.requestLive(hit)
                    .catch(err => console.error("[zen-easel] could not load the tile:", err));
                return;
            }

            if (e.shiftKey) {
                if (this.selection.has(hit.id)) this.selection.delete(hit.id);
                else this.selection.add(hit.id);
                this.invalidateOverlay();
                return;
            }

            if (!this.selection.has(hit.id)) this.select([hit.id]);

            // Ctrl+drag duplicates: the copies are what move, leaving the originals in
            // place, which is what every canvas tool does.
            if (e.ctrlKey) {
                const copies = this._selected().map(obj => ({ ...deepCopy(obj), id: this.Objects.uuid() }));
                this.addObjects(copies);
            }

            const ids = [...this.selection];
            this.beginMutation(ids);
            this._beginActive(ids);
            this._startDrag({
                mode: "move",
                world,
                originals: ids.map(id => deepCopy(this._byId(id))).filter(Boolean)
            }, e);
        }

        _shapeToolDown(e, world, kind) {
            const obj = this.Objects.createObject("shape", {
                x: world.x, y: world.y, w: 0, h: 0,
                color: this.host.tools.color,
                // filled follows the toolbar's remembered choice, so drawing a run of solid
                // shapes does not mean setting each one afterwards. Lines and arrows ignore
                // it — the renderer never reaches the fill for them.
                shape: {
                    kind,
                    strokeWidth: this.host.tools.strokeWidth,
                    filled: !!this.host.tools.shapeFilled
                }
            });
            if (kind === "line" || kind === "arrow") {
                obj.shape.a = [0, 0];
                obj.shape.b = [1, 1];
            }
            this.objects.push(obj);
            this._invalidateIndex();
            // Deliberately not selected. The active canvas renders it from _activeIds,
            // so selection buys nothing here — and because _finishCreated re-adds the
            // object under the same id, an entry left in the selection set survived the
            // rebuild and put a transform box around every shape the moment it was
            // finished. That was the phantom bounding box.
            this._beginActive([obj.id]);
            this._startDrag({ mode: "draw-shape", world, id: obj.id }, e);
        }

        _penDown(e, world) {
            const obj = this.Objects.createObject("ink", {
                color: this.host.tools.color,
                ink: {
                    points: [[world.x, world.y, e.pressure > 0 ? e.pressure : 0.5]],
                    strokeWidth: this.host.tools.strokeWidth,
                    // A mouse reports a constant 0.5; only trust real pressure from a pen.
                    simulatePressure: e.pointerType !== "pen"
                }
            });
            this.Objects.recomputeInkBounds(obj);
            this.objects.push(obj);
            this._invalidateIndex();
            // The stroke lives on the active canvas for its whole life, so extending it
            // never touches the rest of the board. This is what makes a long stroke stay
            // flat instead of degrading as it grows.
            this._beginActive([obj.id]);
            this._startDrag({ mode: "draw-ink", id: obj.id }, e);
        }

        // Reachable only if something arms the text tool as a mode; the toolbar makes
        // it an action instead. Kept so the dispatch table has no hole.
        _textToolDown(e, world) {
            // Without this, the browser's own mousedown focus handling runs after we
            // return and pulls focus out of the editor we are about to open.
            e.preventDefault();
            this.host.tools.active = "pointer";
            this.placeTextBox({ x: this._snap(world.x, e), y: this._snap(world.y, e) });
        }

        _startDrag(state, e) {
            this._drag = { ...state, pointerId: e.pointerId, moved: false };
            try { this.root.setPointerCapture(e.pointerId); } catch (err) { }
            e.preventDefault();
        }

        _onPointerMove(e) {
            const drag = this._drag;
            if (!drag || e.pointerId !== drag.pointerId) return;
            drag.moved = true;

            // Ink consumes every sample the device produced between frames, not just
            // the one that woke us. Throttling to rAF without this would visibly
            // straighten fast strokes. Everything else only cares about the latest.
            if (drag.mode === "draw-ink") {
                const samples = typeof e.getCoalescedEvents === "function"
                    ? e.getCoalescedEvents()
                    : null;
                for (const sample of (samples && samples.length ? samples : [e])) {
                    this._updateDrawInk(drag, this._worldPoint(sample), sample);
                }
                this._paint();
                return;
            }

            const screen = this._screenPoint(e);
            const world = this.toWorld(screen.x, screen.y);

            switch (drag.mode) {
                case "pan":
                    this.view.panX = drag.startPan.x + (screen.x - drag.screen.x);
                    this.view.panY = drag.startPan.y + (screen.y - drag.screen.y);
                    // The board is a fixed-width page, so a pan must not be able to
                    // scroll past its edges. Zooming clamps, and so does a resize, but
                    // the drag itself never did — which is what let a middle-drag walk
                    // sideways off the page and made a bounded board look infinite.
                    this._clampView();
                    this._paintViewport();
                    break;

                case "marquee":
                    this._updateMarquee(drag, world);
                    break;

                case "move":
                    this._updateMove(drag, world, e);
                    break;

                case "resize":
                    this._updateResize(drag, world, e);
                    break;

                case "rotate":
                    this._updateRotate(drag, world, e);
                    break;

                case "draw-shape":
                    this._updateDrawShape(drag, world, e);
                    break;
            }
        }

        _updateMarquee(drag, world) {
            const box = {
                x: Math.min(drag.world.x, world.x),
                y: Math.min(drag.world.y, world.y),
                w: Math.abs(world.x - drag.world.x),
                h: Math.abs(world.y - drag.world.y)
            };

            const tl = this.toScreen(box.x, box.y);
            this._marquee = {
                x: tl.x, y: tl.y,
                w: box.w * this.view.zoom,
                h: box.h * this.view.zoom
            };

            this.selection = new Set(drag.additive ? drag.base : []);
            for (const obj of this.objects) {
                if (this.Objects.intersects(this.Objects.bounds(obj), box)) this.selection.add(obj.id);
            }
            this._paint();
        }

        _updateMove(drag, world, e) {
            let dx = world.x - drag.world.x;
            let dy = world.y - drag.world.y;

            // Shift locks to whichever axis has moved further, matching the constrain
            // behaviour of the drawing tools.
            if (e.shiftKey) {
                if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
            }

            // Alignment guides: nudge the selection so it lines up with something near
            // it, and remember the lines to draw. Alt suppresses it, on the same
            // principle as the grid — the modifier always gets you the raw position.
            //
            // Shift is deliberately excluded: an axis lock and a snap on that same axis
            // would fight, and the lock is the more specific instruction.
            if (this.guides && !e.altKey && !e.shiftKey) {
                const box = this.Objects.unionBounds(drag.originals);
                const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
                const moving = new Set(drag.originals.map(o => o.id));
                const candidates = this._nearbyCandidates(moved, moving);

                const nudge = this.guides.adjust(moved, candidates, this._dragVelocity(world));
                dx += nudge.dx;
                dy += nudge.dy;
            } else if (this.guides) {
                this.guides.clear();
            }

            for (const original of drag.originals) {
                const obj = this._byId(original.id);
                if (!obj) continue;
                const nextX = this._snap(original.x + dx, e);
                const nextY = this._snap(original.y + dy, e);
                if (obj.type === "ink") {
                    // Ink carries absolute world points; moving the box alone would
                    // leave the stroke behind.
                    const shiftX = nextX - original.x;
                    const shiftY = nextY - original.y;
                    obj.ink.points = original.ink.points.map(p => [p[0] + shiftX, p[1] + shiftY, p[2]]);
                }
                obj.x = nextX;
                obj.y = nextY;
            }
            this._paint();
        }

        // Turns the selection about its own centre. A single object simply gains the
        // angle; a multi-selection also has each member's centre carried around the
        // union's, which is what makes a group rotate as a group rather than as several
        // objects each spinning in place.
        //
        // Ink is the exception, and deliberately so: its points are absolute world
        // coordinates and its box is derived from the painted outline, so a stroke is
        // rotated by moving its samples rather than by setting a field. Doing it any
        // other way would leave the selection box and the visible stroke disagreeing.
        _updateRotate(drag, world, e) {
            const centre = drag.centre;
            const angle = Math.atan2(world.y - centre.y, world.x - centre.x);
            let degrees = ((angle - drag.startAngle) * 180) / Math.PI;

            // Shift snaps to 15°, the same increment the shape tools constrain to.
            if (e.shiftKey) degrees = Math.round(degrees / 15) * 15;

            for (const original of drag.originals) {
                const obj = this._byId(original.id);
                if (!obj) continue;

                if (obj.type === "ink") {
                    obj.ink.points = original.ink.points.map(p => {
                        const turned = this.Objects.rotatePoint(p[0], p[1], centre.x, centre.y, degrees);
                        return [turned.x, turned.y, p[2]];
                    });
                    this.Objects.recomputeInkBounds(obj);
                    continue;
                }

                obj.rotation = (original.rotation || 0) + degrees;

                // The object's own centre orbits the selection's. For a single object
                // the two coincide and this is a no-op, which is why there is no
                // special case for it.
                const own = {
                    x: original.x + original.w / 2,
                    y: original.y + original.h / 2
                };
                const moved = this.Objects.rotatePoint(own.x, own.y, centre.x, centre.y, degrees);
                obj.x = moved.x - obj.w / 2;
                obj.y = moved.y - obj.h / 2;
            }
            this._paint();
        }

        _updateResize(drag, world, e) {
            const box = drag.box;
            const handle = drag.handle;

            // A rotated object is resized in its own upright frame: the pointer is
            // rotated back out of the object's rotation, the box is computed as if
            // nothing were turned, and the renderer turns the result again when it
            // paints. Without this, dragging the east handle of a 45° box moves it
            // diagonally, which is the classic symptom.
            if (drag.rotation) {
                world = this.Objects.rotatePoint(
                    world.x, world.y,
                    box.x + box.w / 2, box.y + box.h / 2, -drag.rotation
                );
            }
            const west = handle.includes("w");
            const north = handle.includes("n");
            const horizontal = handle.includes("w") || handle.includes("e");
            const vertical = handle.includes("n") || handle.includes("s");

            let left = box.x, top = box.y, right = box.x + box.w, bottom = box.y + box.h;
            if (horizontal) {
                if (west) left = Math.min(this._snap(world.x, e), right - 1);
                else right = Math.max(this._snap(world.x, e), left + 1);
            }
            if (vertical) {
                if (north) top = Math.min(this._snap(world.y, e), bottom - 1);
                else bottom = Math.max(this._snap(world.y, e), top + 1);
            }

            let scaleX = (right - left) / Math.max(box.w, 0.001);
            let scaleY = (bottom - top) / Math.max(box.h, 0.001);

            // Corner handles with Shift keep the aspect ratio; edge handles are
            // single-axis by definition and ignore it.
            if (e.shiftKey && horizontal && vertical) {
                const scale = Math.min(scaleX, scaleY);
                scaleX = scaleY = scale;
                if (west) left = right - box.w * scale; else right = left + box.w * scale;
                if (north) top = bottom - box.h * scale; else bottom = top + box.h * scale;
            }
            if (!horizontal) scaleX = 1;
            if (!vertical) scaleY = 1;

            for (const original of drag.originals) {
                const obj = this._byId(original.id);
                if (!obj) continue;
                obj.x = left + (original.x - box.x) * scaleX;
                obj.y = top + (original.y - box.y) * scaleY;
                obj.w = Math.max(original.w * scaleX, 1);
                obj.h = Math.max(original.h * scaleY, 1);

                if (obj.type === "ink") {
                    obj.ink.points = original.ink.points.map(p => [
                        left + (p[0] - box.x) * scaleX,
                        top + (p[1] - box.y) * scaleY,
                        p[2]
                    ]);
                    this.Objects.recomputeInkBounds(obj);
                }
                if (obj.type === "text") {
                    // Text height follows its content; only the wrap width is user-set.
                    obj.h = this.renderer.measureTextHeight(obj);
                }
            }
            this._paint();
        }

        _updateDrawShape(drag, world, e) {
            const obj = this._byId(drag.id);
            if (!obj) return;

            let x2 = world.x, y2 = world.y;
            const isLine = obj.shape.kind === "line" || obj.shape.kind === "arrow";

            if (e.shiftKey) {
                const dx = x2 - drag.world.x, dy = y2 - drag.world.y;
                if (isLine) {
                    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
                    const length = Math.hypot(dx, dy);
                    x2 = drag.world.x + Math.cos(angle) * length;
                    y2 = drag.world.y + Math.sin(angle) * length;
                } else {
                    const size = Math.max(Math.abs(dx), Math.abs(dy));
                    x2 = drag.world.x + Math.sign(dx || 1) * size;
                    y2 = drag.world.y + Math.sign(dy || 1) * size;
                }
            }

            obj.x = Math.min(drag.world.x, x2);
            obj.y = Math.min(drag.world.y, y2);
            obj.w = Math.abs(x2 - drag.world.x);
            obj.h = Math.abs(y2 - drag.world.y);

            if (isLine) {
                // Endpoints are fractions of the box, so record which corner the drag
                // started from rather than assuming top-left to bottom-right.
                obj.shape.a = [x2 >= drag.world.x ? 0 : 1, y2 >= drag.world.y ? 0 : 1];
                obj.shape.b = [x2 >= drag.world.x ? 1 : 0, y2 >= drag.world.y ? 1 : 0];
            }
            this._paint();
        }

        // Bounds are extended incrementally instead of being recomputed from the whole
        // point list. The old version was O(n) per sample, which made a single long
        // stroke O(n^2) and visibly slower the longer it got.
        _updateDrawInk(drag, world, e) {
            const obj = this._byId(drag.id);
            if (!obj) return;
            const points = obj.ink.points;
            const last = points[points.length - 1];

            // Drop samples closer than half a screen pixel: at high zoom a slow drag
            // otherwise records hundreds of collinear points.
            const minStep = 0.5 / this.view.zoom;
            if (last && Math.hypot(world.x - last[0], world.y - last[1]) < minStep) return;

            points.push([world.x, world.y, e && e.pressure > 0 ? e.pressure : 0.5]);

            const pad = (obj.ink.strokeWidth || 4) / 2 + 1;
            const minX = Math.min(obj.x, world.x - pad);
            const minY = Math.min(obj.y, world.y - pad);
            const maxX = Math.max(obj.x + obj.w, world.x + pad);
            const maxY = Math.max(obj.y + obj.h, world.y + pad);
            obj.x = minX;
            obj.y = minY;
            obj.w = maxX - minX;
            obj.h = maxY - minY;
        }

        _onPointerUp(e) {
            const drag = this._drag;
            if (!drag || e.pointerId !== drag.pointerId) return;
            this._drag = null;
            try { this.root.releasePointerCapture(e.pointerId); } catch (err) { }

            switch (drag.mode) {
                case "pan":
                    this._paint.flush();
                    this._touch();
                    break;

                case "marquee":
                    this._marquee = null;
                    this._paint();
                    break;

                case "move":
                case "resize":
                case "rotate":
                    this.commitMutation();
                    this._endActive();
                    break;

                case "draw-shape": {
                    const obj = this._byId(drag.id);
                    if (!obj) break;
                    // A click with no drag would leave a zero-size shape that cannot be
                    // seen or selected; give it a default box instead.
                    if (obj.w < 4 && obj.h < 4) {
                        obj.w = 160;
                        obj.h = 120;
                        if (obj.shape.kind === "line" || obj.shape.kind === "arrow") {
                            obj.h = 0;
                            obj.shape.a = [0, 0.5];
                            obj.shape.b = [1, 0.5];
                        }
                    }
                    this.Objects.normalize(obj);
                    this._finishCreated(obj);
                    break;
                }

                case "draw-ink": {
                    const obj = this._byId(drag.id);
                    if (!obj) break;
                    // A click leaves a dot, as it does in Excalidraw. The freehand
                    // module renders a lone sample as a filled circle at the stroke's
                    // own width, so no special case is needed beyond keeping it.
                    if (!obj.ink.points.length) {
                        this.doc.objects = this.objects.filter(o => o.id !== obj.id);
                        this.selection.delete(obj.id);
                        this._endActive();
                        break;
                    }
                    // Final bounds come from the painted outline, so the selection box
                    // matches the ink rather than the raw samples.
                    this.Objects.recomputeInkBounds(obj);
                    this._finishCreated(obj);
                    break;
                }
            }
        }

        // Objects drawn by dragging are pushed straight into the array so they render
        // live. Rewinding that and re-adding through addObjects is what puts a single
        // clean entry on the undo stack.
        _finishCreated(obj) {
            const snapshot = deepCopy(obj);
            this.doc.objects = this.objects.filter(o => o.id !== obj.id);
            // Nothing is selected after being drawn. A transform box thrown around
            // every finished shape is in the way of the next one, and you have just
            // said where you wanted it — selection is for when you come back to it.
            this.addObjects([snapshot], { select: false });
            this._endActive();
            if (this.host.tools) this.host.tools.afterCreate();
        }

        /* --------------------------------------------------------- wheel & misc */

        _onWheel(e) {
            if (!this.doc) return;
            e.preventDefault();

            const screen = this._screenPoint(e);
            const step = e.deltaMode === 1 ? 16 : 1;   // DOM_DELTA_LINE
            const zoomWheel = window.ZenEaselUtil.prefs.wheel !== "pan";

            // Ctrl+wheel always zooms, in either mode: it is the near-universal binding,
            // and it is also how Gecko reports a touchpad pinch, so pinch keeps working
            // without a line of gesture-specific code.
            if (e.ctrlKey || (zoomWheel && !e.shiftKey)) {
                this.zoomAt(screen.x, screen.y, this._nextZoom(e.deltaY * step));
                return;
            }

            if (e.shiftKey) this.panBy(-e.deltaY * step, 0);
            else this.panBy(-e.deltaX * step, -e.deltaY * step);
        }

        _onDblClick(e) {
            if (!this.doc) return;
            const world = this._worldPoint(e);
            const hit = this._hitTest(world.x, world.y);

            if (hit && hit.type === "text") {
                this.startEditing(hit.id, { selectAll: true });
                e.preventDefault();
                return;
            }
            if (hit && hit.type === "webcard" && hit.webcard.url) {
                this.host.capture.openWebcard(hit);
                e.preventDefault();
                return;
            }
            // Double-clicking empty canvas deliberately does nothing. It used to place a
            // text box, which meant every mis-aimed double-click on the board left a
            // stray empty box behind. The toolbar's text button is the way in.
        }

        _onContextMenu(e) {
            if (!this.doc) return;
            e.preventDefault();
            const world = this._worldPoint(e);
            const hit = this._hitTest(world.x, world.y);
            if (hit && !this.selection.has(hit.id)) this.select([hit.id]);
            else if (!hit) this.clearSelection();
            this.host.tools.showContextMenu(this._screenPoint(e), hit, world);
        }

        _onDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        }

        _onDrop(e) {
            e.preventDefault();
            if (!this.doc) return;
            const world = this._worldPoint(e);
            this.host.capture.handleDrop(e, world).catch(err => console.error("[zen-easel] drop failed:", err));
        }

        _onKeyDown(e) {
            if (this.handleKeyDown(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }

        _onKeyUp(e) {
            if (e.code === "Space") this._spaceHeld = false;
        }

        /* ------------------------------------------------------------- editing */

        // The text tool is an action, not a mode: it drops a ready box in the middle of
        // the view with its placeholder selected, so typing replaces it immediately.
        //
        // This also removes a failure that looked like the tool doing nothing at all.
        // Boxes used to be created empty, and an empty box is discarded the moment the
        // editor loses focus — so anything that stole focus in that first instant
        // deleted the object before it could be seen. A box that starts with text in it
        // cannot vanish that way.
        placeTextBox(at = null) {
            if (!this.doc) return;

            const tools = this.host.tools;
            const width = 420;
            const centre = at || this.toWorld(this.renderer.width / 2, this.renderer.height / 2);

            const obj = this.Objects.createObject("text", {
                x: Math.round(centre.x - (at ? 0 : width / 2)),
                y: Math.round(centre.y),
                w: width,
                color: tools.color,
                text: {
                    content: "Textbox",
                    fontSize: tools.fontSize,
                    fontFamily: tools.fontFamily,
                    align: "left"
                }
            });
            obj.h = this.renderer.measureTextHeight(obj);

            this.addObjects([obj]);
            this.startEditing(obj.id, { selectAll: true });
        }

        startEditing(id, options) {
            const obj = this._byId(id);
            if (!obj || obj.type !== "text") return;
            // Committing through stopEditing rather than letting the editor replace
            // itself, so the open mutation and _hiddenId are cleaned up too.
            if (this.host.textEditor.isEditing) this.stopEditing();
            this.select([id]);
            this.beginMutation([id]);
            // Hidden from the static pass: the textarea is the visible copy while
            // editing, so painting it underneath would double every glyph.
            this._hiddenId = id;
            this._staticDirty = true;
            this.host.textEditor.start(obj, options);
            this._paint();
        }

        stopEditing() {
            const id = this.host.textEditor.commit();
            this._hiddenId = null;
            if (!id) return;

            this.commitMutation();

            const obj = this._byId(id);
            // An empty box left behind by an abandoned edit is invisible clutter.
            if (obj && !(obj.text.content || "").trim()) this.removeObjects([id]);

            this.root.focus({ preventScroll: true });
            this.invalidate();
        }

        /* -------------------------------------------------------------- keyboard */

        // Returns true when the key was consumed, so the controller knows not to fall
        // through to its own handling (notably Escape closing the overlay).
        handleKeyDown(e) {
            if (!this.doc) return false;
            const ctrl = e.ctrlKey && !e.altKey;

            // The textarea handles its own keys and stops them propagating; anything
            // arriving here while editing is not meant for the canvas.
            if (this.host.textEditor.isEditing) {
                if (e.code === "Escape") { this.stopEditing(); return true; }
                return false;
            }

            // Buttons and inputs inside the overlay keep their own keys, so Space and
            // Enter activate the focused control instead of arming a canvas pan.
            const target = e.composedPath()[0];
            const name = target && target.localName ? target.localName.toLowerCase() : "";
            if (e.code !== "Escape" && ["button", "input", "textarea", "select"].includes(name)) {
                return false;
            }

            if (e.code === "Space" && !ctrl) {
                this._spaceHeld = true;
                e.preventDefault();
                return true;
            }

            if (e.code === "Escape") return this._handleEscape();
            if (ctrl) return this._handleCtrlKey(e);
            if (e.altKey) return false;

            switch (e.code) {
                case "Delete":
                case "Backspace":
                    if (!this.selection.size) return false;
                    this.removeObjects([...this.selection]);
                    return true;

                case "Tab":
                    this.cycleSelection(e.shiftKey ? -1 : 1);
                    return true;

                case "ArrowUp":
                case "ArrowDown":
                case "ArrowLeft":
                case "ArrowRight":
                    return this._handleArrow(e);
            }

            if (e.shiftKey) return false;
            return this.host.tools.handleShortcutKey(e);
        }

        // Escape is a cascade, not a single binding: cancel the drag, then drop the
        // tool, then deselect, and only decline (letting the overlay close) once there
        // is nothing left to cancel.
        _handleEscape() {
            if (this._drag) {
                this._cancelDrag();
                return true;
            }
            // Stepping out of a live card comes first: while one is active the pointer
            // belongs to a website, and getting back out is the most urgent thing Escape
            // can do.
            if (this.host.live && this.host.live.activeId) {
                this.host.live.deactivate();
                this.root.focus({ preventScroll: true });
                return true;
            }
            if (this.host.tools.active !== "pointer") {
                this.host.tools.setActive("pointer");
                return true;
            }
            if (this.selection.size) {
                this.clearSelection();
                return true;
            }
            return false;
        }

        _cancelDrag() {
            const drag = this._drag;
            this._drag = null;
            this._marquee = null;

            if (drag.mode === "draw-shape" || drag.mode === "draw-ink") {
                this.doc.objects = this.objects.filter(o => o.id !== drag.id);
            } else if (drag.mode === "move" || drag.mode === "resize" || drag.mode === "rotate") {
                for (const original of drag.originals) {
                    const index = this.objects.findIndex(o => o.id === original.id);
                    if (index !== -1) this.objects[index] = deepCopy(original);
                }
                this._invalidateIndex();
                this._pending = null;
            }
            this._endActive();
            this.invalidate();
        }

        _handleArrow(e) {
            const delta = e.shiftKey ? 10 : 1;
            const dx = (e.code === "ArrowRight" ? delta : 0) - (e.code === "ArrowLeft" ? delta : 0);
            const dy = (e.code === "ArrowDown" ? delta : 0) - (e.code === "ArrowUp" ? delta : 0);

            if (!this.selection.size) {
                // Nothing selected: arrows pan, so the canvas is navigable without a
                // mouse at all.
                this.panBy(-dx * 40, -dy * 40);
                return true;
            }

            const ids = [...this.selection];
            this.beginMutation(ids);
            for (const id of ids) {
                const obj = this._byId(id);
                if (!obj) continue;
                obj.x += dx;
                obj.y += dy;
                if (obj.type === "ink") {
                    obj.ink.points = obj.ink.points.map(p => [p[0] + dx, p[1] + dy, p[2]]);
                }
            }
            this.commitMutation();
            this.invalidate();
            return true;
        }

        _handleCtrlKey(e) {
            // Undo is the only Ctrl binding that uses Shift as a modifier of its own.
            if (e.code === "KeyZ") {
                e.shiftKey ? this.redo() : this.undo();
                return true;
            }
            if (e.code === "KeyS" && e.shiftKey) {
                this.host.tools._export("png");
                return true;
            }
            // Everything below is Ctrl-only. Declining Ctrl+Shift+<key> here is what
            // leaves Ctrl+Shift+2 free for the global capture shortcut.
            if (e.shiftKey) return false;

            switch (e.code) {
                case "KeyY":
                    // Windows' other redo binding.
                    this.redo();
                    return true;
                case "KeyA": this.selectAll(); return true;
                case "KeyD": this.duplicateSelection(); return true;
                case "KeyC": this.copySelection(); return true;
                case "KeyX":
                    this.copySelection();
                    this.removeObjects([...this.selection]);
                    return true;
                case "KeyV":
                    // Deliberately NOT consumed — returning true here would preventDefault
                    // the keystroke, and preventDefault on Ctrl+V is exactly what stops the
                    // browser generating the `paste` event that carries the clipboard. The
                    // event is where the data actually arrives; see _onPaste.
                    //
                    // The timer is the safety net for a document that never gets one.
                    this._armPasteFallback();
                    return false;
                case "Digit0":
                case "Numpad0": this.resetZoom(); return true;
                case "Digit1":
                case "Numpad1": this.zoomToFit(); return true;
                case "Digit2":
                case "Numpad2":
                    if (this.selection.size) this.zoomToFit(this._selected());
                    return true;
                case "Equal":
                case "NumpadAdd": this.zoomBy(ZOOM_STEP); return true;
                case "Minus":
                case "NumpadSubtract": this.zoomBy(1 / ZOOM_STEP); return true;
                case "BracketRight": this.reorderSelection(1); return true;
                case "BracketLeft": this.reorderSelection(-1); return true;
            }
            return false;
        }

        /* ------------------------------------------------------------ clipboard */

        // `system: false` for Ctrl+D, which copies only so that it can immediately paste
        // and has no business touching what the user has on their clipboard.
        copySelection({ system = true } = {}) {
            if (!this.selection.size) return;
            const objects = this._selected();
            this._clipboard = objects.map(deepCopy);

            // Copying in the easel now writes to the system clipboard too, and that is what
            // makes Ctrl+V unambiguous.
            //
            // Two clipboards can both hold something pasteable — the easel's objects and the
            // system's — and nothing about their *contents* says which the user meant. Only
            // recency does. The first attempt asked the OS directly, via
            // nsIClipboard.getSequenceNumber, which this build does not expose: the call
            // threw, the guard turned that into "unknown", and "unknown" fell back to
            // preferring our own objects. So anything ever copied in the easel won every
            // paste from then on, which is exactly the bug.
            //
            // Writing a token instead removes the question. The OS owns recency, as it
            // already did for everything else: if what comes back on paste is still the
            // string we wrote, nothing has been copied anywhere since, and our objects are
            // current. If it is anything else, they are not. No special interface needed,
            // and text/plain is the one flavour guaranteed to survive the round trip.
            //
            // It is also a real clipboard payload rather than a marker — paste into a text
            // editor and you get the text you copied, or a description of what you copied.
            if (system) {
                const token = this._clipboardTokenFor(objects);
                this._clipboardToken = this._writeSystemText(token) ? token : null;
            }
        }

        // What copying these objects puts on the system clipboard. Their text if they have
        // any, because that is what someone pasting into another application wants; a plain
        // description otherwise, so the payload is never empty and never a bare marker.
        _clipboardTokenFor(objects) {
            const text = objects
                .filter(o => o.type === "text" && o.text && o.text.content)
                .map(o => o.text.content)
                .join("\n\n");
            if (text) return text;

            const count = objects.length;
            return `${count} ${count === 1 ? "object" : "objects"} copied from Zen Easel`;
        }

        _writeSystemText(text) {
            try {
                Cc["@mozilla.org/widget/clipboardhelper;1"]
                    .getService(Ci.nsIClipboardHelper)
                    .copyString(text);
                return true;
            } catch (e) {
                console.error("[zen-easel] could not write to the clipboard:", e);
                return false;
            }
        }

        // Whether the easel's own objects are still the most recent thing copied.
        //
        // `text` is the system clipboard's text/plain, and `hasBinary` whether it also
        // carries an image or a file. Binary content always wins: we never write any, so
        // its presence means something was copied after us even if the text happens to
        // match.
        _internalIsCurrent(text, hasBinary) {
            if (!this._clipboard.length) return false;
            if (hasBinary) return false;
            // No token means the clipboard write failed, so there is nothing to compare and
            // no basis for claiming our objects are current.
            if (this._clipboardToken === null) return false;
            return text === this._clipboardToken;
        }

        // The clipboard, delivered by the browser.
        //
        // This is the path that actually works, and the reason the first attempt did not:
        // reading the clipboard by hand through nsITransferable meant re-implementing every
        // conversion Gecko already does — an image copied from a page is not sitting there
        // as PNG bytes, it is a platform bitmap that has to be recognised, decoded and
        // re-encoded, and each of those steps is a place to be subtly wrong. The paste event
        // hands over a DataTransfer with all of that done, identical in shape to the one a
        // drop provides. So paste and drop are now literally the same code, and a format
        // that can be dropped onto a board can be pasted onto it by construction.
        _onPaste(e) {
            if (!this.doc) return;
            // The textarea owns its own paste while a text box is being edited.
            if (this.host.textEditor.isEditing) return;

            // The event arrived, so the fallback must not also fire.
            if (this._pasteFallbackTimer) {
                window.clearTimeout(this._pasteFallbackTimer);
                this._pasteFallbackTimer = null;
            }

            const dt = e.clipboardData;
            if (!dt) return;

            e.preventDefault();
            e.stopPropagation();

            const capture = this.host.capture;
            if (!capture) return;

            // The event carries the live system clipboard, so the comparison is exact: if
            // its text is still the token we wrote at Ctrl+C, and nothing binary has been
            // copied since, our objects are the most recent copy. See copySelection.
            const hasBinary = !!(dt.files && dt.files.length) ||
                [...(dt.types || [])].some(t => t.startsWith("image/"));
            if (this._internalIsCurrent(dt.getData("text/plain"), hasBinary)) {
                this.paste();
                return;
            }

            capture.handleTransfer(dt, null)
                .then(placed => {
                    if (placed) return;
                    if (this._clipboard.length) this.paste();
                    else this.host.toast("There is nothing on the clipboard to paste here");
                })
                .catch(err => {
                    console.error("[zen-easel] paste failed:", err);
                    this.host.toast("Could not paste that");
                });
        }

        // Ctrl+V was pressed but no paste event followed, so the clipboard has to be read
        // directly after all. Short enough not to be felt, long enough that a real event
        // always wins the race.
        _armPasteFallback() {
            if (this._pasteFallbackTimer) window.clearTimeout(this._pasteFallbackTimer);
            this._pasteFallbackTimer = window.setTimeout(() => {
                this._pasteFallbackTimer = null;
                this.pasteFromClipboard()
                    .catch(e => console.error("[zen-easel] paste failed:", e));
            }, 120);
        }

        // The direct read, used by "Paste here" — which has no keystroke and so never
        // produces a paste event — and as the fallback above. Chooses between the two
        // clipboards and places whatever wins at `at`, or centred when that is null.
        async pasteFromClipboard(at = null) {
            const capture = this.host.capture;

            // Same test as _onPaste, against a directly-read clipboard rather than an
            // event's copy of it.
            const hasBinary = !!(capture && capture.hasClipboardBinary());
            const text = capture ? capture.clipboardText() : null;
            if (this._internalIsCurrent(text, hasBinary)) {
                this.paste(at);
                return;
            }

            let placed = false;
            try {
                placed = capture ? await capture.handlePaste(at) : false;
            } catch (e) {
                console.error("[zen-easel] paste failed:", e);
                this.host.toast("Could not paste that");
                return;
            }

            // Nothing usable on the system clipboard — an empty one, or a flavour we do not
            // place. Our own objects are then the only candidate left, whatever the
            // sequence number says.
            if (placed) return;
            if (this._clipboard.length) {
                this.paste(at);
                return;
            }
            // Both clipboards empty-handed. Ctrl+V is consumed by this canvas either way,
            // so without this the key would simply do nothing with no explanation.
            this.host.toast("There is nothing on the clipboard to paste here");
        }

        // Whether Ctrl+V would do anything, for the context menu's disabled state.
        canPaste() {
            if (this._clipboard.length) return true;
            try {
                return !!(this.host.capture && this.host.capture.canPaste());
            } catch (e) {
                return false;
            }
        }

        // `at` places the group's top-left corner at a world point — what "Paste here"
        // means. Without it the copies step 16px down and right, so a chained Ctrl+V walks
        // down the canvas rather than stacking, and duplicateSelection keeps its offset.
        paste(at = null) {
            if (!this._clipboard.length) return;

            let dx = 16, dy = 16;
            if (at) {
                const bounds = this.Objects.unionBounds(this._clipboard);
                if (bounds) {
                    dx = Math.round(at.x - bounds.x);
                    dy = Math.round(at.y - bounds.y);
                }
            }

            const copies = this._clipboard.map(obj => {
                const copy = { ...deepCopy(obj), id: this.Objects.uuid() };
                copy.x += dx;
                copy.y += dy;
                // Ink points are absolute, so they travel with the object rather than
                // being relative to its box.
                if (copy.type === "ink") {
                    copy.ink.points = copy.ink.points.map(p => [p[0] + dx, p[1] + dy, p[2]]);
                }
                return copy;
            });
            this.addObjects(copies);
            // Chained pastes should walk down the canvas rather than stacking. The token is
            // untouched: pasting does not change what is on the system clipboard, so the
            // next Ctrl+V must still compare against what the original copy wrote.
            this._clipboard = copies.map(deepCopy);
        }

        duplicateSelection() {
            if (!this.selection.size) return;
            // Ctrl+D is a copy only in the sense that it needs something to paste. It must
            // not overwrite what the user has on their clipboard.
            this.copySelection({ system: false });
            this.paste();
        }

        reorderSelection(direction) {
            if (!this.selection.size) return;
            const ids = [...this.selection];
            const moving = this.objects.filter(o => ids.includes(o.id));
            const rest = this.objects.filter(o => !ids.includes(o.id));
            const before = this.objects.slice();
            this.doc.objects = direction > 0 ? [...rest, ...moving] : [...moving, ...rest];
            const after = this.objects.slice();
            this._push({
                undo: () => { this.doc.objects = before.slice(); },
                redo: () => { this.doc.objects = after.slice(); }
            });
            this._touch();
            this.invalidate();
        }

        setSelectionColor(color) {
            if (!this.selection.size) return;
            const ids = [...this.selection];
            this.beginMutation(ids);
            for (const id of ids) {
                const obj = this._byId(id);
                if (obj) obj.color = color;
            }
            this.commitMutation();
            // Cached ink bitmaps are keyed on the colour *key*, so a recolour has to
            // say so explicitly — nothing about the geometry changed.
            this.renderer.invalidateInkCache();
            this.invalidate();
        }

        // The stroke-width half of the same idea. Only shapes and ink carry a width;
        // text and cards are left alone rather than being given a meaningless field.
        setSelectionStroke(width) {
            if (!this.selection.size) return;
            const ids = [...this.selection];
            this.beginMutation(ids);
            let changed = false;
            for (const id of ids) {
                const obj = this._byId(id);
                if (!obj) continue;
                if (obj.type === "shape") {
                    obj.shape.strokeWidth = width;
                    changed = true;
                } else if (obj.type === "ink") {
                    obj.ink.strokeWidth = width;
                    // The painted outline is what defines an ink object's box, so a
                    // width change moves its bounds.
                    this.Objects.recomputeInkBounds(obj);
                    changed = true;
                }
            }
            // commitMutation compares snapshots and discards a no-op, so a selection of
            // text boxes puts nothing on the undo stack.
            this.commitMutation();
            if (!changed) return;
            this.renderer.invalidateInkCache();
            this.invalidate();
        }

        // The shape equivalent of setSelectionText: patches obj.shape on every selected
        // shape and leaves everything else alone. `filled` is the only field the floating
        // shape controls set today, but the shape is a patch so stroke style or a separate
        // fill colour can join it without a second method.
        setSelectionShape(patch) {
            const ids = [...this.selection].filter(id => {
                const obj = this._byId(id);
                return obj && obj.type === "shape";
            });
            if (!ids.length) return false;

            this.beginMutation(ids);
            for (const id of ids) {
                const obj = this._byId(id);
                if (obj) Object.assign(obj.shape, patch);
            }
            // commitMutation compares snapshots and discards a no-op, so re-applying the
            // fill a shape already has puts nothing on the undo stack.
            this.commitMutation();
            this.invalidate();
            return true;
        }

        // Returns true when it actually changed something, so the toolbar knows whether
        // the click landed on a selection or was only setting a default.
        setSelectionText(patch) {
            const editing = this.host.textEditor.isEditing ? this.host.textEditor.editing : null;
            const ids = [...this.selection].filter(id => {
                const obj = this._byId(id);
                return obj && obj.type === "text";
            });
            if (!ids.length && editing) ids.push(editing);
            if (!ids.length) return false;

            // A box being edited already has an open mutation from startEditing.
            // Reusing it keeps the restyling and the typing as one undo step.
            const piggyback = editing && ids.includes(editing);
            if (!piggyback) this.beginMutation(ids);

            for (const id of ids) {
                const obj = this._byId(id);
                if (obj && obj.type === "text") {
                    Object.assign(obj.text, patch);
                    obj.h = this.renderer.measureTextHeight(obj);
                }
            }

            if (piggyback) this._touch();
            else this.commitMutation();

            this.invalidate();
            return true;
        }
    }

    window.ZenEaselCanvas = ZenEaselCanvas;
})();
