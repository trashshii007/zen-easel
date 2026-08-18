// Zen Easel — the browser-window half of live web cards.
//
// Live tiles are <browser> elements, and they have to live here rather than in the easel
// page. That is not a preference, it is the only thing that works: about:easel is a
// system-principal chrome document, and Gecko refuses to load web content inside one. Every
// variant was tried against this Zen build and every one failed —
//
//   <iframe>                              stays on about:blank, no CSP violation reported
//   <iframe type="content"> (XUL)         stays on about:blank
//   <browser type="content">              NS_ERROR_CONTENT_BLOCKED from the docshell
//   <browser type="content" remote>       frameLoader.remoteTab null, fires oop-browser-crashed
//
// The last one is the instructive failure. `remote="true"` on a XUL browser asks Gecko for a
// *top-level* remote frame — a BrowserParent — which is only granted when the embedder is a
// chrome document. Firefox's own machinery assumes it too: RemoteWebNavigation dereferences
// frameLoader.remoteTab with no null check. A content-document embedder never gets one, and
// the resulting crash event is then handled by code that expects a gBrowser to exist.
//
// In this window all of that is simply true, because every tab is exactly this element.
//
// The division of labour: the page owns the model — which cards are live, the LRU, which one
// has the pointer — and sends geometry. This owns the elements. Everything that crosses is a
// plain number or string, and the host holds no reference to the page.

"use strict";

(function () {
    if (window.ZenEaselLiveHost) return;

    const { E10SUtils } = ChromeUtils.importESModule("resource://gre/modules/E10SUtils.sys.mjs");
    const { safeExternalUrl } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/validate.sys.mjs");

    // Waiting for the content process to be handed over. Firefox's own nested browser
    // (inline-options-browser.mjs) waits on this event rather than assuming clientTop is
    // enough, and it is right to: forcing the binding to apply is not the same as a process
    // existing.
    const FRAME_LOADER_TIMEOUT_MS = 4000;

    // The two addresses the easel page can be at — about:easel when the about module
    // registered, and the chrome URL when it did not. Matched by prefix rather than by
    // regex so the anchoring cannot be got wrong; see _easelBrowser.
    const ABOUT_URL = "about:easel";
    const CHROME_PAGE_URL = "chrome://sine/content/zen-easel/page/easel.xhtml";

    // How long a tile may sit blank before it gives up and the screenshot comes back.
    const LOAD_TIMEOUT_MS = 12000;

    // How long to allow before deciding a navigation never started at all.
    const NAVIGATION_CHECK_MS = 5000;

    // Sites whose sticky headers land in the middle of a crop taken further down the page.
    // Arc ships a list like this; these are applied as agent sheets, which outrank page CSS
    // without an !important arms race.
    const CSS_PATCHES = [
        ".header__shrink-beyond-min-size{min-height:0px;padding-top:0px}",
        "div[class^=mobile-navbar-index__mobileNavbarWrapper]{padding-top:0px}",
        "div[class^=app-layout__header]{padding-top:0px}"
    ];

    class ZenEaselLiveHost {
        constructor() {
            this.log = window.ZenEaselUtil.log;

            // objectId -> { wrapper, clip, browser }
            this._tiles = new Map();
            this._layer = null;
            this._ownerBrowser = null;      // the easel tab's <browser>, for tracking and clipping
            this._activeId = null;
            this._resizeObserver = null;

            // Bumped by anything that invalidates every tile — unmountAll(), destroy().
            // mount() samples it before it awaits and re-checks after; see the note there.
            this._generation = 0;
            this._destroyed = false;

            this._onTabSelect = this._onTabSelect.bind(this);
            gBrowser.tabContainer.addEventListener("TabSelect", this._onTabSelect);
        }

        /* ---------------------------------------------------------------- layer */

        // The layer is placed exactly over the easel tab's <browser>, so the coordinates the
        // page sends — which are relative to its own viewport — can be used unchanged, and
        // anything panned past the edge of the board is clipped by the layer rather than
        // drawn over Zen's sidebar.
        _ensureLayer(ownerBrowser) {
            if (this._layer && this._ownerBrowser === ownerBrowser) return this._layer;

            this._teardownLayer();
            this._ownerBrowser = ownerBrowser;

            const layer = document.createXULElement("box");
            layer.id = "zen-easel-live-layer";
            layer.style.position = "fixed";
            layer.style.overflow = "hidden";
            // The canvas keeps ownership of the pointer; only an activated tile opts back in.
            layer.style.pointerEvents = "none";
            // Above the content area, below Zen's own panels and menus. This is the value
            // the probe that proved the approach used.
            layer.style.zIndex = "9";

            (document.getElementById("browser") || document.documentElement).appendChild(layer);
            this._layer = layer;
            this._positionLayer();

            // A sidebar collapse or a window resize moves the content area without the page
            // repainting, so the layer cannot rely on the page's frame loop alone.
            if (typeof ResizeObserver === "function") {
                this._resizeObserver = new ResizeObserver(() => this._positionLayer());
                this._resizeObserver.observe(ownerBrowser);
            }
            return layer;
        }

        _positionLayer() {
            if (!this._layer || !this._ownerBrowser) return;
            const rect = this._ownerBrowser.getBoundingClientRect();
            this._layer.style.left = `${rect.left}px`;
            this._layer.style.top = `${rect.top}px`;
            this._layer.style.width = `${rect.width}px`;
            this._layer.style.height = `${rect.height}px`;
        }

        _teardownLayer() {
            if (this._resizeObserver) {
                try { this._resizeObserver.disconnect(); } catch (e) { }
                this._resizeObserver = null;
            }
            if (this._layer) {
                this._layer.remove();
                this._layer = null;
            }
            this._ownerBrowser = null;
        }

        /* --------------------------------------------------------------- tiles */

        // geometry is plain data from the page, in its own viewport's CSS pixels:
        //   rect    {x, y, w, h}   where the tile sits
        //   content {w, h}         the size to lay the page out at, so it reflows as captured
        //   offset  {x, y}         how far to shift it so the captured region is at the origin
        //   scale                  what to multiply that by so the region fills the tile
        async mount(objectId, url, geometry, options = {}) {
            // Already mounted still answers true. The page treats false as "this card could
            // not be opened" and drops its model entry — which, for a tile this host is in
            // fact still showing, would strand a live website with nothing tracking it.
            if (this._tiles.has(objectId)) return true;
            if (this._destroyed) return false;

            const spec = safeExternalUrl(url);
            if (!spec) return false;

            const owner = this._easelBrowser();
            if (!owner) return false;

            // Sampled before the first await. _createBrowser waits on XULFrameLoaderCreated
            // and will sit there for up to FRAME_LOADER_TIMEOUT_MS, which is a wide window
            // for the whole layer to be swept out from under this call — suspendAll() runs
            // on both visibilitychange and pagehide, so simply switching tabs at the wrong
            // moment did it. The old code then registered the tile and started the load
            // regardless, into a wrapper that _teardownLayer had already detached: a live
            // site running in a content process with no element on screen, unreachable by
            // unmount() because it landed in _tiles *after* the sweep walked it.
            const generation = this._generation;
            const layer = this._ensureLayer(owner);

            const wrapper = document.createXULElement("box");
            wrapper.className = "zen-easel-live-tile";
            wrapper.style.position = "absolute";
            wrapper.style.overflow = "hidden";
            wrapper.style.borderRadius = "10px";

            const clip = document.createXULElement("box");
            clip.style.position = "absolute";
            clip.style.transformOrigin = "0 0";

            wrapper.appendChild(clip);
            layer.appendChild(wrapper);

            const browser = await this._createBrowser(spec, clip, options);
            if (!browser) {
                wrapper.remove();
                return false;
            }

            // The re-check. Tearing the browser down explicitly rather than just dropping
            // the reference: a remote browser holding render layers keeps its content
            // process alive and can leave its last composited frame on screen, which is the
            // same reason unmount() below drops layers before removing the element.
            // isConnected covers the case the generation counter does not: _ensureLayer
            // tears the old layer down when the easel moves to a different <browser>, which
            // detaches this wrapper without any tile being unmounted.
            if (this._destroyed || generation !== this._generation || !wrapper.isConnected) {
                try { browser.renderLayers = false; } catch (e) { }
                try { browser.docShellIsActive = false; } catch (e) { }
                try { browser.remove(); } catch (e) { }
                wrapper.remove();
                this.log("a live tile was abandoned mid-mount:", spec);
                return false;
            }

            const tile = { wrapper, clip, browser, objectId };
            // Stored before the load starts, because the child's DOMContentLoaded — and
            // the Ready message it sends from there — can arrive before this call
            // returns. An answer of null would mean an unpinned tile with no locks.
            this._storeConfig(tile, options);
            this._tiles.set(objectId, tile);
            this.layout(objectId, geometry);
            this._watchLoad(tile, spec);

            try {
                browser.fixupAndLoadURIString(spec, {
                    // Deliberately not the system principal.
                    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({})
                });
            } catch (e) {
                this.log("a live tile refused to load:", e.message);
                this.unmount(objectId);
                return false;
            }

            return true;
        }

        // A tile whose load fails is worse than one that never mounted: the canvas stops
        // painting the screenshot underneath a live card, so a failure would leave a blank
        // hole with no way back. Every failure therefore ends with the tile going away.
        //
        // Two failures matter and they look nothing alike. A network error arrives as a
        // non-zero status on STATE_STOP. A site that refuses to be embedded —
        // X-Frame-Options, or a frame-ancestors CSP — is not an error at all: the channel
        // succeeds and the docshell quietly lands on about:neterror.
        _watchLoad(tile, url) {
            const browser = tile.browser;
            let settled = false;

            const finish = reason => {
                if (settled) return;
                settled = true;
                window.clearTimeout(tile.loadTimer);
                window.clearTimeout(tile.navCheckTimer);
                if (tile.detachListener) {
                    tile.detachListener();
                    tile.detachListener = null;
                }
                if (!reason || !this._tiles.has(tile.objectId)) return;

                this.log("live tile failed:", url, reason);
                const id = tile.objectId;
                this.unmount(id);
                this._notifyPage(id, reason);
            };

            const listener = {
                QueryInterface: ChromeUtils.generateQI([
                    "nsIWebProgressListener", "nsISupportsWeakReference"
                ]),
                onStateChange: (progress, request, flags, status) => {
                    const done = Ci.nsIWebProgressListener.STATE_STOP;
                    const network = Ci.nsIWebProgressListener.STATE_IS_NETWORK;
                    if (!(flags & done) || !(flags & network)) return;

                    // NS_OK is 0, compared numerically so this does not depend on Cr being
                    // a global in whichever document the host was loaded into.
                    if (status !== 0) {
                        finish("That site could not be loaded in the easel");
                        return;
                    }
                    const landed = browser.documentURI ? browser.documentURI.spec : "";
                    if (/^about:(neterror|blocked|certerror)/.test(landed)) {
                        finish("That site refuses to be embedded, so the card stays a screenshot");
                        return;
                    }
                    // Re-asserted after the load: a process switch on navigation brings a
                    // new remote tab with it, and the flag does not travel.
                    this._markActive(browser);
                    finish(null);
                }
            };

            try {
                browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
                // Handed to the tile so unmount can detach it too. A tile torn down
                // before its load settles never reaches finish(), and the listener would
                // otherwise stay registered against a browser that is going away.
                tile.detachListener = () => {
                    try { browser.removeProgressListener(listener); } catch (e) { }
                };
            } catch (e) {
                this.log("could not watch the tile's load:", e.message);
                return;
            }
            // A refusal to be embedded does not arrive as an error and does not produce an
            // error page: the load is simply cancelled, and the tile sits on about:blank
            // forever. currentURI changes as soon as a navigation *starts*, so still being
            // about:blank a few seconds in means it never started.
            tile.navCheckTimer = window.setTimeout(() => {
                const at = browser.currentURI ? browser.currentURI.spec : "";
                if (at === "about:blank" || !at) {
                    finish("That site refuses to be embedded, so the card stays a screenshot");
                }
            }, NAVIGATION_CHECK_MS);

            tile.loadTimer = window.setTimeout(
                () => finish("That site took too long to load in the easel"), LOAD_TIMEOUT_MS
            );
        }

        // Where the scroll is pinned, which locks apply, and the per-site CSS repairs.
        //
        // Stored on the tile rather than pushed at it. The child asks for this by name
        // — ZenEaselLive:Ready, on every DOMContentLoaded and pageshow — and the parent
        // actor answers from here via liveConfigFor(). That inversion is the fix for two
        // things at once: the retry loop that used to poll for the actor's existence on
        // a 100ms timer forty times per tile is gone, and a navigation that switches
        // content process now reconfigures itself, where before it produced a fresh
        // actor holding no configuration at all and nothing noticed.
        _storeConfig(tile, options) {
            const pinned = !!options.pinned;
            tile.config = {
                offset: options.scrollOffset || null,
                lockScroll: pinned,
                lockSelection: pinned,
                // A sticky header is a feature in a web tile and a defect in a crop
                // taken further down the page, so the repairs are a crop concern.
                cssPatches: pinned ? CSS_PATCHES : []
            };
        }

        // Answered for the parent actor, which has a <browser> and needs the config that
        // belongs to it. Linear over the tiles, which are capped at live.max-tiles.
        configFor(browser) {
            for (const tile of this._tiles.values()) {
                if (tile.browser === browser) return tile.config || null;
            }
            return null;
        }

        // The page owns the model, so a tile the host gives up on has to be reported back
        // rather than silently dropped — otherwise the page still believes it is live and
        // the canvas keeps leaving a hole for it.
        _notifyPage(objectId, reason) {
            try {
                const browser = this._easelBrowser();
                const page = browser?.contentWindow?.gZenEaselPage;
                page?.onLiveTileLost(objectId, reason);
            } catch (e) {
                this.log("could not tell the page a tile was lost:", e.message);
            }
        }

        // Mirrors Firefox's own nested remote browser. The ordering is load-bearing:
        // everything deciding where content runs is set before insertion, and nothing is
        // loaded until the frame loader has actually been created.
        async _createBrowser(url, parent, options) {
            let remoteType;
            try {
                remoteType = ChromeUtils.predictRemoteTypeForURI(url, {
                    window,
                    userContextId: options.userContextId || 0
                });
            } catch (e) {
                this.log("could not predict a remote type:", e.message);
                return null;
            }
            if (remoteType === E10SUtils.NOT_REMOTE || !E10SUtils.isWebRemoteType(remoteType)) {
                return null;
            }

            const browser = document.createXULElement("browser");
            browser.setAttribute("type", "content");
            browser.setAttribute("messagemanagergroup", "zen-easel-live");
            browser.setAttribute("forcemessagemanager", "true");
            // disableglobalhistory keeps the tile out of your browsing history, which is the
            // one that matters for privacy.
            //
            // `disablehistory` is deliberately NOT set, though it looks like the obvious
            // companion. It stops the frame loader creating session history on the docShell
            // at all, and a single-page app leans on history.pushState during hydration and
            // routing — with nowhere to push, those calls throw and the app never finishes
            // rendering. The symptom is a site frozen on its loading skeleton while a
            // server-rendered page beside it looks perfect.
            browser.setAttribute("disableglobalhistory", "true");
            browser.setAttribute("disablefullscreen", "true");
            browser.setAttribute("autoscroll", "false");
            browser.setAttribute("transparent", "true");
            if (options.userContextId) {
                browser.setAttribute("usercontextid", String(options.userContextId));
            }
            browser.setAttribute("remote", "true");
            browser.setAttribute("remoteType", remoteType);
            browser.setAttribute("maychangeremoteness", "true");
            browser.style.width = "100%";
            browser.style.height = "100%";
            browser.style.border = "0";

            const ready = new Promise(resolve => {
                browser.addEventListener("XULFrameLoaderCreated", resolve, { once: true });
                window.setTimeout(resolve, FRAME_LOADER_TIMEOUT_MS);
            });

            parent.appendChild(browser);
            void browser.clientTop;
            await ready;

            if (!browser.isRemoteBrowser) {
                browser.remove();
                return null;
            }

            if (options.private) {
                try { browser.browsingContext.usePrivateBrowsing = true; } catch (e) { }
            }

            this._markActive(browser);
            return browser;
        }

        // A tab's activity is managed by tabbrowser; a tile's is managed by nobody, so it
        // starts *inactive* — which throttles rAF and timers and stops its layers being
        // rendered at all. A largely static page still paints and looks fine. An SPA never
        // gets past its loading skeleton, which is exactly what a heavy site looked like
        // here: the logo, and nothing else, forever.
        //
        // docShellIsActive sets browsingContext.isActive and the remote tab's renderLayers
        // together, which is the pair that matters.
        _markActive(browser) {
            try {
                browser.docShellIsActive = true;
                browser.renderLayers = true;
            } catch (e) {
                this.log("could not mark a tile active:", e.message);
            }
        }

        layout(objectId, geometry) {
            const tile = this._tiles.get(objectId);
            if (!tile || !geometry) return;

            const { rect, content, offset, scale, rotation, pivot } = geometry;

            // Everything else crossing this seam is a plain number or string, and is treated
            // as untrusted on arrival. Geometry is the one structured value, and it was
            // being destructured straight into property writes — so a malformed entry threw
            // from inside the page's paint loop, taking that frame's whole layout pass with
            // it. Numbers are checked rather than coerced: a NaN here is a bug upstream, and
            // silently painting a tile at 0,0 would hide it.
            const finite = v => typeof v === "number" && Number.isFinite(v);
            if (!rect || !content || !offset || !finite(scale)) return;
            if (!finite(rect.x) || !finite(rect.y) || !finite(rect.w) || !finite(rect.h)) return;
            if (!finite(content.w) || !finite(content.h)) return;
            if (!finite(offset.x) || !finite(offset.y)) return;

            tile.wrapper.style.left = `${rect.x}px`;
            tile.wrapper.style.top = `${rect.y}px`;
            tile.wrapper.style.width = `${Math.max(0, rect.w)}px`;
            tile.wrapper.style.height = `${Math.max(0, rect.h)}px`;

            // The card is rotated on the board, so its tile turns with it — about the
            // *object's* centre, which the page sends as a pivot because the tile covers
            // only the card's art and not its title strip. Turning about the tile's own
            // centre would swing the website out of the frame the canvas drew for it.
            if (rotation && finite(rotation) && pivot && finite(pivot.x) && finite(pivot.y)) {
                tile.wrapper.style.transformOrigin = `${pivot.x}px ${pivot.y}px`;
                tile.wrapper.style.transform = `rotate(${rotation}deg)`;
            } else if (tile.wrapper.style.transform) {
                tile.wrapper.style.transform = "";
                tile.wrapper.style.transformOrigin = "";
            }

            tile.clip.style.transform = `scale(${scale})`;
            tile.clip.style.left = `${offset.x}px`;
            tile.clip.style.top = `${offset.y}px`;
            tile.clip.style.width = `${content.w}px`;
            tile.clip.style.height = `${content.h}px`;

            // A CSS transform moves the frame without telling the widget layer, so native
            // dropdowns and IME drift until it is told.
            this._scheduleWidgetUpdate();
        }

        // Batched: the page sends the whole set on one frame during a pan or zoom.
        layoutAll(entries) {
            for (const entry of entries) this.layout(entry.id, entry.geometry);
        }

        _scheduleWidgetUpdate() {
            if (this._widgetTimer) window.clearTimeout(this._widgetTimer);
            this._widgetTimer = window.setTimeout(() => {
                this._widgetTimer = null;
                for (const tile of this._tiles.values()) {
                    try { tile.browser.frameLoader?.requestUpdatePosition(); } catch (e) { }
                }
            }, 100);
        }

        // Only the activated tile takes the pointer; everything else stays transparent to it
        // so the canvas keeps full ownership of selection, dragging and the marquee.
        activate(objectId) {
            if (this._activeId === objectId) return;
            this.deactivate();
            const tile = this._tiles.get(objectId);
            if (!tile) return;
            tile.wrapper.style.pointerEvents = "auto";
            tile.wrapper.style.outline = "2px solid var(--zen-primary-color, #2b5fd9)";
            tile.wrapper.style.outlineOffset = "-2px";
            this._activeId = objectId;
        }

        deactivate() {
            if (!this._activeId) return;
            const tile = this._tiles.get(this._activeId);
            if (tile) {
                tile.wrapper.style.pointerEvents = "none";
                tile.wrapper.style.outline = "";
            }
            this._activeId = null;
        }

        // Hidden rather than unmounted: a drag wants the tile out of the way for a few
        // frames, not a reload afterwards.
        setTileVisible(objectId, visible) {
            const tile = this._tiles.get(objectId);
            if (tile) tile.wrapper.style.visibility = visible ? "" : "hidden";
        }

        // Removing the wrapper is not enough on its own, and that is what left a dead
        // picture of the website behind when a live card was deleted.
        //
        // A tile is created active — _markActive sets docShellIsActive and renderLayers
        // together, because an inactive remote frame never finishes rendering an SPA —
        // and nothing ever told it otherwise. Detaching a subtree containing a remote
        // browser that still holds render layers can leave its last composited frame on
        // screen: the pixels stay, and nothing responds to them, because the wrapper's
        // pointer-events was "none" all along. Dropping the layers first is what
        // actually retires the frame.
        //
        // The ordering matters: layers, then the docshell, then the browser element,
        // then the wrapper. Each step is guarded — a tile whose content process has
        // already died throws on every property here, and a teardown that gives up
        // halfway is exactly the state being fixed.
        unmount(objectId) {
            const tile = this._tiles.get(objectId);
            if (!tile) return;
            if (this._activeId === objectId) this._activeId = null;

            // Timers and the progress listener outlive the element otherwise. _watchLoad
            // only clears them when the load settles, and an unmount is precisely the
            // case where it never does.
            window.clearTimeout(tile.loadTimer);
            window.clearTimeout(tile.navCheckTimer);
            if (tile.detachListener) {
                try { tile.detachListener(); } catch (e) { }
                tile.detachListener = null;
            }

            const browser = tile.browser;
            if (browser) {
                try { browser.renderLayers = false; } catch (e) { }
                try { browser.docShellIsActive = false; } catch (e) { }
                try { browser.remove(); } catch (e) { }
            }
            tile.wrapper.remove();

            this._tiles.delete(objectId);
            if (!this._tiles.size) this._teardownLayer();
        }

        unmountAll() {
            // Bumped first, so a mount() already awaiting its frame loader sees the change
            // when it resumes and cleans up after itself instead of registering a tile this
            // sweep can no longer reach.
            this._generation++;
            for (const id of [...this._tiles.keys()]) this.unmount(id);
            this._teardownLayer();
        }

        isLive(objectId) {
            return this._tiles.has(objectId);
        }

        /* ------------------------------------------------------------ lifecycle */

        // The tiles belong to one tab. Switching away has to hide them, or a board's live
        // cards would be painted over whatever page you moved to.
        _onTabSelect() {
            if (!this._layer) return;
            const owner = this._easelBrowser();
            const showing = owner && owner === this._ownerBrowser &&
                gBrowser.selectedBrowser === this._ownerBrowser;
            this._layer.style.visibility = showing ? "" : "hidden";
            if (showing) this._positionLayer();
        }

        // The easel tab in *this* window. A second window has its own host, and must not
        // render into this one's.
        //
        // Both tests are anchored. They used to be one alternation — /^about:easel|\/zen-
        // easel\/page\/easel\.xhtml/ — where the ^ binds to the first branch only, so any
        // URL merely *containing* the chrome path matched. This decides which tab's
        // <browser> the live layer is positioned over and clipped to, so a false match
        // is a real website's tab being treated as the easel.
        _easelBrowser() {
            try {
                for (const tab of gBrowser.tabs) {
                    const browser = tab.linkedBrowser;
                    const spec = browser && browser.currentURI ? browser.currentURI.spec : "";
                    if (spec.startsWith(ABOUT_URL) || spec.startsWith(CHROME_PAGE_URL)) {
                        return browser;
                    }
                }
            } catch (e) { }
            return null;
        }

        destroy() {
            // Set before unmountAll so a mount() resuming after this point declines outright
            // rather than merely noticing the generation moved.
            this._destroyed = true;
            try {
                gBrowser.tabContainer.removeEventListener("TabSelect", this._onTabSelect);
            } catch (e) { }
            if (this._widgetTimer) window.clearTimeout(this._widgetTimer);
            this.unmountAll();
        }
    }

    window.ZenEaselLiveHost = ZenEaselLiveHost;
})();
