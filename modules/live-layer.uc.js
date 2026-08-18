// Zen Easel — live web cards, page side.
//
// A webcard is a screenshot of a region of a page. Going live replaces those pixels with
// the real site, cropped to the same region: the browser is laid out at exactly the viewport
// size the capture was taken at, scrolled to the same offset, and scaled so the captured
// rectangle fills the card. That is why the crop is stored as a bounding box rather than a
// CSS selector — geometry degrades to "the wrong part of the page" when a site is redesigned,
// where a selector degrades to nothing at all. Arc makes the same trade for the same reason.
//
// This file owns the *model*: which cards are live, the cap and its LRU, which one has the
// pointer, and where each one belongs on screen. It owns no elements at all.
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

    // How long a tile stays alive after scrolling out of view before it is torn down and
    // the screenshot comes back.
    const OFFSCREEN_GRACE_MS = 5000;

    // Height of the title strip the canvas renderer draws at the bottom of a webcard, and of
    // the URL strip it draws at the top of a web tile. Both in world units, and both owned by
    // renderer.uc.js — the tile is inset so the canvas keeps drawing them.
    const FOOTER_HEIGHT = 30;
    const WEB_BROWSER_BAR = 28;

    class ZenEaselLiveLayer {
        constructor(host) {
            this.host = host;
            this.log = window.ZenEaselUtil.log;

            // objectId -> obj. No DOM: the elements are the host's.
            this._tiles = new Map();
            // Insertion order is the LRU: the oldest live tile is the first to go.
            this._order = [];
            this._activeId = null;
            this._suspended = false;
            this._gestureIds = [];
            this._offscreenSince = new Map();
            // Tiles hidden because something in the page needs to be seen over them.
            // Still mounted, still live — just not painting. See suppressOverlapping.
            this._suppressed = new Set();
        }

        get enabled() {
            return window.ZenEaselUtil.prefs["live.enabled"];
        }

        get maxTiles() {
            return Math.max(1, window.ZenEaselUtil.prefs["live.max-tiles"]);
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
        // renderer wants this one: a suppressed card is still live — still loaded, still
        // running — but its pixels are not on screen, so the canvas has to go back to
        // drawing the screenshot or the card would be a hole.
        showsTile(objectId) {
            return this._tiles.has(objectId) && !this._suppressed.has(objectId);
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
                this.bridge?.liveSetTileVisible(id, false);
                changed = true;
            }
            // The renderer skips a live card's screenshot, so the static layer has to be
            // repainted for it to come back.
            if (changed) this.host.canvas.invalidate();
        }

        releaseSuppressed() {
            if (!this._suppressed.size) return;
            for (const id of this._suppressed) {
                if (this._tiles.has(id)) this.bridge?.liveSetTileVisible(id, true);
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
                if (!accepted) return false;
                Services.prefs.setBoolPref("zen.easel.live.explained", true);
            }

            if (obj.type === "webcard") {
                obj.webcard.useLiveWebCard = true;
                this.host.store.markDirty();
            }
            return this._mount(obj);
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
            if (!url || !bridge) return false;

            // Evict before creating, so the cap is a real ceiling rather than a target.
            while (this._order.length >= this.maxTiles) {
                const oldest = this._order.find(id => id !== this._activeId) || this._order[0];
                this._unmount(oldest);
            }

            // Registered before the await: sync() runs on every frame and must already know
            // this tile exists, or the first layout would arrive before the geometry does.
            this._tiles.set(obj.id, obj);
            this._order.push(obj.id);

            const capture = obj.type === "webBrowser" ? null : obj.webcard.capture;
            let ok = false;
            try {
                ok = await bridge.liveMount(obj.id, url, this._geometryFor(obj), {
                    userContextId: this._userContextId(),
                    private: !!window.ZenEaselUtil.prefs["live.private"],
                    // The locks exist to protect a crop, so a tile with no crop declines
                    // them: a web tile is a window onto a site, not a pinned view of one.
                    pinned: !!capture,
                    scrollOffset: capture ? capture.webContentOffset : null
                });
            } catch (e) {
                console.error("[zen-easel] a live card failed to mount:", e);
            }

            if (!ok) {
                this._tiles.delete(obj.id);
                this._order = this._order.filter(id => id !== obj.id);
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
            this._suppressed.delete(objectId);
            this._tiles.delete(objectId);
            this._order = this._order.filter(id => id !== objectId);
            if (this._activeId === objectId) this._activeId = null;

            this.bridge?.liveUnmount(objectId);
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
            this._suppressed.delete(objectId);
            this._tiles.delete(objectId);
            this._order = this._order.filter(id => id !== objectId);
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
            if (!this._tiles.size) return;

            // A tile whose object is gone has to go with it. Done here rather than in
            // removeObjects because deletion is not the only way an object stops existing:
            // undo, redo, paste-over and switching easel all replace the object list, and a
            // tile left behind is a live website floating over a board that no longer has a
            // card for it — unselectable, undeletable, and still running.
            this._sweepOrphans();
            if (!this._tiles.size) return;

            const origin = this._viewportOrigin();
            const entries = [];
            for (const [id, obj] of this._tiles) {
                if (this._gestureIds.includes(id)) continue;
                entries.push({ id, geometry: this._geometryFor(obj, origin) });
            }
            if (entries.length) this.bridge?.liveLayout(entries);

            this._sweepOffscreen(origin);
        }

        // The id set is built once rather than scanning the object list per tile: this
        // runs on every painted frame, and the nested version was O(tiles × objects) in
        // the paint path on a board that could hold hundreds of objects.
        _sweepOrphans() {
            const alive = new Set();
            for (const obj of this.host.canvas.objects) alive.add(obj.id);
            for (const id of [...this._tiles.keys()]) {
                if (!alive.has(id)) this._unmount(id);
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
        _sweepOffscreen(origin = this._viewportOrigin()) {
            const width = this.host.canvas.renderer.width;
            const height = this.host.canvas.renderer.height;
            if (!width || !height) return;

            const now = Date.now();
            for (const [id, obj] of this._tiles) {
                if (id === this._activeId) { this._offscreenSince.delete(id); continue; }

                // Tested against the viewport, so the rect is put back into viewport space
                // rather than the tab space the host wants.
                const { rect } = this._geometryFor(obj, { x: 0, y: 0 });
                const visible = rect.x + rect.w > 0 && rect.x < width &&
                    rect.y + rect.h > 0 && rect.y < height;

                if (visible) {
                    this._offscreenSince.delete(id);
                } else {
                    const since = this._offscreenSince.get(id);
                    if (!since) this._offscreenSince.set(id, now);
                    else if (now - since > OFFSCREEN_GRACE_MS) this._unmount(id);
                }
            }
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
            this.bridge?.liveActivate(objectId);

            // Refresh the LRU: the card being used should be the last one evicted.
            this._order = this._order.filter(id => id !== objectId);
            this._order.push(objectId);
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
                this.bridge?.liveSetTileVisible(id, false);
            }
        }

        endGesture() {
            if (!this._gestureIds.length) return;
            const ids = this._gestureIds;
            this._gestureIds = [];
            for (const id of ids) {
                const obj = this._tiles.get(id);
                if (!obj) continue;
                this.bridge?.liveLayout([{ id, geometry: this._geometryFor(obj) }]);
                // Not unconditionally: a tile hidden because a menu is over it
                // must stay hidden when the drag that also hid it finishes.
                if (!this._suppressed.has(id)) this.bridge?.liveSetTileVisible(id, true);
            }
        }

        /* -------------------------------------------------------- suspension */

        // A backgrounded easel tab has no business keeping content processes alive, and a
        // page being torn down must not leave elements behind in a window that outlives it.
        suspendAll() {
            this._suspended = true;
            this._tiles.clear();
            this._order = [];
            this._offscreenSince.clear();
            this._suppressed.clear();
            this._activeId = null;
            this.bridge?.liveUnmountAll();
        }

        resume() {
            this._suspended = false;
        }

        destroy() {
            this.suspendAll();
        }
    }

    window.ZenEaselLiveLayer = ZenEaselLiveLayer;
})();
