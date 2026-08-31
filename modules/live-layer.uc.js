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

    // Everything the page draws that a live tile must not bury. One selector list rather
    // than references handed over by each module, so a new panel is covered by adding a
    // line here instead of by remembering to register itself.
    //
    // Anything not currently showing is `display: none` — the panels use [hidden], the
    // floating strips use .is-visible — and measures as a zero rect, which is skipped. So
    // the list needs no state in it.
    //
    // .easel-menu is deliberately absent: a context menu is already handled by
    // suppressOverlapping, which hides the tile outright. That is the heavier treatment,
    // but it is the proven one, and a menu is transient enough not to need this.
    const CHROME_SELECTOR = [
        ".easel-topbar",          // the strip itself, and the two panels that hang out of it
        ".easel-list",
        ".easel-live-panel",
        ".easel-toolbar",         // and the style popup that opens above it
        ".easel-popup",
        ".easel-font-panel",
        ".easel-text-controls",   // the strips that ride alongside a selected object
        ".easel-shape-controls",
        ".easel-error"
    ].join(",");

    const overlaps = (a, b) =>
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    // `rect` shrunk so it no longer meets `other`, or null when no shrink can do that
    // without also losing area that only `rect` covers.
    //
    // The answer exists exactly when the intersection is a band across the whole of `rect`
    // lying along one of its edges — which is the case a panel and the bar it hangs from
    // produce. The band is already inside `other`'s hole, so giving it up changes nothing
    // about the region the two cut out between them, and `rect` keeps its corner radius.
    function trimAgainst(rect, other) {
        const left = Math.max(rect.x, other.x);
        const right = Math.min(rect.x + rect.w, other.x + other.w);
        const top = Math.max(rect.y, other.y);
        const bottom = Math.min(rect.y + rect.h, other.y + other.h);

        if (left <= rect.x && right >= rect.x + rect.w) {
            if (top <= rect.y) return { ...rect, y: bottom, h: rect.y + rect.h - bottom };
            if (bottom >= rect.y + rect.h) return { ...rect, h: top - rect.y };
        }
        if (top <= rect.y && bottom >= rect.y + rect.h) {
            if (left <= rect.x) return { ...rect, x: right, w: rect.x + rect.w - right };
            if (right >= rect.x + rect.w) return { ...rect, w: left - rect.x };
        }
        return null;
    }

    // Square-cornered on purpose: the corners of a box drawn round two overlapping panels
    // belong to neither of them, and rounding them would only make the shape look intended.
    function boundingBox(a, b) {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return {
            x, y,
            w: Math.max(a.x + a.w, b.x + b.w) - x,
            h: Math.max(a.y + a.h, b.y + b.h) - y,
            r: 0
        };
    }

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

    // Tiles used to be inset by a strip the canvas renderer drew — a webcard's title bar
    // along its bottom, a web tile's URL bar across its top — because that strip carried the
    // play/pause control and was the one part of the object a <browser> could not be allowed
    // to cover. The control lives in a floating bar now, drawn as DOM *above* the live layer
    // rather than beside it (see modules-host/live-host.uc.js), so there is nothing left for
    // a tile to make room for and both types are laid out edge to edge.

    // How long after a web tile goes live before its poster is taken.
    //
    // A poster written only when a tile is paused would never exist for the tiles that are
    // never paused — the ones the idle sweep stops, or that a reload takes with it — which
    // are exactly the cards you come back to expecting to see something. So one is taken
    // shortly after the site settles, and refreshed on the way out when there is a chance.
    //
    // Long enough for a player to have drawn its poster frame and a page to have laid
    // itself out; short enough that a tile stopped early still has one.
    const POSTER_AFTER_LOAD_MS = 3000;

    // The widest disagreement between a tile's layout box and its capture's that is still
    // believable as a scrollbar gutter. Anything larger is a measurement taken of something
    // else — a page mid-reflow, or one that changed its own overflow — and applying it
    // would move the crop rather than correct it.
    const MAX_WIDTH_CORRECTION = 64;

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
            // The chrome rectangles last sent to the host, as a signature string, and the
            // corner radius of each element they were read from. See _syncChromeClip.
            this._chromeClip = null;
            this._chromeRadii = new WeakMap();
            // Pending post-load poster captures, by object id, so a tile stopped before its
            // timer fires does not snapshot a browser that has gone.
            this._posterTimers = new Map();
            // Per-tile correction to the content box width, in world units, learned from
            // what the tile reports its own clientWidth to be once it has settled.
            //
            // Kept here rather than applied by the host, because the host cannot keep it:
            // sync() rebuilds every tile's geometry and re-sends it on every painted frame,
            // so a width the host set itself is overwritten a frame later. This is folded
            // into _geometryFor instead, which is the one place the number is authored.
            this._contentWidthDelta = new Map();
            // Refreshes in flight, by object id. The button lives on a canvas-drawn bar, so
            // a double click is two clicks, and each one is a snapshot, a PNG encode and an
            // asset written to disk. The second would win, the first would be orphaned until
            // the store's sweep noticed, and both would toast.
            this._refreshing = new Set();
        }

        // Whether a pinned card may be unlocked for repositioning when it is clicked into.
        get repositionEnabled() {
            return window.ZenEaselUtil.prefs["live.reposition"];
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

        // A card whose tile reproduces a crop, as opposed to a window onto a site. Only
        // these carry locks, and so only these have anything to unlock.
        _isPinned(objectId) {
            const obj = this._tiles.get(objectId);
            return !!(obj && obj.type === "webcard" && obj.webcard && obj.webcard.capture);
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
            // The board has gone off screen — a tab switch, a splitter drag — and the
            // pointer is somewhere else entirely by the time it comes back. The bar lives in
            // the browser window and would otherwise still be there, in the position the
            // board was last in, waiting for a hover that already ended.
            if (!next) this.host.canvas.clearHover();
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

        /* ------------------------------------------------------- chrome clip */

        // The other half of the same problem suppressOverlapping solves, for the chrome
        // that is always there rather than only while a menu is open.
        //
        // A live tile is a <browser> in the browser window, above this page's whole content
        // area, so the toolbar and the topbar are drawn underneath it however this
        // document's z-order is arranged. Hiding the tile — the menu's answer — is not an
        // answer here: the toolbar never goes away, so a card that happened to sit over the
        // bottom-left corner would simply stop being live.
        //
        // So the tile stays and the layer gets a hole cut in it instead. The host does the
        // cutting; this side only measures, because these are its elements and it is the
        // only side that knows when one of them appears.
        //
        // Public, because the paint loop is not the only thing that can change the answer.
        // Painting here is on demand, and opening a popup or a dropdown moves nothing on the
        // board — so a panel that appeared between two paints would sit under a tile until
        // something else happened to schedule one. The few places that show or hide chrome
        // call this directly; see easel-page's chromeChanged.
        syncChromeClip() {
            if (!this._easelId) return;
            const rects = this._makeDisjoint(this._chromeRects());

            // Compared before sending. This runs on every painted frame — the floating
            // strips ride alongside a selected object, so their rects really do move with a
            // pan — but the usual frame changes nothing, and rewriting the layer's clip-path
            // re-clips every remote frame inside it.
            const signature = rects.map(r => `${r.x},${r.y},${r.w},${r.h},${r.r}`).join("|");
            if (signature === this._chromeClip) return;

            // Remembered only once the host has somewhere to put it. A board's layer does
            // not exist until its first tile mounts, and the page is measuring its chrome
            // before that — caching a send the host dropped would leave the clip never
            // applied, because the rects would go on matching for ever afterwards.
            this._chromeClip = this.bridge?.liveClipChrome(this._easelId, rects) ? signature : null;
        }

        _chromeRects() {
            const root = this.host.shadowRoot;
            if (!root) return [];

            const rects = [];
            for (const element of root.querySelectorAll(CHROME_SELECTOR)) {
                const box = element.getBoundingClientRect();
                // A hidden panel measures 0×0. Nothing else needs to know it is hidden.
                if (box.width < 1 || box.height < 1) continue;

                // Rounded to whole pixels on each edge rather than by width and height, so
                // the hole neither creeps outward nor eats into the chrome's own border —
                // and so sub-pixel jitter during a pan does not churn the signature.
                const x = Math.round(box.left);
                const y = Math.round(box.top);
                rects.push({
                    x, y,
                    w: Math.round(box.right) - x,
                    h: Math.round(box.bottom) - y,
                    r: this._cornerRadius(element)
                });
            }
            return rects;
        }

        // Two holes that overlap cancel each other out. The host cuts them with the even-odd
        // rule, under which a point inside two holes has crossed an odd number of edges and
        // so counts as *inside* the shape again — the overlap comes back as painted layer,
        // which on screen is a hairline of live website lying across whatever two pieces of
        // chrome happen to meet there.
        //
        // One layout really does that: a panel hanging off the topbar. .easel-list and
        // .easel-live-panel sit 34px below a button that is itself a few pixels down from
        // the top of a 44px bar, so they begin two or three pixels above its lower edge.
        //
        // Rects are processed in document order, so the topbar is already in `out` by the
        // time a panel of its own is looked at, and whatever came first is never moved.
        _makeDisjoint(rects) {
            if (rects.length < 2) return rects;

            const out = [];
            for (const rect of rects) {
                let current = rect;
                let again = true;
                // The size test is a termination condition, not a tidiness one. A rect
                // wholly inside another trims to zero height — it contributes nothing, which
                // is the right answer — and a zero-height rect still reports as overlapping,
                // because the overlap test is written for rectangles with area. Without this
                // it would be handed back to trimAgainst unchanged, for ever, from inside
                // the paint loop.
                while (again && current.w > 0 && current.h > 0) {
                    again = false;
                    for (let i = 0; i < out.length; i++) {
                        if (!overlaps(current, out[i])) continue;
                        const trimmed = trimAgainst(current, out[i]);
                        if (trimmed) {
                            current = trimmed;
                        } else {
                            // Not a clean band, so there is no shrink that does not also
                            // give up area the union needs. Merged into a bounding box
                            // instead: that cuts out slightly more than the two panels
                            // cover, which shows a little board around them — wrong-looking
                            // but harmless, where a cancelled overlap shows a running
                            // website on top of a control. No layout here produces this.
                            current = boundingBox(current, out[i]);
                            out.splice(i, 1);
                        }
                        // Either way `current` has changed shape, so the ones already
                        // cleared have to be checked against it again.
                        again = true;
                        break;
                    }
                }
                if (current.w > 0 && current.h > 0) out.push(current);
            }
            return out;
        }

        // Read once per element and remembered. getComputedStyle flushes style, and these
        // are constants of the stylesheet — but a popup is a new element every time it
        // opens, so this cannot be a lookup table keyed by class either.
        _cornerRadius(element) {
            let radius = this._chromeRadii.get(element);
            if (radius === undefined) {
                const value = parseFloat(window.getComputedStyle(element).borderTopLeftRadius);
                radius = Number.isFinite(value) ? value : 0;
                this._chromeRadii.set(element, radius);
            }
            return radius;
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
            // Before the unmount, and awaited by it: the pixels come from the tile's own
            // <browser>, so there is nothing left to photograph once it is gone. A web tile
            // has no screenshot behind it, so this is the only thing standing between a
            // paused card and a blank panel with a URL on it.
            //
            // Not awaited by the caller — a menu item should not sit open while a snapshot
            // encodes — so the unmount is chained rather than sequenced here.
            if (obj && obj.type === "webBrowser" && this.isLive(obj.id)) {
                // Cancelled up front rather than left to the _unmount below. A snapshot
                // takes a frame or two to encode, and the post-load timer is free to fire
                // inside that window — which is a second capture of the same tile, a
                // second asset written, and whichever finishes last deciding the poster
                // while the other is orphaned on disk until the sweep gets to it.
                this._cancelPoster(obj.id);
                this._capturePoster(obj.id).finally(() => this._unmount(obj.id));
                return;
            }
            this._unmount(obj.id);
        }

        /* ----------------------------------------------------------- poster */

        // Writes the tile's current pixels as this web tile's poster, replacing whatever it
        // had. Best-effort throughout: every failure leaves the card exactly as it was.
        //
        // Only webBrowser objects. A webcard already has a picture — the capture it was
        // born from — and overwriting that with a later frame of the site would quietly
        // rewrite the thing the user saved.
        async _capturePoster(objectId) {
            const obj = this.host.canvas._byId(objectId);
            if (!obj || obj.type !== "webBrowser" || !this.bridge || !this._easelId) return;
            // A poster the user took deliberately outranks every automatic one. Checked here
            // rather than at each call site because there are two — the post-landing timer
            // and the snapshot makeStatic takes on the way out — and only one of them was
            // ever obvious.
            if (obj.webBrowser.posterPinned) return;

            let shot = null;
            try {
                shot = await this.bridge.liveSnapshotTile(this._easelId, objectId);
            } catch (e) {
                this.log("could not snapshot a tile:", e.message);
            }
            if (!shot || !shot.bytes || !shot.bytes.length) return;

            // Re-read rather than trusting the object from before the await: a snapshot
            // takes a frame or two to encode, and the card can be deleted or undone away
            // inside that window. Writing to the stale reference would leave an asset on
            // disk owned by nothing.
            const still = this.host.canvas._byId(objectId);
            if (!still || still.type !== "webBrowser") return;

            let asset = "";
            try {
                asset = await this.host.store.saveAsset(shot.bytes, "png");
            } catch (e) {
                this.log("could not save a tile poster:", e.message);
                return;
            }
            if (!asset) return;

            const target = this.host.canvas._byId(objectId);
            if (!target || target.type !== "webBrowser") return;

            // Written straight onto the object rather than through a mutation. A poster is
            // not an edit: it is a cache of what the card was showing, and putting it on
            // the undo stack would mean Ctrl+Z stepping back through pictures rather than
            // through the things the user actually did.
            target.webBrowser.poster = asset;
            this.host.store.markDirty();
            this.host.canvas.invalidate();
        }

        // One poster shortly after a tile settles, so a card stopped by the idle sweep or
        // by a reload still has something to show. Cancelled if the tile goes first.
        _schedulePoster(objectId) {
            this._cancelPoster(objectId);
            const timer = window.setTimeout(() => {
                this._posterTimers.delete(objectId);
                if (this.isLive(objectId)) this._capturePoster(objectId);
            }, POSTER_AFTER_LOAD_MS);
            this._posterTimers.set(objectId, timer);
        }

        _cancelPoster(objectId) {
            const timer = this._posterTimers.get(objectId);
            if (timer === undefined) return;
            window.clearTimeout(timer);
            this._posterTimers.delete(objectId);
        }

        // The host has told us which page a tile actually settled on. Two things hang off
        // it, and both used to be done blind at a fixed delay after mount.
        //
        // `first` is the tile arriving at the page it was mounted for, as opposed to the
        // user navigating it somewhere else afterwards.
        onLanded(objectId, landedUrl, first) {
            if (!this.isLive(objectId)) return;
            const obj = this.host.canvas._byId(objectId);
            if (!obj) return;

            this._correctContentWidth(obj)
                .catch(e => this.log("could not correct a tile's width:", e.message));

            if (obj.type !== "webBrowser") return;
            // A deliberate poster is pinned against the page it was taken of, not against
            // the card for ever. Browsing the tile somewhere else spends it — otherwise the
            // refresh button was a one-way door, and a card kept showing a picture of a page
            // its tile had left, with nothing in the UI able to undo it. The mount that
            // reopens the card is exempt, or reopening would spend the pin before the user
            // had done anything at all.
            if (!first && obj.webBrowser.posterPinned) {
                obj.webBrowser.posterPinned = false;
                this.host.store.markDirty();
            }
            if (!this._worthPhotographing(obj, landedUrl)) {
                // An interstitial, a login wall on someone else's origin, or a challenge
                // hop. Whatever poster the card already has is better than a picture of
                // this, so the pending capture is dropped rather than replaced.
                this._cancelPoster(objectId);
                return;
            }
            this._schedulePoster(objectId);
        }

        // Whether a landed page is the page the card was asked for, and therefore worth
        // keeping as its picture.
        //
        // This cannot be exact and is not pretending to be: a login wall served from the
        // site's own origin looks like the site. It catches the two cases that actually
        // produced wrong pictures — an off-origin redirect, and an anti-DDoS check — and
        // the refresh button is the authority for everything it cannot see.
        _worthPhotographing(obj, landedUrl) {
            const wanted = this._urlFor(obj);
            if (!wanted || !landedUrl) return false;
            try {
                const asked = new URL(wanted);
                const landed = new URL(landedUrl);
                if (asked.origin !== landed.origin) return false;
                return !/\/cdn-cgi\/|__cf_chl|\/\.well-known\//.test(landed.pathname + landed.search);
            } catch (e) {
                return false;
            }
        }

        // Ask the tile what layout box it actually ended up with, and correct the content
        // box by the difference. This is what turns the gutter arithmetic in _geometryFor
        // from a bet on how Firefox themes scrollbars into something that is measured.
        //
        // One shot per tile: the answer is recorded even when it is zero, so a page that
        // navigates repeatedly cannot walk the width a pixel at a time. Bounded too — a
        // disagreement wider than a scrollbar is a measurement to distrust, not to apply.
        async _correctContentWidth(obj) {
            if (obj.type !== "webcard") return;
            if (this._contentWidthDelta.has(obj.id)) return;

            const capture = obj.webcard && obj.webcard.capture;
            if (!capture || !capture.webContentSize) return;

            let measured = null;
            try {
                measured = await this.bridge?.liveMeasureTile(this._easelId, obj.id);
            } catch (e) {
                this.log("could not measure a tile:", e.message);
            }
            if (!measured || !(measured.clientW > 0)) return;
            // The tile can have gone in the time that took.
            if (!this.isLive(obj.id)) return;

            const delta = Math.round(capture.webContentSize.w - measured.clientW);
            const usable = Math.abs(delta) >= 1 && Math.abs(delta) <= MAX_WIDTH_CORRECTION;
            this._contentWidthDelta.set(obj.id, usable ? delta : 0);
            if (!usable) return;

            this.log("correcting a tile's content width by", delta, "for", obj.id);
            this.host.canvas.invalidate();
        }

        /* ---------------------------------------------------------- refresh */

        // Re-baselines a running tile: the picture the card shows when it is not live is
        // replaced with what the tile is showing now, and — the part that matters — the
        // place in the page the tile opens to is moved to wherever it has been scrolled.
        //
        // This is the answer to every way the reconstruction can land somewhere the stored
        // geometry did not predict: a login wall, an anti-DDoS check, a layout that reflowed
        // because the viewport was not quite the one it was captured in. None of those can
        // be detected reliably from outside, so rather than guess, the user puts the tile
        // where it belongs and presses this.
        //
        // Best-effort throughout, like the poster path: every failure leaves the card
        // exactly as it was.
        async refreshTile(obj) {
            if (!obj || !this.isLive(obj.id) || !this.bridge || !this._easelId) return false;
            if (this._refreshing.has(obj.id)) return false;
            this._refreshing.add(obj.id);
            try {
                return await this._refreshTile(obj);
            } finally {
                // In a finally rather than at each exit: this runs through several awaits
                // and a detach mid-flight would otherwise leave the card unable to refresh
                // again for the rest of the session.
                this._refreshing.delete(obj.id);
            }
        }

        async _refreshTile(obj) {
            // Three ways this gives up, and they mean completely different things — the
            // actor not answering, the page refusing to be drawn, and the write failing.
            // One toast for all three is right for the user and useless for anyone working
            // out which happened, so the reason is always logged before it is swallowed.
            const fail = why => {
                this.log("refresh failed for", obj.id, "-", why);
                this.host.toast("That card could not be refreshed");
                return false;
            };

            let measured = await this.bridge.liveMeasureTile(this._easelId, obj.id);
            if (!measured || !measured.scroll) {
                // Overwhelmingly the restart case: ZenEaselLive:Measure is new, and until
                // the content process reloads the child ESM the old actor answers null to
                // a message it has never heard of.
                return fail("the tile did not answer ZenEaselLive:Measure — is Zen restarted?");
            }

            // Pinned *before* the picture is taken, not after. Two things depend on it and
            // both are silent when it is wrong. An unlocked tile has no gutter reproduced —
            // #hideScrollbars is gated on the scroll lock — so it is laid out at a different
            // width than the one the card will show once it is locked again, and the crop
            // would be of a layout that never appears. And an unpinned page is free to move
            // between the measure and the snapshot, which would commit an offset that does
            // not match the pixels beside it.
            //
            // The second measure is the barrier: it is a sendQuery on the same actor as the
            // configure above, so it cannot be answered until that has been applied, and it
            // reports where the re-pin actually landed — which is not always where it was
            // asked to, since a scroll clamps to the document height it finds.
            if (this._isPinned(obj.id)) {
                this.bridge.liveSetTileUnlocked(this._easelId, obj.id, false, measured.scroll);
                const settled = await this.bridge.liveMeasureTile(this._easelId, obj.id);
                if (!this.isLive(obj.id)) return false;
                if (settled && settled.scroll) measured = settled;
            }

            const shot = obj.type === "webcard"
                ? await this._recropWebcard(obj, measured)
                : await this._resnapWebTile(obj.id);
            if (!shot || !shot.bytes || !shot.bytes.length) {
                return fail("the tile produced no pixels");
            }

            let asset = "";
            try {
                asset = await this.host.store.saveAsset(shot.bytes, "png");
            } catch (e) {
                this.log("could not save a refreshed card:", e.message);
            }
            if (!asset) return fail("the new picture could not be written to disk");

            // Re-read across the awaits, the same way _capturePoster does: a snapshot takes
            // a frame or two to encode and the card can be deleted or undone away inside
            // that window, which would leave an asset on disk owned by nothing.
            const target = this.host.canvas._byId(obj.id);
            if (!target || target.type !== obj.type) return false;

            if (target.type === "webcard") {
                const capture = target.webcard.capture;
                if (!capture) return false;
                target.webcard.asset = asset;
                // Only the offset moves. webContentSize and viewport are what the tile is
                // laid out *from*, so re-measuring them here would be circular — the tile
                // reports back the box we gave it — and frameRelativeToViewport is
                // invariant, because the tile's visible region is always exactly the frame
                // within its viewport however far down the page that viewport has moved.
                capture.webContentOffset = { x: measured.scroll.x, y: measured.scroll.y };
            } else {
                target.webBrowser.poster = asset;
                // Deliberate, so no automatic capture overwrites it — but pinned against
                // this page rather than against the card, and spent the moment the tile is
                // browsed somewhere else. See onLanded.
                target.webBrowser.posterPinned = true;
                target.webBrowser.scrollOffset = { x: measured.scroll.x, y: measured.scroll.y };
            }

            // Straight onto the object rather than through a mutation, for the reason the
            // poster path gives: a picture is a cache of what the card was showing, and
            // putting it on the undo stack would make Ctrl+Z step back through pictures
            // instead of through the things the user actually did. The offset travels with
            // it because the two are one fact — this picture, taken there.
            this.host.store.markDirty();
            this.log("refreshed", target.type, obj.id, "-> offset",
                JSON.stringify(measured.scroll), "asset", asset);

            this.host.canvas.invalidate();
            this.host.toast("Card refreshed");
            return true;
        }

        // The crop a webcard is, taken again from the live page. Document coordinates, the
        // same convention the capture picker uses — the tile's current scroll offset plus
        // the frame's position within the viewport. See the host's snapshotTileRect for how
        // the picture itself is taken.
        async _recropWebcard(obj, measured) {
            const capture = obj.webcard && obj.webcard.capture;
            if (!capture) return null;

            const frame = capture.frameRelativeToViewport;
            const left = measured.scroll.x + frame.x;
            const top = measured.scroll.y + frame.y;

            try {
                return await this.bridge.liveSnapshotTileRect(this._easelId, obj.id, {
                    left,
                    top,
                    right: left + frame.w,
                    bottom: top + frame.h,
                    devicePixelRatio: window.devicePixelRatio || 1
                });
            } catch (e) {
                this.log("could not re-crop a card:", e.message);
                return null;
            }
        }

        // A web tile has no crop, so its refresh is the ordinary whole-tile poster — just
        // taken on demand rather than on a timer, and pinned once it lands.
        async _resnapWebTile(objectId) {
            try {
                return await this.bridge.liveSnapshotTile(this._easelId, objectId);
            } catch (e) {
                this.log("could not snapshot a tile:", e.message);
                return null;
            }
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
            this.log("mounting", obj.type, obj.id, "at offset", JSON.stringify(
                capture ? capture.webContentOffset
                    : (obj.type === "webBrowser" ? obj.webBrowser.scrollOffset : null)));
            let ok = false;
            try {
                ok = await bridge.liveMount(easelId, obj.id, url, this._geometryFor(obj), {
                    userContextId: this._userContextId(obj),
                    private: !!window.ZenEaselUtil.prefs["live.private"],
                    // The locks exist to protect a crop, so a tile with no crop declines
                    // them: a web tile is a window onto a site, not a pinned view of one.
                    pinned: !!capture,
                    // A crop's offset is a contract and is held for life. A web tile's is a
                    // place it was last left by the refresh button, restored once and then
                    // let go of — see ZenEaselLiveChild's #repin.
                    scrollOffset: capture
                        ? capture.webContentOffset
                        : (obj.type === "webBrowser" ? obj.webBrowser.scrollOffset : null),
                    // How much of the content box is scrollbar gutter rather than page. The
                    // tile reinstates exactly this much, invisibly, so its layout box comes
                    // out the width the capture was taken at. Zero means "nothing to
                    // reproduce" — which is also what an older capture reports.
                    gutter: this._gutterFor(capture),
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
            // The poster is deliberately *not* scheduled here. A timer started at mount
            // fires whether or not the tile has arrived anywhere worth photographing, which
            // is how a card ended up with a picture of "Sign in to continue" or "Checking
            // your browser" as the thing it shows when it is not running. It is scheduled
            // from onLiveTileLanded instead, once the host says which page the tile actually
            // settled on — and a challenge that navigates again restarts that, so the
            // interstitial is skipped rather than photographed.
            return true;
        }

        // The width of the scrollbar gutter this capture was taken with, in CSS pixels.
        // Zero when there was none, and zero for a capture that predates the measurement —
        // which lays the tile out exactly as it always was.
        _gutterFor(capture) {
            if (!capture || !capture.viewport || !capture.webContentSize) return 0;
            const gutter = Math.round(capture.viewport.w - capture.webContentSize.w);
            return gutter > 0 ? gutter : 0;
        }

        _unmount(objectId) {
            if (!this._tiles.has(objectId)) return;
            this._cancelPoster(objectId);
            this._offscreenSince.delete(objectId);
            this._offscreen.delete(objectId);
            this._suppressed.delete(objectId);
            // Belongs to a running tile, not to the card. A width correction was measured
            // from this mount and the next one starts by measuring again; leaving it behind
            // would apply one page's gutter to another page's layout.
            this._contentWidthDelta.delete(objectId);
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
            this._cancelPoster(objectId);
            this._offscreenSince.delete(objectId);
            this._offscreen.delete(objectId);
            this._suppressed.delete(objectId);
            this._contentWidthDelta.delete(objectId);
            this._tiles.delete(objectId);
            if (this._activeId === objectId) this._activeId = null;
            this.host.canvas.invalidate();
        }

        // The container a card's live view should load in.
        //
        // The card's own, first: a capture records which container the page was open in, and
        // cookies are keyed on exactly that. Reproducing a shot taken in a container tab
        // inside the default container means a different session or none — which is the whole
        // of "the card shows me signed out while the same site in a tab is signed in", and it
        // is invisible from the page because every other thing about the load is identical.
        //
        // The pref stays as the override for cards captured before this was recorded, and as
        // the way to force every card into one container deliberately.
        _userContextId(obj) {
            const own = obj && obj.type === "webcard" && obj.webcard
                ? obj.webcard.userContextId : 0;
            if (Number.isInteger(own) && own > 0) return own;

            const id = window.ZenEaselUtil.prefs["live.container"];
            return Number.isInteger(id) && id > 0 ? id : 0;
        }

        /* ------------------------------------------------------------ layout */

        // Called from the canvas's paint, on the same frame as everything else, so tiles
        // never lag the board they are sitting on.
        sync() {
            if (!this._easelId) return;

            // Before the tile count is checked, because the layer can be up with no tiles in
            // it at all, carrying only the floating card bar — and that bar has to stay out
            // from under the toolbar too.
            //
            // But only when there is a layer. Measuring costs a querySelectorAll and a
            // getBoundingClientRect per piece of chrome, and the send is refused outright
            // when the board has no layer to cut — which also means the signature cache
            // never engages, so a board with nothing live on it would pay the full price on
            // every frame of every pan and every pen stroke, for an answer that is dropped.
            // The bar's own arrival is handled by the canvas, which calls in directly.
            if (this._tiles.size || this.host.canvas?.isShowingCardChrome()) {
                this.syncChromeClip();
            }

            if (!this._tiles.size) return;

            // A tile whose object is gone has to go with it. Done here rather than in
            // removeObjects because deletion is not the only way an object stops existing:
            // undo, redo, paste-over and switching easel all replace the object list, and a
            // tile left behind is a live website floating over a board that no longer has a
            // card for it — unselectable, undeletable, and still running.
            this._sweepOrphans();
            if (!this._tiles.size) return;

            const origin = this.viewportOrigin();
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
        //
        // Public, because tiles are no longer the only thing placed in that layer: the
        // floating card bar goes there too, and it is the same seam with the same trap on
        // the other side of it. One definition, so a second reader cannot rediscover the
        // topbar the hard way.
        viewportOrigin() {
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
        _geometryFor(obj, viewportOrigin = this.viewportOrigin()) {
            const view = this.host.canvas.view;
            const zoom = view.zoom;
            const local = this.host.canvas.toScreen(obj.x, obj.y);
            const origin = { x: local.x + viewportOrigin.x, y: local.y + viewportOrigin.y };

            // A rotated card's tile turns with it. Sent as a plain number and applied by
            // the host as one CSS transform on the wrapper — the tile is a real element,
            // so this costs nothing that the canvas is not already paying for the objects
            // around it.
            const rotation = obj.rotation || 0;
            // Sent alongside the rotation and applied the same way: a live tile is a real
            // element in the host's layer, so the renderer's globalAlpha reaches its
            // screenshot but not the running site above it. Without this a faded card
            // would snap back to full strength the moment it went live.
            const opacity = obj.opacity === undefined ? 1 : obj.opacity;

            if (obj.type === "webBrowser") {
                // Laid out at its own world size and scaled by the zoom, so zooming magnifies
                // the page rather than reflowing it at every step.
                return {
                    rect: {
                        x: origin.x,
                        y: origin.y,
                        w: obj.w * zoom,
                        h: obj.h * zoom
                    },
                    content: { w: obj.w, h: obj.h },
                    offset: { x: 0, y: 0 },
                    scale: zoom,
                    rotation,
                    opacity,
                    // The tile is the whole object now, so its centre and the object's are
                    // the same point. It used to be inset below a canvas-drawn URL strip and
                    // had to turn about a centre that was not its own.
                    pivot: { x: obj.w * zoom / 2, y: obj.h * zoom / 2 }
                };
            }

            const capture = obj.webcard.capture;
            const frame = capture.frameRelativeToViewport;
            const size = capture.webContentSize;

            // Edge to edge. The tile used to stop short of a canvas-drawn title strip along
            // the card's bottom, which doubled as the drag handle for a card whose middle
            // belonged to a website. Dragging still works without it: a tile only takes the
            // pointer once it has been activated, so a press anywhere on a live-but-not-yet-
            // clicked card reaches the board exactly as it always did.
            const scale = frame.w > 0 ? (obj.w * zoom) / frame.w : zoom;

            // The content box is the viewport the page was captured in, not its layout box.
            // The two differ by the scrollbar gutter, and that difference is invisible right
            // up until a site consults window.innerWidth, a vw unit or a @media (width) —
            // all of which resolve against the scrollbar-*inclusive* box. Laying the tile
            // out at the exclusive one put every responsive site a gutter narrower than it
            // had been, which near a breakpoint is a different layout altogether and a crop
            // pointing at whatever moved into its place.
            //
            // frame is measured from the viewport's top-left, the same origin in both boxes,
            // so neither the scale above nor the offset below changes. The gutter sits at
            // the far edge, outside every frame a capture would have accepted.
            //
            // Older captures have no viewport recorded and lay out exactly as they always
            // did — the field is read as "unknown", never as "there was no gutter".
            const content = capture.viewport
                ? { w: capture.viewport.w, h: capture.viewport.h }
                : { w: size.w, h: size.h };

            // What the tile said about its own layout box once it settled, if it disagreed.
            // See _correctContentWidth: this is the correction that makes the gutter
            // arithmetic above answerable rather than a bet on how Firefox themes scrollbars.
            const delta = this._contentWidthDelta.get(obj.id) || 0;
            if (delta) content.w += delta;

            return {
                rect: { x: origin.x, y: origin.y, w: obj.w * zoom, h: obj.h * zoom },
                content,
                // Post-scale, because the host applies this as a plain offset alongside the
                // transform rather than inside it.
                offset: { x: -frame.x * scale, y: -frame.y * scale },
                scale,
                rotation,
                opacity,
                // The tile is the whole card, so its centre and the card's coincide.
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

            // Clicking into a pinned card lifts its locks. Until this, a webcard tile could
            // not be scrolled, selected or submitted at all — which made two things
            // impossible that the card badly needs: correcting a tile that opened to the
            // wrong part of the page, and logging in to a site that wants a session before
            // it will show you anything.
            //
            // The unlock lasts exactly as long as the pointer is inside the card; deactivate
            // re-pins it wherever it has been left. See _relockTile for why that is not the
            // same as undoing the repositioning.
            if (this.repositionEnabled && this._isPinned(objectId)) {
                this.bridge?.liveSetTileUnlocked(this._easelId, objectId, true);
            }
            // The tile has the pointer now, so the board will not hear it move again until
            // it is handed back — and the hover bar would otherwise stay parked over a site
            // that is being used. This is the whole of "interacting with a live tile hides
            // the card": the state is dropped here, and the frame that follows stops asking
            // the host to draw it.
            this.host.canvas?.clearHover();
        }

        deactivate() {
            if (!this._activeId) return;
            const wasActive = this._activeId;
            this._activeId = null;
            this.bridge?.liveDeactivate();
            if (this.repositionEnabled && this._isPinned(wasActive)) {
                this._relockTile(wasActive)
                    .catch(e => this.log("could not re-pin a card:", e.message));
            }
            // The pointer is back on the board and has not moved, so no event is coming to
            // say what it is resting on. Almost always that is the card just stepped out of,
            // whose bar should reappear rather than wait for a twitch of the mouse.
            this.host.canvas?.refreshHover();
        }

        // Puts the locks back on a card that was unlocked for repositioning, pinned to
        // wherever the tile now sits rather than to where it started.
        //
        // That distinction is the whole point, and it is why this does not undo the gesture:
        // a card scrolled to a new position is re-pinned *at the new position*, so the
        // refresh button still commits exactly what is on screen. What the re-pin buys back
        // is the guarantee the card exists for — an unlocked tile has no offset and no
        // scroll lock, so the site's own scrollIntoView, a fragment link or a lazy loader is
        // free to walk the crop off the region that was captured, silently and for the rest
        // of the tile's life. Leaving that on after a single click was too high a price for
        // a gesture most clicks are not performing.
        //
        // Best-effort: a measure that fails still re-locks, falling back to the offset the
        // host stashed at unlock time, because a stale pin beats no pin at all.
        async _relockTile(objectId) {
            let measured = null;
            try {
                measured = await this.bridge?.liveMeasureTile(this._easelId, objectId);
            } catch (e) {
                this.log("could not measure a tile before re-pinning it:", e.message);
            }
            // The tile can have been stopped, evicted or re-activated while that was in
            // flight; re-locking one the pointer is back inside would fight the user.
            if (!this.isLive(objectId) || this._activeId === objectId) return;
            this.bridge?.liveSetTileUnlocked(
                this._easelId, objectId, false, measured?.scroll || null);
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
                // Adopted tiles are re-measured rather than assumed. _correctContentWidth is
                // otherwise only reached from onLanded, and a tile being adopted landed long
                // ago — so a page reload, which builds a fresh layer with an empty map, left
                // every running webcard laid out at the uncorrected width with nothing able
                // to notice. The one-shot guard inside makes this free for the common case
                // where the layer is the same one that measured it.
                this._correctContentWidth(obj)
                    .catch(e => this.log("could not correct an adopted tile's width:", e.message));
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
            // A pending poster is addressed to a tile on the board being left, and by the
            // time it fired _easelId would name a different one.
            for (const timer of this._posterTimers.values()) window.clearTimeout(timer);
            this._posterTimers.clear();
            this._tiles.clear();
            this._offscreenSince.clear();
            this._offscreen.clear();
            this._suppressed.clear();
            this._gestureIds = [];
            this._activeId = null;
            // _contentWidthDelta is deliberately *not* cleared here, unlike everything
            // above. This is the view being forgotten, not the tiles: a board switch leaves
            // them running on the host, and attach() adopts them back at the same width they
            // are still laid out at. The entries go where the tile goes, and the only place
            // that is, is _unmount and forget.
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
        // viewportOrigin() — and at the moment a tab becomes visible again that layout is
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
