// Zen Easel — live web cards, page side.
//
// A webcard is a screenshot of a region of a page. Going live replaces those pixels with
// the real site, cropped to the same region: the browser is laid out at exactly the viewport
// size the capture was taken at, scrolled to the same offset, and scaled so the captured
// rectangle fills the card. That is why the crop is stored as a bounding box rather than a
// CSS selector — geometry degrades to "the wrong part of the page" when a site is redesigned,
// where a selector degrades to nothing at all. Arc makes the same trade for the same reason.
//
// This file is a *view*: which of the open board's cards are live, which one has the pointer,
// and where each one belongs on screen. It owns no elements at all, and — since a tile now
// outlives both this page and any one board being open — it is no longer the record of what
// is running either. That is the host's, along with the cap and its LRU, because this page
// only ever knows about the board it has open and a ceiling counted here would read three
// while the window was running nine.
//
// So the traffic across the seam runs both ways now. This page reports *facts* — "offscreen",
// "a menu is over this one", "my board is in the background" — and the host decides what they
// mean; and on attach, the host reports back what it is already running on the board being
// opened, which is adopted rather than started again.
//
// The elements live in the browser window, in modules-host/live-host.uc.js, because a
// <browser> cannot exist inside about:easel — it is a system-principal chrome document and
// Gecko refuses web content in one, in every form that was tried. That file's header records
// the four variants and how each failed. The split is not an abstraction for its own sake;
// it is the only arrangement that runs.
//
// What crosses the seam is plain data: an id, a URL string, and rectangles in the page's own
// viewport coordinates. The host places its layer exactly over this page's <browser>, so
// those coordinates need no translation — which is also what clips a tile panned past the
// edge of the board instead of letting it paint over Zen's sidebar.

"use strict";

(function () {
    if (window.ZenEaselLiveLayer) return;

    const { safeExternalUrl } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/validate.sys.mjs");

    // How long a tile stays *painting* after scrolling out of view before it stops and the
    // screenshot comes back. It keeps running either way — this is about pixels, not life.
    //
    // Was five seconds, because going offscreen used to mean a teardown and a reload, and
    // the grace existed to make a fast pan survivable. It costs a visibility flip now, so it
    // only has to be long enough that flicking across the board does not thrash every tile
    // it passes over.
    const OFFSCREEN_PAINT_GRACE_MS = 750;

    // Height of the title strip the canvas renderer draws at the bottom of a webcard, and of
    // the URL strip it draws at the top of a web tile. Both in world units, and both owned by
    // renderer.uc.js — the tile is inset so the canvas keeps drawing them.
    const FOOTER_HEIGHT = 30;
    const WEB_BROWSER_BAR = 28;

    class ZenEaselLiveLayer {
        constructor(host) {
            this.host = host;
            this.log = window.ZenEaselUtil.log;

            // objectId -> obj, for the attached board only. No DOM: the elements are the
            // host's, and so — since tiles outlive both this page and any one board being
            // open — is the record of everything running in the window. This is a view.
            this._tiles = new Map();
            // Which board this view is attached to. Null until the first setDocument.
            this._easelId = null;
            this._activeId = null;
            this._suspended = false;
            this._gestureIds = [];
            this._offscreenSince = new Map();
            // Last viewport size the offscreen test ran against; see sync().
            this._lastWidth = 0;
            this._lastHeight = 0;
            // Tiles currently reported to the host as outside the viewport. Still mounted,
            // still running — the canvas paints their screenshot again in the meantime.
            this._offscreen = new Set();
            // Tiles hidden because something in the page needs to be seen over them.
            // Still mounted, still live — just not painting. See suppressOverlapping.
            this._suppressed = new Set();
            // Whether the host currently has this board's layer on screen. Starts true so
            // nothing changes until the host says otherwise; see setHostPainting.
            this._hostPainting = true;
            // Deferred work owned by foreground(): the delay that keeps the tiles out of the
            // tab-switch animation, and the settle passes that follow it. Declared rather
            // than left to appear on first use, so that every field this class has is
            // visible in one place.
            this._revealTimer = null;
            this._resyncTimer = null;
        }

        get enabled() {
            return window.ZenEaselUtil.prefs["live.enabled"];
        }

        get bridge() {
            return this.host.bridge;
        }

        /* -------------------------------------------------------- capability */

        canGoLive(obj) {
            if (!this.enabled || !this.bridge) return false;
            if (!obj) return false;

            // A web tile is live by definition — there is no screenshot behind it, so the
            // only question is whether its URL is one we are willing to load.
            if (obj.type === "webBrowser") return !!this._urlFor(obj);

            if (obj.type !== "webcard") return false;
            const capture = obj.webcard && obj.webcard.capture;
            if (!capture || !capture.webContentSize || !capture.frameRelativeToViewport) return false;
            return !!this._urlFor(obj);
        }

        // The scheme gate, plus the narrower transport gate that applies only here: a stored
        // http: link is fine to keep and to open in a tab, but silently loading it inside an
        // easel is a downgrade the user did not ask for.
        _urlFor(obj) {
            const source = obj.type === "webBrowser" ? obj.webBrowser : obj.webcard;
            const url = safeExternalUrl(source && source.url);
            if (!url) return null;
            if (url.startsWith("http://") && !window.ZenEaselUtil.prefs["live.allow-http"]) return null;
            return url;
        }

        isLive(objectId) {
            return this._tiles.has(objectId);
        }

        // Whether a tile is actually painting right now. Distinct from isLive, and the
        // renderer wants this one: a card that is offscreen, mid-drag or behind a menu is
        // still live — still loaded, still running — but its pixels are not on screen, so
        // the canvas has to go back to drawing the screenshot or the card would be a hole.
        //
        // Every reason the host might not be painting a tile has to be listed here, because
        // this is the only thing standing between "not painted by the host" and "not painted
        // by anyone". _gestureIds was missing, which is why dragging a live webcard drew a
        // hole instead of the screenshot proxy the drag was supposed to show.
        showsTile(objectId) {
            return this._hostPainting &&
                this._tiles.has(objectId) &&
                !this._suppressed.has(objectId) &&
                !this._offscreen.has(objectId) &&
                !this._gestureIds.includes(objectId);
        }

        // The host has taken this board's whole layer down or put it back — a tab switch, a
        // split view change, the window minimised. Whole-board rather than per-tile because
        // that is the granularity the layer has, and it is the only one of these signals the
        // page cannot work out for itself.
        setHostPainting(painting) {
            const next = !!painting;
            if (this._hostPainting === next) return;
            this._hostPainting = next;
            this.host.canvas.invalidate();
        }

        /* ------------------------------------------------------- suppression */

        // A live tile is a <browser> in the *browser window*, sitting above this page's
        // entire content area. Nothing drawn inside the page can be on top of one — so
        // an easel context menu opened over a live card was simply behind the website,
        // which is what "right-clicking a live tile sends the menu behind the site" is.
        //
        // The menu cannot be raised, so the tile is lowered: any tile the menu overlaps
        // is hidden for as long as it is open, and the canvas paints its screenshot
        // again underneath. Only the overlapping ones, so right-clicking empty board
        // does not make every live card on screen blink.
        //
        // `rect` is in this page's viewport coordinates, which is what the menu's own
        // left/top are already expressed in.
        suppressOverlapping(rect) {
            if (!this._tiles.size || !rect) return;
            let changed = false;

            for (const [id, obj] of this._tiles) {
                if (this._suppressed.has(id)) continue;
                // Viewport space on both sides: the geometry helper is asked for an
                // origin of 0,0 rather than the tab-relative one the host wants.
                const tile = this._geometryFor(obj, { x: 0, y: 0 }).rect;
                const overlaps = rect.x < tile.x + tile.w && rect.x + rect.w > tile.x &&
                    rect.y < tile.y + tile.h && rect.y + rect.h > tile.y;
                if (!overlaps) continue;

                this._suppressed.add(id);
                this.bridge?.liveSetTileHidden(this._easelId, id, true);
                changed = true;
            }
            // The renderer skips a live card's screenshot, so the static layer has to be
            // repainted for it to come back.
            if (changed) this.host.canvas.invalidate();
        }

        releaseSuppressed() {
            if (!this._suppressed.size) return;
            for (const id of this._suppressed) {
                if (this._tiles.has(id)) this.bridge?.liveSetTileHidden(this._easelId, id, false);
            }
            this._suppressed.clear();
            this.host.canvas.invalidate();
        }

        get activeId() { return this._activeId; }

        /* ------------------------------------------------------------ opt-in */

        // Arc gates the first conversion behind an explanation, because what happens next —
        // the site loading with your real session — is not what a screenshot implies.
        async requestLive(obj) {
            if (!this.canGoLive(obj)) return false;

            if (!window.ZenEaselUtil.prefBool("zen.easel.live.explained", false)) {
                const accepted = Services.prompt.confirmEx(
                    window,
                    "Show the live website?",
                    "This card will load the real page in place of the screenshot, so you see " +
                    "an up-to-date, interactive view of whatever you captured.\n\n" +
                    "The site loads with your normal cookies and session, the same as an " +
                    "ordinary tab. It does not work on every site — you can always switch " +
                    "back to the screenshot.",
                    Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
                    Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL,
                    "Show live website", null, null, null, { value: false }
                ) === 0;

                this.host.viewport.focus({ preventScroll: true });
                // confirmEx is modal, and putting it up takes a visibilitychange with it —
                // so background() has already run and told the host to stop painting this
                // board. Nothing will undo that on its own: the page is visible again, so
                // no second visibilitychange is coming. Re-asserted here, or the tile this
                // prompt just authorised mounts straight into a hidden layer.
                if (!document.hidden && this._easelId) {
                    this.bridge?.liveSetBoardPainting(this._easelId, true);
                }
                if (!accepted) return false;
                Services.prefs.setBoolPref("zen.easel.live.explained", true);
            }

            if (obj.type === "webcard") {
                obj.webcard.useLiveWebCard = true;
                this.host.store.markDirty();
            }
            return this._mount(obj);
        }

        /* -------------------------------------------------------------- audio */

        // Where the card's own mute setting lives. Kept on the object rather than the tile
        // so it survives the tile being stopped and started again, the way useLiveWebCard
        // does — the difference being that this one *is* honoured on load, because it only
        // ever makes the board quieter.
        _audioSource(obj) {
            return obj.type === "webBrowser" ? obj.webBrowser : obj.webcard;
        }

        isMuted(obj) {
            const source = obj && this._audioSource(obj);
            return !!(source && source.muted);
        }

        setMuted(obj, muted) {
            const source = obj && this._audioSource(obj);
            if (!source) return;
            source.muted = !!muted;
            this.host.store.markDirty();
            this.bridge?.liveSetTileMuted(this._easelId, obj.id, !!muted);
            this.host.canvas.invalidate();
        }

        makeStatic(obj) {
            if (obj && obj.webcard) {
                obj.webcard.useLiveWebCard = false;
                this.host.store.markDirty();
            }
            this._unmount(obj.id);
        }

        /* ---------------------------------------------------------- mounting */

        async _mount(obj) {
            if (this._tiles.has(obj.id) || this._suspended) return false;

            const url = this._urlFor(obj);
            const bridge = this.bridge;
            const easelId = this._easelId;
            if (!url || !bridge || !easelId) return false;

            // The cap is the host's now. It has to be: this map only ever holds the board
            // that is open, and tiles outlive board switches, so a ceiling counted here
            // would read three while the window was running nine.

            // Registered before the await: sync() runs on every frame and must already know
            // this tile exists, or the first layout would arrive before the geometry does.
            this._tiles.set(obj.id, obj);

            const capture = obj.type === "webBrowser" ? null : obj.webcard.capture;
            let ok = false;
            try {
                ok = await bridge.liveMount(easelId, obj.id, url, this._geometryFor(obj), {
                    userContextId: this._userContextId(),
                    private: !!window.ZenEaselUtil.prefs["live.private"],
                    // The locks exist to protect a crop, so a tile with no crop declines
                    // them: a web tile is a window onto a site, not a pinned view of one.
                    pinned: !!capture,
                    scrollOffset: capture ? capture.webContentOffset : null,
                    muted: this.isMuted(obj)
                });
            } catch (e) {
                console.error("[zen-easel] a live card failed to mount:", e);
            }

            if (!ok) {
                this._tiles.delete(obj.id);
                this.host.toast("That card could not be opened");
                return false;
            }

            // The static canvas must stop painting the screenshot underneath, or it would
            // show through wherever the site is transparent.
            this.host.canvas.invalidate();
            return true;
        }

        _unmount(objectId) {
            if (!this._tiles.has(objectId)) return;
            this._offscreenSince.delete(objectId);
            this._offscreen.delete(objectId);
            this._suppressed.delete(objectId);
            this._tiles.delete(objectId);
            if (this._activeId === objectId) this._activeId = null;

            this.bridge?.liveUnmount(this._easelId, objectId);
            this.host.canvas.invalidate();
        }

        // Objects are about to stop existing — deleted, cut, or replaced by an undo.
        // Called synchronously by the canvas rather than left to sync()'s orphan sweep:
        // the sweep runs on the next painted frame, which is at best late and does not
        // run at all while the tab is hidden, and a live website left mounted over a
        // board that no longer has a card for it is the worst state available.
        //
        // The sweep stays as the backstop it was always meant to be.
        releaseMany(objectIds) {
            for (const id of objectIds) this._unmount(id);
        }

        // Drop a tile from the model without asking the host to remove it — the host has
        // already done so, and this is it telling us. Distinct from _unmount for that
        // reason: calling back into a host that has moved on would be a loop.
        forget(objectId) {
            if (!this._tiles.has(objectId)) return;
            this._offscreenSince.delete(objectId);
            this._offscreen.delete(objectId);
            this._suppressed.delete(objectId);
            this._tiles.delete(objectId);
            if (this._activeId === objectId) this._activeId = null;
            this.host.canvas.invalidate();
        }

        _userContextId() {
            const id = window.ZenEaselUtil.prefs["live.container"];
            return Number.isInteger(id) && id > 0 ? id : 0;
        }

        /* ------------------------------------------------------------ layout */

        // Called from the canvas's paint, on the same frame as everything else, so tiles
        // never lag the board they are sitting on.
        sync() {
            if (!this._tiles.size || !this._easelId) return;

            // A tile whose object is gone has to go with it. Done here rather than in
            // removeObjects because deletion is not the only way an object stops existing:
            // undo, redo, paste-over and switching easel all replace the object list, and a
            // tile left behind is a live website floating over a board that no longer has a
            // card for it — unselectable, undeletable, and still running.
            this._sweepOrphans();
            if (!this._tiles.size) return;

            const origin = this._viewportOrigin();
            const width = this.host.canvas.renderer.width;
            const height = this.host.canvas.renderer.height;
            const now = Date.now();
            const entries = [];

            // A viewport that is still changing size cannot be asked whether a card is
            // outside it. Every frame of a resize gives a different answer, and the board's
            // own zoom is being re-clamped to the new width underneath, so a card can read
            // as offscreen for a few frames purely because the two have not agreed yet.
            //
            // The countdown is therefore restarted whenever the viewport changes size, so it
            // only ever runs while the answer is stable. Without this a split-view drag long
            // enough to outlast the grace hides cards that never actually left the board —
            // which the five-second grace this replaced was accidentally immune to, being far
            // longer than anyone drags for.
            if (width !== this._lastWidth || height !== this._lastHeight) {
                this._lastWidth = width;
                this._lastHeight = height;
                this._offscreenSince.clear();
            }

            for (const [id, obj] of this._tiles) {
                // Built once. The host wants tab space and the offscreen test wants viewport
                // space, and the two differ by a constant translation — so this used to be
                // two _geometryFor calls per tile per painted frame, which is the single
                // most-executed thing in the paint path once the cap is raised.
                const geometry = this._geometryFor(obj, origin);

                // Only the *layout* is skipped mid-gesture: a remote frame is not relaid out
                // at 120Hz. The visibility test still has to run, or a card dragged off the
                // edge of the board would never be noticed as offscreen.
                if (!this._gestureIds.includes(id)) entries.push({ id, geometry });

                if (width && height) this._noteVisibility(id, geometry.rect, origin, width, height, now);
            }
            if (entries.length) this.bridge?.liveLayout(this._easelId, entries);
        }

        // Asked of the canvas's own index rather than answered here. The nested version was
        // O(tiles × objects); replacing it with a locally-built Set fixed that but still
        // allocated one entry per object on the board on every painted frame, to answer a
        // question about at most a handful of tiles. canvas.hasObject is the same amortised
        // map the canvas already maintains for its own hot paths.
        _sweepOrphans() {
            for (const id of [...this._tiles.keys()]) {
                if (!this.host.canvas.hasObject(id)) this._unmount(id);
            }
        }

        // canvas.toScreen() is relative to the *viewport element*, but the host's layer is
        // placed over the whole tab, because that is the element whose position it can
        // observe. The topbar sits between the two, so without this every tile is drawn
        // that much too high — the canvas leaves its hole in the right place and the site
        // appears above it.
        _viewportOrigin() {
            try {
                const rect = this.host.viewport.getBoundingClientRect();
                return { x: rect.left, y: rect.top };
            } catch (e) {
                return { x: 0, y: 0 };
            }
        }

        // Everything the host needs to place one tile, in this page's viewport coordinates.
        //
        //   rect     where the tile sits on screen
        //   content  the size to lay the page out at, so it reflows as it did at capture
        //   offset   how far to shift it so the captured region lands at the tile's origin
        //   scale    what to multiply that by so the region fills the tile
        //
        // The zoom is folded into scale rather than applied to a parent layer, because the
        // host's layer is shared with nothing and has no transform of its own.
        _geometryFor(obj, viewportOrigin = this._viewportOrigin()) {
            const view = this.host.canvas.view;
            const zoom = view.zoom;
            const local = this.host.canvas.toScreen(obj.x, obj.y);
            const origin = { x: local.x + viewportOrigin.x, y: local.y + viewportOrigin.y };

            // A rotated card's tile turns with it. Sent as a plain number and applied by
            // the host as one CSS transform on the wrapper — the tile is a real element,
            // so this costs nothing that the canvas is not already paying for the objects
            // around it.
            const rotation = obj.rotation || 0;

            if (obj.type === "webBrowser") {
                // Laid out at its own world size and scaled by the zoom, so zooming magnifies
                // the page rather than reflowing it at every step.
                const barHeight = Math.min(WEB_BROWSER_BAR, obj.h);
                const contentW = obj.w;
                const contentH = Math.max(obj.h - barHeight, 0);
                return {
                    rect: {
                        x: origin.x,
                        y: origin.y + barHeight * zoom,
                        w: obj.w * zoom,
                        h: contentH * zoom
                    },
                    content: { w: contentW, h: contentH },
                    offset: { x: 0, y: 0 },
                    scale: zoom,
                    rotation,
                    // Where the object's centre is relative to the tile's own top-left.
                    // The tile covers only part of the object — the URL strip and the
                    // card footer stay canvas-drawn — so it must turn about the object's
                    // centre rather than its own, or it would swing away from the frame.
                    pivot: { x: obj.w * zoom / 2, y: (obj.h / 2 - barHeight) * zoom }
                };
            }

            const capture = obj.webcard.capture;
            const frame = capture.frameRelativeToViewport;
            const size = capture.webContentSize;

            // The tile covers the card's art area only, never the footer: the renderer still
            // paints the title strip on the canvas below, and it doubles as the drag handle
            // for a card whose middle now belongs to a website.
            const artHeight = Math.max(obj.h - FOOTER_HEIGHT, 0);
            const scale = frame.w > 0 ? (obj.w * zoom) / frame.w : zoom;

            return {
                rect: { x: origin.x, y: origin.y, w: obj.w * zoom, h: artHeight * zoom },
                content: { w: size.w, h: size.h },
                // Post-scale, because the host applies this as a plain offset alongside the
                // transform rather than inside it.
                offset: { x: -frame.x * scale, y: -frame.y * scale },
                scale,
                rotation,
                // The tile covers the art area only; the footer below it stays canvas-
                // drawn. So the pivot is the whole card's centre expressed in the tile's
                // coordinates, which is half the footer's height below the tile's own.
                pivot: { x: obj.w * zoom / 2, y: obj.h * zoom / 2 }
            };
        }

        // Replaces the IntersectionObserver the DOM version used: with no elements on this
        // side there is nothing to observe, and the geometry is already computed each frame.
        //
        // Called from sync() with a rect the caller already built, in *tab* space — the
        // origin is subtracted here rather than the whole geometry being rebuilt against a
        // zero origin, which is what the second _geometryFor call per tile used to be for.
        _noteVisibility(id, tabRect, origin, width, height, now) {
            if (id === this._activeId) { this._offscreenSince.delete(id); return; }

            const x = tabRect.x - origin.x;
            const y = tabRect.y - origin.y;
            const visible = x + tabRect.w > 0 && x < width &&
                y + tabRect.h > 0 && y < height;

            // Asymmetric on purpose: leaving is deferred by the grace, returning is not.
            // A card scrolled back into view should be showing the site by the time the pan
            // settles, not three quarters of a second later.
            if (visible) {
                this._offscreenSince.delete(id);
                this._setOffscreen(id, false);
                return;
            }

            const since = this._offscreenSince.get(id);
            if (!since) this._offscreenSince.set(id, now);
            else if (now - since > OFFSCREEN_PAINT_GRACE_MS) this._setOffscreen(id, true);
        }

        // Stops the tile painting; does not stop it running. The canvas has to be told as
        // well, because it is what paints the screenshot back in underneath.
        _setOffscreen(id, offscreen) {
            if (offscreen === this._offscreen.has(id)) return;
            if (offscreen) this._offscreen.add(id);
            else this._offscreen.delete(id);
            this.bridge?.liveSetTileOffscreen(this._easelId, id, offscreen);
            this.host.canvas.invalidate();
        }

        /* -------------------------------------------------------- activation */

        // Tiles do not take pointer events until clicked, so the canvas keeps complete
        // ownership of selection, dragging and the marquee — the input path in canvas.uc.js
        // needs no knowledge of any of this.
        activate(objectId) {
            if (this._activeId === objectId) return;
            this.deactivate();
            if (!this._tiles.has(objectId)) return;

            this._activeId = objectId;
            // Also refreshes the LRU: the card being used should be the last one evicted.
            // The order itself is the host's, because the cap is.
            this.bridge?.liveActivate(this._easelId, objectId);
        }

        deactivate() {
            if (!this._activeId) return;
            this._activeId = null;
            this.bridge?.liveDeactivate();
        }

        /* ---------------------------------------------------------- gestures */

        // A remote frame is not relaid out at 120Hz. The tile is hidden for the duration and
        // the canvas's existing active layer draws the cached screenshot as the drag proxy,
        // which is why dragging a live card needs no changes in canvas.uc.js beyond these
        // two calls.
        beginGesture(objectIds) {
            this.deactivate();
            this._gestureIds = [];
            for (const id of objectIds) {
                if (!this._tiles.has(id)) continue;
                this._gestureIds.push(id);
                this.bridge?.liveSetTileHidden(this._easelId, id, true);
            }
        }

        endGesture() {
            if (!this._gestureIds.length) return;
            const ids = this._gestureIds;
            this._gestureIds = [];
            for (const id of ids) {
                const obj = this._tiles.get(id);
                if (!obj) continue;
                this.bridge?.liveLayout(this._easelId, [{ id, geometry: this._geometryFor(obj) }]);
                // Not unconditionally: a tile hidden because a menu is over it
                // must stay hidden when the drag that also hid it finishes.
                if (!this._suppressed.has(id)) this.bridge?.liveSetTileHidden(this._easelId, id, false);
            }
        }

        /* -------------------------------------------------------- attachment */

        // This view moves to a board. The tiles already running on it are *adopted*, not
        // remounted — the host has been running them all along, and asking it to mount what
        // it already has would tear down a working site and load it again. That is exactly
        // what switching boards and back used to do, via the orphan sweep, and what
        // reloading the tab used to do via suspendAll.
        //
        // Synchronous, and called before the first paint of the new board: a tile this has
        // not adopted by then is one the orphan sweep would treat as stray.
        attach(easelId, reveal = true) {
            this._forgetAll();
            this._easelId = easelId || null;
            this._suspended = false;
            if (!this._easelId || !this.bridge) return;

            for (const { objectId, url } of this.bridge.liveAttach(this._easelId, reveal) || []) {
                const obj = this.host.canvas._byId(objectId);
                // The card was deleted, or had its URL changed, while this board was closed.
                // The tile is genuinely stray now, so it is stopped rather than adopted.
                if (!obj || this._urlFor(obj) !== url) {
                    this.bridge.liveUnmount(this._easelId, objectId);
                    continue;
                }
                this._tiles.set(objectId, obj);
            }
            this.host.canvas.invalidate();
        }

        // The page is going away for good — unloaded, reloaded, navigated off — and its
        // board's tiles go with it. Distinct from background(), which is you looking at
        // another tab for a moment and stops the pixels only.
        //
        // Reload is the case worth being explicit about: Ctrl+R starts the board over,
        // websites included. A refresh that readopted the processes it had a moment ago
        // would be the one reload in the browser that refreshes nothing.
        detach() {
            this._forgetAll();
            const easelId = this._easelId;
            this._easelId = null;
            this._suspended = true;
            if (easelId) this.bridge?.liveDetach(easelId);
        }

        _forgetAll() {
            if (this._resyncTimer) {
                window.clearTimeout(this._resyncTimer);
                this._resyncTimer = null;
            }
            this._cancelReveal();
            this._tiles.clear();
            this._offscreenSince.clear();
            this._offscreen.clear();
            this._suppressed.clear();
            this._gestureIds = [];
            this._activeId = null;
        }

        // The tab was backgrounded or the window minimised. Painting stops; nothing else
        // does. A dashboard left open on a board is still refreshing when you come back,
        // which is the whole of what this change is for.
        background() {
            // Cancelled first. Switching away inside the reveal delay is the common case
            // when flicking between tabs, and a reveal that fired after this would put the
            // layer back up for a board nobody is looking at.
            this._cancelReveal();
            if (this._easelId) this.bridge?.liveSetBoardPainting(this._easelId, false);
        }

        _cancelReveal() {
            if (!this._revealTimer) return;
            window.clearTimeout(this._revealTimer);
            this._revealTimer = null;
        }

        // Coming back. The order is load-bearing, and it is the reason this is not just
        // "clear a flag" the way resume() was:
        //
        //   attach   re-establishes which board the host should be painting, and re-adopts
        //            whatever is still running on it. Needed because a tab switch does not
        //            run setDocument, so nothing else would ever re-attach.
        //   sync     puts the geometry right *before* anything is unhidden. The board did
        //            not move while hidden, but the layer may have — a window resize or a
        //            sidebar collapse repositions it without this page painting at all.
        //   paint    only now.
        //
        // Unhiding first would show every tile for one frame at the offset it had when the
        // tab was backgrounded.
        foreground() {
            const doc = this.host.canvas.doc;
            if (!doc) return;
            // Attached without revealing: the tiles are still where they were when this
            // tab was left, so the layer must stay down until sync() has moved them.
            this.attach(doc.id, false);
            this.sync();
            this.host.canvas.invalidate();
            this._revealSoon();
            this._resyncSoon();
        }

        // Puts the tiles back a moment after the tab does, rather than on the same turn.
        //
        // A live tile is a <browser> in the chrome window, so it is not part of whatever
        // transition Zen runs when a tab comes forward — it just appears, at full opacity,
        // wherever the layer currently is. Revealing it while that animation is still
        // playing is the jarring part: the board slides or fades in and the websites do not
        // travel with it. Waiting until the animation is over means the tiles arrive onto a
        // board that has already settled, which reads as the card simply coming to life.
        //
        // The screenshots are on screen throughout, so nothing is missing during the wait —
        // this trades a few frames of static card for not seeing the tiles fly.
        _revealSoon() {
            if (this._revealTimer) window.clearTimeout(this._revealTimer);

            const reveal = () => {
                this._revealTimer = null;
                // Switched away again while waiting. The host would refuse anyway — it
                // re-checks which tab is showing — but not asking is clearer than relying
                // on being told no.
                if (this._suspended || !this._easelId || document.hidden) return;
                // Geometry immediately before the reveal rather than only at the start of
                // the wait: the animation that made the wait necessary is also the thing
                // most likely to have moved the layer during it.
                this.sync();
                this.bridge?.liveSetBoardPainting(this._easelId, true);
                this.host.canvas.invalidate();
            };

            const delay = window.ZenEaselUtil.prefs["live.reveal-delay-ms"];
            if (!Number.isInteger(delay) || delay <= 0) { reveal(); return; }
            this._revealTimer = window.setTimeout(reveal, delay);
        }

        // Sync again over the next couple of frames.
        //
        // The geometry a tile is placed at is built from this page's own layout — see
        // _viewportOrigin — and at the moment a tab becomes visible again that layout is
        // still settling. One pass reads it mid-transition and places every tile at an
        // offset that is about to be wrong, and because the paint loop is dirty-driven
        // rather than continuous, on an idle board there is no second pass to correct it.
        //
        // Bounded, and it invalidates rather than syncing directly so the work rides the
        // normal paint rather than fighting it.
        _resyncSoon() {
            if (this._resyncTimer) return;
            let left = 3;
            const again = () => {
                this._resyncTimer = null;
                if (this._suspended || !this._easelId) return;
                this.host.canvas.invalidate();
                if (--left > 0) this._resyncTimer = window.setTimeout(again, 120);
            };
            this._resyncTimer = window.setTimeout(again, 60);
        }

        destroy() {
            this.detach();
        }
    }

    window.ZenEaselLiveLayer = ZenEaselLiveLayer;
})();
